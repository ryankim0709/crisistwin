/**
 * Firefighting resources for the Studio's suppression model, built from the sourced data in
 * tools/suppression_resources.json (via the generated suppressionData.generated.ts; see
 * docs/suppression-data.md and docs/adr/0048-suppression-engine.md). Every number below is
 * read from that file with its source, or is a named ASSUMPTION constant in this module.
 *
 * Units: line production in metres per hour of ground line; flame lengths in feet (the
 * sources' unit, Hauling chart); speeds in km/h or knots as named; capacities in US gallons.
 */

import { DEVELOPED_FUEL_CODE } from "../fire/spread";
import { SUPPRESSION_DATA, type SuppressionLeaf } from "./suppressionData.generated";

// ---- data access ------------------------------------------------------------------------

/** A generated leaf by its JSON path; throws when the generated module lacks it. */
export function dataLeaf(path: string): SuppressionLeaf {
  const leaf = SUPPRESSION_DATA.leaves[path];
  if (!leaf) throw new Error(`suppression data has no leaf ${path}; regenerate the module`);
  return leaf;
}

export function dataValue<T>(path: string): T {
  return dataLeaf(path).value as T;
}

/** Short provenance for a leaf: "PMS 465 p.140" style source id + page, or "assumption". */
export function provenance(path: string): string {
  const leaf = dataLeaf(path);
  return leaf.assumption ? "assumption" : `${leaf.source} ${leaf.page ?? ""}`.trim();
}

/** 1 chain = 66 ft = 20.1168 m (exact). */
export const METERS_PER_CHAIN = 20.1168;
export const METERS_PER_FOOT = 0.3048;
/** 1 international knot = 1.852 km/h (exact). */
export const KMH_PER_KNOT = 1.852;
/** 1 statute mile = 1.609344 km (exact), so 1 kt = 1.852 / 1.609344 mph. */
export const MPH_PER_KNOT = 1.852 / 1.609344;
export const KG_PER_POUND = 0.45359237;

export const chainsPerHourToMetersPerHour = (chains: number) => chains * METERS_PER_CHAIN;

// ---- apparatus catalogue ----------------------------------------------------------------

/** Road-access vehicle classes of the decision table (docs/suppression-data.md, R01-R12). */
export type AccessClass =
  | "engine_t1_t2"
  | "engine_t3"
  | "engine_t4_t7"
  | "tender_support"
  | "tender_tactical";
export const ACCESS_CLASSES: readonly AccessClass[] = [
  "engine_t1_t2",
  "engine_t3",
  "engine_t4_t7",
  "tender_support",
  "tender_tactical",
];

export type GroundKind =
  | "engine_t1"
  | "engine_t3"
  | "engine_t6"
  | "hand_crew_t1"
  | "hand_crew_t2"
  | "dozer_t1"
  | "dozer_t2"
  | "tender_support"
  | "tender_tactical"
  | "chief";
export type AirKind =
  | "air_attack"
  | "airtanker_vlat"
  | "airtanker_lat"
  | "airtanker_s2t"
  | "airtanker_seat"
  | "helicopter_t1"
  | "helicopter_t2"
  | "helicopter_t3";
export type ApparatusKind = GroundKind | AirKind;

export const GROUND_KINDS: readonly GroundKind[] = [
  "engine_t3",
  "engine_t1",
  "engine_t6",
  "hand_crew_t1",
  "hand_crew_t2",
  "dozer_t2",
  "dozer_t1",
  "tender_tactical",
  "tender_support",
  "chief",
];
export const AIR_KINDS: readonly AirKind[] = [
  "air_attack",
  "airtanker_s2t",
  "airtanker_lat",
  "airtanker_vlat",
  "airtanker_seat",
  "helicopter_t1",
  "helicopter_t2",
  "helicopter_t3",
];
export const APPARATUS_KINDS: readonly ApparatusKind[] = [...GROUND_KINDS, ...AIR_KINDS];

export type LineBuilder =
  | { kind: "engine"; persons: number }
  | { kind: "hand_crew"; crewType: 1 | 2 }
  | { kind: "dozer"; size: "medium_type2" | "large_type1" }
  | null;

