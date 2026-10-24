/**
 * The live monitor: between agent decisions the session checks the simulation every few
 * simulated minutes, and this module decides, deterministically, whether anything changed
 * enough to wake the agent. Quiet checks cost nothing; the agent is only called with the list
 * of reasons this module found. Pure: no React, network or LLM. See
 * docs/adr/0019-live-dispatch-monitor.md.
 */

import { roadLabel } from "./area";
import {
  FORECAST_LOOKAHEAD_MINUTES,
  MAX_QUIET_MINUTES,
  type Alert,
  type DispatchEngine,
} from "./engine";

/** How urgently a zone with no order and no staging needs one, from its order slack. */
export type ThreatTier = "none" | "watch" | "soon" | "urgent" | "late";

const TIER_RANK: Record<ThreatTier, number> = { none: 0, watch: 1, soon: 2, urgent: 3, late: 4 };
const TIER_TEXT: Record<ThreatTier, string> = {
  none: "no fire forecast",
  watch: "fire forecast",
  soon: "order soon",
  urgent: "order now",
  late: "already late",
};

/** Order slack bands, minutes. */
export const SOON_SLACK_MINUTES = 30;
export const URGENT_SLACK_MINUTES = 10;
/** Fire growth since the last decision that wakes the agent: this fraction and at least this area. */
export const GROWTH_WAKE_FRACTION = 0.25;
export const GROWTH_WAKE_MIN_HECTARES = 5;
/** Alert types that always wake the agent, urgent or not. */
const WAKE_ALERT_TYPES = new Set<Alert["type"]>([
  "wave_released",
  "zone_cleared",
  "fire_out",
  "fire_held",
]);
/** Reported from the closure diff instead (`closureChanges`), so none is missed or doubled. */
const ROAD_ALERT_TYPES = new Set<Alert["type"]>(["road_closed", "road_reopened"]);
const MAX_ALERT_REASONS = 6;

export function threatTier(slack: number | null): ThreatTier {
  if (slack === null) return "none";
  if (slack <= 0) return "late";
  if (slack <= URGENT_SLACK_MINUTES) return "urgent";
  if (slack <= SOON_SLACK_MINUTES) return "soon";
  return "watch";
}

export function tierLabel(tier: ThreatTier): string {
  return TIER_TEXT[tier];
}

/** What the monitor compares against: the situation at the last agent decision. */
export interface MonitorBaseline {
  minute: number;
  burnedHectares: number;
  /** Per zone; "none" for zones that already have an order or are staged. */
  tiers: ThreatTier[];
  /** Per zone: fire contact forecast within the agent's lookahead. */
  forecast: boolean[];
  /** The planner's road closures the agent saw (the engine replaces the set on change). */
  closedEdges: ReadonlySet<number>;
}

function unaddressed(engine: DispatchEngine, index: number): boolean {
  const zone = engine.zones[index];
  return zone.status === "no_order" && zone.stage === null;
}

function tiersOf(engine: DispatchEngine): ThreatTier[] {
  return engine.zones.map((zone) =>
    unaddressed(engine, zone.index) ? threatTier(engine.orderSlackMinutes(zone.index)) : "none",
  );
}

function forecastOf(engine: DispatchEngine): boolean[] {
  return engine.zones.map((zone) => {
    if (zone.status === "cleared" || zone.status === "overrun") return false;
    const minutes = engine.exposure.zoneContact[zone.index] - engine.minute;
    return Number.isFinite(minutes) && minutes <= FORECAST_LOOKAHEAD_MINUTES;
  });
}

export function takeBaseline(engine: DispatchEngine, burnedHectares: number): MonitorBaseline {
  return {
    minute: engine.minute,
    burnedHectares,
    tiers: tiersOf(engine),
    forecast: forecastOf(engine),
    closedEdges: engine.closedEdges,
  };
}

/** Roads the planner closed or reopened since the baseline, one reason each. */
function closureChanges(engine: DispatchEngine, baseline: MonitorBaseline): string[] {
  const now = engine.closedEdges;
  const before = baseline.closedEdges;
  if (now === before) return [];
  const { edges } = engine.area;
  const reasons: string[] = [];
  for (const { edge, minute } of engine.roadClosures) {
    if (!before.has(edge)) {
      reasons.push(
        `Planner closed ${roadLabel(edges[edge])} at T+${minute}; routes avoid it from now on.`,
      );
    }
  }
  for (const edge of before) {
    if (!now.has(edge)) reasons.push(`Planner reopened ${roadLabel(edges[edge])}.`);
  }
  return reasons;
}

/**
 * Why the agent should decide now, or an empty list when nothing material changed since the
 * baseline. `alerts` are the engine's alerts after the baseline minute.
 */
export function detectChanges(
  engine: DispatchEngine,
  baseline: MonitorBaseline,
  burnedHectares: number,
  alerts: readonly Alert[],
  quietLimitMinutes: number = MAX_QUIET_MINUTES,
): string[] {
  const reasons: string[] = closureChanges(engine, baseline);
  const { area } = engine;

  const waking = alerts.filter(
    (alert) =>
      !ROAD_ALERT_TYPES.has(alert.type) && (alert.urgent || WAKE_ALERT_TYPES.has(alert.type)),
  );
  for (const alert of waking.slice(-MAX_ALERT_REASONS)) reasons.push(alert.text);
  if (waking.length > MAX_ALERT_REASONS)
    reasons.unshift(`${waking.length - MAX_ALERT_REASONS} earlier alerts not listed.`);

  const tiers = tiersOf(engine);
  const forecast = forecastOf(engine);
  engine.zones.forEach((zone, i) => {
    const info = area.zones[i];
    if (
      TIER_RANK[tiers[i]] > TIER_RANK[baseline.tiers[i]] &&
      TIER_RANK[tiers[i]] >= TIER_RANK.soon
    ) {
      const slack = engine.orderSlackMinutes(i);
      reasons.push(
        `${info.name} (${info.id}) has no order and is now "${tierLabel(tiers[i])}": ${slack === null ? "?" : Math.round(slack)} min of order slack.`,
      );
    } else if (forecast[i] && !baseline.forecast[i] && zone.status === "no_order") {
      const eta = Math.max(0, Math.round(engine.exposure.zoneContact[i] - engine.minute));
      reasons.push(`Fire is now forecast to reach ${info.name} (${info.id}) in ${eta} min.`);
    }
  });

  const grown = burnedHectares - baseline.burnedHectares;
  if (
    grown >= GROWTH_WAKE_MIN_HECTARES &&
    grown >= GROWTH_WAKE_FRACTION * Math.max(baseline.burnedHectares, 1)
  ) {
    reasons.push(
      `Fire grew from ${Math.round(baseline.burnedHectares)} ha to ${Math.round(burnedHectares)} ha since the last decision at T+${baseline.minute}.`,
    );
  }

  if (reasons.length === 0 && engine.minute - baseline.minute >= quietLimitMinutes) {
    reasons.push(`Scheduled review: ${engine.minute - baseline.minute} min without a decision.`);
  }
  return reasons;
}
