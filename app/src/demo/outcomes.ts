/**
 * Evacuation outcomes of the simulated command board, for the /live outcomes panel
 * (live/Outcomes.tsx). Pure: reads the board and its zone forecasts, no React, network or LLM.
 *
 * Every number comes from the board's own counts (model.ts zoneCounts / zonePeople / totals), so
 * it agrees with the commander's observation and conserves population: per zone, home + on the
 * road + out + caught = total. Persons are null (shown "unknown", never 0) when a zone's
 * occupants are not all known; households are always known. Simulation minutes throughout.
 *
 * Definitions (docs/command-demo-realism.md "Resource snapshot" and "Evacuation traffic"):
 * - Out: households whose cohort's congested arrival at its route's destination is at or before
 *   the board minute (zoneCounts.out), and their persons (zonePeople.out).
 * - On the road: departed, arrival still ahead (zoneCounts.enRoute / zonePeople.enRoute).
 * - Threatened zone: model.ts zoneThreatened (fire has touched it, or the forecast reaches any of
 *   its cells within FORECAST_MINUTES).
 * - Still in threatened zones: persons home in threatened zones (zonePeople.home), carless ones
 *   included. An overrun zone has nobody home (they are caught). Of them: in zones with an order
 *   scheduled for a later minute (zone.pendingOrder; they leave then), and in zones with neither
 *   an order in effect nor one scheduled (nobody leaves those: the board has no self-evacuation).
 * - Unable to reach safety: caught (home when fire reached the zone core, zones still overrun)
 *   plus carless persons still home in threatened zones (the board has no pickup model, so they
 *   cannot leave). The two never overlap: an overrun zone's carless persons are caught. With
 *   model.EVERY_HOUSEHOLD_DRIVES (the drill simplification) no household is carless on the board,
 *   so need transport is 0 and only the caught count.
 * - Close call: left home less than CLOSE_CALL_MINUTES before fire reached their zone's core
 *   (zone.overrunAt), from the cohort departure minutes (zone.trips.at, whole-minute traffic
 *   steps). The model's catch rule is "still home at core arrival", so this is the margin by
 *   which they escaped it. Zones still overrun only (a reopened zone's trips are cleared).
 * - Arrivals by destination: arrived cohorts by the destination they left toward (trips.dest).
 * - Homes burned: demo/scoring.ts zoneHomes (each zone's households x its share of developed
 *   cells burned; losses are counted whichever fire burned them).
 * - Report rule (boardResponse.ts): the commander's picture. `forecasts` are
 *   zoneForecasts(board, "reported"), so a fire not yet reported to dispatch threatens no zone
 *   here, and the fire counts and burned area leave it out until its report. Caught households
 *   are counted whichever fire caught them (losses are never hidden).
 */

import { isReported } from "./boardResponse";
import { FORECAST_MINUTES, totals, vehiclePersons, zoneCounts, zonePeople, zoneThreatened, type Board, type ZoneForecast, type ZoneState } from "./model";
import { HOMES_METHOD_LABEL, zoneHomes } from "./scoring";

/** ASSUMPTION: a display threshold for "close call", not a model parameter. */
export const CLOSE_CALL_MINUTES = 15;
export { FORECAST_MINUTES };

/** People (null = unknown) and households. */
export interface Count {
  people: number | null;
  households: number;
}

export interface DestinationArrivals {
  id: string;
  name: string;
  people: number | null;
  households: number;
}

export interface BoardOutcomes {
  minute: number;
  /** Everyone on the board, and households whose occupants are unknown. */
  total: Count;
  unknownHouseholds: number;
  out: Count;
  enRoute: Count;
  threatenedZones: number;
  /** All persons of the threatened zones (the progress bar's denominator there), and those out. */
  threatenedAll: Count;
  threatenedOut: Count;
  threatenedHome: Count;
  /** Of threatenedHome: in zones whose evacuation is scheduled for a later minute, and the zones. */
  threatenedHomeScheduled: Count & { zones: number };
  /** Of threatenedHome: in zones with no evacuation order in effect or scheduled. */
  threatenedHomeNoOrder: Count;
  /** Caught in zones still overrun now; caughtRun = over the whole run (also zones since reopened). */
  caught: Count;
  caughtRun: Count;
  /** Carless persons still home in threatened zones. */
  needsTransport: Count;
  /** caught + needsTransport. */
  unable: Count;
  closeCalls: Count & { zones: number };
  /** Arrived so far, most people first. */
  destinations: DestinationArrivals[];
  fires: { burning: number; contained: number; outTotal: number; burnedHa: number };
  /** Homes (households) burned and reached by fire but put out by crews, by demo/scoring.ts HOMES_METHOD_LABEL. */
  homes: { burned: number; reachedSaved: number; zones: number; method: string };
}

const add = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a + b);

function plus(c: Count, people: number | null, households: number): void {
  c.people = add(c.people, people);
  c.households += households;
}

