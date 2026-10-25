/**
 * Fire-induced wind for the landscape fire solver (spread.ts): a SIMPLIFIED, opt-in
 * parameterization of how an intense fire's own convection takes directional control away from
 * the ambient wind. Pure: no React, network or wall clock; its only randomness is seeded.
 *
 * What is published, and used as published:
 *
 *   - Byram's convective number (Byram 1959, "Forest fire behavior", in Davis (ed.),
 *     Forest Fire: Control and Use, McGraw-Hill, pp. 90-123; derivation in Nelson
 *     1993, "Byram derivation of the energy criterion for forest and wildland fires",
 *     Int. J. Wildland Fire 3(3):131-138, doi:10.1071/WF9930131), in the form given as Eq. (1)
 *     of Hassan, Accary, Moinuddin et al. 2026, Fire Safety Journal 162:104753,
 *     doi:10.1016/j.firesaf.2026.104753:
 *
 *         N_c = 2 g I / (rho c_p T_0 (U_W - R)^3)
 *
 *     I fireline intensity (W/m), g gravity, rho and c_p air density and specific heat, T_0
 *     ambient temperature (K), R rate of spread (m/s), and U_W "the wind velocity component at a
 *     reference height (typically 10 m at field scale ...) aligned with fire propagation
 *     direction" (Hassan et al. 2026). Nelson (1993) itself could not be read for this change;
 *     the form above is the secondary source's, and the 10 m height is its stated field-scale
 *     convention.
 *   - Byram's buoyant velocity U_B = (2 g I / (rho c_p T_0))^(1/3), Eq. (2) of the same paper,
 *     so N_c = (U_B / (U_W - R))^3.
 *   - Regime thresholds: N_c <= 2 wind-driven, N_c >= 10 plume-dominated, mixed between, from
 *     Nelson 2015, "Re-analysis of wind and slope effects on flame characteristics of
 *     Mediterranean shrub fires", Int. J. Wildland Fire 24(7):1001-1007, doi:10.1071/WF14155,
 *     after Pagni & Peterson 1973 — as quoted by Hassan et al. 2026, section 1 (Nelson 2015 was
 *     not read directly).
 *
 * What is ASSUMED (every number below that is not one of the above is an assumption, exported
 * with its reasoning): how plume dominance changes the wind a cell spreads with, how far the
 * indraft reaches, how much it adds to direction variability, and how much it raises spotting.
 * The published criterion classifies a fire; it does not prescribe any of these effects. Every
 * output of a run with this option on is SIMULATED and labelled so.
 *
 * The scheme, applied once per cell when it ignites (the solver's own rule for weather):
 *   1. N_c from the cell's fireline intensity (surface plus burning canopy, Byram's I = H w R),
 *      the cell's head rate and the ambient 10 m wind of its weather step.
 *   2. Plume weight phi in [0, 1]: 0 at N_c <= 2, 1 at N_c >= 10, linear in log N_c between.
 *   3. Indraft: a wind vector toward the fire's active centre (intensity-weighted centroid of the
 *      cells that ignited in the last `PLUME_MEMORY_MINUTES`, per fire) of speed
 *      phi x `INDRAFT_SPEED_FRACTION_OF_BUOYANT_VELOCITY` x U_B, tapering linearly to 0 at
 *      `INDRAFT_RADIUS_FACTOR` x the active area's equivalent radius, is added to the ambient
 *      wind. The cell then spreads with the summed wind (speed and direction), through the same
 *      Rothermel / crown / spotting code as any other wind.
 *   4. Direction variability: a seeded offset of phi x `PLUME_DIRECTION_SIGMA_DEGREES` x z
 *      (z standard normal, clamped to +/- 2) on the summed wind's direction.
 *   5. Spotting: the stochastic firebrand launch probability is multiplied by
 *      1 + phi x (`PLUME_SPOT_LAUNCH_MULTIPLIER` - 1) (stochastic spotting must be on).
 */

import { HEAT_CONTENT_BTU_PER_LB } from "./fuelModels";
import { DEFAULT_AIR_TEMPERATURE_F } from "./stochastic";

/** Opt-in options, carried on `FireScenario.fireInducedWind`. Absent or `enabled: false`: no effect, output unchanged. */
export interface FireInducedWindOptions {
  enabled: boolean;
  /**
   * Seed of the direction-variability draws. Absent: the stochastic seed when natural
   * variation is on, else 0.
   */
  seed?: number;
}

// ---------------------------------------------------------------------------------------
// Published relations and physical constants
// ---------------------------------------------------------------------------------------

