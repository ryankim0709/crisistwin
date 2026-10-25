/**
 * What each unit on the command board is doing and how far it is from its fire, for an honest
 * map label ("building line 830 m ahead of the head", "parked, crew hiking 400 m to its line",
 * "driving to S1-F1 head_60 · 6 min"). Pure: no React, network or LLM. Every number is model
 * state read back (unit status, road leg, off-road reach of response/reach.ts, the solver's open
 * edge, the attack line's built metres); nothing here changes the board. See
 * docs/command-demo-realism.md, "Why units stand away from the fire".
 *
 * Units: metres (ground), board minutes.
 */

import type { LonLat } from "../live/types";
import { distanceText as metresText, fireEdgeSample, idleOnSceneReason } from "./boardResponse";
import { MAX_FIRE_CUT_REROUTES, distanceM, teamPosition, type AttackLine, type Board, type Fire, type Team } from "./model";

export type UnitActivityKind =
  /** Dispatched, waiting where it stands for its road route (POST /api/demo/crew_routes). */
  | "awaiting_route"
  /** Fire cut the road ahead; stopped, waiting for a new road leg (model.ts rerouteTeam). */
  | "rerouting"
  /** On its road leg to its fire or attack position. */
  | "driving"
  /** Parked at the end of its road leg; the crew is walking to the fire's edge or its line's anchor (response/reach.ts). */
  | "hiking_in"
  /** At an attack position (attack.ts), building line outward from its anchor. */
  | "building_line"
  /** Direct attack at the fire's edge (hose within reach, hand line, dozer). */
  | "direct_attack"
  /** Parked too far from the edge or its line's anchor to work (response/reach.ts out_of_reach). */
  | "out_of_reach"
  /** Direct attack, but no point of the fire's open edge is within its reach now (boardResponse.idleOnSceneReason). */
  | "no_edge_in_reach"
  | "refilling"
  | "resting"
  | "returning"
  | "moving_up"
  /** Its last trip was given up because fire kept cutting its road (Team.blockedByFire); free where it stopped. */
  | "blocked_by_fire"
  | "out_of_service"
  | "available";

export interface UnitActivity {
  kind: UnitActivityKind;
  /** Short plain-language label for the map, from model state ("building line 830 m ahead of the head · 169/722 m"). */
  label: string;
  /** Fire it is assigned to (or was, when blocked by fire), and the attack position id (null: direct attack). */
  fireId: string | null;
  positionId: string | null;
  /**
   * Where its work is when that is not where it stands, for a leader line on the map: the line's
   * anchor (attack line), the nearest point of the fire's open edge (direct attack, hiking in or
   * out of reach), or the trip's target while driving or waiting. null: at the unit, or none.
   */
  workPoint: LonLat | null;
  /** Metres from where the unit is now to the nearest point of its fire's open edge; null without a fire or a solve. */
  fromFireM: number | null;
}

/** Where an attack position stands relative to its fire, in words, with its anchor's distance from the fire's edge (metres, or null). */
function positionWhere(board: Board, line: AttackLine, anchorFromFireM: number | null): string {
  const kind = line.plan.kind;
  const d = anchorFromFireM === null ? null : metresText(anchorFromFireM);
  if (kind === "head") return d ? `${d} ahead of the head` : "ahead of the head";
  const where =
    kind === "flank_left"
      ? "on the left flank"
      : kind === "flank_right"
        ? "on the right flank"
        : `at ${board.zones.find((z) => z.id === line.plan.id.slice("zone_".length))?.name ?? line.plan.id.slice("zone_".length)} (structure protection)`;
  return d ? `${where}, ${d} from the fire` : where;
}

function nearestOf(p: LonLat, pts: readonly LonLat[]): { point: LonLat; m: number } | null {
  let best: { point: LonLat; m: number } | null = null;
  for (const q of pts) {
    const m = distanceM(p, q);
    if (!best || m < best.m) best = { point: q, m };
  }
  return best;
}

