/**
 * Departments and their apparatus, built from real fire facilities (CAL FIRE Facilities for
 * Wildland Fire Protection via GET /api/suppression/bases; OSM stations as a fallback). Pure.
 * See docs/response-model.md, "Resources come from the map" and "Departments and mutual aid".
 *
 * The resources that can respond are a pure function of the facilities on and near the board:
 * there are no hand-set unit counts anywhere. A department is the agency that staffs a set of
 * stations: a CAL FIRE unit (BTU, ...), a local-government department under a Schedule A
 * contract (Paradise FD = PRA, Butte County Fire = BTC), a local or volunteer department, a
 * contract county or a federal station. The facilities layer gives the agency class, the CAL
 * FIRE unit code and staffing (P paid, C combination, V volunteer); it gives NO apparatus counts
 * (docs/suppression-data.md, Gaps), so the units per facility are one labelled table,
 * FACILITY_INVENTORY, of sourced averages and named assumptions.
 *
 * Tiers (Cal OES Fire and Rescue Mutual Aid; Operations Bulletin #1, April 2022): stations on
 * the board answer initial attack under the closest-resource concept (automatic aid); stations
 * in the bases list but off the board answer only orders (mutual aid from an adjacent area);
 * beyond that, resources come through the state ordering system (response/orders.ts).
 */

import type { LonLat } from "../live/types";
import { GROUND_APPARATUS, dataValue, type GroundKind } from "../studio/apparatus";
import { AIRCRAFT } from "../studio/aircraft";

/** Ground kinds the response model dispatches (the /live board's kinds). */
export type GroundResponseKind = Extract<GroundKind, "engine_t3" | "engine_t1" | "hand_crew_t1" | "dozer_t2">;
/** Aircraft the response model flies (studio/aircraft.ts AIRCRAFT specs). */
export type AirResponseKind = "air_attack" | "airtanker_s2t" | "helicopter_t2";
export type ResponseKind = GroundResponseKind | AirResponseKind;

/** synthetic: the /live board's assumed roster when it has no facilities and no snapshot (demo/model.ts rosterTeams). */
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
  /** Facility type: FSA, FSB, FSAB, FSL, FSCC, FSO, CC, FCFFC, HB, AAB, osm_fire_station. */
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

// ---- sourced and assumed constants ----

/** NFPA 1710 4.1.2.1 turnout 80 s for staffed (paid) stations (data leaf response_times.turnout_s; source not re-verified). */
export const TURNOUT_PAID_MINUTES = dataValue<number>("response_times.turnout_s") / 60;
/** ASSUMPTION (data leaf response_times.wildland_turnout_s): 120 s for volunteer, combination or unknown staffing, as livecore/apparatus.py. */
export const TURNOUT_OTHER_MINUTES = dataValue<number>("response_times.wildland_turnout_s") / 60;
/**
 * Derived ASSUMPTION (data leaf deployment.engines_per_station_estimate): 1.6 Type 3 engines per
 * state CAL FIRE station (343 engines / 220 stations, 2019). The k-th station of a CAL FIRE unit
 * gets floor(1.6k) - floor(1.6(k-1)), the pattern livecore/apparatus.py uses.
 */
export const ENGINES_PER_CALFIRE_STATION = dataValue<number>("deployment.engines_per_station_estimate");
/** ASSUMPTION (drawdown; no CAL FIRE unit drawdown table is public): a department keeps this share of its engines uncommitted. */
export const DRAWDOWN_KEEP_SHARE = 0.25;
/** ASSUMPTION: a department always answers a fire within this distance of one of its stations (its own area). */
export const OWN_AREA_RADIUS_M = 5_000;

/** What kind of facility a layer or OSM record is, for the inventory below. */
export type FacilityClass =
  | "calfire_station"
  | "local_station"
  | "federal_station"
  | "osm_station"
  | "crew_camp"
  | "air_attack_base"
  | "helitack_base";

export interface InventoryRow {
  /** Which facilities the row covers (layer type and agency). */
  covers: string;
  /** Units per facility. CAL FIRE engines are an average, spread over a unit's stations. */
  units: Partial<Record<ResponseKind, number>>;
  /** Where the count comes from, or ASSUMPTION. */
  evidence: string;
}

/**
 * Units per facility: the only apparatus inventory in the response model. The CAL FIRE facilities
 * layer (docs/suppression-data.md) gives each facility's type, agency, unit and staffing but no
 * apparatus, so these rows are sourced averages or named assumptions. Staffing sets turnout
 * (TURNOUT_*), not counts: no source ties apparatus counts to staffing.
 */
