/**
 * Simulated communications on the command board: 911 calls, civilian reports, fire-department,
 * police and EMS radio, generated once per whole board minute from board state (model.ts stepOnce
 * calls stepSimComms) so the AI commander gets a realistic, noisy message stream. Pure board logic:
 * no React, network or LLM. Deterministic: one seeded stream per board (deriveStream(seed,
 * "simcomms")), draws in board order. Every item is `evidence: "simulated"`; nothing here is an
 * observed call. Phrasing: demo/simCommsTemplates.ts (authored, ASSUMPTION).
 *
 * Two kinds of sources:
 *
 * 1. Rate-based, per zone and minute (the Camp 2018 ground record, docs/ground-data-calibration.md
 *    section 2, as sim/gen_comms.py uses it): a Poisson count with rate
 *    exp(intercept + band + phase) per 1,000 households per hour, for the 911 channel and for
 *    radio (police/fire radio about the zone). band: fire_in_zone (a reported fire has touched the
 *    zone), lt_5km (a reported fire within 5 km), else the reference (>= 5 km); phase: before the
 *    zone's order, 0-2 h after it, >= 2 h after it. 911 is scaled by 132 / 36 = 3.67 (the record's
 *    NIST sample against "at least 132" Paradise PD calls, sim/ground_rates.py PPD_911_SOURCE).
 *    Each call's category comes from the record's before/after-arrival category mix (section 3)
 *    and becomes a message about real board state: a fire sighting, a spot fire, a trapped or
 *    help call (only with households still home), traffic on the zone's loaded route segment, a
 *    road report. Calls start only once a fire is reported (the first call is the report).
 * 2. Event-based, from board transitions: a fire's report (911 or camera / satellite, as
 *    response/report.ts drew it), unit status changes (dispatched, on scene, refilling, returning,
 *    cut off by fire, line progress, line overrun, escalation requests at the run-card stages),
 *    aircraft drops, containment, zones reached by fire, evacuation door-to-door progress, queues
 *    on evacuation roads, controller road closures, and the injuries lead D2 pushes into
 *    board.simComms.injuries (911 call on the injury, EMS radio on its status).
 *
 * Noise (docs/adr/0042-adversarial-ground-data.md "typical" profile, sim/gen_noise.py; all
 * ASSUMPTION there except the Camp echo shares): repeat callers about the same event (share
 * 0.0861 of reports, 1 / 2 / 4 extra with weights 18 / 6 / 2 within 15 min: CALIBRATED on the
 * Camp record), a wrong road name (0.03), a GPS offset (0.10, sigma 40 m), vague locations (the
 * record's pooled "other" share), sightings from zones >= 5 km from any fire (smoke drift mistaken
 * for a new fire: wrong by construction) and jams reported as road blocks. Wrong items are
 * labelled in a hidden truth map (memo.truth), never in the observation.
 *
 * Not modelled: time-of-day variation in call rates (no source; gen_comms.py
 * ASSUMED_RATES_TIME_HOMOGENEOUS), the per-zone gamma overdispersion and radio bursts of
 * gen_comms.py (left out to keep demo runs low-variance), 911 centre saturation.
 */

import type { LonLat } from "../live/types";
import { deriveStream, standardNormal, uniform, type RngStream } from "../response/rng";
import { ESCALATION_ORDERS, ESCALATION_STAGE_ACRES } from "../response/runCards";
import type { DemoObservation } from "./contracts";
import { isReported } from "./boardResponse";
import { departed, distanceM, withVehicle, type Board, type Fire, type Team, type ZoneState } from "./model";
import { ORDER_COMPLIANCE } from "./realism";
import { boardClosures } from "./roadClosures";
import type { CommsChannel, CommsKind, InjuryEvent, SimCommsItem, SimCommsState } from "./runContracts";
import { RELATIONS, SPEAKERS, TEMPLATES, fillTemplate, type TemplateKey } from "./simCommsTemplates";

// ---- sourced rates ----

/**
 * Camp 2018 Poisson GLM, events per 1,000 households per hour = exp(intercept + band + phase).
 * docs/ground-data-calibration.md section 2 (NIST TN 2252 sample of the 2018 Camp Fire record:
 * 911 rows 15-19Z, radio rows 14Z-10Z), the same coefficients sim/gen_comms.py uses.
 */
export const CAMP_GLM = {
  "911": { intercept: -1.608, fire_in_zone: 2.672, lt_5km: 1.532, order_0_2h: -0.048, order_ge_2h: -2.37 },
  radio: { intercept: -1.397, fire_in_zone: 2.714, lt_5km: 0.579, order_0_2h: 0.14, order_ge_2h: -2.046 },
} as const;
/** True 911 volume / NIST sample, a lower bound: "at least 132" Paradise PD calls 06:30-08:20 PST vs 36 sampled (sim/ground_rates.py PPD_911_SOURCE). */
export const SCALE_911 = 132 / 36;
/** The GLM's distance band edge, metres (docs/ground-data-calibration.md: band lt_5km). */
export const BAND_NEAR_M = 5000;

type Category = "help_needed" | "trapped" | "fire_seen" | "road_blocked" | "heavy_traffic" | "other";
const CATEGORIES: Category[] = ["help_needed", "trapped", "fire_seen", "road_blocked", "heavy_traffic", "other"];
/** Category shares before / after the zone's fire arrival (docs/ground-data-calibration.md section 3, Camp record). */
const MIX: Record<"911" | "radio", Record<"before" | "after", number[]>> = {
  "911": { before: [0.42, 0.04, 0.12, 0.12, 0.0, 0.31], after: [0.41, 0.19, 0.05, 0.03, 0.03, 0.29] },
  radio: { before: [0.14, 0.0, 0.03, 0.1, 0.17, 0.55], after: [0.15, 0.07, 0.08, 0.08, 0.18, 0.45] },
};

