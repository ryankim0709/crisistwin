// Temporary refuge areas (NIST TRAs): which are open at a time, from shelter_opened /
// shelter_closed events. Events name the refuge ("TRA-A ...") rather than target it, so the
// link is the TRA code shared by the event label and the destination name. Pure module.
import type { Destination, ReplayEvent } from "./types";

export const REFUGE_KIND = "temporary_refuge";

const TRA_CODE = /\bTRA-([A-Z]+)\b/;

export function traCode(text: string): string | null {
  return text.match(TRA_CODE)?.[1] ?? null;
}

/** Ascending open/close times per refuge destination id. */
export type RefugeTimeline = Map<string, { atMs: number; open: boolean }[]>;

export function refugeTimeline(
  destinations: readonly Destination[],
  events: readonly ReplayEvent[],
): RefugeTimeline {
  const byCode = new Map<string, string>();
  for (const d of destinations) {
    if (d.kind !== REFUGE_KIND) continue;
    const code = traCode(d.name) ?? traCode(d.id);
    if (code) byCode.set(code, d.id);
  }
  const out: RefugeTimeline = new Map();
  for (const e of events) {
    if (e.type !== "shelter_opened" && e.type !== "shelter_closed") continue;
    const id = e.destinationId ?? byCode.get(traCode(e.label) ?? "");
    if (!id) continue;
    const list = out.get(id) ?? [];
    list.push({ atMs: e.atMs, open: e.type === "shelter_opened" });
    out.set(id, list);
  }
  return out;
}

/** "open", "closed" (not yet formed, or ended) or "unknown" when the bundle has no times for it. */
export type RefugeState = "open" | "closed" | "unknown";

export function refugeStateAt(timeline: RefugeTimeline, id: string, t: number): RefugeState {
  const list = timeline.get(id);
  if (!list || list.length === 0) return "unknown";
  let state: RefugeState = "closed";
  for (const step of list) {
    if (step.atMs > t) break;
    state = step.open ? "open" : "closed";
  }
  return state;
}

/** Stable key of the open refuge set at t, to avoid redrawing when nothing changed. */
export function openRefugeKey(timeline: RefugeTimeline, t: number): string {
  const open: string[] = [];
  for (const id of timeline.keys()) if (refugeStateAt(timeline, id, t) === "open") open.push(id);
  return open.sort().join("|");
}