export const FACILITY_INVENTORY: Record<FacilityClass, InventoryRow> = {
  calfire_station: {
    covers: "CAL FIRE-owned station (FSA, FSB, FSAB, FSL, FSCC, FSO; agency CAL FIRE)",
    units: { engine_t3: ENGINES_PER_CALFIRE_STATION },
    evidence:
      "Derived: 343 year-round engines / 220 state-owned stations, 2019 (calfire_house_2019 p.3; data leaf deployment.engines_per_station_estimate), as livecore/apparatus.py",
  },
  local_station: {
    covers: "Local government, Schedule A or contract county station",
    units: { engine_t1: 1 },
    evidence: "ASSUMPTION, as livecore/apparatus.py: one Type 1 structure engine",
  },
  federal_station: {
    covers: "Federal station",
    units: { engine_t3: 1 },
    evidence: "ASSUMPTION: one wildland (Type 3) engine",
  },
  osm_station: {
    covers: "OpenStreetMap fire station (CAL FIRE layer unavailable; agency unknown)",
    units: { engine_t3: 1 },
    evidence: "ASSUMPTION, as dispatch/stationApparatus.ts for unmatched stations",
  },
  crew_camp: {
    covers: "Conservation camp or crew fire centre (CC, FCFFC)",
    units: { hand_crew_t1: 2 },
    evidence: "ASSUMPTION: Type 1 crews a camp fields for initial attack",
  },
  air_attack_base: {
    covers: "Air attack base (AAB)",
    units: { air_attack: 1, airtanker_s2t: 2 },
    evidence: "Derived: 12 air tactical aircraft and 22 airtankers at 13 bases (calfire_house_2019 p.3-4)",
  },
  helitack_base: {
    covers: "Helitack base (HB)",
    units: { helicopter_t2: 1 },
    evidence: "ASSUMPTION: 10 staffed CAL FIRE helicopters (calfire_house_2019 p.4) over 17 helitack bases in the layer",
  },
};

/** ASSUMPTION: one Type 2 dozer per CAL FIRE unit, at the unit's first station in the list (the nearest). */
export const DOZERS_PER_CALFIRE_UNIT = 1;

/**
 * ASSUMPTION: aircraft answer initial attack from bases within this flight time of the area.
 * CAL FIRE describes its air bases as placed to reach most fires within 20 minutes (CAL FIRE
 * aviation program, as commonly quoted; not re-fetched); here it is a dispatch radius of
 * cruise x 20 min per aircraft (S-2T 230 kt: about 142 km; helicopter 100 kt, assumed: about
 * 62 km). Beyond it, aircraft come only by order through the state system (response/orders.ts).
 */
export const AIR_DISPATCH_FLIGHT_MINUTES = 20;

const STATION_TYPES = new Set(["FSA", "FSB", "FSAB", "FSL", "FSCC", "FSO"]);
const CAMP_TYPES = new Set(["CC", "FCFFC"]);

export function agencyClassOf(base: BaseInput): AgencyClass {
  if (base.type === "osm_fire_station") return "osm";
  const a = (base.agency ?? "").toLowerCase();
  if (a.startsWith("cal fire")) return "calfire";
  if (a.includes("schedule a")) return "local_schedule_a";
  if (a.startsWith("contract county")) return "contract_county";
  if (a.startsWith("federal")) return "federal";
  return "local";
}

/** The inventory row a facility falls under, or null when it fields nothing the model dispatches. */
export function facilityClassOf(base: BaseInput): FacilityClass | null {
  if (base.type === "AAB") return "air_attack_base";
  if (base.type === "HB") return "helitack_base";
  if (CAMP_TYPES.has(base.type)) return "crew_camp";
  if (base.type === "osm_fire_station") return "osm_station";
  if (!STATION_TYPES.has(base.type)) return null;
  const cls = agencyClassOf(base);
  return cls === "calfire" ? "calfire_station" : cls === "federal" ? "federal_station" : "local_station";
}

function departmentKey(base: BaseInput, cls: AgencyClass): string {
  if (cls === "osm") return `${cls}:${base.id}`;
  return `${cls}:${base.unit ?? "unknown"}`;
}

function departmentName(base: BaseInput, cls: AgencyClass): string {
  if (cls === "osm") return base.name;
  if (cls === "calfire") return `CAL FIRE ${base.unit ?? ""} unit`.replace("  ", " ");
  if (cls === "local") return `Local and volunteer companies (${base.unit ?? "?"} area)`;
  return `${AGENCY_LABEL[cls]} ${base.unit ?? ""}`.trim();
}