/** Standard gravity, m/s^2 (CGPM 1901 conventional value). */
export const GRAVITY_M_PER_S2 = 9.80665;
/** Specific heat of dry air at constant pressure near 300 K, J/(kg K) (standard tables, ~1004-1005). */
export const AIR_SPECIFIC_HEAT_J_PER_KG_K = 1004;
/** Specific gas constant of dry air, J/(kg K). */
export const DRY_AIR_GAS_CONSTANT_J_PER_KG_K = 287.05;
/**
 * ASSUMPTION: air pressure for the density in N_c, Pa: the standard sea-level atmosphere. The
 * solver has no pressure input; at 1000 m elevation the real density is about 11% lower, which
 * raises N_c by the same 11% (N_c is inversely proportional to rho).
 */
export const STANDARD_PRESSURE_PA = 101325;
/** Wind-driven regime: N_c at or below this (Nelson 2015, after Pagni & Peterson 1973; quoted by Hassan et al. 2026). */
export const WIND_DRIVEN_MAX_CONVECTIVE_NUMBER = 2;
/** Plume-dominated regime: N_c at or above this (same source). */
export const PLUME_DOMINATED_MIN_CONVECTIVE_NUMBER = 10;
/**
 * Below this wind relative to the front, m/s, N_c is treated as infinite (plume-dominated): the
 * fire is outrunning or matching the wind, (U - R)^3 is zero or negative and the published form
 * has no meaning. A numerical guard, not a physical constant.
 */
export const MIN_RELATIVE_WIND_METERS_PER_SECOND = 0.05;

/** Exact: 1 Btu/lb = 2.326 kJ/kg. */
export const KJ_PER_KG_PER_BTU_PER_LB = 2.326;
/**
 * ASSUMPTION: heat yield of burning canopy fuel, kJ/kg: the Scott & Burgan (2005) low heat
 * content every SB40 surface model uses (8,000 Btu/lb = 18,608 kJ/kg), so canopy and surface
 * fuel release heat on one scale. The commonly quoted forest-fuel value is 18,000 kJ/kg.
 */
export const CANOPY_HEAT_YIELD_KJ_PER_KG = HEAT_CONTENT_BTU_PER_LB * KJ_PER_KG_PER_BTU_PER_LB;

/** Air density from the ideal gas law at `STANDARD_PRESSURE_PA`, kg/m^3. */
export function airDensityKgPerM3(airTemperatureK: number): number {
  return STANDARD_PRESSURE_PA / (DRY_AIR_GAS_CONSTANT_J_PER_KG_K * airTemperatureK);
}

/**
 * Byram's buoyant velocity U_B = (2 g I / (rho c_p T_0))^(1/3), m/s (Hassan et al. 2026, Eq. 2).
 * I in kW/m at the call, converted to W/m here.
 */
export function buoyantVelocityMetersPerSecond(firelineIntensityKwPerM: number, airTemperatureK: number): number {
  if (!(firelineIntensityKwPerM > 0) || !(airTemperatureK > 0)) return 0;
  const intensityWPerM = firelineIntensityKwPerM * 1000;
  const rho = airDensityKgPerM3(airTemperatureK);
  return Math.cbrt((2 * GRAVITY_M_PER_S2 * intensityWPerM) / (rho * AIR_SPECIFIC_HEAT_J_PER_KG_K * airTemperatureK));
}

/**
 * Byram's convective number N_c = 2 g I / (rho c_p T_0 (U - R)^3) (Byram 1959; Nelson 1993;
 * form of Hassan et al. 2026, Eq. 1), dimensionless.
 *
 * @param firelineIntensityKwPerM Byram fireline intensity, kW/m.
 * @param tenMeterWindMetersPerSecond ambient open wind at 10 m along the spread direction, m/s.
 * @param rateOfSpreadMetersPerSecond head rate of spread, m/s.
 * @param airTemperatureK ambient air temperature, K.
 * @returns Infinity when U - R is below `MIN_RELATIVE_WIND_METERS_PER_SECOND`; 0 when I is 0.
 */
export function byramConvectiveNumber(
  firelineIntensityKwPerM: number,
  tenMeterWindMetersPerSecond: number,
  rateOfSpreadMetersPerSecond: number,
  airTemperatureK: number,
): number {
  if (!(firelineIntensityKwPerM > 0)) return 0;
  const relative = tenMeterWindMetersPerSecond - rateOfSpreadMetersPerSecond;
  if (!(relative >= MIN_RELATIVE_WIND_METERS_PER_SECOND)) return Number.POSITIVE_INFINITY;
  const rho = airDensityKgPerM3(airTemperatureK);
  return (
    (2 * GRAVITY_M_PER_S2 * firelineIntensityKwPerM * 1000) /
    (rho * AIR_SPECIFIC_HEAT_J_PER_KG_K * airTemperatureK * relative * relative * relative)
  );
}

