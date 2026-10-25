import type { GeoPoint } from "../spread";

export type AreaPreset = { id: string; label: string; point: GeoPoint };

export const DEFAULT_AREA: AreaPreset = {
  id: "berkeley-hills",
  label: "Berkeley Hills & Tilden, CA",
  point: { latitude: 37.895, longitude: -122.23 },
};

/** California starting points (Bay Area to San Diego) for a custom area; any CONUS click also works. */
export const AREA_PRESETS: readonly AreaPreset[] = [
  DEFAULT_AREA,
  { id: "altadena", label: "Altadena / Eaton, CA", point: { latitude: 34.19, longitude: -118.13 } },
  { id: "arrowhead", label: "Lake Arrowhead, CA", point: { latitude: 34.25, longitude: -117.19 } },
  {
    id: "santa-rosa",
    label: "Santa Rosa / Tubbs, CA",
    point: { latitude: 38.48, longitude: -122.72 },
  },
  {
    id: "santa-cruz",
    label: "Santa Cruz Mountains, CA",
    point: { latitude: 37.1, longitude: -122.15 },
  },
  { id: "ramona", label: "Ramona, CA", point: { latitude: 33.04, longitude: -116.87 } },
];
