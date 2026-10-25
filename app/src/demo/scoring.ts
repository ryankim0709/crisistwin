/**
 * Outcome metrics of a command-board run (casualties, people unable to reach safety, homes
 * burned, area burned, containment and out times), for the /live outcomes panel, the AI
 * commander's observation and the headless evaluation harness (app/scripts/live-eval). Pure:
 * reads the board (demo/model.ts), no React, network or LLM. Every number is a board model
 * output or a count derived from one; the methods are named in each field and in
 * docs/command-demo-realism.md ("Run metrics").
 *
 * Units: persons and households (counts), hectares, board minutes (T+0 = board start).
 */

import { DEVELOPED_FUEL_CODE } from "../fire/spread";
import { CELL_STATE_CODE, fireCellStates } from "./fireState";
import { fireAreaHa, withVehicle, type Board, type ZoneState } from "./model";
import { ORDER_COMPLIANCE } from "./realism";
import { injuryScore, type InjuryScore } from "./injuries";

/** FBFM40 non-burnable codes other than developed ground (92 snow/ice, 93 agriculture, 98 water, 99 barren). */
const NON_BURNABLE_MIN = 92;
const NON_BURNABLE_MAX = 99;

/**
 * How homes burned are counted: the board carries no household points (the snapshot's synthetic
 * home points are not loaded onto the board), so each zone's households are spread evenly over
 * its developed cells (FBFM40 91, where the solver runs structure-to-structure spread); a zone
 * with no developed cell spreads them over its burnable cells instead.
 * ASSUMPTION (method, not sourced): homes are uniform over those cells.
 */
export const HOMES_METHOD_LABEL =
  "Zone share of developed cells (FBFM40 91) that burned x the zone's households (zones without developed cells: share of burnable cells). ASSUMPTION: homes spread evenly over those cells; the board has no household points.";

/** Persons (null = unknown) and households. */
export interface Count {
  people: number | null;
  households: number;
}

/** Why the households caught at a zone's overrun were still home (model.ts departed: only ordered households with a vehicle leave). */
export interface CaughtBreakdown {
  /** Carless households (need transport; the board has no pickup). */
  noVehicle: Count;
  /** Households with a vehicle in a zone never ordered out (no self-evacuation on this board). */
  noOrder: Count;
  /** Ordered households with a vehicle that do not comply (1 - ORDER_COMPLIANCE; stay and defend / wait and see). */
  stayedDespiteOrder: Count;
  /** Ordered, complying households with a vehicle that had not left yet (departure delay): an earlier order saves these. */
  tooLate: Count;
}

/** Persons per household with a vehicle in the zone (null when the zone's persons are unknown). */
function vehiclePersonsPerHousehold(zone: ZoneState): number | null {
  if (zone.occupants === null) return null;
  const w = withVehicle(zone);
  return w > 0 ? Math.max(0, zone.occupants - (zone.needsTransportOccupants ?? 0)) / w : 0;
}

/**
 * Split of a zone's caught households (zone.caught, frozen at its overrun) by why they were home.
 * Households are exact counts from the board; persons apportion vehicle persons evenly per
 * household with a vehicle (the board's own assumption, model.ts ZonePeople) and are rounded, so
 * the persons of the parts can differ from zone.caughtPeople by rounding (at most 1 per part).
 */
