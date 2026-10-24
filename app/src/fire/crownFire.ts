/**
 * Crown fire: whether a surface fire climbs into the canopy, and how fast it then runs.
 *
 * Rothermel surface spread alone is far slower than observed forest fires — our timber
 * fuel models give 4 to 29 m/min against published forest rates an order of magnitude
 * higher. Calibration against live LANDFIRE fuels showed the surface model itself is
 * sound (it reproduces Andrews RMRS-GTR-371 2018 Table 17 to 3-4 significant figures and
 * lands within ~1.5x of the observed Palisades Fire in chaparral), so the gap is a
 * missing mechanism, not a miscalibrated coefficient. This module sits above the surface
 * model rather than modifying it.
 *
 * Sources, cited again at each equation:
 *   Van Wagner (1977), Can. J. For. Res. 7:23-34 — crown fire initiation from canopy base
 *     height and foliar moisture (eq. 4), and the critical mass flow rate separating
 *     passive from active crown fire.
 *   Scott & Reinhardt (2001), RMRS-RP-29 — surface, passive and active crown fire as one
 *     sequence, the transition and active ratios, and crown fraction burned.
 *   Cruz, Alexander & Wakimoto (2005), Can. J. For. Res. 35:1626-1639 — active crown rate
 *     of spread from 10 m wind, canopy bulk density and fine fuel moisture.
 *   Albini & Baughman (1979), INT-221, as presented in Andrews (2012), RMRS-GTR-266 —
 *     the wind adjustment factor for sheltered and unsheltered fuel.
 *   Rothermel (1983), INT-143 — the measured wind adjustment factor range this module
 *     refuses to extrapolate below.
 *
 * UNITS. This module is metric throughout: metres, kW/m, kg/m^3, m/min, with percent only
 * inside the empirical equations that were published in percent. `rothermel.ts` is
 * Imperial and reports ft/min and Btu/ft/s; `spread.ts` converts at the call boundary
 * using its own named `KW_PER_METER_PER_BTU_PER_FOOT_PER_SECOND` (1 Btu/ft/s = 3.4613
 * kW/m). Nothing in this file accepts an Imperial value except `fuelBedDepthFeet`, which
 * says so in its name. A silent unit slip here would move every crown-initiation
 * threshold by a factor of 3.5 without changing anything visible on screen.
 *
 * A zeroed `CanopyCell` means TREELESS, not UNKNOWN. When the canopy rasters are missing
 * (`LandscapeGrid.canopyComplete === false`) the caller must skip crown fire entirely and
 * keep the flat scenario midflame factor, rather than passing zeros and reading the
 * surface-only answer as a statement about bare ground.
 *
 * Deterministic: no randomness anywhere in this file.
 */

export interface CanopyCell {
  /** Height to the base of the live crown, metres. 0 where there is no canopy. */
  baseHeightMeters: number;
  /** Canopy bulk density, kilograms per cubic metre. 0 where there is no canopy. */
  bulkDensityKgPerM3: number;
  /** Canopy cover as a fraction from 0 to 1. */
  coverFraction: number;
  /** Stand height, metres. 0 where there is no canopy. */
  heightMeters: number;
}

export type CrownFireType = "surface" | "passive" | "active";

export interface CrownFireResult {
  type: CrownFireType;
  /** Head rate of spread to propagate with, metres per minute. */
  rateMetersPerMinute: number;
  /** The surface head rate it was compared against, metres per minute. */
  surfaceRateMetersPerMinute: number;
  /** Van Wagner critical surface intensity for crown initiation, kW/m. */
  criticalSurfaceIntensityKwPerM: number;
  surfaceIntensityKwPerM: number;
  /**
   * Van Wagner critical mass flow criterion, dimensionless; >= 1 means the canopy is
   * dense enough to carry an active crown fire at this wind. It is a property of the
   * canopy and the weather alone and says nothing about whether the canopy has ignited:
   * `type` is "active" only when this reaches 1 AND the surface fire has reached
   * `criticalSurfaceIntensityKwPerM`. `type` is the authoritative field.
   */
  activeRatio: number;
  /** Share of the canopy consumed, 0 to 1. */
  crownFractionBurned: number;
}

