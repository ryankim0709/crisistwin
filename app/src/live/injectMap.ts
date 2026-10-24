// Map layers of the drill injects, installed by CommandMap: zones with no phone signal get a
// hatched grey overlay with a text tag, and each point inject a ringed mark with its label.
import type { Map as MapLibreMap } from "maplibre-gl";

const SOURCES = ["lc-nosignal", "lc-inject-marks"];
const INK = "#0F1720";
const GREY = "#6B7380";

function greyHatch(): ImageData {
  const size = 10;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.strokeStyle = GREY;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const o of [-size, 0, size]) {
    ctx.moveTo(o, 0);
    ctx.lineTo(o + size, size);
  }
  ctx.stroke();
  return ctx.getImageData(0, 0, size, size);
}

export function installInjectLayers(map: MapLibreMap): void {
  const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
  for (const id of SOURCES) map.addSource(id, { type: "geojson", data: empty });
  map.addImage("lc-nosignal-hatch", greyHatch());
  map.addLayer({ id: "lc-nosignal", type: "fill", source: "lc-nosignal", paint: { "fill-pattern": "lc-nosignal-hatch", "fill-opacity": 0.8 } });
  map.addLayer({
    id: "lc-nosignal-line",
    type: "line",
    source: "lc-nosignal",
    paint: { "line-color": GREY, "line-width": 2, "line-dasharray": [2, 2] },
  });
  map.addLayer({
    id: "lc-nosignal-label",
    type: "symbol",
    source: "lc-nosignal",
    layout: { "text-field": ["get", "text"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-letter-spacing": 0.06 },
    paint: { "text-color": "#3A414C", "text-halo-color": "#FFFFFF", "text-halo-width": 1.8 },
  });
  map.addLayer({
    id: "lc-inject-marks",
    type: "circle",
    source: "lc-inject-marks",
    paint: { "circle-radius": 8, "circle-color": "#FFFFFF", "circle-stroke-color": INK, "circle-stroke-width": 3 },
  });
  map.addLayer({
    id: "lc-inject-labels",
    type: "symbol",
    source: "lc-inject-marks",
    layout: {
      "text-field": ["get", "text"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 11,
      "text-offset": [0, 1.4],
      "text-anchor": "top",
      "text-allow-overlap": true,
    },
    paint: { "text-color": INK, "text-halo-color": "#FFFFFF", "text-halo-width": 1.8 },
  });
}
