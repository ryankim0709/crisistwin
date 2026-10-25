/**
 * Seeded stochasticity for the landscape fire solver (spread.ts). Pure: no React, worker,
 * network or wall clock. Three mechanisms, each switchable, all keyed on one seed:
 *
 *   1. A spatially correlated, multiplicative lognormal rate-of-spread field (unresolved
 *      fuel, moisture and microclimate variability plus model error).
 *   2. Wind wander: per 10-minute step, a speed factor and a direction offset around the
 *      run's (hourly) wind, sized from the gust factor (Durst 1960).
 *   3. Stochastic ember spotting: a burning cell may launch a firebrand ahead of the front
 *      to a distance drawn below the Albini (1979, 1983) / BehavePlus maximum spotting
 *      distance, igniting receptive fuel with the BehavePlus probability of ignition.
 *
 * Every random draw is a pure function of (seed, stream, index) — a counter-based hash, not
 * a sequential generator — so a draw never depends on the order in which the solver happens
 * to visit cells. That is what makes the same seed reproduce the same field bit for bit, and
 * what lets a resumed solve (spread.ts `ResumeFrom`) make the same draws for the same cells
 * as the uninterrupted one. See docs/fire-simulator.md, "Stochastic spread".
 *
 * Evidence. Every output of a stochastic run is SIMULATED. The published relations used
 * here are cited where they are applied; every other number is exported below as a named
 * ASSUMPTION with the reasoning for its value.
 *
 * Units are in the names. Imperial where the published relation is Imperial (BehavePlus
 * spotting and ignition: feet, mph, Btu/ft/s, degrees Fahrenheit on input), metres and
 * minutes at the solver boundary.
 */

// ---------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------

/**
 * Stochastic spread options, carried on `FireScenario.stochastic` (and so on
 * `FireSettings.stochastic` for Studio and the /live board). Absent, or `enabled: false`,
 * leaves every solver output bit-for-bit what the deterministic solver produces.
 */
export interface StochasticSpreadOptions {
  enabled: boolean;
  /** Seed, any finite number; reduced to an unsigned 32-bit integer. */
  seed: number;
  /**
   * Standard deviation of ln(rate-of-spread multiplier), dimensionless. Default
   * `DEFAULT_ROS_LOG_SIGMA` (Cruz & Alexander 2013). 0 turns the field off.
   */
  rosSigma?: number;
  /** Correlation length of the rate field, ground metres. Default `DEFAULT_ROS_CORRELATION_METERS`. */
  rosCorrelationMeters?: number;
  /** Stochastic ember spotting. Default true. Needs the scenario's `spotting.enabled`. */
  spotting?: boolean;
  /** Per-step gusts and direction wander around the run's wind. Default true. */
  windWander?: boolean;
  /**
   * Peak gust over mean wind for the hour, dimensionless, both read at the same height (use
   * `gustFactorOf` on a weather sample). Null, absent or below 1: `DEFAULT_GUST_FACTOR`.
   */
  gustFactor?: number | null;
  /** Air temperature for the firebrand ignition probability, degrees F. Default `DEFAULT_AIR_TEMPERATURE_F`. */
  airTemperatureF?: number;
}

// ---------------------------------------------------------------------------------------
// 1. Rate-of-spread field
// ---------------------------------------------------------------------------------------

/**
 * Default standard deviation of ln(ROS multiplier): ln(1.35) = 0.300.
 *
 * Source: Cruz & Alexander (2013), "Uncertainty associated with model predictions of surface
 * and crown fire rates of spread", Environmental Modelling & Software 47:16-28. From 49
 * evaluation datasets (1278 observations) they propose a 35% error interval as "approximately
 * one standard deviation" of heading-ROS prediction error when inputs are accurate (section 4);
 * the mean absolute percent error of most datasets was 51-75%, so this is the narrow end.
 *
 * ASSUMPTION in how it is used: their figure is a whole-fire prediction error, and here it is
 * applied as cell-scale variability with a finite correlation length. A front crossing many
 * correlation lengths averages the field, so a run's overall spread varies by less than
 * 35%. Their reported under-prediction bias is NOT applied: the field has median 1.
 */
