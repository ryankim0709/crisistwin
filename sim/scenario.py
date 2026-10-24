"""Hybrid scenario: observed 2018 roads and exits with fixture demand and orders.

Evacuation zones, population, and order events are still being acquired. Until they
are, demand zones are a regular grid over the populated area, vehicles are allocated
by mapped residential road length, and orders are staggered by distance from the
assumed ignition. All of these are `fixture` and must be replaced, not tuned.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta

from pathlib import Path

from sim.events import ASSUMPTIONS as ROAD_EVENT_ASSUMPTIONS
from sim.events import resolve_road_events
from sim.firefront import CAMP_IGNITION_AT, CAMP_IGNITION_LONLAT
from sim.network import load_alert_events, load_road_network
from sim.traffic import DemandZone, Destination, RoadNetwork, TrafficEvent

# Populated ridge: Paradise, Magalia, and Concow (approximate, lon/lat).
FIXTURE_DEMAND_BBOX = (-121.66, 39.72, -121.50, 39.85)
FIXTURE_ZONE_SIZE_M = 2000
FIXTURE_TOTAL_VEHICLES = 15_000  # round synthetic total, not a census figure
FIXTURE_VEH_PER_HOUSEHOLD = 1.6
FIXTURE_MIN_RESIDENTIAL_M = 1500  # skip grid cells with little mapped housing
# First wave at the first CodeRED order in NIST TN 2252 sup. Table D-1 (Pulga, 07:13 PST);
# later waves are synthetic spacing, not the historical per-zone order times.
FIXTURE_FIRST_ORDER_AT = datetime.fromisoformat("2018-11-08T15:13:00+00:00")
FIXTURE_ORDER_SPACING = timedelta(minutes=8)
M_PER_DEG_LAT = 111_195.0
CAMP_REPLAY_START = datetime.fromisoformat("2018-11-08T14:00:00+00:00")
CAMP_REPLAY_END = datetime.fromisoformat("2018-11-09T08:00:00+00:00")


def hybrid_scenario(network: RoadNetwork, exits: tuple[Destination, ...], road_assumptions: list[str]) -> dict:
    min_lon, min_lat, max_lon, max_lat = FIXTURE_DEMAND_BBOX
    m_per_deg_lon = M_PER_DEG_LAT * math.cos(math.radians((min_lat + max_lat) / 2))
    dlon, dlat = FIXTURE_ZONE_SIZE_M / m_per_deg_lon, FIXTURE_ZONE_SIZE_M / M_PER_DEG_LAT
    ncols = math.ceil((max_lon - min_lon) / dlon)
    nrows = math.ceil((max_lat - min_lat) / dlat)

    residential_m = [0.0] * (ncols * nrows)
    origins: list[set[str]] = [set() for _ in range(ncols * nrows)]
    for edge in network.edges:
        lon, lat = network.nodes[edge.from_node]
        col, row = math.floor((lon - min_lon) / dlon), math.floor((lat - min_lat) / dlat)
        if not (0 <= col < ncols and 0 <= row < nrows):
            continue
        cell = row * ncols + col
        origins[cell].add(edge.from_node)
        if edge.highway in ("residential", "living_street", "unclassified"):
            residential_m[cell] += edge.length_m / 2  # both directions are listed

    cells = [c for c in range(ncols * nrows) if residential_m[c] >= FIXTURE_MIN_RESIDENTIAL_M and origins[c]]
    total_m = sum(residential_m[c] for c in cells)
    ig_lon, ig_lat = CAMP_IGNITION_LONLAT

    def distance_to_ignition(cell: int) -> float:
        row, col = divmod(cell, ncols)
        lon, lat = min_lon + (col + 0.5) * dlon, min_lat + (row + 0.5) * dlat
        return math.hypot((lon - ig_lon) * m_per_deg_lon, (lat - ig_lat) * M_PER_DEG_LAT)

    zones, events = [], []
    allocated = 0
    ordered_cells = sorted(cells, key=distance_to_ignition)
    for rank, cell in enumerate(ordered_cells):
        row, col = divmod(cell, ncols)
        share = residential_m[cell] / total_m
        vehicles = (FIXTURE_TOTAL_VEHICLES - allocated if rank == len(ordered_cells) - 1
                    else round(FIXTURE_TOTAL_VEHICLES * share))
        allocated += vehicles
        w, s = min_lon + col * dlon, min_lat + row * dlat
        zone_id = f"fz{rank + 1}"
        zones.append(DemandZone(
            id=zone_id,
            name=f"Fixture zone {rank + 1}",
            households=round(vehicles / FIXTURE_VEH_PER_HOUSEHOLD),
            vehicles=vehicles,
            origin_nodes=tuple(sorted(origins[cell])),
            geometry={"type": "Polygon", "coordinates": [[[round(x, 6), round(y, 6)] for x, y in
                      ((w, s), (w + dlon, s), (w + dlon, s + dlat), (w, s + dlat), (w, s))]]},
        ))
        # Zones are ordered in waves of three, nearest to the assumed ignition first.
        events.append(TrafficEvent(
            id=f"fixture-order-{zone_id}",
            at=FIXTURE_FIRST_ORDER_AT + FIXTURE_ORDER_SPACING * (rank // 3),
            type="evacuation_order",
            label=f"Evacuation order (fixture): Fixture zone {rank + 1}",
            evidence_class="fixture",
            time_precision="minute",
            zone_ids=(zone_id,),
            source_id="fixture",
        ))
    events.insert(0, TrafficEvent(
        id="assumed-ignition", at=CAMP_IGNITION_AT, type="fire_ignition",
        label="Fire start near Pulga (assumed time and place)", evidence_class="fixture",
        time_precision="approximate", source_id="assumed",
    ))
    return {
        "network": network,
        "zones": tuple(zones),
        "destinations": exits,
        "events": tuple(events),
        "evidence_class": "fixture",  # demand, zones, and orders; roads keep their own class
        "roads_evidence_class": "observed",
        "destinations_evidence_class": "derived",  # exits are boundary crossings of the road extract
        "bbox": [-121.80, 39.62, -121.40, 39.92],
        "notes": [
            *road_assumptions,
            "Demand zones are a 2 km fixture grid; vehicles are a synthetic total of "
            f"{FIXTURE_TOTAL_VEHICLES} allocated by mapped residential road length.",
            "Evacuation orders are fixture times staggered by distance from the assumed ignition, starting at the "
            "first NIST-documented CodeRED order (15:13Z); per-zone times are not the 2018 orders. The historical "
            "CodeRED alerts appear as reconstructed timeline events but do not drive demand yet.",
        ],
    }


def camp_bundle_inputs(roads_package: Path) -> tuple[dict, datetime, datetime]:
    """The single baseline scenario and clock for the Camp replay; variants derive from it.

    Observed roads and exits, fixture demand and orders, historical alerts (timeline
    only), and NIST road events snapped onto edges (closures and contraflow).
    """
    network, exits, provenance = load_road_network(roads_package)
    scenario = hybrid_scenario(network, exits, provenance["assumptions"])
    road_events, _ = resolve_road_events(roads_package, network, exits)
    scenario["events"] = (*scenario["events"], *load_alert_events(roads_package), *road_events)
    if road_events:
        scenario["notes"] = [*scenario["notes"], *ROAD_EVENT_ASSUMPTIONS]
    return scenario, CAMP_REPLAY_START, CAMP_REPLAY_END
