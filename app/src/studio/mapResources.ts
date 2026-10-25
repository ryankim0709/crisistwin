/**
 * The Studio's firefighting resources, as a pure function of the facilities on and near the
 * board: no unit counts are set by hand. See docs/response-model.md, "Resources come from the map".
 *
 * - Facilities: the CAL FIRE facilities layer around the board (GET /api/suppression/bases:
 *   observed locations, agency, unit, staffing) plus the board's OpenStreetMap fire stations
 *   (DispatchArea.stations) the layer does not list (city departments are often missing from it).
 * - Units: the shared fleet builder (response/fleet.ts buildFleet and its FACILITY_INVENTORY
 *   table). Facilities inside the board answer initial attack; the rest of the list is mutual aid.
 *   Aircraft come only from air attack and helitack bases within their dispatch radius.
 * - Dispatch for a run: the shared run card (response/runCards.ts) for the dispatch level the
 *   scenario's fuel moisture and wind give (or the structure card on developed ground), filled by
 *   the closest units by estimated arrival (closest-resource concept, Cal OES Operations Bulletin
 *   #1), on or off the board. What the facilities cannot fill is ordered from out of the area
 *   through the state system and reaches the board edge after the state lead time
 *   (response/orders.ts, about 4.5 h).
 *
 * Studio sends the initial-attack run card only: escalation orders when initial attack fails
 * need the board's minute-by-minute loop (/live, demo/boardResponse.ts).
 */

import type { DispatchArea, LonLat } from "../dispatch/area";
import { DEVELOPED_FUEL_CODE, MOISTURE_PRESETS, cellAt, type FuelMoisture } from "../fire/spread";
import type { LandscapeGrid } from "../fire/landscape";
import {
  airDispatchRadiusKm,
  buildFleet,
  greatCircleKm,
  summarizeFleet,
  unitsText,
  withOsmStations,
  type AircraftSeed,
  type BaseInput,
  type Fleet,
  type FleetSummary,
  type GroundResponseKind,
  type UnitSeed,
} from "../response/fleet";
import { airKindFor, dispatchLevel, groundFamilyOf, runCard, type DispatchLevel, type ResourceCounts } from "../response/runCards";
import { stateGroundLeadMinutes } from "../response/orders";
import type { AirBase } from "./aircraft";
import type { ApparatusCounts } from "./apparatus";
import { OFFBOARD_CIRCUITY, OFFBOARD_SPEED_KMH, type DispatchUnit, type TripOrigin } from "./crewDispatch";
import type { SuppressionBases } from "./suppressionBases";

export interface MapResources {
  /** Where the facilities came from. */
  source: "calfire" | "osm" | "none";
  fleet: Fleet;
  summary: FleetSummary;
  /** Provenance line for the panel. */
  sourceLabel: string;
}

const MPS_PER_MPH = 0.44704;

/**
 * Units on and near the board, or null while the board's roads (its box) or the facilities layer
 * are still loading. `bases` null = loading; `available: false` = the layer is unavailable.
 */
export function mapResources(area: DispatchArea | null, bases: SuppressionBases | null): MapResources | null {
  if (!area || bases === null) return null;
  const [west, south, east, north] = area.bbox;
  const onBoard = (p: LonLat) => p[0] >= west && p[0] <= east && p[1] >= south && p[1] <= north;
  const center: LonLat = [(west + east) / 2, (south + north) / 2];
  const layer: BaseInput[] = bases.available
    ? bases.bases.map((b) => ({ id: b.id, name: b.name, type: b.type, location: [b.lon, b.lat], agency: b.agency, unit: b.unit, staffing: b.staffing ?? null }))
    : [];
  const osm: BaseInput[] = area.stations.map((s) => ({ id: s.id, name: s.name, type: "osm_fire_station", location: s.location }));
  // Nearest the board's centre first (a CAL FIRE unit's engines and its dozer follow that order).
  const inputs = withOsmStations(layer, osm).sort(
    (a, b) => greatCircleKm(center, a.location) - greatCircleKm(center, b.location) || a.id.localeCompare(b.id),
  );
  const osmUsed = inputs.length - layer.length;
  const source: MapResources["source"] = layer.length > 0 ? "calfire" : osmUsed > 0 ? "osm" : "none";
  const fleet = buildFleet(inputs, onBoard, center);
  return {
    source,
    fleet,
    summary: summarizeFleet(fleet),
    sourceLabel:
      source === "calfire"
        ? `CAL FIRE facilities layer${bases.attribution ? ` (${bases.attribution})` : ""}: locations, agency and staffing observed${
            osmUsed > 0 ? `; plus ${osmUsed} OpenStreetMap fire station${osmUsed === 1 ? "" : "s"} on the board the layer does not list (agency unknown, one Type 3 engine each, assumed)` : ""
          }. Units per facility from a labelled table of sourced averages and assumptions.`
        : source === "osm"
          ? "OpenStreetMap fire stations (CAL FIRE layer unavailable): each is assumed to be one Type 3 engine; no crew camps or air bases."
          : "No fire stations found on this map or in the CAL FIRE layer.",
  };
}

