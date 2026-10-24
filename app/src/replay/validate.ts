import {
  EVIDENCE_CLASSES,
  type AreaGeometry,
  type ArrivalGrid,
  type ClosureInterval,
  type DamagePoint,
  type DemandSummary,
  type Destination,
  type EvidenceClass,
  type FireObservations,
  type FrameEdge,
  type Insights,
  type Layer,
  type LayerStatus,
  type LngLat,
  type Perimeter,
  type ReplayEvent,
  type ReplayModel,
  type ResponderAction,
  type ResponderMatch,
  type RespondersComparison,
  type RoadEdge,
  type SimulatedFire,
  type Traffic,
  type TrafficFrame,
  type TrafficMetrics,
  type Validation,
  type ValidationRow,
  type Zone,
} from "./types";

export const BUNDLE_KIND = "crisistwin_replay_bundle";
export const SUPPORTED_SCHEMA_MAJOR = "1.";

export class BundleError extends Error {
  constructor(path: string, problem: string) {
    super(`Invalid replay bundle at ${path}: ${problem}.`);
    this.name = "BundleError";
  }
}

export type Obj = Record<string, unknown>;

export function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function obj(value: unknown, path: string): Obj {
  if (!isObj(value)) throw new BundleError(path, "expected an object");
  return value;
}

export function objOrEmpty(value: unknown): Obj {
  return isObj(value) ? value : {};
}

export function arr(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new BundleError(path, "expected an array");
  return value;
}

export function str(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BundleError(path, "expected a non-empty string");
  }
  return value;
}

export function optStr(value: unknown, path: string): string | null {
  return value === null || value === undefined ? null : str(value, path);
}

export function num(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BundleError(path, "expected a finite number");
  }
  return value;
}

function nonNeg(value: unknown, path: string): number {
  const n = num(value, path);
  if (n < 0) throw new BundleError(path, "expected a nonnegative number");
  return n;
}

export function optNum(value: unknown, path: string): number | null {
  return value === null || value === undefined ? null : num(value, path);
}

export function strList(value: unknown, path: string): string[] {
  if (value === null || value === undefined) return [];
  return arr(value, path).map((item, i) => str(item, `${path}[${i}]`));
}

// Times must be UTC ISO 8601 with a trailing Z, per the contract.
export function utcMs(value: unknown, path: string): number {
  const text = str(value, path);
  const ms = Date.parse(text);
  if (!text.endsWith("Z") || Number.isNaN(ms)) {
    throw new BundleError(path, `expected a UTC ISO 8601 time ending in Z, got "${text}"`);
  }
  return ms;
}

export function evidence(value: unknown, path: string): EvidenceClass {
  if (typeof value !== "string" || !(EVIDENCE_CLASSES as readonly string[]).includes(value)) {
    throw new BundleError(path, `expected one of ${EVIDENCE_CLASSES.join(", ")}`);
  }
  return value as EvidenceClass;
}

function lngLat(value: unknown, path: string): LngLat {
  const pair = arr(value, path);
  if (pair.length < 2) throw new BundleError(path, "expected [longitude, latitude]");
  const lng = num(pair[0], `${path}[0]`);
  const lat = num(pair[1], `${path}[1]`);
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
    throw new BundleError(path, "coordinate out of CRS84 range");
  }
  return [lng, lat];
}

function ring(value: unknown, path: string): LngLat[] {
  return arr(value, path).map((p, i) => lngLat(p, `${path}[${i}]`));
}

function areaGeometry(value: unknown, path: string): AreaGeometry {
  const g = obj(value, path);
  if (g.type === "Polygon") {
    return {
      type: "Polygon",
      coordinates: arr(g.coordinates, `${path}.coordinates`).map((r, i) =>
        ring(r, `${path}.coordinates[${i}]`),
      ),
    };
  }
  if (g.type === "MultiPolygon") {
    return {
      type: "MultiPolygon",
      coordinates: arr(g.coordinates, `${path}.coordinates`).map((poly, i) =>
        arr(poly, `${path}.coordinates[${i}]`).map((r, j) =>
          ring(r, `${path}.coordinates[${i}][${j}]`),
        ),
      ),
    };
  }
  throw new BundleError(`${path}.type`, "expected Polygon or MultiPolygon");
}