export interface GroundApparatus {
  label: string;
  short: string;
  /** Road-access class the vehicle (or its carrier) is routed as. */
  access: AccessClass;
  /** Why it is routed as that class, when that is an assumption. */
  accessNote?: string;
  /** How it builds line; null for resources that build none (tenders, chief officers). */
  line: LineBuilder;
  /**
   * Longest flame, feet, its line holds: PMS 465 p.12 Figure 2 (Hauling chart): hand tools
   * at the head up to 4 ft; engines and dozers up to 8 ft (the 8-11 ft band is "serious
   * control problems"). Zero for resources that build no line.
   */
  holdsFlameLengthFeet: number;
  /** Where it is based: OSM / CAL FIRE stations, conservation camps, or a CAL FIRE station. */
  base: "station" | "crew_camp" | "dozer_base";
  /** Minutes from report to rolling: turnout, or mobilisation for crews and dozers. */
  turnoutMinutes: number;
}

const HAND_TOOL_FLAME_FT = dataValue<{ hand_tools_direct_attack_head_max: number }>(
  "hand_crews.flame_length_limits_ft",
).hand_tools_direct_attack_head_max;
/** PMS 465 p.12 Fig. 2: engines and dozers hold up to the start of the 8-11 ft band. */
const MACHINE_FLAME_FT = dataValue<{ serious_control_problems: [number, number] }>(
  "hand_crews.flame_length_limits_ft",
).serious_control_problems[0];

/** NFPA 1710 4.1.2.1 turnout, 80 s (source unverified; see data). */
const TURNOUT_MIN = dataValue<number>("response_times.turnout_s") / 60;
/** ASSUMPTION in the data: hand crew mobilisation 30 min. */
const CREW_MOBILISATION_MIN = dataValue<number>("response_times.hand_crew_mobilization_min");
/** ASSUMPTION in the data: dozer (and lowboy) mobilisation 60 min. */
const DOZER_MOBILISATION_MIN = dataValue<number>("response_times.dozer_mobilization_min");

const personsMin = (type: 1 | 3 | 6) => dataValue<number>(`engines.typing.${type}.personnel_min`);

export const GROUND_APPARATUS: Record<GroundKind, GroundApparatus> = {
  engine_t3: {
    label: "Type 3 engine (4x4)",
    short: "T3 engine",
    access: "engine_t3",
    // PMS 200: Type 3 minimum staffing; engine production by crew size from PMS 465 p.164.
    line: { kind: "engine", persons: personsMin(3) },
    holdsFlameLengthFeet: MACHINE_FLAME_FT,
    base: "station",
    turnoutMinutes: TURNOUT_MIN,
  },
  engine_t1: {
    label: "Type 1 structure engine",
    short: "T1 engine",
    access: "engine_t1_t2",
    line: { kind: "engine", persons: personsMin(1) },
    holdsFlameLengthFeet: MACHINE_FLAME_FT,
    base: "station",
    turnoutMinutes: TURNOUT_MIN,
  },
  engine_t6: {
    label: "Type 6 engine (light AWD)",
    short: "T6 engine",
    access: "engine_t4_t7",
    line: { kind: "engine", persons: personsMin(6) },
    holdsFlameLengthFeet: MACHINE_FLAME_FT,
    base: "station",
    turnoutMinutes: TURNOUT_MIN,
  },
  hand_crew_t1: {
    label: "Type 1 hand crew",
    short: "T1 crew",
    access: "engine_t3",
    accessNote: "ASSUMPTION: crew carriers routed as 4x4 Type 3-class trucks",
    line: { kind: "hand_crew", crewType: 1 },
    holdsFlameLengthFeet: HAND_TOOL_FLAME_FT,
    base: "crew_camp",
    turnoutMinutes: CREW_MOBILISATION_MIN,
  },
  hand_crew_t2: {
    label: "Type 2 hand crew",
    short: "T2 crew",
    access: "engine_t3",
    accessNote: "ASSUMPTION: crew carriers routed as 4x4 Type 3-class trucks",
    line: { kind: "hand_crew", crewType: 2 },
    holdsFlameLengthFeet: HAND_TOOL_FLAME_FT,
    base: "crew_camp",
    turnoutMinutes: CREW_MOBILISATION_MIN,
  },
  dozer_t2: {
    label: "Type 2 dozer (medium)",
    short: "T2 dozer",
    access: "tender_support",
    accessNote: "dozers arrive on a lowboy; the support-tender column applies to the carrier (data doc)",
    line: { kind: "dozer", size: "medium_type2" },
    holdsFlameLengthFeet: MACHINE_FLAME_FT,
    base: "dozer_base",
    turnoutMinutes: DOZER_MOBILISATION_MIN,
  },
  dozer_t1: {
    label: "Type 1 dozer (large)",
    short: "T1 dozer",
    access: "tender_support",
    accessNote: "dozers arrive on a lowboy; the support-tender column applies to the carrier (data doc)",
    line: { kind: "dozer", size: "large_type1" },
    holdsFlameLengthFeet: MACHINE_FLAME_FT,
    base: "dozer_base",
    turnoutMinutes: DOZER_MOBILISATION_MIN,
  },
  tender_tactical: {
    label: "Tactical water tender",
    short: "Tac tender",
    access: "tender_tactical",
    line: null,
    holdsFlameLengthFeet: 0,
    base: "station",
    turnoutMinutes: TURNOUT_MIN,
  },
  tender_support: {
    label: "Support water tender",
    short: "Sup tender",
    access: "tender_support",
    line: null,
    holdsFlameLengthFeet: 0,
    base: "station",
    turnoutMinutes: TURNOUT_MIN,
  },
  chief: {
    label: "Chief officer",
    short: "Chief",
    access: "engine_t4_t7",
    accessNote: "ASSUMPTION: a chief's pickup or SUV routed as a light AWD vehicle",
    line: null,
    holdsFlameLengthFeet: 0,
    base: "station",
    turnoutMinutes: TURNOUT_MIN,
  },
};

