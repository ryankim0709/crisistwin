/**
 * Fictional hillside town "Larkspur Hollow" used by the evacuation diorama. Every position,
 * household and count is synthetic and generated deterministically from a fixed seed.
 * Units and axes are documented in `types.ts`.
 */
import type {
  Building,
  Household,
  RoadEdge,
  RoadKind,
  RoadNode,
  Staging,
  Tree,
  Vec2,
  World,
} from "./types";

export const WORLD_SEED = 20261023;

/** Deterministic PRNG (mulberry32) returning floats in [0, 1). */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smoothstep = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);

export function polylineLength(points: Vec2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

/** Point and heading (radians, 0 = +z) at distance `d` along `points`, clamped to the ends. */
export function pointAtDistance(points: Vec2[], d: number): { p: Vec2; heading: number } {
  let remaining = Math.max(0, d);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = dist(a, b);
    if (remaining <= len || i === points.length - 1) {
      const f = len === 0 ? 0 : Math.min(1, remaining / len);
      return {
        p: { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f },
        heading: Math.atan2(b.x - a.x, b.z - a.z),
      };
    }
    remaining -= len;
  }
  return { p: points[0], heading: 0 };
}

function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const f = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
  return Math.hypot(p.x - (a.x + dx * f), p.z - (a.z + dz * f));
}

export function distanceToPolyline(p: Vec2, points: Vec2[]): number {
  let best = Infinity;
  for (let i = 1; i < points.length; i++)
    best = Math.min(best, distanceToSegment(p, points[i - 1], points[i]));
  return best;
}

/** Quadratic curve from `a` to `b`, bowed sideways by `bend` units, sampled into `n` segments. */
function curve(a: Vec2, b: Vec2, bend = 0, n = 10): Vec2[] {
  const mx = (a.x + b.x) / 2;
  const mz = (a.z + b.z) / 2;
  const len = dist(a, b) || 1;
  const cx = mx + (-(b.z - a.z) / len) * bend;
  const cz = mz + ((b.x - a.x) / len) * bend;
  const points: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    points.push({
      x: u * u * a.x + 2 * u * t * cx + t * t * b.x,
      z: u * u * a.z + 2 * u * t * cz + t * t * b.z,
    });
  }
  return points;
}

const RIVER: Vec2[] = [
  { x: 128, z: -230 },
  { x: 112, z: -150 },
  { x: 126, z: -70 },
  { x: 114, z: -5 },
  { x: 113, z: 36 },
  { x: 124, z: 100 },
  { x: 108, z: 165 },
  { x: 120, z: 230 },
];
const RIVER_HALF_WIDTH = 9;

/**
 * Ground elevation (world units). Wooded hills rise to the north, the town sits on a
 * gentle terrace, the river cuts a shallow valley and the east bank is a low meadow.
 */
export function heightAt(x: number, z: number): number {
  const north = smoothstep(-45, -215, z) * 46;
  const southRise = smoothstep(150, 225, z) * 8;
  const westRise = smoothstep(-200, -320, x) * 14;
  const ripple =
    Math.sin(x * 0.021 + z * 0.013) * 2.2 +
    Math.sin(x * 0.047 - z * 0.031 + 1.7) * 1.1 +
    Math.cos(z * 0.035 + x * 0.008) * 1.6;
  // Hills get more relief; the town terrace stays gentle.
  const relief = 0.35 + smoothstep(-40, -150, z) * 1.8;
  let h = 2 + north + southRise + westRise + ripple * relief;
  const riverDist = distanceToPolyline({ x, z }, RIVER);
  const valley = 1 - smoothstep(RIVER_HALF_WIDTH, RIVER_HALF_WIDTH + 34, riverDist);
  h = h * (1 - valley) + -1.5 * valley;
  return h;
}

/** Water surface elevation. */
export const WATER_LEVEL = -0.6;

