/**
 * Fire stations on every 2D map, one look: a red-roofed firehouse pin with a white halo (an
 * icon, so shape and not only colour marks it), air bases as a square-roofed variant, and the
 * station name at closer zooms. Data is the CAL FIRE facilities layer, `GET /api/suppression/bases`
 * (studio/suppressionBases.ts), the same stations the response fleet is built from
 * (response/fleet.ts). Observed, current locations: the replay labels them "today's stations".
 *
 * Quiet by design: while loading, when the layer is unavailable or when nothing is near, no
 * layer is added and nothing is reported.
 *
 * Units: WGS84 degrees (lon, lat); radius in km.
 */

import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import { STATION_TYPES, parseBases, type SuppressionBase } from "../studio/suppressionBases";

export interface MapStation {
  id: string;
  /** Plain label: "Paradise FS · CAL FIRE". */
  label: string;
  lon: number;
  lat: number;
  /** Helitack or air attack base. */
  air: boolean;
}

/** Colours baked into MapLibre / three.js (kept here, not in CSS). */
export const STATION_STYLE = { roof: "#c8352a", wall: "#fff8ef", halo: "#ffffff", ink: "#1f2a24" } as const;

export const STATIONS_LEGEND = "Fire station (CAL FIRE facilities, current locations)";
export const STATIONS_LAYER_LABEL = "Fire stations";

const SOURCE = "ct-stations";
const ICON_STATION = "ct-station-icon";
const ICON_AIR = "ct-station-air-icon";
export const STATION_LAYER_IDS = ["ct-station-pins", "ct-station-labels"] as const;
const FONT = ["Noto Sans Regular"];
const RADIUS_KM = 60;
const cache = new globalThis.Map<string, MapStation[]>();

function agencyShort(agency: string): string {
  const a = agency.trim();
  if (!a) return "";
  if (/cal\s*fire|cdf|forestry/i.test(a)) return "CAL FIRE";
  return a.length > 24 ? `${a.slice(0, 22)}…` : a;
}

/** Stations and air bases from a bases response, with a plain label each. */
export function stationsFrom(bases: SuppressionBase[]): MapStation[] {
  return bases.flatMap((b) => {
    const air = b.type === "HB" || b.type === "AAB";
    if (!air && !STATION_TYPES.has(b.type)) return [];
    const agency = agencyShort(b.agency);
    const name = air ? `${b.name} (${b.type === "HB" ? "helitack" : "air attack"} base)` : b.name;
    return [{ id: b.id, label: agency ? `${name} · ${agency}` : name, lon: b.lon, lat: b.lat, air }];
  });
}

/** Stations within `radiusKm` of a point; [] on any failure (callers draw nothing). */
export async function fetchStations(lon: number, lat: number, signal?: AbortSignal, radiusKm = RADIUS_KM): Promise<MapStation[]> {
  const key = `${lon.toFixed(1)},${lat.toFixed(1)},${radiusKm}`;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const r = await fetch(`/api/suppression/bases?lon=${lon.toFixed(3)}&lat=${lat.toFixed(3)}&radius_km=${radiusKm}`, {
      signal,
      headers: { Accept: "application/json" },
    });
    if (!r.ok) return [];
    const parsed = parseBases(await r.json());
    const list = parsed.available ? stationsFrom(parsed.bases) : [];
    cache.set(key, list);
    return list;
  } catch {
    return [];
  }
}

