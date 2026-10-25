/**
 * Curated, plain-language digest of what the AI commander was shown in one call (the "What the agent
 * sees" panel, AgentInputsPanel.tsx). Pure: AgentInputSnapshot (+ the previous call's snapshot) in,
 * display-ready rows out; no React, no network, no clock. Every number is copied or unit-converted
 * from the observation (demo/contracts.ts DemoObservation, which is simulator output); this module
 * computes no model values (AGENTS.md: an LLM never invents numbers, and neither does the UI).
 *
 * Units: minutes are board minutes from T+0 (never wall time); hectares; metres; feet for flame
 * length; wind speed arrives in m/s and is shown in m/s and mph (1 m/s = 2.23694 mph).
 */

import type { DemoObservation, EvacBalanceObservation, EvacBalanceTotals, PredictedObservation } from "./contracts";
import { minutesText, nf, simClock, tidyMinutes } from "./format";
import type { AgentDecision } from "./useDemoAgent";
import type { AgentInputSnapshot, CommsChannel, InjuryEvent, SimCommsItem } from "./runContracts";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

/** What changed since the previous call, for one row or figure. */
export interface Delta {
  kind: "new" | "up" | "down" | "changed";
  /** Short and plain: "new since the last call", "was 40 ha", "+3". */
  text: string;
}

export interface DigestRow {
  key: string;
  /** "Fire F1", "Zone Z2 Grizzly Peak". */
  title: string;
  /** One plain-language line of numbers and consequences. */
  detail: string;
  /** Status in words (never colour alone), or null. */
  tag: { text: string; tone: Tone } | null;
  delta: Delta | null;
}

/** One apparatus type on the board, counted by what it is doing. */
export interface ResourceRow {
  key: string;
  /** "Engines (type 1-3)", "Hand crews", "Dozers", "Water tenders", "Aircraft". */
  label: string;
  total: number;
  available: number;
  /** Sent and working or travelling: on_scene + en_route + moving_up. */
  assigned: number;
  onScene: number;
  enRoute: number;
  /** returning + refilling + resting + out_of_service. */
  other: number;
  /** One line, e.g. "next arrival in 6 min". */
  detail: string | null;
  delta: Delta | null;
}

/** A line of the radio and calls ticker. */
export interface CommsRow {
  key: string;
  minute: number;
  /** When it was heard: board clock ("T+01:12") for simulated comms, "N min before this call" for the live picture (drill time). */
  timeLabel: string;
  /** "simulated comms" items carry their channel; incident_picture.messages are civilian reports. */
  channel: CommsChannel;
  /** "911 call", "Civilian report", "Fire radio", "Police radio", "EMS radio". Shown with the glyph, never colour alone. */
  channelLabel: string;
  /** One text glyph per channel (not an emoji): 911 "☎", civilian "✉", FD "▲", PD "◆", EMS "✚". */
  glyph: string;
  from: string;
  text: string;
  severity: "info" | "urgent" | "life_threat";
  /** "Simulated", "Real phone", "Simulated phone", "Phone", "2018 record", "Drill fixture". */
  origin: string;
  /** True when this item was not in the previous call. */
  isNew: boolean;
}

export interface ExtraSection {
  key: "evac_balance" | "predicted";
  title: string;
  /** Plain-language one-liner about what the section is (model output, labelled). */
  note: string;
  rows: DigestRow[];
}

/** The curated digest of one call. */
export interface InputDigest {
  id: string;
  minute: number;
  /** "T+01:25" (format.ts simClock). */
  clockLabel: string;
  sentAtMs: number;
  urgency: "urgent" | "routine";
  bytes: number;
  /** "14.2 kB". */
  sizeLabel: string;
  firstCall: boolean;
  /** Board minutes since the previous call; null for the first. */
  minutesSincePrevious: number | null;

  /** Why it woke: event reasons first, the "Since the last decision ..." line split out. */
  wake: { urgency: "urgent" | "routine"; reasons: string[]; sinceLast: string | null };
  /** At most 8 plain bullets of what changed since the previous call; [] for the first call. */
  changes: string[];

  clock: { headline: string; detail: string };
  weather: { headline: string; detail: string; delta: Delta | null };

  fires: DigestRow[];
  firesSummary: string;
  zones: DigestRow[];
  zonesSummary: string;
  traffic: { headline: string; delta: Delta | null; worst: DigestRow[]; closedRoads: DigestRow[] };
  resources: ResourceRow[];
  resourcesSummary: string;

  /** Newest first, at most 12. */
  comms: CommsRow[];
  commsCounts: { channel: CommsChannel; label: string; glyph: string; count: number }[];
  commsSummary: string;
  injuries: DigestRow[];
  injuriesSummary: string;

  /** evac_balance / predicted when the observation has them (contracts.ts EvacBalanceObservation, PredictedObservation). */
  extras: ExtraSection[];

  outcomes: string | null;
  /** The previous decision the agent was told about (observation.previous). */
  previousDecision: string | null;
}

/** observation.sim_comms (lead D / D2), absent until those leads land. */
export interface ObservationSimComms {
  recent: SimCommsItem[];
  open_injuries: InjuryEvent[];
  counts: Record<CommsChannel, number>;
}

/** DemoObservation plus the optional fields other leads add (contracts.ts gets them at merge). */
export type ObservationPlus = DemoObservation & {
  sim_comms?: ObservationSimComms;
};

export const CHANNEL_LABEL: Record<CommsChannel, string> = {
  "911": "911 call",
  civilian_report: "Civilian report",
  fd_radio: "Fire radio",
  pd_radio: "Police radio",
  ems_radio: "EMS radio",
};

