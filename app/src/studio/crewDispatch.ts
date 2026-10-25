/**
 * Sending the Studio's ground resources to the fire: the fire is reported at a given minute;
 * each resource leaves its base after its turnout (or mobilisation) time and drives the board's
 * road graph to the road point it can reach nearest the fire, then walks in. Its arrival minute
 * is when it starts work in the firefighting model (studio/firefighting.ts,
 * studio/initialAttack.ts). See docs/adr/0023-studio-crew-dispatch.md and
 * docs/adr/0048-suppression-engine.md.
 *
 * Road access: every vehicle is routed on its own class's graph (studio/roadAccess.ts, rules
 * R01-R12 of docs/suppression-data.md), with the class's speed on each edge (heavy-apparatus
 * caps, grade and single-lane factors). Engines, tenders and chiefs park within
 * MAX_ROAD_GAP_METERS of the fire; hand crews and dozers park at the road point their class
 * reaches nearest the fire however far it is, and hike or walk in (response/reach.ts limits).
 * A line builder that cannot reach the edge in time (an engine with no road within
 * MAX_ROAD_GAP_METERS, a crew hike over HAND_CREW_MAX_HIKE_MINUTES, a dozer walk over
 * DOZER_MAX_WALK_MINUTES) holds its road as indirect line ("indirect: holding <road>") and is not
 * an arrival on the fire edge. Only a resource with no road route at all is "no access", with
 * the rule that stopped it on the route an unrestricted vehicle would take.
 *
 * Helitack: with a CAL FIRE helitack base (HB) in the facility layer, the crew flown from the
 * nearest one is reported (flight at the helicopter cruise assumption, landing
 * HELITACK_LZ_WALK_M from the fire). Reported only; it is not a line builder in the solver. Service roads and tracks are open to apparatus
 * but not to evacuation traffic.
 *
 * The Studio passes units already chosen from the facilities on the map (`DispatchUnit`,
 * studio/mapResources.ts); each drives from its own base and nothing below picks bases for it.
 *
 * Bases for bare kinds (older callers; ASSUMPTIONS, named below): engines, tenders and chief officers come from the board's
 * OSM fire stations, at most one unit of each kind per station; further units are mutual aid
 * from CAL FIRE-layer stations off the board (tools/ca_fire_bases.json via the bases endpoint),
 * driven at OFFBOARD_SPEED_KMH over the straight-line distance x OFFBOARD_CIRCUITY to the
 * board's nearest exit, then routed on the board. Hand crews come from the nearest conservation
 * camp or crew centre, dozers from the nearest CAL FIRE-owned station, both after the data's
 * mobilisation times. Without the bases file every unit falls back to the board's stations,
 * round-robin, which the result says. Closed roads are avoided.
 */

import { groundMeters, type DispatchArea, type LonLat } from "../dispatch/area";
import { APPROACH_SPEED_KPH, MAX_ROAD_GAP_METERS as ENGINE_MAX_ROAD_GAP_METERS } from "../dispatch/engine";
import { routeTo, shortestPathTree, type ShortestPathTree } from "../dispatch/routing";
import type { LandscapeGrid } from "../fire/landscape";
import {
  GROUND_APPARATUS,
  KMH_PER_KNOT,
  dataValue,
  vehicleFamily,
  type AccessClass,
  type GroundKind,
} from "./apparatus";
import type { CrewArrival } from "./firefighting";
import { RULE_TEXT, edgeAccessTable, type EdgeAccess, type RoadRule } from "./roadAccess";
import { CREW_TYPES, STATION_TYPES, type SuppressionBases } from "./suppressionBases";
import { DOZER_MAX_WALK_MINUTES, HAND_CREW_MAX_HIKE_MINUTES, formatDuration } from "../response/reach";
import { engineTurnoutMinutes } from "../response/fleet";

