"""Seeded adversarial and noisy ground data on top of the honest generators (docs/adr/0042-adversarial-ground-data.md).

``apply_noise(events, profile, seed, ...)`` wraps the event lists of the honest generators and
returns ``(events_out, truth)``:

- ``events_out``: the events a drill would receive, in upload-time order. Honest events are
  copied (never mutated), some are transformed (honest error, late upload), some repeated
  (duplicates, retry storms), and new ones are added (stale echoes after a truth change,
  rumours, out-of-area relays, malicious bursts, Sybil sets, help at empty places).
- ``truth``: a hidden map from every emitted simulated event id to
  ``{"true": bool, "kind_of_noise": str | None, "source_event_id": str | None, "notes": str, ...}``,
  plus one ``truth_change:<id>`` entry per change of the ground-truth timeline. It goes to the
  ``sim_truth`` collection only; nothing a drill participant can read carries it.

Inputs it understands (the honest streams, unchanged in shape):

- ``sim/gen_residents.py`` events: ``{"type": "report"|"checkin"|"destination", "body": {...},
  "at", "party_key", "evidence_class": "simulated", ...}``; a report's id is ``body.client_id``.
- ``sim/gen_comms.py`` items: ``{"id", "at", "channel", "category", "road_name", "coord",
  "evidence_class": "simulated", ...}``.
- ``livecore/responders_sim.py`` calls: ``{"at", "unit", "op", "method", "path", "body"}``;
  a ``report`` call's id is ``body.client_id``.

Anything else, and any event whose ``evidence_class`` is present and not ``"simulated"`` (a real
participant's report, a 2018 record row), passes through untouched and gets no truth entry
(AGENTS.md, Firm: real reports are never altered).

Conventions: times are aware UTC ``datetime`` internally and ISO 8601 ``Z`` strings in events;
distances metres (``*_m``) on a local equirectangular projection; coordinates GeoJSON
``(lon, lat)``; rates are per drill hour (``*_per_h``) or shares of eligible honest events
(``*_share``). Every constant is marked CALIBRATED (with its measurement) or ASSUMPTION.
Standard library only, pure, deterministic for a given ``(events, profile, seed, options)``:
each honest event draws from its own stream keyed by its id, and each injected family from its
own stream, so a change in one stream does not shift another (docs/strategy-evaluation.md §1).
Everything produced is a planning-experiment input, labelled ``simulated``.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import random
import uuid
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from sim.geo import EARTH_RADIUS_M

MODEL_VERSION = "gen-noise-1"
GENERATOR = f"sim/gen_noise.py ({MODEL_VERSION})"
EVIDENCE_CLASS = "simulated"
PARTY_KEY_PREFIX = "sim_"
"""Injected parties use the residents' key format (``sim_`` + 16 hex), so a key does not reveal noise."""
REPORT_NOTE = "Simulated resident (gen-residents)"
"""Injected reports carry the honest residents' note, so the note does not reveal noise either."""
REPORT_ACCURACY_M = 10.0
"""Accuracy sent with injected phone reports: the residents' value (sim/gen_residents.REPORT_ACCURACY_M)."""
COORD_DECIMALS = 6
TRUTH_CHANGE_PREFIX = "truth_change:"

ROAD_KINDS = frozenset({"road_blocked", "road_passable", "heavy_traffic"})
CONTRADICTS = {"road_blocked": "road_passable", "road_passable": "road_blocked"}
"""Same pairs as livecore/public.py CONTRADICTS."""

NOISE_KINDS = (
    "wrong_road", "gps_offset", "wrong_kind",            # honest error
    "duplicate_resubmit", "duplicate_crowd",             # duplicates (retry storms ride on late uploads)
    "late_upload",                                       # stale or late
    "outdated", "change_signal",                         # fast-changing truth
    "rumour", "out_of_area",
    "malicious_burst", "sybil", "empty_help",            # malicious
)
"""Values of ``kind_of_noise`` (None = an honest, unaltered event; ``truth_change`` = a timeline entry)."""

# ---- calibration from the 2018 record (tools/camp_ground_record.json, NIST TN 2252sup) ---------------

CAMP_A2_ROWS_KEPT = 356
CAMP_A2_DUPLICATE_QUOTES_MERGED = 12
DUPLICATE_RESUBMIT_SHARE_CAMP = CAMP_A2_DUPLICATE_QUOTES_MERGED / (CAMP_A2_ROWS_KEPT + CAMP_A2_DUPLICATE_QUOTES_MERGED)
"""CALIBRATED (0.0326): Table A-2 911 and radio rows whose text repeats an earlier row of the same
observation, merged by the record builder (record header ``extraction``: 12 merged of 368 parsed).
It is the repeat rate of one source quoting one observation twice: used as the resubmit share. NIST
transcribed a sample of calls, so this is a lower bound on repeats in the full stream."""

CAMP_ROWS_WITH_POINT = 340
CAMP_SAME_EVENT_GROUPS = 302
CAMP_REPEATED_GROUPS = 26
CROWD_ECHO_SHARE_CAMP = CAMP_REPEATED_GROUPS / CAMP_SAME_EVENT_GROUPS
"""CALIBRATED (0.0861): the record's 340 911 and radio rows with a point form 302 groups of the same
category and ~100 m point within 15 min of the group's first row; 26 groups have repeats (38 extra
rows, 0.126 per group). Measured 2026-10-24 by grouping rows on (category, coord at 3 decimals, 15 min);
recomputed in tests/test_gen_noise.py. Used as the share of honest reports that get same-event reports
from other parties, with the extra count drawn from CROWD_ECHO_EXTRA_DIST_CAMP."""
CROWD_ECHO_EXTRA_DIST_CAMP = ((1, 18), (2, 6), (4, 2))
"""CALIBRATED: among the 26 repeated groups, 18 had 2 rows, 6 had 3, 2 had 5, i.e. (extra rows, groups)."""
CROWD_ECHO_WINDOW_MIN = 15.0
"""The window of that measurement: echoes arrive within this many minutes of the first report."""