export function ascending<T extends { atMs: number }>(items: T[], path: string): T[] {
  for (let i = 1; i < items.length; i += 1) {
    if (items[i].atMs < items[i - 1].atMs) {
      throw new BundleError(`${path}[${i}].at`, "items must be ascending by time");
    }
  }
  return items;
}

function layerStatus(value: unknown, path: string): LayerStatus {
  const s = obj(value, path);
  const status = s.status;
  if (status !== "present" && status !== "fixture" && status !== "missing") {
    throw new BundleError(`${path}.status`, "expected present, fixture or missing");
  }
  return {
    status,
    evidenceClass:
      s.evidence_class == null
        ? null
        : s.evidence_class === "mixed"
          ? "mixed"
          : evidence(s.evidence_class, `${path}.evidence_class`),
    reason: optStr(s.reason, `${path}.reason`),
  };
}

/**
 * The layer object itself may be absent, or present with `status: "missing"`; both mean
 * there is nothing to draw. `layer_status` is checked by the caller.
 */
function layerBody(bundle: Obj, name: string, statuses: Record<string, LayerStatus>): Obj | null {
  const raw = bundle[name];
  if (raw === undefined || raw === null) return null;
  const body = obj(raw, name);
  if (body.status === "missing" || statuses[name]?.status === "missing") return null;
  return body;
}

function perimeter(value: unknown, path: string): Perimeter {
  const p = obj(value, path);
  return {
    snapshotIndex: num(p.snapshot_index, `${path}.snapshot_index`),
    atMs: utcMs(p.at, `${path}.at`),
    areaKm2: optNum(p.area_km2, `${path}.area_km2`),
    evidenceClass: evidence(p.evidence_class, `${path}.evidence_class`),
    timePrecision: optStr(p.time_precision, `${path}.time_precision`),
    geometry: areaGeometry(p.geometry, `${path}.geometry`),
  };
}

function roadEdge(value: unknown, path: string): RoadEdge {
  const e = obj(value, path);
  const coords = ring(e.coords, `${path}.coords`);
  if (coords.length < 2) throw new BundleError(`${path}.coords`, "an edge needs at least 2 points");
  return {
    id: str(e.id, `${path}.id`),
    segmentId: optStr(e.segment_id, `${path}.segment_id`),
    name: optStr(e.name, `${path}.name`),
    highway: optStr(e.highway, `${path}.highway`),
    lanes: optNum(e.lanes, `${path}.lanes`),
    speedKph: nonNeg(e.speed_kph, `${path}.speed_kph`),
    lengthM: nonNeg(e.length_m, `${path}.length_m`),
    bridge: e.bridge === true,
    coords,
  };
}

function zone(value: unknown, path: string): Zone {
  const z = obj(value, path);
  return {
    id: str(z.id, `${path}.id`),
    name: str(z.name, `${path}.name`),
    households: optNum(z.households, `${path}.households`),
    vehicles: optNum(z.vehicles, `${path}.vehicles`),
    geometry: areaGeometry(z.geometry, `${path}.geometry`),
  };
}

function destination(value: unknown, path: string, layerClass: EvidenceClass | "mixed"): Destination {
  const d = obj(value, path);
  return {
    id: str(d.id, `${path}.id`),
    name: str(d.name, `${path}.name`),
    kind: str(d.kind, `${path}.kind`),
    evidenceClass: featureClass(d, path, layerClass),
    coord: lngLat(d.coord, `${path}.coord`),
    capacityVeh: optNum(d.capacity_veh, `${path}.capacity_veh`),
  };
}

