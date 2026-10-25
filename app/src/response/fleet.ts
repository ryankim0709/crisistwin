/**
 * Departments and their apparatus, built from real fire facilities (CAL FIRE Facilities for
 * Wildland Fire Protection via GET /api/suppression/bases; OSM stations as a fallback). Pure.
 * See docs/response-model.md, "Departments and tiers".
 *
 * A department is the agency that staffs a set of stations: a CAL FIRE unit (BTU, ...), a
 * local-government department under a Schedule A contract (Paradise FD = PRA, Butte County
 * Fire = BTC), a local or volunteer department, a contract county or a federal station. The
 * facilities layer gives the agency class, the CAL FIRE unit code and staffing (P paid, C
 * combination, V volunteer); it gives NO apparatus counts (docs/suppression-data.md, Gaps), so
 * the counts per facility below are named assumptions.
 *
 * Tiers (Cal OES Fire and Rescue Mutual Aid; Operations Bulletin #1, April 2022): stations on
 * the board answer initial attack under the closest-resource concept (automatic aid); stations
 * in the bases list but off the board answer only orders (mutual aid from an adjacent area);
 * beyond that, resources come through the state ordering system (response/orders.ts).
 */

import type { LonLat } from "../live/types";
import { GROUND_APPARATUS, dataValue, type GroundKind } from "../studio/apparatus";

/** Ground kinds the response model dispatches (the /live board's roster kinds). */
export type GroundResponseKind = Extract<GroundKind, "engine_t3" | "engine_t1" | "hand_crew_t1" | "dozer_t2">;
/** Aircraft the response model flies (studio/aircraft.ts AIRCRAFT specs). */
export type AirResponseKind = "air_attack" | "airtanker_s2t" | "helicopter_t2";

export type AgencyClass = "calfire" | "local_schedule_a" | "local" | "contract_county" | "federal" | "osm" | "synthetic";
/** closest: answers initial attack; mutual_aid: off the board, answers orders only; state: ordered through the state system. */
export type Tier = "closest" | "mutual_aid" | "state";

export const AGENCY_LABEL: Record<AgencyClass, string> = {
  calfire: "CAL FIRE",
  local_schedule_a: "Local government (CAL FIRE Schedule A)",
  local: "Local government",
  contract_county: "Contract county",
  federal: "Federal",
  osm: "Fire station (OSM, agency unknown)",
  synthetic: "Synthetic station",
};

/** A facility as the board knows it (demo/model.ts Station plus layer metadata when present). */
export interface BaseInput {
  id: string;
  name: string;
  /** Facility type: FSA, FSB, FSAB, FSL, FSCC, FSO, CC, FCFFC, HB, AAB, osm_fire_station, synthetic. */
  type: string;
  location: LonLat;
  /** Layer agency text, e.g. "CAL FIRE (state-owned)", "Local government under CAL FIRE Schedule A/B agreement". */
  agency?: string;
  /** CAL FIRE unit code or local agency code (BTU, PRA, BTC, ...). */
  unit?: string | null;
  /** P paid, C combination, V volunteer (layer field). */
  staffing?: string | null;
}

export interface Department {
  id: string;
  name: string;
  agencyClass: AgencyClass;
  tier: Tier;
  stationIds: string[];
  /** Engines the department staffs (on the board, or in its off-board pool). */
  engines: number;
  /**
   * Engines it keeps uncommitted for its own area (drawdown): floor(DRAWDOWN_KEEP_SHARE x
   * engines), except that a department always answers fires in its own area (OWN_AREA_RADIUS_M).
   */
  keepEngines: number;
}

export interface UnitSeed {
  kind: GroundResponseKind;
  stationId: string;
  departmentId: string;
  location: LonLat;
  /** Report to rolling, minutes: turnout by staffing for engines, mobilisation for crews and dozers. */
  turnoutMinutes: number;
  tier: Tier;
}

export interface AircraftSeed {
  kind: AirResponseKind;
  baseId: string;
  baseName: string;
  location: LonLat;
}

export interface Fleet {
  departments: Department[];
  /** Units at stations on the board (closest-resource initial attack). */
  units: UnitSeed[];
  /** Units at stations in the bases list but off the board (mutual aid; ordered only). */
  offBoardUnits: UnitSeed[];
  aircraft: AircraftSeed[];
  /** What the counts rest on, for the observation's inputs. */
  label: string;
}

// ---- sourced and assumed constants ----

