/**
 * Firefighters' control line on the studio's 2D map: one point per line cell, drawn as a small
 * dark dot once built and not burned, and as a larger outlined dot (red breached, orange
 * outrun) once the fire reaches it. Filtered to the playback minute. Draws solver output only.
 */

import { useEffect } from "react";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import { mercatorToLonLat } from "../fire/landscape";
import { LineStatus } from "./firefighting";
import type { FirelineView } from "./FirelineOverlay";
import { FIRELINE_COLORS, firelineCss } from "./firelinePalette";

const SOURCE = "studio-fireline";
const BUILT = "studio-fireline-built";
const LOST = "studio-fireline-lost";
/** Stand-in for "never" in feature properties (GeoJSON has no Infinity). */
const NEVER = 1e9;

function features(view: FirelineView): GeoJSON.FeatureCollection {
  const { grid, line, status, arrival } = view;
  return {
    type: "FeatureCollection",
    features: Array.from(line.cells, (cell, k) => {
      const column = cell % grid.width;
      const row = (cell - column) / grid.width;
      const [longitude, latitude] = mercatorToLonLat(
        grid.originX + column * grid.cellSizeX,
        grid.originY + row * grid.cellSizeY,
      );
      const burn = arrival[cell];
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [longitude, latitude] },
        properties: {
          hold: line.holdFromMinute[k],
          burn: Number.isFinite(burn) ? burn : NEVER,
          outrun: status[k] === LineStatus.outrun ? 1 : 0,
        },
      };
    }),
  };
}

function filters(minute: number) {
  return {
    built: ["all", ["<=", ["get", "hold"], minute], [">", ["get", "burn"], minute]],
    lost: ["<=", ["get", "burn"], minute],
  } as const;
}

export function useMapFireline(
  map: MapLibreMap | null,
  view: FirelineView | null,
  minute: number,
): void {
  useEffect(() => {
    if (!map) return;
    const data = view ? features(view) : { type: "FeatureCollection" as const, features: [] };
    const source = map.getSource(SOURCE) as GeoJSONSource | undefined;
    if (source) {
      source.setData(data);
      return;
    }
    map.addSource(SOURCE, { type: "geojson", data });
    const f = filters(0);
    map.addLayer({
      id: BUILT,
      type: "circle",
      source: SOURCE,
      filter: f.built as never,
      paint: {
        "circle-radius": 2.5,
        "circle-color": firelineCss(FIRELINE_COLORS.held),
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 0.75,
      },
    });
    map.addLayer({
      id: LOST,
      type: "circle",
      source: SOURCE,
      filter: f.lost as never,
      paint: {
        "circle-radius": 4,
        "circle-color": [
          "case",
          ["==", ["get", "outrun"], 1],
          firelineCss(FIRELINE_COLORS.outrun),
          firelineCss(FIRELINE_COLORS.breached),
        ],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1,
      },
    });
  }, [map, view]);

  const whole = Math.floor(minute);
  useEffect(() => {
    if (!map || !map.getLayer(BUILT)) return;
    const f = filters(whole);
    map.setFilter(BUILT, f.built as never);
    map.setFilter(LOST, f.lost as never);
  }, [map, view, whole]);
}