export function replayEvent(value: unknown, path: string): ReplayEvent {
  const e = obj(value, path);
  const target = objOrEmpty(e.target);
  const source = objOrEmpty(e.source);
  return {
    id: str(e.id, `${path}.id`),
    atMs: utcMs(e.at, `${path}.at`),
    type: str(e.type, `${path}.type`),
    label: str(e.label, `${path}.label`),
    evidenceClass: evidence(e.evidence_class, `${path}.evidence_class`),
    timePrecision: optStr(e.time_precision, `${path}.time_precision`),
    zoneIds: strList(target.zone_ids, `${path}.target.zone_ids`),
    edgeIds: strList(target.edge_ids, `${path}.target.edge_ids`),
    destinationId: optStr(target.destination_id, `${path}.target.destination_id`),
    sourceId: optStr(source.id, `${path}.source.id`),
  };
}

function boundedIndex(value: unknown, path: string, count: number, what: string): number {
  const i = num(value, path);
  if (!Number.isInteger(i) || i < 0 || i >= count) throw new BundleError(path, `${what} out of range`);
  return i;
}

function frame(value: unknown, path: string, edgeCount: number): TrafficFrame {
  const f = obj(value, path);
  const edges = arr(f.edges ?? [], `${path}.edges`).map((t, i): FrameEdge => {
    const p = `${path}.edges[${i}]`;
    const tuple = arr(t, p);
    return [
      boundedIndex(tuple[0], `${p}[0]`, edgeCount, "edge index"),
      nonNeg(tuple[1], `${p}[1]`),
      nonNeg(tuple[2], `${p}[2]`),
    ];
  });
  return { atMs: utcMs(f.at, `${path}.at`), edges };
}

function closure(value: unknown, path: string, edgeCount: number, frameCount: number): ClosureInterval {
  const tuple = arr(value, path);
  const first = boundedIndex(tuple[1], `${path}[1]`, frameCount, "frame index");
  const reopened = tuple[2] == null ? null : num(tuple[2], `${path}[2]`);
  if (reopened !== null && reopened <= first) {
    throw new BundleError(`${path}[2]`, "reopened_frame must be after first_closed_frame");
  }
  return [boundedIndex(tuple[0], `${path}[0]`, edgeCount, "edge index"), first, reopened];
}

function metrics(value: unknown, path: string): TrafficMetrics {
  const m = obj(value, path);
  return {
    atMs: utcMs(m.at, `${path}.at`),
    notDepartedVeh: nonNeg(m.not_departed_veh, `${path}.not_departed_veh`),
    enRouteVeh: nonNeg(m.en_route_veh, `${path}.en_route_veh`),
    arrivedVeh: nonNeg(m.arrived_veh, `${path}.arrived_veh`),
    blockedVeh: nonNeg(m.blocked_veh, `${path}.blocked_veh`),
    exposedVeh: nonNeg(m.exposed_veh, `${path}.exposed_veh`),
  };
}

const KNOWN_METRIC_KEYS = new Set([
  "at",
  "not_departed_veh",
  "en_route_veh",
  "arrived_veh",
  "blocked_veh",
  "exposed_veh",
]);