/** Nearest moisture preset by 1-h dead fuel moisture (fire/spread.ts MOISTURE_PRESETS): ASSUMPTION mapping for the dispatch level. */
export function moistureClass(moisture: FuelMoisture): string {
  let best = MOISTURE_PRESETS[0];
  for (const preset of MOISTURE_PRESETS) {
    if (Math.abs(preset.moisture.dead1h - moisture.dead1h) < Math.abs(best.moisture.dead1h - moisture.dead1h)) best = preset;
  }
  return best.id;
}

export interface MapDispatch {
  level: DispatchLevel;
  structure: boolean;
  card: ResourceCounts;
  /** Ground units sent, each from its own base. */
  units: DispatchUnit[];
  /** Ground and air counts sent (the run's FirefightingSettings.resources). */
  counts: ApparatusCounts;
  /** The air bases the sent aircraft fly from (the aircraft model takes the nearest of each type). */
  airBases: AirBase[];
  /** Plain account of the card and how it was filled. */
  text: string;
}

const KIND_ORIGIN: Record<GroundResponseKind, TripOrigin> = {
  engine_t3: "station",
  engine_t1: "station",
  hand_crew_t1: "crew_camp",
  dozer_t2: "dozer_base",
};

/** The point of the board's edge nearest `p` (where out-of-area units enter). */
function edgePoint(area: DispatchArea, p: LonLat): LonLat {
  const [west, south, east, north] = area.bbox;
  const x = Math.min(east, Math.max(west, p[0]));
  const y = Math.min(north, Math.max(south, p[1]));
  const d = [x - west, east - x, y - south, north - y];
  const i = d.indexOf(Math.min(...d));
  return i === 0 ? [west, y] : i === 1 ? [east, y] : i === 2 ? [x, south] : [x, north];
}

/**
 * The run card for a fire at `fire`, filled from the map's units by estimated arrival (turnout +
 * straight line x OFFBOARD_CIRCUITY at OFFBOARD_SPEED_KMH; the road router then plans the real
 * trips). A ground shortfall comes from out of the area (state system lead time); an aircraft
 * shortfall is reported, not flown (the state's aircraft have no base on the map).
 */
