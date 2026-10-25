/**
 * Display-ready digests for the right-hand panel of /run and /live (AgentInputsPanel.tsx):
 * - `incidentStatus`: the live board's own state (fires, area burned, homes lost, people), read
 *   from the board and scorePoint.ts, never from the agent's last observation;
 * - `knowsNow`: a compact picture of the LATEST observation Claude was sent;
 * - `describeActions`: plain one-line actions for the orders of one decision.
 * Pure: no React, network or clock. Every number is copied or unit-converted from the board or
 * the observation (simulator output); this module computes no model values (AGENTS.md: an LLM
 * never invents numbers, and neither does the UI).
 *
 * Units: minutes are board minutes from T+0; area is shown in acres (1 ha = 2.47105 acres, from
 * 1 acre = 4,046.856 m2) with hectares second; wind in mph (1 m/s = 2.23694 mph); head spread in
 * m/min; volume/capacity is a ratio of vehicles/h over vehicles/h.
 */

import type { CommanderOrder, DemoObservation } from "./contracts";
import { isReported } from "./boardResponse";
import { compass, digestInput, MPH_PER_M_S, type CommsRow } from "./agentInputsDigest";
import { nf, simClock, tidyMinutes } from "./format";
import { emsObservation } from "./injuries";
import type { Board, Fire, ZoneForecast } from "./model";
import type { AgentInputSnapshot } from "./runContracts";
import { scorePoint } from "./scorePoint";
import type { AgentDecision } from "./useDemoAgent";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

/** Acres in one hectare (1 acre = 4,046.856 m2; 10,000 / 4,046.856). */
export const ACRES_PER_HA = 2.47105;

