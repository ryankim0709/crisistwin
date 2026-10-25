/**
 * The Studio evacuation as a people picture: the dispatch engine's state at one simulated
 * minute (households by state, groups on the road, loading queues, cut-off zones, arrivals at
 * exits) turned into the /live People snapshot shape (docs/twin-api.md "People snapshot",
 * live/people/types.ts), so the same map layer and summary strip draw it. Pure; no network.
 *
 * Households to people: each household carries its zone's vehicles per home (the dispatch
 * area's synthetic estimate) times PERSONS_PER_VEHICLE, or, with `zonePeople` (the /dispatch
 * page's scenario-snapshot households, population/households.ts), its zone's snapshot occupants
 * shared over the zone's homes. Every count is an estimate from the model, never an observation.
 *
 * States (each household is in exactly one, so people are conserved per zone and in total):
 * - home: not left yet (no order, or ordered and getting ready);
 * - staying: ordered, but chose not to leave (population/householdBehavior.ts);
 * - queued: left home, waiting under LONG_QUEUE_MINUTES at the zone's loading point for room on
 *   the road (the engine's only queue: once on the road a group drives at free-flow speed);
 * - driving: on a road edge toward an exit;
 * - stuck: waiting LONG_QUEUE_MINUTES or more to get onto the road (`long_queue`); its zone's
 *   route, or its own group's, cut off with no exit left (`no_route`); in a zone with no open
 *   exit when the order went out (`no_route`); or reached by the modelled fire before getting
 *   out (`fire`, the engine's "caught");
 * - out: reached an exit.
 */

import type { DispatchArea, LonLat } from "../dispatch/area";
import { groundMeters, roadLabel } from "../dispatch/area";
import { HomeStatus, type DispatchEngine } from "../dispatch/engine";
import { cssColor, exitColor } from "../dispatch/scene/DispatchOverlay";
import type { ZoneHouseholds } from "./households";
import type {
  PeopleCounts,
  PeopleEdgeRow,
  PeoplePoint,
  PeopleSnapshot,
  PeopleZone,
  StuckCluster,
  StuckReason,
} from "../live/people";

/**
 * ESTIMATE: people per evacuating vehicle. 1.38 is derived in docs/people-data.md "Behaviour
 * evidence" (Camp household size 2.37 over 1.72 vehicles per household: Grajdura 2022 Table 1,
 * Wong et al. 2020 Table 10); NIST TN 2252 (p. 155) bounds it between 1.0 and 2.5. No survey
 * measures it directly.
 */
export const PERSONS_PER_VEHICLE = 1.38;
/** Waiting this long to get onto the road counts as stuck (the /live picture's threshold). */
export const LONG_QUEUE_MINUTES = 15;
/** Stuck items of one reason within this distance form one labelled cluster, metres. */
const CLUSTER_METERS = 800;
const MAX_CLUSTERS = 40;
const MAX_EDGE_ROWS = 1500;
const ARRIVAL_WINDOW_MINUTES = 10;

const REASON_TEXT: Record<StuckReason, string> = {
  long_queue: "in traffic 15+ min",
  road_closed: "road closed ahead",
  fire: "reached by fire before getting out",
  no_route: "no open way out",
  turned_back: "turned back",
};

export interface StudioPeopleOptions {
  /** Zones the policy found no exit for when the order went out. */
  cutOff: ReadonlySet<number>;
  /** Wall-clock time of T+0, epoch ms. */
  startMs: number;
  /** Simulated seconds per wall second while playing; 0 when paused. */
  playbackSpeed: number;
  /** `basis.people_behavior`: the household behaviour applied. */
  behavior: string;
  /**
   * Snapshot occupants per zone (estimated). Zones it matched count these people; other zones
   * keep vehicles per home × PERSONS_PER_VEHICLE.
   */
  zonePeople?: ZoneHouseholds | null;
}

type Counts = Record<keyof PeopleCounts, number>;
const zeroCounts = (): Counts => ({
  home: 0,
  home_no_car: 0,
  staying: 0,
  driving: 0,
  queued: 0,
  stuck: 0,
  out: 0,
});
const KEYS = Object.keys(zeroCounts()) as (keyof PeopleCounts)[];

