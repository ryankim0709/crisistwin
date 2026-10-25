/**
 * Firefighting for Simulation Studio: plan where crews build control line, run the fire
 * solver with that line (`ControlLines` in fire/spread.ts), and keep the plan that leaves the
 * least burned area at the horizon. See docs/adr/0020-studio-firefighting.md.
 *
 * Every number here is a model output or a named assumption below; nothing is chosen by an
 * LLM. The plans are a small, explicit search, not a proven optimum:
 *
 * - Where: around the unsuppressed fire as it would be at a target minute T (its outline,
 *   the "isochrone" T), one cell outside it. Lines too close are outrun; lines too far are
 *   too long to finish. T is the search variable.
 * - How: crews arrive `responseMinutes` after the first ignition, anchor at one point of
 *   that outline and build along both flanks at once, splitting the resources between the
 *   two directions. Within a direction resources leapfrog: the line is cut into chunks and
 *   chunk j goes to resource j mod n, so several crews work the same flank in parallel.
 * - Anchor: the heel (the upwind end, the textbook "anchor and flank" attack) or the head
 *   (indirect line across the front first). Both are tried.
 * - Holding: a line cell holds against flames up to its builder's direct-attack limit
 *   (Hauling chart: hand tools to 4 ft, engines and dozers to 8 ft; Andrews & Rothermel
 *   1982). The solver compares that with the flame facing the line in the direction of
 *   spread, so flanks hold where the head does not. Crown fire breaches any line.
 *
 * Not modelled: travel on the road network, crew fatigue or shifts, water supply, aircraft,
 * burnout or backfire, mop-up, lines failing after they held, or crews retreating for
 * safety. Treat results as a planning experiment.
 */

import type { LandscapeGrid } from "../fire/landscape";
import {
  DEVELOPED_FUEL_CODE,
  simulateScheduledFireSpread,
  type ControlLines,
} from "../fire/spread";
import type { ScheduledFireInput, ScheduledFireRun } from "../fire/scheduledTypes";
import type { InitialAttackResult } from "./initialAttack";
import {
  AIR_KINDS,
  GROUND_APPARATUS,
  GROUND_KINDS,
  dataValue,
  lineRateMetersPerHour,
  type ApparatusCounts,
  type GroundKind,
} from "./apparatus";
import { DROP_HOLDS_FLAME_FEET, planAircraft, type AircraftPlan, type AirBase } from "./aircraft";
import { WILDLAND_RUN_CARDS } from "../response/runCards";
import { lineOfSight, nearestDeveloped, reportDelay } from "../response/report";
import { deriveStream } from "../response/rng";
import { cellAt as gridCellAt } from "../fire/spread";

/** A ground resource kind (studio/apparatus.ts). Kept as an alias for older imports. */
export type ResourceKind = GroundKind;

export interface FirefightingSettings {
  enabled: boolean;
  /**
   * Legacy counts (scenarios saved before ADR 0048): Type 2 hand crews, Type 3 engines and
   * Type 2 dozers. Ignored when `resources` is present.
   */
  handCrews: number;
  engines: number;
  dozers: number;
  /** Count per apparatus kind, ground and air (studio/apparatus.ts). */
  resources?: ApparatusCounts;
  /**
   * Minutes after the first ignition before any resource starts building line. With
   * `fromStations` this is only the fallback when no station can reach the fire.
   */
  responseMinutes: number;
  /**
   * Drive each resource from its base on the board's roads, the fire reported when it ignites
   * (studio/crewDispatch.ts). Absent in scenarios saved before this existed.
   */
  fromStations?: boolean;
  /**
   * Wall-clock time of T+0, ISO 8601 with a UTC offset (e.g. 2026-08-15T13:00-07:00), for the
   * aviation daylight windows. The scenario has no clock of its own; absent means
   * DEFAULT_START_LOCAL_ISO.
   */
  startLocalIso?: string;
  /** Allow helicopter drops at night (a night-capable S-70i base; the data cannot place one). */
  nightHelicopters?: boolean;
}

