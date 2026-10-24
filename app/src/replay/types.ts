// Normalized, validated view of a replay bundle (docs/replay-bundle.md, schema 1.x).
// Times are parsed once at the boundary into epoch milliseconds (`*Ms`); coordinates stay
// [longitude, latitude] in OGC:CRS84.

export const EVIDENCE_CLASSES = [
  "observed",
  "reported",
  "reconstructed",
  "derived",
  "simulated",
  "fixture",
] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

export type LayerStatusValue = "present" | "fixture" | "missing";

export interface LayerStatus {
  status: LayerStatusValue;
  /** "mixed" when a layer's items carry more than one evidence class (e.g. events). */
  evidenceClass: EvidenceClass | "mixed" | null;
  reason: string | null;
}

export type LngLat = [number, number];

export type AreaGeometry =
  | { type: "Polygon"; coordinates: LngLat[][] }
  | { type: "MultiPolygon"; coordinates: LngLat[][][] };

export interface Perimeter {
  snapshotIndex: number;
  atMs: number;
  areaKm2: number | null;
  evidenceClass: EvidenceClass;
  timePrecision: string | null;
  geometry: AreaGeometry;
}

export interface RoadEdge {
  id: string;
  segmentId: string | null;
  name: string | null;
  highway: string | null;
  lanes: number | null;
  speedKph: number;
  lengthM: number;
  bridge: boolean;
  coords: LngLat[];
}

export interface Zone {
  id: string;
  name: string;
  households: number | null;
  vehicles: number | null;
  geometry: AreaGeometry;
}

export interface Destination {
  id: string;
  name: string;
  /** "exit", "shelter" or "temporary_refuge". */
  kind: string;
  /** Per-feature class; the layer's own class when the layer is not "mixed". */
  evidenceClass: EvidenceClass;
  coord: LngLat;
  capacityVeh: number | null;
}

export interface ReplayEvent {
  id: string;
  atMs: number;
  type: string;
  label: string;
  evidenceClass: EvidenceClass;
  timePrecision: string | null;
  zoneIds: string[];
  edgeIds: string[];
  destinationId: string | null;
  sourceId: string | null;
}

/** [edge_index, vehicles_on_edge, mean_speed_kph] */
export type FrameEdge = [number, number, number];

export interface TrafficFrame {
  atMs: number;
  edges: FrameEdge[];
}

/** [edge_index, first_closed_frame, reopened_frame | null]; closed while first <= k < reopened. */
export type ClosureInterval = [number, number, number | null];

export interface TrafficMetrics {
  atMs: number;
  notDepartedVeh: number;
  enRouteVeh: number;
  arrivedVeh: number;
  blockedVeh: number;
  exposedVeh: number;
}

export interface Traffic {
  evidenceClass: EvidenceClass;
  modelId: string | null;
  modelVersion: string | null;
  seed: number | null;
  edgeIds: string[];
  frames: TrafficFrame[];
  closures: ClosureInterval[];
  metrics: TrafficMetrics[];
  /** Additional numeric metric fields by name (e.g. resident states), aligned to frames. */
  extraMetrics: Record<string, (number | null)[]>;
  totalVeh: number | null;
  clearanceTimeS: number | null;
  maxExposedVeh: number | null;
}

export interface DamagePoint {
  coord: LngLat;
  damage: string | null;
  structureCategory: string | null;
}

export interface SimulatedFront {
  atMs: number;
  areaKm2: number | null;
  geometry: AreaGeometry;
}

/** Arrival grid; col = floor((lon-originLon)*mPerDegLon/cellM), row likewise, row 0 south. */
export interface ArrivalGrid {
  originLon: number;
  originLat: number;
  cellM: number;
  ncols: number;
  nrows: number;
  mPerDegLon: number;
  mPerDegLat: number;
  t0Ms: number;
  /** Row-major minutes after t0; null = not reached in the run. */
  minutes: (number | null)[];
}

/** Optional model run from an assumed ignition; never evidence. */
export interface SimulatedFire {
  evidenceClass: EvidenceClass;
  modelId: string | null;
  modelVersion: string | null;
  ignition: { coord: LngLat; atMs: number; provenance: string | null } | null;
  calibrationIou: number | null;
  /** One-line calibration summary (rothermel-mtt), e.g. held-out median arrival error. */
  calibrationHeadline: string | null;
  /** How the model front was constrained (e.g. clipped to the first satellite perimeter). */
  constraintNote: string | null;
  /** Held-out arrival error at NIST observations, when the bundle has it. */
  heldOut: { n: number | null; medianAbsErrorMin: number | null } | null;
  fronts: SimulatedFront[];
  arrivalGrid: ArrivalGrid | null;
  windFromDeg: number | null;
  assumptions: string[];
}

export interface InsightHeadline {
  label: string;
  value: number | null;
  unit: string | null;
  atMs: number | null;
}

