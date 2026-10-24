// "People at home": households still at home per km² in each demand zone at a sim time,
// from Census households and modelled departures. Pure module.
import type { AreaGeometry, ReplayModel, Zone } from "./types";

const EARTH_R_M = 6_371_008.8;

function ringAreaM2(ring: readonly [number, number][]): number {
  // Spherical excess approximation (good to well under 1% at block-group scale).
  let sum = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[(i + 1) % ring.length];
    sum +=
      (((lon2 - lon1) * Math.PI) / 180) *
      (2 + Math.sin((lat1 * Math.PI) / 180) + Math.sin((lat2 * Math.PI) / 180));
  }
  return Math.abs((sum * EARTH_R_M * EARTH_R_M) / 2);
}

export function areaKm2(g: AreaGeometry): number {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  let m2 = 0;
  for (const rings of polys) {
    rings.forEach((ring, i) => {
      m2 += (i === 0 ? 1 : -1) * ringAreaM2(ring);
    });
  }
  return m2 / 1e6;
}

export interface ZoneHome {
  /** Households still at home (modelled). */
  home: number;
  /** Households that have left (modelled). */
  left: number;
  /** Households at home per km². */
  density: number;
}

function departedBy(dep: { atMs: number[]; cumVeh: number[] } | undefined, t: number): number {
  if (!dep || dep.atMs.length === 0 || dep.atMs[0] > t) return 0;
  let lo = 0;
  let hi = dep.atMs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (dep.atMs[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return dep.cumVeh[lo];
}

/** One entry per zone (same order as model.zones.items); null where households are unknown. */
export function peopleAtHome(
  model: ReplayModel,
  areas: readonly number[],
  t: number,
): (ZoneHome | null)[] {
  const zones: readonly Zone[] = model.zones?.items ?? [];
  const departures = model.traffic?.zoneDepartures ?? {};
  return zones.map((z, i) => {
    if (z.households == null || !(areas[i] > 0)) return null;
    const share =
      z.vehicles && z.vehicles > 0 ? Math.min(1, departedBy(departures[z.id], t) / z.vehicles) : 0;
    const home = z.households * (1 - share);
    return { home, left: z.households - home, density: home / areas[i] };
  });
}

/** Whether the bundle can drive the layer at all. */
export function hasPeopleLayer(model: ReplayModel): boolean {
  return (model.zones?.items ?? []).some((z) => z.households != null && z.households > 0);
}
