/**
 * Self-evacuation on the command board: households that leave on their own cues, with no
 * official order (shadow / spontaneous evacuation). Real WUI evacuations have a lot of it: 0.291
 * to 0.75 of households that received no order left anyway (Wong et al. 2020 Table 11 p. 39), and
 * 42.3% of in-zone evacuees of the Kincade fire left before any notice (Zhao et al. 2022 Sec.
 * 4.4.1 p. 16). It runs in every board mode (it is how residents behave, not a baseline rule):
 * with nobody acting, people leave only on these cues; an official order raises the departures
 * on top (model.ts departedExact = departedHouseholds below).
 *
 * Model (aggregate per zone, analytic, so the board's traffic and counts stay tick-size free):
 * - Cues, read on whole board minutes from the fire solver's arrival field. Every active fire
 *   counts, reported or not: residents see the real fire (as Studio, population/householdBehavior.ts).
 *   - fire_approaching: a fire is forecast to reach the zone's edge within APPROACH_LEAD_MINUTES
 *     (proxy for the flame front, smoke column and ember fall being in view);
 *   - neighbours_leaving: at least SOCIAL_CUE_SHARE of the households of the zones whose core is
 *     within SOCIAL_RADIUS_M have left (seeing neighbours go);
 *   - fire_in_zone: fire has reached a cell of the zone (Studio's neighbourhood cue);
 *   - fire_near_core: fire within FIRE_CUE_NEAR_METERS of the zone core (Studio's near cue).
 * - Each cue sets a target share of the zone's households with their own vehicle who decide to
 *   leave (CUE_SHARE); the zone's decided count only rises (the max over the cues so far). The
 *   rise at a cue leaves on an exponential departure curve from the cue minute, mean
 *   DEPARTURE_MEAN_MINUTES (the board's ordered departure curve, realism.ts) or
 *   NEAR_CUE_MEAN_MINUTES for the near cue. At night (NIST TN 2174 sleeping hours) a zone's first
 *   cue starts WAKE_UP_MINUTES later.
 * - Households decide independently, so a zone's decided count is binomial around its target:
 *   one standard normal per zone from its own seeded stream (deriveStream(board seed,
 *   "self-evacuation#<zone id>")), not the board's shared response stream, so it does not move
 *   any other draw and is the same in baseline and AI runs of one seed.
 * - Carless households never leave on their own: the households the drill gives a car
 *   (ZoneState.carlessGivenCar, EVERY_HOUSEHOLD_DRIVES) leave only on an order.
 * - Official order: from the minute it takes effect, the zone's order sends out ORDER_COMPLIANCE
 *   of all households with a vehicle in total; the households already decided on their own keep
 *   their own curves and the order adds the rest (orderHouseholds) on the order's curve. No
 *   further self cue matters once ordered (the order's share is at least every cue's).
 * - Self-evacuees take the zone's best open route (board.routes only offers open safe
 *   destinations, demo/safeDestinations.ts; clear first, then the shortest drive) and load the
 *   roads like ordered households (model.ts evacuationTrafficStep, demo/traffic.ts).
 *
 * Pure: no React, network or LLM. Units: board minutes from T+0, metres, households.
 */

import { cellAt } from "../fire/spread";
import { FIRE_CUE_NEAR_METERS } from "../dispatch/fireExposure";
import {
  ORDER_COMPLIANCE as GROUNDED_COMPLIANCE,
  SHADOW_SHARE,
  WAIT_AND_SEE_SHARE,
  WAKE_UP_MINUTES,
  sleepingAt,
} from "../population/householdBehavior";
import { deriveStream, standardNormal } from "../response/rng";
import type { LonLat } from "../live/types";
import { DEPARTURE_MEAN_MINUTES, ORDER_COMPLIANCE, departedShare } from "./realism";
import type { Board, RouteOption, ZoneState } from "./model";

export type SelfEvacCue = "fire_approaching" | "neighbours_leaving" | "fire_in_zone" | "fire_near_core";

/**
 * Share of households that leave with no order once fire reaches their zone: shadow evacuation
 * 0.291 (Wong et al. 2020 Table 11 p. 39, Oct 2017 N. California non-recipients) plus the
 * wait-and-see compliers who are not shadow evacuees, (0.875 - 0.291) x 0.13 (McLennan et al. 2019
 * preprint pp. 16-19, derived; order compliance 0.875 Wong Table 11). Derived: the expected share
 * of Studio's per-household draw (population/householdBehavior.ts leavesWithoutOrder) = 0.367.
 */