/** ASSUMPTION: T+0 when a scenario sets no clock: a mid-August early afternoon, Pacific time. */
export const DEFAULT_START_LOCAL_ISO = "2026-08-15T13:00-07:00";

/** T+0 as UTC epoch milliseconds. */
export function startMsOf(settings: FirefightingSettings): number {
  const ms = Date.parse(settings.startLocalIso ?? DEFAULT_START_LOCAL_ISO);
  return Number.isFinite(ms) ? ms : Date.parse(DEFAULT_START_LOCAL_ISO);
}

const GROUND_FIRST_ALARM = dataValue<{
  engines: number;
  dozers: number;
  hand_crews: number;
  chief_officers: number;
}>("deployment.initial_attack_ground_first_alarm_sra_high");
/** The shared response model's medium-level wildland run card (response/runCards.ts), the /live board's too. */
const RUN_CARD = WILDLAND_RUN_CARDS.medium;

/**
 * First-alarm package. Ground (ASSUMPTION in the data: no public CAL FIRE dispatch matrix):
 * 3 engines, 1 dozer, 1 hand crew, 1 chief officer, as Type 3 engines, a Type 2 dozer and a
 * Type 2 crew. Air (California Fire Pilots Association, secondary source): air attack, two
 * airtankers (CAL FIRE's S-2T) and one helicopter (Type 2 here; ASSUMPTION on the type).
 */
/**
 * Minutes from an ignition to dispatch (call-in, answer, transfer, processing;
 * response/report.ts), seeded per ignition from its place and minute so a rerun gives the
 * same delay. Studio has no households: the nearest developed cell (FBFM40 91) stands in for the
 * nearest home (assumption).
 */
export function ignitionReportDelayMinutes(
  grid: LandscapeGrid | null,
  location: { longitude: number; latitude: number },
  startMinute: number,
  settings: FirefightingSettings,
): number {
  const p: [number, number] = [location.longitude, location.latitude];
  let developed = false;
  let home: { meters: number; at: [number, number] } | null = null;
  let homeInSight = true;
  if (grid) {
    const c0 = gridCellAt(grid, location);
    developed = c0 >= 0 && grid.fuelCodes[c0] === DEVELOPED_FUEL_CODE;
    home = nearestDeveloped(grid, p);
    if (home) homeInSight = lineOfSight(grid, p, home.at);
  }
  const rng = deriveStream(0, `${location.longitude.toFixed(5)},${location.latitude.toFixed(5)},${startMinute}`);
  // Studio has no road lines here, so remoteness comes from developed cells (homes) only.
  return reportDelay(rng, {
    ignitionEpochMs: startMsOf(settings) + startMinute * 60_000,
    location: p,
    nearestHomeM: home?.meters ?? null,
    homeInSight,
    nearestRoadM: null,
    developed,
    wildland: !developed,
    alreadyReported: false,
  }).totalMinutes;
}

export const FIRST_ALARM: ApparatusCounts = {
  engine_t3: RUN_CARD.engines,
  dozer_t2: RUN_CARD.dozers,
  hand_crew_t2: RUN_CARD.hand_crews,
  chief: GROUND_FIRST_ALARM.chief_officers,
  air_attack: RUN_CARD.air_attack,
  airtanker_s2t: RUN_CARD.airtankers,
  helicopter_t2: RUN_CARD.helicopters,
};

export const DEFAULT_FIREFIGHTING: FirefightingSettings = {
  enabled: false,
  handCrews: 0,
  engines: 0,
  dozers: 0,
  resources: { ...FIRST_ALARM },
  responseMinutes: 30,
  fromStations: true,
};
export const MAX_RESOURCES_PER_KIND = 20;
export const RESPONSE_MINUTE_CHOICES = [15, 30, 60, 90] as const;

/** Count per kind for these settings (legacy counts mapped when `resources` is absent). */
export function apparatusCounts(settings: FirefightingSettings): ApparatusCounts {
  if (settings.resources) return settings.resources;
  return {
    hand_crew_t2: settings.handCrews,
    engine_t3: settings.engines,
    dozer_t2: settings.dozers,
  };
}