# ---- other constants (ASSUMPTION unless marked) -------------------------------------------------------

GPS_OFFSET_SIGMA_M = 40.0
"""ASSUMPTION: per-axis sigma of a degraded phone fix (smoke, canyon, trees). GPS.gov puts open-sky
smartphone accuracy at about 4.9 m; multipath and obstruction raise it to tens of metres. Not measured."""
GPS_OFFSET_TRUE = True
"""ASSUMPTION: a GPS-offset report is still true (right claim, imprecise place); only the location moves."""
WRONG_ROAD_MAX_M = 600.0
"""ASSUMPTION: a wrong-road report names a parallel or crossing road within this distance."""
WRONG_ROAD_FALLBACK_M = (150.0, 400.0)
"""ASSUMPTION: without a road list, the report moves a uniform distance in this range, any bearing."""
WRONG_KIND = {"heavy_smoke": "fire_seen", "fire_seen": "heavy_smoke", "heavy_traffic": "road_blocked",
              "road_blocked": "heavy_traffic"}
"""ASSUMPTION: confusable kinds (smoke reported as fire, a jam reported as a block, and the reverse)."""
LATE_UPLOAD_MEDIAN_MIN = 20.0
LATE_UPLOAD_SIGMA = 1.0
LATE_UPLOAD_MAX_MIN = 240.0
"""ASSUMPTION: a late upload (dead zone, offline outbox) arrives a lognormal delay after it was observed:
median 20 min, shape 1.0, capped at 4 h ("minutes to hours", ADR 0042). ``observed_at`` is kept."""
OUTAGE_RETRY_JITTER_S = 60.0
"""Reports queued during a comms outage upload within this many seconds after it ends (the server's
``Retry-After: 60``, docs/live-reports.md ``comms_outage``)."""
RETRY_STORM_COPIES = (2, 5)
"""ASSUMPTION: a retry storm resends a queued report this many times (uniform), same ``client_id``,
within RETRY_STORM_SPAN_S; the server dedupes on (incident, client_id) (ADR 0011 outbox)."""
RETRY_STORM_SPAN_S = 30.0
RESUBMIT_DELAY_S = (20.0, 600.0)
"""ASSUMPTION: the same person re-sends the same claim (new client id) this many seconds later (uniform)."""
ECHO_RADIUS_M = 100.0
"""ASSUMPTION: crowd echoes stand within this distance of the first report (the record's ~100 m points)."""
CHANGE_MATCH_RADIUS_M = 200.0
"""A report is about a truth-change place when within this distance (livecore/public.py CLUSTER_RADIUS_M)."""
CHANGE_SIGNAL_DELAY_MEDIAN_MIN = 10.0
CHANGE_SIGNAL_DELAY_SIGMA = 0.8
"""ASSUMPTION: true reports of the new state follow a change after a lognormal delay (median 10 min)."""
OUTDATED_ECHO_SPAN_MIN = 45.0
"""ASSUMPTION: stale echoes of the old state arrive uniformly within this many minutes after a change."""
RUMOUR_MIN_PARTIES = 3
"""A rumour has at least this many parties: enough to pass the public rule's 3-party bar
(livecore/public.py PUBLIC_MIN_CIVILIAN_PARTIES) when each counts as independent."""
RUMOUR_SPREAD_MEAN_MIN = 4.0
"""ASSUMPTION: mean minutes between successive echoes of a rumour (exponential inter-arrival)."""
RUMOUR_COORD_SIGMA_M = 150.0
"""ASSUMPTION: echo pins scatter around the claimed place (people drop a pin on the road they heard of)."""
OUT_OF_AREA_KM = (30.0, 150.0)
"""ASSUMPTION: relays of media or social posts come from this far from the scenario centroid."""
OUT_OF_AREA_KINDS = ("fire_seen", "road_blocked")
BURST_SPAN_S = 120.0
"""ASSUMPTION: a single-device burst lands within this many seconds (tests the 6/min, 60/h limits)."""
BURST_RADIUS_M = 800.0
"""ASSUMPTION: burst reports scatter within this distance of the attacker's pick."""
BURST_KINDS = ("road_blocked", "fire_seen", "hazard_down")
SYBIL_SPACING_S = (130.0, 300.0)
SYBIL_OFFSET_M = (120.0, 400.0)
"""ASSUMPTION: a careful Sybil set spaces reports just beyond the server's same-party rule (120 s and
100 m, livecore/public.py SAME_PARTY_WINDOW_S / SAME_PARTY_RADIUS_M) so each device counts."""
EMPTY_HELP_MIN_DIST_M = 500.0
"""ASSUMPTION: a help request is at an empty place when no occupied point is within this distance."""
POINT_TRIES = 200


@dataclass(frozen=True)
class NoiseProfile:
    """Rates of each noise kind. Shares apply per eligible honest event; ``*_per_h`` per drill hour of
    the window; ``*_per_change`` per truth change. All ASSUMPTION except the two CALIBRATED shares."""

    name: str
    wrong_road_share: float = 0.0
    gps_offset_share: float = 0.0
    wrong_kind_share: float = 0.0
    resubmit_share: float = 0.0
    crowd_echo_share: float = 0.0
    late_upload_share: float = 0.0
    retry_storm_share: float = 0.0
    """Of late or outage-delayed uploads, the share that come back as a retry storm."""
    outdated_per_change: float = 0.0
    change_signals_per_change: float = 0.0
    rumours_per_h: float = 0.0
    rumour_parties_mean: float = 0.0
    out_of_area_per_h: float = 0.0
    bursts_per_h: float = 0.0
    burst_size: int = 0
    sybil_sets_per_h: float = 0.0
    sybil_devices: int = 0
    empty_help_per_h: float = 0.0

    def __post_init__(self) -> None:
        shares = (self.wrong_road_share + self.gps_offset_share + self.wrong_kind_share + self.late_upload_share)
        if shares > 1.0:
            raise ValueError("transform shares (wrong road, gps, wrong kind, late) must sum to <= 1")
        for k, v in asdict(self).items():
            if k != "name" and (not isinstance(v, (int, float)) or v < 0 or not math.isfinite(v)):
                raise ValueError(f"{k} must be a finite non-negative number")
        for k in ("resubmit_share", "crowd_echo_share", "retry_storm_share"):
            if getattr(self, k) > 1.0:
                raise ValueError(f"{k} must be <= 1")