/** NFPA 1710 turnout time for fire calls: 80 s (data: response_times.turnout_s, unverified). */
export const TURNOUT_MINUTES = dataValue<number>("response_times.turnout_s") / 60;
/** Board stations tried, nearest first by straight line. */
const MAX_STATIONS = 12;
/** Board-edge entry nodes tried per off-board unit, nearest the unit's base first. */
const MAX_ENTRY_EXITS = 4;
/** ASSUMPTION (data: hand_crews.walking_pace_m_per_min): walking pace with tools, 50 m/min. */
export const HIKE_METERS_PER_MINUTE = dataValue<number>("hand_crews.walking_pace_m_per_min");
/** A fire farther than this from any road a class can use is out of that class's reach. */
export const MAX_ROAD_GAP_METERS = ENGINE_MAX_ROAD_GAP_METERS;
/**
 * ASSUMPTION: road distance over straight-line distance for off-board travel. Of the order of
 * published road circuity factors (about 1.2 for the US in Ballou et al. 2002; not re-checked);
 * mountain roads are worse.
 */
export const OFFBOARD_CIRCUITY = 1.3;
/** ASSUMPTION (data: heavy-apparatus cap for secondary roads): off-board travel speed, km/h. */
export const OFFBOARD_SPEED_KMH = dataValue<Record<string, number>>(
  "road_access.heavy_apparatus_speed_kmh_by_highway",
).secondary;
/** ASSUMPTION (data leaf helicopters.cruise_speed_typical_kt): helicopter cruise, knots. */
export const HELI_CRUISE_KT = dataValue<number>("helicopters.cruise_speed_typical_kt");
/** ASSUMPTION (data leaf response_times.helicopter_call_to_takeoff_min): call to takeoff, minutes. */
export const HELI_TAKEOFF_MIN = dataValue<number>("response_times.helicopter_call_to_takeoff_min");
/**
 * ASSUMPTION (labelled; no landing-zone layer): a helitack crew lands this far from the fire and
 * walks in. A Type 2 helicopter carries 9-14 passengers (NWCG PMS 200 helicopter typing,
 * data leaf helicopters.type2.passenger_seats); the crew size is not modelled.
 */
export const HELITACK_LZ_WALK_M = 500;

/** ASSUMPTION: at most this many units of one kind from one board station. */
export const UNITS_PER_KIND_PER_STATION = 1;

export type TripOrigin = "station" | "mutual_aid" | "crew_camp" | "dozer_base" | "fallback" | "state";

/**
 * One unit already chosen from the facilities on the map (studio/mapResources.ts): it drives from
 * its own base. Units are a pure function of the map, so the planner only routes them.
 */
export interface DispatchUnit {
  kind: GroundKind;
  baseName: string;
  location: LonLat;
  origin: TripOrigin;
  /** Report to rolling: turnout by staffing, or the kind's mobilisation time. */
  turnoutMinutes: number;
  /** Further minutes before it reaches its starting point (a state order's lead time), else 0. */
  leadMinutes: number;
}

export interface CrewTrip {
  kind: GroundKind;
  /** e.g. "T3 engine 2". */
  label: string;
  stationName: string;
  origin: TripOrigin;
  departMinute: number;
  /** Minute the vehicle stops at its road point. */
  atRoadMinute: number;
  /** Minute the crew reaches the fire on foot and starts work. */
  arriveMinute: number;
  /** Where it parks, and the walk from there to the fire. */
  roadPoint: LonLat;
  hikeMeters: number;
  /** direct: works the fire edge; indirect: too far to reach the edge in time, holds its road. */
  tactic: "direct" | "indirect";
  /** indirect only: the road it holds ("Grizzly Peak Blvd"), or null when unnamed. */
  holdingRoad: string | null;
  /** Rule that kept it from a nearer road point, when one did. */
  stoppedShortBy: { rule: RoadRule; why: string; road: string | null } | null;
  /** Origin, then the road path to the road point (off-board legs are a straight line). */
  path: LonLat[];
  /** Minutes after departure at each path vertex (same length as `path`). */
  pathMinutes: number[];
}

export interface NoAccess {
  kind: GroundKind;
  label: string;
  rule: RoadRule | null;
  why: string;
  road: string | null;
}

export interface CrewDispatch {
  reportMinute: number;
  fire: LonLat;
  /** Nearest road point any trip parks at (used for crews joining the evacuation). */
  roadPoint: LonLat;
  /** Walk of the trip parked nearest the fire, ground metres and minutes. */
  hikeMeters: number;
  hikeMinutes: number;
  trips: CrewTrip[];
  noAccess: NoAccess[];
  /** Assumptions that decided this dispatch (fallbacks, unknown tags, off-board travel). */
  notes: string[];
  /** Helitack crew from the nearest helitack base (reported, not a line builder), or null. */
  helitack: HelitackPlan | null;
}