/** Target outline minutes tried, after the crews arrive. */
export const ISOCHRONE_OFFSETS_MINUTES = [15, 30, 60, 90, 120, 180, 240] as const;
/** Cells a crew looks around for the next ring cell when walking it. */
const WALK_RADIUS = 2;
/** Leapfrog chunk, metres of work equivalent to grass for a Type 3 engine. */
export const CHUNK_WORK_METERS = 300;

/**
 * How much slower `kind` builds line in this fuel than in grass (its rate here over its rate in
 * Anderson model 1, flat ground): from the production tables in studio/apparatus.ts. Infinity
 * on non-burnable ground (no line needed). Developed ground is taken as grass.
 */
export function productionFactor(fuelCode: number, kind: GroundKind = "engine_t3"): number {
  const line = GROUND_APPARATUS[kind].line;
  if (!line) return 0;
  const here = lineRateMetersPerHour(line, fuelCode);
  if (!Number.isFinite(here)) return Infinity;
  return here / lineRateMetersPerHour(line, 101);
}

export type Strategy = "heel" | "head";
export const STRATEGY_LABELS: Record<Strategy, string> = {
  heel: "Anchor at the heel, flank both sides",
  head: "Anchor at the head, cut across the front",
};

/** Line cell outcome against the run it was tested in. */
export const LineStatus = {
  /** Built before the horizon and never burned. */
  held: 0,
  /** Burned after it was built: the flame facing it was too long. */
  breached: 1,
  /** Fire got there before the crew did. */
  outrun: 2,
  /** Not built by the horizon, and not burned. */
  unbuilt: 3,
} as const;
export type LineStatus = (typeof LineStatus)[keyof typeof LineStatus];

export interface LinePlan {
  /** Line cells, in build order per crew direction. */
  cells: Int32Array;
  holdFromMinute: Float32Array;
  kind: Uint8Array;
  /** Ground metres of line planned (path length). */
  plannedMeters: number;
}

export interface PlanScore {
  strategy: Strategy;
  isochroneMinute: number;
  burnedSquareMeters: number;
  developedBurnedSquareMeters: number;
  plannedMeters: number;
  /** Line metres built by the horizon. */
  builtMeters: number;
}

export interface FirefightingResult {
  settings: FirefightingSettings;
  /** Minute the resources start work. */
  startMinute: number;
  baseline: { burnedSquareMeters: number; developedBurnedSquareMeters: number };
  /** Every plan tried, best first. Empty when no plan could be made. */
  candidates: PlanScore[];
  /** The best plan's run and line, or null when no plan could be made. */
  best: {
    score: PlanScore;
    run: ScheduledFireRun;
    line: LinePlan;
    status: Uint8Array;
    /** Line metres by status (held, breached, outrun, unbuilt). */
    statusMeters: [number, number, number, number];
  } | null;
  /** Why nothing could be planned, when `best` is null. */
  note: string | null;
  /** Direct attack once on site (studio/initialAttack.ts); filled in by the worker. */
  initialAttack: InitialAttackResult | null;
  /** Aircraft sorties and drop line (studio/aircraft.ts), or null when none were assigned. */
  aircraft: AircraftPlan | null;
  /** Drop line by outcome in the best run, metres (held, breached, outrun, unbuilt). */
  dropStatusMeters: [number, number, number, number] | null;
}

/** `LinePlan.kind` code: index in GROUND_KINDS. */
export const KIND_BY_CODE: readonly GroundKind[] = GROUND_KINDS;
const KIND_CODE = Object.fromEntries(GROUND_KINDS.map((k, i) => [k, i])) as Record<GroundKind, number>;

/** One resource and the minute it is on site and starts building line. */
export interface CrewArrival {
  kind: ResourceKind;
  minute: number;
}

/**
 * When each resource starts work: the dispatched arrival minutes when crews drive in from fire
 * stations (studio/crewDispatch.ts), else everyone at the first ignition plus the response time.
 */