PROFILES: dict[str, NoiseProfile] = {
    "clean": NoiseProfile("clean"),
    "typical": NoiseProfile(
        "typical",
        wrong_road_share=0.03, gps_offset_share=0.10, wrong_kind_share=0.05,
        resubmit_share=round(DUPLICATE_RESUBMIT_SHARE_CAMP, 4), crowd_echo_share=round(CROWD_ECHO_SHARE_CAMP, 4),
        late_upload_share=0.05, retry_storm_share=0.5,
        outdated_per_change=1.0, change_signals_per_change=2.0,
        rumours_per_h=0.25, rumour_parties_mean=5.0, out_of_area_per_h=0.5,
    ),
    "hostile": NoiseProfile(
        "hostile",
        wrong_road_share=0.06, gps_offset_share=0.15, wrong_kind_share=0.10,
        resubmit_share=round(2 * DUPLICATE_RESUBMIT_SHARE_CAMP, 4), crowd_echo_share=round(CROWD_ECHO_SHARE_CAMP, 4),
        late_upload_share=0.15, retry_storm_share=0.8,
        outdated_per_change=3.0, change_signals_per_change=1.0,
        rumours_per_h=1.0, rumour_parties_mean=8.0, out_of_area_per_h=2.0,
        bursts_per_h=0.25, burst_size=30, sybil_sets_per_h=0.25, sybil_devices=6, empty_help_per_h=1.0,
    ),
}
"""``clean``: no noise (honest streams, truth all true). ``typical``: the 2018-calibrated duplicate rates
plus assumed honest error, late uploads, stale echoes and occasional rumours; no attacker. ``hostile``:
doubled error and duplicates, frequent rumours, and malicious devices. Only the two CALIBRATED shares
come from data; every other number is an ASSUMPTION to vary in sensitivity runs."""


@dataclass(frozen=True)
class TruthChange:
    """One change of ground truth at a place: from ``before`` to ``after`` at ``at`` (drill time).

    ``before`` / ``after`` are the report kind that is true there (``road_passable``, ``road_blocked``,
    ``fire_seen``, ``shelter_full``) or None for "nothing to report". A place's changes share
    ``place_id`` and must chain (``after`` of one is ``before`` of the next). ``silent``: no report of the
    new state is generated (a block that clears without a report)."""

    id: str
    place_id: str
    at: datetime
    coord: tuple[float, float]
    before: str | None
    after: str | None
    label: str = ""
    silent: bool = False
    destination_id: str | None = None


@dataclass(frozen=True)
class RoadRef:
    """A named road edge for wrong-road errors: ``coords`` (lon, lat) as in the bundle's ``roads.edges``."""

    id: str
    name: str | None
    coords: tuple[tuple[float, float], ...]


@dataclass(frozen=True)
class NoiseOptions:
    """Scenario inputs beyond the events. ``window``: drill-time span for ``*_per_h`` injections
    (default: first to last honest event). ``outages``: comms outages ``(start, end, centre, radius_m)``
    (centre None = everywhere): reports observed inside one upload after it ends. ``occupied``: points
    with people (default: honest event points). ``incident_id`` fills report paths."""

    changes: tuple[TruthChange, ...] = ()
    roads: tuple[RoadRef, ...] = ()
    window: tuple[datetime, datetime] | None = None
    outages: tuple[tuple[datetime, datetime, tuple[float, float] | None, float], ...] = ()
    occupied: tuple[tuple[float, float], ...] = ()
    incident_id: str | None = None


# ---- small helpers -----------------------------------------------------------------------------------------

def parse_utc(value: str) -> datetime:
    at = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if at.tzinfo is None:
        raise ValueError(f"timestamp without zone: {value}")
    return at.astimezone(timezone.utc)


def iso(at: datetime) -> str:
    return at.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def seed_int(*labels: Any) -> int:
    """A 63-bit seed from labels (sha256), independent of PYTHONHASHSEED."""
    text = "\x1f".join(str(x) for x in labels)
    return int.from_bytes(hashlib.sha256(text.encode("utf-8")).digest()[:8], "big") >> 1


def _uuid(*labels: Any) -> str:
    digest = hashlib.sha256("\x1f".join(str(x) for x in labels).encode("utf-8")).digest()
    return str(uuid.UUID(bytes=digest[:16], version=4))


def _party(seed: int, *labels: Any) -> str:
    return PARTY_KEY_PREFIX + hashlib.sha256("\x1f".join(["noise", str(seed), *map(str, labels)]).encode()).hexdigest()[:16]


def _m_per_deg(lat: float) -> tuple[float, float]:
    m_lat = math.pi * EARTH_RADIUS_M / 180.0
    return m_lat * math.cos(math.radians(lat)), m_lat


def distance_m(a: Sequence[float], b: Sequence[float]) -> float:
    mx, my = _m_per_deg((a[1] + b[1]) / 2)
    return math.hypot((a[0] - b[0]) * mx, (a[1] - b[1]) * my)


def offset(p: Sequence[float], dx_m: float, dy_m: float) -> list[float]:
    mx, my = _m_per_deg(p[1])
    return [round(p[0] + dx_m / mx, COORD_DECIMALS), round(p[1] + dy_m / my, COORD_DECIMALS)]