/**
 * Plume weight in [0, 1]: 0 at or below the wind-driven threshold, 1 at or above the
 * plume-dominated one. ASSUMPTION: linear in ln N_c across the published mixed range (2, 10);
 * the source names the range, not a shape within it.
 */
export function plumeDominance(convectiveNumber: number): number {
  if (!(convectiveNumber > WIND_DRIVEN_MAX_CONVECTIVE_NUMBER)) return 0;
  if (convectiveNumber >= PLUME_DOMINATED_MIN_CONVECTIVE_NUMBER) return 1;
  return (
    Math.log(convectiveNumber / WIND_DRIVEN_MAX_CONVECTIVE_NUMBER) /
    Math.log(PLUME_DOMINATED_MIN_CONVECTIVE_NUMBER / WIND_DRIVEN_MAX_CONVECTIVE_NUMBER)
  );
}

// ---------------------------------------------------------------------------------------
// Assumed effects (labelled)
// ---------------------------------------------------------------------------------------

/**
 * ASSUMPTION: surface indraft speed at full plume dominance, as a share of Byram's buoyant
 * velocity U_B. Convection columns draw surface air toward the fire (observed indrafts of a few
 * m/s at large fires); no source fixes the share, so it is set so that in calm air a
 * 10,000 kW/m front (U_B about 8 m/s) draws about 1.6 m/s, and at N_c = 10 (U_B = 2.15 x the
 * relative wind) the head wind is cut by about 43%.
 */
export const INDRAFT_SPEED_FRACTION_OF_BUOYANT_VELOCITY = 0.2;
/**
 * ASSUMPTION: the indraft reaches this many equivalent radii of the fire's active area (cells
 * that ignited in the last `PLUME_MEMORY_MINUTES`) from its intensity-weighted centre, tapering
 * linearly to zero there. Scales the reach with the size of what is burning now.
 */
export const INDRAFT_RADIUS_FACTOR = 2;
/** ASSUMPTION: floor on that reach, in solver cells, so a young fire still has one. */
export const INDRAFT_MIN_RADIUS_CELLS = 3;
/**
 * ASSUMPTION: how long a cell counts toward the fire's active centre, minutes: flaming plus the
 * persistence of the column it fed. Of order the 10-minute weather step times six.
 */
export const PLUME_MEMORY_MINUTES = 60;
/**
 * ASSUMPTION: standard deviation of the extra wind-direction offset at full plume dominance,
 * degrees (draw clamped to +/- 2 sigma). Plume-dominated fires spread erratically; this is
 * several times the 2-3 degree turbulence spread of the ambient wind wander (stochastic.ts).
 */
export const PLUME_DIRECTION_SIGMA_DEGREES = 30;
export const PLUME_DIRECTION_CLAMP_SIGMAS = 2;
/**
 * ASSUMPTION: multiplier on the firebrand launch probability at full plume dominance. Strong
 * vertical columns loft more and larger brands than a bent-over wind-driven plume (qualitative
 * consensus of the firebrand literature, e.g. Koo et al. 2010, Int. J. Wildland Fire 19:818-843);
 * no source gives a factor.
 */
export const PLUME_SPOT_LAUNCH_MULTIPLIER = 3;

/** Air temperature used when the weather gives none, K (the stochastic module's 86 F). */
export const DEFAULT_AIR_TEMPERATURE_K = ((DEFAULT_AIR_TEMPERATURE_F - 32) * 5) / 9 + 273.15;

export function kelvinOfFahrenheit(fahrenheit: number): number {
  return ((fahrenheit - 32) * 5) / 9 + 273.15;
}

/** What the fire-induced wind did in one solve. Simulated, not observed. */
export interface FireInducedWindSummary {
  evidence: "simulated";
  seed: number;
  /** Cells whose N_c was evaluated (ignited cells with intensity > 0). */
  cellsEvaluated: number;
  /** Ignited cells in the mixed regime (2 < N_c < 10) and the plume-dominated one (N_c >= 10). */
  cellsMixed: number;
  cellsPlumeDominated: number;
  /** Cells whose wind an indraft actually changed. */
  cellsWithIndraft: number;
  /** Largest finite N_c seen, and the cells where U - R was too small for a finite one. */
  maxFiniteConvectiveNumber: number;
  cellsUnboundedConvectiveNumber: number;
  /** Largest indraft speed added, m/s. */
  maxIndraftMetersPerSecond: number;
}