// ---- fuel crosswalk ---------------------------------------------------------------------

/**
 * ASSUMPTION: FBFM40 (Scott & Burgan 2005) code -> nearest of Anderson's 13 models, by family,
 * because every production table in the data is keyed by the 13 Anderson models. Coarse and
 * unvalidated: GR1-2 -> 1, GR3-9 -> 3 (tall grass), GS -> 2, SH1-4 -> 5 (brush),
 * SH5-9 -> 4 (chaparral), TU -> 10, TL1-4 -> 8, TL5-9 -> 9, SB1 -> 11, SB2-3 -> 12, SB4 -> 13.
 * Developed ground (91) is treated as grass (model 1), as the model always has. Returns null
 * for other non-burnable codes (no line work needed there).
 */
export function andersonModel(fuelCode: number): number | null {
  if (fuelCode === DEVELOPED_FUEL_CODE) return 1;
  if (fuelCode < 100) return null;
  if (fuelCode <= 102) return 1;
  if (fuelCode < 120) return 3;
  if (fuelCode < 140) return 2;
  if (fuelCode < 145) return 5;
  if (fuelCode < 160) return 4;
  if (fuelCode < 180) return 10;
  if (fuelCode < 185) return 8;
  if (fuelCode < 200) return 9;
  if (fuelCode === 201) return 11;
  if (fuelCode < 204) return 12;
  return 13;
}

/** Broyles 2011 column for an Anderson model; the table has grass, chaparral, brush, timber. */
function broylesColumn(model: number): number {
  // Columns: fm1_2_grass, fm4_chaparral, fm5_6_brush, fm8_9_10_timber.
  if (model <= 3) return 0; // ASSUMPTION: FM3 tall grass uses the grass column.
  if (model === 4) return 1;
  if (model <= 7) return 2; // ASSUMPTION: FM7 uses the brush column.
  return 3; // FM8-10 timber; ASSUMPTION: slash (11-13) uses the timber column.
}

// ---- line production --------------------------------------------------------------------

const BROYLES = dataValue<{
  type1: { chains_per_hour: number[] };
  type2: { chains_per_hour: number[] };
}>("hand_crews.production_sustained_2011_direct");
const ENGINE_TABLE = dataValue<{ rows: (string | number)[][] }>(
  "engine_production.initial_attack_by_crew_size",
).rows;
const DOZER_TABLE = dataValue<{
  rows_by_dozer_size_then_fuel_model: Record<string, Record<string, number[]>>;
}>("dozers.production_single_pass").rows_by_dozer_size_then_fuel_model;
const DOZER_MAX_SLOPE_PCT = dataValue<number>("dozers.max_slope_in_table_pct");