def _polar(rng: random.Random, p: Sequence[float], lo_m: float, hi_m: float) -> list[float]:
    r, th = rng.uniform(lo_m, hi_m), rng.uniform(0, 2 * math.pi)
    return offset(p, r * math.cos(th), r * math.sin(th))


def _poisson(rng: random.Random, lam: float) -> int:
    """Knuth's method for small means, a rounded normal above 30 (only the hostile profile gets near)."""
    if lam <= 0:
        return 0
    if lam > 30:
        return max(0, round(rng.gauss(lam, math.sqrt(lam))))
    limit, k, p = math.exp(-lam), 0, 1.0
    while True:
        p *= rng.random()
        if p <= limit:
            return k
        k += 1


def _lognormal_min(rng: random.Random, median_min: float, sigma: float, cap_min: float | None = None) -> float:
    v = median_min * math.exp(rng.gauss(0.0, sigma))
    return min(v, cap_min) if cap_min is not None else v


def _nearest_on_polyline(p: Sequence[float], coords: Sequence[Sequence[float]]) -> tuple[list[float], float]:
    mx, my = _m_per_deg(p[1])
    best, best_d = list(coords[0]), math.inf
    for a, b in zip(coords, coords[1:]):
        ax, ay = (a[0] - p[0]) * mx, (a[1] - p[1]) * my
        bx, by = (b[0] - p[0]) * mx, (b[1] - p[1]) * my
        dx, dy = bx - ax, by - ay
        L = dx * dx + dy * dy
        t = 0.0 if L == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / L))
        qx, qy = ax + t * dx, ay + t * dy
        d = math.hypot(qx, qy)
        if d < best_d:
            best_d, best = d, [p[0] + qx / mx, p[1] + qy / my]
    return [round(best[0], COORD_DECIMALS), round(best[1], COORD_DECIMALS)], best_d


# ---- event adapters ------------------------------------------------------------------------------------------

def source_of(ev: Mapping[str, Any]) -> str:
    """``resident``, ``responder``, ``comms`` or ``real`` (passes through, never altered, no truth entry)."""
    ec = ev.get("evidence_class")
    if ec is not None and ec != EVIDENCE_CLASS:
        return "real"
    if "unit" in ev and "op" in ev:
        return "responder"
    if ec == EVIDENCE_CLASS and "channel" in ev and "category" in ev:
        return "comms"
    if ec == EVIDENCE_CLASS and ev.get("type") in ("report", "checkin", "destination"):
        return "resident"
    return "real"


def is_report(ev: Mapping[str, Any]) -> bool:
    src = source_of(ev)
    return (src == "resident" and ev.get("type") == "report") or (src == "responder" and ev.get("op") == "report") \
        or src == "comms"


def event_id(ev: Mapping[str, Any]) -> str:
    """``body.client_id`` for phone and responder reports, ``id`` for comms items, else a content hash."""
    body = ev.get("body") or {}
    if isinstance(body, dict) and body.get("client_id"):
        return str(body["client_id"])
    if source_of(ev) == "comms" and ev.get("id"):
        return str(ev["id"])
    return "ev-" + hashlib.sha256(json.dumps(ev, sort_keys=True, default=str).encode()).hexdigest()[:16]


def kind_of(ev: Mapping[str, Any]) -> str | None:
    return ev.get("category") if source_of(ev) == "comms" else (ev.get("body") or {}).get("kind")


def coord_of(ev: Mapping[str, Any]) -> list[float] | None:
    if source_of(ev) == "comms":
        return ev.get("coord")
    return ((ev.get("body") or {}).get("location") or {}).get("coord")


def upload_at(ev: Mapping[str, Any]) -> datetime:
    return parse_utc(ev["at"])


def observed_at(ev: Mapping[str, Any]) -> datetime:
    obs = (ev.get("body") or {}).get("observed_at") if source_of(ev) != "comms" else None
    return parse_utc(obs) if obs else upload_at(ev)


def party_of(ev: Mapping[str, Any]) -> str | None:
    return ev.get("party_key") or ev.get("unit")


def _set_kind(ev: dict, kind: str) -> None:
    if source_of(ev) == "comms":
        ev["category"] = kind
    else:
        ev["body"]["kind"] = kind
        if kind != "road_blocked" and ev["body"].get("severity") == "full":
            ev["body"]["severity"] = None


def _set_coord(ev: dict, coord: list[float], road_name: str | None = None) -> None:
    if source_of(ev) == "comms":
        ev["coord"] = [round(coord[0], 3), round(coord[1], 3)]  # the record's ~100 m precision
        if road_name is not None:
            ev["road_name"] = road_name
    else:
        ev["body"]["location"]["coord"] = [round(coord[0], COORD_DECIMALS), round(coord[1], COORD_DECIMALS)]


def _set_id(ev: dict, new_id: str) -> None:
    if source_of(ev) == "comms":
        ev["id"] = new_id
    else:
        ev["body"]["client_id"] = new_id


def _set_party(ev: dict, party: str) -> None:
    if source_of(ev) == "resident":
        ev["party_key"] = party


def report_event(*, client_id: str, kind: str, coord: Sequence[float], observed: datetime, upload: datetime,
                 party_key: str, incident_id: str | None, severity: str | None = None,
                 destination_id: str | None = None) -> dict[str, Any]:
    """A phone report in the residents' event shape (sim/gen_residents.py ``_event`` + ``report_body``)."""
    if kind == "road_blocked" and severity is None:
        severity = "full"
    body = {"client_id": client_id, "kind": kind, "severity": severity,
            "location": {"coord": [round(coord[0], COORD_DECIMALS), round(coord[1], COORD_DECIMALS)],
                         "accuracy_m": REPORT_ACCURACY_M},
            "heading_deg": None, "destination_id": destination_id, "task_id": None,
            "observed_at": iso(observed), "note": REPORT_NOTE}
    return {"type": "report", "method": "POST",
            "path": f"incidents/{incident_id or '{incident_id}'}/reports", "body": body, "at": iso(upload),
            "party_key": party_key, "evidence_class": EVIDENCE_CLASS, "zone_id": None, "household": None,
            "cause": {"source": "noise"}, "generator": GENERATOR}


