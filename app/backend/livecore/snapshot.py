"""Scenario resource snapshot: households and fire stations (with engines) at a drill's T+0.

Contract and every assumption: docs/scenario-snapshots.md. Config: tools/snapshot_assumptions.json.

Pure (stdlib only, no Django, MongoDB or network). ``build_snapshot`` reads one drill document
(the Camp replay bundle or a Studio drill package, both replay-bundle JSON) plus the effective
assumptions and returns plain dicts the API stores in ``scenario_snapshots``,
``snapshot_households`` and ``snapshot_stations``. Everything is seeded by the incident id:
the same inputs give the same household ids, counts, positions, engines and ``content_hash``.

Labels (``basis``): ``observed`` (a public record: OSM or NIST station location), ``estimated``
(derived from a public count, e.g. an ACS zone total split over households), ``synthetic``
(a stated assumption), ``unknown`` (value null; never 0). Units: counts are households,
persons or vehicles; coordinates WGS84 ``[lon, lat]``; times UTC.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import random
from collections.abc import Iterable, Mapping, Sequence
from datetime import datetime
from typing import Any

from .drill import DEFAULT_REPLAY_START, parse_time
from .geo import LonLat, centroid, point_in_multipolygon, to_multipolygon

BUILDER = "scenario-snapshot/1"
BASES = ("observed", "estimated", "synthetic", "unknown")
ENGINE_KINDS = ("type1_engine", "type3_engine")
ENGINE_STATUSES = ("available", "committed", "out_of_service")
M_PER_DEG_LAT = 111_195.08


class SnapshotError(ValueError):
    """The drill or the config cannot produce a consistent snapshot."""


# --- config ---------------------------------------------------------------------------------


def _merge(base: Mapping[str, Any], over: Mapping[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(dict(base))
    for key, value in over.items():
        if isinstance(value, Mapping) and isinstance(out.get(key), Mapping):
            out[key] = _merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def effective_config(config: Mapping[str, Any], incident_id: str) -> dict[str, Any]:
    """``defaults`` merged with ``incidents[incident_id]`` (objects merge, lists replace)."""
    if config.get("kind") != "crisistwin_snapshot_assumptions":
        raise SnapshotError("assumptions file kind must be crisistwin_snapshot_assumptions")
    return _merge(config.get("defaults") or {}, (config.get("incidents") or {}).get(incident_id) or {})


# --- small seeded helpers -------------------------------------------------------------------


def _sha(*parts: Any) -> str:
    return hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()


def _unit(*parts: Any) -> float:
    """A deterministic number in [0, 1) from the parts."""
    return int(_sha(*parts)[:13], 16) / float(1 << 52)


def household_id(incident_id: str, zone_id: str, index: int) -> str:
    return "hh_" + _sha(incident_id, zone_id, index)[:16]


def _apportion(shares: Mapping[str, float], n: int) -> list[int]:
    """``n`` integer values whose counts follow ``shares`` (largest remainder), in key order."""
    items = sorted(((int(k), float(v)) for k, v in shares.items()), key=lambda kv: kv[0])
    total = sum(v for _, v in items)
    if n <= 0 or total <= 0:
        return []
    raw = [(k, n * v / total) for k, v in items]
    counts = {k: math.floor(x) for k, x in raw}
    left = n - sum(counts.values())
    for k, _ in sorted(raw, key=lambda kx: (-(kx[1] - math.floor(kx[1])), kx[0]))[:left]:
        counts[k] += 1
    return [k for k, _ in items for _ in range(counts[k])]


def _nudge(values: list[int], target: int, rng: random.Random, floor: int, up_min: int, down_min: int) -> None:
    """Add or remove units one at a time (seeded order) until ``sum(values) == target``.

    Only values ``>= up_min`` are raised and only values ``> down_min`` are lowered, never
    below ``floor``. Stops early when no value can move."""
    order = list(range(len(values)))
    rng.shuffle(order)
    diff = target - sum(values)
    while diff != 0:
        moved = False
        for i in order:
            if diff > 0 and values[i] >= up_min:
                values[i] += 1
                diff -= 1
                moved = True
            elif diff < 0 and values[i] > max(down_min, floor):
                values[i] -= 1
                diff += 1
                moved = True
            if diff == 0:
                break
        if not moved:
            return


# --- drill document -> inputs ---------------------------------------------------------------


def scenario_time(bundle: Mapping[str, Any]) -> datetime:
    """The drill's T+0: where its clock starts by default (Camp 15:00Z, a package ``clock.start``)."""
    start, end = parse_time(bundle["clock"]["start"]), parse_time(bundle["clock"]["end"])
    if start <= DEFAULT_REPLAY_START < end:
        return DEFAULT_REPLAY_START
    return start


