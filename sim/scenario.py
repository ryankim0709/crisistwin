"""Camp Fire scenarios on the observed 2018 roads and exits.

`camp_grounded_inputs` (packages with the population, zone, and shelter layers): Census block-group
demand and orders mapped to block groups through a derived crosswalk (see sim.demand).

`hybrid_scenario` / `camp_bundle_inputs` (road packages without those layers): demand zones are a
regular grid over the populated area, vehicles are allocated by mapped residential road length, and
orders are staggered by distance from the assumed ignition. All of these are `fixture`.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta

from pathlib import Path

from sim import traffic as traffic_engine
from sim.demand import ASSUMPTIONS as DEMAND_ASSUMPTIONS
from sim.demand import grounded_demand, tra_destinations
from sim.events import ASSUMPTIONS as ROAD_EVENT_ASSUMPTIONS
from sim.events import resolve_road_events
from sim.firefront import CAMP_IGNITION_AT, CAMP_IGNITION_LONLAT
from sim.network import load_alert_events, load_road_network
from sim.traffic import DemandZone, Destination, RoadNetwork, TrafficEvent

GROUNDED_LAYERS = ("population_units.geojson", "evacuation_zones.geojson", "shelters.geojson")

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


def has_grounded_layers(package: Path) -> bool:
    return all((package / "normalized" / name).exists() for name in GROUNDED_LAYERS)


def camp_grounded_inputs(package: Path) -> tuple[dict, datetime, datetime]:
    """Camp replay scenario with no fixture inputs: ACS block-group demand, NIST/CodeRED orders and
    warnings mapped to block groups by a derived crosswalk, historical alerts and road events, and
    NIST TRAs. Requires a layered package (`has_grounded_layers`); use camp_bundle_inputs otherwise.

    TRAs become `temporary_refuge` destinations only when the engine opens and closes destinations
    (sim.traffic.DESTINATION_OPEN_EVENT_TYPES); until then they are reported, not routed to.
    """
    network, exits, provenance = load_road_network(package)  # verifies every artifact hash
    if not has_grounded_layers(package):
        raise ValueError(f"{package} lacks {', '.join(GROUNDED_LAYERS)}; use camp_bundle_inputs")
    demand = grounded_demand(package, network)
    road_events, road_report = resolve_road_events(package, network, exits)
    tras, tra_events, tra_report = tra_destinations(package, network)
    tra_routing = "shelter_opened" in getattr(traffic_engine, "DESTINATION_OPEN_EVENT_TYPES", ())
    report = demand["report"]
    totals = report["totals"]
    xs = [b for z in demand["zones"] for b in _bbox_of(z.geometry)[0::2]]
    ys = [b for z in demand["zones"] for b in _bbox_of(z.geometry)[1::2]]
    clip = report["parameters"]["extract_bbox"]
    scenario = {
        "network": network,
        "zones": demand["zones"],
        "destinations": (*exits, *tras) if tra_routing else exits,
        "events": (*load_alert_events(package), *road_events, *demand["events"], *(tra_events if tra_routing else ())),
        "evidence_class": "derived",  # ACS counts are observed; vehicles and zone-to-BG links are derived
        "roads_evidence_class": "observed",
        "destinations_evidence_class": "mixed" if tra_routing else "derived",
        "bbox": [round(max(min(xs), clip[0]), 3), round(max(min(ys), clip[1]), 3),
                 round(min(max(xs), clip[2]), 3), round(min(max(ys), clip[3]), 3)],
        "notes": [
            *provenance["assumptions"],
            *DEMAND_ASSUMPTIONS,
            f"Demand: {totals['block_groups']} block groups, {totals['population']} residents and "
            f"{totals['households']} households (ACS 2014-2018, observed, clipped to the road extract); "
            f"{totals['evacuating_vehicles']} evacuating vehicles (derived, MOE about {totals['evacuating_vehicles_moe']}); "
            f"{totals['households_no_vehicle']} households have no vehicle and need assistance (not modelled).",
            f"Zones without a crosswalk key: {', '.join(report['unmapped_zones']) or 'none'}. "
            f"Block groups never ordered in the source events: {len(report['never_ordered'])}.",
            "Evacuation order and warning events labelled 'derived crosswalk' target block groups; the original "
            "zone-level NIST events stay on the timeline without zone targets.",
            *ROAD_EVENT_ASSUMPTIONS,
            ("NIST TRAs are temporary_refuge destinations, open only during their NIST active periods; capacity "
             "is unknown (unlimited in the model)." if tra_routing else
             "NIST TRAs are not destinations: the traffic engine cannot yet open and close destinations, so their "
             "formation and end appear on the timeline only."),
        ],
        "demand_report": report,
        "tra_report": tra_report,
        "road_event_report": road_report,
    }
    return scenario, CAMP_REPLAY_START, CAMP_REPLAY_END


def _bbox_of(geometry: dict) -> tuple[float, float, float, float]:
    polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    xs = [q[0] for poly in polygons for q in poly[0]]
    ys = [q[1] for poly in polygons for q in poly[0]]
    return min(xs), min(ys), max(xs), max(ys)


DEMAND_MODES = ("auto", "census", "fixture")


def camp_replay_inputs(roads_package: Path, demand: str = "auto") -> tuple[dict, datetime, datetime, bool]:
    """(scenario, start, end, grounded): the single replay baseline used by the CLI, variants and agents.

    census = ACS demand and NIST orders (camp_grounded_inputs); fixture = synthetic grid
    (camp_bundle_inputs); auto = census when the package has the grounded layers.
    """
    if demand not in DEMAND_MODES:
        raise ValueError(f"demand must be one of {DEMAND_MODES}")
    grounded = demand == "census" or (demand == "auto" and has_grounded_layers(roads_package))
    scenario, start, end = (camp_grounded_inputs if grounded else camp_bundle_inputs)(roads_package)
    return scenario, start, end, grounded
