// Restyles an OpenFreeMap basemap into CrisisTwin's light workspace palette (index.css,
// fire.css): ivory land, sage-tinted cover, pale roads, readable place labels, boundaries and
// a faint terrain hillshade. Warm colours stay reserved for fire and cool blue-greens for
// traffic, so the basemap itself is neutral and the overlays read first.
import { TERRAIN_ATTRIBUTION, TERRAIN_TILES_URL } from "./perspectives/perspective";
import type { BasemapStyle } from "./mapLayers";

export const HILLSHADE_LAYER = "rp-hillshade";
const DEM_SOURCE = "rp-dem";

export const BASEMAP_BACKGROUND = "#e3e7d5";
/** Shown under satellite imagery while tiles stream, instead of a dark flash. */
export const SATELLITE_BACKGROUND = "#c8ccbe";

const LAND = BASEMAP_BACKGROUND;
const WATER = "#bdd3dd";
const WATERWAY = "#a2bfcd";
const WOOD = "#d4ddc2";
const PARK = "#d9e2c7";
const RESIDENTIAL = "#e9e8d7";
const BUILDING = "#d3d6c3";
const BUILDING_OUTLINE = "#c3c7b2";
/* Roads are white with a sage casing, the way they are on paper maps, so they read against
   the land while the replay's own road network and congestion colours sit on top of them. */
const ROAD_MINOR = "#f4f4ea";
const ROAD_MAJOR = "#fcfcf6";
const ROAD_MOTORWAY = "#ffffff";
const ROAD_CASING = "#bcc3ab";
const RAILWAY = "#b9bfa8";
const BOUNDARY = "#8b9a8c";
const LABEL = "#52635c";
const LABEL_MAJOR = "#142b27";
const LABEL_HALO = "rgba(245, 244, 238, 0.9)";

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
  building: { "fill-color": BUILDING, "fill-outline-color": BUILDING_OUTLINE },
  "aeroway-area": { "fill-color": "#dcdfcb" },
  "aeroway-runway": { "line-color": "#fcfcf8" },
  "aeroway-runway-casing": { "line-color": ROAD_CASING },
  "aeroway-taxiway": { "line-color": "#f0f0e4" },
  road_area_pier: { "fill-color": LAND },
  road_pier: { "line-color": LAND },
  highway_path: { "line-color": "#cdd2bd" },
  highway_minor: { "line-color": ROAD_MINOR },
  highway_major_casing: { "line-color": ROAD_CASING },
  highway_major_inner: { "line-color": ROAD_MAJOR },
  highway_major_subtle: { "line-color": ROAD_MAJOR },
  highway_motorway_casing: { "line-color": ROAD_CASING },
  highway_motorway_inner: { "line-color": ROAD_MOTORWAY },
  highway_motorway_subtle: { "line-color": ROAD_MOTORWAY },
  railway: { "line-color": RAILWAY },
  railway_minor: { "line-color": RAILWAY },
  railway_transit: { "line-color": RAILWAY },
  railway_dashline: { "line-color": LAND },
  railway_minor_dashline: { "line-color": LAND },
  railway_transit_dashline: { "line-color": LAND },
  water_name: { "text-color": "#41697f", "text-halo-color": LABEL_HALO },
  highway_name_other: { "text-color": "#6b7a71", "text-halo-color": LABEL_HALO },
  highway_name_motorway: { "text-color": "#52635c", "text-halo-color": LABEL_HALO },
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

/** A restyled copy of the upstream style; the input is not modified. */
export function restyleBasemap(style: BasemapStyle): BasemapStyle {
  const layers: StyleLayer[] = (style.layers as unknown as StyleLayer[]).map(
    (layer): StyleLayer => {
      const override = {
        ...(PAINT[layer.id] ?? {}),
        ...(PLACE_LABELS.includes(layer.id)
          ? { "text-color": LABEL, "text-halo-color": LABEL_HALO }
          : {}),
        ...(PLACE_LABELS_MAJOR.includes(layer.id)
          ? { "text-color": LABEL_MAJOR, "text-halo-color": LABEL_HALO }
          : {}),
      };
      const paint: Paint = { ...(layer.paint ?? {}), ...override };
      // The style's wood pattern is not in its sprite (console warning, nothing drawn).
      delete paint["fill-pattern"];
      return { ...layer, paint };
    },
  );

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
      paint: {
        "line-color": BOUNDARY,
        "line-opacity": 0.7,
        "line-width": 0.8,
        "line-dasharray": [3, 2],
      },
    });
  }

  // Terrain hillshade just above land cover, so ridges and canyons read under roads and labels.
  const firstLine = layers.findIndex((l) => l.type === "line" || l.type === "symbol");
  layers.splice(firstLine >= 0 ? firstLine : layers.length, 0, {
    id: HILLSHADE_LAYER,
    type: "hillshade",
    source: DEM_SOURCE,
    paint: {
      "hillshade-exaggeration": 0.35,
      "hillshade-shadow-color": "rgba(63, 82, 70, 0.34)",
      "hillshade-highlight-color": "rgba(255, 255, 255, 0.16)",
      "hillshade-accent-color": "rgba(63, 82, 70, 0.1)",
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