# ---- the ground-truth timeline -----------------------------------------------------------------------------

class Timeline:
    """State of each truth-change place over drill time."""

    def __init__(self, changes: Iterable[TruthChange]):
        self.places: dict[str, list[TruthChange]] = {}
        for c in sorted(changes, key=lambda c: (c.place_id, c.at, c.id)):
            self.places.setdefault(c.place_id, []).append(c)
        for pid, chain in self.places.items():
            for a, b in zip(chain, chain[1:]):
                if a.after != b.before:
                    raise ValueError(f"truth changes at {pid} do not chain: {a.id} -> {b.id}")

    def state(self, place_id: str, at: datetime) -> str | None:
        chain = self.places[place_id]
        cur = chain[0].before
        for c in chain:
            if c.at <= at:
                cur = c.after
        return cur

    def domain(self, place_id: str) -> set[str]:
        kinds = {k for c in self.places[place_id] for k in (c.before, c.after) if k}
        return kinds | {CONTRADICTS[k] for k in kinds if k in CONTRADICTS}

    def place_for(self, kind: str | None, coord: Sequence[float] | None) -> str | None:
        """The nearest place within CHANGE_MATCH_RADIUS_M whose domain includes ``kind``."""
        if kind is None or coord is None:
            return None
        best, best_d = None, CHANGE_MATCH_RADIUS_M
        for pid, chain in self.places.items():
            if kind in self.domain(pid):
                d = distance_m(coord, chain[0].coord)
                if d <= best_d:
                    best, best_d = pid, d
        return best

    def judge(self, kind: str | None, coord: Sequence[float] | None,
              at: datetime) -> tuple[bool | None, str | None, datetime | None]:
        """(claim true at ``at``, place id, time the claim stops (or starts) being true). None when no place
        covers the claim; the caller then keeps its own judgement."""
        pid = self.place_for(kind, coord)
        if pid is None:
            return None, None, None
        holds = self.state(pid, at) == kind
        flip = next((c.at for c in self.places[pid] if c.at > at and (c.after == kind) != holds), None)
        return holds, pid, flip


# ---- the noise layer ------------------------------------------------------------------------------------------

@dataclass
class _Out:
    ev: dict[str, Any]
    truth: dict[str, Any] | None  # None: same id as an earlier event (retry copy)


def _truth(true: bool, kind_of_noise: str | None, source_event_id: str | None, notes: str,
           **extra: Any) -> dict[str, Any]:
    return {"true": true, "kind_of_noise": kind_of_noise, "source_event_id": source_event_id, "notes": notes,
            **{k: v for k, v in extra.items() if v is not None}}


def _claim_fields(ev: Mapping[str, Any], timeline: Timeline, default_true: bool,
                  ) -> tuple[bool, dict[str, Any]]:
    """Judge a report against the timeline; the default holds when no truth-change place covers it."""
    kind, coord, obs = kind_of(ev), coord_of(ev), observed_at(ev)
    holds, pid, flip = timeline.judge(kind, coord, obs)
    true = default_true if holds is None else (holds and default_true)
    extra: dict[str, Any] = {"claim": kind, "coord": coord, "observed_at": iso(obs), "upload_at": ev["at"],
                             "party_key": party_of(ev)}
    if pid is not None:
        extra["place_id"] = pid
        if true and flip is not None:
            extra["true_until"] = iso(flip)
        if not true and holds is False and default_true and flip is not None:
            extra["true_from"] = iso(flip)
    return true, extra


def _road_switch(rng: random.Random, coord: Sequence[float], roads: Sequence[RoadRef]) -> tuple[list[float], str | None] | None:
    """A point on a different named road within WRONG_ROAD_MAX_M (parallel or crossing street)."""
    snapped = [(r, *_nearest_on_polyline(coord, r.coords)) for r in roads if len(r.coords) >= 2]
    if not snapped:
        return None
    own = min(snapped, key=lambda x: x[2])
    others = [(r, p, d) for r, p, d in snapped
              if d <= WRONG_ROAD_MAX_M and r.id != own[0].id and (r.name or r.id) != (own[0].name or own[0].id)]
    if not others:
        return None
    others.sort(key=lambda x: (x[2], x[0].id))
    r, p, _ = others[rng.randrange(min(3, len(others)))]
    return p, r.name


def _outage_end(at: datetime, coord: Sequence[float] | None, outages: NoiseOptions) -> datetime | None:
    for start, end, centre, radius_m in outages.outages:
        if start <= at < end and (centre is None or coord is None or distance_m(coord, centre) <= radius_m):
            return end
    return None