export function caughtBreakdown(zone: ZoneState): CaughtBreakdown {
  const empty = (): Count => ({ people: zone.occupants === null ? null : 0, households: 0 });
  const out: CaughtBreakdown = { noVehicle: empty(), noOrder: empty(), stayedDespiteOrder: empty(), tooLate: empty() };
  if (zone.overrunAt === null || zone.caught <= 0) return out;
  const perVehicleHousehold = vehiclePersonsPerHousehold(zone);
  const persons = (households: number) => (perVehicleHousehold === null ? null : Math.round(households * perVehicleHousehold));
  const carless = Math.min(zone.noVehicle, zone.caught);
  out.noVehicle = { households: carless, people: zone.occupants === null ? null : (zone.needsTransportOccupants ?? 0) };
  const withCar = Math.max(0, zone.caught - carless);
  if (zone.orderedAt === null || zone.orderedAt > zone.overrunAt) {
    out.noOrder = { households: withCar, people: persons(withCar) };
    return out;
  }
  const stayed = Math.min(withCar, Math.round(withVehicle(zone) * (1 - ORDER_COMPLIANCE)));
  out.stayedDespiteOrder = { households: stayed, people: persons(stayed) };
  out.tooLate = { households: withCar - stayed, people: persons(withCar - stayed) };
  return out;
}

export interface ZoneHomes {
  zoneId: string;
  households: number;
  /** Cells homes are spread over (developed, else burnable), and of them burned / put out by crews. */
  homeCells: number;
  basis: "developed" | "burnable" | "none";
  burnedCells: number;
  savedCells: number;
  /** households x burnedCells / homeCells, rounded. */
  homesBurned: number;
  /** households x savedCells / homeCells, rounded: reached by fire, put out by suppression before burning out. */
  homesReachedSaved: number;
}

/** Cells of each zone that carry its homes (developed, else burnable), cached per landscape. */
const homeCellCache = new WeakMap<object, Map<string, { cells: number[]; basis: ZoneHomes["basis"] }>>();

function homeCellsOf(board: Board, zone: ZoneState): { cells: number[]; basis: ZoneHomes["basis"] } {
  const grid = board.env.landscape;
  let byZone = homeCellCache.get(board.solver.zoneCells);
  if (!byZone) {
    byZone = new Map();
    homeCellCache.set(board.solver.zoneCells, byZone);
  }
  const hit = byZone.get(zone.id);
  if (hit) return hit;
  const raster = board.solver.zoneCells.get(zone.id);
  const all = raster ? Array.from(raster.cells) : [];
  const developed = all.filter((c) => grid.fuelCodes[c] === DEVELOPED_FUEL_CODE);
  const burnable = all.filter((c) => grid.fuelCodes[c] > 0 && !(grid.fuelCodes[c] >= NON_BURNABLE_MIN && grid.fuelCodes[c] <= NON_BURNABLE_MAX));
  const value = developed.length > 0
    ? { cells: developed, basis: "developed" as const }
    : burnable.length > 0
      ? { cells: burnable, basis: "burnable" as const }
      : { cells: [], basis: "none" as const };
  byZone.set(zone.id, value);
  return value;
}

/**
 * Homes burned per zone at the board minute (HOMES_METHOD_LABEL). A cell burning now or burned out
 * counts as burned (a cell still burning at the end of a run is counted as lost, conservative); a
 * cell put out by crews before it burned out counts as reached but saved.
 */
export function zoneHomes(board: Board): ZoneHomes[] {
  const codes = fireCellStates(board);
  return board.zones.map((zone) => {
    const { cells, basis } = homeCellsOf(board, zone);
    let burned = 0;
    let saved = 0;
    for (const c of cells) {
      const code = codes[c];
      if (code === CELL_STATE_CODE.burning || code === CELL_STATE_CODE.burned_out) burned += 1;
      else if (code === CELL_STATE_CODE.extinguished) saved += 1;
    }
    const share = (n: number) => (cells.length > 0 ? Math.round((zone.households * n) / cells.length) : 0);
    return {
      zoneId: zone.id,
      households: zone.households,
      homeCells: cells.length,
      basis,
      burnedCells: burned,
      savedCells: saved,
      homesBurned: share(burned),
      homesReachedSaved: share(saved),
    };
  });
}

/**
 * Homes (households) in a zone the fire `sourceIndex` reaches by board minute `byMinute` in the
 * solver's current forecast, by the same method (a free-burn forecast where the fire is not held
 * by line; the field already includes line built). Used by the strategy decision aid.
 */