export function traffic(body: Obj): Traffic {
  const edgeIds = strList(body.edge_ids, "traffic.edge_ids");
  const frames = ascending(
    arr(body.frames, "traffic.frames").map((f, i) => frame(f, `traffic.frames[${i}]`, edgeIds.length)),
    "traffic.frames",
  );
  const closures = arr(body.closures ?? [], "traffic.closures").map((c, i) =>
    closure(c, `traffic.closures[${i}]`, edgeIds.length, frames.length),
  );
  const metricRows = arr(body.metrics, "traffic.metrics").map((m, i) =>
    metrics(m, `traffic.metrics[${i}]`),
  );
  if (metricRows.length !== frames.length) {
    throw new BundleError("traffic.metrics", "expected one metrics row per frame");
  }
  // Extra numeric metric fields (e.g. resident states in agent simulations), kept by name.
  const extraMetrics: Record<string, (number | null)[]> = {};
  const rawRows = arr(body.metrics, "traffic.metrics");
  rawRows.forEach((raw, i) => {
    for (const [key, value] of Object.entries(objOrEmpty(raw))) {
      if (KNOWN_METRIC_KEYS.has(key)) continue;
      if (typeof value !== "number" && value !== null) continue;
      (extraMetrics[key] ??= new Array<number | null>(rawRows.length).fill(null))[i] =
        typeof value === "number" && Number.isFinite(value) ? value : null;
    }
  });
  const model = objOrEmpty(body.model);
  const summary = objOrEmpty(body.summary);
  return {
    evidenceClass: evidence(body.evidence_class, "traffic.evidence_class"),
    modelId: optStr(model.id, "traffic.model.id"),
    modelVersion: optStr(model.version, "traffic.model.version"),
    seed: optNum(model.seed, "traffic.model.seed"),
    edgeIds,
    frames,
    closures,
    metrics: metricRows,
    extraMetrics,
    totalVeh: optNum(summary.total_veh, "traffic.summary.total_veh"),
    clearanceTimeS: optNum(summary.clearance_time_s, "traffic.summary.clearance_time_s"),
    maxExposedVeh: optNum(summary.max_exposed_veh, "traffic.summary.max_exposed_veh"),
  };
}

export function simulatedFire(body: Obj): SimulatedFire {
  const model = objOrEmpty(body.model);
  const calibration = objOrEmpty(body.calibration);
  const raw = body.ignition;
  const ignition: SimulatedFire["ignition"] = isObj(raw)
    ? {
        coord: lngLat(raw.coord, "fire_simulated.ignition.coord"),
        atMs: utcMs(raw.at, "fire_simulated.ignition.at"),
        provenance: optStr(raw.provenance, "fire_simulated.ignition.provenance"),
      }
    : null;
  return {
    evidenceClass: evidence(body.evidence_class, "fire_simulated.evidence_class"),
    modelId: optStr(model.id, "fire_simulated.model.id"),
    modelVersion: optStr(model.version, "fire_simulated.model.version"),
    ignition,
    calibrationIou: optNum(
      objOrEmpty(calibration.perimeter).iou ?? calibration.iou,
      "fire_simulated.calibration.iou",
    ),
    calibrationHeadline: typeof calibration.headline === "string" ? calibration.headline : null,
    constraintNote:
      typeof objOrEmpty(body.constraint).note === "string" ? (objOrEmpty(body.constraint).note as string) : null,
    heldOut: isObj(objOrEmpty(calibration.observations).held_out)
      ? (() => {
          const h = objOrEmpty(objOrEmpty(calibration.observations).held_out);
          return {
            n: typeof h.n === "number" ? h.n : null,
            medianAbsErrorMin: typeof h.median_abs_error_min === "number" ? h.median_abs_error_min : null,
          };
        })()
      : null,
    fronts: ascending(
      arr(body.fronts ?? [], "fire_simulated.fronts").map((f, i) => {
        const path = `fire_simulated.fronts[${i}]`;
        const front = obj(f, path);
        return {
          atMs: utcMs(front.at, `${path}.at`),
          areaKm2: optNum(front.area_km2, `${path}.area_km2`),
          geometry: areaGeometry(front.geometry, `${path}.geometry`),
        };
      }),
      "fire_simulated.fronts",
    ),
    arrivalGrid: body.arrival_grid == null ? null : arrivalGrid(obj(body.arrival_grid, "fire_simulated.arrival_grid")),
    windFromDeg: optNum(objOrEmpty(model.params).wind_from_deg, "fire_simulated.model.params.wind_from_deg"),
    assumptions: strList(body.assumptions, "fire_simulated.assumptions"),
  };
}

