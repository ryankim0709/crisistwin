/**
 * When the Studio's firefighters stop working their fire. Units attack the fire they were sent to
 * (studio/incidents.ts, studio/crewDispatch.ts, studio/initialAttack.ts). Two ways they leave it:
 *
 * - Evacuation support: when the initial attack cannot put their incident's fire out (it is
 *   crowning, its head flame is longer than they can hold, or their line cannot catch its edge)
 *   they are overwhelmed, and they go to support the evacuation (studio/evacuation.ts) only when
 *   there is an evacuation task for them: from the evacuation order minute, or, with threat-based
 *   orders, from the first zone's modelled fire contact minus the agent's forecast lookahead
 *   (FORECAST_LOOKAHEAD_MINUTES, dispatch/engine.ts; ASSUMPTION: the earliest a triggered order
 *   can go out). Each leaves SIZE_UP_MINUTES after it arrived, or when that task starts if later.
 *   With no evacuation task they stay with the fire.
 * - Safety withdrawal (LCES: lookouts, communications, escape routes, safety zones; NWCG Incident
 *   Response Pocket Guide, PMS 461): a unit disengages when a fire it cannot hold will reach the
 *   cells around where it parked before it can walk out (studio/initialAttack.ts decides this for
 *   units on a fire edge; for units holding a road it is the shown run's fire reaching that road
 *   point within UNIT_WITHDRAW_MARGIN_MINUTES).
 *
 * A unit that has left builds no line: the initial attack already stops a withdrawn unit's line,
 * and the page applies this handoff only to the direct-attack run (the run in which it is true),
 * never to the control-line plan. Pure, deterministic. See
 * docs/adr/0024-studio-crews-assist-evacuation.md and docs/response-model.md.
 */

import { groundMeters, type DispatchArea, type LonLat } from "../dispatch/area";
import { FORECAST_LOOKAHEAD_MINUTES, UNIT_WITHDRAW_MARGIN_MINUTES } from "../dispatch/engine";
import type { FireExposure } from "../dispatch/fireExposure";
import type { LandscapeGrid } from "../fire/landscape";
import { cellAt } from "../fire/spread";
import type { CrewDispatch } from "./crewDispatch";
import type { FireAttack, InitialAttackEstimate } from "./initialAttack";

/** ASSUMED: how long crews work a fire before they conclude they cannot hold it, minutes. */
export const SIZE_UP_MINUTES = 10;

export interface CrewHandoff {
  /** Why the crews are overwhelmed, or null when they put every fire out. */
  overwhelmedReason: string | null;
  /** Minute each trip (same order as `dispatch.trips`) leaves for evacuation support; null = no task, stays. */
  leaveMinutes: (number | null)[];
  /** Minute each trip withdrew for safety (same order); null = never. */
  withdrawMinutes: (number | null)[];
  /** First minute there is an evacuation task, or null when there is none in the run. */
  evacuationFromMinute: number | null;
}

/**
 * First minute there is an evacuation task for crews: the order minute, or with threat-based
 * orders the earliest zone contact minus FORECAST_LOOKAHEAD_MINUTES; null when no zone is
 * reached by fire and no order is set.
 */
export function evacuationTaskFromMinute(orderMinute: number | null, exposure: FireExposure | null): number | null {
  if (orderMinute !== null) return orderMinute;
  if (!exposure) return null;
  let first = Infinity;
  for (const contact of exposure.zoneContact) if (contact < first) first = contact;
  return Number.isFinite(first) ? Math.max(0, first - FORECAST_LOOKAHEAD_MINUTES) : null;
}

export interface HandoffOptions {
  evacuationFromMinute?: number | null;
  /** The board and the shown run's arrival field, for units holding a road. */
  grid?: LandscapeGrid | null;
  arrival?: Float32Array | null;
}

function reasonOf(fire: FireAttack, name: string, holds: number): string {
  if (fire.reason) return `${name}: ${fire.reason}`;
  return !Number.isFinite(fire.headFlameFeet)
    ? `${name} is crowning`
    : !fire.attackable
      ? `${name}'s ${fire.headFlameFeet.toFixed(1)} ft head flame is longer than the crews can hold (${holds} ft)`
      : `the crews' line cannot catch ${name}'s edge by the end of the run`;
}

