/**
 * Fire-related injuries on the command board and the medical/rescue response to them (simulated).
 *
 * Generation (stepInjuries, once per whole board minute, from board state, on a seeded stream
 * derived from the board seed so the same run injures the same people):
 * - burns: people still home when fire reaches their zone's core (zone.caughtPeople) are injured
 *   at CIVILIAN_OVERRUN_INJURY_PER_PERSON, at random points in the zone;
 * - smoke: people still home when fire first touches the zone (the fringe, before the core) at
 *   CIVILIAN_FRINGE_FACTOR x that rate; people driving out of a zone fire has touched at
 *   SMOKE_TRANSIT_INJURY_PER_PERSON_HOUR, on the first part of their route;
 * - vehicle_crash: evacuation road segments loaded at or over capacity (LOS F, v/c >= 1) at the
 *   NHTSA injury rate per vehicle-mile x MVC_EVAC_SMOKE_MULTIPLIER;
 * - medical: firefighters on the line (units on scene at a fire, CREW_SIZE persons each) at
 *   FF_INJURY_PER_PERSON_HOUR.
 * Injured people come in parties (InjuryEvent, "inj-<n>", runContracts.ts) pushed into
 * board.simComms.injuries; lead D's simComms.ts turns them into 911 / radio messages.
 *
 * Response: send_rescue with an inj-* id (liveOrders.ts routes it here) sends the closest free
 * ALS ambulance that can drive there (response/fleet.ts EmsSeed units on the board, kind
 * "ambulance", routed as the lightest road class, realism.ts AMBULANCE_ACCESS), by the road
 * router's legs and the same trip machinery as model.dispatch. When no ambulance is free or none
 * can reach the injury by road, the closest free engine goes instead (Berkeley FD staffs every
 * engine with a paramedic, City of Berkeley, Fire Department page,
 * https://berkeleyca.gov/your-government/about-us/departments/fire-department: "All of Berkeley's
 * seven fire engines, two trucks, and four ambulances are staffed with paramedics"); an engine
 * cannot transport, so ASSUMPTION: it hands a serious or critical patient to an ambulance off the
 * board at the end of its on-scene time ("transported"). After EMS_ON_SCENE_MIN on scene a
 * transporting ambulance leaves for the hospital (not on the board: no hospital layer), is out of
 * service for AMBULANCE_TURNAROUND_MIN, then is back in quarters; an engine drives home
 * (boardResponse.sendHome). A critical patient nobody reached dies at a seeded time
 * (CRITICAL_UNTREATED_MEDIAN_DEATH_MIN median).
 *
 * Units: board minutes, persons, metres, [lon, lat]. Everything here is evidence "simulated".
 */

import { deriveStream, uniform, type RngStream } from "../response/rng";
import { travelVariation } from "../response/travel";
import { sendHome, statusFree } from "./boardResponse";
import {
  activeRoute,
  congestionFactor,
  dispatchable,
  distanceM,
  fallbackDriveMinutes,
  legStatus,
  logEvent,
  pointInRing,
  teamPosition,
  travelKey,
  tripStart,
  zoneAt,
  zoneCounts,
  zonePeople,
  type Board,
  type Team,
  type ZoneState,
} from "./model";
import type { InjuryCause, InjuryEvent, InjurySeverity, LonLat, SimCommsState } from "./runContracts";

// ---- sourced rates (see the module note; every value cited or labelled ASSUMPTION) ----

/**
 * Injuries per person still home when fire reaches the zone core. ASSUMPTION (derived): the 1991
 * Oakland Hills (Tunnel) fire's ~150 injured over ~10,000 people left homeless (USFA-TR-060, "The
 * East Bay Hills Fire", 1991: "approximately 150 injuries to civilians and firefighters"; "close to
 * 10,000" homeless) = 0.015 per displaced resident, divided by an assumed 1/3 of residents still
 * home when the fire arrived (no source gives that share).
 */
export const CIVILIAN_OVERRUN_INJURY_PER_PERSON = 0.045;
/** ASSUMPTION: people home in the zone fringe (fire touching the zone, core not reached) are injured at this share of the core rate; no source separates fringe from core exposure. */
export const CIVILIAN_FRINGE_FACTOR = 0.2;
/**
 * Severity split of civilian injuries. Derived (weak) from 2018 Mati, Greece news counts (AFP,
 * Jul 2018, 187 injured; Naftemporiki 2 Aug / 11 Sep 2018: 42 still in hospital on day 9, 10 in
 * ICU, 16 later died in hospital): critical (10+16)/187, serious 32/187, minor the rest.
 * ASSUMPTION: the same split is used for smoke and vehicle-crash injuries (no source for those).
 */
export const CIVILIAN_SEVERITY: Record<InjurySeverity, number> = { minor: 0.69, serious: 0.17, critical: 0.14 };
/**
 * ASSUMPTION: acute smoke injuries per person-hour driving out of a zone the fire has touched.
 * Population studies give only ~1e-6 excess ED visits per person-hour of regional smoke
 * (Wettstein et al. 2018 JAHA 7(8) e007492; Hutchinson et al. 2018 PLoS Med 15(7) e1002601: San
 * Diego 2007 respiratory ED RR 1.34); none covers dense near-front exposure, so this is a guess.
 */
