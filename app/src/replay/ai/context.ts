// Compact, grounded replay snapshot sent to POST /api/replay/explain. Every number here is
// copied from the loaded bundle at the current clock time; nothing is computed for the LLM
// beyond counts and selections. Field names keep the bundle's snake_case and unit suffixes
// so the model can cite them (docs/replay-bundle.md).
import { closedEdgesAt, eventCategory, lastAtOrBefore } from "../timeline";
import type { ReplayModel } from "../types";

export const MAX_RECENT_EVENTS = 15;
const MAX_ZONES = 60;
const MAX_BOTTLENECKS = 10;
const MAX_DESTINATIONS = 20;
const MAX_NOTES = 20;
const MAX_TEXT = 400;
/** Matches the server's MAX_CONTEXT_CHARS (app/backend/api/explain.py). */
export const MAX_CONTEXT_CHARS = 48_000;

export type ExplainContext = Record<string, unknown>;

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString().replace(".000Z", "Z");
}

function text(value: string | null): string | null {
  return value === null || value.length <= MAX_TEXT ? value : `${value.slice(0, MAX_TEXT)}…`;
}

export function buildExplainContext(
  model: ReplayModel,
  frameIndex: number,
  simTimeMs: number,
): ExplainContext {
  const traffic = model.traffic;
  const insights = model.insights;
  const zoneName = new Map((model.zones?.items ?? []).map((z) => [z.id, z.name]));
  const destName = new Map((model.destinations?.items ?? []).map((d) => [d.id, d.name]));

  const lastEvent = lastAtOrBefore(model.events, simTimeMs);
  const pastEvents = model.events.slice(0, lastEvent + 1);
  const closureEvents = pastEvents.filter((e) => eventCategory(e.type) === "closure");
  const recentEvents = pastEvents
    .filter((e) => eventCategory(e.type) !== "closure")
    .slice(-MAX_RECENT_EVENTS)
    .map((e) => ({
      at: iso(e.atMs),
      type: e.type,
      label: text(e.label),
      evidence_class: e.evidenceClass,
      time_precision: e.timePrecision,
      zone_ids: e.zoneIds,
      edge_ids: e.edgeIds.slice(0, 10),
    }));

  const row = traffic && frameIndex >= 0 ? traffic.metrics[frameIndex] : undefined;

  return {
    incident: {
      id: model.incident.id,
      name: model.incident.name,
      package_version: model.incident.packageVersion,
      timezone: model.incident.timezone,
      mode: model.mode,
    },
    clock: {
      now_utc: iso(simTimeMs),
      start_utc: iso(model.clock.startMs),
      end_utc: iso(model.clock.endMs),
      elapsed_s: Math.round((simTimeMs - model.clock.startMs) / 1000),
    },
    metrics_now: row
      ? {
          at: iso(row.atMs),
          evidence_class: traffic!.evidenceClass,
          not_departed_veh: row.notDepartedVeh,
          en_route_veh: row.enRouteVeh,
          arrived_veh: row.arrivedVeh,
          blocked_veh: row.blockedVeh,
          exposed_veh: row.exposedVeh,
        }
      : null,
    traffic_summary: traffic
      ? {
          evidence_class: traffic.evidenceClass,
          model_id: traffic.modelId,
          model_version: traffic.modelVersion,
          seed: traffic.seed,
          total_veh: traffic.totalVeh,
          clearance_time_s: traffic.clearanceTimeS,
          max_exposed_veh: traffic.maxExposedVeh,
        }
      : null,
    insights: insights
      ? {
          evidence_class: insights.evidenceClass,
          scope: "whole simulated run, not limited to the current clock time",
          disclaimer: insights.disclaimer,
          headline: insights.headline.map((h) => ({
            label: h.label,
            value: h.value,
            unit: h.unit,
            at: iso(h.atMs),
          })),
          zones: insights.zones.slice(0, MAX_ZONES).map((z) => ({
            zone_id: z.zoneId,
            name: zoneName.get(z.zoneId) ?? null,
            order_at: iso(z.orderAtMs),
            fire_arrival_at: iso(z.fireArrivalAtMs),
            lead_time_s: z.leadTimeS,
            vehicles: z.vehicles,
            departed_by_fire_veh: z.departedByFireVeh,
            arrived_by_fire_veh: z.arrivedByFireVeh,
            risk_level: z.riskLevel,
          })),
          zones_omitted: Math.max(0, insights.zones.length - MAX_ZONES),
          risk_rule: text(insights.zones[0]?.riskRule ?? null),
          bottlenecks: insights.bottlenecks.slice(0, MAX_BOTTLENECKS).map((b) => ({
            edge_id: b.edgeId,
            name: b.name,
            peak_veh: b.peakVeh,
            peak_at: iso(b.peakAtMs),
            min_speed_kph: b.minSpeedKph,
            minutes_congested: b.minutesCongested,
          })),
          destinations: insights.destinations.slice(0, MAX_DESTINATIONS).map((d) => ({
            destination_id: d.destinationId,
            name: destName.get(d.destinationId) ?? null,
            arrived_veh: d.arrivedVeh,
            capacity_veh: d.capacityVeh,
            full_at: iso(d.fullAtMs),
          })),
        }
      : null,
    recent_events: recentEvents,
    closures: {
      closure_events_so_far: closureEvents.length,
      edges_closed_now: traffic ? closedEdgesAt(traffic.closures, frameIndex).length : null,
    },
    layer_status: Object.fromEntries(
      Object.entries(model.layerStatus).map(([name, s]) => [
        name,
        { status: s.status, evidence_class: s.evidenceClass, reason: text(s.reason) },
      ]),
    ),
    assumptions: model.assumptions.slice(0, MAX_NOTES).map(text),
    limitations: model.limitations.slice(0, MAX_NOTES).map(text),
  };
}