export function planMapDispatch(
  resources: MapResources,
  area: DispatchArea,
  fire: LonLat,
  scenario: { windSpeedMph: number; moisture: FuelMoisture },
  grid: LandscapeGrid | null,
): MapDispatch {
  const moisture = moistureClass(scenario.moisture);
  const level = dispatchLevel(moisture, scenario.windSpeedMph * MPS_PER_MPH);
  const cell = grid ? cellAt(grid, { longitude: fire[0], latitude: fire[1] }) : -1;
  const structure = cell >= 0 && grid!.fuelCodes[cell] === DEVELOPED_FUEL_CODE;
  const card = runCard(level, structure);
  const { fleet } = resources;
  const nameOf = new Map(fleet.facilities.map((f) => [f.id, f.name]));
  const eta = (u: UnitSeed) => u.turnoutMinutes + ((greatCircleKm(u.location, fire) * OFFBOARD_CIRCUITY) / OFFBOARD_SPEED_KMH) * 60;
  const candidates = [...fleet.units, ...fleet.offBoardUnits].sort((a, b) => eta(a) - eta(b) || a.stationId.localeCompare(b.stationId));
  const units: DispatchUnit[] = [];
  const counts: ApparatusCounts = {};
  const short: Partial<Record<"engines" | "hand_crews" | "dozers", number>> = {};
  const need = { engines: card.engines, hand_crews: card.hand_crews, dozers: card.dozers };
  for (const u of candidates) {
    const family = groundFamilyOf(u.kind);
    if (need[family] <= 0) continue;
    need[family] -= 1;
    counts[u.kind] = (counts[u.kind] ?? 0) + 1;
    units.push({
      kind: u.kind,
      baseName: nameOf.get(u.stationId) ?? u.stationId,
      location: u.location,
      origin: u.tier === "closest" ? KIND_ORIGIN[u.kind] : "mutual_aid",
      turnoutMinutes: u.turnoutMinutes,
      leadMinutes: 0,
    });
  }
  const stateKind: Record<"engines" | "hand_crews" | "dozers", GroundResponseKind> = { engines: "engine_t3", hand_crews: "hand_crew_t1", dozers: "dozer_t2" };
  const entry = edgePoint(area, fire);
  const lead = stateGroundLeadMinutes();
  for (const family of ["engines", "hand_crews", "dozers"] as const) {
    if (need[family] <= 0) continue;
    short[family] = need[family];
    const kind = stateKind[family];
    for (let i = 0; i < need[family]; i += 1) {
      counts[kind] = (counts[kind] ?? 0) + 1;
      units.push({ kind, baseName: "Out of the area (state order)", location: entry, origin: "state", turnoutMinutes: 0, leadMinutes: lead });
    }
  }

  // Aircraft: the nearest of each kind within its dispatch radius of the fire.
  const air: AircraftSeed[] = [];
  const airShort: string[] = [];
  for (const family of ["air_attack", "airtankers", "helicopters"] as const) {
    const kind = airKindFor(family);
    const wanted = card[family];
    if (wanted <= 0) continue;
    const near = fleet.aircraft
      .filter((a) => a.kind === kind && greatCircleKm(a.location, fire) <= airDispatchRadiusKm(kind))
      .sort((a, b) => greatCircleKm(a.location, fire) - greatCircleKm(b.location, fire) || a.baseId.localeCompare(b.baseId))
      .slice(0, wanted);
    air.push(...near);
    counts[kind] = (counts[kind] ?? 0) + near.length;
    if (near.length < wanted) airShort.push(unitsText({ [kind]: wanted - near.length }));
  }
  const airBases: AirBase[] = [];
  for (const a of air) {
    if (airBases.some((b) => b.id === a.baseId)) continue;
    const type = a.kind === "helicopter_t2" ? "HB" : "AAB";
    airBases.push({ id: a.baseId, name: a.baseName, type, lon: a.location[0], lat: a.location[1] });
  }

  const cardText = unitsText({
    engine_t3: card.engines,
    hand_crew_t1: card.hand_crews,
    dozer_t2: card.dozers,
    air_attack: card.air_attack,
    airtanker_s2t: card.airtankers,
    helicopter_t2: card.helicopters,
  });
  const why = structure ? "structure fire (developed ground)" : `${level} dispatch level (${moisture} fuel moisture, ${Math.round(scenario.windSpeedMph)} mph wind)`;
  const shortText = unitsText({ engine_t3: short.engines ?? 0, hand_crew_t1: short.hand_crews ?? 0, dozer_t2: short.dozers ?? 0 });
  const text = [
    `Run card for a ${why}: ${cardText || "no units"}.`,
    shortText ? `The map cannot fill ${shortText}: ordered from out of the area through the state system, at the board edge after about ${(lead / 60).toFixed(1)} h.` : null,
    airShort.length > 0 ? `No base within reach for ${airShort.join(", ")}; not flown.` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return { level, structure, card, units, counts, airBases, text };
}
