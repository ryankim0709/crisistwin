/**
 * One sample of a board run's outcome (runContracts.ts ScorePoint), for the /run timeline and the
 * baseline-vs-AI scoreboard (useCommandBoard `timeline`). Pure: reads the board (demo/model.ts),
 * never mutates it; no React, clock or randomness. Every number is a board model output or a
 * count of one (simulated):
 * - homesBurned, caughtPeople, areaBurnedHa: scoring.ts runScore (whole-run casualties; persons
 *   when every zone's occupants are known, else households).
 * - injured: persons in the board's simulated injuries (Board.simComms, demo/simComms.ts); 0 until
 *   that generator is on the board.
 * - peopleSafe / peopleAtRisk: model.ts zonePeople per zone (persons out at a destination; persons
 *   still home in zones model.ts zoneThreatened marks, with the `forecasts` passed: the commander's
 *   "reported" scope on /live and /run). A zone with unknown occupants counts households instead.
 * - worstVolumeToCapacity: max over the evacuation segments in use of the departure flow loading
 *   the segment / its capacity (board.traffic, model.ts trafficStep; capacities are the route's
 *   segment capacities, sourced in traffic.ts and the route builders). 0 when nobody is leaving.
 */

import { zoneCounts, zonePeople, zoneThreatened, type Board, type ZoneForecast } from "./model";
import type { ScorePoint, SimCommsState } from "./runContracts";
import { runScore } from "./scoring";

/** Persons in the board's simulated injuries (any status but "none"); 0 without simComms. */
function injuredPeople(board: Board): number {
  const injuries = (board as { simComms?: SimCommsState }).simComms?.injuries ?? [];
  let n = 0;
  for (const inj of injuries) if ((inj.status as string) !== "none") n += Math.max(0, inj.people);
  return n;
}

/** Worst departure-flow volume / capacity on the evacuation segments in use now (0: nobody leaving). */
function worstVolumeToCapacity(board: Board): number {
  const t = board.traffic;
  let worst = 0;
  for (const [id, segment] of t.segments) {
    const flow = t.flow.get(id) ?? 0;
    if (flow > 0 && segment.capacity_veh_h > 0) worst = Math.max(worst, flow / segment.capacity_veh_h);
  }
  return Math.round(worst * 100) / 100;
}

/** The run's outcome at the board's current minute (see the file comment for each field). */
export function scorePoint(board: Board, forecasts: Map<string, ZoneForecast>): ScorePoint {
  const score = runScore(board);
  let peopleSafe = 0;
  let peopleAtRisk = 0;
  for (const zone of board.zones) {
    const p = zonePeople(zone, board.minute);
    const c = p.total === null ? zoneCounts(zone, board.minute) : null;
    peopleSafe += p.out ?? c?.out ?? 0;
    if (zone.overrunAt === null && zoneThreatened(zone, forecasts)) peopleAtRisk += p.home ?? c?.home ?? 0;
  }
  return {
    minute: Math.floor(board.minute),
    homesBurned: score.homesBurned,
    caughtPeople: score.casualtiesRunPeople ?? score.casualtiesRunHouseholds,
    injured: injuredPeople(board),
    peopleSafe,
    peopleAtRisk,
    worstVolumeToCapacity: worstVolumeToCapacity(board),
    areaBurnedHa: score.areaBurnedHa,
  };
}
