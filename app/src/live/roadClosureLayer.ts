/**
 * Map layers for controller drill road closures (live/useRoadClosures.ts): each closed road is a
 * thick dark line on a white casing with white "X" barrier marks along it and a "CLOSED (drill)"
 * label, so it never reads by colour alone; the road picked but not yet closed is a dashed
 * selection-blue line. Also takes the map clicks of the closure tool: while armed, a click picks
 * the road there; otherwise a click on a closed road selects it (to reopen).
 */

import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import { MAP_COLOR } from "./CommandMap";
import type { RoadClosure } from "../demo/roadClosures";
import type { LonLat } from "./types";

const SRC = { line: "rc-closed", marks: "rc-marks", pick: "rc-pick" } as const;
const LAYERS = ["rc-closed-casing", "rc-closed-line", "rc-pick-casing", "rc-pick-line", "rc-marks", "rc-label"] as const;
const HIT_LAYERS = ["rc-closed-casing", "rc-closed-line"];
/** Barrier marks along a closed road, at most this far apart (metres; at least the midpoint). */
const MARK_SPACING_M = 150;
const FONT = ["Noto Sans Regular"];

export interface RoadClosureLayer {
  update(closures: readonly RoadClosure[], pick: LonLat[] | null, armed: boolean): void;
  claimsClick(e: MapMouseEvent): boolean;
  /** True while the map is dispatching a click this layer took. */
  claimedClick(): boolean;
  dispose(): void;
}

type Feature = GeoJSON.Feature<GeoJSON.Geometry, Record<string, string | number | boolean | null>>;

function lengthM(a: LonLat, b: LonLat): number {
  const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * k, b[1] - a[1]) * 111_320;
}

/** Points every MARK_SPACING_M along the line (centred), at least one. */
export function markPoints(line: LonLat[]): LonLat[] {
  const seg = line.slice(1).map((p, i) => lengthM(line[i], p));
  const total = seg.reduce((s, l) => s + l, 0);
  const n = Math.max(1, Math.floor(total / MARK_SPACING_M));
  const out: LonLat[] = [];
  for (let j = 0; j < n; j += 1) {
    let left = ((j + 0.5) / n) * total;
    for (let i = 0; i < seg.length; i += 1) {
      if (left <= seg[i] || i === seg.length - 1) {
        const f = seg[i] > 0 ? Math.min(1, left / seg[i]) : 0;
        out.push([line[i][0] + (line[i + 1][0] - line[i][0]) * f, line[i][1] + (line[i + 1][1] - line[i][1]) * f]);
        break;
      }
      left -= seg[i];
    }
  }
  return out;
}

export function attachRoadClosureLayer(
  map: MapLibreMap,
  handlers: { armed: () => boolean; onPick: (at: LonLat) => void; onSelect: (segmentId: string) => void },
): RoadClosureLayer {
  let disposed = false;
  let claimed = false;
  const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
  for (const id of Object.values(SRC)) if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: empty });
  // On top of every other layer: a closure must stay visible over routes, traffic and the board.
  map.addLayer({ id: "rc-closed-casing", type: "line", source: SRC.line, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": MAP_COLOR.casing, "line-width": 11 } });
  map.addLayer({ id: "rc-closed-line", type: "line", source: SRC.line, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": MAP_COLOR.ink, "line-width": 7 } });
  map.addLayer({ id: "rc-pick-casing", type: "line", source: SRC.pick, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": MAP_COLOR.casing, "line-width": 9 } });
  map.addLayer({ id: "rc-pick-line", type: "line", source: SRC.pick, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": MAP_COLOR.selection, "line-width": 5, "line-dasharray": [1.5, 1] } });
  map.addLayer({
    id: "rc-marks",
    type: "symbol",
    source: SRC.marks,
    filter: ["==", ["get", "kind"], "x"],
    layout: { "text-field": "X", "text-font": FONT, "text-size": 13, "text-allow-overlap": true, "text-ignore-placement": true },
    paint: { "text-color": MAP_COLOR.casing, "text-halo-color": MAP_COLOR.ink, "text-halo-width": 1 },
  });
  map.addLayer({
    id: "rc-label",
    type: "symbol",
    source: SRC.marks,
    filter: ["==", ["get", "kind"], "label"],
    layout: { "text-field": ["get", "text"], "text-font": FONT, "text-size": 11, "text-offset": [0, -1.4], "text-anchor": "bottom", "text-allow-overlap": true },
    paint: { "text-color": MAP_COLOR.ink, "text-halo-color": MAP_COLOR.casing, "text-halo-width": 1.6 },
  });

  const hit = (e: MapMouseEvent): string | null => {
    const layers = HIT_LAYERS.filter((l) => map.getLayer(l));
    const f = map.queryRenderedFeatures(e.point, { layers })[0];
    const id = f?.properties?.segment_id;
    return typeof id === "string" ? id : null;
  };
  const onClick = (e: MapMouseEvent) => {
    if (disposed) return;
    const armed = handlers.armed();
    const id = armed ? null : hit(e);
    if (!armed && !id) return;
    // Board layers handle the same click after this listener; they skip it while `claimed`.
    claimed = true;
    window.setTimeout(() => (claimed = false), 0);
    if (armed) handlers.onPick([e.lngLat.lng, e.lngLat.lat]);
    else if (id) handlers.onSelect(id);
  };
  const pointer = () => (map.getCanvas().style.cursor = "pointer");
  const reset = () => (map.getCanvas().style.cursor = handlers.armed() ? "crosshair" : "");
  map.on("click", onClick);
  map.on("mouseenter", "rc-closed-line", pointer);
  map.on("mouseleave", "rc-closed-line", reset);

  const set = (id: string, features: Feature[]) => (map.getSource(id) as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features });

  return {
    update(closures, pick, armed) {
      if (disposed) return;
      set(
        SRC.line,
        closures.map((c) => ({ type: "Feature", geometry: { type: "LineString", coordinates: c.line }, properties: { segment_id: c.segmentId, name: c.name } })),
      );
      const marks: Feature[] = [];
      for (const c of closures) {
        const pts = markPoints(c.line);
        for (const p of pts) marks.push({ type: "Feature", geometry: { type: "Point", coordinates: p }, properties: { kind: "x", segment_id: c.segmentId } });
        const mid = pts[Math.floor(pts.length / 2)];
        if (mid) marks.push({ type: "Feature", geometry: { type: "Point", coordinates: mid }, properties: { kind: "label", text: "CLOSED (drill)", segment_id: c.segmentId } });
      }
      set(SRC.marks, marks);
      set(SRC.pick, pick ? [{ type: "Feature", geometry: { type: "LineString", coordinates: pick }, properties: {} }] : []);
      map.getCanvas().style.cursor = armed ? "crosshair" : "";
    },
    claimsClick(e) {
      return !disposed && (handlers.armed() || hit(e) !== null);
    },
    claimedClick: () => claimed,
    dispose() {
      if (disposed) return;
      disposed = true;
      map.off("click", onClick);
      map.off("mouseenter", "rc-closed-line", pointer);
      map.off("mouseleave", "rc-closed-line", reset);
      try {
        for (const id of [...LAYERS].reverse()) if (map.getLayer(id)) map.removeLayer(id);
        for (const id of Object.values(SRC)) if (map.getSource(id)) map.removeSource(id);
      } catch {
        // The map may already be removed.
      }
    },
  };
}