export function crewArrivals(
  settings: FirefightingSettings,
  input: ScheduledFireInput,
  dispatched: readonly CrewArrival[] | null,
): CrewArrival[] {
  if (dispatched && dispatched.length > 0) {
    return dispatched.filter(({ kind }) => GROUND_APPARATUS[kind].line !== null);
  }
  const minute = Math.min(...input.sources.map((s) => s.startMinute)) + settings.responseMinutes;
  return lineBuilders(settings).map((kind) => ({ kind, minute }));
}

/** Resources, strongest line first so the anchor chunks get the best holding line. */
export function resourceList(settings: FirefightingSettings): GroundKind[] {
  const counts = apparatusCounts(settings);
  const strength = (kind: GroundKind) => {
    const line = GROUND_APPARATUS[kind].line;
    return line?.kind === "dozer" ? 0 : line?.kind === "engine" ? 1 : line ? 2 : 3;
  };
  const list: GroundKind[] = [];
  const kinds = [...GROUND_KINDS].sort((a, b) => strength(a) - strength(b));
  for (const kind of kinds) {
    for (let i = 0; i < Math.max(0, Math.floor(counts[kind] ?? 0)); i += 1) list.push(kind);
  }
  return list;
}

/** Ground resources that build line, strongest first (tenders and chiefs build none). */
export function lineBuilders(settings: FirefightingSettings): GroundKind[] {
  return resourceList(settings).filter((kind) => GROUND_APPARATUS[kind].line !== null);
}

export function resourceCount(settings: FirefightingSettings): number {
  return resourceList(settings).length;
}

/**
 * Cells one step outside the burned region `arrival <= minute`, reachable from the grid
 * border: the outer ring a line has to follow to enclose the fire. Where the fire runs off
 * the board the ring is open and simply ends at the edge.
 */
export function outerRing(grid: LandscapeGrid, arrival: Float32Array, minute: number): Uint8Array {
  const { width, height } = grid;
  const burned = (i: number) => arrival[i] <= minute;
  const outside = new Uint8Array(width * height);
  const stack: number[] = [];
  const seed = (i: number) => {
    if (outside[i] || burned(i)) return;
    outside[i] = 1;
    stack.push(i);
  };
  for (let x = 0; x < width; x += 1) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    seed(y * width);
    seed(y * width + width - 1);
  }
  while (stack.length > 0) {
    const i = stack.pop()!;
    const x = i % width;
    const y = (i - x) / width;
    if (x > 0) seed(i - 1);
    if (x < width - 1) seed(i + 1);
    if (y > 0) seed(i - width);
    if (y < height - 1) seed(i + width);
  }
  const ring = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      if (!outside[i]) continue;
      for (let dy = -1; dy <= 1 && !ring[i]; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (burned(i + dy * width + dx)) {
            ring[i] = 1;
            break;
          }
        }
      }
    }
  }
  return ring;
}

/** 8-connected components of the ring, each a list of cells. */
function ringComponents(grid: LandscapeGrid, ring: Uint8Array): number[][] {
  const { width, height } = grid;
  const seen = new Uint8Array(ring.length);
  const components: number[][] = [];
  for (let start = 0; start < ring.length; start += 1) {
    if (!ring[start] || seen[start]) continue;
    const cells: number[] = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const i = stack.pop()!;
      cells.push(i);
      const x = i % width;
      const y = (i - x) / width;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const j = ny * width + nx;
          if (ring[j] && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
    }
    components.push(cells);
  }
  return components;
}

interface Direction {
  cells: number[];
  /** Ground metres from the previous cell (from the anchor for the first). */
  steps: number[];
}

/**
 * Split a ring into the two flanks walked from the anchor bearing (degrees clockwise from
 * north, seen from the ring's centroid): clockwise and counter-clockwise, each ordered by
 * angle away from the anchor, meeting on the far side.
 */
