/**
 * Which stylized 3D houses (fire/diorama cover houses, placeholders along OSM residential streets)
 * show "residents safe" on the /live diorama. The board's evacuation is per zone, not per house, so
 * each zone's houses are marked in proportion to its households that reached safety
 * (zoneCounts(...).out, plus those driving back home after an all clear, / zone.households), rounded down so the picture never shows more than the
 * counts. Houses are taken in a stable hash order, so the marked set only grows as more leave.
 * An allocation of simulated counts, not per-house data.
 *
 * Pure: no React, three.js or network.
 */

import { HOUSE_MARK } from "../fire/diorama/cover";
import type { GeoPoint } from "../fire/diorama/types";
import type { LonLat } from "../live/types";
import { pointInRing, zoneCounts, type Board, type ZoneState } from "./model";

export interface HouseZones {
  /** Houses this index was built for (FireDioramaSceneApi.houseLocations identity). */
  houses: readonly GeoPoint[];
  /** Zone id → its houses' indices, in stable hash order. */
  byZone: Map<string, Int32Array>;
}

/** Stable 32-bit hash of a house position (micro-degrees), for the marking order. */
function positionHash(p: GeoPoint): number {
  let h = Math.imul(Math.round(p.longitude * 1e6), 0x9e3779b1) ^ Math.imul(Math.round(p.latitude * 1e6), 0x85ebca77);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return h >>> 0;
}

/** Each house in the first zone whose ring contains it (zones that overlap keep the earlier one). */
export function assignHouses(houses: readonly GeoPoint[], zones: readonly ZoneState[]): HouseZones {
  const boxes = zones.map((z) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of z.ring) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    return { minX, minY, maxX, maxY };
  });
  const lists = zones.map(() => [] as number[]);
  houses.forEach((h, i) => {
    const p: LonLat = [h.longitude, h.latitude];
    for (let z = 0; z < zones.length; z++) {
      const b = boxes[z];
      if (zones[z].ring.length < 3 || p[0] < b.minX || p[0] > b.maxX || p[1] < b.minY || p[1] > b.maxY) continue;
      if (pointInRing(p, zones[z].ring)) {
        lists[z].push(i);
        break;
      }
    }
  });
  const byZone = new Map<string, Int32Array>();
  zones.forEach((z, k) => {
    const hashes = new Map(lists[k].map((i) => [i, positionHash(houses[i])]));
    byZone.set(z.id, Int32Array.from(lists[k].sort((a, b) => hashes.get(a)! - hashes.get(b)! || a - b)));
  });
  return { houses, byZone };
}

/** Marks parallel to `index.houses` at board.minute: HOUSE_MARK.safe for each zone's share that is out. */
export function safeHouseMarks(index: HouseZones, board: Board): Uint8Array {
  const marks = new Uint8Array(index.houses.length);
  for (const zone of board.zones) {
    const order = index.byZone.get(zone.id);
    if (!order || order.length === 0 || zone.households <= 0) continue;
    // Households driving back after an all clear (demo/allClear.ts) stay marked until they are home.
    const c = zoneCounts(zone, board.minute);
    const out = c.out + c.returning;
    const share = Math.min(1, Math.max(0, out / zone.households));
    const marked = Math.floor(share * order.length + 1e-9);
    for (let k = 0; k < marked; k++) marks[order[k]] = HOUSE_MARK.safe;
  }
  return marks;
}

/** Share of a zone's households that reached safety at board.minute (0..1), for labels. */
export function zoneSafeShare(zone: ZoneState, minute: number): number {
  if (zone.households <= 0) return 0;
  const c = zoneCounts(zone, minute);
  return Math.min(1, Math.max(0, (c.out + c.returning) / zone.households));
}
