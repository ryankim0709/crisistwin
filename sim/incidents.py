"""Incident registry and the generic replay inputs for evacuation packages other than Camp.

`INCIDENTS` holds only what is not in the packages: package paths, display name and place, and
model settings chosen per fire (traffic cadence, fire-front cadence). The clock, ignition,
timezone, bbox, perimeters, demand and orders all come from the package
(`normalized/*`, manifest). Camp keeps its two-package path (sim.scenario.camp_replay_inputs,
sim.bundle._simulated_fire); the others go through `package_replay_inputs` and `package_fire`.

Generic package layers used (Marshall 2021, Kincade 2019 builders):
  fire_perimeters.geojson (FEDS), fire_detections.geojson (FIRMS), events.jsonl,
  evacuation_zones.geojson, population_units.geojson (ACS block groups),
  zone_population_crosswalk.json (zone x block-group area shares), road nodes/edges/exits.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from pathlib import Path

from tools.build_camp_history import SourceError

from sim.demand import EVACUATION_PARTICIPATION, VEHICLES_TAKEN_CAP, _Locator
from sim.events import ASSUMPTIONS as ROAD_EVENT_ASSUMPTIONS
from sim.events import resolve_road_events
from sim.fire import MODEL_ID, MODEL_VERSION, FireParams, burned_mask, simulate_arrival
from sim.fire_obs import WITHIN_MINUTES, score_arrival
from sim.firefront import arrival_lookup, constrain_to_perimeter, isochrones
from sim.geo import Grid, mask_contour, rasterize
from sim.hindcast import score
from sim.history import DamagePoint, IncidentHistory, PerimeterSnapshot, format_utc, parse_utc
from sim.network import load_alert_events, load_road_network
from sim.store import ensure_package
from sim.traffic import DemandZone, TrafficEvent

ROOT = Path(__file__).resolve().parent.parent
REPLAYS_DIR = ROOT / "app/public/replays"
INDEX_KIND = "crisistwin_replay_index"
INDEX_SCHEMA_VERSION = "1.0.0"
NOTICE_TYPES = ("evacuation_order", "evacuation_warning")
CLOCK_LEAD = timedelta(hours=1)  # replay starts this long before the (hour-floored) ignition
FRONT_EVERY = timedelta(minutes=10)
FIRE_CELL_M = 200.0
FIRE_MARGIN_M = 3000.0
MAX_IGNITION_CANDIDATES = 6  # distinct fire cells of the earliest detection pass tried as ignition places
VERIFY_CACHE_DIR = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "crisistwin/verified"


@dataclass(frozen=True)
class Incident:
    id: str
    name: str
    place: str
    package: Path  # perimeter package (Camp: paradise slice; others: the evacuation package itself)
    roads_package: Path
    kind: str  # "camp" (two-package Camp path) | "package" (generic evacuation package)
    traffic: dict = field(default_factory=dict)  # TrafficParams overrides for this fire
    clock_note: str = ""
    assumptions: tuple[str, ...] = ()  # incident-specific modelling assumptions, written into the bundle
    # Curated, cited evidence beside the registry (sim/evidence/*.json): timed fire observations, extra
    # orders and zone splits. The packages are content-addressed, so additions cannot go inside them.
    evidence: Path | None = None


EVIDENCE_DIR = ROOT / "sim/evidence"

INCIDENTS = {
    "camp-2018": Incident(
        "camp-2018", "Camp Fire (2018)", "Paradise, Butte County, California",
        Path("data/incidents/camp-2018-paradise-slice/a6d2cc03f525ed65"),
        Path("data/incidents/camp-2018-evacuation/17e67cfe5669fe50"), "camp",
        clock_note="Camp replay clock (sim.scenario.CAMP_REPLAY_START/END): ignition morning to the next midnight."),
    "marshall-2021": Incident(
        "marshall-2021", "Marshall Fire (2021)", "Superior and Louisville, Boulder County, Colorado",
        Path("data/incidents/marshall-2021-evacuation/415166c55516b100"),
        Path("data/incidents/marshall-2021-evacuation/415166c55516b100"), "package",
        # The package has zone orders only for Everbridge zones 1-3, 5-8; zones 4 and 9 have warnings. The
        # town-wide Superior order (12:58 MST) and the Louisville city-wide order (14:24 MST) come from
        # sim/evidence/marshall_2021.json, which also splits zone 9 at the Louisville city limit. Warnings
        # release no demand, so zone 9 outside Louisville (pre-evacuation only) does not depart.
        evidence=EVIDENCE_DIR / "marshall_2021.json",
        assumptions=("Orders: the package's Everbridge orders plus two public orders from sim/evidence/"
                     "marshall_2021.json: Town of Superior, all residents, 12:58 MST (reported; mapped to zone 4, "
                     "'Southern Superior'), and City of Louisville, 14:24 MST (Boulder ODM post; mapped to zone 8 "
                     "and the part of zone 9 inside the 2020 city boundary). Warnings release no demand.",),
        clock_note="Wind-driven grass fire that crossed into town within about an hour: 10 s traffic step, "
                   "1 min frames, 10 min simulated fronts, from 1 h before ignition to the manifest focus-window end."),
    "kincade-2019": Incident(
        "kincade-2019", "Kincade Fire (2019)", "Geyserville, Healdsburg and Windsor, Sonoma County, California",
        Path("data/incidents/kincade-2019-evacuation/1f44d6f11dd290ac"),
        Path("data/incidents/kincade-2019-evacuation/1f44d6f11dd290ac"), "package",
        # Multi-day run over a 50k-edge network: coarser step and frames keep the build bounded.
        traffic={"step_s": 30, "record_every_s": 300, "reroute_interval_s": 900, "fire_check_every_s": 300},
        clock_note="Orders spread over days: 30 s traffic step, 5 min frames, 15 min reroutes, from 1 h before "
                   "ignition to the manifest focus-window end; simulated fronts every 10 min until the first perimeter."),
}


def get(incident_id: str) -> Incident:
    if incident_id not in INCIDENTS:
        raise ValueError(f"unknown incident {incident_id!r}; known: {', '.join(INCIDENTS)}")
    return INCIDENTS[incident_id]


def _read(package: Path, relative: str):
    return json.loads((package / relative).read_text())


def load_evidence(incident: Incident) -> dict | None:
    """The incident's curated evidence file (sim/evidence), or None. Fails loudly if it names another incident."""
    if incident.evidence is None:
        return None
    evidence = json.loads(incident.evidence.read_text())
    if evidence.get("kind") != "crisistwin_incident_evidence" or evidence.get("incident") != incident.id:
        raise SourceError(f"{incident.evidence} is not evidence for {incident.id}")
    return {**evidence, "path": str(incident.evidence.relative_to(ROOT))}


def _events(package: Path) -> list[dict]:
    path = package / "normalized/events.jsonl"
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()] if path.exists() else []


# --- verification ------------------------------------------------------------------------------------------

def _verifier(manifest: dict):
    """The package builder's own verifier, dispatched by normalizer version."""
    version = manifest.get("normalizer_version", "")
    if version.startswith("marshall-"):
        from tools.marshall_build import verify
    elif version.startswith("kincade-"):
        from tools.kincade_build import verify
    else:
        raise SourceError(f"no verifier registered for normalizer_version {version!r}")
    return verify