export interface HelitackPlan {
  baseName: string;
  baseKm: number;
  /** Minute the helicopter lands at its landing zone. */
  landMinute: number;
  walkMeters: number;
  /** Minute the crew reaches the fire on foot. */
  arriveMinute: number;
}

/** Start minute per line-building resource, for the firefighting model. */
export function arrivalsOf(dispatch: CrewDispatch): CrewArrival[] {
  return dispatch.trips
    .filter((trip) => GROUND_APPARATUS[trip.kind].line !== null && trip.tactic === "direct")
    .map((trip) => ({ kind: trip.kind, minute: trip.arriveMinute }));
}

interface Origin {
  name: string;
  origin: TripOrigin;
  /** Graph node it starts from, or null for an off-board base. */
  node: number | null;
  location: LonLat;
  approachMeters: number;
  /** Facilities-layer staffing (P/C/V) of an off-board base, when known: sets an engine's turnout. */
  staffing?: string | null;
}

interface Leg {
  origin: Origin;
  /** Minutes from departure to the road point. */
  minutes: number;
  node: number;
  hikeMeters: number;
  path: LonLat[];
  pathMinutes: number[];
}

const accessCache = new WeakMap<DispatchArea, { grid: LandscapeGrid | null; table: EdgeAccess[] }>();
const ALL_CLASSES: AccessClass[] = [
  "engine_t1_t2",
  "engine_t3",
  "engine_t4_t7",
  "tender_support",
  "tender_tactical",
];

/** Per-edge access for every class on this board (cached per area and grid). */
export function accessTableFor(area: DispatchArea, grid: LandscapeGrid | null): EdgeAccess[] {
  const hit = accessCache.get(area);
  if (hit && hit.grid === grid) return hit.table;
  const table = edgeAccessTable(area, grid, ALL_CLASSES);
  accessCache.set(area, { grid, table });
  return table;
}

/**
 * Plan every ground resource's trip, or explain why there is none. A `DispatchUnit` (the Studio:
 * units chosen from the facilities on the map, studio/mapResources.ts) drives from its own base;
 * a bare kind (older callers) gets a base by the rules above. `blocked` marks edges closed to
 * traffic (the Studio's road closures). `grid` gives road grades (null: 0% assumed, labelled).
 * `bases` are the off-board CAL FIRE-layer facilities, or null.
 */
