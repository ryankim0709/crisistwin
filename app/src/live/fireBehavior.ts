/**
 * Fire behaviour at the head of the live drill's fire (docs/live-fire-behavior.md): Rothermel
 * spread and flame length from the observed wind and slope the server sends
 * (`GET incidents/{id}/fire-behavior`), whether each apparatus can hold that flame (PMS 465
 * Hauling chart), and carless households in zones the fire touches or an order covers. Pure:
 * no React, network or LLM. The fire on the map stays the observed perimeter; these numbers are
 * a model of how hard its head is burning, labelled as such.
 *
 * Units. rothermel.ts is Imperial (ft/min, Btu/ft/s, feet); everything leaving this module is
 * metric (m/min, metres, m/s), except flame length, which stays in feet because the holding
 * limits it is compared with (PMS 465 Hauling chart) are published in feet. Names carry the unit.
 */

import { FUEL_MODELS, isBurnable, type FuelModel } from "../fire/fuelModels";
import { windAdjustmentFactor } from "../fire/crownFire";
import { prepareFuelBed, spreadFromBed, type FuelBed } from "../fire/rothermel";
import { MOISTURE_PRESETS, type FuelMoisture } from "../fire/spread";
import { GROUND_APPARATUS, GROUND_KINDS, dataValue, type GroundKind } from "../studio/apparatus";
import type { FireBehaviorResponse, ZoneGuidance } from "./types";

// ---- unit conversions (exact) ----

export const METERS_PER_FOOT = 0.3048;
/** 1 mph = 0.44704 m/s (exact, international mile). */
export const METERS_PER_SECOND_PER_MPH = 0.44704;
/** 1 mph = 88 ft/min (exact). */
export const FEET_PER_MINUTE_PER_MPH = 88;

export function metersPerSecondToFeetPerMinute(speedMetersPerSecond: number): number {
  return (speedMetersPerSecond / METERS_PER_SECOND_PER_MPH) * FEET_PER_MINUTE_PER_MPH;
}

// ---- fuel and moisture ----

/**
 * ASSUMPTION (fuel): Scott & Burgan (2005) SH5, high-load dry-climate shrub (FBFM40 code 145),
 * at the head. It is the fuel sim/fire.py (`DEFAULT_FUEL_MODEL`) and the Camp bundle's own fire
 * model use for the same reason: no LANDFIRE landscape covers the drill area, and SH5 stands for
 * the chaparral and manzanita of the Feather River canyon and the brushy understory of the
 * Paradise ridge.
 */
export const FALLBACK_FUEL_CODE = 145;
export const FUEL_LABEL = "SH5 shrub (assumed)";

/** Moisture scenario id from fire/spread.ts MOISTURE_PRESETS (Scott & Burgan 2005, Table 1). */
export type MoistureId = "critical" | "dry" | "moderate" | "wet";

/**
 * ASSUMPTION (moisture): the "critical" scenario (dead 1/10/100-h 3/4/5%, live herb 30%, live
 * woody 60%). These are the Camp bundle's own fire-model moisture fractions
 * (`fire_simulated.model.params.moisture_fractions`, "extreme"), consistent with the single-digit
 * relative humidity observed on 8 November 2018. Fuel moisture is not derived from the hourly
 * humidity.
 */
export const MOISTURE_ID: MoistureId = "critical";
export const MOISTURE_LABEL = "critical moisture (assumed)";

export function moistureOf(id: MoistureId): FuelMoisture {
  const preset = MOISTURE_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`no moisture preset ${id}`);
  return preset.moisture;
}

// ---- spread ----

export interface HeadRates {
  /** Head rate of spread, m/min. */
  headMetersPerMinute: number;
  /** Byram flame length at the head, feet. */
  headFlameFeet: number;
  firelineIntensityBtuPerFootPerSecond: number;
  /** Compass bearing of maximum spread (wind and slope combined as vectors), degrees true. */
  headingDegrees: number;
  /** Anderson (1983) length-to-breadth, capped at 8 (rothermel.ts MAX_LENGTH_TO_BREADTH). */
  lengthToBreadth: number;
  midflameWindMetersPerSecond: number;
  slopePercent: number;
  fuelCode: number;
}

/** Treeless cell for the Albini & Baughman unsheltered factor (no canopy data for the area). */
const OPEN_CANOPY = { baseHeightMeters: 0, bulkDensityKgPerM3: 0, coverFraction: 0, heightMeters: 0 };

const bedCache = new Map<string, FuelBed>();
function bedFor(fuel: FuelModel, moistureId: MoistureId): FuelBed {
  const key = `${fuel.code}|${moistureId}`;
  let bed = bedCache.get(key);
  if (!bed) {
    bed = prepareFuelBed(fuel, moistureOf(moistureId));
    bedCache.set(key, bed);
  }
  return bed;
}

/**
 * Rothermel (1972) surface spread at one fuel, slope and wind (fire/rothermel.ts, Andrews
 * RMRS-GTR-371 2018 formulation):
 * - midflame wind = open 20 ft wind x the Albini & Baughman (1979) unsheltered wind adjustment
 *   factor for the fuel bed depth (fire/crownFire.ts windAdjustmentFactor; no canopy data);
 * - wind and slope combined as vectors; length-to-breadth from the effective wind, Anderson (1983);
 * - flame length by Byram (1959) from the head fireline intensity.
 * Surface fire only: no crown fire (no canopy rasters for the area).
 */