export const SMOKE_TRANSIT_INJURY_PER_PERSON_HOUR = 1e-3;
/** Injured persons per vehicle-mile: NHTSA DOT HS 813 560 (2024), 75 injured per 100 million VMT in 2022. */
export const MVC_INJURED_PER_VEHICLE_MILE = 75 / 1e8;
/** Persons injured per injury crash: NHTSA Traffic Safety Facts 2022 (DOT HS 813 643), 2,382,771 injured / 1,664,598 injury crashes = 1.43. */
export const MVC_PERSONS_PER_INJURY_CRASH = 1.43;
/** ASSUMPTION: evacuation traffic in smoke triples the crash injury rate (only qualitative evidence: AAA on fog/smoke multi-vehicle crashes; USFA-TR-060 "roads were blocked by collisions"). */
export const MVC_EVAC_SMOKE_MULTIPLIER = 3;
/** Heavily congested = demand at or over capacity, v/c >= 1 (Highway Capacity Manual LOS F). */
export const CONGESTED_VC = 1;
/**
 * Firefighter injuries per person-hour on the line, derived: Britton et al. 2013 (Ann Epidemiol
 * 23:37-42), 15.2 injuries per 10,000 person-days on Type III incidents (injuries that kept the
 * firefighter from returning to the assignment), / an ASSUMED 16 h operational day (NWCG maximum shift).
 */
export const FF_INJURY_PER_PERSON_HOUR = 15.2e-4 / 16;
/** Share of firefighter injuries that are severe (lost or restricted time): Britton et al. 2013 (Am J Emerg Med 31:339-45), 180 of 1,301 (14%). None critical (no source). */
export const FF_SEVERITY: Record<InjurySeverity, number> = { minor: 0.86, serious: 0.14, critical: 0 };
/**
 * Persons per unit on the line: hand crew 20 (NWCG Type 1 crew standard); Type 3 engine 3 (Berkeley
 * FD's three-person engines, Citygate 2023 via Berkeleyside Feb 2024); Type 1 engine 4 (NFPA 1710
 * minimum engine company staffing, not re-checked); dozer 1 operator (ASSUMPTION).
 */
export const CREW_SIZE: Record<string, number> = { hand_crew_t1: 20, engine_t3: 3, engine_t1: 4, dozer_t2: 1 };
/** EMS on-scene time, minutes: West Virginia 2016 trauma median 15.29 min (NASEMSO abstract); NEMSIS 2016-19 urban trauma mean 15.5 min. */
export const EMS_ON_SCENE_MIN = 15;
/**
 * Median minutes to death of an untreated critical patient: Remick et al. 2014 (J Trauma Acute Care
 * Surg, PTOS 1999-2010) TD50 0:59 for trauma deaths within 4 h (a lower bound). Drawn per patient
 * as an exponential with this median. ASSUMPTION: a patient reached before then survives.
 */
export const CRITICAL_UNTREATED_MEDIAN_DEATH_MIN = 59;
/** ASSUMPTION: half the minor patients are treated and released on scene; serious and critical are transported (NEMSIS 2022: 89% of treated patients transported overall). */
export const MINOR_TRANSPORT_FRACTION = 0.5;
/** Persons per household where a zone's persons are unknown: US Census Bureau, America's Families and Living Arrangements 2023 (Table HH-6), 2.51 (not re-checked this session). */
export const PERSONS_PER_HOUSEHOLD = 2.51;
/** ASSUMPTION (display grouping, not a rate): injured people are listed in parties of at most this many, at most MAX_PARTIES_PER_BURST parties per zone and severity. */
export const MAX_PARTY = 3;
export const MAX_PARTIES_PER_BURST = 8;
/** Smoke injuries on the road happen on the first part of the route (share of its length): ASSUMPTION, near the zone the fire is in. */
const SMOKE_ROUTE_SHARE = 0.3;
/** Ambulances respond first; paramedic-staffed engines (see the module note) are the fallback. */
const ENGINE = /^engine/;
/**
 * Out of service after taking a patient to hospital, minutes: transport out and back plus offload.
 * ASSUMPTION: no hospital layer on the board, so the drive is HOSPITAL_TRANSPORT_MIN (10 min each
 * way, an urban East Bay hospital within a few miles; not measured). Offload is the California
 * ambulance patient offload time ceiling, AB 40 (2023), Health and Safety Code 1797.120.6: each
 * local EMS agency's standard is at most 30 min, 90% of the time (SMC EMS bulletin 24-05; Sacramento
 * County DHS); used here as the value for every transport, so it is conservative.
 */