export const CHANNEL_GLYPH: Record<CommsChannel, string> = {
  "911": "☎",
  civilian_report: "✉",
  fd_radio: "▲",
  pd_radio: "◆",
  ems_radio: "✚",
};

/** "14.2 kB" / "812 B" / "1.3 MB" (decimal units, as the 200 kB request cap in contracts.ts). */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} kB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** Newest first by when the call was made. */
export function newestFirst(inputs: readonly AgentInputSnapshot[]): AgentInputSnapshot[] {
  return [...inputs].sort((a, b) => b.sentAtMs - a.sentAtMs || b.minute - a.minute);
}

/**
 * The decision each call produced, one decision per call at most. A decision's explicit `inputId`
 * (lead B may add it) wins; otherwise the oldest unclaimed decision at the same board minute with
 * the same wake reasons, else at the same minute. Calls are walked oldest first so a newer call at
 * the same minute (still in flight, cancelled or failed) does not take an older call's decision.
 * A call with no entry is still in flight or produced none.
 */
export function matchDecisions(inputs: readonly AgentInputSnapshot[], decisions: readonly AgentDecision[]): Map<string, AgentDecision> {
  const out = new Map<string, AgentDecision>();
  const claimed = new Set<AgentDecision>();
  const oldestFirst = [...decisions].reverse();
  const oldInputsFirst = [...inputs].reverse();
  const sameReasons = (d: AgentDecision, i: AgentInputSnapshot) =>
    d.wokeBecause.length === i.reasons.length && d.wokeBecause.every((r, k) => r === i.reasons[k]);
  // Passes from the surest match to the loosest, each over every unmatched call, so a loose match
  // never takes a decision that a surer match (an explicit id, the same reasons) would have.
  const passes: ((d: AgentDecision, i: AgentInputSnapshot) => boolean)[] = [
    (d, i) => (d as { inputId?: string }).inputId === i.id,
    (d, i) => d.minute === i.minute && sameReasons(d, i),
    (d, i) => d.minute === i.minute && (d as { inputId?: string }).inputId === undefined,
  ];
  for (const matches of passes) {
    for (const input of oldInputsFirst) {
      if (out.has(input.id)) continue;
      const hit = oldestFirst.find((d) => !claimed.has(d) && matches(d, input));
      if (hit) {
        claimed.add(hit);
        out.set(input.id, hit);
      }
    }
  }
  return out;
}

/** The sim_comms block of an observation, or null before lead D's field exists. */
export function readSimComms(observation: DemoObservation): ObservationSimComms | null {
  const block = (observation as ObservationPlus).sim_comms;
  return block && Array.isArray(block.recent) ? block : null;
}