export const DEFAULT_ROS_LOG_SIGMA = Math.log(1.35);
/**
 * Validation bound on `rosSigma` (scenario import), ln(3) = 1.10: one standard deviation of
 * a factor of three, the loosest "within a factor of two or three" success criterion Cruz &
 * Alexander (2013, section 4) quote from the earlier literature. A bound, not a default.
 */
export const MAX_ROS_LOG_SIGMA = Math.log(3);
/**
 * ASSUMPTION: correlation length (Gaussian kernel standard deviation) of the rate field, ground
 * metres. Three native LANDFIRE cells: fuel and canopy patches are mapped at 30 m, so
 * variability coarser than the map is what the map misses. No source fixes this value.
 */
export const DEFAULT_ROS_CORRELATION_METERS = 90;
/** Kernel half-width in standard deviations; 3 keeps 99.7% of the Gaussian weight. */
const KERNEL_HALF_WIDTH_SIGMAS = 3;

// ---------------------------------------------------------------------------------------
// 2. Wind wander
// ---------------------------------------------------------------------------------------

/**
 * Wind step, simulation minutes: each step draws one 10-minute mean wind around the run's
 * (hourly) wind. Ten minutes is the standard averaging period of a surface wind observation
 * (WMO-No. 8), and it is also the order of how long one solver step lasts: a step carries its
 * source cell's rate up to 10.6 cells (`NEIGHBOUR_STENCIL_RADIUS`), about 12 minutes at 20 m/min
 * on a 24 m cell. A cell's outgoing rate is fixed when it ignites, so a wind step much shorter
 * than that would let a one-minute gust direction persist for the whole step. Measured: with
 * independent 1-minute draws (6.3 degree direction sigma) the synthetic 6-hour test fire
 * burned 79% more area than deterministic, of which 10 points came from speed and the rest
 * from direction jitter fanning the front out; that is a lattice artifact, not wind physics.
 */
export const WIND_STEP_MINUTES = 10;
/**
 * Durst (1960) gust curve, "Wind speeds over short periods of time", Meteorological Magazine
 * 89:181-187, in the closed form used by ASCE 7-05 (commentary to the wind chapter): the
 * probable maximum wind averaged over `seconds`, as a ratio to the hourly mean wind, open
 * terrain: G(t) = 0.977 + 0.64 / (1 + (t / 38.14)^0.685). G(3 s) = 1.52, G(600 s) = 1.06.
 */
export function durstGustFactor(seconds: number): number {
  return 0.977 + 0.64 / (1 + Math.pow(seconds / 38.14, 0.685));
}
/** Default gust factor: Durst's 3-second gust over the hourly mean, 1.52. Used when the weather sample has no gust. */
export const DEFAULT_GUST_FACTOR = durstGustFactor(3);
/**
 * Share of the 3-second gust's excess over the hourly mean that the largest 10-minute mean
 * in the hour reaches, from the same curve: (G(600) - 1) / (G(3) - 1) = 0.117. It converts an
 * observed gust factor into the excess of the largest 10-minute mean, assuming the observed
 * gust and mean stand in the same relation as Durst's (ASSUMPTION: the sample's `speedMs` is
 * read as the hourly mean).
 */
export const TEN_MINUTE_GUST_EXCESS_RATIO = (durstGustFactor(600) - 1) / (durstGustFactor(3) - 1);
/**
 * Expected maximum of 6 independent standard normals, 1.2672 (normal order statistics): the
 * peak factor of the largest of the six 10-minute means in an hour, taking them as independent
 * (ASSUMPTION: stationary turbulence, integral time scale well under 10 minutes). The
 * 10-minute log-speed standard deviation is then (G - 1) x 0.117 / 1.2672: 0.048 at the
 * default gust factor.
 */
