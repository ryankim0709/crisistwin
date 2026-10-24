/**
 * Apparatus of the dispatch agent's engines and the road access they route by
 * (docs/suppression-data.md). Each OSM fire station of the dispatch area holds the engines the
 * backend gives it (one, an ASSUMPTION of app/backend/api/dispatch_area.py). Its kind:
 *
 * - matched (within MATCH_METERS) to a state-owned CAL FIRE-layer station: a CAL FIRE Type 3
 *   engine, the data's default state engine (WHEG 2013 Models 14/24/34);
 * - matched to another CAL FIRE-layer station (local government, contract county): a Type 1
 *   structure engine (ASSUMPTION: the layer has no apparatus for local stations);
 * - unmatched, or no bases file (tools/ca_fire_bases.json is local-only): a Type 3 engine
 *   (ASSUMPTION, the dispatch agent's engines before road access).
 *
 * Road access per class comes from studio/crewDispatch.ts `accessTableFor` (rules R01-R12 on the
 * area's OSM tags with grades from the landscape DEM), the graphs the Studio's crew dispatch uses.
 * Pure: no React or network.
 */

import { groundMeters, type DispatchArea } from "./area";
import { GROUND_APPARATUS, type GroundKind } from "../studio/apparatus";
import { accessTableFor } from "../studio/crewDispatch";
import type { EdgeAccess } from "../studio/roadAccess";
import { STATION_TYPES, type SuppressionBases } from "../studio/suppressionBases";
import type { LandscapeGrid } from "../fire/landscape";

/** An OSM station this close to a CAL FIRE-layer station is taken to be it (as crewDispatch). */
export const MATCH_METERS = 500;

export interface DispatchApparatus {
  /** Per-edge access for every class; one entry per area edge. */
  access: EdgeAccess[];
  /** Unit id -> apparatus kind. */
  kinds: Map<string, GroundKind>;
  /** How the kinds and access were decided, for the agent's model notes. */
  notes: string[];
}

export function dispatchApparatus(
  area: DispatchArea,
  grid: LandscapeGrid | null,
  bases: SuppressionBases | null,
): DispatchApparatus {
  const layer = bases?.available ? bases.bases.filter((b) => STATION_TYPES.has(b.type)) : [];
  const kinds = new Map<string, GroundKind>();
  const counts = { state: 0, local: 0, unmatched: 0 };
  for (const station of area.stations) {
    let match: { agency: string; meters: number } | null = null;
    for (const base of layer) {
      const meters = groundMeters(station.location, [base.lon, base.lat]);
      if (meters <= MATCH_METERS && (!match || meters < match.meters)) match = { agency: base.agency, meters };
    }
    const kind: GroundKind = match && !match.agency.startsWith("CAL FIRE") ? "engine_t1" : "engine_t3";
    if (!match) counts.unmatched += 1;
    else if (kind === "engine_t3") counts.state += 1;
    else counts.local += 1;
    for (const unit of station.units) kinds.set(unit.id, kind);
  }
  const notes = [
    `Units are ground apparatus (units[].apparatus). ${counts.state} station(s) match a state-owned CAL FIRE station and run a ${GROUND_APPARATUS.engine_t3.label} (the data's default state engine); ${counts.local} match a local or contract-county station and run a ${GROUND_APPARATUS.engine_t1.label} (assumption: the CAL FIRE layer has no apparatus); ${counts.unmatched} ${bases?.available ? "match no CAL FIRE-layer station" : "have no CAL FIRE base data (local-only file)"} and run a ${GROUND_APPARATUS.engine_t3.label} (assumption).`,
    `Each unit drives only roads its access_class may use (docs/suppression-data.md rules R01-R12: surface, track grade, road grade from the terrain${grid ? "" : " (unknown here: 0% assumed)"}, width, height, weight, dead ends), service roads and tracks included, at that class's speed. units[].no_access lists threatened zones and burning fires a unit cannot reach because of its class, with the blocking rule; send another unit there. Planner closures and the fire close a road to every class.`,
  ];
  return { access: accessTableFor(area, grid), kinds, notes };
}
