// "People at home": households still at home per km² in each demand zone at a sim time,
// from Census households and modelled departures. Pure module.
import { inArea } from "./insights";
import type { AreaGeometry, LngLat, ReplayModel, Zone } from "./types";

const EARTH_R_M = 6_371_008.8;

function ringAreaM2(ring: readonly [number, number][]): number {
  // Spherical excess approximation (good to well under 1% at block-group scale).
  let sum = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[(i + 1) % ring.length];
    sum += ((lon2 - lon1) * Math.PI) / 180 * (2 + Math.sin((lat1 * Math.PI) / 180) + Math.sin((lat2 * Math.PI) / 180));
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

/** Share of a zone's vehicles that have left by t (0 when vehicles are unknown). */
function departedShare(model: ReplayModel, z: Zone, t: number): number {
  const dep = model.traffic?.zoneDepartures[z.id];
  return z.vehicles && z.vehicles > 0 ? Math.min(1, departedBy(dep, t) / z.vehicles) : 0;
}

/** One entry per zone (same order as model.zones.items); null where households are unknown. */
export function peopleAtHome(model: ReplayModel, areas: readonly number[], t: number): (ZoneHome | null)[] {
  const zones: readonly Zone[] = model.zones?.items ?? [];
  return zones.map((z, i) => {
    if (z.households == null || !(areas[i] > 0)) return null;
    const share = departedShare(model, z, t);
    const home = z.households * (1 - share);
    return { home, left: z.households - home, density: home / areas[i] };
  });
}

/** Whether the bundle can drive the layer at all. */
export function hasPeopleLayer(model: ReplayModel): boolean {
  return (model.zones?.items ?? []).some((z) => z.households != null && z.households > 0);
}

/**
 * Home dots: one dot per `perDot` Census households, placed at seeded random points along the
 * residential streets of its block group (anywhere in the block group when it has none). A
 * picture of density, not of home locations. Each dot has a random departure rank within its
 * zone; it is gone once the zone's modelled departed share passes that rank.
 */
export interface HomeDot {
  zone: number;
  coord: LngLat;
  /** In (0, 1): the dot leaves when the zone's departed share exceeds it. */
  rank: number;
}

export interface HomeDots {
  dots: HomeDot[];
  /** Households each dot stands for. */
  perDot: number;
}

/** Upper bound on dots for the whole bundle; households per dot rounds up to a nice step. */
const MAX_DOTS = 4000;
const PER_DOT_STEPS = [1, 2, 5, 10, 20, 25, 50, 100];
/** Streets that count as where homes are; arterials and highways are left out. */
const ARTERIALS = new Set(["motorway", "motorway_link", "trunk", "trunk_link", "primary", "secondary"]);
/** Dots sit beside the street, not on it: perpendicular offset in metres. */
const SETBACK_M = [12, 35];
const M_PER_DEG = 111_320;
const SEED = 20181108;

/** mulberry32: small seeded PRNG so the dot layout is the same on every load. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bboxOf(g: AreaGeometry): [number, number, number, number] {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  const rings = g.type === "Polygon" ? [g.coordinates[0]] : g.coordinates.map((p) => p[0]);
  for (const ring of rings) {
    for (const [x, y] of ring) {
      w = Math.min(w, x);
      s = Math.min(s, y);
      e = Math.max(e, x);
      n = Math.max(n, y);
    }
  }
  return [w, s, e, n];
}

interface Segment {
  a: LngLat;
  b: LngLat;
  mid: LngLat;
  len: number;
}

interface Streets {
  segs: Segment[];
  /** Cumulative length (m) up to and including each segment. */
  cum: number[];
}