export function planCrewDispatch(
  area: DispatchArea,
  fire: LonLat,
  reportMinute: number,
  resources: readonly (GroundKind | DispatchUnit)[],
  blocked: (edge: number) => boolean = () => false,
  grid: LandscapeGrid | null = null,
  bases: SuppressionBases | null = null,
): { dispatch: CrewDispatch | null; note: string | null } {
  if (resources.length === 0) return { dispatch: null, note: "No resources assigned." };
  // Outside the area's box the roads are unknown: snapping to its nearest node would stage units
  // at the box edge, kilometres from the fire (fire/useBoardStreets.ts picks the box).
  const box = area.bbox;
  if (fire[0] < box[0] || fire[0] > box[2] || fire[1] < box[1] || fire[1] > box[3]) {
    return { dispatch: null, note: "The fire is outside the modelled road area, so no units were routed to it." };
  }
  const kindsOnly = resources.some((r) => typeof r === "string");
  if (kindsOnly && area.stations.length === 0 && !bases?.available) {
    return { dispatch: null, note: "No fire stations on or near this board's roads." };
  }
  // Every road node (crews and dozers park however far from the fire); engines filter by gap.
  const near: { node: number; meters: number }[] = [];
  let nearest: { node: number; meters: number } | null = null;
  area.nodes.forEach((node, index) => {
    const meters = groundMeters(node, fire);
    near.push({ node: index, meters });
    if (!nearest || meters < nearest.meters) nearest = { node: index, meters };
  });
  if (near.length === 0 || !nearest) {
    return { dispatch: null, note: "The board has no roads to drive on." };
  }
  const fireNode = (nearest as { node: number; meters: number }).node;
  const notes: string[] = [];
  const access = accessTableFor(area, grid);
  const arcs = area.allOutgoing ?? area.outgoing;
  if (!grid) notes.push("No terrain board: every road grade assumed 0%.");
  const untagged = area.edges.filter((e) => !e.tags || Object.keys(e.tags).length === 0).length;
  if (untagged > 0) {
    notes.push(
      `${untagged} of ${area.edges.length} road edges carry no OSM surface or width tags; documented defaults by road class decide them.`,
    );
  }

  const speedSeconds = (cls: AccessClass) => (edge: number) => {
    const kmh = access[edge].byClass[cls].speedKmh ?? 1;
    return area.edges[edge].lengthMeters / (kmh / 3.6);
  };
  const trees = new Map<string, ShortestPathTree>();
  const treeFor = (cls: AccessClass, source: number) => {
    const key = `${cls}:${source}`;
    let tree = trees.get(key);
    if (!tree) {
      tree = shortestPathTree(
        area,
        source,
        (edge) => blocked(edge) || !access[edge].byClass[cls].passable,
        { arcs, seconds: speedSeconds(cls) },
      );
      trees.set(key, tree);
    }
    return tree;
  };

  /** Best road point for `cls` from `source`: drive minutes + walk minutes, smallest. */
  const legFrom = (cls: AccessClass, origin: Origin, source: number, offsetMinutes: number, lead: LonLat[], maxGap: number): Leg | null => {
    const tree = treeFor(cls, source);
    let best: { node: number; total: number; meters: number } | null = null;
    for (const { node, meters } of near) {
      if (meters > maxGap) continue;
      const seconds = tree.seconds[node];
      if (!Number.isFinite(seconds)) continue;
      const total = seconds / 60 + meters / HIKE_METERS_PER_MINUTE;
      if (!best || total < best.total || (total === best.total && node < best.node)) {
        best = { node, total, meters };
      }
    }
    if (!best) return null;
    const route = routeTo(area, tree, best.node);
    if (!route) return null;
    const path: LonLat[] = [...lead];
    const pathMinutes: number[] = lead.map(() => 0);
    let clock = offsetMinutes;
    path.push(area.nodes[source]);
    pathMinutes.push(clock);
    const seconds = speedSeconds(cls);
    for (const step of route.steps) {
      const edge = area.edges[step.edge];
      const line = step.forward ? edge.coords : [...edge.coords].reverse();
      const lengths = line.slice(1).map((point, i) => groundMeters(line[i], point));
      const total = lengths.reduce((a, b) => a + b, 0);
      const minutes = seconds(step.edge) / 60;
      lengths.forEach((length, i) => {
        clock += total > 0 ? (minutes * length) / total : minutes / lengths.length;
        path.push(line[i + 1]);
        pathMinutes.push(clock);
      });
    }
    return { origin, minutes: clock, node: best.node, hikeMeters: best.meters, path, pathMinutes };
  };

  const approachMinutesPerMeter = 1 / ((APPROACH_SPEED_KPH * 1000) / 60);
  const boardOrigins: Origin[] = [...area.stations]
    .sort((a, b) => groundMeters(a.location, fire) - groundMeters(b.location, fire) || a.id.localeCompare(b.id))
    .slice(0, MAX_STATIONS)
    .map((station) => ({
      name: station.name,
      origin: "station" as const,
      node: station.node,
      location: station.location,
      approachMeters: station.approachMeters,
    }));
  const legFromBoard = (cls: AccessClass, origin: Origin, maxGap: number): Leg | null => {
    const approach = origin.approachMeters * approachMinutesPerMeter;
    return legFrom(cls, origin, origin.node!, approach, [origin.location], maxGap);
  };

  const [west, south, east, north] = area.bbox;
  const inBox = (p: LonLat) => p[0] >= west && p[0] <= east && p[1] >= south && p[1] <= north;
  const nearestNode = (p: LonLat) => {
    let best = 0;
    let bestM = Infinity;
    area.nodes.forEach((n, i) => {
      const m = groundMeters(n, p);
      if (m < bestM) {
        bestM = m;
        best = i;
      }
    });
    return { node: best, meters: bestM };
  };
  // Entry points for off-board units: public nodes where a road leaves the box (evacuation
  // exits can be the outbound end of a one-way road, so the boundary nodes are used when known).
  const publicNode = new Uint8Array(area.nodes.length);
  for (const edge of area.edges) if (!edge.accessOnly) publicNode[edge.from] = publicNode[edge.to] = 1;
  const entryNodes = [
    ...new Set([
      ...(area.boundaryNodes ?? []).filter((node) => publicNode[node]),
      ...area.exits.map((exit) => exit.node),
    ]),
  ].sort((a, b) => a - b);
  const entryExits = entryNodes.map((node) => ({ node }));
  const entriesNear = (point: LonLat) =>
    [...entryExits]
      .sort((a, b) => groundMeters(area.nodes[a.node], point) - groundMeters(area.nodes[b.node], point) || a.node - b.node)
      .slice(0, MAX_ENTRY_EXITS);
  /** Off-board base: straight line x circuity at OFFBOARD_SPEED_KMH to an exit, then the board. */
  const legFromOffBoard = (cls: AccessClass, origin: Origin, maxGap: number): Leg | null => {
    if (inBox(origin.location)) {
      const snap = nearestNode(origin.location);
      return legFrom(cls, origin, snap.node, snap.meters * approachMinutesPerMeter, [origin.location], maxGap);
    }
    let best: Leg | null = null;
    for (const exit of entriesNear(origin.location)) {
      const km = groundMeters(origin.location, area.nodes[exit.node]) / 1000;
      const minutes = ((km * OFFBOARD_CIRCUITY) / OFFBOARD_SPEED_KMH) * 60;
      const leg = legFrom(cls, origin, exit.node, minutes, [origin.location], maxGap);
      if (leg && (!best || leg.minutes + leg.hikeMeters / HIKE_METERS_PER_MINUTE < best.minutes + best.hikeMeters / HIKE_METERS_PER_MINUTE)) {
        best = leg;
      }
    }
    return best;
  };

  // Off-board candidates from the bases file, nearest first.
  const external = bases?.available ? bases.bases : [];
  const nearBoardStation = (b: { lon: number; lat: number }) =>
    area.stations.some((s) => groundMeters(s.location, [b.lon, b.lat]) < 500);
  const offBoard = (filter: (type: string, agency: string) => boolean, origin: TripOrigin): Origin[] =>
    external
      .filter((b) => filter(b.type, b.agency) && !(origin === "mutual_aid" && nearBoardStation(b)))
      .sort((a, b) => a.distanceKm - b.distanceKm || a.id.localeCompare(b.id))
      .slice(0, 12)
      .map((b) => ({ name: b.name, origin, node: null, location: [b.lon, b.lat] as LonLat, approachMeters: 0, staffing: b.staffing ?? null }));
  const mutualAid = offBoard((type) => STATION_TYPES.has(type), "mutual_aid");
  const crewCamps = offBoard((type) => CREW_TYPES.has(type), "crew_camp");
  const dozerBases = offBoard(
    (type, agency) => STATION_TYPES.has(type) && agency.startsWith("CAL FIRE"),
    "dozer_base",
  );
  if (kindsOnly && !bases?.available) {
    notes.push(
      "No CAL FIRE base data (tools/ca_fire_bases.json is local-only): every unit comes from the board's OSM stations, round-robin, with no off-board mutual aid.",
    );
  }

  // Which rule keeps a class from the fire: walk the route an unrestricted vehicle would take
  // from the unit's starting node (a board station, or the board exit an off-board unit
  // enters by) to the fire's nearest road node; the first edge closed to the class decides.
  const firstOrigin = boardOrigins[0]?.node ?? entriesNear(fire)[0]?.node ?? null;
  const limitFor = new Map<string, { rule: RoadRule; why: string; road: string | null } | null>();
  const limitOf = (cls: AccessClass, source: number | null = firstOrigin) => {
    const key = `${cls}:${source}`;
    if (limitFor.has(key)) return limitFor.get(key)!;
    const openRoute =
      source !== null ? routeTo(area, shortestPathTree(area, source, blocked, { arcs }), fireNode) : null;
    let found: { rule: RoadRule; why: string; road: string | null } | null = null;
    for (const step of openRoute?.steps ?? []) {
      const result = access[step.edge].byClass[cls];
      if (!result.passable) {
        found = {
          rule: result.rule,
          why: result.notes[result.notes.length - 1] ?? RULE_TEXT[result.rule],
          road: area.edges[step.edge].name,
        };
        break;
      }
    }
    limitFor.set(key, found);
    return found;
  };
  /** Starting node of an origin: its own node, else the entry exit nearest to it. */
  const sourceOf = (origin: Origin): number | null => {
    if (origin.node !== null) return origin.node;
    if (inBox(origin.location)) return nearestNode(origin.location).node;
    let best: number | null = null;
    let bestKm = Infinity;
    for (const exit of entriesNear(origin.location)) {
      const km = groundMeters(origin.location, area.nodes[exit.node]);
      if (km < bestKm) {
        bestKm = km;
        best = exit.node;
      }
    }
    return best;
  };

  // Allocate units kind by kind: engines first, then tenders and chiefs, crews, dozers.
  const order = (kind: GroundKind) => {
    const k = GROUND_APPARATUS[kind];
    return k.base === "station" ? (k.line ? 0 : 1) : k.base === "crew_camp" ? 2 : 3;
  };
  const sorted = resources
    .map((r, index) => (typeof r === "string" ? { kind: r, unit: null, index } : { kind: r.kind, unit: r, index }))
    .sort((a, b) => order(a.kind) - order(b.kind) || a.index - b.index);
  const used = new Map<string, number>();
  const counts: Partial<Record<GroundKind, number>> = {};
  const trips: (CrewTrip | null)[] = new Array(resources.length).fill(null);
  const noAccess: NoAccess[] = [];
  const legCache = new Map<string, Leg | null>();
  const cachedLeg = (cls: AccessClass, origin: Origin, offBoardLeg: boolean, maxGap: number) => {
    const key = `${cls}|${maxGap}|${origin.origin}|${origin.name}|${origin.location.join(",")}`;
    if (!legCache.has(key)) {
      legCache.set(key, offBoardLeg ? legFromOffBoard(cls, origin, maxGap) : legFromBoard(cls, origin, maxGap));
    }
    return legCache.get(key) ?? null;
  };
  let fellBack = false;

  for (const { kind, unit, index } of sorted) {
    const spec = GROUND_APPARATUS[kind];
    const cls = spec.access;
    counts[kind] = (counts[kind] ?? 0) + 1;
    const label = `${spec.short} ${counts[kind]}`;
    const candidates: { origin: Origin; offBoard: boolean }[] = unit
      ? [{ origin: { name: unit.baseName, origin: unit.origin, node: null, location: unit.location, approachMeters: 0 }, offBoard: true }]
      : spec.base === "crew_camp" && crewCamps.length > 0
        ? crewCamps.map((origin) => ({ origin, offBoard: true }))
        : spec.base === "dozer_base" && dozerBases.length > 0
          ? dozerBases.map((origin) => ({ origin, offBoard: true }))
          : [
              ...boardOrigins.map((origin) => ({ origin, offBoard: false })),
              ...mutualAid.map((origin) => ({ origin, offBoard: true })),
            ];
    // Engines, tenders and chiefs park within MAX_ROAD_GAP_METERS; crews and dozers anywhere.
    const family = spec.line ? vehicleFamily(kind) : null;
    const walksIn = family === "hand_crew" || family === "dozer";
    const maxWalkMinutes = family === "hand_crew" ? HAND_CREW_MAX_HIKE_MINUTES : family === "dozer" ? DOZER_MAX_WALK_MINUTES : Infinity;
    const optionsWithin = (maxGap: number) =>
      candidates
        .map(({ origin, offBoard: off }) => ({ origin, leg: cachedLeg(cls, origin, off, maxGap) }))
        .filter((o): o is { origin: Origin; leg: Leg } => o.leg !== null);
    let options = optionsWithin(walksIn ? Infinity : MAX_ROAD_GAP_METERS);
    // A line builder too far to attack directly holds the nearest road it can reach (indirect).
    let indirect = walksIn && options.length > 0 && options.every((o) => o.leg.hikeMeters / HIKE_METERS_PER_MINUTE > maxWalkMinutes);
    if (options.length === 0 && family !== null && !walksIn) {
      options = optionsWithin(Infinity);
      indirect = options.length > 0;
    }
    options
      .sort(
        (a, b) =>
          a.leg.minutes + a.leg.hikeMeters / HIKE_METERS_PER_MINUTE -
            (b.leg.minutes + b.leg.hikeMeters / HIKE_METERS_PER_MINUTE) ||
          a.origin.name.localeCompare(b.origin.name),
      );
    if (options.length === 0) {
      const limit = limitOf(cls, candidates.length > 0 ? sourceOf(candidates[0].origin) : firstOrigin);
      noAccess.push({
        kind,
        label,
        rule: limit?.rule ?? null,
        why: limit
          ? `${RULE_TEXT[limit.rule]}: ${limit.why}`
          : "no road route from any base",
        road: limit?.road ?? null,
      });
      continue;
    }
    // Camps and dozer bases are not depleted (ASSUMPTION); stations give one unit per kind,
    // and without base data units round-robin over the board's stations.
    const perStation = !unit && (spec.base === "station" || !bases?.available);
    let pick = options[0];
    if (perStation) {
      const free = options.find(
        (o) => o.origin.origin !== "station" || (used.get(`${kind}|${o.origin.name}`) ?? 0) < UNITS_PER_KIND_PER_STATION,
      );
      if (free) pick = free;
      else {
        fellBack = true;
        const n = counts[kind]! - 1;
        pick = options[n % options.length];
      }
      used.set(`${kind}|${pick.origin.name}`, (used.get(`${kind}|${pick.origin.name}`) ?? 0) + 1);
    }
    // Engines from a base whose staffing the layer gives: 80 s paid, 120 s otherwise (response/fleet.ts,
    // as livecore/apparatus.py); board OSM stations (staffing unknown) keep the kind's turnout.
    const turnout = unit
      ? unit.turnoutMinutes + unit.leadMinutes
      : spec.line?.kind === "engine" && pick.origin.staffing != null
        ? engineTurnoutMinutes(pick.origin.staffing)
        : spec.turnoutMinutes;
    const departMinute = reportMinute + turnout;
    const leg = pick.leg;
    const limit = leg.node !== fireNode ? limitOf(cls, sourceOf(pick.origin)) : null;
    const atRoadMinute = departMinute + leg.minutes;
    trips[index] = {
      kind,
      label,
      stationName: pick.origin.name,
      origin: unit ? unit.origin : !bases?.available && spec.base !== "station" ? "fallback" : pick.origin.origin,
      departMinute,
      atRoadMinute,
      arriveMinute: indirect ? atRoadMinute : atRoadMinute + leg.hikeMeters / HIKE_METERS_PER_MINUTE,
      roadPoint: area.nodes[leg.node],
      hikeMeters: indirect ? 0 : leg.hikeMeters,
      tactic: indirect ? "indirect" : "direct",
      holdingRoad: indirect ? roadNameAt(area, leg.node) : null,
      stoppedShortBy: limit,
      path: leg.path,
      pathMinutes: leg.pathMinutes,
    };
  }
  if (fellBack) notes.push("More units than stations within reach: extra units were sent from stations already used.");
  const sent = trips.filter((t): t is CrewTrip => t !== null);
  if (sent.length === 0) {
    return {
      dispatch: {
        reportMinute,
        fire,
        roadPoint: area.nodes[fireNode],
        hikeMeters: 0,
        hikeMinutes: 0,
        trips: [],
        noAccess,
        notes,
        helitack: helitackPlan(bases, fire, reportMinute),
      },
      note: "No ground resource can reach the fire by road.",
    };
  }
  const direct = sent.filter((t) => t.tactic === "direct");
  const closest = (direct.length > 0 ? direct : sent).reduce((a, b) => (b.hikeMeters < a.hikeMeters ? b : a));
  return {
    dispatch: {
      reportMinute,
      fire,
      roadPoint: closest.roadPoint,
      hikeMeters: closest.hikeMeters,
      hikeMinutes: closest.hikeMeters / HIKE_METERS_PER_MINUTE,
      trips: sent,
      noAccess,
      notes,
      helitack: helitackPlan(bases, fire, reportMinute),
    },
    note: null,
  };
}