/** NFPA 1710 4.1.2.1 turnout 80 s for staffed (paid) stations (data leaf response_times.turnout_s; source not re-verified). */
export const TURNOUT_PAID_MINUTES = dataValue<number>("response_times.turnout_s") / 60;
/** ASSUMPTION (data leaf response_times.wildland_turnout_s): 120 s for volunteer, combination or unknown staffing, as livecore/apparatus.py. */
export const TURNOUT_OTHER_MINUTES = dataValue<number>("response_times.wildland_turnout_s") / 60;
/**
 * Derived ASSUMPTION (data leaf deployment.engines_per_station_estimate): 1.6 Type 3 engines per
 * state CAL FIRE station (343 engines / 220 stations, 2019). The k-th station gets
 * floor(1.6k) - floor(1.6(k-1)), the pattern livecore/apparatus.py uses.
 */
export const ENGINES_PER_CALFIRE_STATION = dataValue<number>("deployment.engines_per_station_estimate");
/** ASSUMPTION (as livecore/apparatus.py): one Type 1 structure engine at any non-CAL FIRE station. */
export const ENGINES_PER_LOCAL_STATION = 1;
/** ASSUMPTION: Type 1 hand crews a conservation camp or crew fire centre can field for initial attack. */
export const CREWS_PER_CAMP = 2;
/** ASSUMPTION: one Type 2 dozer per CAL FIRE unit on the board (the board's earlier roster had one). */
export const DOZERS_PER_CALFIRE_UNIT = 1;
/** Derived (calfire_house_2019 p.3-4: 22 airtankers at 13 air attack bases, 1.7 per base): 2 S-2T per air attack base. */
export const AIRTANKERS_PER_AIR_ATTACK_BASE = 2;
/** Derived (calfire_house_2019 p.4: 12 air tactical aircraft, 13 bases): 1 air attack aircraft per air attack base. */
export const AIR_ATTACK_PER_AIR_ATTACK_BASE = 1;
/** ASSUMPTION (calfire_house_2019 p.4: 10 staffed helicopters; the layer lists 17 helitack bases): one Type 2 helicopter per helitack base. */
export const HELICOPTERS_PER_HELITACK_BASE = 1;
/** ASSUMPTION (drawdown; no CAL FIRE unit drawdown table is public): a department keeps this share of its engines uncommitted. */
export const DRAWDOWN_KEEP_SHARE = 0.25;
/** ASSUMPTION: a department always answers a fire within this distance of one of its stations (its own area). */
export const OWN_AREA_RADIUS_M = 5_000;
/** OSM-only package stations: Type 3 engine each (as dispatch/stationApparatus.ts when unmatched; ASSUMPTION). */
export const ENGINES_PER_OSM_STATION = 1;

const STATION_TYPES = new Set(["FSA", "FSB", "FSAB", "FSL", "FSCC", "FSO"]);
const CAMP_TYPES = new Set(["CC", "FCFFC"]);

export function agencyClassOf(base: BaseInput): AgencyClass {
  if (base.type === "synthetic") return "synthetic";
  if (base.type === "osm_fire_station") return "osm";
  const a = (base.agency ?? "").toLowerCase();
  if (a.startsWith("cal fire")) return "calfire";
  if (a.includes("schedule a")) return "local_schedule_a";
  if (a.startsWith("contract county")) return "contract_county";
  if (a.startsWith("federal")) return "federal";
  return "local";
}

function departmentKey(base: BaseInput, cls: AgencyClass): string {
  if (cls === "osm" || cls === "synthetic") return `${cls}:${base.id}`;
  return `${cls}:${base.unit ?? "unknown"}`;
}

function departmentName(base: BaseInput, cls: AgencyClass): string {
  if (cls === "osm" || cls === "synthetic") return base.name;
  if (cls === "calfire") return `CAL FIRE ${base.unit ?? ""} unit`.replace("  ", " ");
  if (cls === "local") return `Local and volunteer companies (${base.unit ?? "?"} area)`;
  return `${AGENCY_LABEL[cls]} ${base.unit ?? ""}`.trim();
}

export function engineTurnoutMinutes(staffing: string | null | undefined): number {
  return staffing === "P" ? TURNOUT_PAID_MINUTES : TURNOUT_OTHER_MINUTES;
}

/**
 * Departments and units from the facilities, nearest first. `onBoard` says whether a facility
 * is on the board (inside the landscape); the others form the mutual-aid pool.
 */