/** "842" / "7.4": whole acres from 10 up, one decimal below. */
const acreText = (ha: number): string => {
  const a = ha * ACRES_PER_HA;
  return a < 10 ? a.toFixed(1) : nf(a);
};
const haText = (ha: number): string => (ha < 10 ? ha.toFixed(1) : nf(ha));
const rateText = (m: number): string => (m < 10 ? m.toFixed(1) : nf(m));
const plural = (n: number, one: string, many = `${one}s`): string => `${nf(n)} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------------------------
// Incident status (the live board)
// ---------------------------------------------------------------------------------------------

export interface IncidentFireRow {
  key: string;
  /** Fire id on the board ("S1-Ignition1"). */
  title: string;
  status: { text: string; tone: Tone };
  /** True when dispatch has been told (the agent sees only reported fires). */
  reported: boolean;
  /** "842 ac (341 ha)". */
  size: string;
  /** "spreading 18 m/min toward NE (45°)", "contained at T+01:10", "out at T+02:00". */
  spread: string;
}

export interface StatCell {
  key: string;
  label: string;
  value: string;
  /** Second line: the other unit or the method note. */
  sub: string | null;
  title?: string;
}

export interface IncidentStatus {
  clockLabel: string;
  fires: IncidentFireRow[];
  /** Fires beyond the list cap. */
  firesMore: number;
  stats: StatCell[];
  /** Units committed to a fire or an injury now, with the fleet size. */
  units: { key: string; label: string; committed: number; total: number; title: string }[];
  /** True when people are not known for every zone, so "caught" counts households. */
  caughtIsHouseholds: boolean;
}

const MAX_STATUS_FIRES = 4;

const statusOf = (fire: Fire): IncidentFireRow["status"] =>
  fire.status === "burning" ? { text: "Burning", tone: "danger" } : fire.status === "contained" ? { text: "Contained", tone: "success" } : { text: "Out", tone: "success" };

function fireSpread(fire: Fire): string {
  if (fire.status === "contained") return fire.containedAt !== null ? `contained at ${simClock(fire.containedAt)}` : "contained";
  if (fire.status === "out") return fire.outAt !== null ? `out at ${simClock(fire.outAt)}` : "out";
  const rate = fire.rates.headMetersPerMinute;
  if (fire.noSpread || !(rate > 0)) return "not spreading now";
  return `spreading ${rateText(rate)} m/min toward ${compass(fire.rates.headingDegrees)} (${Math.round(fire.rates.headingDegrees)}°)`;
}

/** The incident now, from the live board (fires) and scorePoint.ts (the run's totals). */
export function incidentStatus(board: Board, forecasts: Map<string, ZoneForecast>): IncidentStatus {
  const point = scorePoint(board, forecasts);
  const ordered = [...board.fires].sort((a, b) => {
    const rank = (f: Fire) => (f.status === "burning" ? 0 : f.status === "contained" ? 1 : 2);
    return rank(a) - rank(b) || b.areaHa - a.areaHa;
  });
  const fires = ordered.slice(0, MAX_STATUS_FIRES).map(
    (f): IncidentFireRow => ({
      key: f.id,
      title: f.id,
      status: statusOf(f),
      reported: isReported(board, f),
      size: `${acreText(f.areaHa)} ac (${haText(f.areaHa)} ha)`,
      spread: fireSpread(f),
    }),
  );

  // Ground units sent to a fire (en route, on scene or refilling there); ambulances and aircraft apart.
  const ground = board.teams.filter((t) => t.kind !== "ambulance");
  const committed = (kinds: string[]) => ground.filter((t) => kinds.includes(t.kind) && t.fireId !== null && (t.status === "en_route" || t.status === "on_scene" || t.status === "refilling")).length;
  const fleet = (kinds: string[]) => ground.filter((t) => kinds.includes(t.kind)).length;
  const engines = ["engine_t3", "engine_t1"];
  const crews = ["hand_crew_t1", "dozer_t2"];
  const air = board.response.aircraft;
  const ems = emsObservation(board);

  const caughtIsHouseholds = board.caughtPeopleTotal === null;
  // The same sum as scoring.ts runScore, without its rounding to 0.1 ha, so the total matches the fire rows.
  const areaHa = board.fires.reduce((sum, f) => sum + f.areaHa, board.removedBurnedHa);
  return {
    clockLabel: simClock(board.minute),
    fires,
    firesMore: Math.max(0, ordered.length - fires.length),
    stats: [
      { key: "area", label: "Burned", value: `${acreText(areaHa)} ac`, sub: `${haText(areaHa)} ha` },
      {
        key: "homes",
        label: "Homes lost",
        value: nf(point.homesBurned),
        sub: "estimate",
        title: "Estimated: each zone's homes are assumed spread evenly over its developed ground, so this is the share of that ground that burned (demo/scoring.ts).",
      },
      { key: "caught", label: "Caught by fire", value: nf(point.caughtPeople), sub: caughtIsHouseholds ? "households" : "people" },
      { key: "injured", label: "Injured", value: nf(point.injured), sub: "people" },
      { key: "safe", label: "Safe (evacuated)", value: nf(point.peopleSafe), sub: "people" },
      {
        key: "risk",
        label: "Still at risk",
        value: nf(point.peopleAtRisk),
        sub: "people home",
        title: "People still at home in zones the fire has touched or is forecast to reach (the commander's forecast).",
      },
    ],
    units: [
      { key: "engines", label: "Engines", committed: committed(engines), total: fleet(engines), title: "Engines sent to a fire (en route, on scene or refilling)" },
      { key: "crews", label: "Crews, dozers", committed: committed(crews), total: fleet(crews), title: "Hand crews and dozers sent to a fire" },
      { key: "aircraft", label: "Aircraft", committed: air.filter((a) => a.status === "en_route" || a.status === "over_fire").length, total: air.length, title: "Aircraft en route to or over a fire" },
      { key: "ambulances", label: "Ambulances", committed: ems.responding + ems.treating, total: ems.ambulances, title: "Ambulances responding to or treating a patient" },
    ],
    caughtIsHouseholds,
  };
}

// ---------------------------------------------------------------------------------------------
// What Claude knows now (the latest observation)
// ---------------------------------------------------------------------------------------------

export interface KnowsFire {
  key: string;
  title: string;
  status: { text: string; tone: Tone };
  /** "341 ha (843 ac)". */
  size: string;
  /** "head 18 m/min toward NE (45°); perimeter +45 m/min". */
  growth: string;
}

export interface KnowsZone {
  key: string;
  name: string;
  /** "fire at the edge in 24 min", or null. */
  eta: string | null;
  /** Share of the zone burned at each horizon ("12%"), "-" when the observation has no forecast. */
  burned: string[];
  order: { text: string; tone: Tone; title: string };
}

export interface KnowsRoad {
  key: string;
  name: string;
  detail: string;
  danger: boolean;
}

export interface KnowsUnits {
  key: string;
  label: string;
  total: number;
  available: number;
  enRoute: number;
  onScene: number;
}

export interface KnowsNow {
  minute: number;
  clockLabel: string;
  urgency: "urgent" | "routine";
  /** Wake reasons, tidy minutes, "Since the last decision" line last. */
  reasons: string[];
  wind: string;
  fires: KnowsFire[];
  zoneHorizons: number[];
  zones: KnowsZone[];
  zonesMore: number;
  roadsNow: string;
  roads: KnowsRoad[];
  units: KnowsUnits[];
  comms: CommsRow[];
  commsMore: number;
}

const MAX_KNOWS_ZONES = 4;
const MAX_KNOWS_ROADS = 2;
const MAX_KNOWS_COMMS = 4;
const DEFAULT_HORIZONS = [30, 60, 120];

const ORDER_WORDS: Record<DemoObservation["zones"][number]["order"]["status"], { text: string; tone: Tone; title: string }> = {
  warning: { text: "Be ready", tone: "warning", title: "Evacuation warning" },
  lifted: { text: "All clear", tone: "success", title: "Evacuation order lifted" },
  none: { text: "No order", tone: "neutral", title: "No evacuation order" },
  scheduled: { text: "Scheduled", tone: "warning", title: "Evacuation order scheduled to start later" },
  leaving: { text: "Leaving", tone: "info", title: "Evacuation order in effect, households leaving" },
  done: { text: "Done", tone: "success", title: "Everyone the order sends out has arrived" },
  overrun: { text: "Overrun", tone: "danger", title: "The fire has overrun the zone" },
};

const pct = (n: number): string => (n > 0 && n < 1 ? "<1%" : `${Math.round(n)}%`);

/** The latest call's observation as a compact picture (numbers copied from it). */
export function knowsNow(input: AgentInputSnapshot, previous: AgentInputSnapshot | null): KnowsNow {
  const obs = input.observation;
  const pred = obs.predicted;
  const horizons = pred?.horizons_min?.length ? pred.horizons_min : DEFAULT_HORIZONS;

  const fires = obs.fires.map(
    (f): KnowsFire => ({
      key: f.id,
      title: f.id,
      status: f.status === "burning" ? { text: "Burning", tone: "danger" } : f.status === "contained" ? { text: "Contained", tone: "success" } : { text: "Out", tone: "success" },
      size: `${haText(f.area_ha)} ha (${acreText(f.area_ha)} ac)`,
      growth:
        f.status === "burning"
          ? `head ${rateText(f.head_m_per_min)} m/min toward ${compass(f.heading_deg)} (${Math.round(f.heading_deg)}°); perimeter ${f.perimeter_growth_m_per_min >= 0 ? "+" : ""}${rateText(f.perimeter_growth_m_per_min)} m/min`
          : `${Math.round(f.containment_pct)}% contained`,
    }),
  );

  const zoneById = new Map(obs.zones.map((z) => [z.id, z]));
  const rows: KnowsZone[] = [];
  const seen = new Set<string>();
  const add = (id: string, burned: number[] | null, edgeEta: number | null) => {
    const z = zoneById.get(id);
    if (seen.has(id)) return;
    seen.add(id);
    const eta = edgeEta ?? z?.fire_eta_min ?? null;
    rows.push({
      key: id,
      name: z?.name ?? id,
      eta: eta === null ? null : eta <= 0 ? "fire at the zone now" : `fire at the edge in ${nf(eta)} min`,
      burned: horizons.map((_, i) => (burned && burned[i] !== undefined ? pct(burned[i]) : "-")),
      order: ORDER_WORDS[z?.order.status ?? "none"],
    });
  };
  if (pred) for (const p of pred.zones) add(p.zone_id, p.burned_pct, p.edge_eta_min);
  // Without a forecast block (or for threatened zones it leaves out): the zones the observation lists, soonest fire first.
  [...obs.zones]
    .filter((z) => z.fire_eta_min !== null || z.order.status === "overrun")
    .sort((a, b) => (a.fire_eta_min ?? Infinity) - (b.fire_eta_min ?? Infinity))
    .forEach((z) => add(z.id, null, z.fire_eta_min));

  const w = obs.traffic.worst_segment;
  const roadsNow =
    obs.traffic.vehicles_on_road === 0
      ? "No evacuation traffic on the roads."
      : `${plural(obs.traffic.vehicles_on_road, "vehicle")} on the road${
          w
            ? `; worst now ${w.name}: volume/capacity ${(w.flow_veh_h / Math.max(1, w.capacity_veh_h)).toFixed(2)} (${nf(w.flow_veh_h)} of ${nf(w.capacity_veh_h)} veh/h)${w.queue_vehicles > 0 ? `, queue ${plural(w.queue_vehicles, "vehicle")}` : ""}`
            : ""
        }`;
  const roads = (pred?.segments ?? []).slice(0, MAX_KNOWS_ROADS).map(
    (s): KnowsRoad => ({
      key: s.segment_id,
      name: s.name || s.segment_id,
      detail: `peak volume/capacity ${s.peak_vc.toFixed(2)}${s.peak_queue_vehicles > 0 ? `, queue ${nf(s.peak_queue_vehicles)} veh` : ""}${s.danger ? "; fire reaches it before its traffic clears" : s.fire_eta_min !== null ? `; fire ${nf(s.fire_eta_min)} min away` : ""}`,
      danger: s.danger,
    }),
  );

  const count = (rows: { status: string }[], enRoute: string[], onScene: string[]) => ({
    available: rows.filter((r) => r.status === "available").length,
    enRoute: rows.filter((r) => enRoute.includes(r.status)).length,
    onScene: rows.filter((r) => onScene.includes(r.status)).length,
  });
  const ground = obs.crews.filter((c) => c.kind !== "ambulance");
  const kindsOf = (...kinds: string[]) => ground.filter((c) => kinds.includes(c.kind));
  const units: KnowsUnits[] = [];
  const addUnits = (key: string, label: string, list: { status: string }[], enRoute: string[], onScene: string[]) => {
    if (list.length > 0) units.push({ key, label, total: list.length, ...count(list, enRoute, onScene) });
  };
  addUnits("engines", "Engines", kindsOf("engine_t3", "engine_t1"), ["en_route", "moving_up"], ["on_scene"]);
  addUnits("crews", "Hand crews", kindsOf("hand_crew_t1"), ["en_route", "moving_up"], ["on_scene"]);
  addUnits("dozers", "Dozers", kindsOf("dozer_t2"), ["en_route", "moving_up"], ["on_scene"]);
  addUnits("aircraft", "Aircraft", obs.response.aircraft, ["en_route"], ["over_fire"]);
  const ems = obs.response.ems;
  if (ems.ambulances > 0) units.push({ key: "ambulances", label: "Ambulances", total: ems.ambulances, available: ems.available, enRoute: ems.responding, onScene: ems.treating });

  const comms = digestInput(input, previous).comms;
  const reasons = (input.reasons.length ? input.reasons : obs.monitor.woke_because).map(tidyMinutes);

  return {
    minute: input.minute,
    clockLabel: simClock(obs.clock.minute),
    urgency: input.urgency,
    reasons: [...reasons.filter((r) => !r.startsWith("Since the last decision")), ...reasons.filter((r) => r.startsWith("Since the last decision"))],
    wind: `Wind from ${compass(obs.wind.from_deg)} (${Math.round(obs.wind.from_deg)}°), ${Math.round(obs.wind.speed_m_s * MPH_PER_M_S)} mph (${obs.wind.speed_m_s.toFixed(1)} m/s)`,
    fires,
    zoneHorizons: horizons,
    zones: rows.slice(0, MAX_KNOWS_ZONES),
    zonesMore: Math.max(0, rows.length - MAX_KNOWS_ZONES),
    roadsNow,
    roads,
    units,
    comms: comms.slice(0, MAX_KNOWS_COMMS),
    commsMore: Math.max(0, comms.length - MAX_KNOWS_COMMS),
  };
}

// ---------------------------------------------------------------------------------------------
// What Claude did (one decision's orders as plain actions)
// ---------------------------------------------------------------------------------------------

export interface ActionLine {
  key: string;
  /** applied: the board took it; failed: the board refused it (error); */
  ok: boolean;
  /** "Send E1, E3 to S1-Ignition1 (flank)". */
  text: string;
  /** Why the board refused it, when it did. */
  error: string | null;
  /** The reasons Claude gave for the orders in this line (joined, distinct). */
  reasons: string[];
}

const RESOURCE_WORDS: Record<string, [string, string]> = {
  engine_strike_team: ["engine strike team", "engine strike teams"],
  crew_strike_team: ["hand-crew strike team", "hand-crew strike teams"],
  dozer_strike_team: ["dozer strike team", "dozer strike teams"],
  airtanker: ["airtanker", "airtankers"],
  helicopter: ["helicopter", "helicopters"],
};

const POSITION_WORDS: Record<string, string> = { head: "head", flank_left: "left flank", flank_right: "right flank" };

/** Names for the ids an order mentions: the call's observation first, then the live board. */
interface Namer {
  zone: (id: string) => string;
  destination: (id: string) => string;
  position: (fireId: string, positionId: string) => string;
  strategy: (fireId: string, strategyId: string) => string;
  unitForInjury: (injuryId: string) => string | null;
}

function namer(obs: DemoObservation | null, board: Board | null): Namer {
  const zones = new Map<string, string>();
  const destinations = new Map<string, string>();
  for (const z of board?.zones ?? []) zones.set(z.id, z.name);
  for (const z of obs?.zones ?? []) {
    zones.set(z.id, z.name);
    for (const o of z.options) destinations.set(o.destination_id, o.name);
  }
  for (const d of obs?.predicted?.destinations ?? []) destinations.set(d.destination_id, d.name);
  return {
    zone: (id) => zones.get(id) ?? id,
    destination: (id) => destinations.get(id) ?? zones.get(id) ?? id,
    position: (fireId, positionId) => {
      const p = obs?.fires.find((f) => f.id === fireId)?.attack_positions.find((a) => a.id === positionId);
      if (!p) return positionId;
      return p.kind === "zone" ? `ahead of ${p.protects_zone_ids[0] ? zones.get(p.protects_zone_ids[0]) ?? p.protects_zone_ids[0] : positionId}` : (POSITION_WORDS[p.kind] ?? positionId);
    },
    strategy: (fireId, strategyId) => obs?.fires.find((f) => f.id === fireId)?.strategy_options.find((s) => s.id === strategyId)?.name ?? strategyId,
    unitForInjury: (injuryId) => board?.simComms?.injuries.find((i) => i.id === injuryId)?.assignedUnitId ?? null,
  };
}

const isInjuryId = (id: string): boolean => /^inj-/.test(id);

/**
 * One decision's orders as plain actions. Consecutive units sent to the same fire and position
 * (and released together) become one line ("Send E1, E3 to S1-Ignition1 (flank)"). An order the
 * board refused is its own line with the board's reason; the server's rejections are separate
 * (`decision.rejected`).
 */
export function describeActions(decision: AgentDecision, obs: DemoObservation | null, board: Board | null): ActionLine[] {
  const n = namer(obs, board);
  const lines: ActionLine[] = [];
  const groups = new Map<string, { crews: string[]; fire: string; position: string | null; error: string | null; reasons: string[]; index: number }>();
  const releases = new Map<string, { crews: string[]; error: string | null; reasons: string[]; index: number }>();
  const now = decision.landedMinute;

  decision.applied.forEach(({ order, error }, i) => {
    const reason = order.reason?.trim() ? [order.reason.trim()] : [];
    const push = (text: string) => lines.push({ key: `${decision.id}-${i}`, ok: error === null, text, error, reasons: reason });
    switch (order.type) {
      case "send_crew": {
        const position = order.position_id ?? null;
        const key = `${order.fire_id}|${position}|${error}`;
        const g = groups.get(key);
        if (g) {
          g.crews.push(order.crew_id);
          g.reasons.push(...reason);
        } else {
          groups.set(key, { crews: [order.crew_id], fire: order.fire_id, position, error, reasons: reason, index: lines.length });
          lines.push({ key: `${decision.id}-send-${key}`, ok: error === null, text: "", error, reasons: [] });
        }
        return;
      }
      case "release_crew": {
        const key = String(error);
        const g = releases.get(key);
        if (g) {
          g.crews.push(order.crew_id);
          g.reasons.push(...reason);
        } else {
          releases.set(key, { crews: [order.crew_id], error, reasons: reason, index: lines.length });
          lines.push({ key: `${decision.id}-release-${key}`, ok: error === null, text: "", error, reasons: [] });
        }
        return;
      }
      case "order_evacuation": {
        const when = order.start_minute == null || order.start_minute <= now ? "now" : `at ${simClock(order.start_minute)}`;
        push(`Evacuate ${n.zone(order.zone_id)} ${when} → ${n.destination(order.destination_id)}`);
        return;
      }
      case "cancel_evacuation":
        push(`Cancel the scheduled evacuation of ${n.zone(order.zone_id)}`);
        return;
      case "order_resources": {
        const words = RESOURCE_WORDS[order.resource] ?? [order.resource.replace(/_/g, " "), `${order.resource.replace(/_/g, " ")}s`];
        push(`Order ${order.count} ${order.count === 1 ? words[0] : words[1]} for ${order.fire_id}`);
        return;
      }
      case "set_strategy":
        push(`Set strategy "${n.strategy(order.fire_id, order.strategy_id)}" for ${order.fire_id}`);
        return;
      case "send_rescue":
        push(isInjuryId(order.help_id) ? `Send ${n.unitForInjury(order.help_id) ?? "a medic unit"} to injury ${order.help_id}` : `Send a responder to help request ${order.help_id}`);
        return;
      case "close_road":
        push(`Close road ${order.road_id}`);
        return;
      case "reopen_road":
        push(`Reopen road ${order.road_id}`);
        return;
      case "confirm_report":
        push(`Confirm report ${order.report_id}`);
        return;
      case "dismiss_report":
        push(`Dismiss report ${order.report_id}`);
        return;
      default:
        push(String((order as CommanderOrder).type).replace(/_/g, " "));
    }
  });

  for (const g of groups.values()) {
    const where = g.position ? ` (${n.position(g.fire, g.position)})` : "";
    lines[g.index] = { ...lines[g.index], text: `Send ${g.crews.join(", ")} to ${g.fire}${where}`, reasons: distinct(g.reasons) };
  }
  for (const g of releases.values()) lines[g.index] = { ...lines[g.index], text: `Release ${g.crews.join(", ")}`, reasons: distinct(g.reasons) };
  return lines.map((l) => ({ ...l, reasons: distinct(l.reasons) }));
}

const distinct = (xs: string[]): string[] => [...new Set(xs)];

/** "14 s", "<1 s": how long the call took on the wall clock (model latency). */
export function tookText(latencyMs: number): string {
  if (latencyMs < 1000) return "<1 s";
  const s = Math.round(latencyMs / 1000);
  return s < 120 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}