/** First minute fire reaches the 3 x 3 cells around `point` in `arrival`, or Infinity. */
function firstArrivalNear(grid: LandscapeGrid, arrival: Float32Array, point: LonLat): number {
  const c0 = cellAt(grid, { longitude: point[0], latitude: point[1] });
  if (c0 < 0) return Infinity;
  const x0 = c0 % grid.width;
  const y0 = (c0 - x0) / grid.width;
  let first = Infinity;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const x = x0 + dx;
      const y = y0 + dy;
      if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) continue;
      first = Math.min(first, arrival[y * grid.width + x]);
    }
  }
  return first;
}

export function crewHandoff(
  dispatch: CrewDispatch,
  estimate: InitialAttackEstimate,
  names: Record<string, string>,
  options: HandoffOptions = {},
): CrewHandoff {
  const evacuationFromMinute = options.evacuationFromMinute ?? null;
  const fireOf = new Map(estimate.fires.map((f) => [f.sourceId, f]));
  const firstFire = [...estimate.fires]
    .filter((f) => f.ignitedMinute !== null)
    .sort((a, b) => a.ignitedMinute! - b.ignitedMinute!)[0];
  const unitWithdraw = new Map<string, number>();
  for (const fire of estimate.fires) {
    for (const unit of fire.units ?? []) if (unit.label && unit.withdrawMinute !== null) unitWithdraw.set(unit.label, unit.withdrawMinute);
  }
  const burning = estimate.fires.filter((fire) => fire.ignitedMinute !== null && fire.outMinute === null);
  const overwhelmedReason =
    burning.length === 0
      ? null
      : burning.map((fire) => reasonOf(fire, names[fire.sourceId] || fire.sourceId, estimate.holdsFlameLengthFeet)).join("; ");

  const withdrawMinutes = dispatch.trips.map((trip): number | null => {
    if (trip.label && unitWithdraw.has(trip.label)) return unitWithdraw.get(trip.label)!;
    if (trip.tactic !== "indirect" || !options.grid || !options.arrival) return null;
    const reach = firstArrivalNear(options.grid, options.arrival, trip.roadPoint);
    if (!Number.isFinite(reach)) return null;
    return Math.max(trip.arriveMinute, Math.floor(reach - UNIT_WITHDRAW_MARGIN_MINUTES));
  });
  const leaveMinutes = dispatch.trips.map((trip, index): number | null => {
    if (evacuationFromMinute === null) return null;
    const fire = (trip.sourceId ? fireOf.get(trip.sourceId) : null) ?? firstFire;
    const withdraw = withdrawMinutes[index];
    const overwhelmed = fire !== undefined && fire.ignitedMinute !== null && fire.outMinute === null;
    if (!overwhelmed && withdraw === null) return null;
    const free = overwhelmed ? Math.min(trip.arriveMinute + SIZE_UP_MINUTES, withdraw ?? Infinity) : withdraw!;
    return Math.ceil(Math.max(free, evacuationFromMinute));
  });
  return { overwhelmedReason, leaveMinutes, withdrawMinutes, evacuationFromMinute };
}

/** A crew joining the evacuation run: where it starts and where it withdraws to. */
export interface EvacuationCrew {
  id: string;
  /** Graph node at the crew's own road point. */
  node: number;
  /** Graph node of its station, where it withdraws to. */
  homeNode: number;
  leaveMinute: number;
}

function nearestNode(area: DispatchArea, point: LonLat): number {
  let best = 0;
  let bestMeters = Infinity;
  area.nodes.forEach((node, index) => {
    const meters = groundMeters(node, point);
    if (meters < bestMeters) {
      bestMeters = meters;
      best = index;
    }
  });
  return best;
}

/** The crews that leave their fire for the evacuation, as units on `area`'s road graph. */
export function evacuationCrews(
  area: DispatchArea,
  dispatch: CrewDispatch,
  handoff: CrewHandoff,
): EvacuationCrew[] {
  if (area.nodes.length === 0) return [];
  return dispatch.trips.flatMap((trip, index) => {
    const leaveMinute = handoff.leaveMinutes[index];
    if (leaveMinute === null) return [];
    // path[1] is the station's graph node (path[0] its OSM location).
    const station = trip.path[1] ?? trip.path[0] ?? trip.roadPoint;
    return [{ id: trip.label, node: nearestNode(area, trip.roadPoint), homeNode: nearestNode(area, station), leaveMinute }];
  });
}