export const LEAVE_WITHOUT_ORDER_SHARE = SHADOW_SHARE + Math.max(0, GROUNDED_COMPLIANCE - SHADOW_SHARE) * WAIT_AND_SEE_SHARE;
/**
 * Share of those who leave without an order that go on the first sight of the fire, before any
 * warning: 0.423 of Kincade in-zone evacuees left before any notice, 0.33 / (0.33 + 0.07 + 0.38)
 * (Zhao et al. 2022 Sec. 4.4.1 p. 16, Fig. 10; sim/behavior_params.json self_initiated_kincade,
 * derived; medium transferability: a slow fire and a post-Tubbs population).
 */
export const BEFORE_WARNING_SHARE = 0.33 / (0.33 + 0.07 + 0.38);
/**
 * Target share of the zone's households with their own vehicle that have decided to leave, per cue.
 * - fire_approaching: LEAVE_WITHOUT_ORDER_SHARE x BEFORE_WARNING_SHARE = 0.155 (derived above).
 * - neighbours_leaving: SHADOW_SHARE 0.291 (Wong et al. 2020 Table 11: non-recipients of an order
 *   who left anyway). ASSUMPTION: that whole share is assigned to the social cue; Camp residents
 *   first learned of the fire in person 26.3% of the time (Grajdura 2022 Table 1 p. 36), and
 *   11.6% of Gatlinburg stayers cited seeing others stay (NIST TN 2103 PDF p. 32), so neighbours'
 *   actions are a cue, but no published rate maps "share of neighbours gone" to departures.
 * - fire_in_zone: LEAVE_WITHOUT_ORDER_SHARE 0.367 (derived above; Studio's neighbourhood cue).
 * - fire_near_core: ORDER_COMPLIANCE (the board's 0.92): everyone not staying by choice leaves,
 *   Studio's near-cue rule (25% of Black Saturday leavers left after the fire arrived, McLennan et
 *   al. 2019 preprint pp. 17-18 quoting Whittaker et al. 2013).
 */
export const CUE_SHARE: Record<SelfEvacCue, number> = {
  fire_approaching: LEAVE_WITHOUT_ORDER_SHARE * BEFORE_WARNING_SHARE,
  neighbours_leaving: SHADOW_SHARE,
  fire_in_zone: LEAVE_WITHOUT_ORDER_SHARE,
  fire_near_core: ORDER_COMPLIANCE,
};
/**
 * ASSUMPTION (no published lead time): the fire is "in view" of a zone once it is forecast to
 * reach the zone's edge within this many minutes (flame front, smoke column and ember fall
 * nearby). NIST TN 2103 (Gatlinburg 2016): seeing flames or embers raised risk perception, smoke
 * alone did not; 44.6% of Camp respondents first learned of the fire by seeing it (Grajdura 2022
 * Table 1 p. 36), without a distance or lead time.
 */
export const APPROACH_LEAD_MINUTES = 60;
/** ASSUMPTION: neighbours are the zones whose core is within this distance of the zone's core (about the adjacent drill zones). */
export const SOCIAL_RADIUS_M = 2_000;
/**
 * ASSUMPTION: the social cue fires once at least this share of the neighbours' households have
 * left (a majority gone). Kept above LEAVE_WITHOUT_ORDER_SHARE so self-evacuation alone cannot
 * cascade across the map: only an ordered or overrun-threatened neighbourhood triggers it.
 */
export const SOCIAL_CUE_SHARE = 0.5;
/**
 * Mean departure delay after the near cue, minutes. Derived: an exponential fit to Fort McMurray
 * preparation times (McGee 2018 p. 1157: none 11.7%, < 15 min 16.9%, 15-60 min 39.1%, 1-2 h
 * 16.6%, > 2 h 8.6%; shares of the 92.9% who answered) gives a mean of 41 min from the 15 min band,
 * 46 min from the 60 min band and 50 min from the 120 min band; 45 min. Studio uses 0 min (its
 * optimistic bound); the other cues use the board's DEPARTURE_MEAN_MINUTES (Camp 93 min; seeing
 * the fire first changed preparation time by +4.9 min, n.s., Grajdura 2022 Table 3 p. 46).
 */
export const NEAR_CUE_MEAN_MINUTES = 45;
/** Points sampled around the zone core for the near cue: the core, plus rings at half and full FIRE_CUE_NEAR_METERS. */
const NEAR_SAMPLES = 12;
const M_PER_DEG_LAT = 111_195.08;
const CUE_ORDER: SelfEvacCue[] = ["fire_approaching", "neighbours_leaving", "fire_in_zone", "fire_near_core"];

