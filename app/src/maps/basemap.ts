import type { MapOptions, StyleSpecification } from "maplibre-gl";

/**
 * USGS aerial imagery, served through the backend's read-through cache
 * (`GET /api/geo/imagery/{z}/{y}/{x}`, app/backend/api/geo_cache.py), which fetches
 * USGSImageryOnly once and keeps the tile in MongoDB. MapLibre loads tiles in a worker, so
 * the URL must be absolute.
 */
export const GEO_API_PATH = "/api/geo";
export function absoluteUrl(path: string): string {
  return typeof window === "undefined" ? path : `${window.location.origin}${path}`;
}
export const IMAGERY_TILES_URL = absoluteUrl(`${GEO_API_PATH}/imagery/{z}/{y}/{x}`);
/** Terrarium elevation tiles through the same cache (`/api/geo/terrarium/{z}/{x}/{y}.png`). */
export const TERRAIN_TILES_URL = absoluteUrl(`${GEO_API_PATH}/terrarium/{z}/{x}/{y}.png`);
const USGS_LINK =
  '<a href="https://www.usgs.gov/programs/national-geospatial-program/national-map">USDA / USGS The National Map</a>';

/** The one imagery raster source every map uses; `note` follows the credit. */
export function imagerySource(note = "Aerial imagery") {
  return {
    type: "raster" as const,
    tiles: [IMAGERY_TILES_URL],
    tileSize: 256,
    maxzoom: 16,
    attribution: `${USGS_LINK} \u00b7 ${note}`,
  };
}

/** Imagery only, no preview images: the shared satellite style of the Studio, /live and pickers. */
export const AERIAL_STYLE: StyleSpecification = {
  version: 8,
  sources: { imagery: imagerySource() },
  layers: [{ id: "imagery", type: "raster", source: "imagery" }],
};

// Local, georeferenced previews fill the initial view while detailed USGS tiles stream.
// Sources, retrieval time, and bounds are recorded in public/map-preview/provenance.json.
export const SATELLITE_STYLE: MapOptions["style"] = {
  version: 8,
  sources: {
    "sf-preview-0": {
      type: "image",
      url: "/map-preview/81-197.png",
      coordinates: [
        [-123.046875, 38.27268853598096],
        [-122.34375, 38.27268853598096],
        [-122.34375, 37.718590325588146],
        [-123.046875, 37.718590325588146],
      ],
    },
    "sf-preview-1": {
      type: "image",
      url: "/map-preview/82-197.jpg",
      coordinates: [
        [-122.34375, 38.27268853598096],
        [-121.640625, 38.27268853598096],
        [-121.640625, 37.718590325588146],
        [-122.34375, 37.718590325588146],
      ],
    },
    "sf-preview-2": {
      type: "image",
      url: "/map-preview/81-198.png",
      coordinates: [
        [-123.046875, 37.718590325588146],
        [-122.34375, 37.718590325588146],
        [-122.34375, 37.160316546736766],
        [-123.046875, 37.160316546736766],
      ],
    },
    "sf-preview-3": {
      type: "image",
      url: "/map-preview/82-198.png",
      coordinates: [
        [-122.34375, 37.718590325588146],
        [-121.640625, 37.718590325588146],
        [-121.640625, 37.160316546736766],
        [-122.34375, 37.160316546736766],
      ],
    },
    "sf-city": {
      type: "image",
      url: "/map-preview/sf-city.jpg",
      coordinates: [
        [-122.63499566818868, 37.888420595272],
        [-122.2038043318113, 37.888420595272],
        [-122.2038043318113, 37.66120482921475],
        [-122.63499566818868, 37.66120482921475],
      ],
    },
    imagery: imagerySource("Historical imagery"),
  },
  layers: [
    {
      id: "sf-preview-0",
      type: "raster",
      source: "sf-preview-0",
      paint: {
        "raster-fade-duration": 0,
      },
    },
    {
      id: "sf-preview-1",
      type: "raster",
      source: "sf-preview-1",
      paint: {
        "raster-fade-duration": 0,
      },
    },
    {
      id: "sf-preview-2",
      type: "raster",
      source: "sf-preview-2",
      paint: {
        "raster-fade-duration": 0,
      },
    },
    {
      id: "sf-preview-3",
      type: "raster",
      source: "sf-preview-3",
      paint: {
        "raster-fade-duration": 0,
      },
    },
    { id: "sf-city", type: "raster", source: "sf-city", paint: { "raster-fade-duration": 0 } },
    {
      id: "imagery",
      type: "raster",
      source: "imagery",
      paint: {
        "raster-fade-duration": 0,
      },
    },
  ],
};
