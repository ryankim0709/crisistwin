/**
 * Prebuilt California landscape regions (13: eleven in the San Francisco Bay Area, two in Los
 * Angeles County), for the `/fire` diorama
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
    id: "oakland-montclair-redwood",
    name: "Montclair & Redwood Regional",
    area: "San Francisco Bay Area",
    counties: ["Alameda"],
    summary:
      "Montclair and Piedmont Ave hills above Shepherd Canyon, Joaquin Miller and Redwood parks.",
    station: {
      name: "Oakland Fire Station 24",
      agency: "Oakland Fire Department",
      latitude: 37.8235,
      longitude: -122.2034,
      osm: "node/246294774",
    },
    center: { latitude: 37.82, longitude: -122.195 },
    radiusMeters: 6_500,
    cellMeters: 30,
  },
  {
    id: "berkeley-hills-tilden",
    name: "Berkeley Hills & Tilden",
    area: "San Francisco Bay Area",
    counties: ["Alameda", "Contra Costa"],
    summary:
      "Claremont Canyon, Berkeley hills and Kensington beside Tilden and Wildcat Canyon parks.",
    station: {
      name: "Berkeley Fire Station 7",
      agency: "Berkeley Fire Department",
      latitude: 37.8909,
      longitude: -122.2515,
      osm: "node/288988876",
    },
    center: { latitude: 37.895, longitude: -122.23 },
    radiusMeters: 6_000,
    cellMeters: 30,
  },
  {
    id: "moraga-las-trampas",
    name: "Moraga & Las Trampas",
    area: "San Francisco Bay Area",
    counties: ["Contra Costa"],
    summary: "Moraga and Rheem Valley below the Las Trampas ridge and Briones grassland hills.",
    station: {
      name: "Moraga-Orinda Fire District Station 41",
      agency: "Moraga-Orinda Fire District",
      latitude: 37.8356,
      longitude: -122.1325,
      osm: "way/1024146371",
    },
    center: { latitude: 37.845, longitude: -122.11 },
    radiusMeters: 6_500,
    cellMeters: 30,
  },
  {
    id: "clayton-mt-diablo",
    name: "Clayton & Mt Diablo North",
    area: "San Francisco Bay Area",
    counties: ["Contra Costa"],
    summary:
      "Clayton and Concord's edge, Mitchell Canyon and the north slopes of Mt Diablo State Park.",
    station: {
      name: "Contra Costa County Fire Station 8",
      agency: "Contra Costa County Fire Protection District",
      latitude: 37.9622,
      longitude: -121.9847,
      osm: "way/610600073",
    },
    center: { latitude: 37.93, longitude: -121.95 },
    radiusMeters: 8_000,
    cellMeters: 30,
  },
  {
    id: "mill-valley-mt-tam",
    name: "Mill Valley & Mt Tamalpais",
    area: "San Francisco Bay Area",
    counties: ["Marin"],
    summary:
      "Mill Valley, Kentfield and Muir Woods canyons below Mt Tamalpais's chaparral and redwood slopes.",
    station: {
      name: "Mill Valley Fire Department",
      agency: "Mill Valley Fire Department",
      latitude: 37.9074,
      longitude: -122.5479,
      osm: "way/629313250",
    },
    center: { latitude: 37.91, longitude: -122.58 },
    radiusMeters: 7_000,
    cellMeters: 30,
  },
  {
    id: "angwin-howell-mountain",
    name: "Angwin & Howell Mountain",
    area: "San Francisco Bay Area",
    counties: ["Napa"],
    summary: "Angwin and Pope Valley around Howell Mountain's oak, chaparral and conifer slopes.",
    station: {
      name: "Angwin Volunteer Fire Department",
      agency: "Angwin Volunteer Fire Department",
      latitude: 38.5757,
      longitude: -122.4448,
      osm: "way/978507096",
    },
    center: { latitude: 38.56, longitude: -122.43 },
    radiusMeters: 6_500,
    cellMeters: 30,
  },
  {
    id: "glen-ellen-sugarloaf",
    name: "Glen Ellen & Sugarloaf",
    area: "San Francisco Bay Area",
    counties: ["Sonoma"],
    summary: "Glen Ellen and Kenwood beside Sugarloaf Ridge, Jack London and Hood Mountain ridges.",
    station: {
      name: "CAL FIRE Sonoma-Lake-Napa Unit Glen Ellen Station",
      agency: "California Department of Forestry and Fire Protection",
      latitude: 38.364,
      longitude: -122.5108,
      osm: "way/625162205",
    },
    center: { latitude: 38.39, longitude: -122.5 },
    radiusMeters: 7_000,
    cellMeters: 30,
  },
  {
    id: "fountaingrove-hood-mountain",
    name: "Fountaingrove & Hood Mountain",
    area: "San Francisco Bay Area",
    counties: ["Sonoma"],
    summary:
      "Fountaingrove and Santa Rosa's eastern edge below Hood Mountain and Annadel oak woodland.",
    station: {
      name: "Santa Rosa Fire Station 5",
      agency: "Santa Rosa Fire Department",
      latitude: 38.4858,
      longitude: -122.7107,
      osm: "way/1549801414",
    },
    center: { latitude: 38.47, longitude: -122.66 },
    radiusMeters: 7_000,
    cellMeters: 30,
  },
  {
    id: "boulder-creek-big-basin",
    name: "Boulder Creek & Big Basin",
    area: "San Francisco Bay Area",
    counties: ["Santa Cruz"],
    summary:
      "Boulder Creek and Brookdale in San Lorenzo Valley redwoods up to Big Basin Redwoods State Park.",
    station: {
      name: "Boulder Creek Fire Protection District",
      agency: "Boulder Creek Fire Protection District",
      latitude: 37.1258,
      longitude: -122.1222,
      osm: "way/218390679",
    },
    center: { latitude: 37.15, longitude: -122.17 },
    radiusMeters: 7_500,
    cellMeters: 30,
  },
  {
    id: "los-gatos-sierra-azul",
    name: "Los Gatos & Sierra Azul",
    area: "San Francisco Bay Area",
    counties: ["Santa Clara"],
    summary:
      "Los Gatos hills, Lexington and Redwood Estates beside Sierra Azul and Almaden Quicksilver preserves.",
    station: {
      name: "Shannon Fire Station",
      agency: "Santa Clara County Fire Department",
      latitude: 37.2323,
      longitude: -121.9582,
      osm: "way/125199750",
    },
    center: { latitude: 37.205, longitude: -121.96 },
    radiusMeters: 6_500,
    cellMeters: 30,
  },
  {
    id: "alum-rock-diablo-range",
    name: "Alum Rock & Diablo Range",
    area: "San Francisco Bay Area",
    counties: ["Santa Clara"],
    summary:
      "East San José foothills, Alum Rock Park and Sierra Vista grass and oak ridges of the Diablo Range.",
    station: {
      name: "San Jose Fire Station 2",
      agency: "San Jose Fire Department",
      latitude: 37.3646,
      longitude: -121.8315,
      osm: "way/508129022",
    },
    center: { latitude: 37.38, longitude: -121.79 },
    radiusMeters: 7_000,
    cellMeters: 30,
  },
  {
    id: "altadena-eaton-canyon",
    name: "Altadena & Eaton Canyon",
    area: "Southern California",
    counties: ["Los Angeles"],
    summary: "Altadena's north edge against Eaton Canyon, Mount Lowe and the Angeles foothills.",
    station: {
      name: "LACoFD Station 11",
      agency: "Los Angeles County Fire Department",
      latitude: 34.1885,
      longitude: -118.133,
      osm: "way/1353638773",
    },
    center: { latitude: 34.2005, longitude: -118.125 },
    radiusMeters: 7_000,
    cellMeters: 30,
  },
  {
    id: "pacific-palisades",
    name: "Pacific Palisades & Santa Monica Mountains",
    area: "Southern California",
    counties: ["Los Angeles"],
    summary:
      "Palisades streets beside Temescal Canyon, Topanga State Park and Santa Ynez canyon scrub.",
    station: {
      name: "LAFD Station 69",
      agency: "Los Angeles Fire Department",
      latitude: 34.0451,
      longitude: -118.5225,
      osm: "way/193420774",
    },
    center: { latitude: 34.06, longitude: -118.54 },
    radiusMeters: 6_000,
    cellMeters: 30,
  },
];

export const DEFAULT_REGION_ID = "altadena-eaton-canyon";
