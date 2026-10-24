/**
 * Simulation state for the mobile app: Studio's evacuation run turned into the payloads of
 * `POST /api/sim-state/runs` and `.../tick` (docs/sim-state-api.md). Pure: no React, DOM or network.
 * Everything published is simulated; the homes and their addresses are synthetic.
 */

import type { DispatchArea, LonLat } from "../dispatch/area";
import type { DispatchEngine } from "../dispatch/engine";
import type { EvacuationInputs, EvacuationSummary } from "./evacuation";

/** A home is labelled with a road only when one is this close, ground metres. */
export const ADDRESS_ROAD_METERS = 80;
/** The server's limit on an address. */
const ADDRESS_MAX_CHARS = 120;
const CELL_METERS = ADDRESS_ROAD_METERS;
/** House numbers advance one slot per this many metres along the road, per side. */
const SLOT_METERS = 8;
const METERS_PER_DEGREE = 111_320;

export type SimAdvice =
  "leave_now" | "leave_later" | "no_order" | "cut_off" | "cleared" | "overrun";

export interface SimRunPayload {
  label: string;
  area: { id: string; name: string; bbox: [number, number, number, number] };
  horizon_minutes: number;
  order_minute: number;
  zones: { zone_id: string; name: string; centroid: LonLat; homes: number }[];
  homes: { home_id: string; zone_id: string; rank: number; coord: LonLat; address: string }[];
}

export interface SimTickZone {
  zone_id: string;
  advice: SimAdvice;
  order_minute: number | null;
  departed: number;
  at_home: number;
  exit_id: string | null;
}

export interface SimTickPayload {
  minute: number;
  zones: SimTickZone[];
}

/** What the full run does to each zone; from `simulateEvacuation`. */
export type ZoneSchedule = Pick<EvacuationSummary, "zoneOrderMinutes" | "cutOffZoneIndices">;

interface Segment {
  edge: number;
  /** Local metres. */
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Metres along the edge polyline at the segment start. */
  along: number;
}

/**
 * A synthetic street address per home (index = `area.homes`): the nearest named road within
 * ADDRESS_ROAD_METERS and a made-up house number from the position along that road (odd and even
 * numbers on opposite sides), else "Home n, <zone>". Deterministic.
 */
export function homeAddresses(area: DispatchArea): string[] {
  const lat0 = (area.bbox[1] + area.bbox[3]) / 2;
  const kx = METERS_PER_DEGREE * Math.cos((lat0 * Math.PI) / 180);
  const toLocal = (p: LonLat): [number, number] => [
    (p[0] - area.bbox[0]) * kx,
    (p[1] - area.bbox[1]) * METERS_PER_DEGREE,
  ];
  const cells = new Map<string, Segment[]>();
  const key = (cx: number, cy: number) => `${cx},${cy}`;
  for (const edge of area.edges) {
    if (!edge.name) continue;
    let along = 0;
    let [ax, ay] = toLocal(edge.coords[0]);
    for (let i = 1; i < edge.coords.length; i += 1) {
      const [bx, by] = toLocal(edge.coords[i]);
      const segment: Segment = { edge: edge.index, ax, ay, bx, by, along };
      const x0 = Math.floor(Math.min(ax, bx) / CELL_METERS);
      const x1 = Math.floor(Math.max(ax, bx) / CELL_METERS);
      const y0 = Math.floor(Math.min(ay, by) / CELL_METERS);
      const y1 = Math.floor(Math.max(ay, by) / CELL_METERS);
      for (let cx = x0; cx <= x1; cx += 1) {
        for (let cy = y0; cy <= y1; cy += 1) {
          const k = key(cx, cy);
          const list = cells.get(k);
          if (list) list.push(segment);
          else cells.set(k, [segment]);
        }
      }
      along += Math.hypot(bx - ax, by - ay);
      ax = bx;
      ay = by;
    }
  }

  return area.homes.map((home, index) => {
    const [px, py] = toLocal(home.position);
    const cx = Math.floor(px / CELL_METERS);
    const cy = Math.floor(py / CELL_METERS);
    let best: { segment: Segment; meters: number; t: number; side: number } | null = null;
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (const segment of cells.get(key(cx + dx, cy + dy)) ?? []) {
          const sx = segment.bx - segment.ax;
          const sy = segment.by - segment.ay;
          const length2 = sx * sx + sy * sy;
          const t =
            length2 > 0
              ? Math.max(
                  0,
                  Math.min(1, ((px - segment.ax) * sx + (py - segment.ay) * sy) / length2),
                )
              : 0;
          const meters = Math.hypot(px - (segment.ax + t * sx), py - (segment.ay + t * sy));
          if (
            meters <= ADDRESS_ROAD_METERS &&
            (!best ||
              meters < best.meters ||
              (meters === best.meters && segment.edge < best.segment.edge))
          ) {
            const cross = sx * (py - segment.ay) - sy * (px - segment.ax);
            best = { segment, meters, t, side: cross >= 0 ? 0 : 1 };
          }
        }
      }
    }
    if (!best) {
      const zone = area.zones[home.zone];
      return `Home ${index - zone.firstHome + 1}, ${zone.name}`;
    }
    const { segment } = best;
    const along =
      segment.along + best.t * Math.hypot(segment.bx - segment.ax, segment.by - segment.ay);
    const hundreds = 1 + (segment.edge % 40);
    const number = hundreds * 100 + Math.floor(along / SLOT_METERS) * 2 + best.side;
    return `${number} ${area.edges[segment.edge].name}`;
  });
}