/** CALIBRATED (sim/gen_noise.py CROWD_ECHO_SHARE_CAMP): share of reports that get same-event reports from other callers. */
export const ECHO_SHARE = 26 / 302;
/** CALIBRATED (sim/gen_noise.py CROWD_ECHO_EXTRA_DIST_CAMP): extra reports per echoed event, (count, weight). */
const ECHO_EXTRA: [number, number][] = [
  [1, 18],
  [2, 6],
  [4, 2],
];
/** sim/gen_noise.py CROWD_ECHO_WINDOW_MIN: echoes come within this many minutes. */
const ECHO_WINDOW_MIN = 15;
/** ASSUMPTION (ADR 0042 "typical" profile, sim/gen_noise.py): wrong road name, GPS offset share and sigma. */
export const WRONG_ROAD_SHARE = 0.03;
export const GPS_OFFSET_SHARE = 0.1;
export const GPS_OFFSET_SIGMA_M = 40;

// ---- assumptions (no source) ----

/** ASSUMPTION: share of rate-based 911-channel sightings, smoke and traffic reports that arrive as civilian posts / walk-up reports instead. */
export const CIVILIAN_SHARE = 0.25;
/** ASSUMPTION: a zone counts as "fire in zone" for this long after the fire last touched it, minutes. */
export const FIRE_IN_ZONE_HOLD_MIN = 60;
/** ASSUMPTION: police radio reports a queue on an evacuation road from this many vehicles, at most once per segment per QUEUE_REPEAT_MIN. */
export const QUEUE_ALERT_VEH = 30;
export const QUEUE_REPEAT_MIN = 20;
/** ASSUMPTION: at most this many queue reports per board minute (the longest queues). */
export const QUEUE_ALERTS_PER_MIN = 3;
/**
 * ASSUMPTION: zones farther than this from every reported fire make no fire-related calls. The GLM's
 * reference band (>= 5 km) was fitted on Camp zones that were all near the fire; a 30-60 km board
 * reaches far beyond that.
 */
export const FAR_CALLS_MAX_M = 10_000;
/** ASSUMPTION: dispatch repeats an injury still waiting for a unit every this many minutes. */
export const INJURY_REMINDER_MIN = 15;
/** ASSUMPTION: rate-of-spread words for the size-up, by head rate m/min (upper bounds). */
const SPREAD_WORDS: [number, string][] = [
  [1, "slow"],
  [5, "moderate"],
  [20, "rapid"],
  [Infinity, "extreme"],
];

/** Items kept on the board, and what the observation shows (newest, most severe first). */
export const SIM_COMMS_MAX_ITEMS = 400;
export const SIM_COMMS_RECENT_MAX = 25;
export const SIM_COMMS_RECENT_WINDOW_MIN = 30;
export const SIM_COMMS_OPEN_INJURIES_MAX = 25;

const CHANNELS: CommsChannel[] = ["911", "civilian_report", "fd_radio", "pd_radio", "ems_radio"];
const ACRES_PER_HA = 2.4710538;

// ---- state ----

interface Echo {
  at: number;
  channel: CommsChannel;
  kind: CommsKind;
  key: TemplateKey;
  vars: Record<string, string | number>;
  zoneId: string | null;
  coord: LonLat | null;
  severity: SimCommsItem["severity"];
  injuryId: string | null;
}

interface Memo {
  lastMinute: number;
  counts: Record<CommsChannel, number>;
  teamStatus: Record<string, string>;
  teamCut: Record<string, number>;
  fireReported: Record<string, true>;
  fireStatus: Record<string, string>;
  fireStage: Record<string, number>;
  incident: Record<string, string>;
  sizedUp: Record<string, true>;
  lineStage: Record<string, number>;
  aircraftDrops: Record<string, number>;
  zoneEvac: Record<string, number>;
  zoneOverrun: Record<string, true>;
  segAlertAt: Record<string, number>;
  closures: Record<string, true>;
  injuryStatus: Record<string, string>;
  injuryRemindAt: Record<string, number>;
  seenEvents: string[];
  echoes: Echo[];
  /** Hidden truth for wrong items (item id -> what is wrong); never sent to the agent. */
  truth: Record<string, string>;
}

/** Board.simComms as this module keeps it: the shared contract plus its seeded stream and memory. */
export interface SimCommsBoardState extends SimCommsState {
  rng: RngStream;
  memo: Memo;
}

function emptyMemo(): Memo {
  return {
    lastMinute: -1,
    counts: { "911": 0, civilian_report: 0, fd_radio: 0, pd_radio: 0, ems_radio: 0 },
    teamStatus: {},
    teamCut: {},
    fireReported: {},
    fireStatus: {},
    fireStage: {},
    incident: {},
    sizedUp: {},
    lineStage: {},
    aircraftDrops: {},
    zoneEvac: {},
    zoneOverrun: {},
    segAlertAt: {},
    closures: {},
    injuryStatus: {},
    injuryRemindAt: {},
    seenEvents: [],
    echoes: [],
    truth: {},
  };
}

/** A fresh Board.simComms (createBoard). */
export function createSimComms(seed: number): SimCommsBoardState {
  return { items: [], injuries: [], nextId: 1, rng: deriveStream(seed, "simcomms"), memo: emptyMemo() };
}

/** Board.simComms, created (or completed, if another module created the bare contract) on first use. */
export function ensureSimComms(board: Board): SimCommsBoardState {
  const b = board as Board & { simComms?: SimCommsState };
  if (!b.simComms) b.simComms = createSimComms(board.seed);
  const s = b.simComms as SimCommsState & Partial<SimCommsBoardState>;
  s.rng ??= deriveStream(board.seed, "simcomms");
  s.memo ??= emptyMemo();
  return s as SimCommsBoardState;
}

// ---- small helpers ----

function pick<T>(rng: RngStream, list: readonly T[]): T {
  return list[Math.min(list.length - 1, Math.floor(uniform(rng) * list.length))];
}

function poisson(rng: RngStream, lambda: number): number {
  if (!(lambda > 0)) return 0;
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = uniform(rng);
  while (p > limit && k < 50) {
    k += 1;
    p *= uniform(rng);
  }
  return k;
}

