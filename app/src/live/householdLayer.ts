/**
 * MapLibre "houses" layer: every simulated household at its position, styled by its status in the
 * current board run (./useHouseholdState). Each status has its own shape and inner mark as well as a
 * colour (never colour alone); the legend swatches (HouseholdSummary, MapLegend) are drawn from the
 * same `HOUSEHOLD_STYLE` paths. Icons scale with zoom so ~20k houses stay a legible texture at a
 * region view and readable shapes when zoomed in; the worst statuses draw on top.
 *
 * Performance: one GeoJSON source keyed by `household_id` (promoteId). A new run or a big change
 * replaces the data once; a poll's diff goes through `updateData` (remove + add of the changed
 * houses only). Shapes are a layout property (icon-image), so feature-state cannot carry the status.
 *
 * Everything it draws is simulated: houses are stand-ins from the scenario snapshot and which house
 * has which status is an allocation of the zone's counts.
 */
import { Popup, type GeoJSONSource, type Map as MapLibreMap, type MapLayerMouseEvent, type MapMouseEvent } from "maplibre-gl";
import { simClock } from "../demo/format";
import type { Household, HouseholdStatus } from "./useHouseholdState";

export const HOUSEHOLD_LAYER_ID = "lc-houses";
export const HOUSEHOLD_INTERACTIVE_LAYERS = [HOUSEHOLD_LAYER_ID];
const SRC = "lc-houses";
const ICON_RATIO = 2;
/** Above this share of changed houses a diff is slower than replacing the data. */
const DIFF_MAX_SHARE = 0.3;

export const HOUSEHOLD_NOTE =
  "Simulated household (stand-in from the scenario snapshot; which house has which status is an allocation of the zone's counts)";

export const HOUSEHOLD_LABEL: Record<HouseholdStatus, string> = {
  home: "Home, no order",
  waiting: "Waiting to leave",
  evacuating: "Evacuating",
  safe: "Safe",
  needs_transport: "Needs transport",
  not_leaving: "Not leaving",
  caught: "Caught by fire",
  unknown: "Unknown",
};

export const HOUSEHOLD_DETAIL: Record<HouseholdStatus, string> = {
  home: "Home; no order in effect for its zone",
  waiting: "Ordered or scheduled to leave; has not left yet",
  evacuating: "On the road",
  safe: "Reached its destination",
  needs_transport: "No vehicle; still home in an ordered or threatened zone",
  not_leaving: "Ordered to leave; did not comply",
  caught: "Was home when the fire overran its zone",
  unknown: "Status not known",
};

interface HouseStyle {
  /** SVG path in a 20 x 20 box (also drawn on canvas with Path2D). */
  shape: string;
  fill: string;
  edge: string;
  dashed?: boolean;
  /** Inner mark, stroked. */
  mark?: string;
  markColor?: string;
  /** Draw order: higher on top. */
  order: number;
}