function arrivalGrid(g: Obj): ArrivalGrid {
  const p = "fire_simulated.arrival_grid";
  const ncols = num(g.ncols, `${p}.ncols`);
  const nrows = num(g.nrows, `${p}.nrows`);
  const minutes = arr(g.minutes, `${p}.minutes`);
  if (minutes.length !== ncols * nrows) throw new BundleError(`${p}.minutes`, "expected ncols * nrows cells");
  return {
    originLon: num(g.origin_lon, `${p}.origin_lon`),
    originLat: num(g.origin_lat, `${p}.origin_lat`),
    cellM: num(g.cell_m, `${p}.cell_m`),
    ncols,
    nrows,
    mPerDegLon: num(g.m_per_deg_lon, `${p}.m_per_deg_lon`),
    mPerDegLat: num(g.m_per_deg_lat, `${p}.m_per_deg_lat`),
    t0Ms: utcMs(g.t0, `${p}.t0`),
    // Checked lazily per lookup: values are numbers or null.
    minutes: minutes as (number | null)[],
  };
}

function optUtcMs(value: unknown, path: string): number | null {
  return value == null ? null : utcMs(value, path);
}

export function insights(body: Obj): Insights {
  return {
    evidenceClass: evidence(body.evidence_class, "insights.evidence_class"),
    disclaimer: str(body.disclaimer, "insights.disclaimer"),
    headline: arr(body.headline ?? [], "insights.headline").map((h, i) => {
      const path = `insights.headline[${i}]`;
      const item = obj(h, path);
      return {
        label: str(item.label, `${path}.label`),
        value: optNum(item.value, `${path}.value`),
        unit: optStr(item.unit, `${path}.unit`),
        atMs: item.at == null ? null : utcMs(item.at, `${path}.at`),
      };
    }),
    zones: arr(body.zones ?? [], "insights.zones").map((z, i) => {
      const path = `insights.zones[${i}]`;
      const item = obj(z, path);
      return {
        zoneId: str(item.zone_id, `${path}.zone_id`),
        orderAtMs: optUtcMs(item.order_at, `${path}.order_at`),
        fireArrivalAtMs: optUtcMs(item.fire_arrival_at, `${path}.fire_arrival_at`),
        leadTimeS: optNum(item.lead_time_s, `${path}.lead_time_s`),
        vehicles: optNum(item.vehicles, `${path}.vehicles`),
        departedByFireVeh: optNum(item.departed_by_fire_veh, `${path}.departed_by_fire_veh`),
        arrivedByFireVeh: optNum(item.arrived_by_fire_veh, `${path}.arrived_by_fire_veh`),
        riskLevel: str(item.risk_level, `${path}.risk_level`),
        riskRule: optStr(item.risk_rule, `${path}.risk_rule`),
      };
    }),
    edgeFireArrivalS: arr(body.edge_fire_arrival_s ?? [], "insights.edge_fire_arrival_s").map((v, i) =>
      optNum(v, `insights.edge_fire_arrival_s[${i}]`),
    ),
    bottlenecks: arr(body.bottlenecks ?? [], "insights.bottlenecks").map((b, i) => {
      const path = `insights.bottlenecks[${i}]`;
      const item = obj(b, path);
      return {
        edgeId: str(item.edge_id, `${path}.edge_id`),
        name: optStr(item.name, `${path}.name`),
        peakVeh: optNum(item.peak_veh, `${path}.peak_veh`),
        peakAtMs: optUtcMs(item.peak_at, `${path}.peak_at`),
        minSpeedKph: optNum(item.min_speed_kph, `${path}.min_speed_kph`),
        minutesCongested: optNum(item.minutes_congested, `${path}.minutes_congested`),
      };
    }),
    destinations: arr(body.destinations ?? [], "insights.destinations").map((d, i) => {
      const path = `insights.destinations[${i}]`;
      const item = obj(d, path);
      return {
        destinationId: str(item.destination_id, `${path}.destination_id`),
        arrivedVeh: optNum(item.arrived_veh, `${path}.arrived_veh`),
        capacityVeh: optNum(item.capacity_veh, `${path}.capacity_veh`),
        fullAtMs: optUtcMs(item.full_at, `${path}.full_at`),
      };
    }),
  };
}