function weighted<T>(rng: RngStream, items: readonly T[], weights: readonly number[]): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let u = uniform(rng) * total;
  for (let i = 0; i < items.length; i += 1) {
    u -= weights[i];
    if (u < 0) return items[i];
  }
  return items[items.length - 1];
}

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

const M_PER_DEG = 111_320;
function offset(p: LonLat, eastM: number, northM: number): LonLat {
  return [p[0] + eastM / (M_PER_DEG * Math.cos((p[1] * Math.PI) / 180)), p[1] + northM / M_PER_DEG];
}

function round5(p: LonLat | null): LonLat | null {
  return p ? [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5] : null;
}

const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
function compass(from: LonLat, to: LonLat): string {
  const dx = (to[0] - from[0]) * Math.cos((from[1] * Math.PI) / 180);
  const dy = to[1] - from[1];
  const deg = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  return COMPASS[Math.round(deg / 45) % 8];
}

/** A caller's position: somewhere between the zone's centre and its edge. */
function pointIn(rng: RngStream, zone: ZoneState): LonLat {
  if (zone.ring.length < 3) return zone.core;
  const v = pick(rng, zone.ring);
  const u = 0.8 * uniform(rng);
  return [zone.core[0] + (v[0] - zone.core[0]) * u, zone.core[1] + (v[1] - zone.core[1]) * u];
}

/** Named roads near a zone: its route options' first segments (unnamed segments carry an OSM class, lower case). */
function zoneRoads(board: Board, zone: ZoneState): string[] {
  const names: string[] = [];
  const options = board.routes.get(zone.id) ?? [];
  for (const o of options) {
    for (const s of o.segments.slice(0, 4)) if (/[A-Z]/.test(s.name) && !names.includes(s.name)) names.push(s.name);
    for (const v of o.via.slice(0, 2)) if (/[A-Z]/.test(v) && !names.includes(v)) names.push(v);
  }
  return names;
}

function nearestZone(board: Board, p: LonLat): ZoneState | null {
  let best: ZoneState | null = null;
  let bestM = Infinity;
  for (const z of board.zones) {
    const d = distanceM(z.core, p);
    if (d < bestM) {
      bestM = d;
      best = z;
    }
  }
  return best;
}

function unitLabel(team: Team): string {
  const k = team.kind as string;
  const word = k.includes("dozer") ? "Dozer" : k.includes("crew") ? "Crew" : "Engine";
  return `${word} ${team.id}`;
}

function aircraftLabel(kind: string, id: string): string {
  return `${kind === "air_attack" ? "Air Attack" : kind.startsWith("helicopter") ? "Helicopter" : "Tanker"} ${id}`;
}

/** A police unit label, stable per zone or road (generic: the board can be any region). */
function pdUnit(key: string): string {
  return `PD unit ${(hash(key) % 40) + 1}`;
}

function spreadWord(headRate: number): string {
  for (const [max, word] of SPREAD_WORDS) if (headRate < max) return word;
  return "extreme";
}

function acres(ha: number): number {
  const a = ha * ACRES_PER_HA;
  return a < 10 ? Math.max(1, Math.round(a)) : Math.round(a / 5) * 5;
}

function incidentName(board: Board, s: SimCommsBoardState, fire: Fire): string {
  const known = s.memo.incident[fire.id];
  if (known) return known;
  const zone = nearestZone(board, fire.origin);
  const name = `the ${zone ? zone.name : fire.studio.ignition || fire.id} fire (${fire.id})`;
  s.memo.incident[fire.id] = name;
  return name;
}

// ---- emitting ----

interface Draft {
  channel: CommsChannel;
  kind: CommsKind;
  key: TemplateKey;
  vars: Record<string, string | number>;
  zoneId: string | null;
  coord: LonLat | null;
  severity: SimCommsItem["severity"];
  injuryId?: string | null;
  truth?: string;
  /** Calls and posts may echo (repeat callers) and carry location noise; radio does not. */
  public?: boolean;
}

function emit(board: Board, s: SimCommsBoardState, minute: number, d: Draft): SimCommsItem {
  const rng = s.rng;
  const vars = { ...d.vars };
  let truth = d.truth ?? null;
  let coord = d.coord;
  if (d.public) {
    if (vars.road && uniform(rng) < WRONG_ROAD_SHARE) {
      const other = pick(rng, board.zones);
      const roads = zoneRoads(board, other).filter((r) => r !== vars.road);
      if (roads.length) {
        truth = `wrong_road: is ${vars.road}`;
        vars.road = pick(rng, roads);
      }
    }
    if (coord && uniform(rng) < GPS_OFFSET_SHARE) {
      coord = offset(coord, standardNormal(rng) * GPS_OFFSET_SIGMA_M, standardNormal(rng) * GPS_OFFSET_SIGMA_M);
    }
  }
  const item: SimCommsItem = {
    id: `simc-${s.nextId++}`,
    minute,
    channel: d.channel,
    kind: d.kind,
    from: fillTemplate(pick(rng, SPEAKERS[d.key]), vars),
    text: fillTemplate(pick(rng, TEMPLATES[d.key]), vars),
    zoneId: d.zoneId,
    coord: round5(coord),
    severity: d.severity,
    injuryId: d.injuryId ?? null,
    evidence: "simulated",
  };
  s.items.push(item);
  s.memo.counts[d.channel] += 1;
  if (truth) s.memo.truth[item.id] = truth;
  // Repeat callers about the same event (CALIBRATED share and counts), a few minutes apart.
  if (d.public && uniform(rng) < ECHO_SHARE) {
    const extra = weighted(
      rng,
      ECHO_EXTRA.map(([n]) => n),
      ECHO_EXTRA.map(([, w]) => w),
    );
    for (let i = 0; i < extra; i += 1) {
      s.memo.echoes.push({
        at: minute + 1 + Math.floor(uniform(rng) * ECHO_WINDOW_MIN),
        channel: d.channel,
        kind: d.kind,
        key: d.key,
        vars: d.vars,
        zoneId: d.zoneId,
        coord: d.coord,
        severity: d.severity,
        injuryId: d.injuryId ?? null,
      });
    }
  }
  return item;
}