const CIRCLE = (r: number) => `M${10 - r} 10a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;

/** MapLibre cannot read CSS variables: the hues live here (safe mirrors --ct-success, evacuating --ct-evacuee). */
export const HOUSEHOLD_STYLE: Record<HouseholdStatus, HouseStyle> = {
  home: { shape: CIRCLE(5), fill: "#FFFFFF", edge: "#475569", order: 0 },
  safe: { shape: CIRCLE(6.5), fill: "#22C55E", edge: "#14532D", mark: "M6.8 10.3l2.2 2.2l4.3-4.6", markColor: "#FFFFFF", order: 1 },
  unknown: { shape: CIRCLE(5.5), fill: "#E5E7EB", edge: "#6B7280", dashed: true, mark: "M10 10h.01", markColor: "#374151", order: 2 },
  evacuating: { shape: "M10 2.8L17.2 16H2.8Z", fill: "#2DD4BF", edge: "#0F1720", order: 3 },
  waiting: { shape: "M4 4h12v12H4Z", fill: "#FACC15", edge: "#713F12", mark: "M10 6.6V10l2.6 1.8", markColor: "#713F12", order: 4 },
  not_leaving: {
    shape: "M7.2 3h5.6L17 7.2v5.6L12.8 17H7.2L3 12.8V7.2Z",
    fill: "#8B5CF6",
    edge: "#2E1065",
    mark: "M6.6 10h6.8",
    markColor: "#FFFFFF",
    order: 5,
  },
  needs_transport: {
    shape: "M10 2.5L17.5 10L10 17.5L2.5 10Z",
    fill: "#F472B6",
    edge: "#831843",
    mark: "M10 6.4v4.4M10 13.5v.1",
    markColor: "#500724",
    order: 6,
  },
  caught: { shape: CIRCLE(6.8), fill: "#991B1B", edge: "#450A0A", mark: "M7.4 7.4l5.2 5.2M12.6 7.4l-5.2 5.2", markColor: "#FFFFFF", order: 7 },
};
const HALO = "#FFFFFF";

const iconId = (s: HouseholdStatus) => `lc-house-${s}`;

function drawIcon(style: HouseStyle): ImageData | null {
  const size = 20 * ICON_RATIO;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(ICON_RATIO, ICON_RATIO);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const shape = new Path2D(style.shape);
  ctx.strokeStyle = HALO;
  ctx.lineWidth = 3.6;
  ctx.stroke(shape);
  ctx.fillStyle = style.fill;
  ctx.fill(shape);
  if (style.dashed) ctx.setLineDash([2, 1.5]);
  ctx.strokeStyle = style.edge;
  ctx.lineWidth = 1.5;
  ctx.stroke(shape);
  ctx.setLineDash([]);
  if (style.mark) {
    ctx.strokeStyle = style.markColor ?? style.edge;
    ctx.lineWidth = style.mark.endsWith("h.01") ? 2.6 : 1.8;
    ctx.stroke(new Path2D(style.mark));
  }
  return ctx.getImageData(0, 0, size, size);
}

type Props = { id: string; s: HouseholdStatus; k: number };
const feature = (h: Household): GeoJSON.Feature<GeoJSON.Point, Props> => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [h.lon, h.lat] },
  properties: { id: h.household_id, s: h.status, k: HOUSEHOLD_STYLE[h.status].order },
});

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const known = (n: number | null, one: string, many: string) =>
  n === null ? `${many}: unknown` : `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function householdPopupHtml(h: Household, zoneName: string): string {
  const since = h.since_minute === null ? "since: unknown" : `since ${simClock(h.since_minute)}`;
  return [
    `<strong>${escapeHtml(HOUSEHOLD_LABEL[h.status])}</strong>, ${escapeHtml(since)}`,
    escapeHtml(HOUSEHOLD_DETAIL[h.status]),
    escapeHtml(`${known(h.occupants, "occupant", "occupants")}, ${known(h.vehicles, "vehicle", "vehicles")}`),
    escapeHtml(`Zone: ${zoneName}`),
    `<span class="lc-house-note">${escapeHtml(HOUSEHOLD_NOTE)}</span>`,
  ].join("<br>");
}

