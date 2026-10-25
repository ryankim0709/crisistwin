/**
 * Which evacuation destinations (safe areas) are open for this incident, board-side.
 *
 * Destinations are the live drill's: the dispatch area's safe areas (dispatch-area/6,
 * app/backend/api/dispatch_area.py) packaged by livecore/package.py as `shelter` (a place inside
 * the board, at its road node) or `exit` (a road leaving toward a place beyond it, or a map-edge
 * crossing), each with `capacity_veh` (null = no known limit). A destination is closed when:
 * - the fire is forecast to reach it: the board solver's arrival field (model.ts waitMinutes, the
 *   same active fires the routes request avoids, fireRingsForRouting) reaches its road node, or a
 *   point APPROACH_BUFFER_M from it, within the horizon (FORECAST_MINUTES); or
 * - it is full: vehicles already sent there (trafficPicture byDestination) reach its capacity.
 * Never all of them: with every destination closed, the ones the fire reaches last (an unlimited
 * one first) stay open as a last resort. useDemoRoutes sends the closed ids with the routes
 * request (`excluded_destination_ids`), so every route option the board, the AI and a person can
 * pick from is an open destination. Simulated: a planning estimate, not an official designation.
 *
 * Units: minutes are board minutes from now; coordinates [lon, lat] WGS84; capacity and load in
 * vehicles.
 */

import type { Destination, LonLat } from "../live/types";
import { FORECAST_MINUTES, activeFires, trafficPicture, waitMinutes, type Board } from "./model";

/**
 * Metres around a destination's road node the fire must stay out of within the horizon: the
 * routing's FIRE_BUFFER_M (app/backend/livecore/routing.py, "Normal routes keep every edge at
 * least this far outside the fire estimate"), so the approach to an open destination is a
 * normal (clear) route's.
 */
export const APPROACH_BUFFER_M = 300;
/** Points sampled on the APPROACH_BUFFER_M circle (plus the node itself). */
const APPROACH_SAMPLES = 8;
const M_PER_DEG_LAT = 111_195.08;

export type SafeDestinationReason = "open" | "fire_forecast" | "full" | "kept_last_resort";

export interface SafeDestinationStatus {
  id: string;
  name: string;
  kind: string;
  coord: LonLat;
  capacityVeh: number | null;
  /** Vehicles sent there so far (arrived or on the way). */
  loadVeh: number;
  /** Minutes until the fire reaches the destination or its approach (0 = there now); null = not within the horizon. */
  fireEtaMin: number | null;
  open: boolean;
  reason: SafeDestinationReason;
  evidence: "simulated";
}

type DestinationLike = Pick<Destination, "id" | "name" | "kind" | "coord" | "capacity_veh">;

function approachPoints(p: LonLat): LonLat[] {
  const mLon = M_PER_DEG_LAT * Math.cos((p[1] * Math.PI) / 180);
  const out: LonLat[] = [p];
  for (let k = 0; k < APPROACH_SAMPLES; k += 1) {
    const a = (2 * Math.PI * k) / APPROACH_SAMPLES;
    out.push([p[0] + (APPROACH_BUFFER_M * Math.sin(a)) / mLon, p[1] + (APPROACH_BUFFER_M * Math.cos(a)) / M_PER_DEG_LAT]);
  }
  return out;
}

/** Earliest minutes until any active fire reaches the destination's node or approach, or null. */
function fireEta(board: Board, p: LonLat, horizonMin: number): number | null {
  let best: number | null = null;
  const fires = activeFires(board);
  for (const q of approachPoints(p)) {
    for (const fire of fires) {
      const w = waitMinutes(board, fire, q, horizonMin);
      if (w !== null && (best === null || w < best)) best = w;
    }
  }
  return best === null ? null : Math.round(best);
}

/** Open / closed status of every destination for the board now. */
export function safeDestinationStatus(
  board: Board,
  destinations: readonly DestinationLike[],
  horizonMin = FORECAST_MINUTES,
): SafeDestinationStatus[] {
  const load = trafficPicture(board).byDestination;
  const out: SafeDestinationStatus[] = destinations.map((d) => {
    const loadVeh = Math.round(load.get(d.id) ?? 0);
    const capacityVeh = d.capacity_veh ?? null;
    const fireEtaMin = fireEta(board, d.coord, horizonMin);
    const reason: SafeDestinationReason =
      fireEtaMin !== null ? "fire_forecast" : capacityVeh !== null && loadVeh >= capacityVeh ? "full" : "open";
    return {
      id: d.id, name: d.name, kind: d.kind, coord: d.coord, capacityVeh, loadVeh, fireEtaMin,
      open: reason === "open", reason, evidence: "simulated",
    };
  });
  if (out.length > 0 && !out.some((s) => s.open)) {
    // Last resort: the destinations the fire reaches last stay open (an unlimited one first,
    // then the one with the most room); a board always has somewhere to send people.
    const lateness = (s: SafeDestinationStatus) => (s.fireEtaMin === null ? Infinity : s.fireEtaMin);
    const latest = Math.max(...out.map(lateness));
    const keep = out.filter((s) => lateness(s) === latest);
    const unlimited = keep.filter((s) => s.capacityVeh === null);
    for (const s of unlimited.length > 0 ? unlimited : keep) {
      s.open = true;
      s.reason = "kept_last_resort";
    }
  }
  return out;
}

/** Destination ids to leave out of routing (closed), sorted. */
export function excludedDestinationIds(statuses: readonly SafeDestinationStatus[]): string[] {
  return statuses.filter((s) => !s.open).map((s) => s.id).sort();
}