function flanks(
  grid: LandscapeGrid,
  cells: number[],
  anchorDegrees: number,
): [Direction, Direction] {
  const { width, groundCellSizeMeters } = grid;
  let sx = 0;
  let sy = 0;
  for (const c of cells) {
    sx += c % width;
    sy += Math.floor(c / width);
  }
  const cx = sx / cells.length;
  const cy = sy / cells.length;
  const anchor = (anchorDegrees * Math.PI) / 180;
  const clockwise: [number, number][] = [];
  const counter: [number, number][] = [];
  for (const c of cells) {
    const x = c % width;
    const y = Math.floor(c / width);
    // Bearing clockwise from north in grid space (+x east, +y south).
    let d = Math.atan2(x - cx, -(y - cy)) - anchor;
    while (d <= -Math.PI) d += 2 * Math.PI;
    while (d > Math.PI) d -= 2 * Math.PI;
    if (d >= 0) clockwise.push([d, c]);
    else counter.push([-d, c]);
  }
  // Follow the ring locally from the anchor: step to the nearest unvisited cell within
  // WALK_RADIUS cells, falling back to the next cell in angle order when there is none
  // (a gap, or the far end of a finger). A cell's line work is at most one diagonal cell,
  // so the crew's walk back across a gap is not counted as line.
  const walk = (list: [number, number][]): Direction => {
    list.sort((p, q) => p[0] - q[0]);
    const members = new Map<number, boolean>(list.map(([, c]) => [c, false]));
    const ordered: number[] = [];
    const steps: number[] = [];
    let fallback = 0;
    let current = -1;
    while (ordered.length < list.length) {
      let next = -1;
      if (current >= 0) {
        const x0 = current % width;
        const y0 = Math.floor(current / width);
        let best = Infinity;
        for (let dy = -WALK_RADIUS; dy <= WALK_RADIUS; dy += 1) {
          for (let dx = -WALK_RADIUS; dx <= WALK_RADIUS; dx += 1) {
            if (x0 + dx < 0 || x0 + dx >= width) continue;
            const c = (y0 + dy) * width + (x0 + dx);
            if (members.get(c) !== false) continue;
            const d = dx * dx + dy * dy;
            if (d < best) {
              best = d;
              next = c;
            }
          }
        }
      }
      if (next < 0) {
        while (members.get(list[fallback][1]) !== false) fallback += 1;
        next = list[fallback][1];
      }
      const step =
        current < 0
          ? groundCellSizeMeters
          : Math.hypot(
              (next % width) - (current % width),
              Math.floor(next / width) - Math.floor(current / width),
            ) * groundCellSizeMeters;
      members.set(next, true);
      ordered.push(next);
      steps.push(Math.min(step, Math.SQRT2 * groundCellSizeMeters));
      current = next;
    }
    return { cells: ordered, steps };
  };
  return [walk(clockwise), walk(counter)];
}

/**
 * Build schedule for one plan: when each line cell is finished and by which kind of
 * resource. Resources are shared out over ring components by length, then alternate
 * between the two flanks of their component.
 */