const nodeList: RoadNode[] = [
  { id: "W", p: { x: -235, z: -6 } },
  { id: "M1", p: { x: -160, z: 0 } },
  { id: "M2", p: { x: -92, z: 8 } },
  { id: "M3", p: { x: -22, z: 12 } },
  { id: "M4", p: { x: 46, z: 24 } },
  { id: "BW", p: { x: 92, z: 33 } },
  { id: "BE", p: { x: 134, z: 38 } },
  { id: "E1", p: { x: 182, z: 52 } },
  { id: "SH", p: { x: 232, z: 60 } },
  { id: "U1", p: { x: -192, z: -56 } },
  { id: "U2", p: { x: -126, z: -68 } },
  { id: "U3", p: { x: -56, z: -62 } },
  { id: "U4", p: { x: 10, z: -42 } },
  { id: "L1", p: { x: -172, z: 74 } },
  { id: "L2", p: { x: -96, z: 84 } },
  { id: "L3", p: { x: -24, z: 80 } },
  { id: "FS", p: { x: -60, z: 128 } },
  { id: "SW", p: { x: -142, z: -112 } },
  { id: "SE", p: { x: -24, z: -104 } },
];
const nodeById = new Map(nodeList.map((n) => [n.id, n]));

const SPEED: Record<RoadKind, number> = { main: 16, residential: 11, "fire-road": 8, bridge: 9 };

function edge(from: string, to: string, kind: RoadKind, bend = 0): RoadEdge {
  const a = nodeById.get(from)!.p;
  const b = nodeById.get(to)!.p;
  const n = Math.max(4, Math.round(dist(a, b) / 8));
  return { id: `${from}-${to}`, from, to, kind, points: curve(a, b, bend, n), speed: SPEED[kind] };
}

const edgeList: RoadEdge[] = [
  edge("W", "M1", "main", 4),
  edge("M1", "M2", "main", -5),
  edge("M2", "M3", "main", 4),
  edge("M3", "M4", "main", -4),
  edge("M4", "BW", "main", 2),
  edge("BW", "BE", "bridge", 0),
  edge("BE", "E1", "main", -3),
  edge("E1", "SH", "main", 3),
  edge("U1", "U2", "residential", -6),
  edge("U2", "U3", "residential", 6),
  edge("U3", "U4", "residential", -5),
  edge("U1", "M1", "residential", 6),
  edge("U2", "M2", "residential", -7),
  edge("U3", "M3", "residential", 7),
  edge("U4", "M4", "residential", -6),
  edge("M1", "L1", "residential", -5),
  edge("M2", "L2", "residential", 6),
  edge("M3", "L3", "residential", -5),
  edge("L1", "L2", "residential", 5),
  edge("L2", "L3", "residential", -4),
  edge("L3", "M4", "residential", 6),
  edge("FS", "L2", "residential", -6),
  edge("FS", "L3", "residential", 5),
  edge("U2", "SW", "fire-road", 9),
  edge("U3", "SE", "fire-road", -10),
];

function generateHomes(rng: () => number): { buildings: Building[]; households: Household[] } {
  const buildings: Building[] = [];
  const households: Household[] = [];
  const footprints: { p: Vec2; r: number }[] = [
    { p: { x: 246, z: 84 }, r: 30 }, // shelter
    { p: { x: -60, z: 146 }, r: 20 }, // station
  ];
  const homeEdges = edgeList.filter((e) => e.kind === "residential" && !e.id.startsWith("FS"));
  for (const e of homeEdges) {
    const len = polylineLength(e.points);
    for (let s = 14; s < len - 12; s += 19 + rng() * 6) {
      for (const side of [-1, 1]) {
        if (rng() < 0.22) continue;
        const { p: onRoad, heading } = pointAtDistance(e.points, s);
        // Perpendicular to the right of travel direction is (-cos h, sin h) for heading h.
        const nx = Math.cos(heading) * side;
        const nz = -Math.sin(heading) * side;
        const setback = 13 + rng() * 3;
        const p = { x: onRoad.x + nx * setback, z: onRoad.z + nz * setback };
        const tooClose =
          footprints.some((f) => dist(f.p, p) < f.r) ||
          edgeList.some((other) => distanceToPolyline(p, other.points) < 9) ||
          distanceToPolyline(p, RIVER) < RIVER_HALF_WIDTH + 14;
        if (tooClose) continue;
        footprints.push({ p, r: 13 });
        const id = `home-${buildings.length + 1}`;
        buildings.push({
          id,
          kind: "home",
          p,
          // Face the road.
          rotation: Math.atan2(-nx, -nz),
          w: 9 + rng() * 3,
          d: 7 + rng() * 2,
          h: 4.5 + rng() * 2,
          variant: Math.floor(rng() * 4),
        });
        const park = 6;
        households.push({
          id: `hh-${households.length + 1}`,
          homeId: id,
          residents: 1 + Math.floor(rng() * 4),
          parking: { x: onRoad.x + nx * park, z: onRoad.z + nz * park },
          edgeId: e.id,
          edgeT: s / len,
        });
      }
    }
  }
  return { buildings, households };
}