/**
 * Live foliar moisture, fraction of dry weight. 1.0 (100 percent) is the standard value
 * for western conifers in Van Wagner (1977) and Scott & Reinhardt (2001), and the
 * FARSITE/FlamMap default. Seasonal values run roughly 85 to 130 percent.
 */
export const DEFAULT_FOLIAR_MOISTURE_FRACTION = 1.0;

/** Below this cover fraction a stand is too open to carry crown fire. */
export const MIN_CROWN_COVER_FRACTION = 0.1;
/** Below this bulk density the canopy is too sparse to sustain active crowning, kg/m3. */
export const MIN_CROWN_BULK_DENSITY_KG_PER_M3 = 0.01;

/**
 * Van Wagner (1977) eq. 4 coefficients for I_0 = (C * CBH * (460 + 25.9 * M))^1.5, with
 * CBH in metres, M the foliar moisture content in percent and I_0 in kW/m. 460 kJ/kg is
 * the heat needed to bring foliage to ignition and 25.9 kJ/kg the extra heat per percent
 * of moisture. Van Wagner's own worked example, 6 m base height at 100 percent foliar
 * moisture, gives 2476 kW/m, which this reproduces.
 */
export const VAN_WAGNER_INITIATION_COEFFICIENT = 0.01;
export const VAN_WAGNER_IGNITION_HEAT_KJ_PER_KG = 460;
export const VAN_WAGNER_MOISTURE_HEAT_KJ_PER_KG_PER_PERCENT = 25.9;

/**
 * Van Wagner's critical mass flow rate through the canopy, kg per square metre per second.
 * Active crown fire needs a crown rate of at least this divided by bulk density, so a
 * stand at 0.15 kg/m3 demands 20 m/min and one at 0.05 kg/m3 demands 60 m/min.
 */
export const CRITICAL_MASS_FLOW_RATE_KG_PER_M2_PER_S = 0.05;

/** Scott & Reinhardt (2001): the crown fire is active once the active ratio reaches 1. */
export const ACTIVE_CROWN_RATIO_THRESHOLD = 1;

/**
 * Cruz, Alexander & Wakimoto (2005) eq. 6, the CFIS active crown fire rate of spread:
 *
 *   R_active = 11.02 * U10^0.90 * CBD^0.19 * exp(-0.17 * EFFM)
 *
 * R_active in m/min, U10 the 10 m open wind in km/h, CBD in kg/m3, EFFM the estimated
 * fine fuel moisture in percent.
 */
export const CRUZ_COEFFICIENT = 11.02;
export const CRUZ_WIND_EXPONENT = 0.9;
export const CRUZ_BULK_DENSITY_EXPONENT = 0.19;
export const CRUZ_MOISTURE_COEFFICIENT = -0.17;

/**
 * Fine fuel moisture is held to roughly the span of the Cruz et al. (2005) calibration
 * data before entering the exponential. At 1 to 2 percent the exponential inflates the
 * rate by a factor the source cannot support, and above about 18 percent crown fire was
 * not observed at all in that dataset.
 */
export const CRUZ_MIN_FINE_FUEL_MOISTURE_PERCENT = 3;
export const CRUZ_MAX_FINE_FUEL_MOISTURE_PERCENT = 18;

/**
 * Ceiling on crown rate of spread, metres per minute. Cruz et al. is a regression and
 * extrapolates without bound: at a 40 mph 20-foot wind it already returns about 133 m/min,
 * past anything in its calibration data. Documented sustained conifer crown fire runs top
 * out near 100 m/min — the Camp Fire's fastest sustained push was about 91 m/min — so the
 * model is capped at a number that can be pointed at an observation rather than emitting
 * whatever the fit produces.
 */
export const MAX_ACTIVE_CROWN_RATE_METERS_PER_MINUTE = 100;

/**
 * US fire weather reports a 20-foot open wind; Cruz et al. (2005) is formulated on the
 * 10 m open wind used in Canada and Australia. Turner & Lawson (1978) give
 * U_20ft = 0.87 * U_10m, so U_10m = 1.15 * U_20ft; Scott & Reinhardt (2001) and CFIS use
 * the same ratio. `FireScenario.windSpeedMph` is documented as the 20-foot wind, so
 * `openWindSpeedMph` is treated as a 20-foot wind everywhere in this module.
 */