/** Round values so they sum to the rounded total (largest remainder). */
function roundToTotal<K extends string>(values: Record<K, number>, keys: readonly K[]): Record<K, number> {
  const total = Math.round(keys.reduce((sum, key) => sum + values[key], 0));
  const out = {} as Record<K, number>;
  let assigned = 0;
  const remainders: { key: K; rest: number }[] = [];
  for (const key of keys) {
    const floor = Math.floor(values[key] + 1e-9);
    out[key] = floor;
    assigned += floor;
    remainders.push({ key, rest: values[key] - floor });
  }
  remainders.sort((a, b) => b.rest - a.rest);
  for (let i = 0; i < total - assigned && i < remainders.length; i += 1) out[remainders[i].key] += 1;
  return out;
}

/** A share shown on its own: rounded, but never 0 when there is someone. */
const shown = (people: number) => (people > 0 ? Math.max(1, Math.round(people)) : 0);

interface StuckItem {
  reason: StuckReason;
  coord: LonLat;
  people: number;
  vehicles: number;
  road: string | null;
  place: string;
  edges: number[];
  waitMinutes: number;
}

function clusters(items: StuckItem[]): StuckCluster[] {
  const sorted = [...items].filter((item) => item.people > 0).sort((a, b) => b.people - a.people);
  const used = new Set<StuckItem>();
  const out: StuckCluster[] = [];
  for (const seed of sorted) {
    if (used.has(seed) || out.length >= MAX_CLUSTERS) continue;
    const members = sorted.filter(
      (item) =>
        !used.has(item) &&
        item.reason === seed.reason &&
        groundMeters(item.coord, seed.coord) <= CLUSTER_METERS,
    );
    for (const item of members) used.add(item);
    const people = shown(members.reduce((sum, item) => sum + item.people, 0));
    const where = seed.road ? `on ${seed.road}` : `in ${seed.place}`;
    out.push({
      id: `stuck-${out.length + 1}`,
      reason: seed.reason,
      reason_text: REASON_TEXT[seed.reason],
      road: seed.road,
      people,
      veh: shown(members.reduce((sum, item) => sum + item.vehicles, 0)),
      coord: seed.coord,
      edge_indexes: [...new Set(members.flatMap((item) => item.edges))],
      longest_wait_min: Math.max(0, ...members.map((item) => item.waitMinutes)),
      label: `${people.toLocaleString("en-US")} stuck ${where}: ${REASON_TEXT[seed.reason]}`,
    });
  }
  return out;
}

