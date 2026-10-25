/**
 * Initial attack estimate for Simulation Studio: once its units are on site, can each incident's
 * units put its fire out? A containment race in the spirit of Fried & Fried (1996, Forest Science
 * 42(3):267-281): the units build line along the fire's edge while the edge keeps growing, and
 * the fire is out once the line built covers its perimeter. See docs/adr/0020-studio-firefighting.md
 * and docs/response-model.md.
 *
 * Per incident (studio/incidents.ts): a fire is attacked only by the units sent to it
 * (`CrewArrival.sourceId`), each from its own arrival minute. A fire with no unit on its edge is
 * never "out". Units holding a road (indirect) are not arrivals and build no edge line here.
 *
 * Direct attack is judged at the time each unit works, not at ignition: a unit builds line in a
 * minute only when the fire's head flame then is within its direct-attack limit (hand tools 4 ft,
 * engines and dozers 8 ft: NWCG PMS 465 Fireline Handbook App. B p.12 "Hauling chart", after
 * Andrews & Rothermel 1982, "Charts for interpreting wildland fire behavior characteristics",
 * USDA FS GTR INT-131) and the fire is not crowning. The head flame at minute t is the longest
 * surface flame (Byram 1959, as the solver reports it per cell) among the fire's cells that
 * ignited in the weather step before t (`HEAD_FLAME_WINDOW_MINUTES`); any torching or crowning
 * cell there counts as crowning. Line built while the fire was attackable stays built.
 *
 * Withdrawal (LCES, NWCG Incident Response Pocket Guide PMS 461: escape routes and safety zones
 * must stay usable): a unit stops work when a fire it cannot hold (head flame above its limit, or
 * crowning) is forecast to reach the cells around where it parked within its walk back plus
 * UNIT_WITHDRAW_MARGIN_MINUTES (dispatch/engine.ts, ASSUMPTION). It builds no line after that.
 *
 * Still rough, and labelled so in the UI:
 * - Each fire's perimeter comes from its modelled area as an ellipse with the length-to-breadth
 *   ratio at its ignition point (real perimeters are more ragged, so this understates the line).
 * - Rates are the sourced production tables (studio/apparatus.ts) in the fuel at the ignition
 *   point on flat ground; an engine parked beyond hose reach works as an engine crew on foot
 *   (response/reach.ts planWork: persons x PMS 465 p.39 hand-line rate, hand-tool flame limit).
 * - Water, mop-up and aircraft are not part of this race (aircraft are in the control-line plan).
 *
 * The result feeds `simulateScheduledFireSpread(..., outFromMinuteBySource)`, which stops each
 * fire from spreading after its put-out minute. Before that minute the stopped run equals the
 * free run for that fire, so areas read from the free run are exact.
 */

import { UNIT_WITHDRAW_MARGIN_MINUTES } from "../dispatch/engine";
import { ellipsePerimeter } from "./ellipse";
import type { LandscapeGrid } from "../fire/landscape";
import type { ScheduledFireInput, ScheduledFireRun } from "../fire/scheduledTypes";
import { cellAt, simulateScheduledFireSpread } from "../fire/spread";
import { WEATHER_STEP_MINUTES } from "../fire/weatherSeries";
import { ENGINE_CREW_MAX_HIKE_M, HOSE_1_5_INCH_FEET, engineCrewHandLineMPerMin, hoseReachMeters } from "../response/reach";
import type { GroundResponseKind } from "../response/fleet";
import { GROUND_APPARATUS, lineRateMetersPerHour, type GroundKind } from "./apparatus";
import { HIKE_METERS_PER_MINUTE } from "./crewDispatch";
import {
  burnedAreas,
  crewArrivals,
  type CrewArrival,
  type FirefightingSettings,
} from "./firefighting";

/** Grass reference for "grass-equivalent" line: LANDFIRE GR1, Anderson model 1. */
const GRASS_FUEL_CODE = 101;
/**
 * ASSUMPTION: the fire's head at minute t is read from the cells that ignited in the last
 * weather step (10 min, the solver's step) before t; with none, the last cell to ignite.
 */
export const HEAD_FLAME_WINDOW_MINUTES = WEATHER_STEP_MINUTES;
/** Hand-tool direct-attack limit, feet (PMS 465 Hauling chart; studio/apparatus.ts). */
const HAND_TOOL_FLAME_FT = GROUND_APPARATUS.hand_crew_t1.holdsFlameLengthFeet;

