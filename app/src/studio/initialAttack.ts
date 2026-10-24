/**
 * Initial attack estimate for Simulation Studio: once the crews are on site, can they put
 * each fire out? A rough containment race in the spirit of Fried & Fried (1996): crews build
 * line around the fire's edge at their combined rate while the edge keeps growing, and a fire
 * is out once the line built covers its perimeter. See docs/adr/0020-studio-firefighting.md.
 *
 * Deliberately rough, and labelled so in the UI:
 * - Each fire's perimeter comes from its modelled area alone, as an ellipse with the
 *   length-to-breadth ratio at its ignition point. Real perimeters are more ragged, so this
 *   understates the line needed.
 * - All resources arrive together and work as one pool; line counts toward every fire still
 *   burning (in grass-equivalent metres, so heavier fuel needs more work). When the pool has
 *   built enough to ring all of them, they are all out at once.
 * - Direct attack is possible only where the head flame at the ignition point is within the
 *   longest flame the crews can hold (Hauling chart) and the fire is not crowning there; a
 *   fire that fails this is never put out by direct attack and gets no line.
 * - Travel time, staging, water and mop-up are not modelled.
 *
 * The result feeds `simulateScheduledFireSpread(..., outFromMinuteBySource)`, which stops each
 * fire from spreading after its put-out minute, so playback shows the contained fire.
 */

import type { LandscapeGrid } from "../fire/landscape";
import type { ScheduledFireInput, ScheduledFireRun } from "../fire/scheduledTypes";
import { simulateScheduledFireSpread } from "../fire/spread";
import {
  RESOURCE_TYPES,
  burnedAreas,
  crewArrivals,
  type CrewArrival,
  productionFactor,
  type FirefightingSettings,
} from "./firefighting";

export interface FireAttack {
  sourceId: string;
  /** Minute the fire starts burning in the run, or null if another fire reached it first. */
  ignitedMinute: number | null;
  /** Head flame at the ignition point, feet; Infinity when it is crowning there. */
  headFlameFeet: number;
  /** Can the assigned crews attack it directly at all. */
  attackable: boolean;
  /** Minute it is out, or null if not by the horizon. */
  outMinute: number | null;
  /** Burned area and estimated perimeter when it is out (or at the horizon), m² and m. */
  areaSquareMeters: number;
  perimeterMeters: number;
}

export interface InitialAttackEstimate {
  /** Minute the crews are on site and start building line. */
  onSiteMinute: number;
  /** Line the pooled crews build per minute in grass, metres. */
  lineMetersPerMinute: number;
  /** Longest flame the strongest crew type holds, feet. */
  holdsFlameLengthFeet: number;
  fires: FireAttack[];
  /** Put-out minute per run source, Infinity where it keeps burning (solver input). */
  outFromMinuteBySource: number[];
}

