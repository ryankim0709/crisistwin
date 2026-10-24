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
from sim.firefront import arrival_lookup, constrain_to_perimeter, isochrones
from sim.geo import Grid, rasterize
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
    """
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


@dataclass(frozen=True)
class _Area:  # duck type for sim.demand._Locator
    geoid: str
    bbox: tuple[float, float, float, float]
    geometry: dict


def package_demand(package: Path, network) -> dict:
    """One demand zone per evacuation zone that an order or warning names, from ACS block groups.

    Vehicles of a zone = sum over block groups of evacuating vehicles x the share of the block group's area
    inside the zone that no earlier-ordered zone already covered (zones overlap; the max of shares is a
    lower bound on their union). Orders and warnings target zones directly by zone ID.
    """
    zones_src = {f["properties"]["zone_id"]: f for f in _read(package, "normalized/evacuation_zones.geojson")["features"]}
    units = {f["properties"]["geoid"]: f["properties"] for f in _read(package, "normalized/population_units.geojson")["features"]}
    crosswalk = _crosswalk(package)
    events = _events(package)
    notices = [e for e in events if e["type"] in NOTICE_TYPES and (e.get("target") or {}).get("zone_ids")]
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

    covered: dict[str, float] = {}  # geoid -> share already assigned to earlier zones
    zones, stats = [], []
    for z in modelled:
        f = zones_src[z]
        locate = _Locator([_Area(z, _bbox(f["geometry"]), f["geometry"])])
        origin = tuple(sorted(n for n, (lon, lat) in network.nodes.items() if locate(lon, lat)))
        vehicles = households = population = no_vehicle = older = 0.0
        for geoid, share in crosswalk[z].items():
            u = units.get(geoid)
            add = max(0.0, min(1.0, share) - covered.get(geoid, 0.0))
            if u is None or add <= 0:
                continue
            covered[geoid] = covered.get(geoid, 0.0) + add
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
        "parameters": {"vehicles_taken_cap": VEHICLES_TAKEN_CAP, "evacuation_participation": EVACUATION_PARTICIPATION},
        "totals": totals, "unmapped_zones": unmapped, "notices": mapped, "zones": stats,
    }
    return {"zones": tuple(zones), "events": tuple(traffic_events), "report": report}


def package_replay_inputs(incident: Incident, history: IncidentHistory) -> tuple[dict, datetime, datetime, dict]:
    """(scenario, start, end, ignition) for a generic evacuation package; call after verify_package."""
    package = incident.roads_package
    network, exits, provenance = load_road_network(package, verify=False)
    demand = package_demand(package, network)
    road_events, road_report = resolve_road_events(package, network, exits)
    kept = []
    for ev in road_events:
        if ev.type in NOTICE_TYPES:
            continue  # re-emitted with zone targets by package_demand
        if ev.edge_ids and ev.time_precision == "day":
            ev = replace(ev, edge_ids=())  # untimed narrative: timeline only, never a day-long closure
        kept.append(ev)
    ignition = package_ignition(package, history)
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