export interface HouseholdLayer {
  /** Draw this set (null clears). `runId` change replaces the data instead of diffing. */
  update(households: Map<string, Household> | null, runId: string | null): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

/**
 * Adds the houses source, layer, icons and popups to `map`, below `beforeId`. `zoneName` resolves a
 * zone id for the popup (read at hover time, so it may close over the latest data).
 */
export function attachHouseholdLayer(map: MapLibreMap, beforeId: string | undefined, zoneName: (zoneId: string) => string): HouseholdLayer {
  const before = beforeId && map.getLayer(beforeId) ? beforeId : undefined;
  for (const [status, style] of Object.entries(HOUSEHOLD_STYLE) as [HouseholdStatus, HouseStyle][]) {
    const img = drawIcon(style);
    if (img && !map.hasImage(iconId(status))) map.addImage(iconId(status), img, { pixelRatio: ICON_RATIO });
  }
  map.addSource(SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] }, promoteId: "id" });
  map.addLayer(
    {
      id: HOUSEHOLD_LAYER_ID,
      type: "symbol",
      source: SRC,
      layout: {
        "icon-image": ["concat", "lc-house-", ["get", "s"]] as never,
        "icon-size": ["interpolate", ["linear"], ["zoom"], 9, 0.22, 12, 0.4, 14, 0.65, 16, 0.95, 18, 1.25] as never,
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "symbol-sort-key": ["get", "k"] as never,
        visibility: "none",
      },
      paint: { "icon-opacity": ["interpolate", ["linear"], ["zoom"], 9, 0.75, 12, 1] as never },
    },
    before,
  );

  let current: Map<string, Household> | null = null;
  let currentRun: string | null = null;
  const source = () => map.getSource(SRC) as GeoJSONSource | undefined;
  const replace = (hs: Map<string, Household> | null) =>
    source()?.setData({ type: "FeatureCollection", features: hs ? Array.from(hs.values(), feature) : [] });

  // Hover shows a popup; a click pins it until a click elsewhere on the map.
  const popup = new Popup({ closeButton: false, closeOnClick: false, maxWidth: "300px", className: "lc-popup", offset: 8 });
  let shownId: string | null = null;
  let pinned = false;
  const show = (e: MapLayerMouseEvent) => {
    const id = e.features?.[0]?.properties?.id;
    const h = typeof id === "string" ? current?.get(id) : undefined;
    if (!h) return;
    if (id === shownId && popup.isOpen()) return;
    shownId = id;
    popup.setLngLat([h.lon, h.lat]).setHTML(householdPopupHtml(h, zoneName(h.zone_id))).addTo(map);
  };
  const onMove = (e: MapLayerMouseEvent) => {
    map.getCanvas().style.cursor = "pointer";
    if (!pinned) show(e);
  };
  const onLeave = () => {
    map.getCanvas().style.cursor = "";
    if (!pinned) {
      popup.remove();
      shownId = null;
    }
  };
  const onClick = (e: MapLayerMouseEvent) => {
    pinned = false;
    show(e);
    pinned = true;
  };
  const onMapClick = (e: MapMouseEvent) => {
    if (!pinned || !map.getLayer(HOUSEHOLD_LAYER_ID)) return;
    if (map.queryRenderedFeatures(e.point, { layers: [HOUSEHOLD_LAYER_ID] }).length) return;
    pinned = false;
    shownId = null;
    popup.remove();
  };
  map.on("mousemove", HOUSEHOLD_LAYER_ID, onMove);
  map.on("mouseleave", HOUSEHOLD_LAYER_ID, onLeave);
  map.on("click", HOUSEHOLD_LAYER_ID, onClick);
  map.on("click", onMapClick);

  return {
    update(households, runId) {
      const prev = current;
      current = households;
      if (shownId && !households?.has(shownId)) {
        pinned = false;
        shownId = null;
        popup.remove();
      }
      if (!households || !prev || runId !== currentRun) {
        currentRun = runId;
        replace(households);
        return;
      }
      if (households === prev) return;
      const remove: string[] = [];
      const add: GeoJSON.Feature[] = [];
      for (const [id, h] of households) {
        const old = prev.get(id);
        if (old === h) continue;
        if (old) remove.push(id);
        add.push(feature(h));
      }
      for (const id of prev.keys()) if (!households.has(id)) remove.push(id);
      if (!remove.length && !add.length) return;
      const src = source();
      if (!src) return;
      if (add.length + remove.length > households.size * DIFF_MAX_SHARE) replace(households);
      else void src.updateData({ remove, add }).catch(() => replace(current));
      // Keep a pinned popup's text current.
      const shown = shownId ? households.get(shownId) : undefined;
      if (shown && popup.isOpen()) popup.setHTML(householdPopupHtml(shown, zoneName(shown.zone_id)));
    },
    setVisible(visible) {
      if (map.getLayer(HOUSEHOLD_LAYER_ID)) map.setLayoutProperty(HOUSEHOLD_LAYER_ID, "visibility", visible ? "visible" : "none");
      if (!visible) {
        pinned = false;
        shownId = null;
        popup.remove();
      }
    },
    dispose() {
      popup.remove();
      map.off("mousemove", HOUSEHOLD_LAYER_ID, onMove);
      map.off("mouseleave", HOUSEHOLD_LAYER_ID, onLeave);
      map.off("click", HOUSEHOLD_LAYER_ID, onClick);
      map.off("click", onMapClick);
      try {
        if (map.getLayer(HOUSEHOLD_LAYER_ID)) map.removeLayer(HOUSEHOLD_LAYER_ID);
        if (map.getSource(SRC)) map.removeSource(SRC);
      } catch {
        // The map is already being removed; its layers go with it.
      }
    },
  };
}