/**
 * Plain language for a fire beyond engine reach of every road: "Remote fire: air tankers from
 * Chico (~25 min), helitack crew landing 0.5 km away (~40 min), hand crew hiking 4.1 km
 * (~1 h 22 min), 2 engines indirect: holding Grizzly Peak Blvd." Times are from the report.
 */
export function remoteFireText(
  dispatch: CrewDispatch,
  aircraft: readonly { kind: string; baseName: string | null; overFireMinute: number | null }[],
): string {
  const after = (minute: number) => formatDuration(minute - dispatch.reportMinute);
  const parts: string[] = [];
  const firstAir = (prefix: string, noun: string) => {
    const rows = aircraft.filter((a) => a.kind.startsWith(prefix) && a.overFireMinute !== null);
    if (rows.length === 0) return;
    const first = rows.reduce((a, b) => (b.overFireMinute! < a.overFireMinute! ? b : a));
    parts.push(`${noun} from ${first.baseName} (~${after(first.overFireMinute!)})`);
  };
  firstAir("airtanker", "air tankers");
  firstAir("helicopter", "helicopters");
  const h = dispatch.helitack;
  if (h) parts.push(`helitack crew from ${h.baseName} landing ~${(h.walkMeters / 1000).toFixed(1)} km away (~${after(h.landMinute)}, not in the line model)`);
  for (const trip of [...dispatch.trips].sort((a, b) => a.arriveMinute - b.arriveMinute)) {
    if (trip.tactic === "indirect") {
      parts.push(`${trip.label} indirect: holding ${trip.holdingRoad ?? "the nearest road"}`);
    } else if (trip.hikeMeters >= 50) {
      const verb = GROUND_APPARATUS[trip.kind].line?.kind === "dozer" ? "walking in" : "hiking";
      parts.push(`${trip.label} ${verb} ${(trip.hikeMeters / 1000).toFixed(1)} km (on the line ~${after(trip.arriveMinute)})`);
    }
  }
  return `Remote fire: ${parts.length > 0 ? parts.join(", ") : "no resource reaches it"}.`;
}