function damagePoint(value: unknown, path: string): DamagePoint {
  const f = obj(value, path);
  const geometry = obj(f.geometry, `${path}.geometry`);
  if (geometry.type !== "Point") throw new BundleError(`${path}.geometry.type`, "expected Point");
  const props = objOrEmpty(f.properties);
  return {
    coord: lngLat(geometry.coordinates, `${path}.geometry.coordinates`),
    damage: typeof props.damage === "string" ? props.damage : null,
    structureCategory: typeof props.structure_category === "string" ? props.structure_category : null,
  };
}

/**
 * A feature's own evidence class. Required (and checked) when the layer is "mixed";
 * otherwise an optional per-feature class must still be valid, and defaults to the layer's.
 */
function featureClass(item: Obj, path: string, layerClass: EvidenceClass | "mixed"): EvidenceClass {
  if (item.evidence_class == null) {
    if (layerClass === "mixed") {
      throw new BundleError(`${path}.evidence_class`, "required on every feature of a mixed layer");
    }
    return layerClass;
  }
  return evidence(item.evidence_class, `${path}.evidence_class`);
}

function layer<T>(
  body: Obj | null,
  name: string,
  listKey: string,
  parse: (value: unknown, path: string, layerClass: EvidenceClass | "mixed") => T,
): Layer<T> | null {
  if (body === null) return null;
  const evidenceClass =
    body.evidence_class === "mixed" ? "mixed" : evidence(body.evidence_class, `${name}.evidence_class`);
  const items = arr(body[listKey], `${name}.${listKey}`);
  if (evidenceClass === "mixed") {
    // Mixed is allowed only when every feature says what it is.
    items.forEach((item, i) => featureClass(obj(item, `${name}.${listKey}[${i}]`), `${name}.${listKey}[${i}]`, "mixed"));
  }
  return {
    evidenceClass,
    items: items.map((item, i) => parse(item, `${name}.${listKey}[${i}]`, evidenceClass)),
  };
}

function fireObservations(body: Obj): FireObservations {
  const source = objOrEmpty(body.source);
  const optTime = (v: unknown, path: string) => (v == null ? null : utcMs(v, path));
  return {
    evidenceClass: evidence(body.evidence_class, "fire_observations.evidence_class"),
    sourceLabel: optStr(source.label, "fire_observations.source.label"),
    sourceUrl: optStr(source.url, "fire_observations.source.url"),
    items: ascending(
      arr(body.features ?? [], "fire_observations.features").map((f, i) => {
        const path = `fire_observations.features[${i}]`;
        const o = obj(f, path);
        return {
          id: str(o.id, `${path}.id`),
          coord: lngLat(o.coord, `${path}.coord`),
          atMs: utcMs(o.at, `${path}.at`),
          fromMs: optTime(o.from, `${path}.from`),
          toMs: optTime(o.to, `${path}.to`),
          timePrecision: optStr(o.time_precision, `${path}.time_precision`),
          residual: o.residual_fire === true,
          locationSource: optStr(o.location_source, `${path}.location_source`),
          sourceLocator: optStr(o.source_locator, `${path}.source_locator`),
        };
      }),
      "fire_observations.features",
    ),
    notes: strList(body.notes ?? [], "fire_observations.notes"),
  };
}