def apply_noise(events: Sequence[Mapping[str, Any]], profile: NoiseProfile | str, seed: int,
                options: NoiseOptions | None = None) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    """Return ``(events_out, truth)``; see the module docstring. ``events`` is never mutated."""
    prof = PROFILES[profile] if isinstance(profile, str) else profile
    opt = options or NoiseOptions()
    timeline = Timeline(opt.changes)
    out: list[_Out] = []
    seen_ids: set[str] = set()

    honest = [copy.deepcopy(dict(e)) for e in events]
    report_points = [coord_of(e) for e in honest if is_report(e) and coord_of(e)]
    times = [upload_at(e) for e in honest if source_of(e) != "real" and e.get("at")]
    window = opt.window or ((min(times), max(times)) if times else None)
    incident_id = opt.incident_id

    def emit(ev: dict[str, Any], truth: dict[str, Any] | None) -> None:
        eid = event_id(ev)
        if truth is not None and eid in seen_ids:
            raise ValueError(f"duplicate event id {eid}")  # every new event has a fresh id by construction
        if truth is not None:
            seen_ids.add(eid)
        out.append(_Out(ev, truth))

    # 1. per honest event: transform, delay, duplicate.
    for ev in honest:
        src = source_of(ev)
        if src == "real":
            out.append(_Out(ev, None))  # untouched, no truth entry
            continue
        eid = event_id(ev)
        if not is_report(ev):
            emit(ev, _truth(True, None, None, "honest non-report event", source=src))
            continue
        rng = random.Random(seed_int(seed, prof.name, "event", eid))
        kind, coord = kind_of(ev), coord_of(ev)
        base_true, extra = _claim_fields(ev, timeline, True)
        u = rng.random()
        cut_road = prof.wrong_road_share
        cut_gps = cut_road + prof.gps_offset_share
        cut_kind = cut_gps + prof.wrong_kind_share
        cut_late = cut_kind + prof.late_upload_share
        cur, truth = ev, _truth(base_true, None, None, "honest", **extra)
        if src != "responder" and u < cut_road and kind in ROAD_KINDS and coord:
            moved = _road_switch(rng, coord, opt.roads)
            new = copy.deepcopy(ev)
            if moved is not None:
                _set_coord(new, moved[0], moved[1])
                how = f"moved to {moved[1] or 'another road'}"
            else:
                _set_coord(new, _polar(rng, coord, *WRONG_ROAD_FALLBACK_M))
                how = "moved off the road it names (no road list)"
            _set_id(new, _uuid(seed, "wrong_road", eid))
            _, extra2 = _claim_fields(new, timeline, False)
            cur, truth = new, _truth(False, "wrong_road", eid, f"honest error: {how}", **extra2)
        elif src == "resident" and cut_road <= u < cut_gps and coord:
            new = copy.deepcopy(ev)
            _set_coord(new, offset(coord, rng.gauss(0, GPS_OFFSET_SIGMA_M), rng.gauss(0, GPS_OFFSET_SIGMA_M)))
            _set_id(new, _uuid(seed, "gps_offset", eid))
            t2, extra2 = _claim_fields(new, timeline, GPS_OFFSET_TRUE and base_true)
            cur, truth = new, _truth(t2, "gps_offset", eid, "honest error: degraded GPS fix", **extra2)
        elif src != "responder" and cut_gps <= u < cut_kind and kind in WRONG_KIND:
            new = copy.deepcopy(ev)
            _set_kind(new, WRONG_KIND[kind])
            _set_id(new, _uuid(seed, "wrong_kind", eid))
            _, extra2 = _claim_fields(new, timeline, False)
            cur, truth = new, _truth(False, "wrong_kind", eid, f"honest error: {kind} reported as {WRONG_KIND[kind]}",
                                     **extra2)
        # Late upload: background share, or a comms outage covering the observation (residents only:
        # responders are exempt from outages, docs/live-reports.md comms_outage).
        late_end = _outage_end(observed_at(cur), coord_of(cur), opt) if src == "resident" else None
        late = late_end is not None or (src != "comms" and cut_kind <= u < cut_late)
        if late:
            obs0 = observed_at(cur)
            cur = copy.deepcopy(cur) if cur is ev else cur
            if isinstance(cur.get("body"), dict) and not cur["body"].get("observed_at"):
                cur["body"]["observed_at"] = iso(obs0)  # keep the observation time when the upload moves
            if late_end is not None:
                new_at = max(upload_at(cur), late_end + timedelta(seconds=rng.uniform(0, OUTAGE_RETRY_JITTER_S)))
                why = "queued during a comms outage"
            else:
                new_at = upload_at(cur) + timedelta(minutes=_lognormal_min(
                    rng, LATE_UPLOAD_MEDIAN_MIN, LATE_UPLOAD_SIGMA, LATE_UPLOAD_MAX_MIN))
                why = "dead zone"
            cur["at"] = iso(new_at)
            if truth["kind_of_noise"] is None:
                truth = {**truth, "kind_of_noise": "late_upload", "notes": f"stale or late: {why}"}
            else:
                truth = {**truth, "notes": truth["notes"] + f"; uploaded late ({why})"}
            truth["upload_at"] = cur["at"]
            truth["late_min"] = round((new_at - observed_at(cur)).total_seconds() / 60.0, 1)
            if "true_until" in truth and parse_utc(truth["true_until"]) <= new_at:
                truth["stale_at_upload"] = True
        emit(cur, truth)
        if late and rng.random() < prof.retry_storm_share:
            n = rng.randint(*RETRY_STORM_COPIES)
            base = upload_at(cur)
            for k in range(n):
                dup = copy.deepcopy(cur)
                dup["at"] = iso(base + timedelta(seconds=rng.uniform(1, RETRY_STORM_SPAN_S)))
                out.append(_Out(dup, None))
            truth["retry_copies"] = n
        # Duplicates of what was emitted (an error repeats with its error).
        if rng.random() < prof.resubmit_share:
            dup = copy.deepcopy(cur)
            _set_id(dup, _uuid(seed, "resubmit", eid))
            d_at = upload_at(cur) + timedelta(seconds=rng.uniform(*RESUBMIT_DELAY_S))
            dup["at"] = iso(d_at)
            if src != "comms" and dup.get("body", {}).get("observed_at"):
                dup["body"]["observed_at"] = iso(min(d_at, observed_at(cur) + timedelta(seconds=rng.uniform(*RESUBMIT_DELAY_S))))
            emit(dup, {**{k: v for k, v in truth.items() if k != "retry_copies"},
                       "kind_of_noise": "duplicate_resubmit", "source_event_id": event_id(cur),
                       "notes": "same party re-sends the same claim", "upload_at": dup["at"]})
        if src != "responder" and rng.random() < prof.crowd_echo_share:
            extra_n = _draw_weighted(rng, CROWD_ECHO_EXTRA_DIST_CAMP)
            c0 = coord_of(cur)
            for k in range(extra_n):
                dup = copy.deepcopy(cur)
                _set_id(dup, _uuid(seed, "echo", eid, k))
                _set_party(dup, _party(seed, "echo", eid, k))
                if c0:
                    _set_coord(dup, _polar(rng, c0, 0.0, ECHO_RADIUS_M))
                d_at = upload_at(cur) + timedelta(minutes=rng.uniform(0, CROWD_ECHO_WINDOW_MIN))
                dup["at"] = iso(d_at)
                if src == "resident":
                    dup["body"]["observed_at"] = dup["at"]
                t2, extra2 = _claim_fields(dup, timeline, truth["true"])
                emit(dup, _truth(t2, "duplicate_crowd", event_id(cur), "another party reports the same event",
                                 **extra2))

    # 2. Fast-changing truth: stale echoes of the old state, delayed reports of the new one.
    rng = random.Random(seed_int(seed, prof.name, "changes"))
    for c in sorted(opt.changes, key=lambda c: (c.at, c.id)):
        if c.before:
            for k in range(_poisson(rng, prof.outdated_per_change)):
                at = c.at + timedelta(minutes=rng.uniform(0, OUTDATED_ECHO_SPAN_MIN))
                ev = report_event(client_id=_uuid(seed, "outdated", c.id, k), kind=c.before,
                                  coord=_polar(rng, c.coord, 0, ECHO_RADIUS_M), observed=at, upload=at,
                                  party_key=_party(seed, "outdated", c.id, k), incident_id=incident_id,
                                  destination_id=c.destination_id)
                t, extra = _claim_fields(ev, timeline, False)
                emit(ev, _truth(t, "outdated", None, f"repeats the state before change {c.id}", change_id=c.id, **extra))
        if c.after and not c.silent:
            for k in range(_poisson(rng, prof.change_signals_per_change)):
                at = c.at + timedelta(minutes=_lognormal_min(rng, CHANGE_SIGNAL_DELAY_MEDIAN_MIN, CHANGE_SIGNAL_DELAY_SIGMA))
                ev = report_event(client_id=_uuid(seed, "signal", c.id, k), kind=c.after,
                                  coord=_polar(rng, c.coord, 0, ECHO_RADIUS_M), observed=at, upload=at,
                                  party_key=_party(seed, "signal", c.id, k), incident_id=incident_id,
                                  destination_id=c.destination_id)
                t, extra = _claim_fields(ev, timeline, True)
                emit(ev, _truth(t, "change_signal", None, f"reports the new state of change {c.id}", change_id=c.id,
                                **extra))

    if window is not None:
        hours = max((window[1] - window[0]).total_seconds() / 3600.0, 0.0)
        centre = _centroid(report_points) if report_points else None
        occupied = list(opt.occupied) or report_points
        if centre is not None:
            _rumours(emit, prof, seed, window, hours, timeline, honest, centre, incident_id)
            _out_of_area(emit, prof, seed, window, hours, centre, incident_id)
            _malicious(emit, prof, seed, window, hours, centre, occupied, timeline, incident_id)

    truth_map: dict[str, dict[str, Any]] = {}
    for o in out:
        if o.truth is not None:
            truth_map[event_id(o.ev)] = o.truth
    for c in opt.changes:
        truth_map[TRUTH_CHANGE_PREFIX + c.id] = _truth(
            True, "truth_change", None, c.label or f"{c.before} -> {c.after}", at=iso(c.at), place_id=c.place_id,
            coord=list(c.coord), before=c.before, after=c.after, silent=c.silent)
    events_out = [o.ev for o in sorted(out, key=lambda o: (upload_at(o.ev) if o.ev.get("at") else datetime.min.replace(tzinfo=timezone.utc), event_id(o.ev)))]
    return events_out, truth_map