/** Name of a road meeting `node` (the first named edge), or null. */
function roadNameAt(area: DispatchArea, node: number): string | null {
  for (const edge of area.edges) if ((edge.from === node || edge.to === node) && edge.name) return edge.name;
  return null;
}

/** Helitack from the nearest helitack base (HB) in the facility layer, or null without one. */
export function helitackPlan(bases: SuppressionBases | null, fire: LonLat, reportMinute: number): HelitackPlan | null {
  if (!bases?.available) return null;
  let best: { name: string; km: number } | null = null;
  for (const b of bases.bases) {
    if (b.type !== "HB") continue;
    const km = groundMeters([b.lon, b.lat], fire) / 1000;
    if (!best || km < best.km) best = { name: b.name, km };
  }
  if (!best) return null;
  const landMinute = reportMinute + HELI_TAKEOFF_MIN + (best.km / (HELI_CRUISE_KT * KMH_PER_KNOT)) * 60;
  return {
    baseName: best.name,
    baseKm: Math.round(best.km * 10) / 10,
    landMinute,
    walkMeters: HELITACK_LZ_WALK_M,
    arriveMinute: landMinute + HELITACK_LZ_WALK_M / HIKE_METERS_PER_MINUTE,
  };
}

/** Where a trip is at `minute`: at its base, on the road, or at its road point. */
export function tripPosition(trip: CrewTrip, minute: number): { at: LonLat; ahead: LonLat } {
  const { path, pathMinutes } = trip;
  const elapsed = minute - trip.departMinute;
  if (elapsed <= 0) return { at: path[0], ahead: path[Math.min(1, path.length - 1)] };
  const last = path.length - 1;
  if (elapsed >= pathMinutes[last]) return { at: path[last], ahead: path[last] };
  let i = 1;
  while (i < last && pathMinutes[i] < elapsed) i += 1;
  const span = pathMinutes[i] - pathMinutes[i - 1];
  const t = span > 0 ? (elapsed - pathMinutes[i - 1]) / span : 1;
  const a = path[i - 1];
  const b = path[i];
  return { at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], ahead: b };
}
