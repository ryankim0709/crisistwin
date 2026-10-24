/** Basemap loading and map images shared by the /live and /demo maps. */

import { restyleBasemap } from "../replay/basemapStyle";
import { BASEMAP_STYLE_URL, FALLBACK_STYLE, type BasemapStyle } from "../replay/mapLayers";

const STYLE_TIMEOUT_MS = 10_000;

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
