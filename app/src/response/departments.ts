/**
 * Local fire departments around Berkeley that OpenStreetMap maps but the CAL FIRE facilities
 * layer does not list (GET /api/suppression/stations, source "osm"): which department an OSM
 * station belongs to (its name or operator tag, or its OSM id when the tags name no department),
 * and what each station fields, from the department's own published roster where one was found.
 * Pure. Used by response/fleet.ts buildFleet for Studio, /dispatch and the /live board alike.
 *
 * Sources (fetched 2026-10-25):
 * - BFD_STATIONS: City of Berkeley, "Fire Stations" (https://berkeleyca.gov/safety-health/fire/fire-stations),
 *   per-station apparatus; engine type from the department page
 *   (https://berkeleyca.gov/your-government/about-us/departments/fire-department): "seven firehouses
 *   with seven Type I fire engines, two aerial ladder trucks, four advanced life support (ALS)
 *   ambulances".
 * - OFD_STATIONS: Wikipedia, "Oakland Fire Department" station table
 *   (https://en.wikipedia.org/wiki/Oakland_Fire_Department; secondary source, its citations date
 *   from 2012-2015): 25 engines, 7 trucks, 8 wildland units. Not checked against an oaklandca.gov
 *   roster (none was retrieved).
 * - Ambulance transport: Alameda County EMS contracts Falck for the county exclusive operating area
 *   except the cities of Albany, Berkeley, Piedmont and Alameda, whose fire departments transport
 *   ("grandfathered" pre-1981 providers; Alameda County HCSA board letter 10/23/2018,
 *   https://www.acgov.org/board/bos_calendar/documents/DocsAgendaReg_10_23_18/HEALTH%20CARE%20SERVICES/Regular%20Calendar/HCSA_272126.pdf,
 *   as found by search, not re-read). Falck units are not station-based, so Oakland has no
 *   ambulances here; Albany's and Piedmont's ambulance counts were not found, so none are added.
 *
 * - `paid`: Berkeley FD (the department page: engines, trucks and ambulances "staffed with
 *   paramedics", career firefighters) and Oakland FD (Wikipedia: about 420 employees) are career
 *   departments; the others are not marked (turnout as unknown staffing).
 *
 * - PIEDMONT: piedmont.ca.gov Fire "Apparatus" page: "We staff 3 apparatus at all times" (Engine 1,
 *   Truck 1, Medic 1); Engine 601 (Type 6) not modelled.
 * - EL_CERRITO: elcerrito.gov "Stations & Apparatus" (https://www.elcerrito.gov/168/Stations-Apparatus):
 *   Station 51 (was 71) Engine 51 (Type I), Truck 51, OES 413; Station 52 (was 72) Engine 52 (Type I)
 *   and Engine 352 (Type III); Station 55 (was 65, Kensington FPD's station, staffed by El Cerrito
 *   under contract since 1995) Engine 55 (Type I) and Engine 355 (Type III). Renumbering per the
 *   Kensington FPD Fire Chief's report, April 2023.
 * - ALAMEDA_FD: alamedaca.gov Fire Station 1-4 pages: one engine (type not stated) and one medic
 *   unit each; citywide "four fire engines, two fire trucks, four ambulances".
 * - EBRPD: ebparks.org Fire "Equipment and Stations": Station 1 (Tilden) houses "two Type 3
 *   Engines, one Water Tender, a Type 6 Engine, and a Rescue Gator"; staffing not published.
 *
 * Units are staffed crews, not parked apparatus. A station that houses a Type I engine and a
 * wildland Type III with no separate staffing published has one crew, modelled on the Type III
 * (it can use the narrow hill roads; ASSUMPTION that the crew takes the wildland engine to a
 * vegetation fire). Berkeley FD's staffed list is "seven Type I fire engines, two aerial ladder
 * trucks, four ALS ambulances", so its Type III is cross-staffed. Reserve and state-owned (OES)
 * engines are not counted (staffed only on a state mutual-aid request).
 * Not verified, so not used: Moraga-Orinda FD (mofd.org blocked; search summaries only), Con
 * Fire per-station engines, Albany FD counts (only its Type 6 is in the 2023 hazard plan),
 * Richmond FD per-station engines. Con Fire/AMR (Contra Costa) and Falck (Alameda County) publish
 * no station-based ambulance counts.
 *
 * Not modelled (the board has no unit kind for them): ladder trucks, Type 6 patrols, the BFD
 * quick-response vehicle, the seasonal EBRPD engine at BFD Station 7, OFD airport crash rigs.
 */