export const HOSPITAL_TRANSPORT_MIN = 20;
export const HOSPITAL_OFFLOAD_MIN = 30;
export const AMBULANCE_TURNAROUND_MIN = HOSPITAL_TRANSPORT_MIN + HOSPITAL_OFFLOAD_MIN;
/** Nearest free ambulances whose road legs are fetched ahead for each waiting injury, and injuries so served per request batch. */
export const RESCUE_PREFETCH_UNITS = 2;
export const RESCUE_PREFETCH_INJURIES = 6;
const METERS_PER_MILE = 1609.344;

// ---- board-side state ----

/** Who an injury happened to, and the response's progress (board-side; InjuryEvent is the wire record). */
export interface InjuryDetail {
  who: "resident" | "evacuee" | "driver" | "firefighter";
  /** Unit the injured firefighter belongs to (who "firefighter"). */
  teamId: string | null;
  /** Board minute an untreated critical patient dies; null otherwise. */
  deathAt: number | null;
  /** Rescue trip: when the unit was sent, reached the patient (null while driving), and finishes on scene. */
  sentAt: number | null;
  onSceneAt: number | null;
  doneAt: number | null;
  /** Trip destination key (travelKey destKey) of the rescue. */
  destKey: string;
}

export interface InjuryRunState {
  rng: RngStream;
  /** Zone bursts already generated: `${zone.id}@${overrunAt}` and `${zone.id}~${touchedAt}`. */
  done: Record<string, true>;
  details: Record<string, InjuryDetail>;
  /** People who died of an injury nobody reached. */
  deaths: number;
  /** Last whole minute generated. */
  minute: number | null;
}

type InjuryBoard = Board & { simComms?: SimCommsState; injuryRun?: InjuryRunState };

const isInjuryId = (id: string | null | undefined): id is string => typeof id === "string" && id.startsWith("inj-");
export { isInjuryId };

function commsOf(board: Board): SimCommsState {
  const b = board as InjuryBoard;
  b.simComms ??= { items: [], injuries: [], nextId: 0 };
  return b.simComms;
}

function stateOf(board: Board): InjuryRunState {
  const b = board as InjuryBoard;
  b.injuryRun ??= { rng: deriveStream(board.seed, "injuries"), done: {}, details: {}, deaths: 0, minute: null };
  return b.injuryRun;
}

/** The board the clock stepped last: liveOrders.ts sends a rescue to it when its caller passes no board. */
let lastBoard: Board | null = null;
export function injuryBoard(): Board | null {
  return lastBoard;
}

/** Injury records on the board (empty before the first). */
export function boardInjuries(board: Board): InjuryEvent[] {
  return (board as InjuryBoard).simComms?.injuries ?? [];
}

export function injuryDetail(board: Board, id: string): InjuryDetail | null {
  return (board as InjuryBoard).injuryRun?.details[id] ?? null;
}

// ---- seeded draws ----

function poisson(rng: RngStream, lambda: number): number {
  if (!(lambda > 0)) return 0;
  if (lambda > 30) {
    // Normal approximation for large means.
    const u1 = Math.max(1e-12, uniform(rng));
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * uniform(rng));
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * z));
  }
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = uniform(rng);
  while (p > limit) {
    k += 1;
    p *= uniform(rng);
  }
  return k;
}

function pick<T extends string>(rng: RngStream, split: Record<T, number>): T {
  const u = uniform(rng);
  let acc = 0;
  const keys = Object.keys(split) as T[];
  for (const k of keys) {
    acc += split[k];
    if (u < acc) return k;
  }
  return keys[keys.length - 1];
}

function pointInZone(rng: RngStream, zone: ZoneState): LonLat {
  const ring = zone.ring;
  if (ring.length < 3) return zone.core;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  for (let i = 0; i < 20; i += 1) {
    const p: LonLat = [minX + uniform(rng) * (maxX - minX), minY + uniform(rng) * (maxY - minY)];
    if (pointInRing(p, ring)) return p;
  }
  return zone.core;
}

function pointAlong(line: readonly LonLat[], meters: number): LonLat {
  let left = Math.max(0, meters);
  for (let i = 1; i < line.length; i += 1) {
    const d = distanceM(line[i - 1], line[i]);
    if (left <= d && d > 0) {
      const f = left / d;
      return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * f, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * f];
    }
    left -= d;
  }
  return line[line.length - 1];
}

function lineLength(line: readonly LonLat[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i += 1) total += distanceM(line[i - 1], line[i]);
  return total;
}

// ---- generation ----

function addInjury(
  board: Board,
  s: InjuryRunState,
  at: { coord: LonLat; zoneId: string | null },
  people: number,
  cause: InjuryCause,
  severity: InjurySeverity,
  who: InjuryDetail["who"],
  teamId: string | null = null,
): InjuryEvent {
  const comms = commsOf(board);
  comms.nextId += 1;
  const id = `inj-${comms.nextId}`;
  const minute = Math.round(board.minute);
  const event: InjuryEvent = {
    id,
    minute,
    zoneId: at.zoneId,
    coord: at.coord,
    people,
    cause,
    severity,
    status: "waiting",
    assignedUnitId: null,
    evidence: "simulated",
  };
  comms.injuries.push(event);
  // Exponential time to death with the sourced median (median = mean x ln 2).
  const deathAt = severity === "critical" ? minute + (-Math.log(Math.max(1e-12, uniform(s.rng))) * CRITICAL_UNTREATED_MEDIAN_DEATH_MIN) / Math.LN2 : null;
  s.details[id] = { who, teamId, deathAt, sentAt: null, onSceneAt: null, doneAt: null, destKey: `inj:${id}` };
  return event;
}