/** Totals only; the full crosswalk stays in the bundle for auditing. Lenient: optional block. */
function demandSummary(body: Obj): DemandSummary {
  const t = objOrEmpty(body.totals);
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    evidenceClass: evidence(body.evidence_class, "demand.evidence_class"),
    population: n(t.population),
    households: n(t.households),
    householdsNoVehicle: n(t.households_no_vehicle),
    population65Plus: n(t.population_65_plus),
    evacuatingVehicles: n(t.evacuating_vehicles),
    evacuatingVehiclesMoe: n(t.evacuating_vehicles_moe),
    blockGroups: n(t.block_groups),
  };
}

/** Lenient parse of the optional "model vs published" rows; malformed rows are skipped. */
function validationBlock(body: Obj): Validation {
  const grades: Record<string, string> = {};
  for (const [k, v] of Object.entries(objOrEmpty(body.grades))) if (typeof v === "string") grades[k] = v;
  const text = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  const rows: ValidationRow[] = [];
  for (const raw of Array.isArray(body.rows) ? body.rows : []) {
    if (!isObj(raw) || typeof raw.target_id !== "string" || typeof raw.metric !== "string") continue;
    const model: ValidationRow["model"] = [];
    for (const [key, value] of Object.entries(objOrEmpty(raw.model))) {
      if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) {
        model.push({ key, value });
      }
    }
    const published = raw.published;
    rows.push({
      targetId: raw.target_id,
      metric: raw.metric,
      location: text(raw.location),
      published: typeof published === "string" || typeof published === "number" ? published : null,
      unit: text(raw.unit),
      model,
      comparability: text(raw.comparability) ?? "unknown",
      evidenceClass: (EVIDENCE_CLASSES as readonly unknown[]).includes(raw.evidence_class)
        ? (raw.evidence_class as EvidenceClass)
        : null,
      caveat: text(raw.caveat),
      sourceLocator: text(raw.source_locator),
    });
  }
  return { evidenceClass: evidence(body.evidence_class, "validation.evidence_class"), grades, rows };
}

function responderAction(value: unknown): ResponderAction & { reason: string | null } {
  const a = objOrEmpty(value);
  const text = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    label: text(a.label) ?? "(unlabelled action)",
    localTime: text(a.local_time),
    road: text(a.road),
    kind: text(a.kind),
    reason: text(a.reason),
  };
}

/** Defensive parse of the optional agent-simulation responder comparison. */
function responders(body: Obj): RespondersComparison {
  const c = objOrEmpty(body.comparison_with_history);
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    evidenceClass: evidence(body.evidence_class, "responders.evidence_class"),
    rule: typeof c.rule === "string" ? c.rule : null,
    matches: list(c.matches).map((m): ResponderMatch => {
      const item = objOrEmpty(m);
      const historical = objOrEmpty(item.historical);
      const source = objOrEmpty(historical.source);
      return {
        deltaMin: typeof item.delta_min === "number" ? item.delta_min : null,
        text: typeof item.text === "string" ? item.text : null,
        simulated: responderAction(item.simulated),
        historical: {
          ...responderAction(historical),
          evidenceClass: (EVIDENCE_CLASSES as readonly unknown[]).includes(historical.evidence_class)
            ? (historical.evidence_class as EvidenceClass)
            : null,
          locator: typeof source.locator === "string" ? source.locator : null,
        },
      };
    }),
    simulatedOnly: list(c.simulated_without_counterpart).map(responderAction),
    historicalOnly: list(c.historical_without_counterpart).map(responderAction),
  };
}

