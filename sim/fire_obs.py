"""NIST fire observations and ignition from the Camp evacuation package, and arrival-time scoring.

`fire_observations_reconstructed.geojson` holds points where fire was documented at a time
(NIST TN 2135/TN 2252 reconstruction from 911 calls, photos, video, AVL and dispatch logs).
An observation says fire was present there during [observed_from, observed_to]; it is not
the arrival time, which may be earlier. Scoring therefore keeps, per fire-grid cell, only
the earliest non-residual observation, the closest proxy for first arrival.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from sim.geo import Grid
from sim.history import format_utc, parse_utc

OBSERVATIONS_PATH = "normalized/fire_observations_reconstructed.geojson"
EVENTS_PATH = "normalized/events.jsonl"
ORIGIN_OBSERVATION_ID = "nist-fireobs:0001"
SOURCE_ID = "nist-fire-observations"
WITHIN_MINUTES = 30  # share of observations with |error| <= this, reported alongside the median/mean

OBSERVATION_NOTES = [
    "NIST fire observations are reconstructed from 911 calls, photos, video, AVL and logs; locations and times "
    "carry the reconstruction's uncertainty (time_precision 'minute' or 'approximate' with a window).",
    "An observation shows fire present at a time, not first arrival; scoring keeps the earliest non-residual "
    "observation per fire cell.",
    "Error is zero when the modelled arrival falls inside [observed_from, observed_to], otherwise the distance "
    "to the nearer window edge. Hit means the modelled fire had arrived by observed_to.",
    "Observations the model does not reach by the run horizon are scored at the horizon, a lower bound on "
    "their error.",
]


def read_verified(package: Path, relative: str) -> bytes:
    """Bytes of one package artifact after checking its size and SHA-256 against the manifest."""
    manifest = json.loads((package / "manifest.json").read_bytes())
    entry = next((a for a in manifest.get("artifacts", []) if a.get("path") == relative), None)
    if entry is None:
        raise ValueError(f"{relative} is not listed in {package}/manifest.json")
    data = (package / relative).read_bytes()
    if len(data) != entry["bytes"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
        raise ValueError(f"artifact checksum mismatch: {relative}")
    return data


@dataclass(frozen=True)
class Observation:
    id: str
    lon: float
    lat: float
    observed_at: datetime
    observed_from: datetime
    observed_to: datetime
    time_precision: str
    residual: bool
    location_source: str
    feature: dict  # original normalized feature, unmodified


@dataclass(frozen=True)
class Ignition:
    lon: float
    lat: float
    at: datetime
    provenance: dict


def load_observations(package: Path) -> list[Observation]:
    """Observations with a parseable time, sorted by observed_at. Untimed ones are dropped."""
    features = json.loads(read_verified(package, OBSERVATIONS_PATH))["features"]
    out = []
    for f in features:
        p = f["properties"]
        if not p.get("observed_at") or not f.get("geometry"):
            continue
        lon, lat = f["geometry"]["coordinates"][:2]
        at = parse_utc(p["observed_at"])
        out.append(Observation(
            id=p["observation_id"], lon=lon, lat=lat, observed_at=at,
            observed_from=parse_utc(p["observed_from"]) if p.get("observed_from") else at,
            observed_to=parse_utc(p["observed_to"]) if p.get("observed_to") else at,
            time_precision=p.get("time_precision") or "unknown", residual=bool(p.get("residual_fire")),
            location_source=p.get("location_source") or "unknown", feature=f,
        ))
    return sorted(out, key=lambda o: (o.observed_at, o.id))


def load_ignition(package: Path, observations: list[Observation]) -> Ignition:
    """Ignition time from the package's `fire_ignition` event, place from NIST origin observation 0001."""
    events = [json.loads(line) for line in read_verified(package, EVENTS_PATH).decode().splitlines() if line.strip()]
    event = next((e for e in events if e.get("type") == "fire_ignition"), None)
    if event is None:
        raise ValueError("package has no fire_ignition event")
    origin = next((o for o in observations if o.id == ORIGIN_OBSERVATION_ID), None)
    if origin is None:
        raise ValueError(f"package has no {ORIGIN_OBSERVATION_ID} observation")
    at = parse_utc(event["occurred_at"])
    if at > origin.observed_at:
        raise ValueError("fire_ignition event is after the first origin observation")
    return Ignition(origin.lon, origin.lat, at, {
        "evidence_class": "reconstructed",
        "time_source": {"event_id": event["event_id"], "occurred_at": event["occurred_at"],
                        "time_precision": event.get("time_precision"), "quote": event.get("quote"),
                        "source_locator": event.get("source_locator")},
        "place_source": {"observation_id": origin.id, "location_source": origin.location_source,
                         "observed_at": format_utc(origin.observed_at), "note": "first 911 report at the origin"},
    })


