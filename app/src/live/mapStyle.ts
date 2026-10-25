/** Basemap loading and map images shared by the /live and /demo maps. */

import { restyleBasemap } from "../replay/basemapStyle";
import { BASEMAP_STYLE_URL, FALLBACK_STYLE, type BasemapStyle } from "../replay/mapLayers";

const STYLE_TIMEOUT_MS = 10_000;

/**
 * USGS aerial imagery, the same tiles as the /fire and Simulation Studio map views
 * (StudioMap.tsx SATELLITE_STYLE), plus the OpenFreeMap glyphs our symbol labels need.
 */
export const SATELLITE_STYLE: BasemapStyle = {
  version: 8,
  glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  sources: {
    imagery: {
      type: "raster",
      tiles: ["https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      maxzoom: 16,
      attribution:
        '<a href="https://www.usgs.gov/programs/national-geospatial-program/national-map">USDA / USGS The National Map</a> · Aerial imagery',
    },
  },
  layers: [{ id: "imagery", type: "raster", source: "imagery" }],
};

export async function loadStyle(signal: AbortSignal): Promise<BasemapStyle> {
  const timeout = new AbortController();
  const timer = window.setTimeout(() => timeout.abort(), STYLE_TIMEOUT_MS);
  const abort = () => timeout.abort();
  signal.addEventListener("abort", abort);
  try {
    const response = await fetch(BASEMAP_STYLE_URL, { signal: timeout.signal });
    if (!response.ok) return FALLBACK_STYLE;
    const style: unknown = await response.json();
    if (typeof style !== "object" || style === null || !("layers" in style) || !Array.isArray(style.layers)) {
      return FALLBACK_STYLE;
    }
    return restyleBasemap(style as BasemapStyle);
  } catch {
    return FALLBACK_STYLE;
  } finally {
    window.clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

/** Diagonal hatch for fire areas, so they never read as a tinted evacuation zone. */
export function fireHatch(edgeColor: string): ImageData {
  const size = 10;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.strokeStyle = edgeColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const o of [-size, 0, size]) {
    ctx.moveTo(o, size);
    ctx.lineTo(o + size, 0);
  }
  ctx.stroke();
  return ctx.getImageData(0, 0, size, size);
}