export const TEN_MINUTE_MEAN_PEAK_FACTOR = 1.2672;
/**
 * sigma_v / sigma_u in the neutral surface layer: about 2.0 u* / 2.5 u* = 0.8 (Kaimal &
 * Finnigan 1994, Atmospheric Boundary Layer Flows, ch. 1). A step's direction standard
 * deviation is 0.8 x the speed's coefficient of variation, in radians: 2.2 degrees at the
 * default gust factor.
 */
export const TRANSVERSE_TO_LONGITUDINAL_TURBULENCE = 0.8;
/**
 * How a step's wind is drawn: speed = hourly speed x exp(sigma z - sigma^2 / 2) (lognormal,
 * mean 1), capped at the gust factor (no 10-minute mean exceeds the peak gust); direction =
 * hourly direction + 0.8 sigma z' radians. z and z' are independent standard normals keyed on
 * (seed, step), so steps are independent, consistent with the peak factor above.
 *
 * What this leaves out, deliberately: non-stationary meander and wind shifts within the hour.
 * They are larger than stationary turbulence implies, but no source here sizes them, and the
 * empirical length-to-breadth relations the solver uses (Anderson 1983; Alexander 1985) were
 * fitted to fires that already burned under naturally fluctuating wind. Hour-to-hour change
 * comes from the weather series: inside one solve with `FireScenario.weatherSeries`
 * (weatherSeries.ts; the wander is then applied around each step's series wind), or by
 * re-solving on every hourly sample (the /live board).
 */

// ---------------------------------------------------------------------------------------
// 3. Stochastic spotting
// ---------------------------------------------------------------------------------------

/**
 * ASSUMPTION: firebrand launch rate per metre of burning cell width, per cell passage. A cell
 * of width w launches one spotting firebrand with probability 1 - exp(-rate * w): 2.9% for a
 * 30 m cell. No published per-length generation rate fits a cell model; this is set low so that
 * spotting stays an occasional jump ahead of a front rather than the dominant spread mechanism
 * of a surface fire, and is bounded by `MAX_SPOT_LAUNCHES_PER_RUN`.
 */
export const SPOT_LAUNCH_RATE_PER_METER = 0.001;
/** Bound on launch trials per solve, for performance. Each trial is O(1). */
export const MAX_SPOT_LAUNCHES_PER_RUN = 5000;
/**
 * ASSUMPTION: shape of the landing-distance distribution. Firebrand landing distances are
 * lognormal (Sardoy et al. 2008, Combustion and Flame 154:478-488; Himoto & Tanaka 2005).
 * Their fitted parameters are for fire intensities and plumes outside this surface model's
 * range, so they are not used. Instead the median is a quarter of the Albini maximum and the
 * maximum sits at the 99th percentile (sigma = ln(4) / 2.326 = 0.596); draws past the maximum
 * or past the scenario's spotting ceiling start no fire.
 */
export const SPOT_LANDING_MEDIAN_FRACTION_OF_MAX = 0.25;
const Z_99 = 2.3263478740408408;
export const SPOT_LANDING_LOG_SIGMA = -Math.log(SPOT_LANDING_MEDIAN_FRACTION_OF_MAX) / Z_99;
/**
 * ASSUMPTION: canopy cover at or above which the downwind cover is treated as closed in
 * Albini's model (BehavePlus asks the user; open cover halves the effective height).
 */
export const SPOT_CLOSED_CANOPY_COVER_FRACTION = 0.5;
/**
 * ASSUMPTION: air temperature for the probability of ignition when the caller gives none,
 * degrees F: 86 F (30 C), a hot fire-season afternoon. The solver has no temperature input.
 */
export const DEFAULT_AIR_TEMPERATURE_F = 86;

export const FEET_PER_METER = 1 / 0.3048;
const METERS_PER_MILE = 1609.344;

