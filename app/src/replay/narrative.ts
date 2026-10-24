// Pure builder for the one-line map caption. Every fact comes from the bundle.
import { arrivalAt, distanceM, inArea } from "./insights";
import { eventCategory, lastAtOrBefore, perimeterIndexAt, simulatedFrontIndexAt } from "./timeline";
import type { AreaGeometry, LngLat, ReplayModel } from "./types";

/** Events older than this (sim time) drop out of the caption. */
export const CAPTION_EVENT_WINDOW_MS = 20 * 60_000;

/** Reference place per incident for "fire N km from X". */
export const CAPTION_PLACES: Record<string, { name: string; coord: LngLat }> = {
  "camp-2018-paradise-slice": { name: "Paradise", coord: [-121.6, 39.76] },
};

const SNAPPED_NOTE = /\s*\[snapped:[^\]]*\]\s*$/;

/** Split a label into its text and an optional trailing "[snapped: …]" note. */
export function splitSnappedNote(label: string): { text: string; note: string | null } {
  const match = label.match(SNAPPED_NOTE);
  if (!match) return { text: label, note: null };
  return { text: label.slice(0, match.index).trim(), note: match[0].trim() };
}

function nearestVertexM(g: AreaGeometry, p: LngLat): number {
  const rings = g.type === "Polygon" ? g.coordinates : g.coordinates.flat();
  let best = Infinity;
  for (const ring of rings) for (const v of ring) best = Math.min(best, distanceM(v, p));
  return best;
}

export interface Caption {
  event: { label: string; fixture: boolean } | null;
  enRouteVeh: number | null;
  fire: string | null;
}

export function buildCaption(model: ReplayModel, t: number, frameIndex: number): Caption {
  let event: Caption["event"] = null;
  for (let i = lastAtOrBefore(model.events, t); i >= 0; i -= 1) {
    const e = model.events[i];
    if (t - e.atMs > CAPTION_EVENT_WINDOW_MS) break;
    if (eventCategory(e.type) === "closure") continue;
    event = { label: splitSnappedNote(e.label).text, fixture: e.evidenceClass === "fixture" };
    break;
  }

  const enRouteVeh = model.traffic && frameIndex >= 0 ? (model.traffic.metrics[frameIndex]?.enRouteVeh ?? null) : null;

  let fire: string | null = null;
  const place = CAPTION_PLACES[model.incident.id];
  if (place) {
    const perimeterIndex = perimeterIndexAt(model, t);
    const simIndex = simulatedFrontIndexAt(model, t);
    const grid = model.fireSimulated?.arrivalGrid;
    if (perimeterIndex >= 0) {
      const g = model.perimeters[perimeterIndex].geometry;
      fire = inArea(g, place.coord)
        ? `${place.name} inside satellite perimeter`
        : `satellite perimeter ${(nearestVertexM(g, place.coord) / 1000).toFixed(1)} km from ${place.name}`;
    } else if (simIndex >= 0 && model.fireSimulated) {
      const g = model.fireSimulated.fronts[simIndex].geometry;
      const arrival = grid ? arrivalAt(grid, place.coord) : null;
      const reached = inArea(g, place.coord) || (arrival?.status === "reached" && arrival.atMs <= t);
      fire = reached
        ? `model fire has reached ${place.name}`
        : `model fire ${(nearestVertexM(g, place.coord) / 1000).toFixed(1)} km from ${place.name}`;
    }
  }
  return { event, enRouteVeh, fire };
}