export function planLine(
  grid: LandscapeGrid,
  baselineArrival: Float32Array,
  isochroneMinute: number,
  anchorDegrees: number,
  resources: readonly CrewArrival[],
): LinePlan | null {
  if (resources.length === 0) return null;
  const ring = outerRing(grid, baselineArrival, isochroneMinute);
  const components = ringComponents(grid, ring).sort((a, b) => b.length - a.length);
  if (components.length === 0) return null;

  // Largest remainder share of resources by ring length; at least one for the largest.
  const total = components.reduce((sum, c) => sum + c.length, 0);
  const share = components.map((c) => (c.length / total) * resources.length);
  const given = share.map(Math.floor);
  let left = resources.length - given.reduce((a, b) => a + b, 0);
  share
    .map((value, index) => [value - Math.floor(value), index] as const)
    .sort((a, b) => b[0] - a[0])
    .forEach(([, index]) => {
      if (left > 0) {
        given[index] += 1;
        left -= 1;
      }
    });

  const cells: number[] = [];
  const hold: number[] = [];
  const kinds: number[] = [];
  let plannedMeters = 0;
  let next = 0;
  components.forEach((component, index) => {
    const mine = resources.slice(next, next + given[index]);
    next += given[index];
    const [cw, ccw] = flanks(grid, component, anchorDegrees);
    for (const d of [cw, ccw]) for (const s of d.steps) plannedMeters += s;
    if (mine.length === 0) return;
    // Each resource keeps its own clock; a lone resource does one flank, then the other.
    const crews = mine.map(({ kind, minute }) => ({ kind, clock: minute }));
    const teams =
      crews.length === 1
        ? [crews, crews]
        : [crews.filter((_, k) => k % 2 === 0), crews.filter((_, k) => k % 2 === 1)];
    [cw, ccw].forEach((direction, side) => {
      const team = teams[side];
      let chunk = 0;
      let chunkWork = 0;
      for (let k = 0; k < direction.cells.length; k += 1) {
        const cell = direction.cells[k];
        const factor = productionFactor(grid.fuelCodes[cell]);
        const work = Number.isFinite(factor) ? direction.steps[k] / factor : 0;
        if (chunkWork + work > CHUNK_WORK_METERS && chunkWork > 0) {
          chunk += 1;
          chunkWork = 0;
        }
        chunkWork += work;
        // Slope class and direction for the dozer table: terrain slope at the cell, uphill
        // when the line climbs from the previous cell.
        const previous = k > 0 ? direction.cells[k - 1] : cell;
        const slopePercent = grid.slopeTangent[cell] * 100;
        const uphill = grid.elevationMeters[cell] >= grid.elevationMeters[previous];
        // The chunk's crew, or the next one in the team that can work here (a dozer cannot
        // above 55% slope); with none, the cell stays unbuilt.
        let crew: (typeof team)[number] | null = null;
        let rate = 0;
        for (let t = 0; t < team.length && rate <= 0; t += 1) {
          const candidate = team[(chunk + t) % team.length];
          const line = GROUND_APPARATUS[candidate.kind].line!;
          const r = lineRateMetersPerHour(line, grid.fuelCodes[cell], slopePercent, uphill);
          if (r > 0) {
            crew = candidate;
            rate = r;
          }
        }
        cells.push(cell);
        if (!crew) {
          hold.push(Number.POSITIVE_INFINITY);
          kinds.push(KIND_CODE[team[chunk % team.length].kind]);
          continue;
        }
        // Infinite rate: non-burnable ground needs no line work.
        if (Number.isFinite(rate)) crew.clock += direction.steps[k] / (rate / 60);
        hold.push(crew.clock);
        kinds.push(KIND_CODE[crew.kind]);
      }
    });
  });
  if (cells.length === 0) return null;
  return {
    cells: Int32Array.from(cells),
    holdFromMinute: Float32Array.from(hold),
    kind: Uint8Array.from(kinds),
    plannedMeters,
  };
}

/** Holding limit of a line cell built by the resource with this `LinePlan.kind` code. */
export function holdsFeetOfCode(code: number): number {
  return GROUND_APPARATUS[KIND_BY_CODE[code]].holdsFlameLengthFeet;
}

/**
 * Solver input for a ground line plan plus aircraft drops (studio/aircraft.ts). A cell built
 * twice counts as built by the earlier builder; drops hold flames up to 8 ft (PMS 465).
 */
export function controlLinesFor(
  grid: LandscapeGrid,
  plan: LinePlan | null,
  drops: AircraftPlan | null = null,
): ControlLines {
  const count = grid.width * grid.height;
  const holdFromMinute = new Float32Array(count).fill(Number.POSITIVE_INFINITY);
  const holdsFlameLengthFeet = new Float32Array(count);
  for (let k = 0; plan && k < plan.cells.length; k += 1) {
    const cell = plan.cells[k];
    // A cell on two flanks (rare, where they meet) counts as built by the earlier crew.
    if (plan.holdFromMinute[k] < holdFromMinute[cell]) {
      holdFromMinute[cell] = plan.holdFromMinute[k];
      holdsFlameLengthFeet[cell] = holdsFeetOfCode(plan.kind[k]);
    }
  }
  for (let k = 0; drops && k < drops.cells.length; k += 1) {
    const cell = drops.cells[k];
    if (drops.holdFromMinute[k] < holdFromMinute[cell]) {
      holdFromMinute[cell] = drops.holdFromMinute[k];
      holdsFlameLengthFeet[cell] = DROP_HOLDS_FLAME_FEET;
    }
  }
  return { holdFromMinute, holdsFlameLengthFeet };
}