import type { GroundResponseKind } from "./fleet";

export type StationUnits = Partial<Record<GroundResponseKind, number>>;

export interface StationRoster {
  units: StationUnits;
  /** ALS ambulances (medic units) housed here. */
  ambulances?: number;
  /** Unit names as the department lists them, for labels ("Engine 5, Type III, Medic 5"). */
  names: string;
}

export interface LocalDepartmentSpec {
  id: string;
  name: string;
  /** Short name on map labels. */
  short: string;
  /** Matches the OSM station's name or operator tag (checked in DEPARTMENTS order). */
  match: RegExp;
  /** Published per-station roster by station number, when found. */
  stations?: Record<string, StationRoster>;
  /** Units at a station of this department with no roster row; null = the generic OSM row (fleet.ts FACILITY_INVENTORY). */
  defaultUnits: StationUnits | null;
  /** Evidence for the roster and the default. */
  evidence: string;
  /** Career (paid) department: engines turn out at the paid NFPA 1710 time (fleet.ts TURNOUT_PAID_MINUTES). */
  paid?: boolean;
}

const BFD_EVIDENCE =
  "City of Berkeley Fire Stations page (berkeleyca.gov/safety-health/fire/fire-stations, fetched 2026-10-25); engines are Type I (berkeleyca.gov Fire Department page)";
const OFD_EVIDENCE =
  "Wikipedia 'Oakland Fire Department' station table (secondary, sources 2012-2015; fetched 2026-10-25). Engine type not stated: Type 1 (structure) ASSUMPTION; wildland units' type not stated: modelled as Type 3 engines, ASSUMPTION";
const ASSUMED_EVIDENCE = "Department from the OSM name/operator; units: ASSUMPTION, one Type 1 structure engine per station (as livecore/apparatus.py local stations); no published roster retrieved";
const CROSS_STAFFED = "one crew: the Type III is cross-staffed, modelled as the crew's engine (ASSUMPTION)";
const PIEDMONT_EVIDENCE = "piedmont.ca.gov Fire Apparatus page (fetched 2026-10-25 by a research subagent): staffs Engine 1 (Type 1), Truck 1, Medic 1";
const EL_CERRITO_EVIDENCE = `elcerrito.gov Stations & Apparatus page (fetched 2026-10-25 by a research subagent); ${CROSS_STAFFED} at Stations 52 and 55; OES 413 not counted`;
const ALAMEDA_EVIDENCE = "alamedaca.gov Fire Station 1-4 pages (fetched 2026-10-25 by a research subagent): one engine and one medic unit per station; engine type not stated, Type 1 ASSUMPTION";
const EBRPD_EVIDENCE = "ebparks.org Fire Equipment and Stations page (fetched 2026-10-25 by a research subagent): Station 1 houses two Type 3 engines; staffing not published, one crew ASSUMPTION";

/** Berkeley FD (official). Station 5's "Type III" is a Type 3 wildland engine (Wikipedia names it Wildland Engine 305). */
const BFD_STATIONS: Record<string, StationRoster> = {
  "1": { units: { engine_t1: 1 }, ambulances: 1, names: "Engine 1, Medic 1" },
  "2": { units: { engine_t1: 1 }, ambulances: 1, names: "Engine 2, Truck 2, Medic 2, Type VI 4x4" },
  "3": { units: { engine_t1: 1 }, ambulances: 1, names: "Engine 3, Medic 3" },
  "4": { units: { engine_t1: 1 }, names: "Engine 4" },
  "5": { units: { engine_t3: 1 }, ambulances: 1, names: `Engine 5, Truck 5, Type III, Medic 5 (${CROSS_STAFFED})` },
  "6": { units: { engine_t1: 1 }, names: "Engine 6" },
  "7": { units: { engine_t1: 1 }, names: "Engine 7, quick response vehicle, seasonal EBRPD engine" },
};

