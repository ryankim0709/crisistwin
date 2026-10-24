import type { FeatureCollection } from "geojson";
import { Popup, type Map as MapLibreMap, type MapMouseEvent } from "maplibre-gl";
import { useEffect, useMemo, useRef } from "react";
import { setSourceData } from "./mapLayers";
import {
  MOBILITY_COLORS,
  baselineAt,
  hourIndexAt,
  ratioLog2,
  weekIndexAt,
  type Mobility,
} from "./mobility";
import { clockParts, localTime } from "./timeline";
import type { LngLat } from "./types";

const CELLS = "mobility-cells";
const FLOWS = "mobility-flows";
/** Added below the first of these that exists, so phone-panel cells sit under the fire. */
const BELOW_CANDIDATES = ["sim-front-fill", "fire-history", "fire-glow-outer", "fire-fill"];
const MIN_RADIUS_PX = 2.5;
const MAX_RADIUS_PX = 17;
const MIN_FLOW_PX = 1;
const MAX_FLOW_PX = 7;
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const fmt = (n: number) =>
  Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 1 });

/** Largest value over all cells and hours, so circle size means the same thing at every hour. */
function maxCellVisits(m: Mobility): number {
  let max = 1;
  for (const c of m.cells.items) for (const v of c.visits) if (v > max) max = v;
  return max;
}

function maxFlowVisitors(m: Mobility): number {
  let max = 1;
  for (const w of m.originFlows?.weeks ?? []) for (const f of w.items) if (f.visitors > max) max = f.visitors;
  return max;
}

function cellCollection(m: Mobility, hour: number, maxVisits: number): FeatureCollection {
  const features: FeatureCollection["features"] = [];
  for (const c of m.cells.items) {
    const visits = c.visits[hour];
    const baseline = baselineAt(c.baseline, hour);
    const ratio = ratioLog2(visits, baseline);
    if (ratio === null) continue; // no baseline and no visits: nothing to show
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: c.center },
      properties: {
        id: c.id,
        v: visits,
        b: baseline,
        lr: ratio === "fresh" ? 0 : ratio,
        fresh: ratio === "fresh" ? 1 : 0,
        evac: c.inEvacuationArea ? 1 : 0,
        pois: c.poiCount,
        rad: MIN_RADIUS_PX + (MAX_RADIUS_PX - MIN_RADIUS_PX) * Math.sqrt(visits / maxVisits),
      },
    });
  }
  return { type: "FeatureCollection", features };
}

function flowCollection(m: Mobility, origin: LngLat, week: number, maxVisitors: number): FeatureCollection {
  const label = week >= 0 ? m.eventWeeks[week] : undefined;
  const items = m.originFlows?.weeks.find((w) => w.week === label)?.items ?? [];
  return {
    type: "FeatureCollection",
    features: items
      .filter((f) => f.visitors > 0)
      .map((f) => ({
        type: "Feature" as const,
        geometry: { type: "LineString" as const, coordinates: [origin, f.center] },
        properties: {
          cell: f.cellId,
          visitors: f.visitors,
          baseline: f.baselineVisitors,
          week: label ?? "",
          w: MIN_FLOW_PX + (MAX_FLOW_PX - MIN_FLOW_PX) * Math.sqrt(f.visitors / maxVisitors),
        },
      })),
  };
}

function tooltip(
  p: Record<string, unknown>,
  kind: "cell" | "flow",
  m: Mobility,
  hour: number,
): HTMLElement {
  const root = document.createElement("div");
  root.className = "rp-tip";
  const add = (tag: string, text: string, className?: string) => {
    const el = document.createElement(tag);
    el.textContent = text;
    if (className) el.className = className;
    root.appendChild(el);
  };
  if (kind === "cell") {
    const ms = m.hourStartsMs[hour];
    add("strong", "Phone-panel visits (estimate)");
    add("span", `Hour starting ${clockParts(ms, m.timezone).date} ${localTime(ms, m.timezone)}`);
    add("span", `${fmt(Number(p.v))} visits · baseline for this hour of week ${fmt(Number(p.b))}`);
    add(
      "span",
      `${fmt(Number(p.pois))} places in this ${m.cells.sizeDeg}° cell · ${
        Number(p.evac) === 1 ? "mostly in the evacuation-area block groups" : "outside the evacuation area"
      }`,
    );
  } else {
    add("strong", "Evacuation-area residents seen here (estimate)");
    add("span", `${fmt(Number(p.visitors))} visitors in the week of ${String(p.week)} · baseline week ${fmt(Number(p.baseline))}`);
    add("span", "Lower bound: Advan omits small home-area counts. A straight line, not a travel route.");
  }
  add("span", "Advan phone-panel estimates via Dewey, not counts of people.", "rp-tip-note");
  return root;
}

export interface MobilityOverlayProps {
  map: MapLibreMap | null;
  mobility: Mobility | null;
  simTimeMs: number;
  visible: boolean;
  showFlows: boolean;
  /** Where flow lines start (the reference place); null hides flows. */
  origin: LngLat | null;
}

