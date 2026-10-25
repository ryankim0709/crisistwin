"""People picture of the traffic twin: who is still home, driving out, queued, stuck or out.

The twin moves vehicles. This module turns its state (`Twin.vehicle_states`, per-zone counts and
arrivals) into estimated people, per zone, per road edge and per destination, so a map can show where
the population is and how it moves. Contract: docs/twin-api.md "People snapshot".

People per vehicle are derived per zone, not assumed globally:
- Camp (census demand): `inputs.scenario["demand_report"]` holds each block group's ACS 2014-2018
  population, households and households with no vehicle (observed, clipped to the road extract).
  Residents of carless households = carless households x the zone's mean household size (derived).
  Everyone else rides in their household's evacuating vehicles, so persons per vehicle =
  (population - carless residents) / evacuating vehicles (derived).
- A Studio package (synthetic homes, no census): residents = homes x `ASSUMED_PERSONS_PER_HOUSEHOLD`
  (assumption), carless residents are not modelled (0), persons per vehicle = residents / vehicles.

Residents the model never moves stay home: carless residents (`home_no_car`, they need a ride) and,
when the twin's vehicles are fewer than the census-derived vehicles (no road node in the block group,
or order compliance below 1), the residents of the missing vehicles (`staying`).

Conservation, per zone and in total: population = home + home_no_car + staying + driving + queued +
stuck + out (people), and vehicles: total = home + driving + queued + stuck + out. Both are checked.

Pure Python, no Django. Every output is simulated (a planning experiment, not observations).
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass

SCHEMA_VERSION = "0.1.0"
ASSUMED_PERSONS_PER_HOUSEHOLD = 2.41
"""Residents per home for a package without census data. Camp's ACS 2014-2018 block groups in the
road extract hold 48,088 residents in 19,913 households (camp-2018 bundle `demand.totals`), 2.41 per
household; applying it elsewhere is an assumption."""
CLUSTER_RADIUS_M = 800.0
"""Stuck road edges (or points) of the same reason within this distance form one stuck cluster."""
MAX_CLUSTERS = 40
REASONS = ("long_queue", "road_closed", "fire", "no_route", "turned_back")
REASON_TEXT = {
    "long_queue": "in traffic 15+ min",
    "road_closed": "road closed ahead",
    "fire": "cut off by fire",
    "no_route": "no open way out",
    "turned_back": "turned back",
}
EDGE_FIELDS = ("edge_index", "moving", "queued", "stuck", "reason", "veh", "speed_kph", "max_wait_min")
"""`edges.rows` columns: people moving, queued (< 15 min) and stuck on the edge, the stuck reason (or null),
vehicles, mean speed (km/h) and the longest wait past free-flow time (min)."""
STATES = ("home", "home_no_car", "staying", "driving", "queued", "stuck", "out")
VEHICLE_STATES = ("home", "driving", "queued", "stuck", "out")
LIMITATIONS = [
    "Estimated people: the traffic twin's vehicles times persons per vehicle derived from census counts; "
    "not observed positions. Phones (app users) are shown separately.",
    "Vehicles move in packets of up to 5; a dot or count on a road is a share of a packet, not a person.",
    "Carless residents stay home in the model (no pickup, bus or walking model).",
    "A long queue is one vehicle waiting 15+ simulated minutes past its free-flow time on one road edge.",
]


@dataclass(frozen=True)
class ZonePeople:
    zone_id: str
    population: float
    """Residents of the zone (ACS, observed; or homes x ASSUMED_PERSONS_PER_HOUSEHOLD)."""
    no_car: float
    """Residents of households with no vehicle (derived; 0 when unknown)."""
    per_vehicle: float
    """Residents per evacuating vehicle (derived)."""
    reference_vehicles: int
    """Vehicles the population is split over (census-derived; at least the twin's)."""
    basis: str
    """acs | assumed."""


def _ring_centroid(ring: list) -> tuple[float, float, float]:
    """(lon, lat, |area|) of a closed lon/lat ring, by the shoelace formula (degrees, for weighting only)."""
    a = cx = cy = 0.0
    for (x0, y0), (x1, y1) in zip(ring, ring[1:]):
        c = x0 * y1 - x1 * y0
        a += c
        cx += (x0 + x1) * c
        cy += (y0 + y1) * c
    if abs(a) < 1e-12:
        xs, ys = [p[0] for p in ring], [p[1] for p in ring]
        return sum(xs) / len(xs), sum(ys) / len(ys), 0.0
    return cx / (3 * a), cy / (3 * a), abs(a / 2)


def zone_anchor(geometry: dict) -> list[float]:
    """A display point for a zone: the centroid of its largest polygon's outer ring, `[lon, lat]`."""
    polys = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    best = max((_ring_centroid(p[0]) for p in polys if p and len(p[0]) > 2), key=lambda c: c[2], default=None)
    if best is None:
        return [0.0, 0.0]
    return [round(best[0], 5), round(best[1], 5)]


def zone_people(inputs) -> dict[str, ZonePeople]:
    """Per-zone residents and persons per vehicle for a `sim.twin.TwinInputs`; cached on the inputs."""
    cached = inputs.cache.get("zone_people")
    if cached is not None:
        return cached
    report = {z["zone_id"]: z for z in (inputs.scenario.get("demand_report") or {}).get("zones") or []}
    out: dict[str, ZonePeople] = {}
    for z in inputs.scenario["zones"]:
        stats = report.get(z.id)
        if stats is not None:
            population = float(stats.get("population_in_extract") or 0)
            households = float(stats.get("households_in_extract") or 0)
            carless_hh = float(stats.get("households_no_vehicle_in_extract") or 0)
            no_car = min(population, carless_hh * population / households) if households > 0 else 0.0
            reference = max(int(stats.get("evacuating_vehicles") or 0) + int(stats.get("vehicles_dropped_no_origin") or 0),
                            z.vehicles)
            basis = "acs"
        else:
            population = z.households * ASSUMED_PERSONS_PER_HOUSEHOLD
            no_car = 0.0
            reference = z.vehicles
            basis = "assumed"
        per_vehicle = (population - no_car) / reference if reference > 0 else 0.0
        out[z.id] = ZonePeople(z.id, population, no_car, per_vehicle, reference, basis)
    inputs.cache["zone_people"] = out
    return out


def _round_parts(parts: dict[str, float], total: int) -> dict[str, int]:
    """Integers that add up to `total`, each the floor of its part plus the largest remainders."""
    floors = {k: max(0, math.floor(v)) for k, v in parts.items()}
    left = total - sum(floors.values())
    order = sorted(parts, key=lambda k: (-(parts[k] - math.floor(parts[k])), k))
    for k in order[:max(0, left)]:
        floors[k] += 1
    return floors


def _people(x: float) -> int:
    """People shown for a nonzero share: at least 1."""
    return max(1, round(x)) if x > 0 else 0


def _metres(a: list[float], b: list[float]) -> float:
    kx = math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((a[0] - b[0]) * kx, a[1] - b[1]) * 111_320.0


def _clusters(items: list[dict]) -> list[dict]:
    """Stuck clusters: per reason, the item with the most people seeds a cluster that takes every other
    unassigned item of that reason within CLUSTER_RADIUS_M of the seed; repeat. Compact, local groups."""
    out = []
    for reason in REASONS:
        group = sorted((it for it in items if it["reason"] == reason),
                       key=lambda it: (-it["people"], it["coord"][0], it["coord"][1]))
        seen = [False] * len(group)
        for start in range(len(group)):
            if seen[start]:
                continue
            members = [j for j in range(start, len(group))
                       if not seen[j] and _metres(group[start]["coord"], group[j]["coord"]) <= CLUSTER_RADIUS_M]
            for j in members:
                seen[j] = True
            parts = [group[k] for k in members]
            people = sum(p["people"] for p in parts)
            veh = sum(p["veh"] for p in parts)
            if veh <= 0:
                continue
            names: dict[str, float] = {}
            for p in parts:
                if p["name"]:
                    names[p["name"]] = names.get(p["name"], 0.0) + p["people"]
            road = max(sorted(names), key=lambda n: names[n]) if names else None
            coord = [round(group[start]["coord"][0], 5), round(group[start]["coord"][1], 5)]  # on the worst road
            n = max(1, round(people))
            where = f" on {road}" if road else ""
            out.append({
                "reason": reason, "reason_text": REASON_TEXT[reason], "road": road, "people": n, "veh": veh,
                "coord": coord, "edge_indexes": sorted({p["edge_index"] for p in parts if p["edge_index"] is not None}),
                "longest_wait_min": round(max(p["wait_s"] for p in parts) / 60),
                "label": f"{n:,} stuck{where}: {REASON_TEXT[reason]}",
            })
    out.sort(key=lambda c: (-c["people"], c["reason"], c["coord"]))
    for k, c in enumerate(out):
        c["id"] = f"stuck-{k + 1}"
    return out


def people_snapshot(twin, *, edge_name: Callable[[int], str | None] | None = None,
                    long_queue_s: float | None = None) -> dict:
    """The people picture of `twin` (a `sim.twin.Twin`) at its `now`. `edge_name(edge_index)` names roads
    for stuck labels (default: the network edge name). Geometry beyond points is left to the caller."""
    from sim.twin import LONG_QUEUE_S

    long_queue_s = LONG_QUEUE_S if long_queue_s is None else long_queue_s
    e, s = twin.engine, twin.engine.s
    zp = zone_people(twin.inputs)
    states = twin.vehicle_states(long_queue_s)
    name_of = edge_name or (lambda i: s.edges[i].name if s.edges[i].name and not s.edges[i].name.startswith("unnamed ")
                            else None)
    zone_ix = s.zone_ix
    node_edges = _node_edges(twin)

    # Vehicles by zone and state (exact integers), people by zone and state (floats).
    nz = s.n_zones
    veh = {k: [0] * nz for k in VEHICLE_STATES}
    stuck_reason_veh = {r: [0] * nz for r in REASONS}
    for zi in range(nz):
        veh["home"][zi] = e.z_waiting[zi] + e.z_preparing[zi]
        veh["out"][zi] = e.z_arrived[zi]

    def ppv(zone_id: str) -> float:
        return zp[zone_id].per_vehicle

    edge_rows = []
    stuck_items = []
    for row in states["edges"]:
        i = row["edge_index"]
        moving = queued = stuck = 0.0
        stuck_veh = 0
        for z, c in row["moving_veh"].items():
            veh["driving"][zone_ix[z]] += c
            moving += c * ppv(z)
        reason = row["block"]
        for z, c in row["queued_veh"].items():
            if reason is None:
                veh["queued"][zone_ix[z]] += c
                queued += c * ppv(z)
            else:
                veh["stuck"][zone_ix[z]] += c
                stuck_reason_veh[reason][zone_ix[z]] += c
                stuck += c * ppv(z)
                stuck_veh += c
        for z, c in row["long_queue_veh"].items():
            veh["stuck"][zone_ix[z]] += c
            stuck_reason_veh["long_queue"][zone_ix[z]] += c
            stuck += c * ppv(z)
            stuck_veh += c
        reason = reason or ("long_queue" if row["long_queue_veh"] else None)
        edge_rows.append([i, _people(moving), _people(queued), _people(stuck), reason, row["veh"], row["speed_kph"],
                          round(row["max_wait_s"] / 60)])
        if stuck_veh:
            stuck_items.append({"reason": reason, "name": name_of(i), "coord": [s.e_mid[i][0], s.e_mid[i][1]],
                                "people": stuck, "veh": stuck_veh, "edge_index": i, "wait_s": row["max_wait_s"]})
    points = []
    for o in states["origins"]:
        people = sum(c * ppv(z) for z, c in o["veh"].items())
        n = sum(o["veh"].values())
        node = o["node_index"]
        near = next((name_of(j) for j in node_edges.get(node, ()) if name_of(j)), None)
        if o["block"]:
            for z, c in o["veh"].items():
                veh["stuck"][zone_ix[z]] += c
                stuck_reason_veh["no_route"][zone_ix[z]] += c
            stuck_items.append({"reason": "no_route", "name": near, "coord": o["coord"], "people": people, "veh": n,
                                "edge_index": None, "wait_s": 0})
            state = "stuck"
        else:
            for z, c in o["veh"].items():
                veh["queued"][zone_ix[z]] += c
            state = "queued"
        points.append({"coord": [round(o["coord"][0], 5), round(o["coord"][1], 5)], "people": max(1, round(people)),
                       "veh": n, "state": state, "reason": "no_route" if o["block"] else None,
                       "text": "waiting to get on the road" if not o["block"] else REASON_TEXT["no_route"]})
    for r in states["returning"]:
        people = sum(c * ppv(z) for z, c in r["veh"].items())
        n = sum(r["veh"].values())
        for z, c in r["veh"].items():
            veh["stuck"][zone_ix[z]] += c
            stuck_reason_veh["turned_back"][zone_ix[z]] += c
        near = next((name_of(j) for j in node_edges.get(r["node_index"], ()) if name_of(j)), None)
        stuck_items.append({"reason": "turned_back", "name": near, "coord": r["coord"], "people": people, "veh": n,
                            "edge_index": None, "wait_s": 0})
        points.append({"coord": [round(r["coord"][0], 5), round(r["coord"][1], 5)], "people": max(1, round(people)),
                       "veh": n, "state": "stuck", "reason": "turned_back", "text": REASON_TEXT["turned_back"]})

    # Zones: people per state, rounded so each zone adds up to its population.
    zones, tot_people = [], dict.fromkeys(STATES, 0.0)
    for zi, z in enumerate(s.zone_list):
        info = zp[z.id]
        k = info.per_vehicle
        parts = {
            "home": veh["home"][zi] * k, "home_no_car": info.no_car,
            "staying": max(0.0, info.population - info.no_car - z.vehicles * k),
            "driving": veh["driving"][zi] * k, "queued": veh["queued"][zi] * k,
            "stuck": veh["stuck"][zi] * k, "out": veh["out"][zi] * k,
        }
        vtotal = sum(veh[st][zi] for st in VEHICLE_STATES)
        if vtotal != z.vehicles or min(veh[st][zi] for st in VEHICLE_STATES) < 0:
            raise AssertionError(f"zone {z.id}: vehicles not conserved ({vtotal} != {z.vehicles})")
        if abs(sum(parts.values()) - info.population) > 1e-6 * max(1.0, info.population):
            raise AssertionError(f"zone {z.id}: people not conserved")
        for st in STATES:
            tot_people[st] += parts[st]
        rounded = _round_parts(parts, round(info.population))
        zones.append({"id": z.id, "name": z.name, "coord": zone_anchor(z.geometry), "population": round(info.population),
                      **rounded, "vehicles": z.vehicles, "persons_per_vehicle": round(k, 2), "basis": info.basis})

    population = sum(round(info.population) for info in zp.values())
    totals_people = _round_parts(tot_people, population)
    totals_veh = {st: sum(veh[st]) for st in VEHICLE_STATES}
    conserved = (sum(totals_veh.values()) == s.total_veh and sum(totals_people.values()) == population
                 and totals_veh["driving"] + totals_veh["queued"] + totals_veh["stuck"] == states["en_route_veh"])
    if not conserved:
        raise AssertionError(f"people snapshot not conserved at {twin.now}")
    stuck_people = {r: 0.0 for r in REASONS}
    for r in REASONS:
        for zi, z in enumerate(s.zone_list):
            stuck_people[r] += stuck_reason_veh[r][zi] * zp[z.id].per_vehicle

    # Destinations: arrivals in people at the overall people-per-arrived-vehicle ratio (per-destination
    # arrivals are not split by zone in the engine).
    out_ratio = tot_people["out"] / totals_veh["out"] if totals_veh["out"] else 0.0
    destinations = []
    for k, d in enumerate(s.dest_list):
        if not e.dest_arrived[k]:
            continue
        recent = sum(n for t, n in reversed(e.dest_series[k][-200:]) if t > (e.now_s or 0) - 600)
        destinations.append({"id": d.id, "name": d.name, "kind": d.kind, "coord": [round(d.coord[0], 5), round(d.coord[1], 5)],
                             "people": round(e.dest_arrived[k] * out_ratio), "veh": e.dest_arrived[k],
                             "last_10_min_people": round(recent * out_ratio)})
    destinations.sort(key=lambda d: (-d["veh"], d["id"]))

    acs = sum(1 for info in zp.values() if info.basis == "acs")
    mean_ppv = (population - tot_people["home_no_car"]) / max(1, sum(info.reference_vehicles for info in zp.values()))
    return {
        "schema_version": SCHEMA_VERSION,
        "evidence_class": "simulated",
        "now": twin.now,
        "long_queue_min": round(long_queue_s / 60),
        "totals": {"people": {"population": population, **totals_people},
                   "vehicles": {"total": s.total_veh, **totals_veh}, "conserved": conserved},
        "stuck_by_reason": {r: round(v) for r, v in stuck_people.items()},
        "zones": zones,
        "edges": {"fields": list(EDGE_FIELDS), "rows": edge_rows},
        "points": points,
        "stuck": _clusters(stuck_items)[:MAX_CLUSTERS],
        "destinations": destinations,
        "basis": {
            "population": ("ACS 2014-2018 block-group population, clipped to the road extract (observed)" if acs
                           else f"homes x {ASSUMED_PERSONS_PER_HOUSEHOLD} residents per home (assumption)"),
            "persons_per_vehicle": round(mean_ppv, 2),
            "persons_per_vehicle_basis": (
                "derived per zone: (population - residents of carless households) / evacuating vehicles; "
                "carless residents = ACS B25044 no-vehicle households x mean household size" if acs else
                "derived per zone: residents / package vehicles (carless residents not modelled)"),
            "zones_census": acs, "zones_assumed": len(zp) - acs,
        },
        "limitations": list(LIMITATIONS),
    }


def _node_edges(twin) -> dict[int, list[int]]:
    """Engine node index -> edges leaving or entering it (for a nearby road name); cached on the inputs."""
    cache = twin.inputs.cache.get("node_edges")
    if cache is None:
        s = twin.engine.s
        cache = {}
        for i, (a, b) in enumerate(zip(s.e_from, s.e_to)):
            cache.setdefault(a, []).append(i)
            cache.setdefault(b, []).append(i)
        twin.inputs.cache["node_edges"] = cache
    return cache