def first_per_cell(grid: Grid, observations: list[Observation], *, exclude: tuple[str, ...] = ()) -> list[tuple[int, Observation]]:
    """(cell, observation) for the earliest non-residual observation in each grid cell, inside the grid only."""
    seen: dict[int, Observation] = {}
    for o in observations:
        if o.residual or o.id in exclude:
            continue
        cell = grid.cell_of(o.lon, o.lat)
        if cell is not None and cell not in seen:
            seen[cell] = o
    return sorted(seen.items(), key=lambda item: (item[1].observed_at, item[1].id))


def score_arrival(arrival_s: list[float], t0: datetime, targets: list[tuple[int, Observation]],
                  horizon_s: float) -> dict:
    """Window arrival error (minutes) of a modelled arrival grid at observation cells."""
    errors, signed, hits, unreached = [], [], 0, 0
    for cell, o in targets:
        a = arrival_s[cell]
        if not math.isfinite(a):
            unreached += 1
            a = horizon_s
        lo = (o.observed_from - t0).total_seconds()
        hi = (o.observed_to - t0).total_seconds()
        if a <= hi and math.isfinite(arrival_s[cell]):
            hits += 1
        e = 0.0 if lo <= a <= hi else (a - hi if a > hi else a - lo)
        signed.append(e / 60)
        errors.append(abs(e) / 60)
    n = len(errors)
    if not n:
        return {"n": 0}
    ranked = sorted(errors)
    return {
        "n": n,
        "median_abs_error_min": round(ranked[n // 2] if n % 2 else (ranked[n // 2 - 1] + ranked[n // 2]) / 2, 1),
        "mean_abs_error_min": round(sum(errors) / n, 1),
        "median_signed_error_min": round(sorted(signed)[n // 2], 1),  # positive = model late
        f"within_{WITHIN_MINUTES}_min": round(sum(1 for e in errors if e <= WITHIN_MINUTES) / n, 3),
        "hit_rate": round(hits / n, 3),
        "unreached": unreached,
    }


def split_scores(arrival_s: list[float], t0: datetime, targets: list[tuple[int, Observation]], horizon_s: float,
                 *, cutoff: datetime, until: datetime) -> dict:
    """Scores on calibration observations (observed_at < cutoff) and held-out ones (cutoff <= observed_at < until)."""
    train = [t for t in targets if t[1].observed_at < cutoff]
    test = [t for t in targets if cutoff <= t[1].observed_at < until]
    return {"train": score_arrival(arrival_s, t0, train, horizon_s),
            "held_out": score_arrival(arrival_s, t0, test, horizon_s)}


def _locator(o: Observation) -> str:
    """Workbook sheet!row(s) and the record's source number, e.g. 'Concow!2; 911-001-1'."""
    p = o.feature["properties"]
    rows = ", ".join(p.get("corridor_sheet_rows") or [])
    return "; ".join(part for part in (rows, p.get("source_number")) if part)


def observation_layer(observations: list[Observation], package: Path, *, until: datetime | None = None) -> dict:
    """`fire_observations` bundle layer: NIST points with time, precision, evidence class and source locator.

    Not thinned: every timed observation up to `until` is kept (about 1,850 points, ~0.5 MB for the Camp
    replay window); the free-text columns were already dropped by the package.
    """
    # sources.json is package metadata (not a hashed artifact); only its citation fields are read.
    source = json.loads((package / "sources.json").read_text()).get(SOURCE_ID, {})
    features = [
        {
            "id": o.id,
            "coord": [round(o.lon, 6), round(o.lat, 6)],
            "at": format_utc(o.observed_at),
            "from": format_utc(o.observed_from),
            "to": format_utc(o.observed_to),
            "time_precision": o.time_precision,
            "residual_fire": o.residual,
            "location_source": o.location_source,
            "type_of_fire_code": o.feature["properties"].get("type_of_fire_code"),
            "source_locator": _locator(o),
        }
        for o in observations
        if until is None or o.observed_at <= until
    ]
    return {
        "evidence_class": "reconstructed",
        "source": {"id": SOURCE_ID, "label": "NIST TN 2135 / TN 2252 fire observations",
                   "url": source.get("landing_url"), "license": source.get("license"),
                   "publication": source.get("related_publication")},
        "temporal_role": "fire present at time (not first arrival)",
        "features": features,
        "notes": OBSERVATION_NOTES[:2],
    }
