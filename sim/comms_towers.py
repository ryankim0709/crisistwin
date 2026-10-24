"""Seeded cell-site failure model that schedules simulated ``comms_outage`` drill injects.

Planning model, not a prediction of real outages. Every inject it returns is labelled
``evidence_class: "simulated"``. Parameters come from ``tools/comms_degradation.json`` (built by
``tools/comms_infra_data.py``, explained in docs/comms-infrastructure.md); each carries the file's
provenance (sourced / derived / ASSUMPTION). Values the file does not give are the ``ASSUMED_*``
constants below, each with its rationale. Section "Tower-failure model (simulated comms_outage
injects)" of docs/comms-infrastructure.md has the measured behaviour.

Standard library only, pure (the only I/O is ``params_from_file``). Times are aware UTC
``datetime``; durations are hours (``*_h``) and rates per hour (``*_per_h``).

Model, per zone (zones are independent: ``random.Random(f"{seed}:comms-towers:{zone_id}")``):

1. The zone has ``n`` serving sites (``TowerZone.serving_sites`` or ``ASSUMED_SERVING_SITES_PER_ZONE``).
   All are exposed from the zone's fire arrival time to the end of the window. Zones with no fire
   arrival get no outage (non-fire power shutoffs are out of scope).
2. Fire damage: time to failure ~ Exponential(rate), i.e. P(failed by t) = 1 - exp(-rate * t),
   rate = ``fire_damage_to_sites.hazard_per_hour_inside_fire_perimeter`` (file formula).
3. Power: each exposed site loses commercial power at fire arrival
   (``ASSUMED_POWER_LOSS_DELAY_AFTER_ARRIVAL_H``) and runs on battery for a per-site draw, then fails.
   Pre-rule battery: triangular(low, high, mode=value) of ``backup_power.pre_2020_battery_hours``.
   For scenarios dated on/after ``rule_effective``, sites get the CPUC D.20-07-011 72 h backup, except
   the exempt/non-compliant share, which keeps the pre-rule draw.
4. A site is down from min(damage time, power loss + battery) (cause = whichever came first) until
   it is restored on the repair clock derived from ``recovery.fire_damaged_sites_repaired_share_by_day_2``.
5. The zone is in outage while at least ``ceil(ASSUMED_ZONE_OUTAGE_SITE_SHARE * n)`` of its sites are
   down. Each such interval becomes one inject; ``until`` is clamped to the window end.

Known simplifications (see docs): sites shared between neighbouring zones are drawn independently per
zone; a restored site does not fail again; recovery is measured from the site's own failure time.
"""

from __future__ import annotations

import json
import math
import random
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, fields
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from statistics import median
from typing import Any

SOURCE = "sim/comms_towers.py"
PARAMS_PATH = Path(__file__).resolve().parent.parent / "tools" / "comms_degradation.json"
PARAMS_FILE_LABEL = "tools/comms_degradation.json"

CAUSE_FIRE_DAMAGE = "fire_damage"
CAUSE_BATTERY_EXHAUSTED = "battery_exhausted"

# ---------------------------------------------------------------------------------------------
# Assumptions the parameter file does not cover. Each is a model choice, not an observation.
# ---------------------------------------------------------------------------------------------

# ASSUMPTION. Serving sites per zone (a census block group of roughly 1,000 households in the Camp
# bundle). The file gives only county totals (Butte: 174 sites served, FCC DIRS 2019) and no site
# coordinates or density, so a per-zone count cannot be derived. Paradise (about 26,000 residents)
# lost 7 to 9 towers (file: camp_2018_paradise_towers_down), a lower bound on the sites serving the
# town; with overlapping sectors a block group is typically within reach of a few of them. 3 is a
# round placeholder in that spirit, not a fit. Override per zone with TowerZone.serving_sites.
ASSUMED_SERVING_SITES_PER_ZONE = 3

# ASSUMPTION. Share of a zone's serving sites that must be down for the zone to count as in outage.
# 1.0 = all of them. Chosen because the file's caveat (FCC DIRS) says overlapping coverage keeps
# service up while individual sites fail; requiring every serving site down is the conservative reading.
ASSUMED_ZONE_OUTAGE_SITE_SHARE = 1.0