/** `injured` persons of one zone burst, by severity, in parties of at most MAX_PARTY (at most MAX_PARTIES_PER_BURST parties per severity). */
function burst(board: Board, s: InjuryRunState, zone: ZoneState, injured: number, cause: InjuryCause, who: InjuryDetail["who"]): number {
  const bySeverity: Record<InjurySeverity, number> = { minor: 0, serious: 0, critical: 0 };
  for (let i = 0; i < injured; i += 1) bySeverity[pick(s.rng, CIVILIAN_SEVERITY)] += 1;
  for (const severity of ["critical", "serious", "minor"] as InjurySeverity[]) {
    let left = bySeverity[severity];
    const parties = Math.min(MAX_PARTIES_PER_BURST, Math.ceil(left / MAX_PARTY));
    for (let p = 0; p < parties && left > 0; p += 1) {
      const people = Math.ceil(left / (parties - p));
      addInjury(board, s, { coord: pointInZone(s.rng, zone), zoneId: zone.id }, people, cause, severity, who);
      left -= people;
    }
  }
  return injured;
}

const personsOf = (people: number | null, households: number) => (people !== null ? people : Math.round(households * PERSONS_PER_HOUSEHOLD));

function generate(board: Board, s: InjuryRunState, minute: number): void {
  // Burns: people home when fire reached the zone core (frozen at the overrun).
  for (const zone of board.zones) {
    if (zone.overrunAt !== null) {
      const key = `${zone.id}@${zone.overrunAt}`;
      if (!s.done[key]) {
        s.done[key] = true;
        const exposed = personsOf(zone.caughtPeople, zone.caught);
        const n = burst(board, s, zone, poisson(s.rng, exposed * CIVILIAN_OVERRUN_INJURY_PER_PERSON), "burn", "resident");
        if (n > 0) logEvent(board, "zone", "board", `Fire overran ${zone.name}: ${n} of the ${exposed} people still home injured (simulated).`);
      }
    }
    // Smoke: people home when fire first touched the zone (fringe), before the core.
    if (zone.touchedAt !== null && zone.overrunAt === null) {
      const key = `${zone.id}~${zone.touchedAt}`;
      if (!s.done[key]) {
        s.done[key] = true;
        const p = zonePeople(zone, minute);
        const home = p.home !== null ? p.home : Math.round(zoneCounts(zone, minute).home * PERSONS_PER_HOUSEHOLD);
        const n = burst(board, s, zone, poisson(s.rng, home * CIVILIAN_OVERRUN_INJURY_PER_PERSON * CIVILIAN_FRINGE_FACTOR), "smoke", "resident");
        if (n > 0) logEvent(board, "zone", "board", `Fire reached ${zone.name}: ${n} people at home hurt by smoke and heat (simulated).`);
      }
    }
    // Smoke on the road: people driving out of a zone the fire has touched.
    const route = activeRoute(zone);
    if (zone.touchedAt !== null && route && route.line.length >= 2) {
      const p = zonePeople(zone, minute);
      const enRoute = p.enRoute !== null ? p.enRoute : Math.round(zoneCounts(zone, minute).enRoute * PERSONS_PER_HOUSEHOLD);
      const k = poisson(s.rng, (enRoute * SMOKE_TRANSIT_INJURY_PER_PERSON_HOUR) / 60);
      if (k > 0) {
        const at = pointAlong(route.line, uniform(s.rng) * SMOKE_ROUTE_SHARE * lineLength(route.line));
        addInjury(board, s, { coord: at, zoneId: zone.id }, k, "smoke", pick(s.rng, CIVILIAN_SEVERITY), "evacuee");
      }
    }
  }
  crashes(board, s);
  firefighters(board, s);
}

/** Vehicle crashes on evacuation segments at or over capacity: throughput vehicle-miles x the NHTSA rate x the evacuation/smoke multiplier. */
function crashes(board: Board, s: InjuryRunState): void {
  const t = board.traffic;
  let where: Map<string, { coord: LonLat; zoneId: string }> | null = null;
  for (const [segId, flow] of t.flow) {
    const seg = t.segments.get(segId);
    if (!seg || !(seg.capacity_veh_h > 0) || flow / seg.capacity_veh_h < CONGESTED_VC) continue;
    const vehicleMiles = (Math.min(flow, seg.capacity_veh_h) / 60) * (seg.length_m / METERS_PER_MILE);
    const crashCount = poisson(s.rng, (vehicleMiles * MVC_INJURED_PER_VEHICLE_MILE * MVC_EVAC_SMOKE_MULTIPLIER) / MVC_PERSONS_PER_INJURY_CRASH);
    for (let i = 0; i < crashCount; i += 1) {
      where ??= segmentPoints(board);
      const at = where.get(segId);
      if (!at) continue;
      // 1.43 persons per injury crash on average: 1, plus a second with probability 0.43.
      const people = 1 + (uniform(s.rng) < MVC_PERSONS_PER_INJURY_CRASH - 1 ? 1 : 0);
      addInjury(board, s, at, people, "vehicle_crash", pick(s.rng, CIVILIAN_SEVERITY), "driver");
      logEvent(board, "zone", "board", `Crash on ${seg.name} in evacuation traffic: ${people} injured (simulated).`);
    }
  }
}