export function lineStatus(plan: LinePlan, arrival: Float32Array, horizon: number): Uint8Array {
  return Uint8Array.from(plan.cells, (cell, k) => {
    const burnedAt = arrival[cell];
    const built = plan.holdFromMinute[k];
    if (burnedAt <= horizon) return burnedAt < built ? LineStatus.outrun : LineStatus.breached;
    return built <= horizon ? LineStatus.held : LineStatus.unbuilt;
  });
}

export function burnedAreas(grid: LandscapeGrid, arrival: Float32Array, horizon: number) {
  const cellArea = grid.groundCellSizeMeters * grid.groundCellSizeMeters;
  let burned = 0;
  let developed = 0;
  for (let i = 0; i < arrival.length; i += 1) {
    if (arrival[i] > horizon) continue;
    burned += 1;
    if (grid.fuelCodes[i] === DEVELOPED_FUEL_CODE) developed += 1;
  }
  return {
    burnedSquareMeters: burned * cellArea,
    developedBurnedSquareMeters: developed * cellArea,
  };
}

/** Line metres per status, scaling planned length by each cell's share. */
function metersByStatus(plan: LinePlan, status: Uint8Array): [number, number, number, number] {
  const out: [number, number, number, number] = [0, 0, 0, 0];
  const perCell = plan.cells.length > 0 ? plan.plannedMeters / plan.cells.length : 0;
  for (const s of status) out[s] += perCell;
  return out;
}

/** Aircraft inputs for a run: bases near the fire (null without the bases file). */
export interface AirInputs {
  bases: AirBase[] | null;
}

/** Drop line by outcome against a run, ground metres: held, breached, outrun, unbuilt. */
export function dropStatusMeters(
  grid: LandscapeGrid,
  plan: AircraftPlan,
  arrival: Float32Array,
  horizon: number,
): [number, number, number, number] {
  const out: [number, number, number, number] = [0, 0, 0, 0];
  const perCell = grid.groundCellSizeMeters;
  plan.cells.forEach((cell, k) => {
    const burnedAt = arrival[cell];
    const built = plan.holdFromMinute[k];
    const status =
      burnedAt <= horizon
        ? burnedAt < built
          ? LineStatus.outrun
          : LineStatus.breached
        : built <= horizon
          ? LineStatus.held
          : LineStatus.unbuilt;
    out[status] += perCell;
  });
  return out;
}

const EMPTY_LINE: LinePlan = {
  cells: new Int32Array(0),
  holdFromMinute: new Float32Array(0),
  kind: new Uint8Array(0),
  plannedMeters: 0,
};

/**
 * Try every anchor and target outline, solve each, keep the plan with the least burned area
 * (ties: less developed ground burned, then the shorter line). Aircraft drops (when any are
 * assigned) are planned once and added to every candidate. Deterministic.
 */