/** What `team` is doing now, its work point and its distance from its fire. Pure. */
export function unitActivity(board: Board, team: Team): UnitActivity {
  const here = teamPosition(board, team);
  const fireId = team.fireId ?? team.blockedByFire?.fireId ?? null;
  const fire: Fire | undefined = fireId ? board.fires.find((f) => f.id === fireId) : undefined;
  const line = team.lineId ? board.lines.find((l) => l.id === team.lineId) : undefined;
  const edge = fire && fire.status === "burning" ? fireEdgeSample(board, fire) : [];
  const near = nearestOf(here, edge);
  const fromFireM = near ? near.m : null;
  const dest = line ? `${line.fireId} ${line.plan.id}` : (team.fireId ?? "");
  const base = { fireId, positionId: line?.plan.id ?? null, fromFireM };
  const mins = (t: number | null) => (t === null ? "" : ` · ${Math.max(0, Math.ceil(t - board.minute))} min`);

  switch (team.status) {
    case "en_route": {
      if (team.travel === "pending") {
        const cut = team.fireCuts > 0;
        return {
          ...base,
          kind: cut ? "rerouting" : "awaiting_route",
          label: cut
            ? `fire cut its road to ${dest}; waiting for a new route (cut ${team.fireCuts} of ${MAX_FIRE_CUT_REROUTES})`
            : `waiting for its road route to ${dest}`,
          workPoint: team.target,
        };
      }
      return { ...base, kind: "driving", label: `driving to ${dest}${mins(team.arriveAt)}`, workPoint: team.target };
    }
    case "on_scene": {
      const hiking = team.workStartAt !== null && team.workStartAt > board.minute + 1e-9;
      if (line) {
        // Parked beyond reach of the line's anchor (out of reach, or holding its road: response/reach.ts planWork): it builds nothing there.
        if (team.workMode === "out_of_reach" || team.workMode === "indirect") {
          return { ...base, kind: "out_of_reach", label: idleOnSceneReason(board, team) ?? `too far from its ${dest} line to build it`, workPoint: line.plan.point };
        }
        if (hiking) {
          return {
            ...base,
            kind: "hiking_in",
            label: `parked, crew hiking ${metresText(team.parkedM ?? 0)} to its ${dest} line${mins(team.workStartAt)}`,
            workPoint: line.plan.point,
          };
        }
        return {
          ...base,
          kind: "building_line",
          // Where the line is relative to the fire: its anchor's distance from the open edge (not the unit's, which parks at its road's end).
          label: `building ${dest} line ${positionWhere(board, line, nearestOf(line.plan.point, edge)?.m ?? null)} · ${Math.round(line.builtM)}/${Math.round(line.lengthM)} m`,
          workPoint: distanceM(here, line.plan.point) > 30 ? line.plan.point : null,
        };
      }
      const idle = idleOnSceneReason(board, team);
      if (team.workMode === "out_of_reach") return { ...base, kind: "out_of_reach", label: idle ?? `too far from ${dest} to work`, workPoint: near?.point ?? null };
      if (hiking) {
        return {
          ...base,
          kind: "hiking_in",
          label: `parked, crew hiking ${metresText(team.parkedM ?? 0)} to the ${dest} edge${mins(team.workStartAt)}`,
          workPoint: near?.point ?? null,
        };
      }
      if (idle) return { ...base, kind: "no_edge_in_reach", label: idle, workPoint: near?.point ?? null };
      const how = team.workMode === "hand_line" ? "building hand line" : team.workMode === "dozer" ? "cutting dozer line" : "hose line";
      return { ...base, kind: "direct_attack", label: `${how} on the ${dest} edge${fromFireM !== null && fromFireM > 50 ? ` (${metresText(fromFireM)} away)` : ""}`, workPoint: null };
    }
    case "refilling":
      return { ...base, kind: "refilling", label: `refilling water${line ? ` (${dest} line)` : ""}`, workPoint: null };
    case "resting":
      return { ...base, kind: "resting", label: `resting${mins(team.restUntil)}`, workPoint: null };
    case "returning":
      return { ...base, kind: "returning", label: `returning to station${team.travel !== "pending" ? mins(team.arriveAt) : ""}`, workPoint: null };
    case "moving_up": {
      const st = board.stations.find((s) => s.id === team.coverStation);
      return { ...base, kind: "moving_up", label: `moving up to cover ${st?.name ?? "a station"}`, workPoint: team.target };
    }
    case "out_of_service":
      return { ...base, kind: "out_of_service", label: "out of service", workPoint: null };
    default:
      if (team.blockedByFire) {
        return {
          ...base,
          kind: "blocked_by_fire",
          label: `stopped: fire cut its road to ${team.blockedByFire.fireId} ${team.blockedByFire.cuts} times; free here`,
          workPoint: null,
        };
      }
      return { ...base, kind: "available", label: "free", workPoint: null };
  }
}

/**
 * One map label for units standing at one spot: the ids on each job, then the job (unitActivity),
 * jobs separated by "; " ("S03-E1 S06-E1 · building S1-F1 head_60 line 830 m ahead of the head ·
 * 169/722 m").
 */
export function unitSpotLabel(board: Board, members: readonly Team[]): string {
  const byJob = new Map<string, string[]>();
  for (const t of members) {
    const a = unitActivity(board, t);
    const job = a.kind === "available" ? "free" : a.label;
    byJob.set(job, [...(byJob.get(job) ?? []), t.id]);
  }
  return [...byJob.entries()].map(([job, ids]) => `${ids.join(" ")} · ${job}`).join("; ");
}