export const TEN_METER_WIND_PER_TWENTY_FOOT_WIND = 1.15;

/** A stand shorter than this does not shelter the fuel bed beneath it, feet. */
export const MIN_SHELTERING_CANOPY_HEIGHT_FEET = 6;
/** Albini & Baughman's sheltered branch applies above this canopy cover (FARSITE's rule). */
export const MIN_SHELTERING_COVER_FRACTION = 0.05;
/**
 * Floor on the wind adjustment factor. Rothermel (1983, INT-143) tabulates 0.1 to 0.2 for
 * fuel fully sheltered beneath a timber stand and Andrews (2012, RMRS-GTR-266) recommends
 * 0.2 as the sheltered default when stand data is unavailable. The Albini & Baughman
 * equation falls below that whole measured range for very tall closed stands — about 0.04
 * for a 30 m redwood canopy — which is extrapolation past any measurement behind it. The
 * factor is therefore floored at the bottom of the published range rather than allowed to
 * tend to zero. This is the one number here chosen from a tabulated range rather than
 * computed, and it matters: halving it roughly halves surface fireline intensity under
 * forest and moves where crown fire initiates.
 */
export const MIN_WIND_ADJUSTMENT_FACTOR = 0.1;
/** Fuel bed depth floor, feet; the logarithmic profile diverges as depth goes to zero. */
export const MIN_FUEL_BED_DEPTH_FEET = 0.1;

const METERS_PER_FOOT = 0.3048;
const KM_PER_HOUR_PER_MPH = 1.609344;

/**
 * Van Wagner (1977) eq. 4: the surface fireline intensity needed to ignite the crown,
 * from canopy base height in metres and foliar moisture as a fraction of dry weight.
 * Returns kW/m.
 */
export function criticalSurfaceIntensityKwPerM(
  canopyBaseHeightMeters: number,
  foliarMoistureFraction: number,
): number {
  if (canopyBaseHeightMeters <= 0) return 0;
  const foliarMoisturePercent = Math.max(foliarMoistureFraction, 0) * 100;
  const heatTerm =
    VAN_WAGNER_IGNITION_HEAT_KJ_PER_KG +
    VAN_WAGNER_MOISTURE_HEAT_KJ_PER_KG_PER_PERCENT * foliarMoisturePercent;
  return Math.pow(VAN_WAGNER_INITIATION_COEFFICIENT * canopyBaseHeightMeters * heatTerm, 1.5);
}

/**
 * Van Wagner's critical crown fire spread rate, metres per minute: the slowest a crown
 * fire can move and still draw the critical mass flow of canopy fuel through the flame
 * front. Scott & Reinhardt (2001) compare the actual crown rate against this.
 */
export function criticalActiveCrownRateMetersPerMinute(bulkDensityKgPerM3: number): number {
  if (bulkDensityKgPerM3 <= 0) return Number.POSITIVE_INFINITY;
  return (CRITICAL_MASS_FLOW_RATE_KG_PER_M2_PER_S * 60) / bulkDensityKgPerM3;
}

/**
 * Cruz, Alexander & Wakimoto (2005) active crown rate of spread, metres per minute, from
 * the 20-foot open wind in mph, canopy bulk density in kg/m3 and fine fuel moisture as a
 * fraction of dry weight.
 *
 * WHY CRUZ AND NOT ROTHERMEL (1991). Rothermel (1991, INT-438) sets the active crown rate
 * at 3.34x the Anderson Fuel Model 10 surface rate run at 0.4 of the 20-foot wind. Two
 * reasons it is not used here. Inputs: this module is handed one fine fuel moisture, not
 * the five-class moisture vector and fuel bed an FM10 Rothermel run needs, and FM10 is an
 * Anderson (1982) 13-model entry absent from our Scott & Burgan SB40 table, so supplying
 * either would mean inventing inputs rather than reading them. Behaviour: the 3.34 factor
 * is a correlation fitted to eight northern Rocky Mountain crown fires and carries no
 * canopy bulk density term, so it cannot tell a dense Douglas-fir stand from an open
 * woodland — exactly the distinction this simulator has to make in the Santa Cruz
 * Mountains. Cruz et al. is fitted to 58 conifer crown fires, takes bulk density directly,
 * and is the model behind CFIS. The two are NOT averaged; Cruz is used alone.
 */
