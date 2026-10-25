/**
 * What the firefighting animation draws, read from the command board (both the 3D board,
 * firefightingFx3d.ts, and the 2D map, boardMapLayers.ts). Pure and read-only: it consumes
 * fireState.ts crewWork (who works which edge, how far along), the units' work mode
 * (response/reach.ts: hose, hand line, dozer) and the suppression state's put-out cells
 * (suppression.ts extinguishedAt / inert); it never changes the board. Every mark it feeds
 * is simulated and is labelled so in the legends.
 *
 * Coordinates WGS84 [lon, lat]; directions local metres [east, north]; minutes are board minutes.
 */

import type { LonLat } from "../live/types";
import { vehicleFamily } from "../studio/apparatus";
import { crewWork, type CrewWork } from "./fireState";
import { cellLonLat, distanceM, lineBuiltExtent, type Board, type Team } from "./model";

/** What the crew works with: water from its engine's hose, hand tools, or a dozer blade. */
export type WorkTool = "hose" | "hand" | "dozer";

export interface FirefightingWork {
  teamId: string;
  fireId: string;
  kind: CrewWork["kind"];
  tool: WorkTool;
  /** Where its vehicle is parked (the hose runs from here), WGS84. */
  vehicle: LonLat;
  /** The point it works now: the edge cell being knocked down, or its attack line's growing tip. */
  lead: LonLat;
  /**
   * Ground it has worked on this assignment, ending at `lead`: direct / mop-up, the cells it put
   * out, oldest first; line, from the line's anchor out to this crew's tip (the built part).
   */
  trail: LonLat[];
  /** Unit vector toward the fire (local metres [east, north]); [0, 0] when unknown. */
  inward: [number, number];
  /** 0..1 along its work (fireState.crewWork). */
  progress: number;
}

/** A cell put out by suppression within the last JUST_PUT_OUT_MINUTES (steam / pulse marker). */
export interface JustPutOut {
  at: LonLat;
  /** Board minute it was put out, and how long ago (board minutes, >= 0). */
  minute: number;
  age: number;
}

/** Display only: how long a put-out cell keeps its steam / pulse marker, board minutes. */
export const JUST_PUT_OUT_MINUTES = 8;
/** Display caps: markers per board update (newest first). */
export const JUST_PUT_OUT_MAX = 64;

function toolOf(team: Team | undefined): WorkTool {
  if (!team) return "hand";
  if (team.workMode === "hose") return "hose";
  if (team.workMode === "dozer") return "dozer";
  if (team.workMode === "hand_line") return "hand";
  const family = vehicleFamily(team.kind);
  return family === "engine" ? "hose" : family === "dozer" ? "dozer" : "hand";
}

/** Point a share `u` (0..1) of the way along `path` by length. */
function alongShare(path: readonly LonLat[], u: number): { at: LonLat; index: number } {
  if (path.length === 1) return { at: path[0], index: 0 };
  const cum = [0];
  for (let k = 1; k < path.length; k++) cum.push(cum[k - 1] + distanceM(path[k - 1], path[k]));
  const s = Math.max(0, Math.min(1, u)) * cum[cum.length - 1];
  for (let k = 1; k < path.length; k++) {
    if (cum[k] >= s) {
      const f = (s - cum[k - 1]) / Math.max(1e-6, cum[k] - cum[k - 1]);
      const a = path[k - 1];
      const b = path[k];
      return { at: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], index: k };
    }
  }
  return { at: path[path.length - 1], index: path.length };
}

const workCache = new WeakMap<Board, { source: CrewWork[]; built: string; value: FirefightingWork[] }>();

/** Every crew at work now, with its tool, vehicle, work point and worked ground. Cached per crewWork result. */
export function firefightingWork(board: Board): FirefightingWork[] {
  const source = crewWork(board);
  const built = board.lines.map((l) => Math.round(l.builtM)).join("|");
  const hit = workCache.get(board);
  if (hit && hit.source === source && hit.built === built) return hit.value;
  const byId = new Map(board.teams.map((t) => [t.id, t]));
  const out: FirefightingWork[] = [];
  const lineSide = new Map<string, number>();
  for (const w of source) {
    const team = byId.get(w.teamId);
    if (!team) continue;
    const base = { teamId: w.teamId, fireId: w.fireId, kind: w.kind, tool: toolOf(team), vehicle: team.position, inward: w.inward, progress: w.progress };
    if (w.kind === "line") {
      const line = team.lineId ? board.lines.find((l) => l.id === team.lineId) : undefined;
      if (!line) continue;
      // Line is built outward from the anchor on both sides (model.ts builtExtent): crews alternate sides.
      const { point: p, a, b, aM, bM } = line.plan;
      const n = lineSide.get(line.id) ?? 0;
      lineSide.set(line.id, n + 1);
      const ext = lineBuiltExtent(line);
      const useA = bM <= 0 || (aM > 0 && n % 2 === 0);
      const end = useA ? a : b;
      const f = useA ? (aM > 0 ? ext.a / aM : 0) : bM > 0 ? ext.b / bM : 0;
      const tip: LonLat = [p[0] + (end[0] - p[0]) * f, p[1] + (end[1] - p[1]) * f];
      out.push({ ...base, lead: tip, trail: [p, tip] });
      continue;
    }
    const path = w.path as LonLat[];
    if (path.length === 0) continue;
    const { at, index } = alongShare(path, w.progress);
    out.push({ ...base, lead: at, trail: [...path.slice(0, Math.max(1, index)), at] });
  }
  workCache.set(board, { source, built, value: out });
  return out;
}

const putOutCache = new WeakMap<Board, { minute: number; version: number; value: JustPutOut[] }>();

/**
 * Cells put out by suppression in the last JUST_PUT_OUT_MINUTES board minutes, newest first,
 * at most JUST_PUT_OUT_MAX. Reads suppression.inert (cells in the order they were put out) from
 * the end, so it costs only the recent cells.
 */
export function justPutOut(board: Board): JustPutOut[] {
  const st = board.suppression;
  const hit = putOutCache.get(board);
  if (hit && hit.minute === board.minute && hit.version === st.version) return hit.value;
  const out: JustPutOut[] = [];
  const order = st.inert ?? [];
  const grid = board.env.landscape;
  for (let k = order.length - 1; k >= 0 && out.length < JUST_PUT_OUT_MAX; k--) {
    const c = order[k];
    const minute = st.extinguishedAt[c];
    if (!(minute <= board.minute)) continue;
    const age = board.minute - minute;
    if (age > JUST_PUT_OUT_MINUTES) break;
    out.push({ at: cellLonLat(grid, c), minute, age });
  }
  putOutCache.set(board, { minute: board.minute, version: st.version, value: out });
  return out;
}