function ofd(n: number, wildland: number | null, extra = ""): [string, StationRoster] {
  return [
    String(n),
    {
      units: wildland ? { engine_t3: 1 } : { engine_t1: 1 },
      names: `Engine ${n}${wildland ? `, Wildland Unit ${wildland} (one crew: the wildland unit is modelled as the crew's engine, ASSUMPTION)` : ""}${extra}`,
    },
  ];
}

/** Oakland FD (Wikipedia station table). Station 22 (airport crash rigs) fields nothing the board dispatches. */
const OFD_STATIONS: Record<string, StationRoster> = Object.fromEntries([
  ofd(1, null, ", Truck 1, Rescue 1"),
  ofd(2, null),
  ofd(3, null, ", Truck 3"),
  ofd(4, null, ", Truck 2"),
  ofd(5, null),
  ofd(6, 306),
  ofd(7, 307),
  ofd(8, null, ", Truck 5"),
  ofd(10, null),
  ofd(12, null),
  ofd(13, null),
  ofd(15, null, ", Truck 4"),
  ofd(16, null),
  ofd(17, null),
  ofd(18, null, ", Truck 6"),
  ofd(19, null),
  ofd(20, null, ", Truck 7"),
  ofd(21, null, ", Patrol 21"),
  ["22", { units: {}, names: "Airport crash rigs (not dispatched to wildland fires)" }],
  ofd(23, 323),
  ofd(24, 324),
  ofd(25, 325),
  ofd(26, null, ", Patrol 26"),
  ofd(27, null),
  ofd(28, null, ", Patrol 28"),
  ofd(29, null),
]);

const LOCAL_T1: StationUnits = { engine_t1: 1 };

const PIEDMONT_STATIONS: Record<string, StationRoster> = {
  "1": { units: { engine_t1: 1 }, ambulances: 1, names: "Engine 1, Truck 1, Medic 1, Engine 601 (Type 6)" },
};

/** El Cerrito FD stations, under their current numbers and the pre-2023 ones OSM still uses. */
const EL_CERRITO_51: StationRoster = { units: { engine_t1: 1 }, names: "Engine 51, Truck 51, Battalion 5, OES 413" };
const EL_CERRITO_52: StationRoster = { units: { engine_t3: 1 }, names: "Engine 52 (Type I), Engine 352 (Type III)" };
const EL_CERRITO_55: StationRoster = { units: { engine_t3: 1 }, names: "Engine 55 (Type I), Engine 355 (Type III); Kensington FPD station" };
const EL_CERRITO_STATIONS: Record<string, StationRoster> = {
  "51": EL_CERRITO_51, "71": EL_CERRITO_51,
  "52": EL_CERRITO_52, "72": EL_CERRITO_52,
  "55": EL_CERRITO_55, "65": EL_CERRITO_55,
};

const ALAMEDA_STATIONS: Record<string, StationRoster> = Object.fromEntries(
  [1, 2, 3, 4].map((n) => [String(n), { units: { engine_t1: 1 }, ambulances: 1, names: `Engine ${n}, Medic ${n}${n <= 2 ? `, Truck ${n}` : ""}` }]),
);

const EBRPD_STATIONS: Record<string, StationRoster> = {
  "1": { units: { engine_t3: 1 }, names: "Two Type 3 engines, water tender, Type 6 engine, Rescue Gator (Tilden)" },
};

/** Checked in order: "Alameda County Fire" before "Alameda Fire". */
export const DEPARTMENTS: readonly LocalDepartmentSpec[] = [
  { id: "berkeley_fd", name: "Berkeley Fire Department", short: "Berkeley FD", match: /berkeley fire/i, stations: BFD_STATIONS, defaultUnits: LOCAL_T1, evidence: `${BFD_EVIDENCE}; ${CROSS_STAFFED} at Station 5`, paid: true },
  { id: "oakland_fd", name: "Oakland Fire Department", short: "Oakland FD", match: /oakland fire/i, stations: OFD_STATIONS, defaultUnits: LOCAL_T1, evidence: OFD_EVIDENCE, paid: true },
  { id: "ebrpd_fd", name: "East Bay Regional Park District Fire Department", short: "EBRPD Fire", match: /east bay regional park|ebrpd/i, stations: EBRPD_STATIONS, defaultUnits: null, evidence: EBRPD_EVIDENCE },
  { id: "albany_fd", name: "Albany Fire Department", short: "Albany FD", match: /albany fire/i, defaultUnits: LOCAL_T1, evidence: ASSUMED_EVIDENCE },
  { id: "piedmont_fd", name: "Piedmont Fire Department", short: "Piedmont FD", match: /piedmont/i, stations: PIEDMONT_STATIONS, defaultUnits: LOCAL_T1, evidence: PIEDMONT_EVIDENCE },
  { id: "kensington_fpd", name: "Kensington Fire Protection District", short: "Kensington FPD", match: /kensington/i, defaultUnits: LOCAL_T1, evidence: ASSUMED_EVIDENCE },
  { id: "el_cerrito_fd", name: "El Cerrito Fire Department", short: "El Cerrito FD", match: /el cerrito/i, stations: EL_CERRITO_STATIONS, defaultUnits: LOCAL_T1, evidence: EL_CERRITO_EVIDENCE },
  { id: "mofd", name: "Moraga-Orinda Fire District", short: "Moraga-Orinda FD", match: /moraga.?orinda/i, defaultUnits: LOCAL_T1, evidence: ASSUMED_EVIDENCE },
  { id: "confire", name: "Contra Costa County Fire Protection District", short: "Con Fire", match: /contra costa/i, defaultUnits: LOCAL_T1, evidence: ASSUMED_EVIDENCE },
  { id: "richmond_fd", name: "Richmond Fire Department", short: "Richmond FD", match: /richmond fire/i, defaultUnits: LOCAL_T1, evidence: ASSUMED_EVIDENCE },
  { id: "acfd", name: "Alameda County Fire Department", short: "Alameda County FD", match: /alameda county fire/i, defaultUnits: LOCAL_T1, evidence: ASSUMED_EVIDENCE },
  { id: "alameda_fd", name: "Alameda Fire Department", short: "Alameda FD", match: /alameda fire/i, stations: ALAMEDA_STATIONS, defaultUnits: LOCAL_T1, evidence: ALAMEDA_EVIDENCE },
  { id: "emeryville", name: "Emeryville fire stations", short: "Emeryville", match: /emeryville/i, defaultUnits: LOCAL_T1, evidence: ASSUMED_EVIDENCE },
  { id: "sffd", name: "San Francisco Fire Department", short: "SFFD", match: /san francisco fire/i, defaultUnits: LOCAL_T1, evidence: ASSUMED_EVIDENCE },
];

/**
 * OSM elements whose tags name no department (observed in GET /api/suppression/stations around
 * Berkeley, 2026-10-25), placed at the address the department lists for that station number.
 */
const OSM_ALIASES: Record<string, { department: string; station: string }> = {
  "osm/way/227634068": { department: "berkeley_fd", station: "2" }, // "Fire Station Number 2", 2029 Berkeley Way
  "osm/way/295968637": { department: "oakland_fd", station: "25" }, // "Fire Station #25", 2795 Butters Dr
  "osm/way/376587064": { department: "oakland_fd", station: "16" }, // "Fire Station Number 16", 3600 13th Ave
  "osm/node/3281243658": { department: "el_cerrito_fd", station: "51" }, // "El Cerrito Fire Department", San Pablo Ave
  "osm/way/694455393": { department: "el_cerrito_fd", station: "55" }, // "Kensington District Fire Department", 217 Arlington Ave
};

export interface LocalStationMatch {
  department: LocalDepartmentSpec;
  /** Station number parsed from the name (last integer), or null. */
  station: string | null;
  /** The published roster row, or null (department default). */
  roster: StationRoster | null;
  units: StationUnits | null;
  ambulances: number;
  evidence: string;
}

/**
 * The department and roster of an OSM station, or null when its name/operator names none of
 * DEPARTMENTS. `used` (department id -> station numbers already matched) keeps a station number
 * from being counted twice when OSM maps two buildings with the same number; the second gets the
 * department default.
 */
export function matchLocalStation(
  base: { id: string; name: string; agency?: string },
  used: Map<string, Set<string>>,
): LocalStationMatch | null {
  const alias = OSM_ALIASES[base.id];
  const text = `${base.name} ${base.agency ?? ""}`;
  const department = alias ? DEPARTMENTS.find((d) => d.id === alias.department) : DEPARTMENTS.find((d) => d.match.test(text));
  if (!department) return null;
  const numbers = base.name.match(/\d+/g);
  const keys = department.stations ? Object.keys(department.stations) : [];
  const station = alias?.station ?? (numbers ? String(Number(numbers[numbers.length - 1])) : keys.length === 1 ? keys[0] : null);
  const seen = used.get(department.id) ?? new Set<string>();
  used.set(department.id, seen);
  const fresh = station !== null && !seen.has(station);
  const roster = fresh && department.stations ? (department.stations[station] ?? null) : null;
  if (fresh && station !== null) seen.add(station);
  return {
    department,
    station,
    roster,
    units: roster ? roster.units : department.defaultUnits,
    ambulances: roster?.ambulances ?? 0,
    evidence: roster ? department.evidence : department.stations ? `${department.name}: station not in the roster, ${ASSUMED_EVIDENCE}` : department.evidence,
  };
}