/**
 * Maximum spotting distance from a wind-driven surface fire over flat terrain, ground metres:
 * Albini (1979) INT-56 and Albini (1983) INT-309 as implemented in BehavePlus
 * (firelab/behave src/behave/spot.cpp, `calculateSpottingDistanceFromSurfaceFire`,
 * `calculateSpotCriticalCoverHeight`, `spotDistanceFlatTerrain`), transcribed term for term:
 *
 *   f   = 322 (0.474 U)^-1.01                     U: 20-ft wind, mph
 *   z_F = 1.055 sqrt(f I)                         I: Byram intensity, Btu/ft/s; z_F ft
 *   drift = 0.000278 U z_F^0.643                  miles
 *   H_c = max(H, 2.2 z_F^0.337 - 4)               H: effective downwind cover height, ft
 *   D   = 0.000718 U sqrt(H_c) (0.362 + sqrt(z_F/H_c)/2 ln(z_F/H_c)) + drift   miles
 *
 * Effective cover height is the cover height for closed cover and half of it for open cover.
 * The mountain-terrain (ridge/valley) adjustment is not applied.
 */
export function albiniSurfaceSpotDistanceMeters(
  firelineIntensityBtuPerFootPerSecond: number,
  twentyFootWindMph: number,
  downwindCoverHeightFeet: number,
  closedCanopy: boolean,
): number {
  const U = twentyFootWindMph;
  const I = firelineIntensityBtuPerFootPerSecond;
  if (!(U > 1e-7) || !(I > 1e-7)) return 0;
  const f = 322 * Math.pow(0.474 * U, -1.01);
  const fI = f * I;
  const firebrandHeightFeet = fI < 1e-7 ? 0 : 1.055 * Math.sqrt(fI);
  const driftMiles = 0.000278 * U * Math.pow(firebrandHeightFeet, 0.643);
  const effectiveCoverFeet = closedCanopy ? downwindCoverHeightFeet : downwindCoverHeightFeet * 0.5;
  const criticalFeet = firebrandHeightFeet < 1e-7 ? 0 : 2.2 * Math.pow(firebrandHeightFeet, 0.337) - 4;
  const coverFeet = effectiveCoverFeet > criticalFeet ? effectiveCoverFeet : criticalFeet;
  let flatMiles = 0;
  if (coverFeet > 1e-7) {
    const ratio = firebrandHeightFeet / coverFeet;
    flatMiles =
      0.000718 * U * Math.sqrt(coverFeet) * (0.362 + (Math.sqrt(ratio) / 2) * Math.log(ratio));
  }
  const miles = flatMiles + driftMiles;
  return miles > 0 ? miles * METERS_PER_MILE : 0;
}

/**
 * Probability that a firebrand landing on fine dead fuel ignites it, 0 to 1. Schroeder (1969)
 * as implemented in BehavePlus (firelab/behave src/behave/ignite.cpp,
 * `calculateFirebrandIgnitionProbability` and `calculateFuelTemperature`):
 *
 *   T_fuel(F) = T_air(F) + 25 - 20 shade
 *   Q_ig = 144.51 - 0.266 T - 0.00058 T^2 - T M + 18.54 (1 - exp(-15.1 M)) + 640 M,  Q_ig <= 400
 *          (T fuel temperature C, M 1-h moisture fraction; Q_ig Btu/lb)
 *   x = 0.1 (400 - Q_ig);   P = 0.000048 x^4.3 / 50, clamped to [0, 1]
 *
 * BehavePlus worked examples (testBehave.cpp): 6% 1-h, 80 F, 50% shade -> 0.54831705;
 * 7% 1-h, 90 F, 25% shade -> 0.50717573.
 */
export function firebrandIgnitionProbability(
  oneHourMoistureFraction: number,
  airTemperatureF: number,
  sunShadeFraction: number,
): number {
  const fuelTemperatureF = airTemperatureF + (25 - 20 * sunShadeFraction);
  const T = ((fuelTemperatureF - 32) * 5) / 9;
  const M = oneHourMoistureFraction;
  let heat =
    144.51 -
    0.266 * T -
    0.00058 * T * T -
    T * M +
    18.54 * (1 - Math.exp(-15.1 * M)) +
    640 * M;
  if (heat > 400) heat = 400;
  const x = 0.1 * (400 - heat);
  const p = (0.000048 * Math.pow(x, 4.3)) / 50;
  return p > 1 ? 1 : p < 0 ? 0 : p;
}