/** How one unit fared on its incident's fire. */
export interface UnitAttack {
  label: string | null;
  kind: GroundKind;
  sourceId: string;
  arriveMinute: number;
  /** hose / engine: from the apparatus; hand_line: an engine crew on foot (planWork). */
  mode: "apparatus" | "engine_crew_on_foot";
  /** Line it builds, metres per minute, in the fire's fuel on flat ground. */
  lineMetersPerMinute: number;
  /** Longest head flame it attacks directly, feet. */
  holdsFlameLengthFeet: number;
  /** Head flame when it arrived, feet (Infinity: crowning). */
  headFlameAtArrivalFeet: number;
  /** First minute it built line, or null when the fire was never within its limit while it was there. */
  firstWorkMinute: number | null;
  /** Minute it withdrew for safety (fire it cannot hold reaching its parking point), or null. */
  withdrawMinute: number | null;
  /** Line it built, metres. */
  lineMeters: number;
}

export interface FireAttack {
  sourceId: string;
  /** Minute the fire starts burning in the run, or null if another fire reached it first. */
  ignitedMinute: number | null;
  /** Head flame when the first unit arrived (at ignition when none came), feet; Infinity when crowning. */
  headFlameFeet: number;
  /** Did any of its units ever attack it directly. */
  attackable: boolean;
  /** Minute it is out, or null if not by the horizon. */
  outMinute: number | null;
  /** Burned area and estimated perimeter when it is out (or at the horizon), m² and m. */
  areaSquareMeters: number;
  perimeterMeters: number;
  /** The units sent to it that worked its edge (direct arrivals). */
  units?: UnitAttack[];
  /** First unit on its edge, or null when none came. */
  firstArrivalMinute?: number | null;
  /** Why it is not out, in plain words, or null when it is out. */
  reason?: string | null;
}

export interface InitialAttackEstimate {
  /** Minute the first unit is on any fire edge (Infinity when none is). */
  onSiteMinute: number;
  /** Line all units would build per minute in grass, metres (display only). */
  lineMetersPerMinute: number;
  /** Longest flame the strongest unit holds, feet. */
  holdsFlameLengthFeet: number;
  fires: FireAttack[];
  /** Put-out minute per run source, Infinity where it keeps burning (solver input). */
  outFromMinuteBySource: number[];
}

export { ellipsePerimeter };

/** Rate and holding limit of a unit that walked `hikeMeters` from where it parked (response/reach.ts planWork). */
function unitWork(kind: GroundKind, hikeMeters: number, fuelCode: number) {
  const spec = GROUND_APPARATUS[kind];
  const line = spec.line!;
  const apparatus = {
    mode: "apparatus" as const,
    perMinute: lineRateMetersPerHour(line, fuelCode) / 60,
    holds: spec.holdsFlameLengthFeet,
  };
  if (line.kind !== "engine") return apparatus;
  const typed = kind in HOSE_1_5_INCH_FEET;
  const hose = typed ? hoseReachMeters(kind as GroundResponseKind) : ENGINE_CREW_MAX_HIKE_M;
  if (hikeMeters <= hose) return apparatus;
  if (hikeMeters <= ENGINE_CREW_MAX_HIKE_M && typed) {
    return {
      mode: "engine_crew_on_foot" as const,
      perMinute: engineCrewHandLineMPerMin(kind as GroundResponseKind, fuelCode),
      holds: HAND_TOOL_FLAME_FT,
    };
  }
  return { mode: "apparatus" as const, perMinute: 0, holds: 0 };
}

/** Arrival minutes and head flames of one source's cells, in arrival order. */
interface SourceCells {
  arrival: Float64Array;
  /** Head flame per cell, feet; Infinity where it torches or crowns. */
  flame: Float32Array;
}

function sourceCells(run: ScheduledFireRun): SourceCells[] {
  const n = run.input.sources.length;
  const lists: number[][] = Array.from({ length: n }, () => []);
  const { arrivalMinutes, sourceIndexByCell, cellBehaviour } = run;
  for (let i = 0; i < arrivalMinutes.length; i += 1) {
    const s = sourceIndexByCell[i];
    if (s >= 0 && s < n && Number.isFinite(arrivalMinutes[i])) lists[s].push(i);
  }
  return lists.map((cells) => {
    cells.sort((a, b) => arrivalMinutes[a] - arrivalMinutes[b] || a - b);
    const arrival = Float64Array.from(cells, (c) => arrivalMinutes[c]);
    const flame = Float32Array.from(cells, (c) =>
      cellBehaviour
        ? cellBehaviour.crownType[c] !== 0
          ? Number.POSITIVE_INFINITY
          : cellBehaviour.headFlameFeet[c]
        : Number.NaN,
    );
    return { arrival, flame };
  });
}

