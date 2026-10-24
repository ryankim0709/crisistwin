/**
 * Firefighters driving in on the studio's 2D map: each route as a dashed line while someone is
 * on it, and each resource as a dot coloured and sized by kind (engines largest), following the
 * smooth playback clock. Draws the dispatch plan only (studio/crewDispatch.ts).
 */

import { vehicleFamily } from "./apparatus";
import { useEffect } from "react";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import { tripPosition, type CrewDispatch } from "./crewDispatch";
import { CREW_COLORS, firelineCss } from "./firelinePalette";

const ROUTES = "studio-crew-routes";
const VEHICLES = "studio-crew-vehicles";
/** Redraw when the clock has moved this many minutes. */
const STEP_MINUTES = 0.1;

function routesData(dispatch: CrewDispatch | null, minute: number): GeoJSON.FeatureCollection {
  const seen = new Set<unknown>();
  const features: GeoJSON.Feature[] = [];
  for (const trip of dispatch?.trips ?? []) {
    if (seen.has(trip.path)) continue;
    const active = dispatch!.trips.some(
      (other) =>
        other.path === trip.path && minute >= dispatch!.reportMinute && minute < other.atRoadMinute,
    );
    if (!active) continue;
    seen.add(trip.path);
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: trip.path.map(([x, y]) => [x, y]) },
      properties: {},
    });
  }
  return { type: "FeatureCollection", features };
}

function vehiclesData(dispatch: CrewDispatch | null, minute: number): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: (dispatch?.trips ?? []).map((trip) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [...tripPosition(trip, minute).at] },
      properties: { kind: vehicleFamily(trip.kind) },
    })),
  };
}

export function useMapCrews(
  map: MapLibreMap | null,
  dispatch: CrewDispatch | null,
  clockRef: { readonly current: number },
): void {
  useEffect(() => {
    if (!map) return;
    if (!map.getSource(ROUTES)) {
      map.addSource(ROUTES, { type: "geojson", data: routesData(null, 0) });
      map.addLayer({
        id: ROUTES,
        type: "line",
        source: ROUTES,
        paint: {
          "line-color": firelineCss(CREW_COLORS.engine),
          "line-width": 3,
          "line-dasharray": [1.5, 1],
        },
      });
      map.addSource(VEHICLES, { type: "geojson", data: vehiclesData(null, 0) });
      map.addLayer({
        id: VEHICLES,
        type: "circle",
        source: VEHICLES,
        paint: {
          "circle-radius": ["match", ["get", "kind"], "engine", 6, "dozer", 5, 4.5],
          "circle-color": [
            "match",
            ["get", "kind"],
            "engine",
            firelineCss(CREW_COLORS.engine),
            "dozer",
            firelineCss(CREW_COLORS.dozer),
            firelineCss(CREW_COLORS.hand_crew),
          ],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
        },
      });
    }
    let drawn = Number.NaN;
    let handle = 0;
    const tick = () => {
      const minute = clockRef.current;
      if (!(Math.abs(minute - drawn) < STEP_MINUTES)) {
        drawn = minute;
        (map.getSource(ROUTES) as GeoJSONSource | undefined)?.setData(routesData(dispatch, minute));
        (map.getSource(VEHICLES) as GeoJSONSource | undefined)?.setData(
          vehiclesData(dispatch, minute),
        );
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [map, dispatch, clockRef]);
}