export function buildFleet(bases: readonly BaseInput[], onBoard: (p: LonLat) => boolean): Fleet {
  const departments = new Map<string, Department>();
  const units: UnitSeed[] = [];
  const offBoardUnits: UnitSeed[] = [];
  const aircraft: AircraftSeed[] = [];
  const calfireStationIndex = new Map<string, number>();
  const dozerUnits = new Map<string, number>();

  for (const base of bases) {
    if (base.type === "HB") {
      for (let i = 0; i < HELICOPTERS_PER_HELITACK_BASE; i += 1) {
        aircraft.push({ kind: "helicopter_t2", baseId: base.id, baseName: base.name, location: base.location });
      }
      continue;
    }
    if (base.type === "AAB") {
      for (let i = 0; i < AIR_ATTACK_PER_AIR_ATTACK_BASE; i += 1) {
        aircraft.push({ kind: "air_attack", baseId: base.id, baseName: base.name, location: base.location });
      }
      for (let i = 0; i < AIRTANKERS_PER_AIR_ATTACK_BASE; i += 1) {
        aircraft.push({ kind: "airtanker_s2t", baseId: base.id, baseName: base.name, location: base.location });
      }
      continue;
    }
    const isCamp = CAMP_TYPES.has(base.type);
    const isStation = STATION_TYPES.has(base.type) || base.type === "osm_fire_station" || base.type === "synthetic";
    if (!isCamp && !isStation) continue;
    const cls = agencyClassOf(base);
    const tier: Tier = onBoard(base.location) ? "closest" : "mutual_aid";
    const key = departmentKey(base, cls);
    let dept = departments.get(key);
    if (!dept) {
      dept = { id: key, name: departmentName(base, cls), agencyClass: cls, tier, stationIds: [], engines: 0, keepEngines: 0 };
      departments.set(key, dept);
    }
    // A department with any station on the board answers initial attack.
    if (tier === "closest") dept.tier = "closest";
    dept.stationIds.push(base.id);
    const out = tier === "closest" ? units : offBoardUnits;
    const add = (kind: GroundResponseKind, n: number, turnout: number) => {
      for (let i = 0; i < n; i += 1) {
        out.push({ kind, stationId: base.id, departmentId: key, location: base.location, turnoutMinutes: turnout, tier });
      }
      if (kind === "engine_t3" || kind === "engine_t1") dept!.engines += n;
    };
    if (isCamp) {
      add("hand_crew_t1", CREWS_PER_CAMP, GROUND_APPARATUS.hand_crew_t1.turnoutMinutes);
      continue;
    }
    const turnout = engineTurnoutMinutes(base.staffing);
    if (cls === "calfire") {
      const k = (calfireStationIndex.get(key) ?? 0) + 1;
      calfireStationIndex.set(key, k);
      const n = Math.floor(ENGINES_PER_CALFIRE_STATION * k) - Math.floor(ENGINES_PER_CALFIRE_STATION * (k - 1));
      add("engine_t3", n, turnout);
      const dozers = dozerUnits.get(key) ?? 0;
      if (dozers < DOZERS_PER_CALFIRE_UNIT) {
        add("dozer_t2", 1, GROUND_APPARATUS.dozer_t2.turnoutMinutes);
        dozerUnits.set(key, dozers + 1);
      }
    } else if (cls === "osm" || cls === "synthetic") {
      add("engine_t3", ENGINES_PER_OSM_STATION, turnout);
    } else if (cls === "federal") {
      // ASSUMPTION: federal stations field a wildland (Type 3) engine.
      add("engine_t3", ENGINES_PER_LOCAL_STATION, turnout);
    } else {
      add("engine_t1", ENGINES_PER_LOCAL_STATION, turnout);
    }
  }
  // floor: a department with fewer than 1 / DRAWDOWN_KEEP_SHARE engines keeps none back (a
  // one-engine volunteer company answers its area's fires rather than holding its only engine).
  for (const dept of departments.values()) dept.keepEngines = Math.floor(DRAWDOWN_KEEP_SHARE * dept.engines);
  return {
    departments: [...departments.values()],
    units,
    offBoardUnits,
    aircraft,
    label:
      "Facilities: CAL FIRE layer (observed locations, agency, staffing). Counts per facility are assumptions: " +
      `${ENGINES_PER_CALFIRE_STATION} Type 3 engines per CAL FIRE station (derived), ${ENGINES_PER_LOCAL_STATION} Type 1 engine per other station, ` +
      `${CREWS_PER_CAMP} Type 1 crews per camp, ${DOZERS_PER_CALFIRE_UNIT} dozer per CAL FIRE unit, ` +
      `${AIRTANKERS_PER_AIR_ATTACK_BASE} S-2T + ${AIR_ATTACK_PER_AIR_ATTACK_BASE} air attack per air attack base, ${HELICOPTERS_PER_HELITACK_BASE} Type 2 helicopter per helitack base`,
  };
}