export function activeCrownRateMetersPerMinute(
  openWindSpeedMph: number,
  bulkDensityKgPerM3: number,
  fineFuelMoistureFraction: number,
): number {
  if (bulkDensityKgPerM3 <= 0) return 0;
  const tenMeterWindKmPerHour =
    Math.max(openWindSpeedMph, 0) * TEN_METER_WIND_PER_TWENTY_FOOT_WIND * KM_PER_HOUR_PER_MPH;
  const fineFuelMoisturePercent = clamp(
    Math.max(fineFuelMoistureFraction, 0) * 100,
    CRUZ_MIN_FINE_FUEL_MOISTURE_PERCENT,
    CRUZ_MAX_FINE_FUEL_MOISTURE_PERCENT,
  );
  const rate =
    CRUZ_COEFFICIENT *
    Math.pow(Math.max(tenMeterWindKmPerHour, 0.1), CRUZ_WIND_EXPONENT) *
    Math.pow(bulkDensityKgPerM3, CRUZ_BULK_DENSITY_EXPONENT) *
    Math.exp(CRUZ_MOISTURE_COEFFICIENT * fineFuelMoisturePercent);
  return Math.min(rate, MAX_ACTIVE_CROWN_RATE_METERS_PER_MINUTE);
}

/**
 * Wind adjustment factor: the share of the 20-foot open wind that reaches midflame height
 * in this cell, 0 to 1. Export it so the solver can replace its flat 0.5.
 *
 * Unsheltered, with the fuel bed depth h in feet (Albini & Baughman 1979, as Andrews 2012
 * RMRS-GTR-266 presents it):
 *
 *   WAF = 1.83 / ln((20 + 0.36 * h) / (0.13 * h))
 *
 * This reproduces the published per-fuel-model table exactly: 0.36 at 1 ft (grass, FM1),
 * 0.42 at 2 ft, 0.44 at 2.5 ft, 0.46 at 3 ft, 0.55 at 6 ft (chaparral, FM4).
 *
 * Sheltered, under a canopy, with the stand height H in feet and f the crown fill portion:
 *
 *   WAF = 0.555 / (sqrt(f * H) * ln((20 + 0.36 * H) / (0.13 * H)))
 *
 * f is the share of the stand volume occupied by live crown — canopy cover times crown
 * ratio — and both terms are read straight off the canopy rasters, crown ratio as
 * (height - base height) / height. Implementations without a crown ratio substitute
 * cover/3; we have the base height, so we use it.
 *
 * CONSEQUENCE, STATED ON PURPOSE. The solver previously applied a flat 0.5 everywhere.
 * That is 1.2 to 1.7x above the Albini & Baughman value for 8 of 10 fuel models in open
 * fuel, and under a closed conifer canopy the true factor is near 0.1 — a fivefold
 * difference. Adopting this function therefore makes SURFACE spread under forest much
 * slower than it was. That is not a regression and must not be "fixed" by raising the
 * factor back: in real forest the fast spread comes from the canopy, not the litter
 * layer, and crown fire is what supplies it above. The two halves only make sense
 * together, and a run with this factor but without crown fire will look too slow.
 */
export function windAdjustmentFactor(canopy: CanopyCell, fuelBedDepthFeet: number): number {
  // The solver treats this as total and bounded for every cell, so a non-finite depth
  // falls back to the floor depth rather than propagating NaN into a cell's spread rate,
  // which would silently make that cell unburnable. A non-finite canopy field fails the
  // `shelters` comparisons below and the cell is treated as unsheltered.
  const depthFeet = Number.isFinite(fuelBedDepthFeet)
    ? Math.max(fuelBedDepthFeet, MIN_FUEL_BED_DEPTH_FEET)
    : MIN_FUEL_BED_DEPTH_FEET;
  const unsheltered = 1.83 / logWindProfile(depthFeet);

  const canopyHeightFeet = Math.max(canopy.heightMeters, 0) / METERS_PER_FOOT;
  const crownFillPortion = clamp(canopy.coverFraction, 0, 1) * crownRatioOf(canopy);
  const shelters =
    canopy.coverFraction >= MIN_SHELTERING_COVER_FRACTION &&
    canopyHeightFeet >= MIN_SHELTERING_CANOPY_HEIGHT_FEET &&
    crownFillPortion > 0;
  if (!shelters) return clamp(unsheltered, MIN_WIND_ADJUSTMENT_FACTOR, 1);

  const sheltered =
    0.555 / (Math.sqrt(crownFillPortion * canopyHeightFeet) * logWindProfile(canopyHeightFeet));
  // Our guard, not Albini & Baughman's: an overstory can only slow the wind reaching the
  // fuel bed, so a short sparse canopy never raises the factor above the open-fuel value.
  return clamp(Math.min(unsheltered, sheltered), MIN_WIND_ADJUSTMENT_FACTOR, 1);
}