export function planFirefighting(
  grid: LandscapeGrid,
  input: ScheduledFireInput,
  baseline: ScheduledFireRun,
  settings: FirefightingSettings,
  onProgress?: (done: number, total: number) => void,
  dispatched: readonly CrewArrival[] | null = null,
  air: AirInputs | null = null,
): FirefightingResult {
  const horizon = input.settings.horizonMinutes;
  const resources = crewArrivals(settings, input, dispatched);
  // The first fire reaches dispatch after its call-in and processing delay (response/report.ts).
  const first = [...input.sources].sort((a, b) => a.startMinute - b.startMinute)[0];
  const reportMinute = first ? first.startMinute + ignitionReportDelayMinutes(grid, first.location, first.startMinute, settings) : 0;
  const counts = apparatusCounts(settings);
  const anyAir = AIR_KINDS.some((kind) => (counts[kind] ?? 0) > 0);
  const aircraft = anyAir
    ? planAircraft({
        grid,
        input,
        baseline,
        counts,
        bases: air?.bases ?? null,
        reportMinute,
        startMs: startMsOf(settings),
        nightHelicopters: settings.nightHelicopters === true,
      })
    : null;
  const firstDrop = aircraft && aircraft.drops.length > 0 ? aircraft.drops[0].minute : Infinity;
  const startMinute = Math.min(
    resources.length > 0
      ? Math.min(...resources.map((r) => r.minute))
      : reportMinute + settings.responseMinutes,
    firstDrop,
  );
  const baselineAreas = burnedAreas(grid, baseline.arrivalMinutes, horizon);
  const empty = (note: string): FirefightingResult => ({
    settings,
    startMinute,
    baseline: baselineAreas,
    candidates: [],
    best: null,
    note,
    initialAttack: null,
    aircraft,
    dropStatusMeters: null,
  });
  const hasDrops = aircraft !== null && aircraft.cells.length > 0;
  if (resources.length === 0 && !hasDrops) {
    return empty(anyAir ? "No aircraft drop reached the fire (see aircraft)." : "No resources assigned.");
  }
  if (startMinute >= horizon) return empty("Resources arrive after the horizon.");

  const windFrom = input.settings.windFromDegrees;
  const anchors: [Strategy, number][] = [
    ["heel", windFrom],
    ["head", (windFrom + 180) % 360],
  ];
  const minutes = ISOCHRONE_OFFSETS_MINUTES.map((m) => startMinute + m).filter((m) => m <= horizon);
  if (minutes.length === 0) minutes.push(horizon);
  const total = resources.length > 0 ? anchors.length * minutes.length : 1;
  let done = 0;
  type Tried = { score: PlanScore; run: ScheduledFireRun; line: LinePlan };
  const tried: Tried[] = [];
  const solve = (strategy: Strategy, isochroneMinute: number, line: LinePlan) => {
    const run = simulateScheduledFireSpread(grid, input, controlLinesFor(grid, line, aircraft));
    const areas = burnedAreas(grid, run.arrivalMinutes, horizon);
    let builtMeters = 0;
    const perCell = line.cells.length > 0 ? line.plannedMeters / line.cells.length : 0;
    for (const t of line.holdFromMinute) if (t <= horizon) builtMeters += perCell;
    tried.push({
      score: { strategy, isochroneMinute, ...areas, plannedMeters: line.plannedMeters, builtMeters },
      run,
      line,
    });
  };
  if (resources.length === 0) {
    solve("head", startMinute, EMPTY_LINE);
    onProgress?.(1, 1);
  }
  for (const [strategy, bearing] of resources.length > 0 ? anchors : []) {
    for (const isochroneMinute of minutes) {
      const line = planLine(grid, baseline.arrivalMinutes, isochroneMinute, bearing, resources);
      done += 1;
      onProgress?.(done, total);
      if (!line) continue;
      solve(strategy, isochroneMinute, line);
    }
  }
  if (tried.length === 0) {
    return empty("The fire has no outline to build line along before the horizon.");
  }
  tried.sort(
    (a, b) =>
      a.score.burnedSquareMeters - b.score.burnedSquareMeters ||
      a.score.developedBurnedSquareMeters - b.score.developedBurnedSquareMeters ||
      a.score.plannedMeters - b.score.plannedMeters,
  );
  const winner = tried[0];
  const status = lineStatus(winner.line, winner.run.arrivalMinutes, horizon);
  return {
    settings,
    startMinute,
    baseline: baselineAreas,
    candidates: tried.map((t) => t.score),
    best: {
      score: winner.score,
      run: winner.run,
      line: winner.line,
      status,
      statusMeters: metersByStatus(winner.line, status),
    },
    note: null,
    initialAttack: null,
    aircraft,
    dropStatusMeters: aircraft
      ? dropStatusMeters(grid, aircraft, winner.run.arrivalMinutes, horizon)
      : null,
  };
}