/**
 * Draws the mobility sidecar on the map: one circle per grid cell for the replay-clock hour
 * (size = visits, color = visits vs the same hour-of-week baseline), and optional origin-flow
 * lines for the current event week. Renders no DOM; owns its sources, layers and popup.
 */
export default function MobilityOverlay({ map, mobility, simTimeMs, visible, showFlows, origin }: MobilityOverlayProps) {
  const hour = mobility ? hourIndexAt(mobility, simTimeMs) : -1;
  const week = weekIndexAt(hour);
  const scale = useMemo(
    () => (mobility ? { visits: maxCellVisits(mobility), flow: maxFlowVisitors(mobility) } : null),
    [mobility],
  );
  const originLon = origin?.[0];
  const originLat = origin?.[1];

  // Latest props for the long-lived hover handler.
  const live = useRef({ mobility, hour, visible, showFlows });
  useEffect(() => {
    live.current = { mobility, hour, visible, showFlows };
  }, [mobility, hour, visible, showFlows]);

  // Install sources, layers and hover; remove them when the map changes or this unmounts.
  useEffect(() => {
    if (!map) return;
    const below = BELOW_CANDIDATES.find((id) => map.getLayer(id));
    map.addSource(FLOWS, { type: "geojson", data: EMPTY });
    map.addSource(CELLS, { type: "geojson", data: EMPTY });
    map.addLayer(
      {
        id: FLOWS,
        type: "line",
        source: FLOWS,
        layout: { "line-cap": "round" },
        paint: { "line-color": MOBILITY_COLORS.flow, "line-width": ["get", "w"], "line-opacity": 0.6 },
      },
      below,
    );
    map.addLayer(
      {
        id: CELLS,
        type: "circle",
        source: CELLS,
        layout: { "circle-sort-key": ["-", ["get", "rad"]] },
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, ["*", ["get", "rad"], 0.6], 12, ["*", ["get", "rad"], 1.4]],
          "circle-color": [
            "case",
            ["==", ["get", "fresh"], 1],
            MOBILITY_COLORS.fresh,
            [
              "interpolate",
              ["linear"],
              ["get", "lr"],
              -2,
              MOBILITY_COLORS.below,
              0,
              MOBILITY_COLORS.near,
              2,
              MOBILITY_COLORS.above,
            ],
          ],
          "circle-opacity": 0.62,
          "circle-stroke-color": ["case", ["==", ["get", "fresh"], 1], "#ffffff", "rgba(8,12,17,0.7)"],
          "circle-stroke-width": ["case", ["==", ["get", "evac"], 1], 1.8, 0.6],
        },
      },
      below,
    );

    const popup = new Popup({ closeButton: false, closeOnClick: false, className: "rp-popup", offset: 10, maxWidth: "280px" });
    const onMove = (event: MapMouseEvent) => {
      const s = live.current;
      if (!s.mobility || s.hour < 0 || !s.visible) {
        popup.remove();
        return;
      }
      const layers = [CELLS, ...(s.showFlows ? [FLOWS] : [])].filter((id) => map.getLayer(id));
      const feature = map.queryRenderedFeatures(event.point, { layers })[0];
      if (!feature) {
        popup.remove();
        return;
      }
      const kind = feature.layer.id === FLOWS ? "flow" : "cell";
      popup
        .setLngLat(event.lngLat)
        .setDOMContent(tooltip(feature.properties as Record<string, unknown>, kind, s.mobility, s.hour))
        .addTo(map);
    };
    const onOut = () => popup.remove();
    map.on("mousemove", onMove);
    map.on("mouseout", onOut);

    return () => {
      popup.remove();
      // The map may already be destroyed (the incident changed or the page is leaving), in which
      // case its style is gone and there is nothing left to remove.
      try {
        map.off("mousemove", onMove);
        map.off("mouseout", onOut);
        for (const id of [CELLS, FLOWS]) if (map.getLayer(id)) map.removeLayer(id);
        for (const id of [CELLS, FLOWS]) if (map.getSource(id)) map.removeSource(id);
      } catch {
        /* map already removed */
      }
    };
  }, [map]);

  // Cells: only the clock's hour changes the data.
  useEffect(() => {
    if (!map || !map.getSource(CELLS)) return;
    setSourceData(map, CELLS, mobility && scale && hour >= 0 ? cellCollection(mobility, hour, scale.visits) : EMPTY);
  }, [map, mobility, scale, hour]);

  // Flows: change with the event week or the origin.
  useEffect(() => {
    if (!map || !map.getSource(FLOWS)) return;
    const from: LngLat | null = originLon !== undefined && originLat !== undefined ? [originLon, originLat] : null;
    setSourceData(
      map,
      FLOWS,
      mobility && scale && from && week >= 0 ? flowCollection(mobility, from, week, scale.flow) : EMPTY,
    );
  }, [map, mobility, scale, week, originLon, originLat]);

  useEffect(() => {
    if (!map) return;
    const set = (id: string, on: boolean) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    };
    set(CELLS, visible);
    set(FLOWS, visible && showFlows);
  }, [map, visible, showFlows]);

  return null;
}