export function engineTurnoutMinutes(staffing: string | null | undefined): number {
  return staffing === "P" ? TURNOUT_PAID_MINUTES : TURNOUT_OTHER_MINUTES;
}

const KMH_PER_KNOT = 1.852;

/** Minutes from the call until an aircraft of `kind` from `km` away is over the fire (takeoff + cruise). */
export function airMinutes(kind: AirResponseKind, km: number): number {
  const spec = AIRCRAFT[kind];
  return spec.callToTakeoffMinutes + (km / (spec.cruiseKnots * KMH_PER_KNOT)) * 60;
}

/** Initial-attack dispatch radius of an aircraft kind, km (AIR_DISPATCH_FLIGHT_MINUTES at cruise). */
export function airDispatchRadiusKm(kind: AirResponseKind): number {
  return AIRCRAFT[kind].cruiseKnots * KMH_PER_KNOT * (AIR_DISPATCH_FLIGHT_MINUTES / 60);
}

/** Great-circle distance, km (mean Earth radius 6,371 km). */
export function greatCircleKm(a: LonLat, b: LonLat): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * ASSUMPTION (as studio/crewDispatch.ts and dispatch/stationApparatus.ts): an OSM fire station
 * this close to a CAL FIRE-layer facility is that facility.
 */
export const SAME_STATION_M = 500;

/**
 * The CAL FIRE layer plus the OSM fire stations it does not list. The layer covers wildland fire
 * protection, so city departments (San Francisco, Oakland) are often missing from it while OSM
 * maps their stations: every station visible on the map responds, counted once.
 */
export function withOsmStations<T extends BaseInput>(layer: readonly T[], osm: readonly T[]): T[] {
  const extra = osm.filter((s) => !layer.some((b) => greatCircleKm(b.location, s.location) * 1000 < SAME_STATION_M));
  return [...layer, ...extra];
}

const NOUN: Record<ResponseKind, [string, string]> = {
  engine_t3: ["engine", "engines"],
  engine_t1: ["engine", "engines"],
  hand_crew_t1: ["hand crew", "hand crews"],
  dozer_t2: ["dozer", "dozers"],
  air_attack: ["air attack plane", "air attack planes"],
  airtanker_s2t: ["air tanker", "air tankers"],
  helicopter_t2: ["helicopter", "helicopters"],
};
const FAMILY_ORDER = ["engine", "hand crew", "dozer", "air attack plane", "air tanker", "helicopter"];

/** "11 engines, 2 hand crews, 1 dozer": engine types are added together. */
export function unitsText(units: Partial<Record<string, number>>): string {
  const byNoun = new Map<string, { one: string; many: string; n: number }>();
  for (const [kind, n] of Object.entries(units)) {
    const noun = NOUN[kind as ResponseKind];
    if (!n || !noun) continue;
    const [one, many] = noun;
    const row = byNoun.get(one) ?? { one, many, n: 0 };
    row.n += n;
    byNoun.set(one, row);
  }
  return [...byNoun.values()]
    .sort((a, b) => FAMILY_ORDER.indexOf(a.one) - FAMILY_ORDER.indexOf(b.one))
    .map((r) => `${r.n} ${r.n === 1 ? r.one : r.many}`)
    .join(", ");
}

const AGENCY_SHORT: Record<AgencyClass, string> = {
  calfire: "CAL FIRE",
  local_schedule_a: "Local (Schedule A)",
  local: "Local",
  contract_county: "Contract county",
  federal: "Federal",
  osm: "OSM, agency unknown",
  synthetic: "Synthetic station",
};

/** A facility that fields units, with what it fields: drawn on the map as "what can respond". */
export interface FacilityContribution {
  id: string;
  name: string;
  type: string;
  facility: FacilityClass;
  agencyClass: AgencyClass;
  location: LonLat;
  tier: Tier;
  units: Partial<Record<ResponseKind, number>>;
  /** Distance from the area's centre, km (null without a centre). */
  km: number | null;
  /** "Paradise FS · CAL FIRE · 2 engines, 1 dozer". */
  label: string;
}

export interface Fleet {
  departments: Department[];
  /** Units at stations on the board (closest-resource initial attack). */
  units: UnitSeed[];
  /** Units at stations in the bases list but off the board (mutual aid; ordered only). */
  offBoardUnits: UnitSeed[];
  aircraft: AircraftSeed[];
  /** Every facility that fields a unit (on the board, mutual aid, air bases in range). */
  facilities: FacilityContribution[];
  /** What the counts rest on, for the observation's inputs. */
  label: string;
}