function emitEchoes(board: Board, s: SimCommsBoardState, minute: number): void {
  const due = s.memo.echoes.filter((e) => e.at <= minute);
  if (!due.length) return;
  s.memo.echoes = s.memo.echoes.filter((e) => e.at > minute);
  for (const e of due) {
    const item = emit(board, s, minute, { ...e, public: false });
    if (e.coord) item.coord = round5(offset(e.coord, standardNormal(s.rng) * 100, standardNormal(s.rng) * 100));
  }
}

// ---- the step ----

/** One whole board minute of simulated communications (model.ts stepOnce, every whole minute). */
export function stepSimComms(board: Board, minute: number): void {
  const s = ensureSimComms(board);
  if (minute <= s.memo.lastMinute) return;
  s.memo.lastMinute = minute;
  // One stream per board minute (seed + minute): a draw that depends on asynchronous inputs (route
  // names arriving from the router) cannot shift the draws of later minutes.
  s.rng = deriveStream(board.seed, `simcomms:${minute}`);
  fireReports(board, s, minute);
  unitRadio(board, s, minute);
  fireRadio(board, s, minute);
  lineRadio(board, s, minute);
  aircraftRadio(board, s, minute);
  eventRadio(board, s, minute);
  zoneTraffic(board, s, minute);
  evacuationRadio(board, s, minute);
  queueRadio(board, s, minute);
  closureRadio(board, s, minute);
  injuryComms(board, s, minute);
  emitEchoes(board, s, minute);
  if (s.items.length > SIM_COMMS_MAX_ITEMS) s.items.splice(0, s.items.length - SIM_COMMS_MAX_ITEMS);
  const keepIds = new Set(s.items.map((i) => i.id));
  for (const id of Object.keys(s.memo.truth)) if (!keepIds.has(id)) delete s.memo.truth[id];
}

/** The first report of each fire, at the minute response/report.ts drew for it (911, camera or satellite). */
function fireReports(board: Board, s: SimCommsBoardState, minute: number): void {
  for (const fire of board.fires) {
    if (s.memo.fireReported[fire.id] || !isReported(board, fire)) continue;
    s.memo.fireReported[fire.id] = true;
    const zone = nearestZone(board, fire.origin);
    const by = board.response.fires.get(fire.id)?.report.by ?? "911";
    const roads = zone ? zoneRoads(board, zone) : [];
    const caller = zone ? pointIn(s.rng, zone) : fire.origin;
    const vars = { zone: zone?.name ?? "", road: roads.length ? pick(s.rng, roads) : "", dir: compass(caller, fire.origin) };
    if (by === "camera" || by === "satellite") {
      emit(board, s, minute, { channel: "fd_radio", kind: "fire_sighting", key: "camera_alert_fd", vars, zoneId: zone?.id ?? null, coord: fire.origin, severity: "urgent" });
    } else {
      emit(board, s, minute, { channel: "911", kind: "fire_sighting", key: "first_report_911", vars, zoneId: zone?.id ?? null, coord: caller, severity: "urgent", public: true });
    }
  }
}

/** FD radio on unit status changes (dispatch, arrival and size-up, refill, release, cut off by fire). */
function unitRadio(board: Board, s: SimCommsBoardState, minute: number): void {
  for (const team of board.teams) {
    const prev = s.memo.teamStatus[team.id];
    const now = team.status;
    s.memo.teamStatus[team.id] = now;
    const cuts = team.fireCuts + (team.blockedByFire ? 1 : 0);
    const prevCuts = s.memo.teamCut[team.id] ?? 0;
    s.memo.teamCut[team.id] = cuts;
    const unit = unitLabel(team);
    const fire = team.fireId ? board.fires.find((f) => f.id === team.fireId) : undefined;
    const zone = fire ? nearestZone(board, fire.origin) : nearestZone(board, team.position);
    const base = { zoneId: zone?.id ?? null, coord: team.position };
    if (cuts > prevCuts) {
      const roads = zone ? zoneRoads(board, zone) : [];
      emit(board, s, minute, { ...base, channel: "fd_radio", kind: "road_blocked", key: "unit_cut_off_fd", vars: { unit, road: roads[0] ?? "" }, severity: "urgent" });
    }
    if (prev === undefined || prev === now) continue;
    if (now === "en_route" && fire) {
      const eta = team.arriveAt !== null ? Math.max(1, Math.round(team.arriveAt - minute)) : "";
      emit(board, s, minute, { ...base, channel: "fd_radio", kind: "unit_status", key: "unit_enroute_fd", vars: { unit, incident: incidentName(board, s, fire), minutes: eta }, severity: "info" });
    } else if (now === "on_scene" && fire) {
      const incident = incidentName(board, s, fire);
      if (!s.memo.sizedUp[fire.id]) {
        s.memo.sizedUp[fire.id] = true;
        const vars = { unit, incident, acres: acres(fire.areaHa), spread: spreadWord(fire.headRate), zone: zone?.name ?? "" };
        emit(board, s, minute, { ...base, channel: "fd_radio", kind: "unit_status", key: "unit_onscene_fd", vars, severity: "urgent" });
      } else {
        emit(board, s, minute, { ...base, channel: "fd_radio", kind: "unit_status", key: "unit_arrived_fd", vars: { unit, incident }, severity: "info" });
      }
    } else if (now === "refilling") {
      emit(board, s, minute, { ...base, channel: "fd_radio", kind: "unit_status", key: "unit_refill_fd", vars: { unit }, severity: "info" });
    } else if (now === "returning" && (prev === "on_scene" || prev === "en_route" || prev === "refilling")) {
      emit(board, s, minute, { ...base, channel: "fd_radio", kind: "unit_status", key: "unit_returning_fd", vars: { unit }, severity: "info" });
    }
  }
}