/** Residential street segments, once per bundle. */
function streetSegments(model: ReplayModel): Segment[] {
  const out: Segment[] = [];
  for (const edge of model.roads?.items ?? []) {
    if (edge.highway !== null && ARTERIALS.has(edge.highway)) continue;
    for (let i = 1; i < edge.coords.length; i += 1) {
      const a = edge.coords[i - 1];
      const b = edge.coords[i];
      const mid: LngLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const kx = Math.cos((mid[1] * Math.PI) / 180);
      const len = Math.hypot((b[0] - a[0]) * kx, b[1] - a[1]) * M_PER_DEG;
      if (len > 0) out.push({ a, b, mid, len });
    }
  }
  return out;
}

/**
 * Street segments whose midpoint is in the zone's bounding box. Only a cheap box test here:
 * samples are drawn by length and then rejected unless inside the zone, which is the same
 * distribution as pre-filtering every segment with the (expensive) polygon test.
 */
function boxStreets(all: Segment[], box: [number, number, number, number]): Streets {
  const segs: Segment[] = [];
  const cum: number[] = [];
  let total = 0;
  for (const seg of all) {
    const [x, y] = seg.mid;
    if (x < box[0] || x > box[2] || y < box[1] || y > box[3]) continue;
    total += seg.len;
    segs.push(seg);
    cum.push(total);
  }
  return { segs, cum };
}

/** A street-side point inside the zone, or null when the zone's streets are not found. */
function onStreet(
  g: AreaGeometry,
  { segs, cum }: Streets,
  random: () => number,
): LngLat | null {
  if (segs.length === 0) return null;
  for (let tries = 0; tries < 40; tries += 1) {
    const target = random() * cum[cum.length - 1];
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cum[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    if (inArea(g, segs[lo].mid)) return beside(segs[lo], random);
  }
  return null;
}

function beside({ a, b }: Segment, random: () => number): LngLat {
  const f = random();
  const x = a[0] + (b[0] - a[0]) * f;
  const y = a[1] + (b[1] - a[1]) * f;
  // Step off the street, either side, perpendicular to it.
  const kx = Math.cos((y * Math.PI) / 180);
  const dx = (b[0] - a[0]) * kx;
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const off = (SETBACK_M[0] + random() * (SETBACK_M[1] - SETBACK_M[0])) * (random() < 0.5 ? -1 : 1);
  return [x + ((-dy / len) * off) / (M_PER_DEG * kx), y + ((dx / len) * off) / M_PER_DEG];
}

function inZone(g: AreaGeometry, box: [number, number, number, number], random: () => number): LngLat | null {
  for (let tries = 0; tries < 50; tries += 1) {
    const p: LngLat = [box[0] + random() * (box[2] - box[0]), box[1] + random() * (box[3] - box[1])];
    if (inArea(g, p)) return p;
  }
  return null;
}

export function homeDots(model: ReplayModel): HomeDots {
  const zones: readonly Zone[] = model.zones?.items ?? [];
  const total = zones.reduce((sum, z) => sum + (z.households ?? 0), 0);
  const perDot = PER_DOT_STEPS.find((step) => total / step <= MAX_DOTS) ?? Math.ceil(total / MAX_DOTS);
  const random = rng(SEED);
  const streetsAll = streetSegments(model);
  const dots: HomeDot[] = [];
  zones.forEach((z, zone) => {
    const n = Math.round((z.households ?? 0) / perDot);
    if (n <= 0) return;
    const box = bboxOf(z.geometry);
    const streets = boxStreets(streetsAll, box);
    // Departure ranks: an even spread over (0, 1), shuffled so leaving looks scattered.
    const ranks = Array.from({ length: n }, (_, i) => (i + 0.5) / n);
    for (let i = n - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [ranks[i], ranks[j]] = [ranks[j], ranks[i]];
    }
    for (let i = 0; i < n; i += 1) {
      const coord = onStreet(z.geometry, streets, random) ?? inZone(z.geometry, box, random);
      if (coord) dots.push({ zone, coord, rank: ranks[i] });
    }
  });
  return { dots, perDot };
}

/** Departed share per zone at t (same order as model.zones.items). */
export function departedShares(model: ReplayModel, t: number): number[] {
  return (model.zones?.items ?? []).map((z) => departedShare(model, z, t));
}
