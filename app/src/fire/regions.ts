/**
 * Prebuilt California landscape regions, San Francisco Bay Area to San Diego, for the `/fire` diorama
 * (docs/adr/0013-prebuilt-socal-landscapes.md). Each region is built once by
 * `tools/build_landscape_regions` from LANDFIRE fuels/canopy and terrain tiles, stored in
 * MongoDB GridFS, and served by `GET /api/landscapes/<id>`. Each board is station-scale:
 * framed around one real fire station (location from OpenStreetMap) and the neighbourhoods
 * and adjacent wildland it would work, at LANDFIRE's native 30 m. Centres and radii are
 * presentation choices; they are not response-area boundaries or risk designations.
 */
/** Part of the state a region is listed under, in display order. */
export const REGION_AREAS = [
  "San Francisco Bay Area",
  "Central Coast",
  "Central Sierra & Kern",
  "Southern California",
] as const;
export type RegionArea = (typeof REGION_AREAS)[number];

export interface LandscapeRegion {
  id: string;
  name: string;
  area: RegionArea;
  counties: string[];
  /** One line on why the area is included (terrain, vegetation, past fires as context). */
  summary: string;
  /** Station the board is framed around; position from OpenStreetMap (`osm` = "node/<id>"). */
  station: { name: string; agency: string; latitude: number; longitude: number; osm: string };
  center: { latitude: number; longitude: number };
  /** Half-width of the square board, ground metres. */
  radiusMeters: number;
  /** Ground cell size the package is built at (multiple of 30 m). */
  cellMeters: number;
}