/**
 * Decide the fire type for one cell and return the rate to propagate with.
 *
 * `surfaceFirelineIntensityKwPerM` must already be metric; `rothermel.ts` reports
 * Btu/ft/s and `spread.ts` multiplies by 3.4613 at the call. `openWindSpeedMph` is the
 * 20-foot open wind. `fineFuelMoistureFraction` is the dead 1-hour moisture as a fraction
 * (0.06 is 6 percent).
 */
/**
 * Whether this canopy can carry an active crown fire that is already burning into it.
 *
 * This is Van Wagner's critical mass flow criterion on its own, with no reference to the
 * cell's own surface fireline intensity. It answers a different question from
 * `criticalSurfaceIntensityKwPerM`: that one asks whether a SURFACE fire here is intense
 * enough to climb into the crowns, while this asks whether the canopy is dense enough to
 * sustain a crown fire that started somewhere else. An established crown fire carries
 * itself through continuous canopy, so requiring every cell to re-initiate from its own
 * sheltered surface fire understates forest spread badly — the under-prediction Cruz &
 * Alexander (2010) identify in linked Rothermel/Van Wagner models.
 */
export function canSustainActiveCrown(
  canopy: CanopyCell,
  openWindSpeedMph: number,
  fineFuelMoistureFraction: number,
): boolean {
  if (
    canopy.heightMeters <= 0 ||
    canopy.coverFraction < MIN_CROWN_COVER_FRACTION ||
    canopy.bulkDensityKgPerM3 < MIN_CROWN_BULK_DENSITY_KG_PER_M3
  ) {
    return false;
  }
  const activeRate = activeCrownRateMetersPerMinute(
    openWindSpeedMph,
    canopy.bulkDensityKgPerM3,
    fineFuelMoistureFraction,
  );
  const criticalRate = criticalActiveCrownRateMetersPerMinute(canopy.bulkDensityKgPerM3);
  return criticalRate > 0 && activeRate / criticalRate >= ACTIVE_CROWN_RATIO_THRESHOLD;
}