/** Containment, and the incident commander's requests at the run-card escalation stages (response/runCards.ts). */
function fireRadio(board: Board, s: SimCommsBoardState, minute: number): void {
  for (const fire of board.fires) {
    if (!s.memo.fireReported[fire.id]) continue;
    const ic = board.teams.find((t) => t.fireId === fire.id && t.status === "on_scene");
    const prev = s.memo.fireStatus[fire.id];
    s.memo.fireStatus[fire.id] = fire.status;
    const zone = nearestZone(board, fire.origin);
    const incident = incidentName(board, s, fire);
    if (prev === "burning" && fire.status === "contained") {
      emit(board, s, minute, {
        channel: "fd_radio",
        kind: "unit_status",
        key: "contained_fd",
        vars: { unit: ic ? unitLabel(ic) : "Command", incident, acres: acres(fire.areaHa) },
        zoneId: zone?.id ?? null,
        coord: fire.origin,
        severity: "info",
      });
    }
    if (fire.status !== "burning" || !ic) continue;
    const a = fire.areaHa * ACRES_PER_HA;
    const stage = ESCALATION_STAGE_ACRES.filter((x) => a >= x).length;
    if (stage > (s.memo.fireStage[fire.id] ?? 0)) {
      s.memo.fireStage[fire.id] = stage;
      const o = ESCALATION_ORDERS[Math.min(stage, ESCALATION_ORDERS.length) - 1];
      const parts = [
        o.engine_strike_teams ? `${o.engine_strike_teams} engine strike teams` : "",
        o.crew_strike_teams ? `${o.crew_strike_teams} crew strike team${o.crew_strike_teams > 1 ? "s" : ""}` : "",
        o.dozer_strike_teams ? `${o.dozer_strike_teams} dozer strike team${o.dozer_strike_teams > 1 ? "s" : ""}` : "",
        o.airtankers ? `${o.airtankers} air tankers` : "",
        o.helicopters ? `${o.helicopters} helicopter${o.helicopters > 1 ? "s" : ""}` : "",
      ].filter(Boolean);
      emit(board, s, minute, {
        channel: "fd_radio",
        kind: "unit_status",
        key: "unit_request_fd",
        vars: { unit: unitLabel(ic), incident, request: parts.join(", ") },
        zoneId: zone?.id ?? null,
        coord: fire.origin,
        severity: "urgent",
      });
    }
  }
}

/** Attack-line progress: half built, and finished. */
function lineRadio(board: Board, s: SimCommsBoardState, minute: number): void {
  for (const line of board.lines) {
    const stage = line.completedAt !== null ? 2 : line.lengthM > 0 && line.builtM / line.lengthM >= 0.5 ? 1 : 0;
    const prev = s.memo.lineStage[line.id] ?? 0;
    if (stage <= prev) continue;
    s.memo.lineStage[line.id] = stage;
    const crew = board.teams.find((t) => t.lineId === line.id);
    const fire = board.fires.find((f) => f.id === line.fireId);
    if (!crew || !fire) continue;
    const vars = { unit: unitLabel(crew), incident: incidentName(board, s, fire), pct: 50 };
    const key: TemplateKey = stage === 2 ? "unit_line_done_fd" : "unit_line_progress_fd";
    emit(board, s, minute, { channel: "fd_radio", kind: "unit_status", key, vars, zoneId: nearestZone(board, line.plan.point)?.id ?? null, coord: line.plan.point, severity: "info" });
  }
}

/** Aircraft: the first drop on a fire, then every fourth. */
function aircraftRadio(board: Board, s: SimCommsBoardState, minute: number): void {
  for (const a of board.response.aircraft) {
    const prev = s.memo.aircraftDrops[a.id] ?? 0;
    s.memo.aircraftDrops[a.id] = a.drops;
    if (a.drops <= prev || !a.fireId) continue;
    if (!(prev === 0 || Math.floor(a.drops / 4) > Math.floor(prev / 4))) continue;
    const fire = board.fires.find((f) => f.id === a.fireId);
    if (!fire) continue;
    emit(board, s, minute, {
      channel: "fd_radio",
      kind: "unit_status",
      key: "aircraft_drop_fd",
      vars: { unit: aircraftLabel(a.kind, a.id), incident: incidentName(board, s, fire) },
      zoneId: nearestZone(board, fire.origin)?.id ?? null,
      coord: fire.origin,
      severity: "info",
    });
  }
}

/** Board events this module voices: lines overrun by fire (crews pull back), zones reached by fire. */
function eventRadio(board: Board, s: SimCommsBoardState, minute: number): void {
  const fresh: string[] = [];
  for (const e of board.events) {
    if (e.minute < minute - 1) break;
    const key = `${e.minute}|${e.text}`;
    fresh.push(key);
    if (s.memo.seenEvents.includes(key)) continue;
    if (e.refs?.action === "line_overrun") {
      const team = board.teams.find((t) => t.id === e.refs?.teamIds?.[0]);
      const fire = board.fires.find((f) => f.id === e.refs?.fireId);
      if (team && fire) {
        emit(board, s, minute, {
          channel: "fd_radio",
          kind: "unit_status",
          key: "unit_withdraw_fd",
          vars: { unit: unitLabel(team), incident: incidentName(board, s, fire) },
          zoneId: nearestZone(board, team.position)?.id ?? null,
          coord: team.position,
          severity: "urgent",
        });
      }
    }
  }
  s.memo.seenEvents = fresh;
  for (const zone of board.zones) {
    if (zone.overrunAt === null || s.memo.zoneOverrun[zone.id] || zone.knownTouchedAt === null) continue;
    s.memo.zoneOverrun[zone.id] = true;
    const team = board.teams.find((t) => t.status === "on_scene" && distanceM(t.position, zone.core) < BAND_NEAR_M);
    const home = zone.caught;
    emit(board, s, minute, {
      channel: team ? "fd_radio" : "pd_radio",
      kind: "fire_sighting",
      key: "zone_overrun_fd",
      vars: { unit: team ? unitLabel(team) : pdUnit(zone.id), zone: zone.name },
      zoneId: zone.id,
      coord: zone.core,
      severity: home > 0 ? "life_threat" : "urgent",
    });
    if (home > 0) {
      // ASSUMPTION: a zone reached with households still home produces at least one trapped call at once.
      const roads = zoneRoads(board, zone);
      emit(board, s, minute, {
        channel: "911",
        kind: "trapped",
        key: "trapped_911",
        vars: { zone: zone.name, road: roads.length ? pick(s.rng, roads) : "", people: 2 + Math.floor(uniform(s.rng) * 3), relation: pick(s.rng, RELATIONS) },
        zoneId: zone.id,
        coord: pointIn(s.rng, zone),
        severity: "life_threat",
        public: true,
      });
    }
  }
}