function generateTrees(rng: () => number, buildings: Building[]): Tree[] {
  const trees: Tree[] = [];
  const spacing = 8;
  for (let z = -215; z <= 215; z += spacing) {
    for (let x = -315; x <= 315; x += spacing) {
      const p = { x: x + (rng() - 0.5) * spacing * 0.9, z: z + (rng() - 0.5) * spacing * 0.9 };
      const forest = smoothstep(-55, -105, p.z); // dense northern forest
      const fringe = smoothstep(150, 200, p.z) * 0.8 + smoothstep(-230, -300, p.x) * 0.6;
      const eastHill = p.x > 150 && (p.z < -20 || p.z > 120) ? 0.55 : 0;
      const density = Math.max(forest * 0.92, fringe, eastHill, 0.07);
      if (rng() > density) continue;
      if (distanceToPolyline(p, RIVER) < RIVER_HALF_WIDTH + 4) continue;
      if (edgeList.some((e) => distanceToPolyline(p, e.points) < 6.5)) continue;
      if (buildings.some((b) => dist(b.p, p) < Math.max(b.w, b.d) * 0.5 + 5)) continue;
      const pine = forest > 0.4 ? rng() < 0.7 : rng() < 0.3;
      trees.push({ p, kind: pine ? "pine" : "round", scale: 0.75 + rng() * 0.6 });
    }
  }
  return trees;
}

function buildWorld(): World {
  const rng = createRng(WORLD_SEED);
  const { buildings, households } = generateHomes(rng);
  buildings.push(
    {
      id: "shelter",
      kind: "shelter",
      p: { x: 246, z: 86 },
      rotation: Math.PI,
      w: 38,
      d: 24,
      h: 9,
      variant: 0,
    },
    {
      id: "station",
      kind: "station",
      p: { x: -60, z: 146 },
      rotation: Math.PI,
      w: 24,
      d: 16,
      h: 8,
      variant: 0,
    },
  );
  const stagings: Staging[] = [
    {
      id: "east-flank",
      label: "East flank",
      p: { x: -18, z: -110 },
      target: { x: -40, z: -126 },
      nodeId: "SE",
    },
    {
      id: "west-flank",
      label: "West flank",
      p: { x: -136, z: -118 },
      target: { x: -118, z: -136 },
      nodeId: "SW",
    },
    {
      id: "ridge-lane",
      label: "Ridge Lane homes",
      p: { x: -46, z: -70 },
      target: { x: -70, z: -88 },
      nodeId: "U3",
    },
  ];
  return {
    width: 640,
    depth: 440,
    nodes: nodeList,
    edges: edgeList,
    buildings,
    households,
    trees: generateTrees(rng, buildings),
    river: { points: RIVER, halfWidth: RIVER_HALF_WIDTH },
    bridgeEdgeId: "BW-BE",
    shelter: { buildingId: "shelter", nodeId: "SH", label: "Meadow Hall shelter", capacity: 400 },
    station: { buildingId: "station", nodeId: "FS", label: "Station 7", engines: 3 },
    stagings,
    ignition: { x: -84, z: -176 },
    wind: { toward: { x: 0.42, z: 0.91 }, label: "NNW 18 mph" },
  };
}

export const WORLD: World = buildWorld();