export function headRates(
  fuelCode: number,
  slopeTangent: number,
  upslopeDegrees: number,
  wind: { speedMetersPerSecond: number; fromDegrees: number },
  moistureId: MoistureId,
): HeadRates | null {
  const fuel = FUEL_MODELS.get(fuelCode);
  if (!fuel || !isBurnable(fuelCode)) return null;
  const waf = windAdjustmentFactor(OPEN_CANOPY, fuel.depthFeet);
  const midflameFeetPerMinute = metersPerSecondToFeetPerMinute(wind.speedMetersPerSecond) * waf;
  const towardDegrees = (wind.fromDegrees + 180) % 360;
  const r = spreadFromBed(bedFor(fuel, moistureId), midflameFeetPerMinute, towardDegrees, slopeTangent, upslopeDegrees);
  return {
    headMetersPerMinute: r.headRateFeetPerMinute * METERS_PER_FOOT,
    headFlameFeet: r.flameLengthFeet,
    firelineIntensityBtuPerFootPerSecond: r.firelineIntensityBtuPerFootPerSecond,
    headingDegrees: r.headingDegrees,
    lengthToBreadth: r.lengthToBreadth,
    midflameWindMetersPerSecond: (midflameFeetPerMinute / FEET_PER_MINUTE_PER_MPH) * METERS_PER_SECOND_PER_MPH,
    slopePercent: slopeTangent * 100,
    fuelCode,
  };
}

/** Head rates for the server's inputs, or null without wind direction or a head point (calm, no fire). */
export function headBehavior(r: FireBehaviorResponse | null): HeadRates | null {
  if (!r?.available || !r.wind || r.wind.from_deg == null || !r.head) return null;
  return headRates(
    FALLBACK_FUEL_CODE,
    r.head.slope_tan,
    r.head.upslope_deg,
    { speedMetersPerSecond: r.wind.speed_20ft_ms, fromDegrees: r.wind.from_deg },
    MOISTURE_ID,
  );
}

// ---- holding (PMS 465 p.12, Hauling chart) ----

const LIMITS = dataValue<{
  hand_tools_direct_attack_head_max: number;
  serious_control_problems: [number, number];
  head_attack_ineffective_above: number;
}>("hand_crews.flame_length_limits_ft");

export type HoldBand = "hand" | "machine" | "serious" | "indirect";

/** Hauling chart band of a head flame length: up to 4 ft, 4-8 ft, 8-11 ft, above 11 ft. */
export function holdBand(flameFeet: number): HoldBand {
  if (flameFeet <= LIMITS.hand_tools_direct_attack_head_max) return "hand";
  if (flameFeet <= LIMITS.serious_control_problems[0]) return "machine";
  if (flameFeet <= LIMITS.head_attack_ineffective_above) return "serious";
  return "indirect";
}

export const HOLD_BAND_LABEL: Record<HoldBand, string> = {
  hand: "Hand crews, engines and dozers can hold the head",
  machine: "Engines and dozers can hold the head; hand line cannot",
  serious: "Head attack probably ineffective; flanks only",
  indirect: "No ground resource holds the head: aircraft or indirect line",
};

function groundKind(kind: string | null | undefined): GroundKind | null {
  return kind && (GROUND_KINDS as readonly string[]).includes(kind) ? (kind as GroundKind) : null;
}

export function apparatusShort(kind: string | null | undefined): string | null {
  const k = groundKind(kind);
  return k ? GROUND_APPARATUS[k].short : null;
}

/**
 * Whether the apparatus's line holds this head flame: GROUND_APPARATUS holdsFlameLengthFeet
 * (hand crews 4 ft, engines and dozers 8 ft). Null for an unknown kind or one that builds no line.
 */
export function canHold(kind: string | null | undefined, flameFeet: number): boolean | null {
  const k = groundKind(kind);
  if (!k) return null;
  const limit = GROUND_APPARATUS[k].holdsFlameLengthFeet;
  return limit > 0 ? flameFeet <= limit : null;
}

/** "T3 engine, holds 8 ft head" style phrase, or null when the kind is unknown. */
export function holdPhrase(kind: string | null | undefined, flameFeet: number | null): string | null {
  const short = apparatusShort(kind);
  if (!short) return null;
  if (flameFeet == null) return short;
  const hold = canHold(kind, flameFeet);
  if (hold == null) return `${short}, builds no line`;
  return `${short}, ${hold ? "can hold" : "cannot hold"} ${Math.round(flameFeet)} ft head`;
}

// ---- households without a vehicle ----

export interface NoVehicleZone {
  zoneId: string;
  households: number;
  moe: number | null;
  fire: boolean;
  order: boolean;
}

/** ACS carless households in zones the fire estimate touches or an evacuate-now order covers. */
export function noVehicleAtRisk(r: FireBehaviorResponse | null, guidance: ZoneGuidance[]): NoVehicleZone[] {
  if (!r?.available || !r.households_no_vehicle) return [];
  const touched = new Set(r.zones_fire_touches ?? []);
  const ordered = new Set(guidance.filter((g) => g.level === "evacuate_now").map((g) => g.zone_id));
  const out: NoVehicleZone[] = [];
  for (const [zoneId, v] of Object.entries(r.households_no_vehicle)) {
    const fire = touched.has(zoneId);
    const order = ordered.has(zoneId);
    if (v.households > 0 && (fire || order)) out.push({ zoneId, households: v.households, moe: v.moe, fire, order });
  }
  return out.sort((a, b) => b.households - a.households || a.zoneId.localeCompare(b.zoneId));
}
