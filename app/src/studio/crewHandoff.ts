/**
 * When the Studio's firefighters stop fighting the fire and help the evacuation instead. Crews
 * attack the fire when they arrive (studio/crewDispatch.ts, studio/initialAttack.ts). If the
 * direct-attack estimate says they cannot put every fire out (one is crowning, its head flame
 * is longer than they can hold, or their line cannot catch its edge by the horizon), they are
 * overwhelmed: each crew leaves the fire SIZE_UP_MINUTES after it arrived (or after the last
 * fire they did put out, if later) and goes to support the evacuation
 * (studio/evacuation.ts). When every fire goes out they stay with it. Pure, deterministic. See
 * docs/adr/0024-studio-crews-assist-evacuation.md.
 */

import { groundMeters, type DispatchArea, type LonLat } from "../dispatch/area";
import type { CrewDispatch } from "./crewDispatch";
import type { InitialAttackEstimate } from "./initialAttack";

/** ASSUMED: how long crews work a fire before they conclude they cannot hold it, minutes. */
export const SIZE_UP_MINUTES = 10;

export interface CrewHandoff {
  /** Why the crews are overwhelmed, or null when they put every fire out. */
  overwhelmedReason: string | null;
  /** Minute each trip (same order as `dispatch.trips`) leaves the fire; null = stays. */
  leaveMinutes: (number | null)[];
}

export function crewHandoff(
  dispatch: CrewDispatch,
  estimate: InitialAttackEstimate,
  names: Record<string, string>,
): CrewHandoff {
  const burning = estimate.fires.filter(
    (fire) => fire.ignitedMinute !== null && fire.outMinute === null,
  );
  if (burning.length === 0) {
    return { overwhelmedReason: null, leaveMinutes: dispatch.trips.map(() => null) };
  }
  const fire = burning[0];
  const name = names[fire.sourceId] || fire.sourceId;
  const overwhelmedReason = !Number.isFinite(fire.headFlameFeet)
    ? `${name} is crowning`
    : !fire.attackable
      ? `${name}'s ${fire.headFlameFeet.toFixed(1)} ft head flame is longer than the crews can hold (${estimate.holdsFlameLengthFeet} ft)`
      : `the crews' line cannot catch ${name}'s edge by the end of the run`;
  const lastOut = Math.max(0, ...estimate.fires.map((f) => f.outMinute ?? 0));
  return {
    overwhelmedReason,
    leaveMinutes: dispatch.trips.map((trip) =>
      Math.ceil(Math.max(trip.arriveMinute + SIZE_UP_MINUTES, lastOut)),
    ),
  };
}

/** A crew joining the evacuation run: where it starts and where it withdraws to. */
export interface EvacuationCrew {
  id: string;
  /** Graph node at the fire's road point. */
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

/** The crews that leave the fire, as evacuation units on `area`'s road graph. */
export function evacuationCrews(
  area: DispatchArea,
  dispatch: CrewDispatch,
  handoff: CrewHandoff,
): EvacuationCrew[] {
  if (area.nodes.length === 0) return [];
  const node = nearestNode(area, dispatch.roadPoint);
  return dispatch.trips.flatMap((trip, index) => {
    const leaveMinute = handoff.leaveMinutes[index];
    if (leaveMinute === null) return [];
    // path[1] is the station's graph node (path[0] its OSM location).
    const station = trip.path[1] ?? trip.path[0] ?? dispatch.roadPoint;
    return [{ id: trip.label, node, homeNode: nearestNode(area, station), leaveMinute }];
  });
}