export interface ZoneInsight {
  zoneId: string;
  orderAtMs: number | null;
  fireArrivalAtMs: number | null;
  /** fire arrival - order; negative = fire first; null if either is missing. */
  leadTimeS: number | null;
  vehicles: number | null;
  departedByFireVeh: number | null;
  arrivedByFireVeh: number | null;
  riskLevel: string;
  riskRule: string | null;
}

export interface Bottleneck {
  edgeId: string;
  name: string | null;
  peakVeh: number | null;
  peakAtMs: number | null;
  minSpeedKph: number | null;
  minutesCongested: number | null;
}

export interface DestinationLoad {
  destinationId: string;
  arrivedVeh: number | null;
  capacityVeh: number | null;
  fullAtMs: number | null;
}

/** Optional planning insights computed from model output only. */
export interface Insights {
  evidenceClass: EvidenceClass;
  disclaimer: string;
  headline: InsightHeadline[];
  zones: ZoneInsight[];
  /** Aligned to traffic.edge_ids; seconds after clock.start; null = not reached. */
  edgeFireArrivalS: (number | null)[];
  bottlenecks: Bottleneck[];
  destinations: DestinationLoad[];
}

export interface ResponderAction {
  label: string;
  localTime: string | null;
  road: string | null;
  kind: string | null;
}

export interface ResponderMatch {
  /** simulated - historical, minutes; negative = the simulated action came first. */
  deltaMin: number | null;
  text: string | null;
  simulated: ResponderAction;
  historical: ResponderAction & { evidenceClass: EvidenceClass | null; locator: string | null };
}

/** Agent simulations only: responder agents compared with recorded 2018 actions. */
export interface RespondersComparison {
  evidenceClass: EvidenceClass;
  rule: string | null;
  matches: ResponderMatch[];
  simulatedOnly: (ResponderAction & { reason: string | null })[];
  historicalOnly: (ResponderAction & { reason: string | null })[];
}

export interface Layer<T> {
  /** "mixed" only when every item carries its own evidence class. */
  evidenceClass: EvidenceClass | "mixed";
  items: T[];
}

/** A NIST fire observation point: fire was seen here during [fromMs, toMs]. Not a first arrival. */
export interface FireObservation {
  id: string;
  coord: LngLat;
  atMs: number;
  fromMs: number | null;
  toMs: number | null;
  timePrecision: string | null;
  residual: boolean;
  locationSource: string | null;
  sourceLocator: string | null;
}

export interface FireObservations {
  evidenceClass: EvidenceClass;
  sourceLabel: string | null;
  sourceUrl: string | null;
  items: FireObservation[];
  notes: string[];
}

/** Derived demand summary (Census block groups); only the totals the UI shows. */
export interface DemandSummary {
  evidenceClass: EvidenceClass;
  population: number | null;
  households: number | null;
  householdsNoVehicle: number | null;
  population65Plus: number | null;
  evacuatingVehicles: number | null;
  evacuatingVehiclesMoe: number | null;
  blockGroups: number | null;
}

/** One "model vs published 2018" comparison row. */
export interface ValidationRow {
  targetId: string;
  metric: string;
  location: string | null;
  /** Published value as given (a local time "hh:mm", a count, ...). */
  published: string | number | null;
  unit: string | null;
  /** Model side as flat label/value pairs, for display only. */
  model: { key: string; value: string | number }[];
  /** e.g. "partial", "weak", "tuned", "not_computed". */
  comparability: string;
  evidenceClass: EvidenceClass | null;
  caveat: string | null;
  sourceLocator: string | null;
}

export interface Validation {
  evidenceClass: EvidenceClass;
  grades: Record<string, string>;
  rows: ValidationRow[];
}

export interface ReplayModel {
  schemaVersion: string;
  incident: {
    id: string;
    name: string;
    packageVersion: string | null;
    timezone: string;
    /** Optional "Town, ST" the bundle names; used to label the distance reference. */
    place: string | null;
    /** Optional named point the bundle provides for "fire N km from X". */
    referencePoint: { name: string; coord: LngLat } | null;
  };
  mode: string;
  clock: { startMs: number; endMs: number; stepSeconds: number };
  bbox: [number, number, number, number];
  layerStatus: Record<string, LayerStatus>;
  assumptions: string[];
  limitations: string[];
  perimeters: Perimeter[];
  fireSimulated: SimulatedFire | null;
  insights: Insights | null;
  responders: RespondersComparison | null;
  roads: Layer<RoadEdge> | null;
  zones: Layer<Zone> | null;
  destinations: Layer<Destination> | null;
  events: ReplayEvent[];
  traffic: Traffic | null;
  damage: Layer<DamagePoint> | null;
  fireObservations: FireObservations | null;
  demand: DemandSummary | null;
  validation: Validation | null;
}