// ---------------------------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------------------------

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
/** 16-point compass name of a bearing in degrees true. */
export function compass(deg: number): string {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/** 1 m/s in mph (exact: 3600 / 1609.344). */
export const MPH_PER_M_S = 3600 / 1609.344;

const ha = (n: number) => `${n < 10 ? n.toFixed(1) : nf(n)} ha`;
const plural = (n: number, one: string, many = `${one}s`) => `${nf(n)} ${n === 1 ? one : many}`;
/** Whole minutes, "<1 min" under one (format.ts minutesText); never a raw float. */
const min = minutesText;

const KIND_LABEL: Record<string, string> = {
  engine_t3: "Type 3 engines",
  engine_t1: "Type 1 engines",
  hand_crew_t1: "Hand crews",
  dozer_t2: "Dozers",
};
const KIND_ORDER = ["engine_t3", "engine_t1", "hand_crew_t1", "dozer_t2"];

const zoneNameOf = (obs: DemoObservation, id: string): string => obs.zones.find((z) => z.id === id)?.name ?? id;

function seenDelta(isNew: boolean, hasPrevious: boolean): Delta | null {
  return hasPrevious && isNew ? { kind: "new", text: "new since the last call" } : null;
}

function numberDelta(now: number, was: number | null | undefined, unit: string, minChange = 1): Delta | null {
  if (was === null || was === undefined || Math.abs(now - was) < minChange) return null;
  return { kind: now > was ? "up" : "down", text: `was ${unit === "ha" ? ha(was) : `${nf(was)} ${unit}`}` };
}

function fireRows(obs: DemoObservation, prev: DemoObservation | null): DigestRow[] {
  return obs.fires.map((f) => {
    const before = prev?.fires.find((p) => p.id === f.id) ?? null;
    const reach = f.threatens_zone_ids.map((id) => zoneNameOf(obs, id));
    const parts = [
      `${ha(f.area_ha)} burned`,
      f.status === "burning"
        ? `spreading ${f.head_m_per_min.toFixed(f.head_m_per_min < 10 ? 1 : 0)} m/min toward ${compass(f.heading_deg)} (${Math.round(f.heading_deg)}°), flames ${f.head_flame_ft.toFixed(0)} ft`
        : null,
      `${Math.round(f.containment_pct)}% contained`,
      `${plural(f.crews_on_scene.length, "unit")} on scene, ${f.crews_en_route.length} en route`,
      f.status !== "burning"
        ? null
        : f.contained_in_min !== null
          ? `forecast contained in ${min(f.contained_in_min)} with the units assigned`
          : "not forecast to be contained within the forecast window with the units assigned",
      reach.length ? `forecast to reach ${reach.join(", ")}` : "no zone forecast to be reached",
      f.strategy ? `strategy: ${f.strategy.name}` : `${plural(f.strategy_options.length, "strategy option")} offered, none chosen`,
    ];
    return {
      key: f.id,
      title: `Fire ${f.id}`,
      detail: parts.filter((p): p is string => p !== null).join("; ") + ".",
      tag: { text: f.status === "burning" ? "Burning" : f.status === "contained" ? "Contained" : "Out", tone: f.status === "burning" ? "danger" : "success" },
      delta: prev ? (before ? numberDelta(f.area_ha, before.area_ha, "ha", 0.5) : seenDelta(true, true)) : null,
    } satisfies DigestRow;
  });
}

function orderWords(z: DemoObservation["zones"][number]): { text: string; tag: DigestRow["tag"] } {
  const o = z.order;
  switch (o.status) {
    case "scheduled":
      return {
        text: `evacuation order scheduled to start ${o.start_minute !== null ? simClock(o.start_minute) : "later"}${o.starts_in_min !== null ? ` (in ${min(o.starts_in_min)})` : ""}`,
        tag: { text: "Order scheduled", tone: "warning" },
      };
    case "leaving":
      return { text: `leaving since ${o.start_minute !== null ? simClock(o.start_minute) : "the order"}`, tag: { text: "Leaving", tone: "info" } };
    case "done":
      return { text: "everyone the order sends out has arrived (households without a car or that did not comply may still be home)", tag: { text: "Order complete", tone: "success" } };
    case "overrun":
      return { text: "the fire has overrun the zone", tag: { text: "Overrun", tone: "danger" } };
    default:
      return { text: "no evacuation order", tag: { text: "No order", tone: "neutral" } };
  }
}

function zoneRows(obs: DemoObservation, prev: DemoObservation | null): DigestRow[] {
  return obs.zones.map((z) => {
    const before = prev?.zones.find((p) => p.id === z.id) ?? null;
    const order = orderWords(z);
    const dest = z.order.destination_id ?? z.destination_id;
    const destName = dest ? (z.options.find((o) => o.destination_id === dest)?.name ?? dest) : null;
    const home = z.people_home !== null ? `${nf(z.people_home)} people home (${plural(z.households_home, "household")})` : `${plural(z.households_home, "household")} home, people unknown`;
    const eta =
      z.fire_eta_min !== null || z.fire_core_eta_min !== null
        ? `fire forecast to reach the edge ${z.fire_eta_min !== null ? `in ${min(z.fire_eta_min)}` : "(no edge time)"} and the core ${
            z.fire_core_eta_min !== null ? `in ${min(z.fire_core_eta_min)}` : "(no core time)"
          }`
        : "no fire arrival forecast";
    // order_slack_min = core ETA minus the mean departure delay: it leaves out the drive and queue time.
    const slack =
      z.order_slack_min === null
        ? null
        : z.order_slack_min >= 0
          ? `${min(z.order_slack_min)} between the average household leaving and the fire reaching the core (drive not counted)`
          : `the fire reaches the core ${min(-z.order_slack_min)} before the average household would even leave`;
    const margin =
      z.margin_min == null
        ? null
        : z.margin_min >= 0
          ? `traffic margin ${min(z.margin_min)} (drive and queue counted, as if ordered now)`
          : `${min(-z.margin_min)} short once the drive and queue are counted (as if ordered now)`;
    const parts = [
      home,
      eta,
      slack,
      margin,
      order.text + (destName && (z.order.status === "scheduled" || z.order.status === "leaving") ? ` to ${destName}` : ""),
      z.households_no_vehicle_home > 0 ? `${plural(z.households_no_vehicle_home, "household")} without a car still home` : null,
      z.households_en_route > 0 ? `${plural(z.households_en_route, "household")} on the road` : null,
      z.self_evacuated > 0 ? `${plural(z.self_evacuated, "household")} left on their own (no order)` : null,
    ];
    let delta: Delta | null = null;
    if (prev) {
      if (!before) delta = { kind: "new", text: "newly listed" };
      else if (before.order.status !== z.order.status) delta = { kind: "changed", text: `order was: ${orderWords(before).tag?.text.toLowerCase() ?? before.order.status}` };
      else {
        // Core with core, else edge with edge: never one against the other.
        const useCore = before.fire_core_eta_min !== null && z.fire_core_eta_min !== null;
        const was = useCore ? before.fire_core_eta_min : before.fire_eta_min;
        const now = useCore ? z.fire_core_eta_min : z.fire_eta_min;
        if (was !== null && now !== null && Math.abs(now - was) >= 2) {
          delta = { kind: now < was ? "down" : "up", text: `fire ${useCore ? "core" : "edge"} arrival was ${min(was)}` };
        }
      }
    }
    return {
      key: z.id,
      title: z.name,
      detail: parts.filter((p): p is string => p !== null).join("; ") + ".",
      tag: order.tag,
      delta,
    } satisfies DigestRow;
  });
}

function trafficSection(obs: DemoObservation, prev: DemoObservation | null): InputDigest["traffic"] {
  const t = obs.traffic;
  const w = t.worst_segment;
  const headline =
    t.vehicles_on_road === 0
      ? "No evacuation traffic on the roads."
      : `${plural(t.vehicles_on_road, "vehicle")} on the evacuation roads` +
        (w
          ? `; busiest: ${w.name} at ${nf(w.flow_veh_h)} of ${nf(w.capacity_veh_h)} vehicles/h` +
            (w.queue_vehicles > 0 ? `, queue ${nf(w.queue_vehicles)} vehicles (${min(w.queue_delay_min)} wait)` : ", no queue")
          : "");
  const worst: DigestRow[] = [];
  for (const z of obs.zones) {
    for (const o of z.options) {
      if (o.congested_eta_min < o.free_flow_min * 1.25 || o.congested_eta_min - o.free_flow_min < 2) continue;
      worst.push({
        key: `${z.id}-${o.destination_id}`,
        title: `${z.name} to ${o.name}`,
        detail: `drive ${min(o.free_flow_min)} empty roads, ${min(o.congested_eta_min)} with current traffic plus this zone's own departure flow (as if ordered now)${
          o.bottleneck ? `; bottleneck ${o.bottleneck.name} (${nf(o.bottleneck.capacity_veh_h)} vehicles/h)` : ""
        }.`,
        tag: { text: "Slow route", tone: "warning" },
        delta: null,
      });
    }
  }
  // Worst first: the most minutes lost to congestion.
  const lost = new Map<string, number>();
  for (const z of obs.zones) for (const o of z.options) lost.set(`${z.id}-${o.destination_id}`, o.congested_eta_min - o.free_flow_min);
  worst.sort((a, b) => (lost.get(b.key) ?? 0) - (lost.get(a.key) ?? 0) || a.key.localeCompare(b.key));
  const closedRoads = (obs.closed_roads ?? []).map((c) => ({
    key: c.segment_id,
    title: c.name || c.segment_id,
    detail: `closed since ${simClock(c.since_minute)} by ${c.by}; routes go around it.`,
    tag: { text: "Closed", tone: "warning" as Tone },
    delta: prev && !(prev.closed_roads ?? []).some((p) => p.segment_id === c.segment_id) ? ({ kind: "new", text: "closed since the last call" } as Delta) : null,
  }));
  return {
    headline,
    delta: prev ? numberDelta(t.vehicles_on_road, prev.traffic.vehicles_on_road, "vehicles", 5) : null,
    worst: worst.slice(0, 3),
    closedRoads,
  };
}

interface UnitCount {
  total: number;
  available: number;
  onScene: number;
  enRoute: number;
  other: number;
  nextArrival: number | null;
}

function crewCounts(obs: DemoObservation): Map<string, UnitCount> {
  const out = new Map<string, UnitCount>();
  for (const c of obs.crews) {
    const row = out.get(c.kind) ?? { total: 0, available: 0, onScene: 0, enRoute: 0, other: 0, nextArrival: null };
    row.total += 1;
    if (c.status === "available") row.available += 1;
    else if (c.status === "on_scene") row.onScene += 1;
    else if (c.status === "en_route" || c.status === "moving_up") {
      row.enRoute += 1;
      if (c.eta_min !== null) row.nextArrival = row.nextArrival === null ? c.eta_min : Math.min(row.nextArrival, c.eta_min);
    } else row.other += 1;
    out.set(c.kind, row);
  }
  return out;
}

function aircraftCounts(obs: DemoObservation): UnitCount {
  const row: UnitCount = { total: 0, available: 0, onScene: 0, enRoute: 0, other: 0, nextArrival: null };
  for (const a of obs.response.aircraft) {
    row.total += 1;
    if (a.status === "available") row.available += 1;
    else if (a.status === "over_fire") row.onScene += 1;
    else if (a.status === "en_route") {
      row.enRoute += 1;
      if (a.over_fire_in_min !== null) row.nextArrival = row.nextArrival === null ? a.over_fire_in_min : Math.min(row.nextArrival, a.over_fire_in_min);
    } else row.other += 1;
  }
  return row;
}

function resourceRows(obs: DemoObservation, prev: DemoObservation | null): ResourceRow[] {
  const now = crewCounts(obs);
  const before = prev ? crewCounts(prev) : null;
  const kinds = [...KIND_ORDER.filter((k) => now.has(k)), ...[...now.keys()].filter((k) => !KIND_ORDER.includes(k))];
  const rows: ResourceRow[] = kinds.map((k) => {
    const c = now.get(k) as UnitCount;
    return resourceRow(k, KIND_LABEL[k] ?? k, c, before ? (before.get(k) ?? null) : undefined);
  });
  const air = aircraftCounts(obs);
  if (air.total > 0) rows.push(resourceRow("aircraft", "Aircraft", air, prev ? aircraftCounts(prev) : undefined));
  return rows;
}

function resourceRow(key: string, label: string, c: UnitCount, before: UnitCount | null | undefined): ResourceRow {
  return {
    key,
    label,
    total: c.total,
    available: c.available,
    assigned: c.onScene + c.enRoute,
    onScene: c.onScene,
    enRoute: c.enRoute,
    other: c.other,
    detail: c.nextArrival !== null ? `next arrival in ${min(c.nextArrival)}` : null,
    delta:
      before === undefined || before === null
        ? null
        : before.available !== c.available || before.enRoute !== c.enRoute || before.onScene !== c.onScene
          ? {
              kind: c.available < before.available ? "down" : c.available > before.available ? "up" : "changed",
              text: `was ${before.available} available, ${before.enRoute} en route, ${before.onScene} on scene`,
            }
          : null,
  };
}

const PICTURE_ORIGIN: Record<string, string> = {
  real_phone: "Real phone",
  simulated_phone: "Simulated phone",
  phone: "Phone",
  historical_record: "2018 record",
  drill_fixture: "Drill fixture",
};

const MAX_COMMS = 12;

function commsRows(obs: DemoObservation, prev: DemoObservation | null): CommsRow[] {
  const prevKeys = new Set<string>();
  if (prev) {
    for (const m of readSimComms(prev)?.recent ?? []) prevKeys.add(`sim-${m.id}`);
    for (const m of prev.incident_picture?.messages ?? []) prevKeys.add(`pic-${m.id}`);
  }
  const rows: CommsRow[] = [];
  for (const m of readSimComms(obs)?.recent ?? []) {
    const key = `sim-${m.id}`;
    rows.push({
      key,
      minute: m.minute,
      timeLabel: simClock(m.minute),
      channel: m.channel,
      channelLabel: CHANNEL_LABEL[m.channel],
      glyph: CHANNEL_GLYPH[m.channel],
      from: m.from,
      text: m.text,
      severity: m.severity,
      origin: "Simulated",
      isNew: prev !== null && !prevKeys.has(key),
    });
  }
  const now = obs.clock.minute;
  for (const m of obs.incident_picture?.messages ?? []) {
    const key = `pic-${m.id}`;
    rows.push({
      key,
      minute: m.min_ago !== null ? Math.max(0, now - m.min_ago) : now,
      timeLabel: m.min_ago !== null ? `${min(m.min_ago)} before this call` : "time not given",
      channel: "civilian_report",
      channelLabel: CHANNEL_LABEL.civilian_report,
      glyph: CHANNEL_GLYPH.civilian_report,
      from: m.kind.replace(/_/g, " "),
      text: m.line,
      severity: "info",
      origin: PICTURE_ORIGIN[m.source] ?? m.source,
      isNew: prev !== null && !prevKeys.has(key),
    });
  }
  const calls = obs.incident_picture?.calls;
  if (calls && calls.in_window["911"] > 0) {
    rows.push({
      key: "pic-911-window",
      minute: now,
      timeLabel: `last ${calls.window_min === null ? "few" : nf(calls.window_min)} min`,
      channel: "911",
      channelLabel: CHANNEL_LABEL["911"],
      glyph: CHANNEL_GLYPH["911"],
      from: "Dispatch",
      text: `${plural(calls.in_window["911"], "call")} in the last ${calls.window_min === null ? "few" : nf(calls.window_min)} min across the drill (${nf(calls.total_so_far["911"])} so far).`,
      severity: "info",
      origin: "2018 record",
      isNew: false,
    });
  }
  return rows.sort((a, b) => b.minute - a.minute).slice(0, MAX_COMMS);
}

function injuryRows(obs: DemoObservation, prev: DemoObservation | null): DigestRow[] {
  const prevIds = new Set<string>();
  if (prev) {
    for (const i of readSimComms(prev)?.open_injuries ?? []) prevIds.add(i.id);
    for (const h of prev.incident_picture?.help_requests.items ?? []) prevIds.add(h.id);
  }
  const rows: DigestRow[] = [];
  const now = obs.clock.minute;
  for (const i of readSimComms(obs)?.open_injuries ?? []) {
    rows.push({
      key: i.id,
      title: `${plural(i.people, "person", "people")}, ${i.cause.replace(/_/g, " ")}`,
      detail: `${i.severity} injury${i.zoneId ? ` in ${zoneNameOf(obs, i.zoneId)}` : ""}; waiting since ${simClock(i.minute)} (${min(Math.max(0, now - i.minute))}); ${
        i.status === "unit_en_route" ? `unit ${i.assignedUnitId ?? ""} en route` : "no unit sent yet"
      }. Simulated.`,
      tag: { text: i.status === "unit_en_route" ? "Unit en route" : i.severity === "critical" ? "Critical" : "Waiting", tone: i.status === "unit_en_route" ? "info" : i.severity === "critical" ? "danger" : "warning" },
      delta: prev && !prevIds.has(i.id) ? { kind: "new", text: "new since the last call" } : null,
    });
  }
  for (const h of obs.incident_picture?.help_requests.items ?? []) {
    const real = h.source === "real_phone" || h.source === "phone";
    rows.push({
      key: h.id,
      title: h.type === "checkin" ? "Phone check-in asking for help" : "Report asking for help",
      detail: `${h.zone_id ? `${zoneNameOf(obs, h.zone_id)}; ` : ""}${h.min_ago !== null ? `${min(h.min_ago)} ago; ` : ""}${
        h.assignee ? `assigned to ${h.assignee}` : "not assigned"
      }${real ? "; from a real phone (text not repeated here)" : h.note ? `; "${h.note}"` : ""}.`,
      tag: { text: h.assignee ? "Assigned" : "Waiting", tone: h.assignee ? "info" : "warning" },
      delta: prev && !prevIds.has(h.id) ? { kind: "new", text: "new since the last call" } : null,
    });
  }
  return rows;
}

// --- evac_balance / predicted (contracts.ts EvacBalanceObservation, PredictedObservation): model output, shown as given.

const MAX_PLAN_ZONES = 12;
const MAX_FORECAST_ROADS = 6;
const MAX_FORECAST_DESTINATIONS = 5;
const MAX_FORECAST_DANGERS = 6;

const times = (n: number) => `${n.toFixed(1)}x`;
const peopleOrHomes = (people: number | null, households: number) =>
  people !== null ? `${plural(people, "person", "people")} (${plural(households, "household")})` : `${plural(households, "household")} (people not known)`;

/** "Z2 to Strawberry Canyon Rec Area" lookups: the zones' route options, then the forecast's destinations. */
function destinationNames(obs: DemoObservation): Map<string, string> {
  const names = new Map<string, string>();
  for (const z of obs.zones) for (const o of z.options) names.set(o.destination_id, o.name);
  for (const d of obs.predicted?.destinations ?? []) names.set(d.destination_id, d.name);
  return names;
}

type EvacZone = EvacBalanceObservation["zones"][number];

/** What to do and when, in words: "Order now", "Schedule departure at T+00:45 (in 20 min)". */
function evacActionText(z: EvacZone, nowMinute: number): { text: string; tag: string } {
  const at = simClock(z.start_minute);
  const inMin = Math.round(z.start_minute - nowMinute);
  const when = inMin > 0 ? `${at}, in ${min(inMin)}` : at;
  switch (z.action) {
    case "order_now":
      return { text: "Order now", tag: "Order now" };
    case "schedule":
      return { text: `Schedule departure at ${when}`, tag: "Schedule" };
    case "reschedule":
      return { text: `Move the scheduled departure to ${when}`, tag: "Reschedule" };
    case "keep":
      return { text: `Keep the scheduled departure at ${when}`, tag: "Keep" };
    case "leaving":
      return { text: `Already leaving (started ${at})`, tag: "Leaving" };
  }
}

function totalsText(t: EvacBalanceTotals): string {
  const parts = [
    `${peopleOrHomes(t.expected_caught_people, t.expected_caught_households)} still at home when the fire arrives`,
    `${plural(t.exposed_vehicles, "vehicle")} on a road when fire reaches it`,
    `worst road load ${times(t.peak_vc)} capacity`,
    `${plural(t.zones_fire_cuts_route, "zone")} with a route cut by fire`,
    `${plural(t.destinations_over_capacity, "destination")} over capacity`,
  ];
  return parts.join("; ");
}

function evacBalanceRows(obs: DemoObservation, eb: EvacBalanceObservation): DigestRow[] {
  const dest = destinationNames(obs);
  const rows: DigestRow[] = [];
  const { totals, all_now: allNow } = eb;
  // Lower is better; people when both runs know them, else households.
  const useP = totals.expected_caught_people !== null && allNow.expected_caught_people !== null;
  const plan = useP ? (totals.expected_caught_people as number) : totals.expected_caught_households;
  const now = useP ? (allNow.expected_caught_people as number) : allNow.expected_caught_households;
  const verdict: DigestRow["tag"] =
    plan < now ? { text: "Fewer caught than all now", tone: "success" } : plan > now ? { text: "More caught than all now", tone: "warning" } : { text: "Same as all now", tone: "neutral" };
  rows.push({
    key: "evac-totals",
    title: "Whole plan against ordering every zone now",
    detail: `Plan: ${totalsText(totals)}. Everyone leaving now: ${totalsText(allNow)}.`,
    tag: verdict,
    delta: null,
  });
  for (const z of eb.zones.slice(0, MAX_PLAN_ZONES)) {
    const action = evacActionText(z, obs.clock.minute);
    const to = z.destination_id ? ` to ${dest.get(z.destination_id) ?? z.destination_id}` : " (no destination chosen)";
    const parts = [
      `${action.text}${to}`,
      `its road peaks at ${times(z.peak_vc)} capacity${z.peak_vc > 1 ? " (queues form)" : ""}${z.worst_segment ? `, worst at ${z.worst_segment}` : ""}`,
      `expected still home when the fire arrives: ${peopleOrHomes(z.expected_caught_people, z.expected_caught_households)}`,
    ];
    if (z.exposed_vehicles > 0) parts.push(`${plural(z.exposed_vehicles, "vehicle")} on a road when fire reaches it`);
    rows.push({
      key: `evac-${z.zone_id}`,
      title: zoneNameOf(obs, z.zone_id),
      detail: `${parts.join("; ")}.${z.why ? ` ${z.why}` : ""}`,
      tag: z.fire_cuts_route
        ? { text: "Fire cuts route", tone: "danger" }
        : z.peak_vc > 1
          ? { text: "Road over capacity", tone: "warning" }
          : { text: action.tag, tone: z.action === "order_now" ? "info" : "neutral" },
      delta: null,
    });
  }
  if (eb.zones.length > MAX_PLAN_ZONES) {
    rows.push({ key: "evac-more", title: "More zones", detail: `${plural(eb.zones.length - MAX_PLAN_ZONES, "more zone")} in the plan are not listed here.`, tag: null, delta: null });
  }
  return rows;
}

/** Which forecast window a fire-edge arrival falls in: the first horizon at or after it. */
function horizonIndex(horizons: readonly number[], eta: number): number {
  const i = horizons.findIndex((h) => eta <= h);
  return i === -1 ? horizons.length - 1 : i;
}

function predictedRows(obs: DemoObservation, p: PredictedObservation): DigestRow[] {
  const rows: DigestRow[] = [];
  p.dangers.slice(0, MAX_FORECAST_DANGERS).forEach((line, i) => {
    rows.push({ key: `pred-danger-${i}`, title: "Danger flagged by the forecast", detail: line, tag: { text: "Danger", tone: "danger" }, delta: null });
  });

  // Zones by when the fire edge arrives.
  const hs = p.horizons_min;
  const last = hs[hs.length - 1] ?? 120;
  const groups = hs.map(() => [] as PredictedObservation["zones"]);
  for (const z of p.zones) {
    const eta = z.edge_eta_min ?? z.core_eta_min;
    if (eta === null) continue;
    groups[horizonIndex(hs, eta)]?.push(z);
  }
  const reached = groups.reduce((n, g) => n + g.length, 0);
  groups.forEach((g, i) => {
    if (g.length === 0) return;
    const from = i === 0 ? null : hs[i - 1];
    const title = from === null ? `Fire edge arrives within ${min(hs[i])}` : `Fire edge arrives in ${from} to ${min(hs[i])}`;
    const detail = g
      .map((z) => {
        const eta = z.edge_eta_min ?? z.core_eta_min ?? 0;
        const edge = eta <= 0 ? "fire already at the zone" : `edge in ${min(eta)}`;
        const core = z.core_eta_min !== null && z.edge_eta_min !== null ? `, core in ${min(z.core_eta_min)}` : "";
        const burned = z.burned_pct[i] !== undefined ? `, ${Math.round(z.burned_pct[i])}% of its ground burned by +${min(hs[i])}` : "";
        return `${zoneNameOf(obs, z.zone_id)} (${edge}${core}${burned})`;
      })
      .join("; ");
    rows.push({ key: `pred-zones-${i}`, title, detail: `${detail}.`, tag: { text: i === 0 ? "Soonest" : i === 1 ? "Next" : "Later", tone: i === 0 ? "danger" : i === 1 ? "warning" : "info" }, delta: null });
  });
  if (reached === 0) {
    rows.push({ key: "pred-zones-none", title: "Fire edge arrival", detail: `No zone's fire edge arrives within ${min(last)}.`, tag: null, delta: null });
  }

  // Roads whose fire arrives before their traffic has cleared.
  const dangerSegs = p.segments.filter((s) => s.danger);
  for (const s of dangerSegs.slice(0, MAX_FORECAST_ROADS)) {
    const zones = s.zone_ids.map((id) => zoneNameOf(obs, id)).join(", ");
    rows.push({
      key: `pred-road-${s.segment_id}`,
      title: s.name,
      detail: `${s.fire_eta_min !== null ? `Fire reaches it in ${min(s.fire_eta_min)}` : "Fire reaches it"}${
        s.clears_in_min !== null ? `, but traffic from ${zones || "its zones"} will not have cleared for ${min(s.clears_in_min)}` : ""
      }. Load peaks at ${times(s.peak_vc)} capacity (${nf(s.capacity_veh_h)} vehicles/h), queue up to ${plural(Math.round(s.peak_queue_vehicles), "vehicle")}.`,
      tag: { text: "Fire before clearance", tone: "danger" },
      delta: null,
    });
  }
  if (dangerSegs.length > MAX_FORECAST_ROADS) {
    rows.push({ key: "pred-road-more", title: "More roads", detail: `${plural(dangerSegs.length - MAX_FORECAST_ROADS, "more road segment")} with fire before clearance are not listed here.`, tag: null, delta: null });
  }
  const others = p.segments.filter((s) => !s.danger);
  if (others.length > 0) {
    const busiest = others.reduce((a, b) => (b.peak_vc > a.peak_vc ? b : a));
    rows.push({
      key: "pred-road-others",
      title: "Other roads on current orders",
      detail: `${plural(others.length, "segment")} not reached by fire before its traffic clears; busiest is ${busiest.name} at ${times(busiest.peak_vc)} capacity.`,
      tag: null,
      delta: null,
    });
  }

  // Destinations over capacity.
  const over = p.destinations.filter((d) => d.over_capacity);
  for (const d of over.slice(0, MAX_FORECAST_DESTINATIONS)) {
    rows.push({
      key: `pred-dest-${d.destination_id}`,
      title: d.name,
      detail: `${plural(d.committed_vehicles, "vehicle")} committed (arrived, on the way or still to leave) against room for ${d.capacity_veh !== null ? nf(d.capacity_veh) : "an unknown number"}.`,
      tag: { text: "Over capacity", tone: "danger" },
      delta: null,
    });
  }
  if (p.destinations.length > 0 && over.length === 0) {
    rows.push({ key: "pred-dest-ok", title: "Destinations", detail: `${plural(p.destinations.length, "destination")} on current orders; none over capacity.`, tag: null, delta: null });
  }
  return rows;
}

function extraSections(obs: DemoObservation): ExtraSection[] {
  const out: ExtraSection[] = [];
  if (obs.evac_balance)
    out.push({
      key: "evac_balance",
      title: "Evacuation plan balancing roads and destinations",
      note: "Model output (simulated), not an order: where and when each zone could leave, against ordering every zone now.",
      rows: evacBalanceRows(obs, obs.evac_balance),
    });
  if (obs.predicted)
    out.push({
      key: "predicted",
      title: "Predicted next states",
      note: `Model forecast (simulated), not an observation: if the current orders proceed, over the next ${obs.predicted.horizons_min[obs.predicted.horizons_min.length - 1] ?? 120} min.`,
      rows: predictedRows(obs, obs.predicted),
    });
  return out;
}

// --- change bullets

function changeBullets(snapshot: AgentInputSnapshot, previous: AgentInputSnapshot, d: Pick<InputDigest, "comms" | "injuries" | "resources">): string[] {
  const obs = snapshot.observation;
  const prev = previous.observation;
  const out: string[] = [];
  for (const f of obs.fires) {
    const before = prev.fires.find((p) => p.id === f.id);
    if (!before) out.push(`New fire ${f.id} reported (${ha(f.area_ha)}).`);
    else if (before.status !== f.status) out.push(`Fire ${f.id} is now ${f.status}.`);
    else if (Math.abs(f.area_ha - before.area_ha) >= 0.5) out.push(`Fire ${f.id} ${f.area_ha > before.area_ha ? "grew" : "shrank"} from ${ha(before.area_ha)} to ${ha(f.area_ha)}.`);
  }
  for (const z of obs.zones) {
    const before = prev.zones.find((p) => p.id === z.id);
    if (!before) out.push(`${z.name} is now threatened or ordered${z.fire_core_eta_min !== null ? ` (fire in ${min(z.fire_core_eta_min)})` : ""}.`);
    else if (before.order.status !== z.order.status) out.push(`${z.name} order: ${before.order.status} to ${z.order.status}.`);
  }
  const w = obs.wind;
  const pw = prev.wind;
  if (Math.abs(w.speed_m_s - pw.speed_m_s) * MPH_PER_M_S >= 3 || compass(w.from_deg) !== compass(pw.from_deg)) {
    out.push(`Wind changed from ${compass(pw.from_deg)} ${Math.round(pw.speed_m_s * MPH_PER_M_S)} mph to ${compass(w.from_deg)} ${Math.round(w.speed_m_s * MPH_PER_M_S)} mph.`);
  }
  const avail = (o: DemoObservation) => o.crews.filter((c) => c.status === "available").length;
  const enRoute = (o: DemoObservation) => o.crews.filter((c) => c.status === "en_route" || c.status === "moving_up").length;
  if (avail(obs) !== avail(prev)) out.push(`${nf(Math.abs(avail(obs) - avail(prev)))} ${avail(obs) > avail(prev) ? "more" : "fewer"} units available (${avail(obs)} now).`);
  if (enRoute(obs) !== enRoute(prev)) out.push(`${nf(Math.abs(enRoute(obs) - enRoute(prev)))} ${enRoute(obs) > enRoute(prev) ? "more" : "fewer"} units en route (${enRoute(obs)} now).`);
  const newComms = d.comms.filter((c) => c.isNew).length;
  if (newComms > 0) out.push(`${plural(newComms, "new call or radio message")}.`);
  const newInjuries = d.injuries.filter((r) => r.delta?.kind === "new").length;
  if (newInjuries > 0) out.push(`${plural(newInjuries, "new injury or help report")} waiting.`);
  const closedNow = (obs.closed_roads ?? []).length;
  if (closedNow !== (prev.closed_roads ?? []).length) out.push(`${plural(closedNow, "road")} closed now.`);
  return out.slice(0, 8);
}

/**
 * Digest of one call. `previous` is the call before it (older), or null for the first. See the
 * InputDigest field docs for what each section holds.
 */
export function digestInput(snapshot: AgentInputSnapshot, previous: AgentInputSnapshot | null): InputDigest {
  const obs = snapshot.observation;
  const prev = previous?.observation ?? null;
  const reasons = snapshot.reasons.length ? snapshot.reasons : obs.monitor.woke_because;
  const sinceLast = reasons.find((r) => r.startsWith("Since the last decision")) ?? null;

  const weatherNow = `Wind from ${compass(obs.wind.from_deg)} (${Math.round(obs.wind.from_deg)}°) at ${obs.wind.speed_m_s.toFixed(1)} m/s (${Math.round(obs.wind.speed_m_s * MPH_PER_M_S)} mph)`;
  const windMoved = prev !== null && (compass(obs.wind.from_deg) !== compass(prev.wind.from_deg) || Math.abs(obs.wind.speed_m_s - prev.wind.speed_m_s) * MPH_PER_M_S >= 3);

  const fires = fireRows(obs, prev);
  const burning = obs.fires.filter((f) => f.status === "burning").length;
  const zones = zoneRows(obs, prev);
  const resources = resourceRows(obs, prev);
  const comms = commsRows(obs, prev);
  const injuries = injuryRows(obs, prev);
  const sim = readSimComms(obs);

  const counts = sim
    ? (Object.keys(CHANNEL_LABEL) as CommsChannel[])
        .map((channel) => ({ channel, label: CHANNEL_LABEL[channel], glyph: CHANNEL_GLYPH[channel], count: sim.counts?.[channel] ?? 0 }))
        .filter((c) => c.count > 0)
    : [];
  const fleetTotal = obs.crews.length;
  const available = obs.crews.filter((c) => c.status === "available").length;
  const enRoute = obs.crews.filter((c) => c.status === "en_route" || c.status === "moving_up").length;
  const onScene = obs.crews.filter((c) => c.status === "on_scene").length;
  const o = obs.outcomes;

  const partial = { comms, injuries, resources };
  return {
    id: snapshot.id,
    minute: snapshot.minute,
    clockLabel: simClock(snapshot.minute),
    sentAtMs: snapshot.sentAtMs,
    urgency: snapshot.urgency,
    bytes: snapshot.bytes,
    sizeLabel: formatBytes(snapshot.bytes),
    firstCall: previous === null,
    minutesSincePrevious: previous ? snapshot.minute - previous.minute : null,
    wake: { urgency: snapshot.urgency, reasons: reasons.filter((r) => r !== sinceLast).map(tidyMinutes), sinceLast: sinceLast === null ? null : tidyMinutes(sinceLast) },
    changes: previous ? changeBullets(snapshot, previous, partial) : [],
    clock: {
      headline: simClock(obs.clock.minute),
      detail: `Forecasts look ${min(obs.clock.forecast_min)} ahead. Residents leave about ${min(obs.clock.departure_mean_min)} after an order, and ${Math.round(obs.clock.order_compliance * 100)}% comply.`,
    },
    weather: {
      headline: weatherNow,
      detail: obs.wind.source,
      delta: windMoved && prev ? { kind: "changed", text: `was ${compass(prev.wind.from_deg)} at ${Math.round(prev.wind.speed_m_s * MPH_PER_M_S)} mph` } : null,
    },
    fires,
    firesSummary: fires.length === 0 ? "No fire reported to dispatch yet." : `${burning} burning, ${obs.fires.length - burning} contained or out.`,
    zones,
    zonesSummary: `${plural(zones.length, "zone")} listed, ${nf(obs.quiet_zone_count)} quiet (no fire threatens them); ${plural(obs.totals.households_home_in_threatened_zones, "household")} still home in threatened zones.`,
    traffic: trafficSection(obs, prev),
    resources,
    resourcesSummary: `${available} of ${fleetTotal} units available, ${enRoute} en route, ${onScene} on scene${
      obs.response.mutual_aid_pool_units > 0 ? `; ${plural(obs.response.mutual_aid_pool_units, "more unit")} can be ordered through mutual aid` : ""
    }.`,
    comms,
    commsCounts: counts,
    commsSummary: comms.length === 0 ? "No calls or radio traffic reported yet." : `${plural(comms.length, "message")} shown, newest first.`,
    injuries,
    injuriesSummary: injuries.length === 0 ? "No injuries reported." : `${plural(injuries.length, "report")} waiting for help.`,
    extras: extraSections(obs),
    outcomes: o
      ? `Homes burned so far ${nf(o.homes_burned)}; people caught ${o.caught_people !== null ? nf(o.caught_people) : `unknown (${plural(o.caught_households, "household")})`}; area burned ${ha(o.area_burned_ha)}.`
      : null,
    previousDecision: obs.previous
      ? `At ${simClock(obs.previous.minute)}: ${obs.previous.summary}${obs.previous.rejected.length ? ` Refused: ${obs.previous.rejected.join("; ")}` : ""}`
      : null,
  };
}