export const SELF_EVACUATION_LABEL =
  "Self-evacuation (simulated): with no order, households with their own vehicle leave on fire and social cues: 15.5% when the fire is an hour out, 29.1% once most neighbours have left, 36.7% once fire is in the zone, 92% once it is within 500 m of the core (Wong 2020, McLennan 2019, Zhao 2022, Studio's grounded behaviour; lead time, neighbour radius and threshold are assumptions). An order sends the rest of the 92% on its own curve.";

/** One rise of a zone's decided count: `households` start leaving at `at` on an exponential curve of mean `meanMinutes`. */
export interface SelfEvacEvent {
  at: number;
  households: number;
  meanMinutes: number;
  cue: SelfEvacCue;
}

/** A zone's self-evacuation state (ZoneState.selfEvac); absent until its first cue. */
export interface SelfEvacZone {
  /** The zone's standard normal (binomial spread of its decided counts), from its own seeded stream. */
  z: number;
  /** Households decided so far (sum of the events' households). */
  decided: number;
  events: SelfEvacEvent[];
  /** Strongest cue so far. */
  cue: SelfEvacCue | null;
  /** Self-decided households when the order in effect took effect (orderedAt), captured on its first minute. */
  orderBase: { at: number; selfBefore: number } | null;
}

/** Households with their own vehicle: the only ones that can leave on their own (the drill's given cars wait for an order). */
export function ownVehicleHouseholds(zone: ZoneState): number {
  return Math.max(0, zone.households - zone.noVehicle - zone.carlessGivenCar);
}

function withVehicleCount(zone: ZoneState): number {
  return Math.max(0, zone.households - zone.noVehicle);
}

export function selfEvacuating(zone: ZoneState): boolean {
  return (zone.selfEvac?.events.length ?? 0) > 0;
}

function share(minutesSinceCue: number, meanMinutes: number): number {
  if (meanMinutes === DEPARTURE_MEAN_MINUTES) return departedShare(minutesSinceCue);
  return minutesSinceCue <= 0 ? 0 : 1 - Math.exp(-minutesSinceCue / meanMinutes);
}

function selfBeforeOrder(zone: ZoneState): number {
  const s = zone.selfEvac;
  if (!s) return 0;
  return zone.orderedAt !== null && s.orderBase && s.orderBase.at === zone.orderedAt ? s.orderBase.selfBefore : s.decided;
}

/** Households the order in effect sends out on its own curve: ORDER_COMPLIANCE of those with a vehicle, less those already decided on their own. */
export function orderHouseholds(zone: ZoneState): number {
  if (zone.orderedAt === null) return 0;
  return Math.max(0, ORDER_COMPLIANCE * withVehicleCount(zone) - selfBeforeOrder(zone));
}

/** Households that will leave in the end (self-decided plus the order's), before rounding. */
export function householdsLeaving(zone: ZoneState): number {
  return (zone.selfEvac?.decided ?? 0) + orderHouseholds(zone);
}

/** Self-evacuated households (own cues) gone by `minute`, before rounding; frozen at overrun. */
export function selfDepartedExact(zone: ZoneState, minute: number): number {
  const s = zone.selfEvac;
  if (!s) return 0;
  const end = zone.overrunAt !== null ? Math.min(minute, zone.overrunAt) : minute;
  let d = 0;
  for (const e of s.events) d += e.households * share(end - e.at, e.meanMinutes);
  return d;
}

/**
 * Households with a vehicle gone by `minute` (model.ts departedExact): the self-evacuees' curves
 * plus the order's (orderHouseholds from orderedAt, mean DEPARTURE_MEAN_MINUTES). Frozen at overrun.
 */
export function departedHouseholds(zone: ZoneState, minute: number): number {
  const end = zone.overrunAt !== null ? Math.min(minute, zone.overrunAt) : minute;
  const ordered = zone.orderedAt === null ? 0 : orderHouseholds(zone) * departedShare(end - zone.orderedAt);
  return selfDepartedExact(zone, minute) + ordered;
}

/** Self-evacuated households gone by `minute` (whole households, for the observation). */
export function selfEvacuated(zone: ZoneState, minute: number): number {
  return Math.floor(selfDepartedExact(zone, minute) + 1e-9);
}