/** Midpoint of each segment of the routes in use, along its zone's route line (segments in travel order). */
function segmentPoints(board: Board): Map<string, { coord: LonLat; zoneId: string }> {
  const out = new Map<string, { coord: LonLat; zoneId: string }>();
  for (const zone of board.zones) {
    const route = activeRoute(zone);
    if (!route || route.line.length < 2 || route.segments.length === 0) continue;
    const total = route.segments.reduce((a, g) => a + g.length_m, 0);
    const scale = total > 0 ? lineLength(route.line) / total : 0;
    let acc = 0;
    for (const g of route.segments) {
      if (!out.has(g.id)) out.set(g.id, { coord: pointAlong(route.line, (acc + g.length_m / 2) * scale), zoneId: zone.id });
      acc += g.length_m;
    }
  }
  return out;
}

/** Firefighter injuries: persons on the line (units on scene at a fire) x the per-hour rate. */
function firefighters(board: Board, s: InjuryRunState): void {
  for (const team of board.teams) {
    if (team.status !== "on_scene" || team.fireId === null) continue;
    const persons = CREW_SIZE[team.kind] ?? 1;
    const k = poisson(s.rng, (persons * FF_INJURY_PER_PERSON_HOUR) / 60);
    if (k <= 0) continue;
    const coord = teamPosition(board, team);
    addInjury(board, s, { coord, zoneId: zoneAt(board, coord)?.id ?? null }, Math.min(k, persons), "medical", pick(s.rng, FF_SEVERITY), "firefighter", team.id);
    logEvent(board, "team", "board", `${team.id}: firefighter injured on ${team.fireId} (simulated).`);
  }
}

// ---- response ----

function onThisRescue(team: Team, inj: InjuryEvent, d: InjuryDetail): boolean {
  if (team.fireId !== null || team.lineId !== null) return false;
  if (d.onSceneAt !== null) return team.status === "on_scene";
  return team.status === "en_route" && (team.legKey === null || team.legKey.split("|")[2] === d.destKey) && team.target !== null && distanceM(team.target, inj.coord) < 1;
}

/** Whether a unit is on a rescue trip or treating a patient (model.ts invariants: such a unit is en route / on scene with no fire). */
export function onRescue(board: Board, teamId: string): boolean {
  // unit_en_route covers driving and treating on scene; resolution (treated / transported) sends the unit home.
  return boardInjuries(board).some((inj) => inj.assignedUnitId === teamId && inj.status === "unit_en_route");
}

/** Whether a unit can be sent to a patient now: a free ambulance, or (fallback) a free paramedic engine. */
function rescueCandidate(board: Board, t: Team): boolean {
  if (onRescue(board, t.id)) return false;
  if (t.kind === "ambulance") return statusFree(t);
  return ENGINE.test(t.kind) && dispatchable(t);
}

/** Ambulances are tried first (rank 0), engines second (rank 1). */
const rescueRank = (t: Team) => (t.kind === "ambulance" ? 0 : 1);

/**
 * send_rescue on an inj-* id: the closest free ambulance that can drive there by its road leg
 * (or the ASSUMPTION straight-line estimate while the leg is not known; it waits where it stands
 * until the road router answers, as model.dispatch); when no ambulance is free or none can reach
 * the injury by road, the closest free engine that can. Returns null or why it cannot go.
 */