/** The engine's state now, as a simulated people snapshot. */
export function studioPeopleSnapshot(
  engine: DispatchEngine,
  options: StudioPeopleOptions,
): PeopleSnapshot {
  const area: DispatchArea = engine.area;
  const minute = engine.minute;
  const zoneCounts: Counts[] = area.zones.map(() => zeroCounts());
  const zoneStuckByReason = area.zones.map(() => ({ fire: 0, no_route: 0 }));
  const snapshotPeople = options.zonePeople ?? null;
  const fromSnapshot = (z: number) => snapshotPeople !== null && snapshotPeople.matched[z] === true;
  const perHome = area.zones.map((zone, z) =>
    fromSnapshot(z)
      ? snapshotPeople!.people[z] / Math.max(1, zone.homes)
      : engine.vehiclesPerHome(z) * PERSONS_PER_VEHICLE,
  );
  /** Engine vehicles per person in each zone (the engine moves vehicles, not people). */
  const vehiclesPerPerson = area.zones.map((_, z) =>
    perHome[z] > 0 ? engine.vehiclesPerHome(z) / perHome[z] : 0,
  );
  const points: PeoplePoint[] = [];
  const stuckItems: StuckItem[] = [];
  const stuckByReason: Record<StuckReason, number> = {
    long_queue: 0,
    road_closed: 0,
    fire: 0,
    no_route: 0,
    turned_back: 0,
  };

  // Households at home, in loading queues, out, or caught: from each home's state.
  area.zones.forEach((zone, z) => {
    const state = engine.zones[z];
    const counts = zoneCounts[z];
    const pph = perHome[z];
    const cutOff = options.cutOff.has(z);
    let waiting = 0;
    let longWait = 0;
    let held = 0;
    let longest = 0;
    for (let h = zone.firstHome; h < zone.firstHome + zone.homes; h += 1) {
      const status = engine.homeStatus[h];
      if (status === HomeStatus.idle || status === HomeStatus.ordered) {
        if (cutOff) zoneStuckByReason[z].no_route += pph;
        else if (state.status !== "no_order" && engine.staysHome(h)) counts.staying += pph;
        else counts.home += pph;
      } else if (status === HomeStatus.queued) {
        const wait = minute - Math.max(0, engine.queuedSince(h));
        if (state.routeBlocked) held += pph;
        else if (wait >= LONG_QUEUE_MINUTES) {
          longWait += pph;
          longest = Math.max(longest, wait);
        } else waiting += pph;
      } else if (status === HomeStatus.safe) counts.out += pph;
      else if (status === HomeStatus.caught) zoneStuckByReason[z].fire += pph;
      // Driving households are counted from the groups on the road below.
    }
    const loading = area.nodes[zone.node];
    counts.queued += waiting;
    counts.stuck += longWait + held + zoneStuckByReason[z].fire + zoneStuckByReason[z].no_route;
    stuckByReason.long_queue += longWait;
    stuckByReason.no_route += held + zoneStuckByReason[z].no_route;
    stuckByReason.fire += zoneStuckByReason[z].fire;
    const vehicles = (people: number) => people * vehiclesPerPerson[z];
    if (waiting > 0)
      points.push({
        coord: loading,
        people: shown(waiting),
        veh: shown(vehicles(waiting)),
        state: "queued",
        reason: null,
        text: `waiting to get onto the road from ${zone.name}`,
      });
    if (longWait > 0) {
      points.push({
        coord: loading,
        people: shown(longWait),
        veh: shown(vehicles(longWait)),
        state: "stuck",
        reason: "long_queue",
        text: `waiting ${LONG_QUEUE_MINUTES}+ min to get onto the road from ${zone.name}`,
      });
      stuckItems.push({
        reason: "long_queue",
        coord: loading,
        people: longWait,
        vehicles: vehicles(longWait),
        road: null,
        place: zone.name,
        edges: [],
        waitMinutes: longest,
      });
    }
    if (held > 0) {
      points.push({
        coord: loading,
        people: shown(held),
        veh: shown(vehicles(held)),
        state: "stuck",
        reason: "no_route",
        text: `left home in ${zone.name}; every route out is cut off`,
      });
      stuckItems.push({
        reason: "no_route",
        coord: loading,
        people: held,
        vehicles: vehicles(held),
        road: null,
        place: zone.name,
        edges: [],
        waitMinutes: 0,
      });
    }
    for (const reason of ["no_route", "fire"] as const) {
      const people = zoneStuckByReason[z][reason];
      if (people > 0)
        stuckItems.push({
          reason,
          coord: zone.centroid,
          people,
          vehicles: vehicles(people),
          road: null,
          place: zone.name,
          edges: [],
          waitMinutes: 0,
        });
    }
  });

  // Groups on the road: moving along an edge, or held with no exit left.
  const edgeRows = new Map<
    string,
    { edge: number; forward: boolean; moving: number; stuck: number; vehicles: number }
  >();
  for (const packet of engine.packetStates()) {
    const people = packet.homes * perHome[packet.zone];
    const counts = zoneCounts[packet.zone];
    if (packet.stuck) {
      counts.stuck += people;
      stuckByReason.no_route += people;
    } else counts.driving += people;
    if (packet.edge === null) continue;
    const key = `${packet.edge}:${packet.forward ? 1 : 0}`;
    const row = edgeRows.get(key) ?? {
      edge: packet.edge,
      forward: packet.forward,
      moving: 0,
      stuck: 0,
      vehicles: 0,
    };
    if (packet.stuck) row.stuck += people;
    else row.moving += people;
    row.vehicles += packet.vehicles;
    edgeRows.set(key, row);
    if (packet.stuck) {
      const road = area.edges[packet.edge];
      stuckItems.push({
        reason: "no_route",
        coord: road.coords[Math.floor(road.coords.length / 2)],
        people,
        vehicles: packet.vehicles,
        road: roadLabel(road),
        place: area.zones[packet.zone].name,
        edges: [packet.edge],
        waitMinutes: 0,
      });
    }
  }
  const rows: PeopleEdgeRow[] = [...edgeRows.values()]
    .sort((a, b) => b.moving + b.stuck - (a.moving + a.stuck))
    .slice(0, MAX_EDGE_ROWS)
    .sort((a, b) => a.edge - b.edge)
    .map((row) => {
      const road = area.edges[row.edge];
      const line = row.forward ? road.coords : [...road.coords].reverse();
      return [
        row.edge,
        shown(row.moving),
        0,
        shown(row.stuck),
        row.stuck > 0 ? "no_route" : null,
        shown(row.vehicles),
        row.moving > 0 ? road.speedKph : 0,
        0,
        road.speedKph,
        Math.round(road.lengthMeters),
        line,
      ];
    });

  // Arrivals per exit.
  const arrivals = new Map<string, { people: number; recent: number; vehicles: number }>();
  for (const arrival of engine.exitArrivals) {
    const entry = arrivals.get(arrival.exitId) ?? { people: 0, recent: 0, vehicles: 0 };
    const people = arrival.homes * perHome[arrival.zone];
    entry.people += people;
    entry.vehicles += arrival.homes * engine.vehiclesPerHome(arrival.zone);
    if (arrival.minute > minute - ARRIVAL_WINDOW_MINUTES) entry.recent += people;
    arrivals.set(arrival.exitId, entry);
  }
  const heading = new Map<string, number>();
  engine.zones.forEach((state, z) => {
    if (!state.exitId || state.status === "cleared") return;
    const homes = state.atHome + state.queued + state.onRoad;
    heading.set(state.exitId, (heading.get(state.exitId) ?? 0) + homes * perHome[z]);
  });
  const destinations = area.exits.map((exit) => {
    const entry = arrivals.get(exit.id) ?? { people: 0, recent: 0, vehicles: 0 };
    return {
      id: exit.id,
      name: exit.name,
      kind: "exit",
      coord: area.nodes[exit.node],
      people: Math.round(entry.people),
      veh: Math.round(entry.vehicles),
      last_10_min_people: Math.round(entry.recent),
      heading_people: Math.round(heading.get(exit.id) ?? 0),
      color: cssColor(exitColor(area, exit.id)),
    };
  });

  const zones: PeopleZone[] = area.zones.map((zone, z) => {
    const rounded = roundToTotal(zoneCounts[z], KEYS);
    return {
      id: zone.id,
      name: zone.name,
      coord: zone.centroid,
      population: KEYS.reduce((sum, key) => sum + rounded[key], 0),
      vehicles: Math.round(zone.vehicles),
      persons_per_vehicle: fromSnapshot(z)
        ? Math.round((perHome[z] / Math.max(1e-9, engine.vehiclesPerHome(z))) * 100) / 100
        : PERSONS_PER_VEHICLE,
      basis: fromSnapshot(z) ? "estimated" : "assumed",
      ...rounded,
    };
  });

  const totalFloat = zeroCounts();
  for (const counts of zoneCounts) for (const key of KEYS) totalFloat[key] += counts[key];
  const people = roundToTotal(totalFloat, KEYS);
  const population = KEYS.reduce((sum, key) => sum + people[key], 0);
  const vehicleFloat = { home: 0, driving: 0, queued: 0, stuck: 0, out: 0 };
  zoneCounts.forEach((counts, z) => {
    const v = vehiclesPerPerson[z];
    vehicleFloat.home += (counts.home + counts.staying) * v;
    vehicleFloat.driving += counts.driving * v;
    vehicleFloat.queued += counts.queued * v;
    vehicleFloat.stuck += counts.stuck * v;
    vehicleFloat.out += counts.out * v;
  });
  const snapshotZones = area.zones.filter((_, z) => fromSnapshot(z)).length;
  const totalVehicles = area.zones.reduce((sum, zone) => sum + zone.vehicles, 0);
  const transport = snapshotPeople
    ? Math.round(snapshotPeople.needsTransport.reduce((sum, n) => sum + n, 0))
    : 0;
  const vehicleKeys = ["home", "driving", "queued", "stuck", "out"] as const;
  const vehicles = roundToTotal(vehicleFloat, vehicleKeys);
  const roundedReasons = roundToTotal(stuckByReason, Object.keys(stuckByReason) as StuckReason[]);
  const now = new Date(options.startMs + minute * 60_000).toISOString();

  return {
    kind: "crisistwin_live_people",
    schema_version: "0.1.0",
    incident_id: "studio",
    evidence_class: "simulated",
    label:
      "Simulated people picture of the Studio evacuation. Estimates from the model, not observations.",
    now,
    drill_replay_now: now,
    drill_speed: options.playbackSpeed,
    long_queue_min: LONG_QUEUE_MINUTES,
    totals: {
      people: { population, ...people },
      vehicles: {
        total: vehicleKeys.reduce((sum, key) => sum + vehicles[key], 0),
        ...vehicles,
      },
      conserved: true,
    },
    stuck_by_reason: roundedReasons,
    zones,
    edges: {
      fields: [
        "edge_index",
        "moving",
        "queued",
        "stuck",
        "reason",
        "veh",
        "speed_kph",
        "max_wait_min",
        "free_flow_kph",
        "length_m",
        "line",
      ],
      rows,
    },
    edges_omitted: { edges: Math.max(0, edgeRows.size - MAX_EDGE_ROWS), people: 0 },
    points,
    stuck: clusters(stuckItems),
    destinations,
    basis: snapshotPeople
      ? {
          population: `estimated occupants of ${Math.round(snapshotPeople.matchedHouseholds).toLocaleString("en-US")} scenario-snapshot households (${snapshotPeople.incidents.join(", ")}) in ${snapshotZones} of ${area.zones.length} zones, moved with the synthetic homes nearest them${snapshotZones < area.zones.length ? "; other zones: synthetic homes × 1.38 per vehicle" : ""}`,
          persons_per_vehicle:
            totalVehicles > 0 ? Math.round((population / totalVehicles) * 100) / 100 : PERSONS_PER_VEHICLE,
          persons_per_vehicle_basis:
            "people from the snapshot's estimated occupants per zone over the engine's vehicles",
          persons_per_vehicle_check: "occupants are estimates (scenario resource snapshot)",
          zones_census: snapshotZones,
          zones_assumed: area.zones.length - snapshotZones,
          people_behavior: options.behavior,
        }
      : {
          population: "synthetic homes on OSM residential streets",
          persons_per_vehicle: PERSONS_PER_VEHICLE,
          persons_per_vehicle_basis:
            "estimate: 1.38 derived from Camp household size over vehicles per household (docs/people-data.md)",
          persons_per_vehicle_check: "within NIST TN 2252 bounds of 1.0 to 2.5 (p. 155)",
          zones_census: 0,
          zones_assumed: area.zones.length,
          people_behavior: options.behavior,
        },
    limitations: snapshotPeople
      ? [
          "Occupants are the scenario snapshot's estimates; homes, zones and vehicles moving them are synthetic.",
          "Once on the road a group drives at free-flow speed: only the wait to get onto the road is modelled as traffic.",
          `${transport.toLocaleString("en-US")} people in households that need transport move with their zone; transport is not modelled.`,
          ...(snapshotPeople.unmatchedHouseholds > 0
            ? [
                `${Math.round(snapshotPeople.unmatchedHouseholds).toLocaleString("en-US")} snapshot households lie farther than 400 m from any modelled home and are not counted.`,
              ]
            : []),
        ]
      : [
          "Homes, zones and vehicles are synthetic; people = vehicles x 1.38 (an estimate).",
          "Once on the road a group drives at free-flow speed: only the wait to get onto the road is modelled as traffic.",
          "Households without a car are not modelled.",
        ],
  };
}