export const CALIFORNIA_REGIONS: readonly LandscapeRegion[] = [
  {
    id: "east-bay-hills",
    name: "East Bay hills & Mt Diablo",
    area: "San Francisco Bay Area",
    counties: ["Alameda", "Contra Costa"],
    summary: "Berkeley–Oakland hills, Lamorinda and Mt Diablo above the inner East Bay.",
    center: { latitude: 37.86, longitude: -122.1 },
    radiusMeters: 25_000,
    cellMeters: 60,
  },
  {
    id: "marin-headlands-tamalpais",
    name: "Marin & Mt Tamalpais",
    area: "San Francisco Bay Area",
    counties: ["Marin"],
    summary: "Mt Tamalpais, Point Reyes ridges and the Mill Valley–San Rafael canyon towns.",
    center: { latitude: 38.0, longitude: -122.62 },
    radiusMeters: 25_000,
    cellMeters: 60,
  },
  {
    id: "napa-sonoma-hills",
    name: "Napa & Sonoma hills",
    area: "San Francisco Bay Area",
    counties: ["Napa", "Sonoma"],
    summary: "Mayacamas oak-woodland ridges between Santa Rosa, Napa and St Helena.",
    center: { latitude: 38.45, longitude: -122.55 },
    radiusMeters: 35_000,
    cellMeters: 90,
  },
  {
    id: "santa-cruz-mountains",
    name: "Santa Cruz Mountains",
    area: "San Francisco Bay Area",
    counties: ["Santa Cruz", "San Mateo", "Santa Clara"],
    summary: "Redwood and chaparral ridges around Boulder Creek, Los Gatos and Bonny Doon.",
    center: { latitude: 37.15, longitude: -122.08 },
    radiusMeters: 30_000,
    cellMeters: 90,
  },
  {
    id: "diablo-range-hamilton",
    name: "Diablo Range & Mt Hamilton",
    area: "San Francisco Bay Area",
    counties: ["Santa Clara", "Alameda", "Stanislaus"],
    summary: "Grass and oak rangeland east of San José, Morgan Hill and Livermore.",
    center: { latitude: 37.35, longitude: -121.6 },
    radiusMeters: 35_000,
    cellMeters: 90,
  },
  {
    id: "big-sur-santa-lucia",
    name: "Big Sur & Santa Lucia Range",
    area: "Central Coast",
    counties: ["Monterey"],
    summary: "Steep coastal range from Carmel Valley down the Big Sur coast.",
    center: { latitude: 36.25, longitude: -121.65 },
    radiusMeters: 35_000,
    cellMeters: 90,
  },
  {
    id: "san-luis-obispo-hills",
    name: "San Luis Obispo hills",
    area: "Central Coast",
    counties: ["San Luis Obispo"],
    summary: "Cuesta Ridge chaparral around San Luis Obispo, Atascadero and Santa Margarita.",
    center: { latitude: 35.35, longitude: -120.6 },
    radiusMeters: 30_000,
    cellMeters: 90,
  },
  {
    id: "santa-barbara-front",
    name: "Santa Barbara front country",
    area: "Central Coast",
    counties: ["Santa Barbara"],
    summary: "Santa Ynez Mountains above Goleta, Santa Barbara and Montecito.",
    center: { latitude: 34.5, longitude: -119.8 },
    radiusMeters: 30_000,
    cellMeters: 90,
  },
  {
    id: "mariposa-sierra-foothills",
    name: "Mariposa & Sierra foothills",
    area: "Central Sierra & Kern",
    counties: ["Mariposa", "Madera", "Tuolumne"],
    summary: "Oak and pine foothills below Yosemite around Mariposa, Coulterville and Oakhurst.",
    center: { latitude: 37.5, longitude: -119.9 },
    radiusMeters: 35_000,
    cellMeters: 90,
  },
  {
    id: "kern-river-valley",
    name: "Kern River Valley & southern Sierra",
    area: "Central Sierra & Kern",
    counties: ["Kern", "Tulare"],
    summary: "Lake Isabella, Kernville and Wofford Heights in the southern Sierra.",
    center: { latitude: 35.7, longitude: -118.45 },
    radiusMeters: 35_000,
    cellMeters: 90,
  },
  {
    id: "tehachapi-mountains",
    name: "Tehachapi Mountains & Tejon Pass",
    area: "Central Sierra & Kern",
    counties: ["Kern", "Los Angeles"],
    summary: "Grass and oak ranges around Tehachapi, Frazier Park and the Grapevine.",
    center: { latitude: 34.95, longitude: -118.75 },
    radiusMeters: 35_000,
    cellMeters: 90,
  },
  {
    id: "santa-monica-mountains",
    name: "Santa Monica Mountains & Malibu",
    area: "Southern California",
    counties: ["Los Angeles", "Ventura"],
    summary: "Chaparral ridges and canyon neighbourhoods between the Valley and the coast.",
    center: { latitude: 34.09, longitude: -118.78 },
    radiusMeters: 25_000,
    cellMeters: 60,
  },
  {
    id: "san-gabriel-mountains",
    name: "San Gabriel Mountains & foothills",
    area: "Southern California",
    counties: ["Los Angeles"],
    summary: "Angeles National Forest above the Pasadena–Altadena–Sierra Madre foothill edge.",
    center: { latitude: 34.27, longitude: -118.05 },
    radiusMeters: 35_000,
    cellMeters: 90,
  },
  {
    id: "san-bernardino-mountains",
    name: "San Bernardino Mountains",
    area: "Southern California",
    counties: ["San Bernardino"],
    summary: "Conifer forest around Lake Arrowhead and Big Bear above the Inland Empire.",
    center: { latitude: 34.21, longitude: -117.08 },
    radiusMeters: 35_000,
    cellMeters: 90,
  },
  {
    id: "san-jacinto-mountains",
    name: "San Jacinto Mountains & Idyllwild",
    area: "Southern California",
    counties: ["Riverside"],
    summary: "Steep forested range rising from Hemet and the Coachella Valley.",
    center: { latitude: 33.76, longitude: -116.75 },
    radiusMeters: 30_000,
    cellMeters: 90,
  },
  {
    id: "santa-ana-mountains",
    name: "Santa Ana Mountains",
    area: "Southern California",
    counties: ["Orange", "Riverside"],
    summary: "Cleveland National Forest chaparral between Orange County and Corona–Lake Elsinore.",
    center: { latitude: 33.72, longitude: -117.5 },
    radiusMeters: 30_000,
    cellMeters: 90,
  },
  {
    id: "san-diego-backcountry",
    name: "San Diego backcountry",
    area: "Southern California",
    counties: ["San Diego"],
    summary: "Cuyamaca and Laguna mountains with Ramona, Alpine and Julian.",
    center: { latitude: 32.95, longitude: -116.7 },
    radiusMeters: 40_000,
    cellMeters: 90,
  },
  {
    id: "ventura-los-padres",
    name: "Ventura hills & Los Padres front",
    area: "Southern California",
    counties: ["Ventura"],
    summary: "Ojai valley, Santa Paula and the Los Padres front ranges above Ventura.",
    center: { latitude: 34.42, longitude: -119.15 },
    radiusMeters: 35_000,
    cellMeters: 90,
  },
  {
    id: "santa-clarita-sierra-pelona",
    name: "Santa Clarita & Sierra Pelona",
    area: "Southern California",
    counties: ["Los Angeles"],
    summary: "Castaic, Agua Dulce and canyon communities around the Santa Clarita Valley.",
    center: { latitude: 34.5, longitude: -118.45 },
    radiusMeters: 30_000,
    cellMeters: 90,
  },
  {
    id: "palomar-north-county",
    name: "Palomar & North County San Diego",
    area: "Southern California",
    counties: ["San Diego"],
    summary: "Palomar Mountain, Valley Center, Fallbrook and the hills east of Escondido.",
    center: { latitude: 33.3, longitude: -116.95 },
    radiusMeters: 30_000,
    cellMeters: 90,
  },
];

export const DEFAULT_REGION_ID = "altadena-eaton-canyon";
