/**
 * Every fire facility that can respond, on the Studio's 2D map: a marker and a plain label
 * ("Paradise FS · CAL FIRE · 2 engines, 1 dozer") for each station, camp and air base the
 * resources come from (studio/mapResources.ts, response/fleet.ts). Mutual aid from outside the
 * area is drawn fainter and labelled so; air bases are squares. What is on the map is what can
 * respond.
 */

import { useEffect } from "react";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import type { FacilityContribution } from "../response/fleet";
import { STATION_COLORS, firelineCss } from "./firelinePalette";

const SOURCE = "studio-stations";
const MARKERS = "studio-stations";
const AIR = "studio-air-bases";
const LABELS = "studio-station-labels";
const FONT = ["Noto Sans Regular"];

function data(facilities: readonly FacilityContribution[] | null): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: (facilities ?? []).map((f) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [f.location[0], f.location[1]] },
      properties: {
        label: f.tier === "mutual_aid" ? `${f.label} · mutual aid` : f.label,
        tier: f.tier,
        air: f.facility === "air_attack_base" || f.facility === "helitack_base",
      },
    })),
  };
}

export function useMapStations(map: MapLibreMap | null, facilities: readonly FacilityContribution[] | null): void {
  useEffect(() => {
    if (!map) return;
    if (!map.getSource(SOURCE)) {
      const ink = firelineCss(STATION_COLORS.ink);
      const faint = ["case", ["==", ["get", "tier"], "mutual_aid"], 0.55, 1] as never;
      map.addSource(SOURCE, { type: "geojson", data: data(null) });
      map.addLayer({
        id: MARKERS,
        type: "circle",
        source: SOURCE,
        filter: ["!", ["get", "air"]],
        paint: {
          "circle-radius": 5,
          "circle-color": firelineCss(STATION_COLORS.fill),
          "circle-stroke-color": ink,
          "circle-stroke-width": 3,
          "circle-opacity": faint,
          "circle-stroke-opacity": faint,
        },
      });
      // Air bases: a square glyph so the shape, not colour, tells them apart.
      map.addLayer({
        id: AIR,
        type: "symbol",
        source: SOURCE,
        filter: ["get", "air"],
        layout: { "text-field": "■", "text-font": FONT, "text-size": 16, "text-allow-overlap": true },
        paint: { "text-color": ink, "text-halo-color": firelineCss(STATION_COLORS.halo), "text-halo-width": 1.5 },
      });
      map.addLayer({
        id: LABELS,
        type: "symbol",
        source: SOURCE,
        minzoom: 9.5,
        layout: {
          "text-field": ["get", "label"],
          "text-font": FONT,
          "text-size": 11,
          "text-offset": [0, 1.1],
          "text-anchor": "top",
          "text-max-width": 16,
          "text-optional": true,
        },
        paint: { "text-color": ink, "text-halo-color": firelineCss(STATION_COLORS.halo), "text-halo-width": 1.4, "text-opacity": faint },
      });
    }
    (map.getSource(SOURCE) as GeoJSONSource | undefined)?.setData(data(facilities));
  }, [map, facilities]);
}