type Band = "fire_in_zone" | "lt_5km" | "far";

function zoneBand(zone: ZoneState, minute: number, fires: Fire[]): Band | null {
  if (zone.knownTouchedAt !== null && zone.lastFireAt !== null && minute - zone.lastFireAt <= FIRE_IN_ZONE_HOLD_MIN) return "fire_in_zone";
  let nearest = Infinity;
  for (const f of fires) nearest = Math.min(nearest, Math.max(0, distanceM(zone.core, f.origin) - f.reachM));
  return nearest < BAND_NEAR_M ? "lt_5km" : nearest < FAR_CALLS_MAX_M ? "far" : null;
}

/** Households still home (departed() counts households with a vehicle that left). */
function homeHouseholds(zone: ZoneState, minute: number): number {
  if (zone.overrunAt !== null) return 0;
  return Math.max(0, zone.households - departed(zone, minute));
}

/** The loaded segment of the zone's evacuation route (queue first, then volume / capacity), or null when it carries no traffic. */
function zoneJam(board: Board, zone: ZoneState): { name: string; queue: number; vc: number } | null {
  const route = zone.route ?? zone.pendingOrder?.route ?? null;
  if (!route) return null;
  let best: { name: string; queue: number; vc: number } | null = null;
  for (const seg of route.segments) {
    const queue = board.traffic.queue.get(seg.id) ?? 0;
    const flow = board.traffic.flow.get(seg.id) ?? 0;
    const vc = seg.capacity_veh_h > 0 ? flow / seg.capacity_veh_h : 0;
    if (queue <= 0 && vc <= 0) continue;
    if (!best || queue > best.queue || (queue === best.queue && vc > best.vc)) best = { name: /[A-Z]/.test(seg.name) ? seg.name : "", queue, vc };
  }
  return best;
}

/** Rate-based 911 calls, civilian reports and police radio per zone (Camp GLM and category mix). */
function zoneTraffic(board: Board, s: SimCommsBoardState, minute: number): void {
  const fires = board.fires.filter((f) => f.status !== "out" && s.memo.fireReported[f.id]);
  if (!fires.length) return;
  const rng = s.rng;
  for (const zone of board.zones) {
    if (zone.households <= 0) continue;
    const band = zoneBand(zone, minute, fires);
    if (band === null) continue;
    const sinceOrder = zone.orderedAt === null || zone.orderedAt > minute ? null : minute - zone.orderedAt;
    const phase = sinceOrder === null ? null : sinceOrder < 120 ? "order_0_2h" : "order_ge_2h";
    const after = zone.knownTouchedAt !== null;
    for (const channel of ["911", "radio"] as const) {
      const g = CAMP_GLM[channel];
      const eta = g.intercept + (band === "far" ? 0 : g[band]) + (phase ? g[phase] : 0);
      const lambda = (Math.exp(eta) * (zone.households / 1000) * (channel === "911" ? SCALE_911 : 1)) / 60;
      const n = poisson(rng, lambda);
      for (let i = 0; i < n; i += 1) {
        const category = weighted(rng, CATEGORIES, MIX[channel][after ? "after" : "before"]);
        const draft = channel === "911" ? callDraft(board, s, zone, band, category, minute) : radioDraft(board, s, zone, band, category, minute);
        if (draft) emit(board, s, minute, draft);
      }
    }
  }
}