export function parseBundle(data: unknown): ReplayModel {
  const b = obj(data, "bundle");
  if (b.kind !== BUNDLE_KIND) throw new BundleError("kind", `expected "${BUNDLE_KIND}"`);
  const schemaVersion = str(b.schema_version, "schema_version");
  if (!schemaVersion.startsWith(SUPPORTED_SCHEMA_MAJOR)) {
    throw new BundleError("schema_version", `unsupported version ${schemaVersion}; this view reads 1.x`);
  }

  const incident = obj(b.incident, "incident");
  const timezone = str(incident.timezone, "incident.timezone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new BundleError("incident.timezone", `unknown IANA time zone "${timezone}"`);
  }

  const clock = obj(b.clock, "clock");
  const startMs = utcMs(clock.start, "clock.start");
  const endMs = utcMs(clock.end, "clock.end");
  const stepSeconds = num(clock.step_seconds, "clock.step_seconds");
  if (endMs <= startMs) throw new BundleError("clock.end", "must be after clock.start");
  if (stepSeconds <= 0) throw new BundleError("clock.step_seconds", "must be positive");

  const bboxRaw = arr(b.bbox, "bbox");
  if (bboxRaw.length !== 4) throw new BundleError("bbox", "expected [west, south, east, north]");
  const bbox = bboxRaw.map((v, i) => num(v, `bbox[${i}]`)) as [number, number, number, number];

  const statusObj = obj(b.layer_status, "layer_status");
  const layerStatusMap: Record<string, LayerStatus> = {};
  for (const [name, value] of Object.entries(statusObj)) {
    layerStatusMap[name] = layerStatus(value, `layer_status.${name}`);
  }

  const fire = layerBody(b, "fire", layerStatusMap);
  const perimeters = fire
    ? ascending(
        arr(fire.perimeters, "fire.perimeters").map((p, i) => perimeter(p, `fire.perimeters[${i}]`)),
        "fire.perimeters",
      )
    : [];

  const trafficBody = layerBody(b, "traffic", layerStatusMap);
  const fireSimBody = layerBody(b, "fire_simulated", layerStatusMap);
  const insightsBody = layerBody(b, "insights", layerStatusMap);

  return {
    schemaVersion,
    incident: {
      id: str(incident.id, "incident.id"),
      name: str(incident.name, "incident.name"),
      packageVersion: optStr(incident.package_version, "incident.package_version"),
      timezone,
      // Both optional and lenient: a bad value is ignored rather than failing the bundle.
      place: typeof incident.place === "string" ? incident.place : null,
      referencePoint: (() => {
        const r = incident.reference_point;
        if (!isObj(r) || typeof r.name !== "string" || !Array.isArray(r.coord)) return null;
        const [lon, lat] = r.coord;
        return typeof lon === "number" && typeof lat === "number" ? { name: r.name, coord: [lon, lat] as LngLat } : null;
      })(),
    },
    mode: str(b.mode, "mode"),
    clock: { startMs, endMs, stepSeconds },
    bbox,
    layerStatus: layerStatusMap,
    assumptions: strList(b.assumptions, "assumptions"),
    limitations: strList(b.limitations, "limitations"),
    perimeters,
    fireSimulated: fireSimBody ? simulatedFire(fireSimBody) : null,
    insights: insightsBody ? insights(insightsBody) : null,
    responders: isObj(b.responders) ? responders(objOrEmpty(b.responders)) : null,
    roads: layer(layerBody(b, "roads", layerStatusMap), "roads", "edges", roadEdge),
    zones: layer(layerBody(b, "zones", layerStatusMap), "zones", "features", zone),
    destinations: layer(
      layerBody(b, "destinations", layerStatusMap),
      "destinations",
      "features",
      destination,
    ),
    events: ascending(
      arr(b.events ?? [], "events").map((e, i) => replayEvent(e, `events[${i}]`)),
      "events",
    ),
    traffic: trafficBody ? traffic(trafficBody) : null,
    damage: layer(layerBody(b, "damage", layerStatusMap), "damage", "features", damagePoint),
    fireObservations: (() => {
      const body = layerBody(b, "fire_observations", layerStatusMap);
      return body ? fireObservations(body) : null;
    })(),
    demand: isObj(b.demand) ? demandSummary(b.demand) : null,
    validation: isObj(b.validation) ? validationBlock(b.validation) : null,
  };
}