/** Firehouse icon: roof, wall, bay door on a white halo. Air bases: a square badge. */
function drawIcon(air: boolean): ImageData {
  const s = 56;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  g.lineJoin = "round";
  const outline = () => {
    g.beginPath();
    if (air) g.rect(10, 8, 36, 36);
    else {
      g.moveTo(8, 24);
      g.lineTo(28, 7);
      g.lineTo(48, 24);
      g.lineTo(48, 44);
      g.lineTo(8, 44);
    }
    g.closePath();
  };
  outline();
  g.lineWidth = 9;
  g.strokeStyle = STATION_STYLE.halo;
  g.stroke();
  outline();
  g.fillStyle = STATION_STYLE.wall;
  g.fill();
  g.lineWidth = 2.5;
  g.strokeStyle = STATION_STYLE.ink;
  g.stroke();
  g.fillStyle = STATION_STYLE.roof;
  if (air) g.fillRect(10, 8, 36, 12);
  else {
    g.beginPath();
    g.moveTo(8, 24);
    g.lineTo(28, 7);
    g.lineTo(48, 24);
    g.closePath();
    g.fill();
  }
  g.fillRect(22, 28, 12, 16);
  return g.getImageData(0, 0, s, s);
}

export interface StationsHandle {
  setVisible(visible: boolean): void;
  dispose(): void;
}

/**
 * Add the station layer to a loaded map. Fetches around `center` (or the map centre, refetching
 * when a pan moves it well away). `labelSuffix` is appended to every label ("today's stations").
 */
export function attachStations(
  map: MapLibreMap,
  opts: { center?: [number, number]; labelSuffix?: string; radiusKm?: number } = {},
): StationsHandle {
  const controller = new AbortController();
  let visible = true;
  let last: [number, number] | null = null;
  let disposed = false;

  const ensureLayers = () => {
    if (map.getSource(SOURCE)) return;
    if (!map.hasImage(ICON_STATION)) map.addImage(ICON_STATION, drawIcon(false), { pixelRatio: 2 });
    if (!map.hasImage(ICON_AIR)) map.addImage(ICON_AIR, drawIcon(true), { pixelRatio: 2 });
    map.addSource(SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    const vis = visible ? "visible" : "none";
    map.addLayer({
      id: "ct-station-pins",
      type: "symbol",
      source: SOURCE,
      minzoom: 8,
      layout: {
        "icon-image": ["case", ["get", "air"], ICON_AIR, ICON_STATION],
        "icon-size": ["interpolate", ["linear"], ["zoom"], 8, 0.5, 12, 0.8, 15, 1],
        "icon-allow-overlap": true,
        visibility: vis,
      },
    });
    map.addLayer({
      id: "ct-station-labels",
      type: "symbol",
      source: SOURCE,
      minzoom: 11,
      layout: {
        "text-field": ["get", "label"],
        "text-font": FONT,
        "text-size": 11,
        "text-offset": [0, 1.3],
        "text-anchor": "top",
        "text-max-width": 14,
        "text-optional": true,
        visibility: vis,
      },
      paint: { "text-color": STATION_STYLE.ink, "text-halo-color": STATION_STYLE.halo, "text-halo-width": 1.6 },
    });
  };

  const load = async (lon: number, lat: number) => {
    last = [lon, lat];
    const list = await fetchStations(lon, lat, controller.signal, opts.radiusKm);
    if (disposed || list.length === 0) return;
    try {
      ensureLayers();
    } catch {
      return;
    }
    const suffix = opts.labelSuffix ? ` · ${opts.labelSuffix}` : "";
    (map.getSource(SOURCE) as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: list.map((s) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        properties: { label: s.label + suffix, air: s.air },
      })),
    });
  };

  const onMove = () => {
    if (opts.center || !last) return;
    const c = map.getCenter();
    if (Math.hypot(c.lng - last[0], c.lat - last[1]) > 0.4) void load(c.lng, c.lat);
  };
  const c0 = opts.center ?? ([map.getCenter().lng, map.getCenter().lat] as [number, number]);
  void load(c0[0], c0[1]);
  if (!opts.center) map.on("moveend", onMove);

  return {
    setVisible(v) {
      visible = v;
      for (const id of STATION_LAYER_IDS) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", v ? "visible" : "none");
    },
    dispose() {
      disposed = true;
      controller.abort();
      map.off("moveend", onMove);
    },
  };
}