export function forecastHomesBurned(board: Board, sourceIndex: number, byMinute: number): { total: number; byZone: Record<string, number> } {
  const field = board.solver.field;
  const byZone: Record<string, number> = {};
  let total = 0;
  if (!field) return { total, byZone };
  for (const zone of board.zones) {
    const { cells } = homeCellsOf(board, zone);
    if (cells.length === 0) continue;
    let n = 0;
    for (const c of cells) if (field.sourceIndexByCell[c] === sourceIndex && field.arrivalMinutes[c] <= byMinute) n += 1;
    if (n === 0) continue;
    const homes = Math.round((zone.households * n) / cells.length);
    if (homes > 0) {
      byZone[zone.id] = homes;
      total += homes;
    }
  }
  return { total, byZone };
}

export interface RunScore {
  minute: number;
  /** Caught = still home when fire reached the zone core (zones overrun now; board.caughtTotal for the whole run). */
  casualties: Count & { breakdown: CaughtBreakdown; zones: string[] };
  casualtiesRunHouseholds: number;
  casualtiesRunPeople: number | null;
  /** Homes (households) burned and reached-but-saved, by HOMES_METHOD_LABEL. */
  homesBurned: number;
  homesReachedSaved: number;
  homesMethod: string;
  homesByZone: { zoneId: string; homesBurned: number; homesReachedSaved: number }[];
  /** Burned area over every fire (removed ones included), hectares. */
  areaBurnedHa: number;
  fires: { burning: number; contained: number; out: number };
  /** Simulated injuries (demo/injuries.ts): people injured so far, injury deaths (nobody reached them), open, treated, transported. */
  injuries: InjuryScore;
}

const add = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b);

/** The run's outcome metrics now (see the field docs). */
export function runScore(board: Board): RunScore {
  const breakdown: CaughtBreakdown = {
    noVehicle: { people: 0, households: 0 },
    noOrder: { people: 0, households: 0 },
    stayedDespiteOrder: { people: 0, households: 0 },
    tooLate: { people: 0, households: 0 },
  };
  const casualties: RunScore["casualties"] = { people: 0, households: 0, breakdown, zones: [] };
  for (const zone of board.zones) {
    if (zone.overrunAt === null) continue;
    casualties.households += zone.caught;
    casualties.people = add(casualties.people, zone.caughtPeople);
    if (zone.caught > 0) casualties.zones.push(zone.id);
    const b = caughtBreakdown(zone);
    for (const k of Object.keys(breakdown) as (keyof CaughtBreakdown)[]) {
      breakdown[k].households += b[k].households;
      breakdown[k].people = add(breakdown[k].people, b[k].people);
    }
  }
  const homes = zoneHomes(board);
  let area = board.removedBurnedHa;
  const fires = { burning: 0, contained: 0, out: board.firesOutTotal };
  for (const f of board.fires) {
    area += fireAreaHa(f);
    if (f.status === "burning") fires.burning += 1;
    else if (f.status === "contained") fires.contained += 1;
  }
  return {
    minute: board.minute,
    casualties,
    casualtiesRunHouseholds: board.caughtTotal,
    casualtiesRunPeople: board.caughtPeopleTotal,
    homesBurned: homes.reduce((s, z) => s + z.homesBurned, 0),
    homesReachedSaved: homes.reduce((s, z) => s + z.homesReachedSaved, 0),
    homesMethod: HOMES_METHOD_LABEL,
    homesByZone: homes.filter((z) => z.homesBurned > 0 || z.homesReachedSaved > 0).map((z) => ({ zoneId: z.zoneId, homesBurned: z.homesBurned, homesReachedSaved: z.homesReachedSaved })),
    areaBurnedHa: Math.round(area * 10) / 10,
    fires,
    injuries: injuryScore(board),
  };
}
