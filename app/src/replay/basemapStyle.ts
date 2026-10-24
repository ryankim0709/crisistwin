// Restyles the OpenFreeMap dark basemap so it stays legible at every zoom: muted neutral land,
// visible water, grey roads, readable place labels, boundaries and a faint terrain hillshade.
// Warm colours stay reserved for fire and cool colours for traffic, so the basemap is neutral.
import { TERRAIN_ATTRIBUTION, TERRAIN_TILES_URL } from "./perspectives/perspective";
import type { BasemapStyle } from "./mapLayers";

export const HILLSHADE_LAYER = "rp-hillshade";
const DEM_SOURCE = "rp-dem";

export const BASEMAP_BACKGROUND = "#1a2129";
/** Shown under satellite imagery while tiles stream, instead of black. */
export const SATELLITE_BACKGROUND = "#4a5058";

const LAND = BASEMAP_BACKGROUND;
const WATER = "#163246";
const WATERWAY = "#21455e";
const WOOD = "#1c2723";
const PARK = "#1f2a25";
const RESIDENTIAL = "#222a32";
const BUILDING = "#262e37";
const ROAD_MINOR = "#363b40";
const ROAD_MAJOR = "#4b5157";
const ROAD_MOTORWAY = "#5d6369";
const BOUNDARY = "#6f7a86";
const LABEL = "#b9c3cc";
const LABEL_MAJOR = "#dde3e9";
const LABEL_HALO = "rgba(10, 14, 19, 0.9)";

type Paint = Record<string, unknown>;

/** Paint overrides by OpenFreeMap dark layer id; ids missing from the style are ignored. */
const PAINT: Record<string, Paint> = {
  background: { "background-color": LAND },
  water: { "fill-color": WATER },
  waterway: { "line-color": WATERWAY },
  landcover_ice_shelf: { "fill-color": LAND },
  landcover_glacier: { "fill-color": LAND },
  landuse_residential: { "fill-color": RESIDENTIAL, "fill-opacity": 0.7 },
  landcover_wood: { "fill-color": WOOD, "fill-opacity": 0.7 },
  landuse_park: { "fill-color": PARK },
  building: { "fill-color": BUILDING, "fill-outline-color": "#2f3842" },
  "aeroway-area": { "fill-color": "#232a31" },
  "aeroway-runway": { "line-color": "#2c333a" },
  road_area_pier: { "fill-color": LAND },
  road_pier: { "line-color": LAND },
  highway_path: { "line-color": "#2d3238" },
  highway_minor: { "line-color": ROAD_MINOR },
  highway_major_casing: { "line-color": "#30363c" },
  highway_major_inner: { "line-color": ROAD_MAJOR },
  highway_major_subtle: { "line-color": ROAD_MAJOR },
  highway_motorway_casing: { "line-color": "#353b41" },
  highway_motorway_inner: { "line-color": ROAD_MOTORWAY },
  highway_motorway_subtle: { "line-color": ROAD_MOTORWAY },
  railway: { "line-color": "#3a3f45" },
  railway_minor: { "line-color": "#3a3f45" },
  railway_transit: { "line-color": "#3a3f45" },
  water_name: { "text-color": "#7fa3bd", "text-halo-color": LABEL_HALO },
  highway_name_other: { "text-color": "#8b949d", "text-halo-color": LABEL_HALO },
  highway_name_motorway: { "text-color": "#9aa3ac" },
  boundary_state: { "line-color": BOUNDARY },
  "boundary_country_z0-4": { "line-color": BOUNDARY },
  "boundary_country_z5-": { "line-color": BOUNDARY },
};

const PLACE_LABELS = ["place_other", "place_suburb", "place_village", "place_town"];
const PLACE_LABELS_MAJOR = [
  "place_city",
  "place_city_large",
  "place_state",
  "place_country_other",
  "place_country_minor",
  "place_country_major",
];

interface StyleLayer {
  id: string;
  type: string;
  paint?: Paint;
  [key: string]: unknown;
}

/** A restyled copy of the dark style; the input is not modified. */
export function restyleDarkBasemap(style: BasemapStyle): BasemapStyle {
  const layers: StyleLayer[] = (style.layers as unknown as StyleLayer[]).map((layer): StyleLayer => {
    const override = {
      ...(PAINT[layer.id] ?? {}),
      ...(PLACE_LABELS.includes(layer.id) ? { "text-color": LABEL, "text-halo-color": LABEL_HALO } : {}),
      ...(PLACE_LABELS_MAJOR.includes(layer.id) ? { "text-color": LABEL_MAJOR, "text-halo-color": LABEL_HALO } : {}),
    };
    const paint: Paint = { ...(layer.paint ?? {}), ...override };
    // The style's wood pattern is not in its sprite (console warning, nothing drawn).
    delete paint["fill-pattern"];
    return { ...layer, paint };
  });

  // County lines (OpenMapTiles boundary admin_level 6), under the state line.
  const stateIndex = layers.findIndex((l) => l.id === "boundary_state");
  const omtSource = layers.find((l) => l.id === "boundary_state")?.source;
  if (stateIndex >= 0 && typeof omtSource === "string") {
    layers.splice(stateIndex, 0, {
      id: "rp-boundary-county",
      type: "line",
      source: omtSource,
      "source-layer": "boundary",
      minzoom: 7,
      filter: ["all", ["==", ["get", "admin_level"], 6], ["!=", ["get", "maritime"], 1]],
      paint: { "line-color": BOUNDARY, "line-opacity": 0.55, "line-width": 0.8, "line-dasharray": [3, 2] },
    });
  }

  // Terrain hillshade just above land cover, so ridges and canyons read under roads and labels.
  const firstLine = layers.findIndex((l) => l.type === "line" || l.type === "symbol");
  layers.splice(firstLine >= 0 ? firstLine : layers.length, 0, {
    id: HILLSHADE_LAYER,
    type: "hillshade",
    source: DEM_SOURCE,
    paint: {
      "hillshade-exaggeration": 0.45,
      "hillshade-shadow-color": "rgba(0, 0, 0, 0.55)",
      "hillshade-highlight-color": "rgba(220, 230, 240, 0.10)",
      "hillshade-accent-color": "rgba(0, 0, 0, 0.25)",
    },
  });

  return {
    ...style,
    sources: {
      ...style.sources,
      [DEM_SOURCE]: {
        type: "raster-dem",
        tiles: [TERRAIN_TILES_URL],
        encoding: "terrarium",
        tileSize: 256,
        maxzoom: 15,
        attribution: TERRAIN_ATTRIBUTION,
      },
    },
    layers: layers as unknown as BasemapStyle["layers"],
  };
}