export function sendRescue(board: Board, injuryId: string, actor: "agent" | "you", reason = ""): string | null {
  const inj = boardInjuries(board).find((i) => i.id === injuryId);
  const s = stateOf(board);
  const d = s.details[injuryId];
  if (!inj || !d) return `Unknown injury ${injuryId}.`;
  if (inj.status !== "waiting") return `${injuryId} is ${inj.status.replace(/_/g, " ")}${inj.assignedUnitId ? ` (${inj.assignedUnitId})` : ""}.`;
  const free = board.teams.filter((t) => rescueCandidate(board, t));
  if (free.length === 0) return `No free ambulance or engine to send to ${injuryId}.`;
  let best: { team: Team; minutes: number; rank: number } | null = null;
  let why: string | null = null;
  let ambulanceWhy: string | null = null;
  const ambulancesFree = free.filter((t) => t.kind === "ambulance").length;
  for (const team of free) {
    const leg = legStatus(board, team, d.destKey, inj.coord);
    if (leg.route === "none") {
      why ??= leg.reason.replace(/_/g, " ");
      if (team.kind === "ambulance") ambulanceWhy ??= leg.reason.replace(/_/g, " ");
      continue;
    }
    const rank = rescueRank(team);
    if (!best || rank < best.rank || (rank === best.rank && (leg.minutes < best.minutes || (leg.minutes === best.minutes && team.id < best.team.id)))) {
      best = { team, minutes: leg.minutes, rank };
    }
  }
  if (!best) return `No free ambulance or engine can drive to ${injuryId}${why ? ` (${why})` : ""}.`;
  const team = best.team;
  startRescueTrip(board, s, team, inj.coord, d.destKey);
  inj.status = "unit_en_route";
  inj.assignedUnitId = team.id;
  d.sentAt = board.minute;
  d.onSceneAt = d.doneAt = null;
  const eta = Math.max(0, Math.ceil((team.arriveAt ?? board.minute) - board.minute));
  const what = `${inj.people} ${inj.severity} ${inj.cause.replace(/_/g, " ")} patient${inj.people === 1 ? "" : "s"}`;
  // An engine went: say why no ambulance did.
  const fallback =
    team.kind === "ambulance"
      ? ""
      : ambulancesFree === 0
        ? " (engine: no ambulance free)"
        : ` (engine: no free ambulance can drive there${ambulanceWhy ? `, ${ambulanceWhy}` : ""})`;
  logEvent(
    board,
    "team",
    actor,
    `${team.id}${fallback} sent to ${injuryId} (${what})${reason ? `: ${reason.slice(0, 120)}` : ""}; ${team.travel === "pending" ? `waiting for its road route (about ${eta} min estimated)` : `on scene in ${eta} min`}.`,
  );
  return null;
}

/**
 * Road legs worth asking for before an order: for each waiting injury (at most
 * RESCUE_PREFETCH_INJURIES, oldest first), the RESCUE_PREFETCH_UNITS nearest free ambulances'
 * legs to it (straight line), so the ambulance's road time, or that its road class cannot reach
 * the spot, is known when the commander sends help (useCrewRoutes crewRouteRequests).
 */
export function rescueLegWants(board: Board): { team: Team; from: LonLat; destKey: string; to: LonLat }[] {
  const out: { team: Team; from: LonLat; destKey: string; to: LonLat }[] = [];
  const s = (board as InjuryBoard).injuryRun;
  if (!s) return out;
  const free = board.teams.filter((t) => t.kind === "ambulance" && rescueCandidate(board, t));
  if (free.length === 0) return out;
  const origin = new Map(free.map((t) => [t.id, tripStart(board, t).from] as const));
  const waiting = boardInjuries(board)
    .filter((i) => i.status === "waiting" && s.details[i.id])
    .slice(0, RESCUE_PREFETCH_INJURIES);
  for (const inj of waiting) {
    const destKey = s.details[inj.id].destKey;
    const near = free
      .filter((t) => legStatus(board, t, destKey, inj.coord).route !== "none")
      .sort((a, b) => distanceM(origin.get(a.id)!, inj.coord) - distanceM(origin.get(b.id)!, inj.coord) || a.id.localeCompare(b.id))
      .slice(0, RESCUE_PREFETCH_UNITS);
    for (const team of near) out.push({ team, from: origin.get(team.id)!, destKey, to: inj.coord });
  }
  return out;
}

/** The trip machinery of model.dispatch, with no fire: turnout, a returning unit turning back, road leg or pending, congestion x seeded variation (the injury stream). */
function startRescueTrip(board: Board, s: InjuryRunState, team: Team, to: LonLat, destKey: string): void {
  const start = tripStart(board, team, true);
  const here = teamPosition(board, team);
  const key = travelKey(team, start.from, destKey, to);
  const leg = board.travel.get(key);
  const congestion = congestionFactor(board, leg ? leg.line : [start.from, to]);
  team.travelFactor = congestion * travelVariation(s.rng);
  team.position = here;
  team.status = "en_route";
  team.fireId = null;
  team.lineId = null;
  team.coverStation = null;
  team.fireCuts = 0;
  team.rerouteAt = null;
  team.returnRetryAt = null;
  team.blockedByFire = null;
  team.workMode = team.workStartAt = team.parkedM = null;
  team.departAt = board.minute;
  team.rollAt = board.minute + start.turnoutMin;
  team.target = to;
  if (leg) {
    team.legKey = key;
    team.route = [...start.lead, ...leg.line];
    team.travel = leg.basis;
    team.arriveAt = team.rollAt + start.leadMin + leg.driveMinutes * team.travelFactor;
  } else {
    team.legKey = travelKey(team, here, destKey, to);
    team.route = null;
    team.travel = "pending";
    team.arriveAt = team.rollAt + fallbackDriveMinutes(here, to) * team.travelFactor;
  }
}