/** Upper bound of the zone's departure rate, households per minute (each curve's initial rate). */
export function peakHouseholdsPerMinute(zone: ZoneState): number {
  let r = zone.orderedAt === null ? 0 : orderHouseholds(zone) / DEPARTURE_MEAN_MINUTES;
  for (const e of zone.selfEvac?.events ?? []) r += e.households / e.meanMinutes;
  return r;
}

/** Changes whenever the zone's departure curves change (model.ts segmentQueues cache key). */
export function selfEvacKey(zone: ZoneState): string {
  const s = zone.selfEvac;
  return s ? `${s.events.length}/${s.decided}` : "";
}

/** Earliest minute any of the zone's self-evacuees start leaving, or null. */
export function firstSelfCue(zone: ZoneState): number | null {
  const e = zone.selfEvac?.events;
  return e && e.length ? Math.min(...e.map((x) => x.at)) : null;
}

/** Binomial count of `n` households at share `p`, through the zone's normal `z` (normal approximation), clamped to [0, cap]. */
function decidedAt(n: number, p: number, z: number, cap: number): number {
  const mean = n * p;
  const sd = Math.sqrt(Math.max(0, n * p * (1 - p)));
  return Math.max(0, Math.min(cap, Math.round(mean + z * sd)));
}

function zoneDraw(board: Board, zone: ZoneState): number {
  const rng = deriveStream(board.seed, `self-evacuation#${zone.id}`);
  return Math.max(-3, Math.min(3, standardNormal(rng)));
}

function metresBetween(a: LonLat, b: LonLat): number {
  const mLon = M_PER_DEG_LAT * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot((a[0] - b[0]) * mLon, (a[1] - b[1]) * M_PER_DEG_LAT);
}

const neighbourCache = new WeakMap<object, Map<string, ZoneState[]>>();

function neighboursOf(board: Board, zone: ZoneState): ZoneState[] {
  let byZone = neighbourCache.get(board.zones);
  if (!byZone) {
    byZone = new Map();
    neighbourCache.set(board.zones, byZone);
  }
  let list = byZone.get(zone.id);
  if (!list) {
    list = board.zones.filter((o) => o !== zone && metresBetween(o.core, zone.core) <= SOCIAL_RADIUS_M);
    byZone.set(zone.id, list);
  }
  return list;
}

function nearPoints(core: LonLat): LonLat[] {
  const mLon = M_PER_DEG_LAT * Math.cos((core[1] * Math.PI) / 180);
  const out: LonLat[] = [core];
  for (const r of [FIRE_CUE_NEAR_METERS / 2, FIRE_CUE_NEAR_METERS]) {
    for (let k = 0; k < NEAR_SAMPLES; k += 1) {
      const a = (2 * Math.PI * k) / NEAR_SAMPLES;
      out.push([core[0] + (r * Math.sin(a)) / mLon, core[1] + (r * Math.cos(a)) / M_PER_DEG_LAT]);
    }
  }
  return out;
}

/** Strongest fire cue at whole minute `m` (any active fire, reported or not), or null. */
function fireCue(board: Board, zone: ZoneState, m: number, active: Set<number>): SelfEvacCue | null {
  const field = board.solver.field;
  if (!field || active.size === 0) return null;
  for (const p of nearPoints(zone.core)) {
    const cell = cellAt(board.env.landscape, { longitude: p[0], latitude: p[1] });
    if (cell >= 0 && active.has(field.sourceIndexByCell[cell]) && field.arrivalMinutes[cell] <= m) return "fire_near_core";
  }
  const za = field.zones.get(zone.id);
  if (!za) return null;
  let edge = Number.POSITIVE_INFINITY;
  for (const s of active) edge = Math.min(edge, za.earliestBySource[s] ?? Number.POSITIVE_INFINITY);
  if (edge <= m) return "fire_in_zone";
  if (edge - m <= APPROACH_LEAD_MINUTES) return "fire_approaching";
  return null;
}

function neighboursGoneShare(board: Board, zone: ZoneState, m: number, departed: (z: ZoneState, minute: number) => number): number {
  let households = 0;
  let gone = 0;
  for (const o of neighboursOf(board, zone)) {
    households += o.households;
    gone += Math.min(o.households, departed(o, m));
  }
  return households > 0 ? gone / households : 0;
}

/** The zone's best open route: clear first, then passes near fire, then the shortest drive. */
function bestRoute(options: readonly RouteOption[] | undefined): RouteOption | null {
  if (!options || options.length === 0) return null;
  const rank = (o: RouteOption) => (o.safety === "clear" ? 0 : o.safety === "passes_near_fire" ? 1 : 2);
  return [...options].sort((a, b) => rank(a) - rank(b) || a.eta_min - b.eta_min || a.destination_id.localeCompare(b.destination_id))[0];
}