/** Gust factor of a weather sample (gust over mean at the station's height), or null. */
export function gustFactorOf(sample: {
  speedMs: number | null;
  gustMs: number | null;
}): number | null {
  const { speedMs, gustMs } = sample;
  if (speedMs === null || gustMs === null || !(speedMs > 0) || !Number.isFinite(gustMs)) return null;
  return gustMs >= speedMs ? gustMs / speedMs : null;
}

// ---------------------------------------------------------------------------------------
// Counter-based random numbers
// ---------------------------------------------------------------------------------------

/** Stream ids: one per kind of draw, so no two mechanisms share a random number. */
export const STREAM_ROS = 1;
export const STREAM_WIND_SPEED = 2;
export const STREAM_WIND_DIRECTION = 3;
export const STREAM_SPOT_LAUNCH = 4;
export const STREAM_SPOT_DISTANCE = 5;
export const STREAM_SPOT_LATERAL = 6;
export const STREAM_SPOT_IGNITION = 7;
export const STREAM_ENSEMBLE = 8;
/** Fire-induced wind direction offsets (fireInducedWind.ts), keyed on the igniting cell. */
export const STREAM_PLUME_DIRECTION = 9;

/** 32-bit integer finaliser ("lowbias32", C. Wellons 2018); a bijection on uint32. */
function mix32(value: number): number {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Seed of any finite number as an unsigned 32-bit integer (non-finite becomes 0). */
export function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed)) return 0;
  const whole = Math.trunc(seed);
  // Fold the high bits in so seeds above 2^32 are not silently aliased by truncation.
  return (mix32(whole >>> 0) ^ mix32(Math.floor(whole / 4294967296) >>> 0)) >>> 0;
}

function hash3(seed: number, stream: number, index: number): number {
  return mix32(mix32(mix32(seed ^ Math.imul(stream, 0x9e3779b9)) ^ index) + 0x6a09e667);
}

/** Uniform draw in (0, 1), a pure function of (seed, stream, index). */
export function uniformAt(seed: number, stream: number, index: number): number {
  return ((hash3(seed, stream, index) >>> 8) + 0.5) / 16777216;
}