# ASSUMPTION. Hours from fire arrival to the loss of commercial power at the zone's sites. The file's
# power section covers PSPS de-energisation, not fire; inside a burning zone the distribution lines
# burn or are de-energised, so power is taken as lost on arrival.
ASSUMED_POWER_LOSS_DELAY_AFTER_ARRIVAL_H = 0.0

# ASSUMPTION. Shape of the per-site pre-rule battery draw. The file says "a per-site draw from
# low..high" around value 4 h; a triangular law with mode = value uses all three numbers.
ASSUMED_BATTERY_DRAW = "triangular(low, high, mode=value)"

# ASSUMPTION. Share of pre-rule sites with a generator (no battery-exhaustion failure in the window).
# The file says "a minority of generator-backed sites (share unknown)"; 0 because no number exists.
# This biases the pre-rule battery mechanism towards more failures.
ASSUMED_PRE_RULE_GENERATOR_SHARE = 0.0

# ASSUMPTION. Zones are inside Tier 2/3 CPUC High Fire Threat Districts, where the 72 h rule applies
# (Paradise is in such a district; the file does not carry a zone-to-district table).
ASSUMED_ZONES_IN_TIER2_TIER3_HFTD = True

# Hours in the recovery data point "by day 2" (file: recovery.fire_damaged_sites_repaired_share_by_day_2,
# 35 of 77 sites repaired about 1.5 to 2 days after the Tubbs ignition). Upper end taken: 2 days.
RECOVERY_REFERENCE_H = 48.0

# CPUC D.20-07-011 adopted 16 Jul 2020, compliance "within 12 months" (file note on
# backup_power.cpuc_required_backup_hours_tier2_tier3_hftd). Derived: 2020-07-16 + 12 months.
RULE_ADOPTED = date(2020, 7, 16)
RULE_EFFECTIVE = date(2021, 7, 16)


@dataclass(frozen=True)
class Param:
    """One model parameter: value (with optional range), unit and where it came from."""

    value: float
    unit: str
    provenance: str  # "sourced" | "derived" | "ASSUMPTION"
    source: str  # JSON path in the parameter file, or the module constant
    low: float | None = None
    high: float | None = None
    note: str = ""


@dataclass(frozen=True)
class TowerParams:
    fire_damage_rate_per_h: Param
    pre_rule_battery_h: Param  # value = mode, low/high = range
    rule_backup_h: Param
    rule_exempt_share: Param
    repair_rate_per_h: Param  # derived from recovery share by day 2
    serving_sites_per_zone: Param
    zone_outage_site_share: Param
    power_loss_delay_h: Param
    pre_rule_generator_share: Param
    rule_effective: date

    def table(self) -> list[tuple[str, Param]]:
        return [(f.name, getattr(self, f.name)) for f in fields(self) if isinstance(getattr(self, f.name), Param)]


@dataclass(frozen=True)
class TowerZone:
    id: str
    fire_arrival_at: datetime | None  # aware UTC; None = fire never reaches the zone
    households: int | None = None  # carried for callers; not used (no per-household site density in the file)
    serving_sites: int | None = None  # override of ASSUMED_SERVING_SITES_PER_ZONE


def _entry(doc: dict[str, Any], section: str, key: str) -> dict[str, Any]:
    try:
        return doc[section][key]
    except KeyError as exc:
        raise ValueError(f"{PARAMS_FILE_LABEL} lacks {section}.{key}") from exc


def _param(doc: dict[str, Any], section: str, key: str) -> Param:
    e = _entry(doc, section, key)
    return Param(
        value=float(e["value"]), unit=e["unit"], provenance=e["provenance"], source=f"{section}.{key}",
        low=None if e.get("low") is None else float(e["low"]),
        high=None if e.get("high") is None else float(e["high"]),
        note=e.get("rationale") or e.get("note") or "",
    )


def _assumed(value: float, unit: str, name: str, note: str) -> Param:
    return Param(value=value, unit=unit, provenance="ASSUMPTION", source=f"{SOURCE}:{name}", note=note)