function callDraft(board: Board, s: SimCommsBoardState, zone: ZoneState, band: Band, category: Category, minute: number): Draft | null {
  const rng = s.rng;
  const roads = zoneRoads(board, zone);
  const road = roads.length ? pick(rng, roads) : "";
  const coord = pointIn(rng, zone);
  const home = homeHouseholds(zone, minute);
  const nearest = board.fires.filter((f) => f.status !== "out" && s.memo.fireReported[f.id]).sort((a, b) => distanceM(zone.core, a.origin) - distanceM(zone.core, b.origin))[0];
  const dir = nearest ? compass(zone.core, nearest.origin) : "";
  const civilian = uniform(rng) < CIVILIAN_SHARE;
  const base = { zoneId: zone.id, coord, public: true };
  const vars = { zone: zone.name, road, dir, people: 1 + Math.floor(uniform(rng) * 4), relation: pick(rng, RELATIONS) };
  if (category === "trapped" && (band === "far" || home <= 0)) category = "help_needed";
  if (category === "help_needed" && home <= 0) category = zone.orderedAt !== null && zoneJam(board, zone) ? "heavy_traffic" : "other";
  // Far from the fire and not ordered out, a help call is a question about whether to leave.
  if (category === "help_needed" && band === "far" && zone.orderedAt === null) category = "other";
  if (category === "road_blocked") {
    const jam = zoneJam(board, zone);
    if (!jam || jam.queue <= 0) category = "other";
    else return { ...base, channel: "911", kind: "road_blocked", key: "road_blocked_911", vars: { ...vars, road: jam.name || road }, severity: "urgent", truth: "wrong_kind: a queue, not a blocked road" };
  }
  if (category === "heavy_traffic") {
    const jam = zoneJam(board, zone);
    if (!jam) category = "other";
    else {
      const minutes = Math.max(5, Math.round(jam.queue > 0 ? jam.queue / 10 : 5));
      return civilian
        ? { ...base, channel: "civilian_report", kind: "traffic", key: "traffic_civilian", vars: { ...vars, road: jam.name || road, minutes }, severity: "info" }
        : { ...base, channel: "911", kind: "traffic", key: "traffic_911", vars: { ...vars, road: jam.name || road }, severity: "urgent" };
    }
  }
  switch (category) {
    case "help_needed": {
      const noCar = zone.noVehicle + zone.carlessGivenCar > 0 && uniform(rng) < (zone.noVehicle + zone.carlessGivenCar) / Math.max(1, zone.households) + 0.2;
      return { ...base, channel: "911", kind: "trapped", key: noCar ? "trapped_no_car_911" : "help_evac_911", vars, severity: "urgent" };
    }
    case "trapped":
      return { ...base, channel: "911", kind: "trapped", key: "trapped_911", vars, severity: "life_threat" };
    case "fire_seen":
      if (band === "far") return { ...base, channel: "911", kind: "fire_sighting", key: "false_report_911", vars, severity: "urgent", truth: "false_report: no fire within 5 km" };
      if (band === "fire_in_zone") {
        return civilian
          ? { ...base, channel: "civilian_report", kind: "fire_sighting", key: "homes_burning_civilian", vars, severity: "urgent" }
          : { ...base, channel: "911", kind: "spot_fire", key: "spot_fire_911", vars, severity: "urgent" };
      }
      return { ...base, channel: civilian ? "civilian_report" : "911", kind: "fire_sighting", key: civilian ? "smoke_civilian" : "sighting_dup_911", vars: { ...vars, size: pick(rng, ["small", "big", "huge"]) }, severity: "info" };
    default:
      if (civilian) return { ...base, channel: "civilian_report", kind: "other", key: "smoke_civilian", vars, severity: "info" };
      if (band !== "far" && uniform(rng) < 0.5) return { ...base, channel: "911", kind: "fire_sighting", key: "sighting_vague_911", vars, severity: "info" };
      return { ...base, channel: "911", kind: "other", key: "other_911", vars, severity: "info" };
  }
}

function radioDraft(board: Board, s: SimCommsBoardState, zone: ZoneState, band: Band, category: Category, minute: number): Draft | null {
  const rng = s.rng;
  const roads = zoneRoads(board, zone);
  const road = roads.length ? pick(rng, roads) : "";
  const home = homeHouseholds(zone, minute);
  const base = { channel: "pd_radio" as const, zoneId: zone.id, coord: pointIn(rng, zone) };
  const vars = { unit: pdUnit(zone.id), zone: zone.name, road };
  if (category === "trapped" && (band === "far" || home <= 0)) category = "help_needed";
  if (category === "help_needed" && (home <= 0 || (band === "far" && zone.orderedAt === null))) category = "other";
  switch (category) {
    case "help_needed":
      return { ...base, kind: "trapped", key: "evac_help_pd", vars, severity: "urgent" };
    case "trapped":
      return { ...base, kind: "trapped", key: "trapped_radio", vars, severity: "life_threat" };
    case "fire_seen":
      return band === "far" ? { ...base, kind: "other", key: "other_radio", vars, severity: "info" } : { ...base, kind: "fire_sighting", key: "fire_seen_radio", vars, severity: "urgent" };
    case "road_blocked":
    case "heavy_traffic": {
      const jam = zoneJam(board, zone);
      if (!jam) return { ...base, kind: "other", key: "other_radio", vars, severity: "info" };
      return { ...base, kind: "traffic", key: "traffic_pd", vars: { ...vars, road: jam.name || road, queue: Math.round(jam.queue) }, severity: jam.queue > 0 ? "urgent" : "info" };
    }
    default:
      return { ...base, kind: "other", key: "other_radio", vars, severity: "info" };
  }
}

/** Police door-to-door once a zone's order takes effect: started, half out, clear (and those who stay). */
function evacuationRadio(board: Board, s: SimCommsBoardState, minute: number): void {
  for (const zone of board.zones) {
    if (zone.orderedAt === null || zone.orderedAt > minute) continue;
    const stage = s.memo.zoneEvac[zone.id] ?? 0;
    const cars = withVehicle(zone);
    const left = departed(zone, minute);
    const share = cars > 0 ? left / cars : 1;
    const unit = pdUnit(zone.id);
    const base = { channel: "pd_radio" as const, kind: "evacuation_status" as const, zoneId: zone.id, coord: zone.core };
    if (stage < 1) {
      s.memo.zoneEvac[zone.id] = 1;
      emit(board, s, minute, { ...base, key: "evac_start_pd", vars: { unit, zone: zone.name }, severity: "info" });
    } else if (stage < 2 && share >= 0.5) {
      s.memo.zoneEvac[zone.id] = 2;
      emit(board, s, minute, { ...base, key: "evac_progress_pd", vars: { unit, zone: zone.name, pct: Math.floor(share * 10) * 10 }, severity: "info" });
    } else if (stage < 3 && share >= 0.95 * ORDER_COMPLIANCE) {
      s.memo.zoneEvac[zone.id] = 3;
      emit(board, s, minute, { ...base, key: "evac_clear_pd", vars: { unit, zone: zone.name }, severity: "info" });
      const stay = zone.households - left;
      if (stay > 0) emit(board, s, minute, { ...base, key: "evac_refusal_pd", vars: { unit, zone: zone.name, count: stay }, severity: "urgent" });
    }
  }
}