const zero = (): Count => ({ people: 0, households: 0 });

/** Persons of the zone's cohorts departed[k-1]..departed[k] (null when its persons are unknown). */
function cohortPeople(zone: ZoneState, before: number, after: number): number | null {
  return zone.occupants === null ? null : vehiclePersons(zone, after) - vehiclePersons(zone, before);
}

/** Destination names from the routes the board has seen. */
function destinationNames(board: Board): Map<string, string> {
  const names = new Map<string, string>();
  for (const options of board.routes.values()) for (const o of options) names.set(o.destination_id, o.name);
  for (const z of board.zones) {
    for (const r of [z.route, z.pendingOrder?.route]) if (r) names.set(r.destination_id, r.name);
  }
  return names;
}

/** Fire counts and burned area of the fires dispatch has (report rule); fires already removed from the board were all closed. */
function reportedFires(board: Board, outTotal: number): BoardOutcomes["fires"] {
  const fires = { burning: 0, contained: 0, outTotal, burnedHa: board.removedBurnedHa };
  for (const fire of board.fires) {
    if (!isReported(board, fire)) continue;
    if (fire.status === "burning") fires.burning += 1;
    else if (fire.status === "contained") fires.contained += 1;
    fires.burnedHa += fire.areaHa;
  }
  return fires;
}

export function boardOutcomes(board: Board, forecasts: Map<string, ZoneForecast>): BoardOutcomes {
  const t = totals(board, forecasts);
  const minute = board.minute;
  const o: BoardOutcomes = {
    minute,
    total: { people: t.people.total, households: t.households },
    unknownHouseholds: t.people.unknownHouseholds,
    out: { people: t.people.out, households: t.out },
    enRoute: { people: t.people.enRoute, households: t.enRoute },
    threatenedZones: 0,
    threatenedAll: zero(),
    threatenedOut: zero(),
    threatenedHome: zero(),
    threatenedHomeScheduled: { ...zero(), zones: 0 },
    threatenedHomeNoOrder: zero(),
    caught: { people: t.people.caught, households: t.caught },
    caughtRun: { people: t.people.caughtTotal, households: t.caughtTotal },
    needsTransport: { people: t.people.needsTransportAtRisk, households: t.noVehicleAtRisk },
    unable: { people: add(t.people.caught, t.people.needsTransportAtRisk), households: t.caught + t.noVehicleAtRisk },
    closeCalls: { ...zero(), zones: 0 },
    destinations: [],
    fires: reportedFires(board, t.firesOutTotal),
    homes: { burned: 0, reachedSaved: 0, zones: 0, method: HOMES_METHOD_LABEL },
  };
  for (const h of zoneHomes(board)) {
    o.homes.burned += h.homesBurned;
    o.homes.reachedSaved += h.homesReachedSaved;
    if (h.homesBurned > 0) o.homes.zones += 1;
  }
  const names = destinationNames(board);
  const byDest = new Map<string, DestinationArrivals>();
  for (const zone of board.zones) {
    const c = zoneCounts(zone, minute);
    const p = zonePeople(zone, minute);
    if (zoneThreatened(zone, forecasts)) {
      o.threatenedZones += 1;
      plus(o.threatenedAll, p.total, zone.households);
      plus(o.threatenedOut, p.out, c.out);
      plus(o.threatenedHome, p.home, c.home);
      if (zone.overrunAt === null && zone.orderedAt === null) {
        if (zone.pendingOrder) {
          plus(o.threatenedHomeScheduled, p.home, c.home);
          o.threatenedHomeScheduled.zones += 1;
        } else plus(o.threatenedHomeNoOrder, p.home, c.home);
      }
    }
    const trips = zone.trips;
    let closeHere = false;
    for (let k = 0; k < trips.at.length; k += 1) {
      const before = k > 0 ? trips.departed[k - 1] : 0;
      const households = trips.departed[k] - before;
      if (households <= 0) continue;
      if (trips.arriveAt[k] <= minute) {
        const id = trips.dest[k] ?? "unknown";
        const d = byDest.get(id) ?? { id, name: names.get(id) ?? id, people: 0, households: 0 };
        d.people = add(d.people, cohortPeople(zone, before, trips.departed[k]));
        d.households += households;
        byDest.set(id, d);
      }
      // A cohort is recorded at the whole minute after its departures, so the margin is at most 1 min short.
      if (zone.overrunAt !== null && Math.max(0, zone.overrunAt - trips.at[k]) < CLOSE_CALL_MINUTES) {
        plus(o.closeCalls, cohortPeople(zone, before, trips.departed[k]), households);
        closeHere = true;
      }
    }
    if (closeHere) o.closeCalls.zones += 1;
  }
  o.destinations = [...byDest.values()].sort(
    (a, b) => (b.people ?? -1) - (a.people ?? -1) || b.households - a.households || a.name.localeCompare(b.name),
  );
  return o;
}