/** Number of entries <= t in an ascending array. */
function countUpTo(sorted: Float64Array, t: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function estimateInitialAttack(
  run: ScheduledFireRun,
  settings: FirefightingSettings,
  dispatched: readonly CrewArrival[] | null = null,
  grid: LandscapeGrid | null = null,
): InitialAttackEstimate {
  const { sources } = run.input;
  const horizon = run.input.settings.horizonMinutes;
  const arrivals = crewArrivals(settings, run.input, dispatched);
  const cellArea = run.cellSizeMeters * run.cellSizeMeters;
  const cells = sourceCells(run);
  const indexOf = new Map(sources.map((s, i) => [s.id, i]));
  const firstIgnited = run.ignitions
    .map((ig, i) => ({ i, minute: ig.outcome.status === "ignited" ? ig.outcome.ignitedMinute : Infinity }))
    .sort((a, b) => a.minute - b.minute)[0]?.i ?? 0;

  /** Head flame of source s at minute t, feet (Infinity: crowning). */
  const headFlameAt = (s: number, t: number): number => {
    const { conditions } = run.ignitions[s];
    const atIgnition =
      conditions.crown !== null && conditions.crown.type !== "surface"
        ? Number.POSITIVE_INFINITY
        : conditions.spread.flameLengthFeet;
    const { arrival, flame } = cells[s];
    const hi = countUpTo(arrival, t);
    if (hi === 0 || Number.isNaN(flame[0])) return atIgnition;
    const lo = countUpTo(arrival, t - HEAD_FLAME_WINDOW_MINUTES);
    let max = 0;
    for (let k = Math.min(lo, hi - 1); k < hi; k += 1) max = Math.max(max, flame[k]);
    return max;
  };
  const areaAt = (s: number, t: number) => countUpTo(cells[s].arrival, t) * cellArea;

  // A unit sent to a fire another fire reached first works the fire that reached it.
  const effectiveSource = (sourceId: string | undefined): number => {
    let s = sourceId !== undefined ? (indexOf.get(sourceId) ?? firstIgnited) : firstIgnited;
    for (let guard = 0; guard < sources.length; guard += 1) {
      const outcome = run.ignitions[s].outcome;
      if (outcome.status === "ignited") break;
      const next = indexOf.get(outcome.reachedBySourceId);
      if (next === undefined) break;
      s = next;
    }
    return s;
  };

  type Working = UnitAttack & { s: number; hikeBackMinutes: number; nearby: { arrival: number; source: number }[] };
  const fires = run.ignitions.map((ignition, s) => {
    const { conditions, outcome } = ignition;
    return {
      s,
      sourceId: sources[s].id,
      ignitedMinute: outcome.status === "ignited" ? outcome.ignitedMinute : null,
      ratio: Math.max(1, conditions.spread.lengthToBreadth),
      fuelCode: conditions.fuelCode,
      outMinute: null as number | null,
      line: 0,
      units: [] as Working[],
    };
  });
  for (const a of arrivals) {
    const s = effectiveSource(a.sourceId);
    const fire = fires[s];
    const work = unitWork(a.kind, a.hikeMeters ?? 0, fire.fuelCode);
    // Cells around where it parked (3 x 3, ASSUMPTION: its vehicle and the start of its escape route).
    const nearby: { arrival: number; source: number }[] = [];
    if (grid && a.roadPoint) {
      const c0 = cellAt(grid, { longitude: a.roadPoint[0], latitude: a.roadPoint[1] });
      if (c0 >= 0) {
        const x0 = c0 % grid.width;
        const y0 = (c0 - x0) / grid.width;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const x = x0 + dx;
            const y = y0 + dy;
            if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) continue;
            const c = y * grid.width + x;
            if (Number.isFinite(run.arrivalMinutes[c]) && run.sourceIndexByCell[c] >= 0) {
              nearby.push({ arrival: run.arrivalMinutes[c], source: run.sourceIndexByCell[c] });
            }
          }
        }
      }
    }
    fire.units.push({
      s,
      label: a.label ?? null,
      kind: a.kind,
      sourceId: fire.sourceId,
      arriveMinute: a.minute,
      mode: work.mode,
      lineMetersPerMinute: work.perMinute,
      holdsFlameLengthFeet: work.holds,
      headFlameAtArrivalFeet: Number.NaN,
      firstWorkMinute: null,
      withdrawMinute: null,
      lineMeters: 0,
      hikeBackMinutes: (a.hikeMeters ?? 0) / HIKE_METERS_PER_MINUTE,
      nearby,
    });
  }

  // Step the race minute by minute from the first ignition (the solver's arrival field is
  // continuous; one minute is finer than any line or weather input).
  const start = Math.max(0, Math.floor(Math.min(...fires.map((f) => f.ignitedMinute ?? Infinity), horizon)));
  for (let t = start + 1; t <= horizon; t += 1) {
    const flameNow = fires.map((fire) =>
      fire.ignitedMinute !== null && fire.ignitedMinute <= t ? headFlameAt(fire.s, t) : 0,
    );
    for (const fire of fires) {
      if (fire.ignitedMinute === null || fire.outMinute !== null || fire.ignitedMinute > t) continue;
      for (const unit of fire.units) {
        if (unit.arriveMinute > t) continue;
        if (Number.isNaN(unit.headFlameAtArrivalFeet)) unit.headFlameAtArrivalFeet = headFlameAt(fire.s, unit.arriveMinute);
        if (unit.withdrawMinute !== null) continue;
        // Withdraw when a fire it cannot hold will reach where it parked before it can walk out.
        const lead = unit.hikeBackMinutes + UNIT_WITHDRAW_MARGIN_MINUTES;
        const threat = unit.nearby.some(
          ({ arrival, source }) =>
            arrival <= t + lead &&
            (fires[source].outMinute === null || fires[source].outMinute! >= arrival) &&
            flameNow[source] > unit.holdsFlameLengthFeet,
        );
        if (threat) {
          unit.withdrawMinute = Math.max(unit.arriveMinute, t - 1);
          continue;
        }
        if (flameNow[fire.s] > unit.holdsFlameLengthFeet || unit.lineMetersPerMinute <= 0) continue;
        const minutes = t - Math.max(t - 1, unit.arriveMinute);
        const built = unit.lineMetersPerMinute * minutes;
        unit.lineMeters += built;
        fire.line += built;
        if (unit.firstWorkMinute === null) unit.firstWorkMinute = Math.max(t - 1, unit.arriveMinute);
      }
      if (fire.line <= 0) continue;
      const need = ellipsePerimeter(areaAt(fire.s, t), fire.ratio);
      if (fire.line >= need) fire.outMinute = t;
    }
  }

  const out: FireAttack[] = fires.map((fire) => {
    const at = fire.outMinute ?? horizon;
    const areaSquareMeters = fire.ignitedMinute === null ? 0 : areaAt(fire.s, at);
    const units: UnitAttack[] = fire.units.map((u) => ({
      label: u.label,
      kind: u.kind,
      sourceId: u.sourceId,
      arriveMinute: u.arriveMinute,
      mode: u.mode,
      lineMetersPerMinute: u.lineMetersPerMinute,
      holdsFlameLengthFeet: u.holdsFlameLengthFeet,
      headFlameAtArrivalFeet: Number.isNaN(u.headFlameAtArrivalFeet)
        ? headFlameAt(fire.s, Math.min(u.arriveMinute, horizon))
        : u.headFlameAtArrivalFeet,
      firstWorkMinute: u.firstWorkMinute,
      withdrawMinute: u.withdrawMinute,
      lineMeters: u.lineMeters,
    }));
    const firstArrivalMinute = units.length > 0 ? Math.min(...units.map((u) => u.arriveMinute)) : null;
    const headFlameFeet =
      fire.ignitedMinute === null
        ? 0
        : headFlameAt(fire.s, Math.min(horizon, firstArrivalMinute ?? fire.ignitedMinute));
    const attackable = units.some((u) => u.firstWorkMinute !== null);
    const strongest = Math.max(0, ...units.map((u) => u.holdsFlameLengthFeet));
    const reason =
      fire.outMinute !== null || fire.ignitedMinute === null
        ? null
        : units.length === 0
          ? "no unit reached its edge"
          : !attackable
            ? !Number.isFinite(headFlameFeet)
              ? "it is crowning when its units arrive"
              : `its ${headFlameFeet.toFixed(1)} ft head flame when units arrive is longer than they can hold (${strongest} ft)`
            : units.every((u) => u.withdrawMinute !== null)
              ? "its units withdrew for safety"
              : "its units' line cannot catch its edge by the end of the run";
    return {
      sourceId: fire.sourceId,
      ignitedMinute: fire.ignitedMinute,
      headFlameFeet,
      attackable,
      outMinute: fire.outMinute,
      areaSquareMeters,
      perimeterMeters: ellipsePerimeter(areaSquareMeters, fire.ratio),
      units,
      firstArrivalMinute,
      reason,
    };
  });

  const grassPerMinute = (kind: GroundKind) =>
    lineRateMetersPerHour(GROUND_APPARATUS[kind].line!, GRASS_FUEL_CODE) / 60;
  return {
    onSiteMinute: arrivals.length > 0 ? Math.min(...arrivals.map((a) => a.minute)) : Number.POSITIVE_INFINITY,
    lineMetersPerMinute: arrivals.reduce((sum, a) => sum + grassPerMinute(a.kind), 0),
    holdsFlameLengthFeet: Math.max(0, ...arrivals.map((a) => GROUND_APPARATUS[a.kind].holdsFlameLengthFeet)),
    fires: out,
    outFromMinuteBySource: out.map((fire) =>
      fire.outMinute !== null && fire.outMinute < horizon ? fire.outMinute : Number.POSITIVE_INFINITY,
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
  const estimate = estimateInitialAttack(baseline, settings, dispatched, grid);
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