def _draw_weighted(rng: random.Random, table: Sequence[tuple[int, int]]) -> int:
    total = sum(w for _, w in table)
    x = rng.uniform(0, total)
    for value, w in table:
        x -= w
        if x <= 0:
            return value
    return table[-1][0]


def _centroid(points: Sequence[Sequence[float]]) -> list[float]:
    return [sum(p[0] for p in points) / len(points), sum(p[1] for p in points) / len(points)]


def _onsets(rng: random.Random, window: tuple[datetime, datetime], hours: float, per_h: float) -> list[datetime]:
    n = _poisson(rng, per_h * hours)
    span = (window[1] - window[0]).total_seconds()
    return sorted(window[0] + timedelta(seconds=rng.uniform(0, span)) for _ in range(n))


def _rumours(emit, prof: NoiseProfile, seed: int, window, hours: float, timeline: Timeline,
             honest: Sequence[Mapping[str, Any]], centre, incident_id) -> None:
    """A false claim that spreads: a seed report, then echoes from distinct parties at exponential
    intervals, pins scattered around the claimed place. Correlated, not independent."""
    rng = random.Random(seed_int(seed, prof.name, "rumour"))
    road_reports = [e for e in honest if is_report(e) and kind_of(e) in ROAD_KINDS and coord_of(e)]
    for i, onset in enumerate(_onsets(rng, window, hours, prof.rumours_per_h)):
        # Target: a truth-change place whose state at onset is road_passable, else an honest road report
        # (the rumour claims the opposite), else a point near the centre. ASSUMPTION: in the last two cases
        # the claim is false by construction (no timeline says otherwise).
        open_places = [pid for pid, ch in sorted(timeline.places.items())
                       if timeline.state(pid, onset) == "road_passable"]
        if open_places:
            pid = open_places[rng.randrange(len(open_places))]
            target, claim = list(timeline.places[pid][0].coord), "road_blocked"
        elif road_reports:
            src = road_reports[rng.randrange(len(road_reports))]
            target = coord_of(src)
            claim = "road_passable" if kind_of(src) == "road_blocked" else "road_blocked"
        else:
            target, claim = _polar(rng, centre, 0, 2_000), "road_blocked"
        n = max(RUMOUR_MIN_PARTIES, _poisson(rng, prof.rumour_parties_mean))
        rid = f"rumour-{seed}-{i}"
        at = onset
        for k in range(n):
            if k:
                at = at + timedelta(minutes=rng.expovariate(1.0 / RUMOUR_SPREAD_MEAN_MIN))
            sx, sy = rng.gauss(0, RUMOUR_COORD_SIGMA_M), rng.gauss(0, RUMOUR_COORD_SIGMA_M)
            ev = report_event(client_id=_uuid(seed, rid, k), kind=claim, coord=offset(target, sx, sy), observed=at,
                              upload=at, party_key=_party(seed, rid, k), incident_id=incident_id)
            t, extra = _claim_fields(ev, timeline, False)
            emit(ev, _truth(t, "rumour", None, f"rumour {rid}: {claim} (member {k + 1} of {n})", rumour_id=rid,
                            rumour_onset_at=iso(onset), rumour_place=list(target), rumour_seed=(k == 0), **extra))