/** Ramanujan's perimeter of the ellipse with this area and length-to-breadth ratio. */
export function ellipsePerimeter(areaSquareMeters: number, lengthToBreadth: number): number {
  if (areaSquareMeters <= 0) return 0;
  const ratio = Math.max(1, lengthToBreadth);
  const a = Math.sqrt((areaSquareMeters * ratio) / Math.PI);
  const b = a / ratio;
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

export function estimateInitialAttack(
  run: ScheduledFireRun,
  settings: FirefightingSettings,
  dispatched: readonly CrewArrival[] | null = null,
): InitialAttackEstimate {
  const { sources } = run.input;
  const horizon = run.input.settings.horizonMinutes;
  const arrivals = crewArrivals(settings, run.input, dispatched);
  const onSiteMinute =
    arrivals.length > 0
      ? Math.min(...arrivals.map((a) => a.minute))
      : Math.min(...sources.map((s) => s.startMinute)) + settings.responseMinutes;
  let lineMetersPerMinute = 0;
  let holdsFlameLengthFeet = 0;
  for (const { kind } of arrivals) {
    lineMetersPerMinute += RESOURCE_TYPES[kind].metersPerHourInGrass / 60;
    holdsFlameLengthFeet = Math.max(
      holdsFlameLengthFeet,
      RESOURCE_TYPES[kind].holdsFlameLengthFeet,
    );
  }
  /** Grass-equivalent line built by `minute`, each resource working from its own arrival. */
  const builtBy = (minute: number) =>
    arrivals.reduce(
      (sum, { kind, minute: start }) =>
        sum + (RESOURCE_TYPES[kind].metersPerHourInGrass / 60) * Math.max(0, minute - start),
      0,
    );

  const fires = run.ignitions.map(
    (ignition, index): FireAttack & { work: number; ratio: number } => {
      const { conditions, outcome } = ignition;
      const crowning = conditions.crown !== null && conditions.crown.type !== "surface";
      const headFlameFeet = crowning ? Number.POSITIVE_INFINITY : conditions.spread.flameLengthFeet;
      const factor = productionFactor(conditions.fuelCode);
      return {
        sourceId: sources[index].id,
        ignitedMinute: outcome.status === "ignited" ? outcome.ignitedMinute : null,
        headFlameFeet,
        attackable:
          outcome.status === "ignited" &&
          lineMetersPerMinute > 0 &&
          headFlameFeet <= holdsFlameLengthFeet,
        outMinute: null,
        areaSquareMeters: 0,
        perimeterMeters: 0,
        // Grass-equivalent work per metre of this fire's edge.
        work: Number.isFinite(factor) ? 1 / factor : 0,
        ratio: Math.max(1, conditions.spread.lengthToBreadth),
      };
    },
  );

  const areaAt = (frame: ScheduledFireRun["frames"][number], id: string) =>
    frame.reachedAreaBySourceSquareMeters[id] ?? 0;
  /** Grass-equivalent line needed to ring every attackable fire still burning. */
  const needAt = (frame: ScheduledFireRun["frames"][number], committed: number) => {
    let need = committed;
    for (const fire of fires) {
      if (!fire.attackable || fire.outMinute !== null) continue;
      need += ellipsePerimeter(areaAt(frame, fire.sourceId), fire.ratio) * fire.work;
    }
    return need;
  };

  // Walk the run's frames; between frames the gap between line built and line needed is
  // interpolated linearly to find the minute they meet.
  let committed = 0;
  let previous: { minute: number; gap: number } | null = null;
  for (const frame of run.frames) {
    const minute = frame.elapsedMinutes;
    if (minute < onSiteMinute) continue;
    const anyBurning = fires.some(
      (fire) =>
        fire.attackable &&
        fire.outMinute === null &&
        fire.ignitedMinute !== null &&
        fire.ignitedMinute <= minute,
    );
    if (!anyBurning) {
      previous = null;
      continue;
    }
    const built = builtBy(minute);
    const gap = built - needAt(frame, committed);
    if (gap >= 0) {
      const outMinute =
        previous && previous.gap < 0
          ? previous.minute + ((minute - previous.minute) * -previous.gap) / (gap - previous.gap)
          : minute;
      for (const fire of fires) {
        if (!fire.attackable || fire.outMinute !== null || fire.ignitedMinute === null) continue;
        if (fire.ignitedMinute > minute) continue;
        fire.outMinute = outMinute;
        fire.areaSquareMeters = areaAt(frame, fire.sourceId);
        fire.perimeterMeters = ellipsePerimeter(fire.areaSquareMeters, fire.ratio);
        committed += fire.perimeterMeters * fire.work;
      }
      previous = null;
      continue;
    }
    previous = { minute, gap };
  }
  const last = run.frames[run.frames.length - 1];
  for (const fire of fires) {
    if (fire.outMinute !== null || !last) continue;
    fire.areaSquareMeters = areaAt(last, fire.sourceId);
    fire.perimeterMeters = ellipsePerimeter(fire.areaSquareMeters, fire.ratio);
  }

  return {
    onSiteMinute,
    lineMetersPerMinute,
    holdsFlameLengthFeet,
    fires: fires.map((fire) => ({
      sourceId: fire.sourceId,
      ignitedMinute: fire.ignitedMinute,
      headFlameFeet: fire.headFlameFeet,
      attackable: fire.attackable,
      outMinute: fire.outMinute,
      areaSquareMeters: fire.areaSquareMeters,
      perimeterMeters: fire.perimeterMeters,
    })),
    outFromMinuteBySource: fires.map((fire) =>
      fire.outMinute !== null && fire.outMinute < horizon
        ? fire.outMinute
        : Number.POSITIVE_INFINITY,
    ),
  };
}

export interface InitialAttackResult {
  estimate: InitialAttackEstimate;
  /** Burned and developed area at the horizon in `run`. */
  areas: { burnedSquareMeters: number; developedBurnedSquareMeters: number };
  /** The run with each fire stopped at its put-out minute (the free run if none goes out). */
  run: ScheduledFireRun;
}

export function runInitialAttack(
  grid: LandscapeGrid,
  input: ScheduledFireInput,
  baseline: ScheduledFireRun,
  settings: FirefightingSettings,
  dispatched: readonly CrewArrival[] | null = null,
): InitialAttackResult {
  const estimate = estimateInitialAttack(baseline, settings, dispatched);
  const anyOut = estimate.outFromMinuteBySource.some(Number.isFinite);
  const run = anyOut
    ? simulateScheduledFireSpread(grid, input, null, estimate.outFromMinuteBySource)
    : baseline;
  return {
    estimate,
    areas: burnedAreas(grid, run.arrivalMinutes, input.settings.horizonMinutes),
    run,
  };
}