/**
 * Departments and units from the facilities, nearest first: a pure function of the facilities
 * on and near the board and FACILITY_INVENTORY. `onBoard` says whether a facility is on the
 * board (inside the landscape); the other stations form the mutual-aid pool. Aircraft come only
 * from air attack and helitack bases within their dispatch radius of `center` (every listed base
 * when `center` is null).
 */
export function buildFleet(bases: readonly BaseInput[], onBoard: (p: LonLat) => boolean, center: LonLat | null = null): Fleet {
  const departments = new Map<string, Department>();
  const units: UnitSeed[] = [];
  const offBoardUnits: UnitSeed[] = [];
  const aircraft: AircraftSeed[] = [];
  const facilities: FacilityContribution[] = [];
  const calfireStationIndex = new Map<string, number>();
  const dozerUnits = new Map<string, number>();

  for (const base of bases) {
    const facility = facilityClassOf(base);
    if (!facility) continue;
    const cls = agencyClassOf(base);
    const tier: Tier = onBoard(base.location) ? "closest" : "mutual_aid";
    const km = center ? greatCircleKm(center, base.location) : null;
    const fielded: Partial<Record<ResponseKind, number>> = {};
    const contribute = () => {
      const text = unitsText(fielded);
      if (!text) return;
      facilities.push({ id: base.id, name: base.name, type: base.type, facility, agencyClass: cls, location: base.location, tier, units: fielded, km, label: `${base.name} · ${AGENCY_SHORT[cls]} · ${text}` });
    };

    if (facility === "air_attack_base" || facility === "helitack_base") {
      for (const [kind, n] of Object.entries(FACILITY_INVENTORY[facility].units) as [AirResponseKind, number][]) {
        if (km !== null && km > airDispatchRadiusKm(kind)) continue;
        for (let i = 0; i < n; i += 1) aircraft.push({ kind, baseId: base.id, baseName: base.name, location: base.location });
        fielded[kind] = n;
      }
      contribute();
      continue;
    }

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
      if (n <= 0) return;
      for (let i = 0; i < n; i += 1) {
        out.push({ kind, stationId: base.id, departmentId: key, location: base.location, turnoutMinutes: turnout, tier });
      }
      fielded[kind] = (fielded[kind] ?? 0) + n;
      if (kind === "engine_t3" || kind === "engine_t1") dept!.engines += n;
    };
    const row = FACILITY_INVENTORY[facility];
    const turnout = engineTurnoutMinutes(base.staffing);
    if (facility === "crew_camp") {
      add("hand_crew_t1", row.units.hand_crew_t1 ?? 0, GROUND_APPARATUS.hand_crew_t1.turnoutMinutes);
    } else if (facility === "calfire_station") {
      const k = (calfireStationIndex.get(key) ?? 0) + 1;
      calfireStationIndex.set(key, k);
      const per = row.units.engine_t3 ?? 0;
      add("engine_t3", Math.floor(per * k) - Math.floor(per * (k - 1)), turnout);
      const dozers = dozerUnits.get(key) ?? 0;
      if (dozers < DOZERS_PER_CALFIRE_UNIT) {
        add("dozer_t2", 1, GROUND_APPARATUS.dozer_t2.turnoutMinutes);
        dozerUnits.set(key, dozers + 1);
      }
    } else {
      for (const [kind, n] of Object.entries(row.units) as [GroundResponseKind, number][]) add(kind, n, turnout);
    }
    contribute();
  }
  // floor: a department with fewer than 1 / DRAWDOWN_KEEP_SHARE engines keeps none back (a
  // one-engine volunteer company answers its area's fires rather than holding its only engine).
  for (const dept of departments.values()) dept.keepEngines = Math.floor(DRAWDOWN_KEEP_SHARE * dept.engines);
  const osm = bases.some((b) => b.type === "osm_fire_station");
  return {
    departments: [...departments.values()],
    units,
    offBoardUnits,
    aircraft,
    facilities,
    label:
      facilities.length === 0
        ? "No fire stations found on this map: only out-of-area resources ordered through the state system"
        : `Units from the facilities on the map (${osm ? "OpenStreetMap fire stations; CAL FIRE layer unavailable" : "CAL FIRE facilities layer: observed locations, agency, staffing"}); ` +
          "units per facility from FACILITY_INVENTORY (response/fleet.ts: sourced averages and named assumptions)",
  };
}