/**
 * A transporting ambulance leaves the board for the hospital: out of service (board.teams status,
 * responseTick brings it back to "available" at the end) for AMBULANCE_TURNAROUND_MIN, drawn at its
 * quarters meanwhile since the hospital is not on the board.
 */
function toHospital(board: Board, team: Team): void {
  team.status = "out_of_service";
  team.outOfServiceUntil = board.minute + AMBULANCE_TURNAROUND_MIN;
  team.position = team.home;
  team.target = null;
  team.route = null;
  team.legKey = null;
  team.travel = null;
  team.departAt = team.rollAt = team.arriveAt = null;
  team.accessKnown = false;
  team.coverStation = null;
}

/** Rescue arrivals, on-scene completion, re-tasked or unroutable rescues, and deaths (every clock step, before model.ts lands en-route units at fires). */
function stepResponse(board: Board, s: InjuryRunState): void {
  const now = board.minute;
  for (const inj of boardInjuries(board)) {
    if (inj.status !== "waiting" && inj.status !== "unit_en_route") continue;
    const d = s.details[inj.id];
    if (!d) continue;
    const team = inj.assignedUnitId ? board.teams.find((t) => t.id === inj.assignedUnitId) : undefined;
    if (inj.status === "unit_en_route") {
      if (!team || !onThisRescue(team, inj, d)) {
        // Re-tasked by an order, or the road router found no route (model.travelLegFailed released it).
        inj.status = "waiting";
        inj.assignedUnitId = null;
        d.sentAt = d.onSceneAt = null;
        logEvent(board, "team", "board", `${inj.id}: ${team ? `${team.id} is no longer on its way` : "its unit left the board"}; the patient${inj.people === 1 ? " waits" : "s wait"} for a unit (simulated).`);
      } else if (d.onSceneAt === null && team.travel !== "pending" && team.arriveAt !== null && team.arriveAt <= now + 1e-9) {
        const road = !!team.route && team.route.length > 1;
        team.position = road ? team.route![team.route!.length - 1] : (team.target ?? inj.coord);
        team.status = "on_scene";
        team.departAt = team.rollAt = team.arriveAt = null;
        team.route = null;
        team.legKey = null;
        team.accessKnown = road;
        d.onSceneAt = now;
        d.doneAt = now + EMS_ON_SCENE_MIN;
        d.deathAt = null;
        logEvent(board, "team", "board", `${team.id} on scene at ${inj.id}: treating ${inj.people} ${inj.severity} patient${inj.people === 1 ? "" : "s"} (simulated).`);
      } else if (d.onSceneAt !== null && d.doneAt !== null && now >= d.doneAt - 1e-9) {
        const transported = inj.severity !== "minor" || uniform(s.rng) < MINOR_TRANSPORT_FRACTION;
        inj.status = transported ? "transported" : "treated";
        const patients = `${inj.id}'s patient${inj.people === 1 ? "" : "s"}`;
        if (team.kind === "ambulance" && transported) {
          toHospital(board, team);
          logEvent(
            board,
            "team",
            "board",
            `${team.id} leaves with ${patients} for hospital (not on the board); out of service about ${AMBULANCE_TURNAROUND_MIN} min (transport ${HOSPITAL_TRANSPORT_MIN} + offload ${HOSPITAL_OFFLOAD_MIN}, assumed), then back in quarters (simulated).`,
          );
          continue;
        }
        sendHome(board, team);
        logEvent(
          board,
          "team",
          "board",
          team.kind === "ambulance"
            ? `${team.id} treated ${inj.id} on scene (no transport) and heads back (simulated).`
            : transported
              ? `${team.id} hands ${patients} to an ambulance (not on the board; assumed) and heads back (simulated).`
              : `${team.id} treated ${inj.id} on scene and heads back (simulated).`,
        );
        continue;
      }
    }
    if (d.deathAt !== null && d.onSceneAt === null && now >= d.deathAt) {
      const en = inj.status === "unit_en_route" && team ? team : null;
      inj.status = "died";
      s.deaths += inj.people;
      if (en) sendHome(board, en);
      inj.assignedUnitId = null;
      logEvent(board, "zone", "board", `${inj.id}: ${inj.people} critically injured ${inj.people === 1 ? "person" : "people"} died before a unit reached them (simulated).`);
    }
  }
}

/**
 * The board's injury step (model.ts stepOnce, before en-route units land at their fires): every
 * clock step handles rescue arrivals, treatment and deaths; once per whole board minute new
 * injuries are generated from the board state.
 */
export function stepInjuries(board: Board, wholeMinute: boolean): void {
  lastBoard = board;
  const s = stateOf(board);
  stepResponse(board, s);
  if (!wholeMinute) return;
  const minute = Math.floor(board.minute + 1e-9);
  if (s.minute !== null && minute <= s.minute) return;
  s.minute = minute;
  generate(board, s, minute);
}

// ---- outcome ----

