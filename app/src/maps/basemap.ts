import type { MapOptions } from "maplibre-gl";

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
    imagery: {
      type: "raster",
      tiles: [
        "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      maxzoom: 16,
      attribution:
        '<a href="https://www.usgs.gov/programs/national-geospatial-program/national-map">USDA / USGS The National Map</a> \u00b7 Historical imagery',
    },
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