// ---- plain summary ----

function countKinds(seeds: readonly { kind: ResponseKind }[]): Partial<Record<ResponseKind, number>> {
  const out: Partial<Record<ResponseKind, number>> = {};
  for (const s of seeds) out[s.kind] = (out[s.kind] ?? 0) + 1;
  return out;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "~25 min": whole minutes under 10, else rounded to 5. */
export function aboutMinutes(m: number): string {
  return `~${m < 10 ? Math.max(1, Math.round(m)) : Math.round(m / 5) * 5} min`;
}

export interface FleetSummary {
  /** One compact line: "From the map: 9 stations · 11 engines, 2 crews, 1 dozer · air from Chico AAB, ~25 min". */
  short: string;
  /** "From the map: 9 stations, 4 departments — 11 engines, 2 hand crews, 1 dozer; air tankers from ...". */
  local: string;
  /** Stations near but outside the area (mutual aid), and how out-of-area resources come. */
  mutualAid: string;
  /** No station or camp inside the area. */
  empty: boolean;
}

/** Plain summary of a fleet: what is on the map, what flies in, and what mutual aid is near. */
export function summarizeFleet(fleet: Fleet): FleetSummary {
  const isAir = (f: FacilityContribution) => f.facility === "air_attack_base" || f.facility === "helitack_base";
  const ground = fleet.facilities.filter((f) => !isAir(f));
  const local = ground.filter((f) => f.tier === "closest");
  const camps = local.filter((f) => f.facility === "crew_camp").length;
  const stations = local.length - camps;
  const departments = fleet.departments.filter((d) => d.tier === "closest").length;
  const places = [stations > 0 ? plural(stations, "station", "stations") : null, camps > 0 ? plural(camps, "crew camp", "crew camps") : null]
    .filter(Boolean)
    .join(", ");
  const airBases = fleet.facilities.filter(isAir).sort((a, b) => (a.km ?? 0) - (b.km ?? 0));
  const firstAir = airBases.find((f) => (f.units.airtanker_s2t ?? 0) > 0) ?? airBases[0] ?? null;
  const firstAirKind: AirResponseKind | null = firstAir
    ? (firstAir.units.airtanker_s2t ?? 0) > 0
      ? "airtanker_s2t"
      : (firstAir.units.helicopter_t2 ?? 0) > 0
        ? "helicopter_t2"
        : "air_attack"
    : null;
  const shortAir =
    firstAir && firstAirKind
      ? `air from ${firstAir.name}${firstAir.km !== null ? `, ${aboutMinutes(airMinutes(firstAirKind, firstAir.km))}` : ""}`
      : "no air base in reach";
  const air = airBases
    .map((f) => {
      const tankers = (f.units.airtanker_s2t ?? 0) > 0;
      const helis = f.units.helicopter_t2 ?? 0;
      const what = tankers ? "air tankers" : helis > 1 ? "helicopters" : helis === 1 ? "a helicopter" : "air attack";
      const kind: AirResponseKind = tankers ? "airtanker_s2t" : helis > 0 ? "helicopter_t2" : "air_attack";
      const where = f.tier === "closest" ? "in the area" : "outside the area";
      return `${what} from ${f.name} (${where}${f.km !== null ? `, ${aboutMinutes(airMinutes(kind, f.km))}` : ""})`;
    });
  const airText = air.length > 0 ? `; ${air.join("; ")}` : "; no air attack or helitack base within reach";
  const localText =
    local.length === 0
      ? `No fire stations found on this map${airText}`
      : `From the map: ${places}, ${plural(departments, "department", "departments")} — ${unitsText(countKinds(fleet.units))}${airText}`;
  const offFacilities = ground.filter((f) => f.tier === "mutual_aid").length;
  const mutualAid =
    fleet.offBoardUnits.length > 0
      ? `Mutual aid from outside the area: ${plural(offFacilities, "facility", "facilities")}, ${unitsText(countKinds(fleet.offBoardUnits))}. Beyond that, out-of-area resources come through the state system, hours away.`
      : "Out-of-area resources only, through the state system, hours away (no stations listed outside the area).";
  const short =
    local.length === 0
      ? `No fire stations found on this map · ${shortAir}`
      : `From the map: ${places} · ${unitsText(countKinds(fleet.units)).replace(/hand crew/g, "crew")} · ${shortAir}`;
  return { short, local: localText, mutualAid, empty: local.length === 0 };
}