const CUE_TEXT: Record<SelfEvacCue, string> = {
  fire_approaching: "the fire is in view, under an hour out",
  neighbours_leaving: "most neighbours have left",
  fire_in_zone: "fire is in the zone",
  fire_near_core: "fire is within 500 m of the core",
};

/**
 * Self-evacuation at whole board minute `m` (model.ts stepOnce, before the traffic step): captures
 * the self-decided count when an order takes effect, raises zones' decided counts on new cues,
 * and gives self-evacuating zones without a route their best open route. `departed` is model.ts
 * departedExact (households with a vehicle gone); `note` logs a zone's new cue.
 */
export function stepSelfEvacuation(
  board: Board,
  m: number,
  departed: (zone: ZoneState, minute: number) => number,
  note: (zone: ZoneState, text: string, households: number) => void,
): void {
  const field = board.solver.field;
  const active = new Set<number>();
  if (field) {
    for (const f of board.fires) {
      if (f.status === "out") continue;
      const s = field.sourceIndex.get(f.id);
      if (s !== undefined) active.add(s);
    }
  }
  // Social cues read the neighbours' departures before this minute's rises (order independent).
  const social = new Map<string, boolean>();
  for (const zone of board.zones) {
    if (zone.overrunAt !== null || zone.orderedAt !== null) continue;
    social.set(zone.id, neighboursGoneShare(board, zone, m, departed) >= SOCIAL_CUE_SHARE);
  }
  for (const zone of board.zones) {
    const s = zone.selfEvac;
    if (zone.orderedAt !== null) {
      // The order's share is fixed by the households already decided on their own when it took effect.
      if (s && (!s.orderBase || s.orderBase.at !== zone.orderedAt)) s.orderBase = { at: zone.orderedAt, selfBefore: s.decided };
      continue;
    }
    if (zone.overrunAt !== null) continue;
    const own = ownVehicleHouseholds(zone);
    if (own <= 0) continue;
    const fire = fireCue(board, zone, m, active);
    const cues: SelfEvacCue[] = [];
    if (fire) cues.push(fire);
    if (social.get(zone.id)) cues.push("neighbours_leaving");
    if (cues.length === 0) {
      if (s) keepOpenRoute(board, zone);
      continue;
    }
    const strongest = cues.reduce((a, b) => (CUE_SHARE[b] > CUE_SHARE[a] ? b : a));
    const state: SelfEvacZone = s ?? { z: zoneDraw(board, zone), decided: 0, events: [], cue: null, orderBase: null };
    const target = decidedAt(own, CUE_SHARE[strongest], state.z, Math.floor(ORDER_COMPLIANCE * own));
    if (target > state.decided) {
      const first = state.events.length === 0;
      const asleep = first && sleepingAt(board.response.startEpochMs + m * 60_000);
      const households = target - state.decided;
      state.events.push({
        at: m + (asleep ? WAKE_UP_MINUTES : 0),
        households,
        meanMinutes: strongest === "fire_near_core" ? NEAR_CUE_MEAN_MINUTES : DEPARTURE_MEAN_MINUTES,
        cue: strongest,
      });
      state.decided = target;
      const stronger = state.cue === null || CUE_ORDER.indexOf(strongest) > CUE_ORDER.indexOf(state.cue);
      if (stronger) state.cue = strongest;
      zone.selfEvac = state;
      if (stronger) {
        note(
          zone,
          `Self-evacuation in ${zone.name}: ${CUE_TEXT[strongest]}; ${target.toLocaleString("en-US")} of ${own.toLocaleString("en-US")} households with their own vehicle now mean to leave without an order${asleep ? ` (night: about ${Math.round(WAKE_UP_MINUTES)} min to wake first)` : ""}. Simulated.`,
          households,
        );
      }
    }
    if (zone.selfEvac) keepOpenRoute(board, zone);
  }
}

/**
 * A self-evacuating zone (no order) drives its best open route; it picks again when its route is
 * no longer offered (destination closed or full, road closed: board.routes only offers open
 * destinations, and setRoutes keeps an offered destination's newest route object).
 */
function keepOpenRoute(board: Board, zone: ZoneState): void {
  const options = board.routes.get(zone.id);
  if (!options || options.length === 0) return;
  if (zone.route === null || !options.includes(zone.route)) zone.route = bestRoute(options);
}