def verify_package(package: Path) -> dict:
    """Fetch missing artifacts (ADR 0006), check every artifact hash, and run the builder's full offline
    rebuild once per manifest. The rebuild result is cached outside the repo under VERIFY_CACHE_DIR, keyed by
    the manifest's SHA-256; later runs re-check every artifact hash against the manifest (the Kincade rebuild
    alone takes about 2 min). Returns a verification record for the bundle."""
    ensure_package(package)
    manifest_bytes = (package / "manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    for item in manifest["artifacts"]:
        data = (package / item["path"]).read_bytes()
        if len(data) != item["bytes"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
            raise SourceError(f"artifact checksum mismatch: {package / item['path']}")
    key = hashlib.sha256(manifest_bytes).hexdigest()
    stamp = VERIFY_CACHE_DIR / f"{key}.json"
    if stamp.exists():
        record = json.loads(stamp.read_text())
        return {**record, "this_run": "artifact hashes re-checked; offline rebuild result reused (cache)"}
    _verifier(manifest)(package)
    record = {"package": str(package), "manifest_sha256": key, "rebuild_verified_at": format_utc(datetime.now().astimezone()),
              "verifier": f"{_verifier(manifest).__module__}.verify"}
    stamp.parent.mkdir(parents=True, exist_ok=True)
    stamp.write_text(json.dumps(record))
    return {**record, "this_run": "full offline rebuild and hash check"}


# --- history -----------------------------------------------------------------------------------------------

def _bbox(geometry: dict) -> tuple[float, float, float, float]:
    polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    xs = [q[0] for poly in polygons for q in poly[0]]
    ys = [q[1] for poly in polygons for q in poly[0]]
    return min(xs), min(ys), max(xs), max(ys)


def _union_bbox(boxes) -> list[float]:
    boxes = list(boxes)
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def load_package_history(package: Path) -> IncidentHistory:
    """Perimeters (and damage, when present) from the evacuation package's own layers.

    Marshall writes `t_utc`/`farea_km2`, Kincade `snapshot_at`/`area_km2`; both are read. Call after
    verify_package. The perimeter bbox is derived from the geometries when the manifest has none.
    """
    manifest = _read(package, "manifest.json")
    perimeters = []
    for f in _read(package, "normalized/fire_perimeters.geojson")["features"]:
        p = f["properties"]
        at = p.get("snapshot_at") or p.get("t_utc")
        area = p.get("area_km2", p.get("farea_km2"))
        if at is None or area is None or not f.get("geometry"):
            raise SourceError(f"perimeter {f.get('id')} lacks a time, area or geometry")
        perimeters.append(PerimeterSnapshot(parse_utc(at), float(area), f["geometry"], f))
    perimeters.sort(key=lambda s: s.snapshot_at)
    if not perimeters:
        raise SourceError("package has no fire perimeter snapshots")
    damage = []
    if (package / "normalized/damage_assessments.geojson").exists():
        damage = [DamagePoint(f["geometry"]["coordinates"][0], f["geometry"]["coordinates"][1],
                              f["properties"]["damage"], f["properties"]["structure_category"], f)
                  for f in _read(package, "normalized/damage_assessments.geojson")["features"] if f.get("geometry")]
    layer = dict(manifest["layers"].get("fire_perimeters", {}))
    layer.setdefault("bbox", _union_bbox(_bbox(s.geometry) for s in perimeters))
    manifest = {**manifest, "layers": {**manifest["layers"], "fire_perimeters": layer}}
    return IncidentHistory(package=package, manifest=manifest, perimeters=tuple(perimeters), damage=tuple(damage))


# --- clock and ignition ------------------------------------------------------------------------------------

def package_ignition(package: Path, history: IncidentHistory) -> dict:
    """Ignition time and place from the package, with provenance.

    Time: the fire_ignition event, else the earliest detection. Place: the event's point when it has one;
    otherwise the place is chosen by the fire fit among cells of the earliest detection pass
    (`candidates`), else the first perimeter's centroid.
    """
    events = [e for e in _events(package) if e["type"] == "fire_ignition"]
    detections = sorted((f for f in _read(package, "normalized/fire_detections.geojson")["features"]
                         if f.get("geometry")), key=lambda f: f["properties"]["acquired_at"]) \
        if (package / "normalized/fire_detections.geojson").exists() else []
    first_perimeter = history.perimeters[0]
    if events:
        ev = min(events, key=lambda e: e["occurred_at"])
        at = parse_utc(ev["occurred_at"])
        time_source = (f"package fire_ignition event {ev['event_id']} ({ev['evidence_class']}, "
                       f"time precision {ev['time_precision']})")
    elif detections:
        ev, at = None, parse_utc(detections[0]["properties"]["acquired_at"])
        time_source = "earliest fire detection (observed satellite pass; the fire started earlier)"
    else:
        ev, at = None, first_perimeter.snapshot_at
        time_source = "first perimeter snapshot time (the fire started earlier)"
    if ev is not None and ev.get("geometry"):
        return {"at": at, "candidates": [tuple(ev["geometry"]["coordinates"])],
                "provenance": f"time and place from {time_source.removeprefix('package ')}"}
    first_pass = [f for f in detections if f["properties"]["acquired_at"] == detections[0]["properties"]["acquired_at"]] \
        if detections else []
    if first_pass:
        return {"at": at, "candidates": [tuple(f["geometry"]["coordinates"]) for f in first_pass],
                "provenance": f"time from {time_source}; the event has no coordinates, so the place is the cell of the "
                              f"earliest FIRMS pass ({detections[0]['properties']['acquired_at']}) that best fits the "
                              "first perimeter (fitted, not observed)"}
    x0, y0, x1, y1 = _bbox(first_perimeter.geometry)
    return {"at": at, "candidates": [((x0 + x1) / 2, (y0 + y1) / 2)],
            "provenance": f"time from {time_source}; place is the first perimeter's bbox centre (assumed)"}


def package_clock(package: Path, ignition_at: datetime) -> tuple[datetime, datetime, str]:
    """Manifest focus window, starting no earlier than CLOCK_LEAD before the hour-floored ignition."""
    manifest = _read(package, "manifest.json")
    window = manifest.get("focus_window_utc")
    lead = ignition_at.replace(minute=0, second=0, microsecond=0) - CLOCK_LEAD
    if window:
        start, end = parse_utc(window[0]), parse_utc(window[1])
        return max(start, lead), end, "manifest focus_window_utc, trimmed to 1 h before the hour of ignition"
    notices = [parse_utc(e["occurred_at"]) for e in _events(package) if e["type"] in NOTICE_TYPES]
    if not notices:
        raise SourceError("package has neither a focus window nor order/warning events to set the clock")
    return lead, max(notices) + timedelta(hours=12), "ignition to 12 h after the last order or warning event"


# --- fire --------------------------------------------------------------------------------------------------

def fire_candidates() -> list[FireParams]:
    """Any wind direction (the packages have no weather layer) and effective rates from slow to very fast."""
    return [FireParams(base, wind_from, speed)
            for base in (8.0, 24.0, 64.0) for wind_from in range(0, 360, 45) for speed in (5.0, 15.0)]


def package_fire(history: IncidentHistory, ignition: dict, end: datetime) -> tuple[dict, tuple]:
    """elliptical-mtt-ca front from the package ignition, fitted by IoU to the first perimeter and clipped to it.

    Returns the (fire_simulated block, (grid, arrival, t0, lookup)) pair of sim.bundle._simulated_fire.
    With curated timed observations (`ignition["evidence"]`, see package_replay_inputs) the fit is
    `timed_package_fire` instead.
    """
    if (ignition.get("evidence") or {}).get("fire"):
        return timed_package_fire(history, ignition["evidence"], end)
    target = history.perimeters[0]
    t0 = ignition["at"]
    horizon_s = (target.snapshot_at - t0).total_seconds()
    if horizon_s <= 0:
        raise ValueError(f"ignition {format_utc(t0)} is not before the first perimeter {format_utc(target.snapshot_at)}")
    boxes = [_bbox(target.geometry), *((x, y, x, y) for x, y in ignition["candidates"])]
    grid = Grid.covering(_union_bbox(boxes), FIRE_CELL_M, FIRE_MARGIN_M)
    observed = rasterize(grid, target.geometry)
    cells = []
    for lon, lat in ignition["candidates"]:
        cell = grid.cell_of(lon, lat)
        if cell is not None and cell not in [c for c, _ in cells]:
            cells.append((cell, (lon, lat)))
    cells = cells[:MAX_IGNITION_CANDIDATES]
    best, table = None, []
    for cell, lonlat in cells:
        seed = bytearray(grid.size)
        seed[cell] = 1
        for params in fire_candidates():
            arrival = simulate_arrival(grid, seed, params, horizon_s)
            metrics = score(burned_mask(arrival, horizon_s), observed, grid.cell_area_km2)
            table.append({"ignition": list(lonlat), "params": params.to_dict(), "iou": metrics["iou"]})
            if best is None or metrics["iou"] > best[0]["iou"]:
                best = (metrics, params, arrival, lonlat)
    metrics, params, arrival, lonlat = best
    arrival, constraint = constrain_to_perimeter(grid, arrival, target)
    until = min(end, target.snapshot_at)
    ignition_record = {"coord": [round(lonlat[0], 5), round(lonlat[1], 5)], "at": format_utc(t0),
                       "provenance": ignition["provenance"]}
    block = {
        "evidence_class": "simulated",
        "model": {"id": MODEL_ID, "version": MODEL_VERSION, "params": params.to_dict()},
        "ignition": ignition_record,
        "calibration": {
            "target_snapshot_at": format_utc(target.snapshot_at), "iou": metrics["iou"],
            "area_ratio": metrics["area_ratio"],
            "method": f"best IoU with the first satellite perimeter over {len(table)} runs "
                      f"({len(cells)} ignition place(s) x {len(fire_candidates())} parameter sets)",
            "headline": f"IoU {metrics['iou']:.2f} with the first perimeter only; no ground observations, "
                        "no terrain or fuel layer",
            "perimeter_time_precision": target.feature["properties"].get("time_precision"),
        },
        "constraint": constraint,
        "fronts": isochrones(grid, arrival, t0, until=until, every=FRONT_EVERY),
        "arrival_grid": {
            "origin_lon": grid.origin_lon, "origin_lat": grid.origin_lat, "cell_m": grid.cell_m,
            "ncols": grid.ncols, "nrows": grid.nrows,
            "m_per_deg_lon": grid._m_per_deg_lon, "m_per_deg_lat": grid._m_per_deg_lat,
            "t0": format_utc(t0),
            "minutes": [round(a / 60) if math.isfinite(a) else None for a in arrival],
        },
        "assumptions": [
            f"Ignition: {ignition['provenance']}.",
            "No ground fire observations: parameters are fitted to the first satellite perimeter only, so "
            "intermediate fronts are model output, not observations.",
            "Uniform fuel, flat terrain (no terrain layer), constant wind; the fitted wind is a fitting parameter, "
            "not a recovered historical wind. No spotting.",
            f"FEDS perimeter times are {target.feature['properties'].get('time_precision', 'unknown')}-precision "
            "labels; the fit treats the label as the snapshot time.",
            "Front clipped to the first satellite perimeter (plus buffer): a replay reconstruction, not a forecast.",
        ],
    }
    return block, (grid, arrival, t0, arrival_lookup(grid, arrival, t0))


# --- fire fitted to timed observations (curated evidence) --------------------------------------------------
#
# elliptical-mtt-ca from the documented ignitions, with wind direction, wind speed (ellipse shape) and head
# spread rate chosen on a grid of evidence priors by
#     J = mean window error at reported first arrivals (min) + IOU_WEIGHT_MIN * (1 - shape IoU),
# where shape IoU is the IoU of the model's burned area, at the moment it first equals the final perimeter's
# area, with that perimeter. Rate is set by arrival times; direction and elongation by both. "Present by"
# bounds (late sightings, FIRMS passes) are evaluation only. The front is then clipped to the final perimeter.

IOU_WEIGHT_MIN = 60.0  # minutes of mean arrival error traded for one unit of shape IoU (0.1 IoU = 6 min)
DETECTION_NEIGHBOURHOOD = 1  # cells around a FIRMS pixel centre that may hold the detected fire


@dataclass(frozen=True)
class _Window:  # duck type of sim.fire_obs.Observation for score_arrival
    observed_from: datetime
    observed_to: datetime


def _location_cells(grid: Grid, location: dict) -> list[int]:
    """Grid cells of an observation place: the point's cell, the cells a street passes, or a polygon's cells."""
    def cells_of(points):
        return sorted({c for c in (grid.cell_of(lon, lat) for lon, lat in points) if c is not None})

    kind = location["type"]
    if kind == "point":
        return cells_of([location["coord"]])
    if kind == "line":
        coords = location["coords"]
        points = list(coords[:1])
        for (x0, y0), (x1, y1) in zip(coords, coords[1:]):
            dx, dy = grid.to_xy(x1, y1)[0] - grid.to_xy(x0, y0)[0], grid.to_xy(x1, y1)[1] - grid.to_xy(x0, y0)[1]
            steps = max(1, math.ceil(math.hypot(dx, dy) / (grid.cell_m / 2)))
            points.extend((x0 + (x1 - x0) * k / steps, y0 + (y1 - y0) * k / steps) for k in range(1, steps + 1))
        return cells_of(points)
    if kind == "area":
        mask = rasterize(grid, location["geometry"])
        return [i for i, v in enumerate(mask) if v] or cells_of(location["geometry"]["coordinates"][0])
    raise ValueError(f"unknown location type {kind!r}")


def _neighbourhood(grid: Grid, cell: int, radius: int) -> list[int]:
    row, col = divmod(cell, grid.ncols)
    return [r * grid.ncols + c for r in range(row - radius, row + radius + 1) for c in range(col - radius, col + radius + 1)
            if 0 <= r < grid.nrows and 0 <= c < grid.ncols]


def _window_error_min(a_s: float, window_s: tuple[float, float], horizon_s: float) -> float:
    """Minutes outside the window (0 inside), as sim.fire_obs.score_arrival; unreached counts as the horizon."""
    a = a_s if math.isfinite(a_s) else horizon_s
    lo, hi = window_s
    return 0.0 if lo <= a <= hi else abs(a - hi if a > hi else a - lo) / 60


def _shape_iou(arrival: list[float], observed: bytearray, cell_area_km2: float) -> dict:
    """IoU when the modelled burned area first reaches the observed area (all burned cells if it never does)."""
    k = sum(observed)
    finite = sorted(a for a in arrival if math.isfinite(a))
    threshold = finite[k - 1] if len(finite) >= k else (finite[-1] if finite else -1.0)
    metrics = score(burned_mask(arrival, threshold), observed, cell_area_km2)
    return {"iou": metrics["iou"], "area_ratio": metrics["area_ratio"],
            "at_min": round(threshold / 60) if finite else None}


def _run_ignitions(grid: Grid, seeds: list[tuple[int, float]], params: FireParams, horizon_s: float) -> list[float]:
    """Arrival (s after t0) from several ignitions, each starting delay_s after t0: the earliest wins."""
    arrival = [math.inf] * grid.size
    for cell, delay_s in seeds:
        seed = bytearray(grid.size)
        seed[cell] = 1
        own = simulate_arrival(grid, seed, params, max(0.0, horizon_s - delay_s))
        arrival = [min(a, b + delay_s) for a, b in zip(arrival, own)]
    return arrival


def timed_candidates(priors: dict) -> list[FireParams]:
    """Evidence priors -> FireParams; head rate is set directly and the base rate derived from it."""
    out = []
    for wind_from in priors["wind_from_deg"]:
        for speed in priors["wind_speed_m_s"]:
            for head in priors["head_rate_m_per_min"]:
                coef = FireParams(1.0, wind_from, speed).wind_coef_per_m_s
                out.append(FireParams(head / (1 + coef * speed), float(wind_from), float(speed)))
    return out


def timed_package_fire(history: IncidentHistory, evidence: dict, end: datetime) -> tuple[dict, tuple]:
    """elliptical-mtt-ca fitted to curated, timed fire-arrival reports and the final perimeter's shape.

    Same return shape as package_fire. Adds `hazard_until`: sim.bundle uses this simulated front as the
    traffic hazard until then, instead of the half-day FEDS labels whose extents postdate their times.
    """
    fire = evidence["fire"]
    by_id = {p.feature["properties"].get("perimeter_id"): p for p in history.perimeters}
    if fire["final_perimeter_id"] not in by_id:
        raise SourceError(f"final perimeter {fire['final_perimeter_id']} not in the package")
    final = by_id[fire["final_perimeter_id"]]
    ignitions = sorted(fire["ignitions"], key=lambda i: i["at"])
    t0 = parse_utc(ignitions[0]["at"])
    stop = parse_utc(fire["spread_stop"]["at"])
    horizon_s = (stop - t0).total_seconds()
    observations = fire["observations"]
    boxes = [_bbox(final.geometry), *((*i["coord"], *i["coord"]) for i in ignitions)]
    grid = Grid.covering(_union_bbox(boxes), FIRE_CELL_M, FIRE_MARGIN_M)
    seeds = []
    for i in ignitions:
        cell = grid.cell_of(*i["coord"])
        if cell is None:
            raise ValueError(f"ignition {i['id']} lies outside the fire grid")
        seeds.append((cell, (parse_utc(i["at"]) - t0).total_seconds()))
    observed = rasterize(grid, final.geometry)

    def window_s(obs):
        return tuple((parse_utc(t) - t0).total_seconds() for t in obs["window_utc"])

    points = []  # (observation, cells, window_s)
    for obs in observations:
        if obs["role"] == "excluded":
            continue
        cells = _location_cells(grid, obs["location"])
        if not cells:
            raise ValueError(f"observation {obs['id']} lies outside the fire grid")
        points.append((obs, cells, window_s(obs)))
    fit_points = [p for p in points if p[0]["role"] == "fit"]
    bound_points = [p for p in points if p[0]["role"] == "bound"]
    detections = fire.get("detections")
    if detections:
        passes = set(detections["passes_utc"])
        for f in _read(history.package, "normalized/fire_detections.geojson")["features"]:
            p = f["properties"]
            cell = grid.cell_of(*f["geometry"]["coordinates"]) if p["acquired_at"] in passes else None
            if cell is not None:
                at_s = (parse_utc(p["acquired_at"]) - t0).total_seconds()
                bound_points.append(({"id": p["detection_id"], "role": "bound", "evidence_class": "observed"},
                                     _neighbourhood(grid, cell, DETECTION_NEIGHBOURHOOD), (0.0, at_s)))

    def at_points(arrival, pts):
        return [min(arrival[c] for c in cells) for _, cells, _ in pts]

    def summary(arrival, pts):
        values = at_points(arrival, pts)
        windows = [_Window(t0 + timedelta(seconds=w[0]), t0 + timedelta(seconds=w[1])) for _, _, w in pts]
        return score_arrival(values, t0, list(enumerate(windows)), horizon_s)

    candidates = timed_candidates(fire["priors"])
    table = []
    for params in candidates:
        arrival = _run_ignitions(grid, seeds, params, horizon_s)
        errors = [_window_error_min(a, w, horizon_s) for a, (_, _, w) in zip(at_points(arrival, fit_points), fit_points)]
        shape = _shape_iou(arrival, observed, grid.cell_area_km2)
        table.append({"params": params, "errors": errors, "shape": shape,
                      "objective": sum(errors) / len(errors) + IOU_WEIGHT_MIN * (1 - shape["iou"])})
    best = min(table, key=lambda r: r["objective"])
    params = best["params"]
    observed_speeds = set(fire["priors"].get("observed_wind_speed_m_s", []))
    at_observed_wind = min((r for r in table if r["params"].wind_speed_m_s in observed_speeds),
                           key=lambda r: r["objective"], default=None)

    # Leave-one-out: refit without each reported arrival and score that arrival with the refit choice.
    loo = []
    for k, (obs, _, _) in enumerate(fit_points):
        def objective_without(r, k=k):
            rest = r["errors"][:k] + r["errors"][k + 1:]
            return sum(rest) / len(rest) + IOU_WEIGHT_MIN * (1 - r["shape"]["iou"])
        refit = min(table, key=objective_without)
        loo.append({"id": obs["id"], "error_min": round(refit["errors"][k], 1),
                    "refit_wind_from_deg": refit["params"].wind_from_deg,
                    "refit_head_m_per_min": round(refit["params"].head_rate_m_per_min, 1)})
    loo_ranked = sorted(r["error_min"] for r in loo)
    n = len(loo_ranked)
    loo_median = (loo_ranked[n // 2] if n % 2 else (loo_ranked[n // 2 - 1] + loo_ranked[n // 2]) / 2) if n else None

    unclipped = _run_ignitions(grid, seeds, params, horizon_s)
    unclipped_fit, unclipped_bounds = summary(unclipped, fit_points), summary(unclipped, bound_points)
    at_stop = score(burned_mask(unclipped, horizon_s), observed, grid.cell_area_km2)
    arrival, constraint = constrain_to_perimeter(grid, unclipped, final)
    constraint = {**constraint, "kind": "clipped_to_final_satellite_perimeter",
                  "note": "Model front limited to the final FEDS perimeter (plus buffer): uses later evidence, so this "
                          "is a replay reconstruction, not a forecast. Calibration scores are for the unclipped model; "
                          "`observations.as_replayed` scores the clipped front."}
    clipped_area = score(burned_mask(arrival, horizon_s), observed, grid.cell_area_km2)
    point_rows = []
    for (obs, cells, w), a_unclipped, a_clipped in zip(points, at_points(unclipped, points), at_points(arrival, points)):
        point_rows.append({
            "id": obs["id"], "place": obs["place"], "role": obs["role"], "kind": obs["kind"],
            "reported_at": obs["at"], "window_utc": obs["window_utc"], "evidence_class": obs["evidence_class"],
            "source_id": obs["source_id"], "source_locator": obs["source_locator"],
            "model_at": format_utc(t0 + timedelta(seconds=a_unclipped)) if math.isfinite(a_unclipped) else None,
            "model_at_as_replayed": format_utc(t0 + timedelta(seconds=a_clipped)) if math.isfinite(a_clipped) else None,
            "window_error_min": round(_window_error_min(a_unclipped, w, horizon_s), 1),
            # model minus the reported time (positive = model late); for "present_by" bounds only lateness matters
            "error_vs_reported_min": round((a_unclipped - (parse_utc(obs["at"]) - t0).total_seconds()) / 60, 1)
            if math.isfinite(a_unclipped) else None,
            "cells": len(cells)})
    point_errors = sorted(abs(r["error_vs_reported_min"]) for r in point_rows
                          if r["role"] == "fit" and r["error_vs_reported_min"] is not None)
    m = len(point_errors)
    point_median = (point_errors[m // 2] if m % 2 else (point_errors[m // 2 - 1] + point_errors[m // 2]) / 2) if m else None
    excluded = [{"id": o["id"], "place": o["place"], "reason": o.get("note")} for o in observations
                if o["role"] == "excluded"]

    final_at = final.snapshot_at
    finite = [a for a in arrival if math.isfinite(a)]
    last = t0 + timedelta(seconds=max(finite)) + FRONT_EVERY if finite else t0
    until = min(end, final_at, last)
    record_ignitions = [{"id": i["id"], "coord": i["coord"], "at": i["at"], "time_precision": i["time_precision"],
                         "evidence_class": i["evidence_class"], "location_method": i["location_method"],
                         "source_id": i["source_id"], "source_locator": i["source_locator"]} for i in ignitions]
    ignition_record = {
        "coord": [round(ignitions[0]["coord"][0], 5), round(ignitions[0]["coord"][1], 5)],
        "at": format_utc(t0),
        "provenance": f"reported: {ignitions[0]['time_basis']} Place {ignitions[0]['location_method']} A second "
                      f"ignition ({ignitions[1]['id']}) is seeded at {ignitions[1]['at']}." if len(ignitions) > 1
                      else f"reported: {ignitions[0]['time_basis']} Place {ignitions[0]['location_method']}",
        "provenance_detail": record_ignitions,
    }
    fit_summary = unclipped_fit
    headline = (f"median arrival error {point_median:.0f} min from the reported times at {m} places "
                f"({fit_summary['median_abs_error_min']:.0f} min outside the report windows; leave-one-out "
                f"{loo_median:.0f} min); shape IoU {best['shape']['iou']:.2f} with the final satellite perimeter. "
                "Fitted to reported arrival times; no fuel or terrain layer")
    block = {
        "evidence_class": "simulated",
        "model": {"id": MODEL_ID, "version": MODEL_VERSION, "params": params.to_dict()},
        "ignition": ignition_record,
        "calibration": {
            "target_snapshot_at": format_utc(final_at),
            "iou": best["shape"]["iou"],
            "area_ratio": clipped_area["area_ratio"],
            "method": (f"minimum of mean window error at {len(fit_points)} reported first arrivals + "
                       f"{IOU_WEIGHT_MIN:g} min x (1 - shape IoU with the final perimeter), over {len(candidates)} "
                       "parameter sets from the evidence priors (westerly sector)"),
            "headline": headline,
            "fitted_to": "reported fire-arrival times (AAR, FLA, Colorado Sun dispatch recordings) and the final "
                         "FEDS perimeter's shape",
            "evidence_file": evidence["path"],
            "observations": {
                "source": "curated reports in " + evidence["path"] + " (reported; geocoded here, derived)",
                "report_lag_min": fire["report_lag_min"],
                "fit": fit_summary,
                "vs_reported_time": {"n": m, "median_abs_error_min": point_median,
                                     "metric": "|model arrival - reported time|, no window"},
                "leave_one_out": {"n": n, "median_abs_error_min": loo_median, "rows": loo,
                                  "metric": "window error of each arrival under the choice refitted without it"},
                "bounds": {**unclipped_bounds, "role": "evaluation only: 'fire present by' sightings and FIRMS "
                                                       "daytime detections (window = ignition to sighting)"},
                "as_replayed": {"fit": summary(arrival, fit_points), "bounds": summary(arrival, bound_points)},
                "points": point_rows, "excluded": excluded,
                "within_minutes": WITHIN_MINUTES,
            },
            "perimeter": {"snapshot_at": format_utc(final_at), "perimeter_id": fire["final_perimeter_id"],
                          "shape_iou": best["shape"]["iou"], "shape_iou_at_min_after_t0": best["shape"]["at_min"],
                          "iou_at_spread_stop_unclipped": at_stop["iou"],
                          "area_ratio_at_spread_stop_unclipped": at_stop["area_ratio"],
                          "area_ratio_as_replayed": clipped_area["area_ratio"],
                          "n_cells": sum(observed), "cell_m": grid.cell_m, "spread_stop": fire["spread_stop"]["at"],
                          "role": "shape term of the objective (direction and elongation); spread rate comes from "
                                  "the arrival times"},
            "objective": {"weight_min_per_iou": IOU_WEIGHT_MIN, "best": round(best["objective"], 2)},
            "at_observed_wind_speed": at_observed_wind and {
                "params": at_observed_wind["params"].to_dict(),
                "mean_window_error_min": round(sum(at_observed_wind["errors"]) / len(at_observed_wind["errors"]), 1),
                "shape_iou": at_observed_wind["shape"]["iou"], "objective": round(at_observed_wind["objective"], 2),
                "note": "best candidate with the wind speed held at the observed sustained range: the narrower "
                        "ellipse fits the perimeter shape worse, so it is not chosen"},
            "params_source": f"chosen on every build from {len(candidates)} candidates ({evidence['path']} priors)",
            "wind_evidence": fire["wind_evidence"],
            "perimeter_time_precision": final.feature["properties"].get("time_precision"),
        },
        "constraint": constraint,
        "hazard_until": format_utc(final_at),
        "fronts": isochrones(grid, arrival, t0, until=until, every=FRONT_EVERY),
        "arrival_grid": {
            "origin_lon": grid.origin_lon, "origin_lat": grid.origin_lat, "cell_m": grid.cell_m,
            "ncols": grid.ncols, "nrows": grid.nrows,
            "m_per_deg_lon": grid._m_per_deg_lon, "m_per_deg_lat": grid._m_per_deg_lat,
            "t0": format_utc(t0),
            "minutes": [round(a / 60) if math.isfinite(a) else None for a in arrival],
        },
        "assumptions": [
            f"Ignitions: {'; '.join(i['id'] + ' at ' + i['at'] + ' (' + i['location_method'] + ')' for i in ignitions)}.",
            "Fitted to reported fire-arrival times (minute-level reports from the AAR, the FLA and dispatch "
            f"recordings; a report at t means arrival in [t - {fire['report_lag_min']} min, t]) and to the final "
            "satellite perimeter's shape. Report places are geocoded from OSM names (derived).",
            "Uniform fuel, flat terrain (no fuel or terrain layer), constant wind; no spotting, no urban "
            "structure-to-structure spread. The fitted wind direction is a fit within the westerly sector; the "
            "fitted wind speed only sets ellipse elongation and is not the observed 22-27 m/s sustained wind.",
            "One constant spread rate: the model cannot slow down in town or when the wind eased (about 18:30 MST); "
            "the clip to the final perimeter stands in for that.",
            "The simulated front is the traffic hazard until the final perimeter time (hazard_until); the FEDS "
            "half-day labels (12:00 and 24:00 local) are not the times their extents were reached.",
        ],
    }
    return block, (grid, arrival, t0, arrival_lookup(grid, arrival, t0))


# --- demand ------------------------------------------------------------------------------------------------

def _vehicles_by_household(p: dict) -> list[tuple[int, int]]:
    """(vehicles available, households); 5 = 5+. Kincade/Camp: a dict; Marshall: flat ACS fields."""
    if "households_by_vehicles_available" in p:
        return [(5 if k == "5_plus" else int(k), v["households"] if isinstance(v, dict) else v)
                for k, v in p["households_by_vehicles_available"].items()]
    keys = {0: "households_0_vehicles", 1: "households_1_vehicle", 2: "households_2_vehicles",
            3: "households_3_vehicles", 4: "households_4_vehicles", 5: "households_5plus_vehicles"}
    return [(k, p[name] or 0) for k, name in keys.items()]


def _crosswalk(package: Path) -> dict[str, dict[str, float]]:
    """zone_id -> {geoid: share of the block group's area inside the zone}. Marshall nests units per zone;
    Kincade lists flat rows."""
    raw = _read(package, "normalized/zone_population_crosswalk.json")
    out: dict[str, dict[str, float]] = {}
    for z in raw.get("zones", []):
        out[z["zone_id"]] = {u["geoid"]: u["share_of_unit_area"] for u in z["units"]}
    for r in raw.get("rows", []):
        out.setdefault(r["zone_id"], {})[r["geoid"]] = r["area_share"]
    return out


CROSSWALK_CELL_M = 100.0  # raster cell for block-group shares of zones the package crosswalk omits


def _raster_shares(zone_geometry: dict, units: dict[str, dict], unit_geometry: dict[str, dict]) -> dict[str, float]:
    """geoid -> share of the block group's area inside the zone, by counting CROSSWALK_CELL_M cells (derived here)."""
    zx0, zy0, zx1, zy1 = _bbox(zone_geometry)
    out = {}
    for geoid, geometry in unit_geometry.items():
        x0, y0, x1, y1 = _bbox(geometry)
        if x1 < zx0 or x0 > zx1 or y1 < zy0 or y0 > zy1:
            continue
        grid = Grid.covering([x0, y0, x1, y1], CROSSWALK_CELL_M)
        unit_mask, zone_mask = rasterize(grid, geometry), rasterize(grid, zone_geometry)
        total = sum(unit_mask)
        both = sum(1 for u, z in zip(unit_mask, zone_mask) if u and z)
        if total and both:
            out[geoid] = round(both / total, 6)
    return out


@dataclass(frozen=True)
class _Area:  # duck type for sim.demand._Locator
    geoid: str
    bbox: tuple[float, float, float, float]
    geometry: dict


def _split_zones(zones_src: dict, evidence: dict) -> tuple[dict, dict[str, list[str]], list[dict]]:
    """Split package zones at a place boundary (evidence `zone_splits`): (zones_src with the parts added,
    base zone -> part ids, report rows). Parts are derived on a raster and outlined without smoothing."""
    zones_src, parts, rows = dict(zones_src), {}, []
    for split in evidence.get("zone_splits", []):
        base = zones_src[split["zone_id"]]
        place = evidence["places"][split["place_geoid"]]["geometry"]
        cell_m = float(split["cell_m"])
        grid = Grid.covering(list(_bbox(base["geometry"])), cell_m, cell_m)
        zone_mask, place_mask = rasterize(grid, base["geometry"]), rasterize(grid, place)
        ids = []
        for part_id, inside in ((split["inside_id"], True), (split["outside_id"], False)):
            mask = bytearray(z and (p if inside else not p) for z, p in zip(zone_mask, place_mask))
            if not any(mask):
                continue
            label = f"{'inside' if inside else 'outside'} {split['place_name']}"
            zones_src[part_id] = {"type": "Feature", "geometry": mask_contour(grid, mask, smooth_iterations=0),
                                  "properties": {**base["properties"], "zone_id": part_id,
                                                 "name": f"{base['properties'].get('name') or split['zone_id']} ({label})",
                                                 "geometry_status": "derived", "derived_from": split["zone_id"],
                                                 "geometry_method": split["method"]}}
            ids.append(part_id)
            rows.append({"zone_id": part_id, "derived_from": split["zone_id"], "place": split["place_name"],
                         "place_geoid": split["place_geoid"], "inside": inside, "cells": sum(mask),
                         "cell_m": cell_m, "reason": split["reason"]})
        parts[split["zone_id"]] = ids
    return zones_src, parts, rows


def package_demand(package: Path, network, evidence: dict | None = None) -> dict:
    """One demand zone per evacuation zone that an order or warning names, from ACS block groups.

    Vehicles of a zone = sum over block groups of evacuating vehicles x the share of the block group's area
    inside the zone that no earlier-ordered zone already covered (zones overlap; the max of shares is a
    lower bound on their union). Orders and warnings target zones directly by zone ID. `evidence`
    (load_evidence) adds cited orders and splits zones at a place boundary; notices naming a split zone
    then name all of its parts.
    """
    zones_src = {f["properties"]["zone_id"]: f for f in _read(package, "normalized/evacuation_zones.geojson")["features"]}
    unit_features = _read(package, "normalized/population_units.geojson")["features"]
    units = {f["properties"]["geoid"]: f["properties"] for f in unit_features}
    crosswalk = _crosswalk(package)
    events = _events(package)
    split_rows, extra_orders = [], []
    if evidence:
        zones_src, parts, split_rows = _split_zones(zones_src, evidence)
        extra_orders = [{**o, "source_locator": f"{o['source_locator']} (via {evidence['path']})"}
                        for o in evidence.get("orders", [])]
        events = [*events, *extra_orders]
        events = [{**e, "target": {**e["target"], "zone_ids": [p for z in e["target"]["zone_ids"] for p in parts.get(z, [z])]}}
                  if (e.get("target") or {}).get("zone_ids") else e for e in events]
    notices = [e for e in events if e["type"] in NOTICE_TYPES and (e.get("target") or {}).get("zone_ids")]
    unzoned = [{"event_id": e["event_id"], "at": e["occurred_at"], "type": e["type"],
                "place_name": (e.get("target") or {}).get("place_name"),
                "mapping": "none: timeline only (no zone IDs; place text is not matched to zone polygons)"}
               for e in events if e["type"] in NOTICE_TYPES and not (e.get("target") or {}).get("zone_ids")]
    derived_here = []
    named_zones = {z for e in notices for z in e["target"]["zone_ids"]}
    for z in sorted(named_zones):
        if z not in crosswalk and (zones_src.get(z) or {}).get("geometry"):
            crosswalk[z] = _raster_shares(zones_src[z]["geometry"], units,
                                          {f["properties"]["geoid"]: f["geometry"] for f in unit_features})
            derived_here.append({"zone_id": z, "block_groups": len(crosswalk[z]),
                                 "method": f"derived in sim.incidents: block-group area share inside the zone polygon by "
                                           f"{CROSSWALK_CELL_M:g} m raster cells (package crosswalk has no rows)"})
    first: dict[str, dict[str, datetime]] = {}
    for e in notices:
        for z in e["target"]["zone_ids"]:
            slot = first.setdefault(z, {})
            at = parse_utc(e["occurred_at"])
            if e["type"] not in slot or at < slot[e["type"]]:
                slot[e["type"]] = at
    never = datetime.max.replace(tzinfo=timezone.utc)
    named = sorted(first, key=lambda z: (first[z].get("evacuation_order", never), first[z].get("evacuation_warning", never), z))
    modelled = [z for z in named if z in crosswalk and z in zones_src and zones_src[z].get("geometry")]
    unmapped = [{"zone_id": z, "reason": "no polygon in evacuation_zones" if not (zones_src.get(z) or {}).get("geometry")
                 else "no crosswalk rows"} for z in named if z not in modelled]

    covered: dict[str, dict[str, float]] = {}  # geoid -> {earlier zone: share assigned to it}
    # Parts of one split zone are disjoint, so a sibling's share is not treated as overlap.
    siblings: dict[str, set[str]] = {}
    for r in split_rows:
        siblings.setdefault(r["zone_id"], set()).update(
            x["zone_id"] for x in split_rows if x["derived_from"] == r["derived_from"])
    used_units: set[str] = set()
    zones, stats = [], []
    for z in modelled:
        f = zones_src[z]
        locate = _Locator([_Area(z, _bbox(f["geometry"]), f["geometry"])])
        origin = tuple(sorted(n for n, (lon, lat) in network.nodes.items() if locate(lon, lat)))
        vehicles = households = population = no_vehicle = older = 0.0
        for geoid, share in crosswalk[z].items():
            u = units.get(geoid)
            earlier = covered.get(geoid, {})
            overlapping = sum(v for zz, v in earlier.items() if zz not in siblings.get(z, ()))
            add = max(0.0, min(min(1.0, share) - overlapping, 1.0 - sum(earlier.values())))
            if u is None or add <= 0:
                continue
            covered.setdefault(geoid, {})[z] = add
            used_units.add(geoid)
            veh = sum(hh * min(k, VEHICLES_TAKEN_CAP) for k, hh in _vehicles_by_household(u)) * EVACUATION_PARTICIPATION
            vehicles += veh * add
            households += (u.get("households") or 0) * add
            population += (u.get("population") or 0) * add
            no_vehicle += (u.get("households_no_vehicle") or 0) * add
            older += (u.get("population_65_plus") or 0) * add
        veh = round(vehicles) if origin else 0
        name = (f["properties"].get("name") or f["properties"].get("zone_label_as_written") or z)
        zones.append(DemandZone(id=z, name=name, households=round(households), vehicles=veh, origin_nodes=origin,
                                geometry=f["geometry"]))
        stats.append({"zone_id": z, "name": name, "population": round(population), "households": round(households),
                      "households_no_vehicle": round(no_vehicle), "population_65_plus": round(older),
                      "evacuating_vehicles": veh, "vehicles_dropped_no_origin": 0 if origin else round(vehicles),
                      "origin_nodes": len(origin), "block_groups": len(crosswalk[z]),
                      "first_order": format_utc(first[z]["evacuation_order"]) if "evacuation_order" in first[z] else None,
                      "first_warning": format_utc(first[z]["evacuation_warning"]) if "evacuation_warning" in first[z] else None})

    ids = {z.id for z in zones}
    traffic_events, mapped = [], []
    for e in notices:
        targets = tuple(z for z in e["target"]["zone_ids"] if z in ids)
        missing = [z for z in e["target"]["zone_ids"] if z not in ids]
        mapped.append({"event_id": e["event_id"], "at": e["occurred_at"], "type": e["type"],
                       "zone_ids": list(targets), "unmapped_zone_ids": missing})
        kind = "Evacuation order" if e["type"] == "evacuation_order" else "Evacuation warning"
        traffic_events.append(TrafficEvent(
            id=e["event_id"], at=parse_utc(e["occurred_at"]), type=e["type"],
            label=f"{kind}: {e.get('description') or ', '.join(e['target']['zone_ids'])}",
            evidence_class=e["evidence_class"], time_precision=e["time_precision"], zone_ids=targets,
            source_id=e["source_id"], source_locator=e.get("source_locator")))

    totals = {
        "zones": len(zones),
        "block_groups": len(used_units),
        "population": sum(s["population"] for s in stats),
        "households": sum(s["households"] for s in stats),
        "households_no_vehicle": sum(s["households_no_vehicle"] for s in stats),
        "population_65_plus": sum(s["population_65_plus"] for s in stats),
        "evacuating_vehicles": sum(z.vehicles for z in zones),
        "vehicles_dropped_no_origin": sum(s["vehicles_dropped_no_origin"] for s in stats),
        "orders_and_warnings": len(notices),
        "orders_mapped": sum(1 for m in mapped if m["zone_ids"] and m["type"] == "evacuation_order"),
        "warnings_mapped": sum(1 for m in mapped if m["zone_ids"] and m["type"] == "evacuation_warning"),
    }
    report = {
        "evidence_class": "derived",
        "crosswalk": "package zone_population_crosswalk.json (zone x block-group area shares; derived by the "
                     "package builder), not the Camp derived crosswalk",
        "population_source": "package population_units.geojson: "
                             f"{_read(package, 'manifest.json')['layers']['population_units'].get('acs_vintage', 'ACS 5-year')} "
                             "block-group estimates (population, households, vehicles available, 65+), not counts "
                             "of people present on the day",
        "orders_from_evidence": [{"event_id": o["event_id"], "at": o["occurred_at"], "type": o["type"],
                                  "place_name": o["target"].get("place_name"), "evidence_class": o["evidence_class"],
                                  "source_id": o["source_id"], "zone_mapping": o.get("zone_mapping")}
                                 for o in extra_orders],
        "zone_splits": split_rows,
        "parameters": {"vehicles_taken_cap": VEHICLES_TAKEN_CAP, "evacuation_participation": EVACUATION_PARTICIPATION},
        "totals": totals, "unmapped_zones": unmapped, "crosswalk_derived_here": derived_here,
        "orders_without_zone_ids": unzoned, "notices": mapped, "zones": stats,
    }
    return {"zones": tuple(zones), "events": tuple(traffic_events), "report": report}


def package_replay_inputs(incident: Incident, history: IncidentHistory) -> tuple[dict, datetime, datetime, dict]:
    """(scenario, start, end, ignition) for a generic evacuation package; call after verify_package."""
    package = incident.roads_package
    network, exits, provenance = load_road_network(package, verify=False)
    evidence = load_evidence(incident)
    demand = package_demand(package, network, evidence)
    road_events, road_report = resolve_road_events(package, network, exits)
    kept = []
    for ev in road_events:
        if ev.type in NOTICE_TYPES:
            continue  # re-emitted with zone targets by package_demand
        if ev.edge_ids and ev.time_precision == "day":
            ev = replace(ev, edge_ids=())  # untimed narrative: timeline only, never a day-long closure
        kept.append(ev)
    ignition = package_ignition(package, history)
    if evidence and evidence.get("fire"):
        ignition["evidence"] = evidence  # package_fire then fits to the curated timed observations
    start, end, clock_rule = package_clock(package, ignition["at"])
    manifest = _read(package, "manifest.json")
    clip = manifest["requested_bbox"]
    box = _union_bbox([*(_bbox(z.geometry) for z in demand["zones"]), *(_bbox(p.geometry) for p in history.perimeters)])
    report = demand["report"]
    t = report["totals"]
    snapped = sum(1 for r in road_report if r.get("status") == "snapped")
    road_like = sum(1 for r in road_report if r.get("status") != "not_road")
    scenario = {
        "network": network,
        "zones": demand["zones"],
        "destinations": exits,
        "events": (*load_alert_events(package), *kept, *demand["events"]),
        "evidence_class": "derived",
        "roads_evidence_class": "observed",
        "destinations_evidence_class": "derived",
        "bbox": [round(max(box[0], clip[0]), 3), round(max(box[1], clip[1]), 3),
                 round(min(box[2], clip[2]), 3), round(min(box[3], clip[3]), 3)],
        "notes": [
            *provenance["assumptions"],
            f"Demand: {t['zones']} evacuation zones from ACS block groups via the package crosswalk: about "
            f"{t['population']} residents, {t['households']} households, {t['evacuating_vehicles']} evacuating vehicles "
            f"(derived: min(vehicles, {VEHICLES_TAKEN_CAP}) per household, participation {EVACUATION_PARTICIPATION:g}); "
            f"{t['households_no_vehicle']} households have no vehicle and need assistance (not modelled).",
            "Overlapping zones: a block group's area share counts once, for the earliest-ordered zone that covers it "
            "(max of shares, a lower bound on their union).",
            f"Orders and warnings target zones by their own zone IDs ({t['orders_mapped']} orders, "
            f"{t['warnings_mapped']} warnings mapped); unmapped zones: "
            f"{', '.join(u['zone_id'] for u in report['unmapped_zones']) or 'none'}.",
            "Vehicles start at road nodes inside the zone polygon; destinations are exits of the road extract. "
            "Package shelters appear on the timeline only.",
            f"Road events: {snapped} of {road_like} snapped to edges; day-precision (untimed) road events stay on the "
            "timeline and never close edges.",
            *ROAD_EVENT_ASSUMPTIONS,
            *([f"Block-group shares for {', '.join(d['zone_id'] for d in report['crosswalk_derived_here'])} are derived "
               f"here by {CROSSWALK_CELL_M:g} m raster overlap (the package crosswalk has no rows for them)."]
              if report["crosswalk_derived_here"] else []),
            *([f"Zones split at a 2020 Census place boundary (derived, {report['zone_splits'][0]['cell_m']:g} m raster): "
               + "; ".join(f"{r['zone_id']} ({'inside' if r['inside'] else 'outside'} {r['place']})"
                           for r in report["zone_splits"]) + "."] if report["zone_splits"] else []),
            *incident.assumptions,
            f"Clock: {clock_rule}. {incident.clock_note}",
        ],
        "demand_report": report,
        "road_event_report": road_report,
    }
    return scenario, start, end, ignition


# --- validation and index ----------------------------------------------------------------------------------

def not_computed_validation(package: Path) -> dict:
    path = package / "normalized/calibration_targets.json"
    targets = json.loads(path.read_text())["targets"] if path.exists() else []
    reason = ("No generic model-vs-published comparison for this package yet (Camp-specific "
              "sim.validation.calibration_report); listed for next work.")
    rows = [{"target_id": t["target_id"], "metric": t["metric"], "location": t.get("location"),
             "published": t["value"], "unit": t.get("unit"), "evidence_class": t.get("evidence_class"),
             "source_locator": t.get("source_locator"), "model": None, "comparability": "not_computed",
             "caveat": reason} for t in targets]
    return {"evidence_class": "simulated", "rows": rows, "input_checks": [],
            "grades": {"not_computed": "model cannot produce it yet"},
            "next_work": ["generic calibration_report over calibration_targets.json",
                          "model-vs-observed traffic at package traffic stations"]}


def bundle_incident(incident: Incident, history: IncidentHistory) -> dict:
    """Registry fields added to the bundle's `incident` block."""
    manifest = history.manifest
    tz = manifest.get("time_zone")
    out = {"registry_id": incident.id, "name": incident.name, "place": incident.place}
    if tz:
        out["timezone"] = tz
    return out


def update_index(bundle: dict, output: Path, incident: Incident) -> Path:
    """Write or update app/public/replays/index.json next to the bundle (one entry per registry id)."""
    index_path = output.parent / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else {}
    entries = [e for e in index.get("incidents", []) if e["id"] != incident.id]
    entries.append({
        "id": incident.id, "name": incident.name, "place": incident.place,
        "date": parse_utc(bundle["clock"]["start"]).astimezone(ZoneInfo(bundle["incident"]["timezone"])).date().isoformat(),
        "timezone": bundle["incident"]["timezone"],
        "clock": bundle["clock"], "bundle": output.name, "package_version": bundle["incident"]["package_version"],
        "layer_status": {k: v["status"] for k, v in bundle["layer_status"].items()},
    })
    order = list(INCIDENTS)
    entries.sort(key=lambda e: order.index(e["id"]) if e["id"] in order else len(order))
    index_path.write_text(json.dumps({"kind": INDEX_KIND, "schema_version": INDEX_SCHEMA_VERSION,
                                      "incidents": entries}, indent=1, sort_keys=True) + "\n")
    return index_path