/** Police radio on queues building on evacuation road segments (traffic.ts point queues). */
function queueRadio(board: Board, s: SimCommsBoardState, minute: number): void {
  const due = [...board.traffic.queue]
    .filter(([segId, queue]) => queue >= QUEUE_ALERT_VEH && !(minute - (s.memo.segAlertAt[segId] ?? -Infinity) < QUEUE_REPEAT_MIN))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, QUEUE_ALERTS_PER_MIN);
  for (const [segId, queue] of due) {
    s.memo.segAlertAt[segId] = minute;
    const seg = board.traffic.segments.get(segId);
    const name = seg && /[A-Z]/.test(seg.name) ? seg.name : "";
    const zone = board.zones.find((z) => z.route?.segments.some((x) => x.id === segId)) ?? null;
    emit(board, s, minute, {
      channel: "pd_radio",
      kind: "traffic",
      key: "traffic_pd",
      vars: { unit: pdUnit(segId), road: name || (zone ? `the route out of ${zone.name}` : ""), queue: Math.round(queue) },
      zoneId: zone?.id ?? null,
      coord: zone?.core ?? null,
      severity: "urgent",
    });
  }
}

/** Police radio on controller road closures as the board applies them (roadClosures.ts). */
function closureRadio(board: Board, s: SimCommsBoardState, minute: number): void {
  for (const { closure } of boardClosures(board)) {
    if (s.memo.closures[closure.segmentId]) continue;
    s.memo.closures[closure.segmentId] = true;
    const mid = closure.line[Math.floor(closure.line.length / 2)] ?? null;
    emit(board, s, minute, {
      channel: "pd_radio",
      kind: "road_blocked",
      key: "road_closed_pd",
      vars: { unit: pdUnit(closure.segmentId), road: closure.name },
      zoneId: mid ? (nearestZone(board, mid)?.id ?? null) : null,
      coord: mid,
      severity: "urgent",
    });
  }
}

const INJURY_KEY: Record<InjuryEvent["cause"], TemplateKey> = {
  burn: "injury_burn_911",
  smoke: "injury_smoke_911",
  vehicle_crash: "injury_crash_911",
  medical: "injury_medical_911",
};
const CAUSE_WORDS: Record<InjuryEvent["cause"], string> = { burn: "burn injuries", smoke: "smoke inhalation", vehicle_crash: "vehicle accident", medical: "medical emergency" };

/** 911 calls on the injuries lead D2 records (board.simComms.injuries) and EMS radio on their status. */
function injuryComms(board: Board, s: SimCommsBoardState, minute: number): void {
  for (const inj of s.injuries) {
    const prev = s.memo.injuryStatus[inj.id];
    s.memo.injuryStatus[inj.id] = inj.status;
    const zone = inj.zoneId ? board.zones.find((z) => z.id === inj.zoneId) : nearestZone(board, inj.coord);
    const roads = zone ? zoneRoads(board, zone) : [];
    const severe = inj.severity !== "minor";
    const unit = inj.assignedUnitId ?? "Medic unit";
    const vars = { zone: zone?.name ?? "", road: roads.length ? pick(s.rng, roads) : "", people: inj.people, relation: pick(s.rng, RELATIONS), unit, cause: CAUSE_WORDS[inj.cause] };
    const base = { zoneId: zone?.id ?? inj.zoneId, coord: inj.coord, injuryId: inj.id };
    if (prev === undefined) {
      emit(board, s, minute, { ...base, channel: "911", kind: inj.cause === "medical" ? "medical" : "injury", key: INJURY_KEY[inj.cause], vars, severity: severe ? "life_threat" : "urgent", public: true });
      s.memo.injuryRemindAt[inj.id] = minute + INJURY_REMINDER_MIN;
    }
    if (prev !== undefined && prev !== inj.status) {
      const key: TemplateKey | null =
        inj.status === "unit_en_route" ? "ems_dispatched" : inj.status === "treated" ? "ems_onscene" : inj.status === "transported" ? "ems_transport" : inj.status === "died" ? "ems_fatal" : null;
      if (key) emit(board, s, minute, { ...base, channel: "ems_radio", kind: inj.cause === "medical" ? "medical" : "injury", key, vars, severity: inj.status === "died" ? "urgent" : "info" });
    }
    if (inj.status === "waiting" && minute >= (s.memo.injuryRemindAt[inj.id] ?? Infinity)) {
      s.memo.injuryRemindAt[inj.id] = minute + INJURY_REMINDER_MIN;
      emit(board, s, minute, { ...base, channel: "ems_radio", kind: inj.cause === "medical" ? "medical" : "injury", key: "ems_waiting", vars: { ...vars, minutes: Math.round(minute - inj.minute) }, severity: severe ? "life_threat" : "urgent" });
    }
  }
}

// ---- observation ----

const SEVERITY_RANK: Record<SimCommsItem["severity"], number> = { life_threat: 2, urgent: 1, info: 0 };

/**
 * observation.sim_comms: the last SIM_COMMS_RECENT_WINDOW_MIN minutes of messages, at most
 * SIM_COMMS_RECENT_MAX (most severe first when there are more, then shown newest first), the
 * injuries still waiting or with a unit on the way, and run totals per channel. Undefined before
 * the board has a simComms state.
 */
export function simCommsObservation(board: Board): DemoObservation["sim_comms"] {
  const s = (board as Board & { simComms?: SimCommsState }).simComms;
  if (!s) return undefined;
  const from = board.minute - SIM_COMMS_RECENT_WINDOW_MIN;
  const recent = s.items
    .filter((i) => i.minute >= from)
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.minute - a.minute)
    .slice(0, SIM_COMMS_RECENT_MAX)
    .sort((a, b) => b.minute - a.minute);
  const open_injuries = s.injuries.filter((i) => i.status === "waiting" || i.status === "unit_en_route").slice(-SIM_COMMS_OPEN_INJURIES_MAX);
  const memo = (s as Partial<SimCommsBoardState>).memo;
  const counts = memo
    ? { ...memo.counts }
    : (Object.fromEntries(CHANNELS.map((c) => [c, s.items.filter((i) => i.channel === c).length])) as Record<CommsChannel, number>);
  return { recent, open_injuries, counts };
}