def params_from_file(path: str | Path = PARAMS_PATH) -> TowerParams:
    doc = json.loads(Path(path).read_text())
    rate = _param(doc, "fire_damage_to_sites", "hazard_per_hour_inside_fire_perimeter")
    if rate.unit != "per_hour":
        raise ValueError(f"fire damage rate unit {rate.unit!r}, expected per_hour")
    battery = _param(doc, "backup_power", "pre_2020_battery_hours")
    rule_h = _param(doc, "backup_power", "cpuc_required_backup_hours_tier2_tier3_hftd")
    exempt = _param(doc, "backup_power", "share_sites_exempt_or_noncompliant_after_2021")
    for p in (battery, rule_h):
        if p.unit != "hours":
            raise ValueError(f"{p.source} unit {p.unit!r}, expected hours")
    if battery.low is None or battery.high is None:
        raise ValueError("backup_power.pre_2020_battery_hours needs low and high")

    # Repair clock (derived). The file gives one point: share 0.45 of damaged-or-out sites repaired
    # by day 2 (Cal OES, Tubbs 2017). Exponential repair with P(repaired by T) = s gives
    #   rate = -ln(1 - s) / T = -ln(1 - 0.45) / 48 h = 0.01246 per h (mean 80.3 h).
    # The point counts "damaged or out" sites, so it covers both causes; it is applied to both.
    rec = _param(doc, "recovery", "fire_damaged_sites_repaired_share_by_day_2")
    repair = Param(
        value=-math.log(1.0 - rec.value) / RECOVERY_REFERENCE_H, unit="per_hour", provenance="derived",
        source=f"{rec.source} ({rec.provenance}), -ln(1 - {rec.value}) / {RECOVERY_REFERENCE_H:g} h",
        note="Exponential repair from the site's failure time; one 2017 data point measured from ignition.",
    )
    return TowerParams(
        fire_damage_rate_per_h=rate,
        pre_rule_battery_h=battery,
        rule_backup_h=rule_h,
        rule_exempt_share=exempt,
        repair_rate_per_h=repair,
        serving_sites_per_zone=_assumed(ASSUMED_SERVING_SITES_PER_ZONE, "sites", "ASSUMED_SERVING_SITES_PER_ZONE",
                                        "No per-zone site count or density in the file."),
        zone_outage_site_share=_assumed(ASSUMED_ZONE_OUTAGE_SITE_SHARE, "share", "ASSUMED_ZONE_OUTAGE_SITE_SHARE",
                                        "All serving sites must be down (overlapping coverage caveat)."),
        power_loss_delay_h=_assumed(ASSUMED_POWER_LOSS_DELAY_AFTER_ARRIVAL_H, "hours",
                                    "ASSUMED_POWER_LOSS_DELAY_AFTER_ARRIVAL_H", "Power lost at fire arrival."),
        pre_rule_generator_share=_assumed(ASSUMED_PRE_RULE_GENERATOR_SHARE, "share",
                                          "ASSUMED_PRE_RULE_GENERATOR_SHARE", "Generator share unknown."),
        rule_effective=RULE_EFFECTIVE,
    )


def backup_rule_applies(scenario_date: date, rule_effective: date = RULE_EFFECTIVE) -> bool:
    """True when the CPUC 72 h backup rule binds sites in a scenario on ``scenario_date``."""
    return ASSUMED_ZONES_IN_TIER2_TIER3_HFTD and scenario_date >= rule_effective


def _iso_z(t: datetime) -> str:
    return t.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _aware(t: datetime, name: str) -> datetime:
    if t.tzinfo is None:
        raise ValueError(f"{name} must be timezone-aware UTC")
    return t.astimezone(timezone.utc)


def _battery_h(rng: random.Random, params: TowerParams, rule: bool) -> float:
    """Hours a site runs on backup after losing commercial power (math.inf = generator)."""
    if rule and rng.random() >= params.rule_exempt_share.value:
        return params.rule_backup_h.value
    if rng.random() < params.pre_rule_generator_share.value:
        return math.inf
    b = params.pre_rule_battery_h
    return rng.triangular(b.low, b.high, b.value)  # type: ignore[arg-type]


@dataclass(frozen=True)
class _SiteOutage:
    down_h: float  # hours after fire arrival
    up_h: float  # hours after fire arrival (may be inf)
    cause: str


