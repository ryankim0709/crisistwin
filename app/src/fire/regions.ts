/**
 * Prebuilt Southern California landscape regions for the `/fire` diorama
 * (docs/adr/0013-prebuilt-socal-landscapes.md). Each region is built once by
 * `tools/build_landscape_regions` from LANDFIRE fuels/canopy and terrain tiles, stored in
 * MongoDB GridFS, and served by `GET /api/landscapes/<id>`. Centres and radii are
 * presentation choices that frame vegetated wildland-urban-interface areas; they are not
 * risk designations.
 */
export interface LandscapeRegion {
  id: string;
  name: string;
  counties: string[];
  /** One line on why the area is included (terrain, vegetation, past fires as context). */
  summary: string;
  center: { latitude: number; longitude: number };
  /** Half-width of the square board, ground metres. */
  radiusMeters: number;
  /** Ground cell size the package is built at (multiple of 30 m). */
  cellMeters: number;
}

export const SOCAL_REGIONS: readonly LandscapeRegion[] = [
  {
    id: "santa-monica-mountains",
    name: "Santa Monica Mountains & Malibu",
    counties: ["Los Angeles", "Ventura"],
    summary: "Chaparral ridges and canyon neighbourhoods between the Valley and the coast.",
    center: { latitude: 34.09, longitude: -118.78 },
    radiusMeters: 25_000,
    cellMeters: 60,
  },
  {
    id: "san-gabriel-mountains",
    name: "San Gabriel Mountains & foothills",
    counties: ["Los Angeles"],
    summary: "Angeles National Forest above the Pasadena–Altadena–Sierra Madre foothill edge.",
    center: { latitude: 34.27, longitude: -118.05 },
    radiusMeters: 35_000,
    cellMeters: 90,
  },
  {
    id: "san-bernardino-mountains",
    name: "San Bernardino Mountains",
    counties: ["San Bernardino"],
    summary: "Conifer forest around Lake Arrowhead and Big Bear above the Inland Empire.",
    center: { latitude: 34.21, longitude: -117.08 },
    radiusMeters: 35_000,
    cellMeters: 90,
  },
  {
    id: "san-jacinto-mountains",
    name: "San Jacinto Mountains & Idyllwild",
    counties: ["Riverside"],
    summary: "Steep forested range rising from Hemet and the Coachella Valley.",
    center: { latitude: 33.76, longitude: -116.75 },
    radiusMeters: 30_000,
    cellMeters: 90,
  },
  {
    id: "santa-ana-mountains",
    name: "Santa Ana Mountains",
    counties: ["Orange", "Riverside"],
    summary: "Cleveland National Forest chaparral between Orange County and Corona–Lake Elsinore.",
    center: { latitude: 33.72, longitude: -117.5 },
    radiusMeters: 30_000,
    cellMeters: 90,
  },
  {
    id: "san-diego-backcountry",
    name: "San Diego backcountry",
    counties: ["San Diego"],
    summary: "Cuyamaca and Laguna mountains with Ramona, Alpine and Julian.",
    center: { latitude: 32.95, longitude: -116.7 },
    radiusMeters: 40_000,
    cellMeters: 90,
  },
  {
    id: "ventura-los-padres",
    name: "Ventura hills & Los Padres front",
    counties: ["Ventura"],
    summary: "Ojai valley, Santa Paula and the Los Padres front ranges above Ventura.",
    center: { latitude: 34.42, longitude: -119.15 },
    radiusMeters: 35_000,
    cellMeters: 90,
  },
];

export const DEFAULT_REGION_ID = "san-gabriel-mountains";