export interface InjuryScore {
  /** People injured so far (every party, any status). */
  injuredPeople: number;
  /** People who died of an injury nobody reached in time. */
  injuryDeaths: number;
  /** People waiting for a unit or with a unit on the way / on scene. */
  openPeople: number;
  treatedPeople: number;
  transportedPeople: number;
  byCause: Record<InjuryCause, number>;
  firefighters: number;
}

export function injuryScore(board: Board): InjuryScore {
  const out: InjuryScore = {
    injuredPeople: 0,
    injuryDeaths: (board as InjuryBoard).injuryRun?.deaths ?? 0,
    openPeople: 0,
    treatedPeople: 0,
    transportedPeople: 0,
    byCause: { burn: 0, smoke: 0, vehicle_crash: 0, medical: 0 },
    firefighters: 0,
  };
  const details = (board as InjuryBoard).injuryRun?.details ?? {};
  for (const inj of boardInjuries(board)) {
    out.injuredPeople += inj.people;
    out.byCause[inj.cause] += inj.people;
    if (details[inj.id]?.who === "firefighter") out.firefighters += inj.people;
    if (inj.status === "waiting" || inj.status === "unit_en_route") out.openPeople += inj.people;
    else if (inj.status === "treated") out.treatedPeople += inj.people;
    else if (inj.status === "transported") out.transportedPeople += inj.people;
  }
  return out;
}

// ---- EMS capacity (observation response.ems) ----

/** One ambulance for the commander: where it stands, what it is doing, when it is free. */
export interface EmsUnitObservation {
  id: string;
  department: string;
  station_id: string;
  /** "available", "responding" (driving to a patient), "treating" (on scene), "returning", "at_hospital" (turnaround, out of service), or "out_of_service" (other). */
  state: "available" | "responding" | "treating" | "returning" | "at_hospital" | "out_of_service";
  /** inj-* id of the patient it is responding to or treating, or the last one it took to hospital. */
  injury_id: string | null;
  /** Minutes until it is on scene (responding), done (treating), free again (at_hospital, out_of_service) or home (returning); null otherwise. */
  free_or_arrives_in_min: number | null;
}

export interface EmsObservation {
  /** ALS ambulances on the board (response.ems seeds at stations on it; response/departments.ts rosters). */
  ambulances: number;
  /** Ambulances in the fleet's roster at stations off the board (cannot be sent). */
  off_board: number;
  available: number;
  responding: number;
  treating: number;
  at_hospital: number;
  /** Minutes out of service per hospital transport: transport + offload (ASSUMPTION, AMBULANCE_TURNAROUND_MIN). */
  hospital_turnaround_min: number;
  /** Patients waiting for a unit now. */
  patients_waiting: number;
  units: EmsUnitObservation[];
  note: string;
}

/** Ambulance availability for the observation's response section. */
export function emsObservation(board: Board): EmsObservation {
  const minute = board.minute;
  const injuries = boardInjuries(board);
  const mins = (t: number | null) => (t === null ? null : Math.max(0, Math.ceil(t - minute)));
  const units: EmsUnitObservation[] = board.teams
    .filter((t) => t.kind === "ambulance")
    .map((t): EmsUnitObservation => {
      const current = injuries.find((i) => i.assignedUnitId === t.id && i.status === "unit_en_route");
      const last = [...injuries].reverse().find((i) => i.assignedUnitId === t.id);
      let state: EmsUnitObservation["state"];
      let when: number | null = null;
      if (current) {
        const d = injuryDetail(board, current.id);
        if (d && d.onSceneAt !== null) {
          state = "treating";
          when = d.doneAt;
        } else {
          state = "responding";
          when = t.travel === "pending" ? null : t.arriveAt;
        }
      } else if (t.status === "out_of_service") {
        state = last?.status === "transported" ? "at_hospital" : "out_of_service";
        when = t.outOfServiceUntil;
      } else if (t.status === "returning" || t.status === "moving_up") {
        state = "returning";
        when = t.travel === "pending" ? null : t.arriveAt;
      } else {
        state = t.status === "available" ? "available" : "out_of_service";
      }
      return {
        id: t.id,
        department: board.response.departments.find((d) => d.id === t.department)?.name ?? t.department,
        station_id: t.station,
        state,
        injury_id: current?.id ?? (state === "at_hospital" ? (last?.id ?? null) : null),
        free_or_arrives_in_min: mins(when),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const count = (s: EmsUnitObservation["state"]) => units.filter((u) => u.state === s).length;
  return {
    ambulances: units.length,
    off_board: Math.max(0, board.response.ems.length - units.length),
    available: count("available"),
    responding: count("responding"),
    treating: count("treating"),
    at_hospital: count("at_hospital"),
    hospital_turnaround_min: AMBULANCE_TURNAROUND_MIN,
    patients_waiting: injuries.filter((i) => i.status === "waiting").reduce((sum, i) => sum + i.people, 0),
    units,
    note: "send_rescue on an inj-* id sends the closest free ambulance that can drive there; an engine goes only when none is free or none can reach by road. An ambulance that transports is out of service for the hospital turnaround (transport + offload, assumed; no hospital on the board).",
  };
}