def _site_outage(rng: random.Random, params: TowerParams, rule: bool) -> _SiteOutage:
    # Draw order is fixed (damage, battery, repair) so a seed reproduces exactly.
    damage_h = rng.expovariate(params.fire_damage_rate_per_h.value)  # P(T <= t) = 1 - exp(-rate t)
    battery_h = params.power_loss_delay_h.value + _battery_h(rng, params, rule)
    repair_h = rng.expovariate(params.repair_rate_per_h.value)
    if damage_h <= battery_h:
        return _SiteOutage(damage_h, damage_h + repair_h, CAUSE_FIRE_DAMAGE)
    return _SiteOutage(battery_h, battery_h + repair_h, CAUSE_BATTERY_EXHAUSTED)


def _zone_intervals(sites: Sequence[_SiteOutage], need: int) -> list[tuple[float, float, str]]:
    """Intervals (start_h, end_h, cause) during which at least ``need`` sites are down.
    ``cause`` is the cause of the site whose failure completed the outage."""
    events = sorted([(s.down_h, 1, s.cause) for s in sites] + [(s.up_h, -1, "") for s in sites],
                    key=lambda e: (e[0], e[1]))  # restore (-1) before fail (+1) at equal times
    out: list[tuple[float, float, str]] = []
    down, start, cause = 0, 0.0, ""
    for t, d, c in events:
        before = down
        down += d
        if before < need <= down:
            start, cause = t, c
        elif down < need <= before:
            out.append((start, t, cause))
    return out


def schedule_outages(
    zones: Sequence[TowerZone],
    window_utc: tuple[datetime, datetime],
    params: TowerParams,
    seed: int,
    scenario_date: date,
) -> list[dict[str, Any]]:
    """Simulated ``comms_outage`` injects (drill inject shape of app/backend/livecore/injects.py),
    ``at`` ascending. ``until`` is clamped to the window end and is always after ``at``."""
    w0, w1 = _aware(window_utc[0], "window start"), _aware(window_utc[1], "window end")
    if w1 <= w0:
        raise ValueError("window end must be after window start")
    rule = backup_rule_applies(scenario_date, params.rule_effective)
    share = params.zone_outage_site_share.value
    battery_desc = (f"{params.rule_backup_h.value:g} h backup (CPUC rule), {params.rule_exempt_share.value:.0%} exempt"
                    if rule else
                    f"pre-rule battery {params.pre_rule_battery_h.low:g}-{params.pre_rule_battery_h.high:g} h")
    injects: list[dict[str, Any]] = []
    for zone in zones:
        if zone.fire_arrival_at is None:
            continue
        arrival = _aware(zone.fire_arrival_at, f"{zone.id} fire_arrival_at")
        n = zone.serving_sites if zone.serving_sites is not None else int(params.serving_sites_per_zone.value)
        if n < 1:
            continue
        need = max(1, math.ceil(share * n))
        rng = random.Random(f"{seed}:comms-towers:{zone.id}")
        sites = [_site_outage(rng, params, rule) for _ in range(n)]
        for start_h, end_h, cause in _zone_intervals(sites, need):
            at = max(arrival + timedelta(hours=start_h), w0)
            until = w1 if math.isinf(end_h) else min(arrival + timedelta(hours=end_h), w1)
            at, until = at.replace(microsecond=0), until.replace(microsecond=0)
            if at >= w1 or until <= at:
                continue
            injects.append({
                "type": "comms_outage",
                "at": _iso_z(at),
                "params": {"zone_ids": [zone.id], "until": _iso_z(until)},
                "label": (f"Simulated: {need} of {n} serving cell sites down ({cause.replace('_', ' ')}); "
                          f"tower-failure planning model, {battery_desc}, seed {seed}, {PARAMS_FILE_LABEL}"),
                "evidence_class": "simulated",
                "source": SOURCE,
                "cause": cause,
            })
    injects.sort(key=lambda i: (i["at"], i["params"]["zone_ids"][0]))
    return injects


def summary(injects: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """Counts: injects, distinct zones, by cause, and median duration in hours (``at`` to ``until``)."""
    def parse(s: str) -> datetime:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))

    durations = [(parse(i["params"]["until"]) - parse(i["at"])).total_seconds() / 3600 for i in injects]
    return {
        "injects": len(injects),
        "zones": len({z for i in injects for z in i["params"]["zone_ids"]}),
        "by_cause": dict(Counter(i.get("cause", "unknown") for i in injects)),
        "median_duration_h": round(median(durations), 2) if durations else None,
    }