/** Body of `POST sim-state/runs`. `addresses` is `homeAddresses(area)`. */
export function runPayload(
  area: DispatchArea,
  inputs: Pick<EvacuationInputs, "horizonMinutes" | "orderMinute">,
  addresses: readonly string[],
  label: string,
): SimRunPayload {
  return {
    label: label.slice(0, 120),
    area: { id: area.id, name: area.name, bbox: area.bbox },
    horizon_minutes: inputs.horizonMinutes,
    order_minute: inputs.orderMinute,
    zones: area.zones.map((zone) => ({
      zone_id: zone.id,
      name: zone.name,
      centroid: zone.centroid,
      homes: zone.homes,
    })),
    homes: area.homes.map((home, i) => ({
      home_id: `h${i}`,
      zone_id: area.zones[home.zone].id,
      rank: i - area.zones[home.zone].firstHome,
      coord: home.position,
      address: addresses[i].slice(0, ADDRESS_MAX_CHARS),
    })),
  };
}

/** Per-zone order minutes and cut-off zones over the full run (`simulateEvacuation`'s summary). */
export function zoneSchedule(summary: ZoneSchedule): ZoneSchedule {
  return {
    zoneOrderMinutes: summary.zoneOrderMinutes,
    cutOffZoneIndices: summary.cutOffZoneIndices,
  };
}

/** Every zone's advice at the engine's current minute, per the table in docs/sim-state-api.md. */
export function zoneTick(
  area: DispatchArea,
  engine: DispatchEngine,
  cutOff: ReadonlySet<number>,
  schedule: ZoneSchedule,
): SimTickPayload {
  const minute = engine.minute;
  const zones = engine.zones.map((zone): SimTickZone => {
    const homes = area.zones[zone.index].homes;
    const orderMinute = schedule.zoneOrderMinutes[zone.index] ?? null;
    let advice: SimAdvice;
    if (cutOff.has(zone.index)) advice = "cut_off";
    else if (zone.status === "cleared") advice = "cleared";
    else if (zone.status === "overrun") advice = "overrun";
    else if (zone.status === "ordered") advice = "leave_now";
    else if (zone.stage !== null || (orderMinute !== null && orderMinute > minute))
      advice = "leave_later";
    else advice = "no_order";
    return {
      zone_id: area.zones[zone.index].id,
      advice,
      order_minute: orderMinute,
      departed: Math.max(0, homes - zone.atHome),
      at_home: zone.atHome,
      exit_id: zone.exitId,
    };
  });
  return { minute, zones };
}

/** The zones of `next` that differ from the same zone in `prev` (all of them when no `prev`). */
export function diffTick(
  prev: readonly SimTickZone[] | null,
  next: readonly SimTickZone[],
): SimTickZone[] {
  if (!prev) return [...next];
  const before = new Map(prev.map((zone) => [zone.zone_id, zone]));
  return next.filter((zone) => {
    const old = before.get(zone.zone_id);
    return (
      !old ||
      old.advice !== zone.advice ||
      old.order_minute !== zone.order_minute ||
      old.departed !== zone.departed ||
      old.at_home !== zone.at_home ||
      old.exit_id !== zone.exit_id
    );
  });
}
