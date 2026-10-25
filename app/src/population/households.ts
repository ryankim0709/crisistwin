/**
 * Scenario-snapshot households for a dispatch area: GET /api/dispatch/households
 * (app/backend/api/dispatch_households.py) returns the households of the stored scenario
 * resource snapshots inside the area box, summed into small grid cells (occupants, evacuating
 * vehicles and occupants who need transport; every value an estimate, `basis: "estimated"`).
 * `matchHouseholds` gives each cell to the zone of the nearest synthetic home within
 * MATCH_METERS, so the /dispatch people picture can count people per zone from the snapshot's
 * occupants instead of vehicles × 1.38. Cells farther from every home are left out and counted.
 *
 * The engine still moves the area's synthetic homes with its own vehicles per home: these
 * counts only change how many people each zone's households stand for, never routes, timing or
 * the agent's evaluation.
 */

import { groundMeters, type DispatchArea, type LonLat } from "../dispatch/area";

export const HOUSEHOLDS_URL = "/api/dispatch/households";
/** A cell counts for a zone when a home of the zone lies this close, metres. */
export const MATCH_METERS = 400;
/** Grid of the home index, degrees. */
const INDEX_DEG = 0.004;

export interface HouseholdCells {
  cells: [number, number, number, number, number, number][];
  sources: { incident_id: string | null; snapshot_id: string; households: number }[];
  note: string | null;
}

/** Snapshot people per zone of one area. */
export interface ZoneHouseholds {
  /** Occupants per zone (index = zone), estimated; 0 for a zone no household matched. */
  people: Float64Array;
  /** Households per zone. */
  households: Float64Array;
  /** Occupants of households that need transport (no vehicle), per zone. */
  needsTransport: Float64Array;
  /** True for zones with at least one matched household. */
  matched: boolean[];
  matchedHouseholds: number;
  unmatchedHouseholds: number;
  /** Incident ids of the snapshots used. */
  incidents: string[];
}

export async function loadHouseholds(
  bbox: readonly [number, number, number, number],
  signal: AbortSignal,
): Promise<HouseholdCells> {
  const query = bbox.map((value) => value.toFixed(4)).join(",");
  const response = await fetch(`${HOUSEHOLDS_URL}?bbox=${query}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`The household service returned HTTP ${response.status}.`);
  const body = (await response.json()) as Partial<HouseholdCells>;
  return {
    cells: Array.isArray(body.cells) ? body.cells : [],
    sources: Array.isArray(body.sources) ? body.sources : [],
    note: typeof body.note === "string" ? body.note : null,
  };
}

/** Each household cell to the zone of its nearest synthetic home; null when none matched. */
export function matchHouseholds(area: DispatchArea, data: HouseholdCells): ZoneHouseholds | null {
  if (data.cells.length === 0 || area.homes.length === 0) return null;
  const index = new Map<string, number[]>();
  const key = (x: number, y: number) => `${x}:${y}`;
  area.homes.forEach((home, i) => {
    const k = key(Math.floor(home.position[0] / INDEX_DEG), Math.floor(home.position[1] / INDEX_DEG));
    const list = index.get(k);
    if (list) list.push(i);
    else index.set(k, [i]);
  });
  const zones = area.zones.length;
  const people = new Float64Array(zones);
  const households = new Float64Array(zones);
  const needsTransport = new Float64Array(zones);
  let matchedHouseholds = 0;
  let unmatchedHouseholds = 0;
  for (const [lon, lat, count, occupants, , transport] of data.cells) {
    const point: LonLat = [lon, lat];
    const cx = Math.floor(lon / INDEX_DEG);
    const cy = Math.floor(lat / INDEX_DEG);
    let best = -1;
    let bestMeters = MATCH_METERS;
    for (let dx = -1; dx <= 1; dx += 1)
      for (let dy = -1; dy <= 1; dy += 1)
        for (const home of index.get(key(cx + dx, cy + dy)) ?? []) {
          const meters = groundMeters(point, area.homes[home].position);
          if (meters <= bestMeters) {
            bestMeters = meters;
            best = home;
          }
        }
    if (best < 0) {
      unmatchedHouseholds += count;
      continue;
    }
    const zone = area.homes[best].zone;
    people[zone] += Math.max(0, occupants);
    households[zone] += count;
    needsTransport[zone] += Math.max(0, transport);
    matchedHouseholds += count;
  }
  if (matchedHouseholds === 0) return null;
  return {
    people,
    households,
    needsTransport,
    matched: Array.from(households, (n) => n > 0),
    matchedHouseholds,
    unmatchedHouseholds,
    incidents: [...new Set(data.sources.map((s) => s.incident_id ?? s.snapshot_id))],
  };
}
