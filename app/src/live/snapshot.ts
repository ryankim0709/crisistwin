/**
 * Builds `LiveSnapshot` pieces from fire frames and the dispatch engine. Pure: no React or
 * network. See contracts.ts.
 */

import type { Polygon } from "geojson";
import type { DispatchEngine, ZoneState } from "../dispatch/engine";
import { routeCoords } from "../dispatch/routing";
import {
  MAX_LIVE_RING_POINTS,
  MAX_LIVE_RINGS,
  type LiveGuidance,
  type LiveZone,
  type LonLat,
} from "./contracts";

/** Suggest waiting only when the households already queued take at least this long to clear. */
export const WAIT_MIN_QUEUE_MINUTES = 10;
/** ...and the fire core is at least this much further away than the wait plus the drive. */
export const WAIT_SAFETY_MARGIN_MINUTES = 30;
const WAIT_ROUNDING_MINUTES = 5;
const SQUARE_METERS_PER_HECTARE = 10_000;

/** Evenly thin a line to at most `max` points, keeping both ends. */
export function thin(points: LonLat[], max: number): LonLat[] {
  if (points.length <= max) return points.map(([x, y]) => [round6(x), round6(y)]);
  const out: LonLat[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i += 1) {
    const [x, y] = points[Math.round(i * step)];
    out.push([round6(x), round6(y)]);
  }
  return out;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Thin a ring and keep it closed with at least 4 points; null when degenerate. */
function closedRing(ring: LonLat[]): LonLat[] | null {
  const open = ring.length > 1 && ring[0][0] === ring.at(-1)![0] && ring[0][1] === ring.at(-1)![1]
    ? ring.slice(0, -1)
    : ring;
  if (open.length < 3) return null;
  const thinned = thin(open, MAX_LIVE_RING_POINTS - 1);
  return [...thinned, thinned[0]];
}

/** Outer rings of a frame's perimeters, largest first, within the server limits. */
export function fireRings(perimeters: readonly { geometry: Polygon }[]): LonLat[][] {
  return perimeters
    .map((feature) => (feature.geometry.coordinates[0] ?? []) as LonLat[])
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_LIVE_RINGS)
    .map(closedRing)
    .filter((ring): ring is LonLat[] => ring !== null);
}

export function hectares(squareMeters: number): number {
  return Math.round(squareMeters / SQUARE_METERS_PER_HECTARE);
}

function eta(arrival: number, now: number): number | null {
  if (!Number.isFinite(arrival)) return null;
  return Math.max(0, Math.round(arrival - now));
}

interface Guidance {
  guidance: LiveGuidance;
  message: string;
  waitMin: number | null;
}

function guidanceFor(
  state: ZoneState,
  exitLabel: string | null,
  driveMin: number | null,
  coreEta: number | null,
  edgeEta: number | null,
): Guidance {
  if (state.status === "overrun") {
    return { guidance: "overrun", message: "In the simulation, fire has reached this zone.", waitMin: null };
  }
  if (state.status === "cleared") {
    return { guidance: "cleared", message: "In the simulation, everyone in this zone has left.", waitMin: null };
  }
  if (state.status === "no_order" && state.stage) {
    return {
      guidance: "no_order",
      message: `Get ready, but stay home for now: your zone leaves in a later wave so the roads stay clear.${edgeEta !== null ? ` The simulated fire is about ${edgeEta} min away.` : ""} You will be told when it is your turn.`,
      waitMin: null,
    };
  }
  if (state.status === "no_order") {
    const near = edgeEta !== null ? ` The simulated fire is about ${edgeEta} min from the zone.` : "";
    return {
      guidance: "no_order",
      message: `No evacuation order for this zone yet.${near} Be ready to leave.`,
      waitMin: null,
    };
  }
  if (!state.route || state.routeBlocked || !exitLabel) {
    return {
      guidance: "route_blocked",
      message: "The assigned route is cut off by fire in the simulation. Hold until dispatch assigns a new exit.",
      waitMin: null,
    };
  }
  const drive = driveMin !== null ? ` (about ${driveMin} min drive)` : "";
  // Households already ready and queued at the zone must enter the route at its bottleneck.
  const queueMin = (state.queued / state.route.bottleneckVph) * 60;
  const waitMin = Math.round(queueMin / WAIT_ROUNDING_MINUTES) * WAIT_ROUNDING_MINUTES;
  const fireFar = coreEta === null || coreEta > waitMin + (driveMin ?? 0) + WAIT_SAFETY_MARGIN_MINUTES;
  if (queueMin >= WAIT_MIN_QUEUE_MINUTES && waitMin > 0 && fireFar) {
    return {
      guidance: "wait",
      message: `Evacuation ordered via ${exitLabel}. The route is backed up; if you are safe, wait about ${waitMin} min before leaving${drive}.`,
      waitMin,
    };
  }
  return { guidance: "leave_now", message: `Leave now via ${exitLabel}${drive}.`, waitMin: null };
}

/** Every dispatch zone with resident guidance derived from the engine state. */
export function liveZones(engine: DispatchEngine): LiveZone[] {
  const { area, exposure, minute } = engine;
  return engine.zones.map((state) => {
    const zone = area.zones[state.index];
    const exit = state.exitId ? area.exits.find((e) => e.id === state.exitId) ?? null : null;
    const exitLabel = exit ? (exit.road && exit.road !== exit.name ? `${exit.name} (${exit.road})` : exit.name) : null;
    const activeRoute = state.status === "ordered" && state.route && !state.routeBlocked ? state.route : null;
    const driveMin = activeRoute ? Math.max(1, Math.round(activeRoute.seconds / 60)) : null;
    const coreEta = eta(exposure.zoneCore[state.index], minute);
    const edgeEta = eta(exposure.zoneContact[state.index], minute);
    const { guidance, message, waitMin } = guidanceFor(state, exitLabel, driveMin, coreEta, edgeEta);
    const polygon = closedRing(zone.polygon);
    const route = activeRoute ? thin(routeCoords(area, activeRoute.steps), MAX_LIVE_RING_POINTS) : null;
    return {
      id: zone.id,
      name: zone.name,
      polygon: polygon ?? [],
      guidance,
      message,
      exit: exit ? { id: exit.id, name: exit.name, road: exit.road, location: area.nodes[exit.node] } : null,
      route: route && route.length >= 2 ? route : null,
      drive_min: driveMin,
      wait_min: waitMin,
      fire_eta_min: edgeEta,
      fire_core_eta_min: coreEta,
    };
  }).filter((zone) => zone.polygon.length >= 4);
}