/** PMS 465 p.164 row for an Anderson model. ASSUMPTION: FM8 and FM9 use the conifer rows. */
function engineRow(model: number): number[] {
  const label = model === 1 ? "1 grass" : model === 8 ? "8 conifers" : model === 9 ? "9 conifers" : null;
  const row =
    ENGINE_TABLE.find((r) => (label ? r[0] === label : String(r[0]).split(" ")[0] === String(model))) ??
    ENGINE_TABLE[0];
  return row.slice(1) as number[];
}

/** PMS 465 p.140 row for a dozer size and Anderson model; null when the table has none. */
function dozerRow(size: string, model: number): number[] | null {
  const rows = DOZER_TABLE[size];
  for (const [label, values] of Object.entries(rows)) {
    if (label.split(",").includes(String(model))) return values;
  }
  return null;
}

/**
 * Line one resource builds per hour on a cell of this fuel, metres; 0 when it cannot work
 * there (a dozer above 55% slope or with no table row), Infinity where no line is needed
 * (non-burnable ground).
 *
 * - Hand crews: Broyles 2011 Table 2, sustained direct-attack rate of a 20-person crew.
 * - Engines: PMS 465 p.164 Table 4, initial-attack production by engine crew size.
 * - Dozers: PMS 465 p.140 Table 2, single pass, by slope class (0-25, 26-40, 41-55%) and
 *   whether the line goes up or down the slope; none above 55%.
 */
export function lineRateMetersPerHour(
  builder: Exclude<LineBuilder, null>,
  fuelCode: number,
  slopePercent = 0,
  uphill = true,
): number {
  const model = andersonModel(fuelCode);
  if (model === null) return Number.POSITIVE_INFINITY;
  let chains: number;
  if (builder.kind === "hand_crew") {
    const table = builder.crewType === 1 ? BROYLES.type1 : BROYLES.type2;
    chains = table.chains_per_hour[broylesColumn(model)];
  } else if (builder.kind === "engine") {
    const row = engineRow(model);
    chains = row[Math.max(0, Math.min(row.length - 1, builder.persons - 1))];
  } else {
    if (slopePercent > DOZER_MAX_SLOPE_PCT) return 0;
    const row = dozerRow(builder.size, model);
    if (!row) return 0;
    const slopeClass = slopePercent <= 25 ? 0 : slopePercent <= 40 ? 1 : 2;
    chains = row[slopeClass * 2 + (uphill ? 0 : 1)];
  }
  return chainsPerHourToMetersPerHour(chains);
}

/** Grass rate (Anderson model 1, flat, uphill column) for display. */
export function grassRateMetersPerHour(kind: GroundKind): number {
  const line = GROUND_APPARATUS[kind].line;
  return line ? lineRateMetersPerHour(line, 101) : 0;
}

/** Vehicle family for drawing: engines (and tenders, chiefs), hand crews, dozers. */
export type VehicleFamily = "engine" | "hand_crew" | "dozer";
export function vehicleFamily(kind: GroundKind): VehicleFamily {
  const line = GROUND_APPARATUS[kind].line;
  return line?.kind === "hand_crew" ? "hand_crew" : line?.kind === "dozer" ? "dozer" : "engine";
}

/** Counts per kind; missing kinds are zero. */
export type ApparatusCounts = Partial<Record<ApparatusKind, number>>;

export const isAirKind = (kind: ApparatusKind): kind is AirKind =>
  (AIR_KINDS as readonly string[]).includes(kind);

/** Display label for any kind. */
export function apparatusLabel(kind: ApparatusKind): string {
  return isAirKind(kind) ? AIR_LABELS[kind] : GROUND_APPARATUS[kind].label;
}

export const AIR_LABELS: Record<AirKind, string> = {
  air_attack: "Air attack (OV-10A)",
  airtanker_vlat: "VLAT (DC-10)",
  airtanker_lat: "Large airtanker (C-130)",
  airtanker_s2t: "Airtanker (S-2T)",
  airtanker_seat: "SEAT (AT-802F)",
  helicopter_t1: "Type 1 helicopter",
  helicopter_t2: "Type 2 helicopter",
  helicopter_t3: "Type 3 helicopter",
};
