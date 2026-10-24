/**
 * Shared contract for the fictional wildfire evacuation diorama (`/diorama`).
 *
 * Ownership (see docs/adr/0010-evacuation-diorama.md):
 * - `world.ts`, `types.ts`: shared, change only with all three owners in mind.
 * - `scenario/`: deterministic synthetic scenario and simulation state (pure TS, no DOM/three).
 * - `scene/`: three.js rendering of the world and a `SimSnapshot`.
 * - `ui/` + `DioramaPage.tsx`: playback clock, controls, legend, counters, labels.
 *
 * Units and axes: one world unit ≈ one metre. `x` grows east, `z` grows south (three.js
 * convention with `y` up). Ground elevation comes from `heightAt(x, z)` in `world.ts`.
 * Time `t` is scenario seconds in [0, SCENARIO_DURATION_S]; it is a scripted clock for a
 * visual demonstration, not a fire or traffic model. Everything here is synthetic.
 */

export type Vec2 = { x: number; z: number };

export type RoadKind = "main" | "residential" | "fire-road" | "bridge";

export type RoadNode = { id: string; p: Vec2 };

/** An undirected road segment. `points` runs from `from` to `to` and includes both ends. */
export type RoadEdge = {
  id: string;
  from: string;
  to: string;
  kind: RoadKind;
  points: Vec2[];
  /** Speed limit in world units per scenario second. */
  speed: number;
};

export type BuildingKind = "home" | "shelter" | "station";

export type Building = {
  id: string;
  kind: BuildingKind;
  p: Vec2;
  /** Yaw in radians; 0 means the front faces +z (south). */
  rotation: number;
  /** Footprint width (x before rotation), depth (z before rotation) and wall height. */
  w: number;
  d: number;
  h: number;
  /** Roof colour variant index for homes (0..3), purely decorative. */
  variant: number;
};

export type Household = {
  id: string;
  homeId: string;
  residents: number;
  /** Where the household car is parked; on the verge of `edgeId`. */
  parking: Vec2;
  /** Road edge the driveway joins and the fraction along `points` where it joins. */
  edgeId: string;
  edgeT: number;
};

export type TreeKind = "pine" | "round";

export type Tree = { p: Vec2; kind: TreeKind; scale: number };

export type Staging = { id: string; label: string; p: Vec2; /** Point the hose aims at. */ target: Vec2; nodeId: string };

export type World = {
  /** Playable ground extent, centred on the origin. */
  width: number;
  depth: number;
  nodes: RoadNode[];
  edges: RoadEdge[];
  buildings: Building[];
  households: Household[];
  trees: Tree[];
  /** River centreline from north to south and its half width. */
  river: { points: Vec2[]; halfWidth: number };
  bridgeEdgeId: string;
  shelter: { buildingId: string; nodeId: string; label: string; capacity: number };
  station: { buildingId: string; nodeId: string; label: string; engines: number };
  stagings: Staging[];
  ignition: Vec2;
  /** Direction the wind blows toward (unit vector) and a nominal speed label. */
  wind: { toward: Vec2; label: string };
};

export type PhaseId = "ignition" | "spread" | "evacuation" | "congestion" | "response" | "resolution";

export type Phase = { id: PhaseId; label: string; start: number; end: number };

/**
 * Fire field on a regular grid. Cell (col, row) covers
 * x ∈ [originX + col·cellSize, +cellSize), z ∈ [originZ + row·cellSize, +cellSize).
 * `ignitionTime[row * cols + col]` is the scenario second the cell ignites, or `Infinity`
 * if it never burns (water, roads held by crews, town, out of fuel).
 * A cell is burning while `ignition ≤ t < ignition + burnDuration`, burned afterwards.
 */
export type FireField = {
  cols: number;
  rows: number;
  originX: number;
  originZ: number;
  cellSize: number;
  burnDuration: number;
  ignitionTime: Float32Array;
  /** Cells inside the crew-held section, for the scene to tint after `heldFrom`. */
  heldCells: Uint8Array;
  heldFrom: number;
};

export type CellFireState = "unburned" | "burning" | "burned";

export type VehicleKind = "civilian" | "engine";

export type VehicleStatus =
  | "parked"
  | "boarding"
  | "driving"
  | "queued"
  | "sheltered"
  | "at-station"
  | "responding"
  | "staged";

export type VehicleState = {
  id: string;
  kind: VehicleKind;
  p: Vec2;
  /** Heading in radians; 0 means travelling toward +z. Use `Math.atan2(dx, dz)`. */
  heading: number;
  /** Current speed in world units per scenario second. */
  speed: number;
  status: VehicleStatus;
  /** Residents aboard (civilians) or crew size (engines). */
  occupants: number;
  /** False once a sheltered car has parked out of sight; the scene may fade it. */
  visible: boolean;
  householdId?: string;
  stagingId?: string;
};

export type PedestrianState = { id: string; householdId: string; p: Vec2; heading: number };

export type CrewState = {
  engineId: string;
  stagingId: string;
  spraying: boolean;
  /** Hose origin and aim point while spraying. */
  from: Vec2;
  target: Vec2;
};

export type Counters = {
  /** Fixed total; always equals atHome + walking + inVehicles + sheltered. */
  population: number;
  atHome: number;
  walking: number;
  inVehicles: number;
  sheltered: number;
  /** walking + inVehicles (+ atHome residents already ordered to leave). */
  evacuating: number;
  vehiclesQueued: number;
  crewsDeployed: number;
  crewsTotal: number;
  burnedAreaM2: number;
};

export type SimSnapshot = {
  t: number;
  phase: PhaseId;
  /** One short sentence describing the current event. */
  caption: string;
  vehicles: VehicleState[];
  pedestrians: PedestrianState[];
  crews: CrewState[];
  closedEdgeIds: string[];
  /** Households ordered to leave (scene may mark their homes). */
  orderedHouseholdIds: string[];
  /** True while the bridge approach has a queue; the scene shows the bottleneck marker. */
  bottleneckActive: boolean;
  counters: Counters;
};

export type PickTarget =
  | { kind: "vehicle"; id: string }
  | { kind: "shelter" }
  | { kind: "station" }
  | { kind: "bridge" };

export type RecapItem = { label: string; value: string };

/** Built once by `createScenario(world)` in `scenario/`; `sample` is pure and deterministic. */
export type Scenario = {
  duration: number;
  phases: Phase[];
  fire: FireField;
  sample(t: number): SimSnapshot;
  /** Short status text for a clicked object at the given snapshot. */
  describe(target: PickTarget, snapshot: SimSnapshot): { title: string; lines: string[] };
  recap: RecapItem[];
};

export const SCENARIO_DURATION_S = 90;
