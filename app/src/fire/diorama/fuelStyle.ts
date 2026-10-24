import { FUEL_MODELS } from "../fuelModels";
import { FUEL_COLORS } from "../fuelPalette";

/**
 * Presentation grouping of LANDFIRE FBFM40 codes for the diorama. This is how a cell is
 * *drawn* (ground tone, what stands on it); it never feeds the model.
 */
export const FuelFamily = {
  None: 0,
  Grass: 1,
  GrassShrub: 2,
  Shrub: 3,
  TimberUnderstory: 4,
  TimberLitter: 5,
  Slash: 6,
  Urban: 7,
  Snow: 8,
  Agriculture: 9,
  Water: 10,
  Barren: 11,
} as const;
export type FuelFamily = (typeof FuelFamily)[keyof typeof FuelFamily];

export function fuelFamily(code: number): FuelFamily {
  switch (code) {
    case 91:
      return FuelFamily.Urban;
    case 92:
      return FuelFamily.Snow;
    case 93:
      return FuelFamily.Agriculture;
    case 98:
      return FuelFamily.Water;
    case 99:
      return FuelFamily.Barren;
  }
  if (!FUEL_MODELS.has(code)) return FuelFamily.None;
  if (code < 120) return FuelFamily.Grass;
  if (code < 140) return FuelFamily.GrassShrub;
  if (code < 160) return FuelFamily.Shrub;
  if (code < 180) return FuelFamily.TimberUnderstory;
  if (code < 200) return FuelFamily.TimberLitter;
  return FuelFamily.Slash;
}

/** Miniature ground tones per family (sRGB hex), in the /diorama palette's register. */
export const GROUND_COLORS: Record<FuelFamily, number> = {
  [FuelFamily.None]: 0xc2b9a6,
  [FuelFamily.Grass]: 0xd0c698,
  [FuelFamily.GrassShrub]: 0xb9b68a,
  [FuelFamily.Shrub]: 0x848a5b,
  [FuelFamily.TimberUnderstory]: 0x6f8c5b,
  [FuelFamily.TimberLitter]: 0x587650,
  [FuelFamily.Slash]: 0x80795a,
  [FuelFamily.Urban]: 0xd9d1c2,
  [FuelFamily.Snow]: 0xf5f4ef,
  [FuelFamily.Agriculture]: 0xc4c48c,
  [FuelFamily.Water]: 0x7fae9f,
  [FuelFamily.Barren]: 0xd6cbb4,
};

/** Alternating furrow tones for agricultural (93) fields. */
export const FIELD_STRIPES = [0xc9c58e, 0xd8c993, 0xa9b47c, 0xbfae7e] as const;

const legend = (label: string) => {
  const entry = FUEL_COLORS.find((e) => e.label.startsWith(label));
  if (!entry) throw new Error(`Fire diorama: fuel legend entry "${label}" missing`);
  return parseInt(entry.color.slice(1), 16);
};

/** Fuel-overlay tints: the page's fuel legend (`../fuelPalette.ts`), so legend and board match. */
export const OVERLAY_COLORS: Record<FuelFamily, number> = {
  [FuelFamily.None]: legend("Non-burnable"),
  [FuelFamily.Grass]: legend("Grass (GR)"),
  [FuelFamily.GrassShrub]: legend("Grass-shrub"),
  [FuelFamily.Shrub]: legend("Shrub"),
  [FuelFamily.TimberUnderstory]: legend("Timber understory"),
  [FuelFamily.TimberLitter]: legend("Timber litter"),
  [FuelFamily.Slash]: legend("Slash"),
  [FuelFamily.Urban]: legend("Non-burnable"),
  [FuelFamily.Snow]: legend("Non-burnable"),
  [FuelFamily.Agriculture]: legend("Non-burnable"),
  /** Water keeps the old map's blue so it does not read as developed ground. */
  [FuelFamily.Water]: 0x3c5a78,
  [FuelFamily.Barren]: legend("Non-burnable"),
};

/**
 * Canopy-cover fallback (0..1) per family, used only when the canopy rasters failed to
 * load, so forests still read as forests.
 */
export const FALLBACK_CANOPY: Record<FuelFamily, number> = {
  [FuelFamily.None]: 0,
  [FuelFamily.Grass]: 0.02,
  [FuelFamily.GrassShrub]: 0.06,
  [FuelFamily.Shrub]: 0.08,
  [FuelFamily.TimberUnderstory]: 0.5,
  [FuelFamily.TimberLitter]: 0.65,
  [FuelFamily.Slash]: 0.25,
  [FuelFamily.Urban]: 0.15,
  [FuelFamily.Snow]: 0,
  [FuelFamily.Agriculture]: 0,
  [FuelFamily.Water]: 0,
  [FuelFamily.Barren]: 0,
};

/** Share of trees drawn as conifers (pines) per family; the rest are round broadleaf. */
export const PINE_SHARE: Record<FuelFamily, number> = {
  [FuelFamily.None]: 0.4,
  [FuelFamily.Grass]: 0.2,
  [FuelFamily.GrassShrub]: 0.25,
  [FuelFamily.Shrub]: 0.3,
  [FuelFamily.TimberUnderstory]: 0.55,
  [FuelFamily.TimberLitter]: 0.75,
  [FuelFamily.Slash]: 0.6,
  [FuelFamily.Urban]: 0.15,
  [FuelFamily.Snow]: 0.8,
  [FuelFamily.Agriculture]: 0.1,
  [FuelFamily.Water]: 0,
  [FuelFamily.Barren]: 0.5,
};

/** Low-bush density (bushes per cell before thinning) per family. */
export const BUSH_DENSITY: Record<FuelFamily, number> = {
  [FuelFamily.None]: 0,
  [FuelFamily.Grass]: 0.02,
  [FuelFamily.GrassShrub]: 0.28,
  [FuelFamily.Shrub]: 0.6,
  [FuelFamily.TimberUnderstory]: 0.12,
  [FuelFamily.TimberLitter]: 0.03,
  [FuelFamily.Slash]: 0.2,
  [FuelFamily.Urban]: 0.04,
  [FuelFamily.Snow]: 0,
  [FuelFamily.Agriculture]: 0,
  [FuelFamily.Water]: 0,
  [FuelFamily.Barren]: 0.02,
};