/** Standard normal draw (Box-Muller), a pure function of (seed, stream, index). */
export function normalAt(seed: number, stream: number, index: number): number {
  const h = hash3(seed, stream, index);
  const u1 = ((h >>> 8) + 0.5) / 16777216;
  const u2 = ((mix32(h ^ 0x85ebca6b) >>> 8) + 0.5) / 16777216;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Seed of ensemble member k derived from a base seed. */
export function memberSeed(baseSeed: number, member: number): number {
  return hash3(normalizeSeed(baseSeed), STREAM_ENSEMBLE, member);
}

// ---------------------------------------------------------------------------------------
// Resolved options
// ---------------------------------------------------------------------------------------

/** The options a stochastic run actually used, after defaults, for the run record. */
export interface AppliedStochasticOptions {
  seed: number;
  rosSigma: number;
  rosCorrelationMeters: number;
  windWander: boolean;
  spotting: boolean;
  gustFactor: number;
  gustFactorSource: "observed" | "assumed-default";
  /** Standard deviation of ln(10-minute wind speed / hourly speed), dimensionless. */
  stepWindLogSigma: number;
  /** Direction standard deviation, degrees. */
  directionSigmaDegrees: number;
  airTemperatureF: number;
}

/** What the stochastic mechanisms did in one solve. Simulated, not observed. */
export interface StochasticRunSummary {
  evidence: "simulated";
  applied: AppliedStochasticOptions;
  /** Launch trials that produced a firebrand. */
  spotLaunches: number;
  /** Firebrands that landed on receptive fuel, ignited, and set an arrival time when they landed. */
  spotIgnitions: number;
  /** True when `MAX_SPOT_LAUNCHES_PER_RUN` cut launching off. */
  spotLaunchCapReached: boolean;
  /** Wind factors per step actually drawn over the horizon (speed multiplier, direction offset). */
  windSpeedFactorRange: [number, number];
  windDirectionOffsetRangeDegrees: [number, number];
}

/** Resolve options against defaults; null means the run is deterministic. */
export function resolveStochastic(
  options: StochasticSpreadOptions | null | undefined,
): AppliedStochasticOptions | null {
  if (!options || options.enabled !== true) return null;
  const finiteOr = (value: number | null | undefined, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const observedGust =
    typeof options.gustFactor === "number" && Number.isFinite(options.gustFactor) && options.gustFactor >= 1
      ? options.gustFactor
      : null;
  const gustFactor = observedGust ?? DEFAULT_GUST_FACTOR;
  const stepWindLogSigma =
    ((gustFactor - 1) * TEN_MINUTE_GUST_EXCESS_RATIO) / TEN_MINUTE_MEAN_PEAK_FACTOR;
  return {
    seed: normalizeSeed(options.seed),
    rosSigma: Math.max(0, finiteOr(options.rosSigma, DEFAULT_ROS_LOG_SIGMA)),
    rosCorrelationMeters: Math.max(0, finiteOr(options.rosCorrelationMeters, DEFAULT_ROS_CORRELATION_METERS)),
    windWander: options.windWander !== false,
    spotting: options.spotting !== false,
    gustFactor,
    gustFactorSource: observedGust !== null ? "observed" : "assumed-default",
    stepWindLogSigma,
    directionSigmaDegrees: (TRANSVERSE_TO_LONGITUDINAL_TURBULENCE * stepWindLogSigma * 180) / Math.PI,
    airTemperatureF: finiteOr(options.airTemperatureF, DEFAULT_AIR_TEMPERATURE_F),
  };
}

// ---------------------------------------------------------------------------------------
// Field and series generators
// ---------------------------------------------------------------------------------------

/** Normalised 1-D Gaussian kernel of standard deviation `sigmaCells`. */
function gaussianKernel(sigmaCells: number): Float64Array {
  const half = Math.max(1, Math.ceil(KERNEL_HALF_WIDTH_SIGMAS * sigmaCells));
  const kernel = new Float64Array(2 * half + 1);
  let sum = 0;
  for (let k = -half; k <= half; k++) {
    const w = Math.exp(-(k * k) / (2 * sigmaCells * sigmaCells));
    kernel[k + half] = w;
    sum += w;
  }
  for (let k = 0; k < kernel.length; k++) kernel[k] /= sum;
  return kernel;
}

/**
 * One separable blur pass along a line of `length` samples, truncating the kernel at the
 * ends. Returns, per position, the sum of squared weights used, so the caller can restore
 * unit variance exactly (white noise of unit variance filtered with weights w has variance
 * sum w^2).
 */
function blurLine(
  input: Float32Array,
  output: Float32Array,
  start: number,
  stride: number,
  length: number,
  kernel: Float64Array,
  sumSquares: Float64Array,
  recordSquares: boolean,
): void {
  const half = (kernel.length - 1) / 2;
  for (let i = 0; i < length; i++) {
    let acc = 0;
    let squares = 0;
    const lo = Math.max(0, i - half);
    const hi = Math.min(length - 1, i + half);
    for (let j = lo; j <= hi; j++) {
      const w = kernel[j - i + half];
      acc += w * input[start + j * stride];
      squares += w * w;
    }
    output[start + i * stride] = acc;
    if (recordSquares) sumSquares[i] = squares;
  }
}

let cachedField: { key: string; field: Float32Array } | null = null;

/**
 * Multiplicative rate-of-spread field, row-major like `LandscapeGrid.fuelCodes`: exp(sigma z)
 * with z a unit-variance Gaussian field of correlation length `correlationMeters` (white noise
 * from `normalAt(seed, STREAM_ROS, cell)` blurred by a separable Gaussian, then rescaled so
 * every cell, edges included, has unit variance). Median 1. Null when sigma is 0.
 *
 * The last field is cached by its inputs: the /live board re-solves the same grid and seed
 * many times, and the field is the same every time.
 */
export function rosMultiplierField(
  width: number,
  height: number,
  groundCellSizeMeters: number,
  seed: number,
  sigma: number,
  correlationMeters: number,
): Float32Array | null {
  if (!(sigma > 0) || width <= 0 || height <= 0) return null;
  const key = `${width}|${height}|${groundCellSizeMeters}|${seed}|${sigma}|${correlationMeters}`;
  if (cachedField && cachedField.key === key) return cachedField.field;
  const count = width * height;
  const noise = new Float32Array(count);
  for (let i = 0; i < count; i++) noise[i] = normalAt(seed, STREAM_ROS, i);
  const sigmaCells = correlationMeters / groundCellSizeMeters;
  // Below half a cell the kernel is a delta: each cell already averages its own area.
  if (sigmaCells >= 0.5) {
    const kernel = gaussianKernel(sigmaCells);
    const rowSquares = new Float64Array(width);
    const columnSquares = new Float64Array(height);
    const scratch = new Float32Array(count);
    for (let y = 0; y < height; y++) {
      blurLine(noise, scratch, y * width, 1, width, kernel, rowSquares, y === 0);
    }
    for (let x = 0; x < width; x++) {
      blurLine(scratch, noise, x, width, height, kernel, columnSquares, x === 0);
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        noise[y * width + x] /= Math.sqrt(rowSquares[x] * columnSquares[y]);
      }
    }
  }
  for (let i = 0; i < count; i++) noise[i] = Math.exp(sigma * noise[i]);
  cachedField = { key, field: noise };
  return noise;
}

/** Per-step wind multipliers over a horizon. Index k covers minutes [k * step, (k + 1) * step). */
export interface WindWanderSeries {
  stepMinutes: number;
  /** Speed multiplier per step, mean 1, at most the gust factor. */
  speedFactor: Float64Array;
  /** Direction offset per step, degrees, added to the bearing the wind blows FROM. */
  directionOffsetDegrees: Float64Array;
}

/**
 * Wind anomaly per step from minute 0 to `horizonMinutes`, keyed on the step index (minute 0
 * is always step 0), so every solve with the same seed sees the same anomaly at the same
 * simulation minute, whatever minute it starts or resumes at.
 */
export function windWanderSeries(applied: AppliedStochasticOptions, horizonMinutes: number): WindWanderSeries {
  const steps = Math.max(1, Math.ceil(Math.max(0, horizonMinutes) / WIND_STEP_MINUTES) + 1);
  const sigmaSpeed = applied.stepWindLogSigma;
  const sigmaDirectionDegrees = applied.directionSigmaDegrees;
  const speedFactor = new Float64Array(steps);
  const directionOffsetDegrees = new Float64Array(steps);
  for (let k = 0; k < steps; k++) {
    const zs = normalAt(applied.seed, STREAM_WIND_SPEED, k);
    const zd = normalAt(applied.seed, STREAM_WIND_DIRECTION, k);
    const factor = Math.exp(sigmaSpeed * zs - (sigmaSpeed * sigmaSpeed) / 2);
    speedFactor[k] = Math.min(factor, applied.gustFactor);
    directionOffsetDegrees[k] = sigmaDirectionDegrees * zd;
  }
  return { stepMinutes: WIND_STEP_MINUTES, speedFactor, directionOffsetDegrees };
}

/** Step index of a simulation minute, clamped to the series. */
export function windStepAt(series: WindWanderSeries, minute: number): number {
  const k = Math.floor(minute / series.stepMinutes);
  return k < 0 ? 0 : k >= series.speedFactor.length ? series.speedFactor.length - 1 : k;
}

/** Probability that a burning cell of this width launches a spotting firebrand. */
export function spotLaunchProbability(cellWidthMeters: number): number {
  return 1 - Math.exp(-SPOT_LAUNCH_RATE_PER_METER * cellWidthMeters);
}