def _out_of_area(emit, prof: NoiseProfile, seed: int, window, hours: float, centre, incident_id) -> None:
    rng = random.Random(seed_int(seed, prof.name, "out_of_area"))
    for i, at in enumerate(_onsets(rng, window, hours, prof.out_of_area_per_h)):
        coord = _polar(rng, centre, OUT_OF_AREA_KM[0] * 1000, OUT_OF_AREA_KM[1] * 1000)
        kind = OUT_OF_AREA_KINDS[rng.randrange(len(OUT_OF_AREA_KINDS))]
        ev = report_event(client_id=_uuid(seed, "ooa", i), kind=kind, coord=coord, observed=at, upload=at,
                          party_key=_party(seed, "ooa", i), incident_id=incident_id)
        emit(ev, _truth(False, "out_of_area", None, "relay of media or social posts from far away", claim=kind,
                        coord=coord, observed_at=iso(at), upload_at=iso(at), party_key=ev["party_key"],
                        distance_from_centre_km=round(distance_m(coord, centre) / 1000, 1)))


def _malicious(emit, prof: NoiseProfile, seed: int, window, hours: float, centre, occupied, timeline: Timeline,
               incident_id) -> None:
    rng = random.Random(seed_int(seed, prof.name, "malicious"))
    for i, at0 in enumerate(_onsets(rng, window, hours, prof.bursts_per_h)):
        party, pick = _party(seed, "burst", i), _polar(rng, centre, 0, 3_000)
        aid = f"burst-{seed}-{i}"
        for k in range(prof.burst_size):
            at = at0 + timedelta(seconds=rng.uniform(0, BURST_SPAN_S))
            kind = BURST_KINDS[rng.randrange(len(BURST_KINDS))]
            ev = report_event(client_id=_uuid(seed, aid, k), kind=kind, coord=_polar(rng, pick, 0, BURST_RADIUS_M),
                              observed=at, upload=at, party_key=party, incident_id=incident_id)
            t, extra = _claim_fields(ev, timeline, False)
            emit(ev, _truth(t, "malicious_burst", None, f"burst {aid}: one device floods reports", attack_id=aid, **extra))
    for i, at0 in enumerate(_onsets(rng, window, hours, prof.sybil_sets_per_h)):
        target, aid = _polar(rng, centre, 0, 3_000), f"sybil-{seed}-{i}"
        at = at0
        for k in range(prof.sybil_devices):
            if k:
                at = at + timedelta(seconds=rng.uniform(*SYBIL_SPACING_S))
            ev = report_event(client_id=_uuid(seed, aid, k), kind="road_blocked",
                              coord=_polar(rng, target, *SYBIL_OFFSET_M) if k else list(target), observed=at,
                              upload=at, party_key=_party(seed, aid, k), incident_id=incident_id)
            t, extra = _claim_fields(ev, timeline, False)
            emit(ev, _truth(t, "sybil", None, f"sybil set {aid}: fake devices agree", attack_id=aid, **extra))
    for i, at in enumerate(_onsets(rng, window, hours, prof.empty_help_per_h)):
        coord = None
        for _ in range(POINT_TRIES):
            cand = _polar(rng, centre, EMPTY_HELP_MIN_DIST_M, 6_000)
            if all(distance_m(cand, p) >= EMPTY_HELP_MIN_DIST_M for p in occupied):
                coord = cand
                break
        if coord is None:
            continue  # no empty place found: skip rather than put a false request among people
        ev = report_event(client_id=_uuid(seed, "empty_help", i), kind="help_needed", coord=coord, observed=at,
                          upload=at, party_key=_party(seed, "empty_help", i), incident_id=incident_id)
        emit(ev, _truth(False, "empty_help", None, "help requested where nobody is", claim="help_needed",
                        coord=coord, observed_at=iso(at), upload_at=iso(at), party_key=ev["party_key"]))


# ---- summaries -----------------------------------------------------------------------------------------------

def truth_summary(truth: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    """Counts by kind of noise and truth value (for logs and the ADR; never shown to drill participants)."""
    by: dict[str, dict[str, int]] = {}
    for entry in truth.values():
        k = entry.get("kind_of_noise") or "honest"
        row = by.setdefault(k, {"true": 0, "false": 0})
        row["true" if entry["true"] else "false"] += 1
    return {"by_kind": dict(sorted(by.items())), "entries": len(truth)}


def profile_params(profile: NoiseProfile | str) -> dict[str, Any]:
    """The profile as a dict, for ``generator_params_hash`` (sim/evaluation.py)."""
    prof = PROFILES[profile] if isinstance(profile, str) else profile
    return {"model": MODEL_VERSION, **asdict(prof)}


__all__ = [
    "NoiseOptions", "NoiseProfile", "PROFILES", "RoadRef", "Timeline", "TruthChange", "apply_noise", "event_id",
    "profile_params", "source_of", "truth_summary",
]