def _road_nodes(bundle: Mapping[str, Any]) -> list[LonLat]:
    seen: dict[str, LonLat] = {}
    for edge in (bundle.get("roads") or {}).get("edges") or []:
        coords = edge.get("coords") or []
        if coords:
            seen.setdefault(str(edge["from_node"]), (float(coords[0][0]), float(coords[0][1])))
            seen.setdefault(str(edge["to_node"]), (float(coords[-1][0]), float(coords[-1][1])))
    return [seen[k] for k in sorted(seen)]


def _bbox(geometry) -> tuple[float, float, float, float]:
    xs = [p[0] for poly in geometry for ring in poly for p in ring]
    ys = [p[1] for poly in geometry for ring in poly for p in ring]
    return min(xs), min(ys), max(xs), max(ys)


def _demand_rows(bundle: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    return {str(r["zone_id"]): r for r in (bundle.get("demand") or {}).get("zones") or [] if r.get("zone_id")}


def _is_package(bundle: Mapping[str, Any]) -> bool:
    return bool(bundle.get("drill_package"))


def _stations(bundle: Mapping[str, Any], cfg: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Package OSM stations (observed locations) plus ``extra_stations`` from the config."""
    patterns = [p.upper() for p in (cfg.get("engines") or {}).get("state_name_patterns") or []]
    out = []
    for f in (bundle.get("stations") or {}).get("features") or []:
        name = str(f.get("name") or "Fire station")
        out.append({
            "station_id": str(f["id"]), "name": name,
            "coord": (float(f["coord"][0]), float(f["coord"][1])),
            "basis": "observed", "class": "state" if any(p in name.upper() for p in patterns) else "local",
            "source_id": "osm", "locator": None,
        })
    for s in cfg.get("extra_stations") or []:
        basis = str(s.get("basis") or "synthetic")
        if basis not in ("observed", "synthetic"):
            raise SnapshotError(f"station {s.get('id')}: basis must be observed or synthetic")
        out.append({
            "station_id": str(s["id"]), "name": str(s.get("name") or s["id"]),
            "coord": (float(s["coord"][0]), float(s["coord"][1])), "basis": basis,
            "class": str(s.get("class") or "local"), "source_id": s.get("source_id"), "locator": s.get("locator"),
        })
    ids = [s["station_id"] for s in out]
    if len(ids) != len(set(ids)):
        raise SnapshotError("station ids must be unique")
    return out


# --- households -----------------------------------------------------------------------------


def _occupants(zone_id: str, n: int, row: Mapping[str, Any] | None, cfg: Mapping[str, Any], seed: str,
               notes: list[str]) -> tuple[list[int | None], str]:
    occ = cfg.get("occupants") or {}
    method = occ.get("method") or "distribution"
    if method == "unknown":
        return [None] * n, "unknown"
    values = _apportion(occ.get("distribution") or {"2": 1.0}, n)
    rng = random.Random(f"{seed}|{zone_id}|occupants")
    rng.shuffle(values)
    if method == "acs_zone_population":
        population = row.get("population_in_extract", row.get("population")) if row else None
        if not isinstance(population, (int, float)) or population < 0:
            notes.append(f"{zone_id}: no ACS population; occupants use the synthetic distribution")
            return values, "synthetic"
        target = int(round(population))
        if target < n:
            notes.append(f"{zone_id}: ACS population {target} < {n} households; one person per household")
            target = n
        _nudge(values, target, rng, floor=1, up_min=1, down_min=1)
        return values, "estimated"
    if method != "distribution":
        raise SnapshotError(f"unknown occupants method {method!r}")
    return values, "synthetic"


def _vehicles_acs(zone_id: str, n: int, row: Mapping[str, Any], pooled_extra: float, rng: random.Random,
                  notes: list[str]) -> list[int]:
    """Camp: carless = ACS, min(v, 2) sums to the bundle's evacuating_vehicles, extras from ACS totals."""
    carless = int(row.get("households_no_vehicle_in_extract", row.get("households_no_vehicle")) or 0)
    carless = max(0, min(n, carless))
    with_vehicle = n - carless
    evacuating = int(row.get("evacuating_vehicles") or 0)
    one = max(0, min(with_vehicle, 2 * with_vehicle - evacuating))
    two_plus = with_vehicle - one
    if one + 2 * two_plus != evacuating:
        notes.append(f"{zone_id}: evacuating_vehicles {evacuating} not reachable with cap 2; "
                     f"{one + 2 * two_plus} used")
    available = row.get("vehicles_available_total")
    if isinstance(available, (int, float)):
        households = row.get("households") or n
        scaled = available * (n / households) if households else available
        extra = max(0, int(round(scaled)) - one - 2 * two_plus)
    else:
        extra = int(round(pooled_extra * two_plus))
        notes.append(f"{zone_id}: no ACS vehicles_available_total; extra vehicles from the pooled Camp ratio "
                     f"{pooled_extra:.3f} per 2+ vehicle household")
    values = [0] * carless + [1] * one + [2] * two_plus
    rng.shuffle(values)
    twos = [i for i, v in enumerate(values) if v >= 2]
    rng.shuffle(twos)
    for k in range(extra if twos else 0):
        values[twos[k % len(twos)]] += 1
    return values


def _pooled_extra(rows: Iterable[Mapping[str, Any]]) -> float:
    extra = two_plus_total = 0.0
    for row in rows:
        available = row.get("vehicles_available_total")
        if not isinstance(available, (int, float)):
            continue
        n = int(row.get("households_in_extract", row.get("households")) or 0)
        carless = int(row.get("households_no_vehicle_in_extract", row.get("households_no_vehicle")) or 0)
        with_vehicle = max(0, n - carless)
        one = max(0, min(with_vehicle, 2 * with_vehicle - int(row.get("evacuating_vehicles") or 0)))
        two_plus = with_vehicle - one
        households = row.get("households") or n
        scaled = available * (n / households) if households else available
        extra += max(0.0, scaled - one - 2 * two_plus)
        two_plus_total += two_plus
    return extra / two_plus_total if two_plus_total else 0.0


def _vehicles(zone: Mapping[str, Any], n: int, row: Mapping[str, Any] | None, cfg: Mapping[str, Any], seed: str,
              pooled_extra: float, notes: list[str]) -> tuple[list[int | None], str]:
    veh = cfg.get("vehicles") or {}
    method = veh.get("method") or "distribution"
    rng = random.Random(f"{seed}|{zone['id']}|vehicles")
    if method == "unknown":
        return [None] * n, "unknown"
    if method == "acs_zone":
        if row is None:
            notes.append(f"{zone['id']}: no ACS demand row; vehicles use the synthetic distribution")
        else:
            return _vehicles_acs(str(zone["id"]), n, row, pooled_extra, rng, notes), "estimated"
    elif method != "distribution":
        raise SnapshotError(f"unknown vehicles method {method!r}")
    values = _apportion(veh.get("distribution") or {"1": 1.0}, n)
    rng.shuffle(values)
    if veh.get("match_zone_vehicles") and isinstance(zone.get("vehicles"), int):
        _nudge(values, int(zone["vehicles"]), rng, floor=1, up_min=1, down_min=1)
        if sum(values) != zone["vehicles"]:
            notes.append(f"{zone['id']}: zone vehicles {zone['vehicles']} not reachable without changing "
                         f"carless households; {sum(values)} used")
    return values, "synthetic"


class _Placer:
    """Synthetic points in a zone: given home points, else seeded road nodes inside it plus jitter."""

    def __init__(self, nodes: Sequence[LonLat], jitter_m: float) -> None:
        self.nodes = nodes
        self.jitter_m = jitter_m

    def place(self, zone_id: str, geometry_json: Mapping[str, Any], n: int, seed: str,
              given: Sequence[LonLat] | None) -> tuple[list[LonLat], str]:
        if given is not None and len(given) == n:
            return [(round(p[0], 6), round(p[1], 6)) for p in given], "dispatch_area_homes"
        geometry = to_multipolygon(geometry_json)
        w, s, e, nn = _bbox(geometry)
        inside = [p for p in self.nodes if w <= p[0] <= e and s <= p[1] <= nn and point_in_multipolygon(p, geometry)]
        rng = random.Random(f"{seed}|{zone_id}|positions")
        if not inside:
            inside = [centroid(geometry)]
        kx = M_PER_DEG_LAT * math.cos(math.radians((s + nn) / 2))
        out = []
        for _ in range(n):
            lon, lat = inside[rng.randrange(len(inside))]
            r = self.jitter_m * math.sqrt(rng.random())
            a = rng.random() * 2 * math.pi
            out.append((round(lon + r * math.cos(a) / kx, 6), round(lat + r * math.sin(a) / M_PER_DEG_LAT, 6)))
        return out, "zone_road_nodes"


# --- stations and engines -------------------------------------------------------------------


def _engines(incident_id: str, stations: list[dict[str, Any]], cfg: Mapping[str, Any]) -> list[dict[str, Any]]:
    ecfg = cfg.get("engines") or {}
    shares = ecfg.get("status_shares") or {}
    committed, oos = float(shares.get("committed", 0.0)), float(shares.get("out_of_service", 0.0))
    guarantee = ecfg.get("guarantee") or {}
    out = []
    for st in stations:
        rule = ecfg.get("state_station" if st["class"] == "state" else "local_station") or {}
        kinds = list(rule.get("kinds") or ["type3_engine"])
        lo, hi = int(rule.get("min", 1)), int(rule.get("max", 1))
        if not (1 <= lo <= hi) or any(k not in ENGINE_KINDS for k in kinds):
            raise SnapshotError("engine rule needs 1 <= min <= max and kinds from " + ", ".join(ENGINE_KINDS))
        count = lo + int(_sha(incident_id, st["station_id"], "count")[:8], 16) % (hi - lo + 1)
        engines = []
        for k in range(count):
            eid = f"{st['station_id']}-E{k + 1}"
            u = _unit(incident_id, eid, "status")
            status = "committed" if u < committed else "out_of_service" if u < committed + oos else "available"
            engines.append({"engine_id": eid, "kind": kinds[min(k, len(kinds) - 1)], "status_at_start": status,
                            "basis": "synthetic"})
        out.append({**st, "engines": engines})

    def add_engine(st: dict[str, Any], status: str) -> None:
        rule = ecfg.get("state_station" if st["class"] == "state" else "local_station") or {}
        kinds = list(rule.get("kinds") or ["type3_engine"])
        k = len(st["engines"])
        st["engines"].append({"engine_id": f"{st['station_id']}-E{k + 1}", "kind": kinds[min(k, len(kinds) - 1)],
                              "status_at_start": status, "basis": "synthetic"})

    if len(out) >= 2:
        want_zero = int(guarantee.get("zero_available_stations", 0))
        zeros = [s for s in out if not any(e["status_at_start"] == "available" for e in s["engines"])]
        for st in sorted((s for s in out if s not in zeros), key=lambda s: _sha(incident_id, s["station_id"], "zero")):
            if len(zeros) >= min(want_zero, len(out) - 1):
                break
            for e in st["engines"]:
                if e["status_at_start"] == "available":
                    e["status_at_start"] = "committed"
            zeros.append(st)
        want_multi = int(guarantee.get("multi_engine_stations", 0))
        multi = [s for s in out if len(s["engines"]) >= 2]
        for st in sorted((s for s in out if s not in multi),
                         key=lambda s: (s in zeros, _sha(incident_id, s["station_id"], "multi"))):
            if len(multi) >= min(want_multi, len(out)):
                break
            add_engine(st, "committed" if st in zeros else "available")
            multi.append(st)
        want_available = int(guarantee.get("min_available_engines", 0))
        pool = sorted(((s, e) for s in out if s not in zeros for e in s["engines"]
                       if e["status_at_start"] != "available"),
                      key=lambda se: _sha(incident_id, se[1]["engine_id"], "available"))
        while sum(e["status_at_start"] == "available" for s in out for e in s["engines"]) < want_available and pool:
            pool.pop(0)[1]["status_at_start"] = "available"
    for st in out:
        st["engines_total"] = len(st["engines"])
        st["engines_available"] = sum(e["status_at_start"] == "available" for e in st["engines"])
    return out


# --- build ----------------------------------------------------------------------------------


def _sources(bundle: Mapping[str, Any], stations: Sequence[Mapping[str, Any]], acs: bool) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if _is_package(bundle):
        area = (bundle["drill_package"].get("dispatch_area") or {})
        attribution = (((area.get("sources") or {}).get("osm") or {}).get("attribution")
                       or "© OpenStreetMap contributors, ODbL")
        out.append({"id": "osm", "name": f"OpenStreetMap fire stations and roads in drill package "
                    f"{bundle['drill_package'].get('package_id')} ({attribution})",
                    "url": "https://www.openstreetmap.org/copyright", "license": "ODbL 1.0"})
        out.append({"id": "dispatch-area-homes", "name": "Synthetic homes and zones of the dispatch area "
                    f"{area.get('id')} (builder {area.get('builder')}, {area.get('generated_at')})",
                    "url": None, "license": None})
    else:
        out.append({"id": "camp-2018-replay-bundle", "name": "Camp 2018 replay bundle zones (2018 census block groups)",
                    "url": None, "license": None})
    if acs:
        locator = next((r.get("source_locator") for r in _demand_rows(bundle).values() if r.get("source_locator")),
                       None)
        out.append({"id": "acs-5yr-block-groups", "name": "U.S. Census Bureau, American Community Survey 5-Year "
                    f"Estimates (B25044, B01001) per block group, via the bundle demand table ({locator or 'ACS'})",
                    "url": "https://www.census.gov/programs-surveys/acs",
                    "license": "Public domain (US Government work, 17 USC 105)"})
    for sid in sorted({s["source_id"] for s in stations if s.get("source_id") and s["source_id"] != "osm"}):
        loc = next(s["locator"] for s in stations if s.get("source_id") == sid)
        name = ("NIST TN 2252 supplement, Appendix I (temporary refuge areas at fire stations)"
                if sid == "nist-nettra-supplement" else sid)
        out.append({"id": sid, "name": name, "url": (loc or "").split(" ")[0] or None,
                    "license": "US Government work" if sid.startswith("nist") else None})
    out.append({"id": "snapshot-assumptions", "name": "CrisisTwin snapshot assumptions (tools/snapshot_assumptions.json)",
                "url": None, "license": None})
    return out


def _sum_or_none(values: Iterable[int | None]) -> int | None:
    values = list(values)
    return None if any(v is None for v in values) else sum(values)  # type: ignore[arg-type]


def build_snapshot(incident_id: str, bundle: Mapping[str, Any], cfg: Mapping[str, Any], *,
                   home_points: Mapping[str, Sequence[LonLat]] | None = None) -> dict[str, Any]:
    """Build the snapshot of one drill. Returns ``{snapshot, households, stations}``.

    ``cfg`` is ``effective_config(config, incident_id)``. ``home_points`` maps zone id to the
    package's synthetic home points (the dispatch area ``homes`` of that zone, in its order);
    a zone whose point count differs from its households falls back to road-node placement.
    ``snapshot`` has no ``snapshot_id`` or ``created_at`` (the store adds both)."""
    seed = f"{BUILDER}|{incident_id}"
    zones = list((bundle.get("zones") or {}).get("features") or [])
    if not zones:
        raise SnapshotError("the drill has no zones")
    rows = _demand_rows(bundle)
    pooled = _pooled_extra(rows.values())
    cap = int((cfg.get("evacuating_vehicles") or {}).get("cap_per_household", 2))
    if cap < 1:
        raise SnapshotError("evacuating_vehicles.cap_per_household must be at least 1")
    placer = _Placer(_road_nodes(bundle), float((cfg.get("positions") or {}).get("jitter_m", 25)))
    notes: list[str] = []
    households: list[dict[str, Any]] = []
    zone_rows: list[dict[str, Any]] = []
    placements: dict[str, int] = {}
    bases: dict[str, set[str]] = {"occupants": set(), "vehicles": set()}
    for zone in zones:
        zid = str(zone["id"])
        n = int(zone.get("households") or 0)
        if n < 0:
            raise SnapshotError(f"{zid}: negative households")
        row = rows.get(zid)
        occupants, occ_basis = _occupants(zid, n, row, cfg, seed, notes)
        vehicles, veh_basis = _vehicles(zone, n, row, cfg, seed, pooled, notes)
        bases["occupants"].add(occ_basis)
        bases["vehicles"].add(veh_basis)
        points, how = placer.place(zid, zone["geometry"], n, seed, (home_points or {}).get(zid))
        placements[how] = placements.get(how, 0) + 1
        zh = []
        for i in range(n):
            v = vehicles[i]
            ev = None if v is None else min(v, cap)
            zh.append({
                "household_id": household_id(incident_id, zid, i), "zone_id": zid,
                "location": {"type": "Point", "coordinates": [points[i][0], points[i][1]]},
                "occupants": {"value": occupants[i], "basis": occ_basis},
                "vehicles": {"value": v, "basis": veh_basis},
                "evacuating_vehicles": {"value": ev, "basis": veh_basis},
                "needs_transport": v == 0,
            })
        households.extend(zh)
        known = [h["occupants"]["value"] for h in zh if h["occupants"]["value"] is not None]
        zone_rows.append({
            "zone_id": zid, "name": str(zone.get("name") or zid), "households": n,
            "occupants": _sum_or_none(h["occupants"]["value"] for h in zh),
            "known_occupants": sum(known), "unknown_households": n - len(known),
            "vehicles": _sum_or_none(h["vehicles"]["value"] for h in zh),
            "evacuating_vehicles": sum(h["evacuating_vehicles"]["value"] or 0 for h in zh),
            "needs_transport_households": sum(h["needs_transport"] for h in zh),
            "needs_transport_occupants": sum(h["occupants"]["value"] or 0 for h in zh if h["needs_transport"]),
            "drill_vehicles": int(zone.get("vehicles") or 0),
        })
    ids = [h["household_id"] for h in households]
    if len(ids) != len(set(ids)):
        raise SnapshotError("household id collision")
    stations = _engines(incident_id, _stations(bundle, cfg), cfg)
    station_docs = [{
        "station_id": s["station_id"], "name": s["name"],
        "location": {"type": "Point", "coordinates": [round(s["coord"][0], 6), round(s["coord"][1], 6)]},
        "basis": s["basis"], "station_class": s["class"], "source_id": s.get("source_id"), "locator": s.get("locator"),
        "engines": s["engines"], "engines_total": s["engines_total"], "engines_available": s["engines_available"],
    } for s in stations]

    known_occ = [h["occupants"]["value"] for h in households if h["occupants"]["value"] is not None]
    totals = {
        "households": len(households),
        "occupants": _sum_or_none(h["occupants"]["value"] for h in households),
        "known_occupants": sum(known_occ),
        "unknown_occupant_households": len(households) - len(known_occ),
        "vehicles": _sum_or_none(h["vehicles"]["value"] for h in households),
        "unknown_vehicle_households": sum(h["vehicles"]["value"] is None for h in households),
        "evacuating_vehicles": sum(h["evacuating_vehicles"]["value"] or 0 for h in households),
        "no_vehicle_households": sum(h["vehicles"]["value"] == 0 for h in households),
        "needs_transport_households": sum(h["needs_transport"] for h in households),
        "needs_transport_occupants": sum(h["occupants"]["value"] or 0 for h in households if h["needs_transport"]),
        "stations": len(station_docs),
        "engines_total": sum(s["engines_total"] for s in station_docs),
        "engines_available": sum(s["engines_available"] for s in station_docs),
        "engines_committed": sum(e["status_at_start"] == "committed" for s in station_docs for e in s["engines"]),
        "engines_out_of_service": sum(e["status_at_start"] == "out_of_service"
                                      for s in station_docs for e in s["engines"]),
    }
    _check(households, zone_rows, station_docs, totals)
    content_hash = hashlib.sha256(json.dumps(
        {"h": households, "s": station_docs, "t": totals}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    label = (bundle.get("drill_package") or {}).get("label") or "Drill: 2018 Camp Fire replay. Not a real incident."
    snapshot = {
        "incident_id": incident_id,
        "scenario_time": scenario_time(bundle),
        "version": BUILDER,
        "label": f"{label} Resource snapshot: synthetic households and engines; see basis.",
        "sources": _sources(bundle, station_docs, "estimated" in bases["occupants"] | bases["vehicles"]),
        "assumptions": copy.deepcopy(dict(cfg)),
        "basis": {
            "occupants": sorted(bases["occupants"]), "vehicles": sorted(bases["vehicles"]),
            "household_positions": "synthetic", "station_locations": sorted({s["basis"] for s in station_docs}),
            "engines": "synthetic",
        },
        "placement": placements,
        "notes": notes,
        "totals": totals,
        "zones": zone_rows,
        "content_hash": content_hash,
    }
    return {"snapshot": snapshot, "households": households, "stations": station_docs}


def _check(households: Sequence[Mapping[str, Any]], zones: Sequence[Mapping[str, Any]],
           stations: Sequence[Mapping[str, Any]], totals: Mapping[str, Any]) -> None:
    """Invariants: non-negative counts, evacuating <= vehicles, totals = sums (zones and households)."""
    for h in households:
        for key in ("occupants", "vehicles", "evacuating_vehicles"):
            v = h[key]["value"]
            if h[key]["basis"] not in BASES or (v is not None and (not isinstance(v, int) or v < 0)):
                raise SnapshotError(f"{h['household_id']}: bad {key} {h[key]}")
            if (v is None) != (h[key]["basis"] == "unknown"):
                raise SnapshotError(f"{h['household_id']}: {key} null iff basis unknown")
        if h["vehicles"]["value"] is not None and h["evacuating_vehicles"]["value"] > h["vehicles"]["value"]:
            raise SnapshotError(f"{h['household_id']}: evacuating vehicles exceed vehicles")
    assert totals["households"] == sum(z["households"] for z in zones)
    assert totals["known_occupants"] == sum(z["known_occupants"] for z in zones)
    assert totals["unknown_occupant_households"] == sum(z["unknown_households"] for z in zones)
    assert totals["evacuating_vehicles"] == sum(z["evacuating_vehicles"] for z in zones)
    assert totals["needs_transport_households"] == sum(z["needs_transport_households"] for z in zones)
    assert totals["needs_transport_households"] == totals["no_vehicle_households"]
    if totals["occupants"] is not None:
        assert totals["occupants"] == totals["known_occupants"]
    if totals["vehicles"] is not None:
        assert totals["vehicles"] == sum(z["vehicles"] for z in zones)
        assert totals["evacuating_vehicles"] <= totals["vehicles"]
    assert totals["engines_total"] == sum(len(s["engines"]) for s in stations)
    assert totals["engines_available"] == sum(
        e["status_at_start"] == "available" for s in stations for e in s["engines"])
    assert totals["engines_total"] == (totals["engines_available"] + totals["engines_committed"]
                                       + totals["engines_out_of_service"])
    for s in stations:
        assert s["engines_total"] == len(s["engines"]) >= 1
        assert 0 <= s["engines_available"] <= s["engines_total"]
        assert all(e["status_at_start"] in ENGINE_STATUSES and e["kind"] in ENGINE_KINDS for e in s["engines"])
