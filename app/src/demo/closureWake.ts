/**
 * The wake reason for a controller road closure or reopening (useDemoAgent's closure monitor):
 * what changed and what the board's models did about it, from the change records of
 * roadClosures.ts (units stopped for a new leg, evacuating zones switched) and the zone routes
 * before and after (POST /api/demo/routes). Every number here is the board's (unit arrival minutes
 * from the crew router, route ETAs from the evacuation router); nothing is estimated. Pure: no
 * React, network or LLM.
 */

import { simClock } from "./format";
import { zoneCounts, type Board, type RouteOption } from "./model";
import { lineUsesRoad, type ClosureChange, type RoadClosure } from "./roadClosures";

/** Zones named in one reason before "+N more". */
const MAX_ZONES = 8;

const who = (by: string) => (by === "controller" ? "Controller" : by.replace(/^agent:/, "Agent "));
const roads = (list: RoadClosure[]) => list.map((c) => `${c.name} (segment ${c.segmentId})`).join(", ");
const route = (r: RouteOption) => `${r.name} ${Math.round(r.eta_min)} min`;
const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "±0");

function more(items: string[]): string {
  return items.length <= MAX_ZONES ? items.join("; ") : `${items.slice(0, MAX_ZONES).join("; ")}; +${items.length - MAX_ZONES} more`;
}

/** "Controller closed <road> (segment <id>) at T+hh:mm" per change, joined. */
export function closureHeadline(changes: ClosureChange[]): string {
  return changes
    .map((c) => {
      const by = who((c.closed[0] ?? c.reopened[0])?.by ?? "controller");
      const parts = [
        c.closed.length ? `closed ${roads(c.closed)}` : "",
        c.reopened.length ? `reopened ${roads(c.reopened)}` : "",
      ].filter(Boolean);
      return `${by} ${parts.join(" and ")} at ${simClock(c.minute)}`;
    })
    .join("; ");
}

export interface ClosureWakeInput {
  board: Board;
  /** The changes the agent has not seen yet (roadClosures.closureChangesSince), oldest first. */
  changes: ClosureChange[];
  /** Zone routes before the first change and now. */
  before: ReadonlyMap<string, RouteOption[]>;
  after: ReadonlyMap<string, RouteOption[]>;
  /** False when the wait for the new routes timed out: `after` may still be the old answer. */
  routesReady: boolean;
}

/** One urgent wake reason (useDemoAgent: kind road_closed). */
export function closureWakeText({ board, changes, before, after, routesReady }: ClosureWakeInput): string {
  const head = closureHeadline(changes);

  // Units the board stopped for a new road leg (latest record per unit).
  const units = new Map<string, ClosureChange["units"][number]>();
  for (const c of changes) for (const u of c.units) if (!units.has(u.teamId)) units.set(u.teamId, u);
  const unitTexts = [...units.values()].map((u) => {
    const team = board.teams.find((t) => t.id === u.teamId);
    if (!team) return `${u.teamId} (no longer on the board)`;
    if (team.travel === "pending") return `${u.teamId} ${u.to} (new road route still computing)`;
    const moving = team.status === "en_route" || team.status === "returning" || team.status === "moving_up";
    if (team.arriveAt === null || !moving) return `${u.teamId} ${u.to} (now ${team.status})`;
    const delta = u.wasArriveAt === null ? null : Math.round(team.arriveAt - u.wasArriveAt);
    return `${u.teamId} ${u.to} (${delta === null ? "" : `${signed(delta)} min, `}arrives ${simClock(team.arriveAt)})`;
  });
  const anyClosed = changes.some((c) => c.closed.length > 0);
  const unitPart = unitTexts.length
    ? `units rerouted: ${unitTexts.join(", ")}`
    : anyClosed
      ? "no unit on the road was using it"
      : "";

  // Evacuating or scheduled zones the board switched (first route before, latest after).
  const switched = new Map<string, { scheduled: boolean; from: RouteOption | null; to: RouteOption | null }>();
  for (const c of changes) {
    for (const z of c.zones) {
      const prev = switched.get(z.zoneId);
      switched.set(z.zoneId, { scheduled: z.scheduled, from: prev ? prev.from : z.from, to: z.to });
    }
  }
  const zoneTexts: string[] = [];
  for (const [zoneId, z] of switched) {
    const what = z.scheduled ? "scheduled" : "evacuating";
    if (z.to) zoneTexts.push(`${zoneId} (${what}) redirected to ${route(z.to)}${z.from ? ` (was ${route(z.from)})` : " (was held, no route)"}`);
    else zoneTexts.push(`${zoneId} (${what}): no open route left${z.scheduled ? ", its schedule was dropped" : ", households held at the zone"}`);
  }

  // Zones with people home and no order whose best route changed with this road.
  const closedRoads = changes.flatMap((c) => c.closed);
  const reopenedRoads = changes.flatMap((c) => c.reopened);
  for (const zone of board.zones) {
    if (switched.has(zone.id) || zone.overrunAt !== null || zone.orderedAt !== null || zone.pendingOrder !== null) continue;
    if (zoneCounts(zone, board.minute).home <= 0) continue;
    const was = before.get(zone.id)?.[0] ?? null;
    const now = after.get(zone.id)?.[0] ?? null;
    const lost = was !== null && closedRoads.some((r) => lineUsesRoad(was.line, r.line));
    const gained = now !== null && reopenedRoads.some((r) => lineUsesRoad(now.line, r.line));
    if (!lost && !gained) continue;
    if (!routesReady) zoneTexts.push(`${zone.id}: its best route (${route(was ?? now!)}) used it; new options still computing`);
    else if (!now) zoneTexts.push(`${zone.id}: no route left`);
    else if (was && now.destination_id === was.destination_id && Math.round(now.eta_min) === Math.round(was.eta_min) && !gained) continue;
    else zoneTexts.push(`${zone.id} best route now ${route(now)}${was ? ` (was ${route(was)})` : ""}`);
  }
  const zonePart = zoneTexts.length ? `zones affected: ${more(zoneTexts)}` : "no zone's route changed";

  const tail = routesReady ? "" : " (routes were still being recomputed after the closure; check closed_roads and the options in this observation)";
  return `${head}: ${[unitPart, zonePart].filter(Boolean).join("; ")}.${tail}`;
}