export function crownFireBehaviour(
  surfaceRateMetersPerMinute: number,
  surfaceFirelineIntensityKwPerM: number,
  canopy: CanopyCell,
  openWindSpeedMph: number,
  fineFuelMoistureFraction: number,
  foliarMoistureFraction: number = DEFAULT_FOLIAR_MOISTURE_FRACTION,
): CrownFireResult {
  const surfaceRate = Math.max(surfaceRateMetersPerMinute, 0);
  const surfaceIntensity = Math.max(surfaceFirelineIntensityKwPerM, 0);
  const noCrown = (criticalIntensity: number, activeRatio: number): CrownFireResult => ({
    type: "surface",
    rateMetersPerMinute: surfaceRate,
    surfaceRateMetersPerMinute: surfaceRate,
    criticalSurfaceIntensityKwPerM: criticalIntensity,
    surfaceIntensityKwPerM: surfaceIntensity,
    activeRatio,
    crownFractionBurned: 0,
  });

  // Guard rail: no canopy, or one too open or too sparse to carry fire in the crowns.
  // The surface answer passes through untouched and the thresholds read as not applicable.
  if (
    surfaceRate <= 0 ||
    canopy.baseHeightMeters <= 0 ||
    canopy.heightMeters <= 0 ||
    canopy.coverFraction < MIN_CROWN_COVER_FRACTION ||
    canopy.bulkDensityKgPerM3 < MIN_CROWN_BULK_DENSITY_KG_PER_M3
  ) {
    return noCrown(0, 0);
  }

  const criticalIntensity = criticalSurfaceIntensityKwPerM(
    canopy.baseHeightMeters,
    foliarMoistureFraction,
  );
  const activeRate = activeCrownRateMetersPerMinute(
    openWindSpeedMph,
    canopy.bulkDensityKgPerM3,
    fineFuelMoistureFraction,
  );
  const criticalCrownRate = criticalActiveCrownRateMetersPerMinute(canopy.bulkDensityKgPerM3);
  // Scott & Reinhardt's active ratio: the rate this canopy can actually achieve against
  // the rate its own bulk density demands.
  const activeRatio = Number.isFinite(criticalCrownRate) ? activeRate / criticalCrownRate : 0;

  // Scott & Reinhardt's transition ratio: surface intensity against Van Wagner's I_0.
  // Below it the canopy never ignites, however dense it is.
  if (surfaceIntensity < criticalIntensity) return noCrown(criticalIntensity, activeRatio);

  // Scott & Reinhardt classify on the two ratios and nothing else. Once the canopy has
  // ignited and the mass flow criterion is met the fire is active and the crown fraction
  // burned is 1 by definition — it is NOT gated on the surface fire also being fast,
  // which would make active crown fire unreachable under any sheltered canopy.
  if (activeRatio >= ACTIVE_CROWN_RATIO_THRESHOLD) {
    return {
      type: "active",
      // Guard rail: a crown fire is never slower than the surface fire that drives it.
      rateMetersPerMinute: Math.max(activeRate, surfaceRate),
      surfaceRateMetersPerMinute: surfaceRate,
      criticalSurfaceIntensityKwPerM: criticalIntensity,
      surfaceIntensityKwPerM: surfaceIntensity,
      activeRatio,
      crownFractionBurned: 1,
    };
  }

  // Passive (torching). Scott & Reinhardt interpolate linearly in surface spread rate
  // between R_initiation, where the surface fire is just intense enough to torch
  // individual trees, and the rate at which the canopy would go active. Byram's intensity
  // is linear in spread rate at a fixed heat per unit area, so R_initiation scales as
  // I_0 / I_surface.
  //
  // SIMPLIFICATION, LEFT VISIBLE. Scott & Reinhardt derive the upper anchor by inverting
  // Rothermel (1991), whose crown rate is a function of the surface rate. The Cruz rate is
  // not, so the upper anchor here is Van Wagner's critical crown rate itself — the same
  // quantity the active test uses. The linear ramp is Scott & Reinhardt's own stated
  // assumption rather than a measured relationship, and torching fires really are only
  // modestly faster than the surface fire beneath them, which is what this produces.
  const initiationRateMetersPerMinute = (surfaceRate * criticalIntensity) / surfaceIntensity;
  const span = criticalCrownRate - initiationRateMetersPerMinute;
  const crownFractionBurned =
    Number.isFinite(span) && span > 0
      ? clamp((surfaceRate - initiationRateMetersPerMinute) / span, 0, 1)
      : 1;
  const blendedRate = surfaceRate + crownFractionBurned * (activeRate - surfaceRate);

  return {
    type: "passive",
    rateMetersPerMinute: clamp(
      Math.max(blendedRate, surfaceRate),
      surfaceRate,
      Math.max(MAX_ACTIVE_CROWN_RATE_METERS_PER_MINUTE, surfaceRate),
    ),
    surfaceRateMetersPerMinute: surfaceRate,
    criticalSurfaceIntensityKwPerM: criticalIntensity,
    surfaceIntensityKwPerM: surfaceIntensity,
    activeRatio,
    crownFractionBurned,
  };
}

/**
 * The logarithmic wind profile denominator shared by both Albini & Baughman forms,
 * ln((20 + 0.36 * z) / (0.13 * z)) with z in feet and 20 ft the measurement height above
 * the vegetation.
 */
function logWindProfile(zFeet: number): number {
  return Math.log((20 + 0.36 * zFeet) / (0.13 * zFeet));
}

function crownRatioOf(canopy: CanopyCell): number {
  if (canopy.heightMeters <= 0) return 0;
  return clamp((canopy.heightMeters - canopy.baseHeightMeters) / canopy.heightMeters, 0, 1);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
