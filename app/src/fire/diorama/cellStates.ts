/**
 * Per-cell fire state codes the diorama understands (`FireDioramaSceneApi.setCellStates`), and the
 * colours it draws them in. No three.js import, so pure classifiers (demo/fireVisualState.ts) can
 * use the codes without pulling in the renderer.
 *
 * Codes 0-3 keep their original meaning (a caller that only knows burning / burned out / put out
 * still works). Codes 4-9 are the legible states: smouldering, and the flaming front split by
 * the Hauling chart's flame-length bands (PMS 465 p.12, Fig. 2; Andrews & Rothermel 1982) plus
 * crown fire. `CELL_CONTAINED_BIT` is OR'd into a code when the cell's fire is contained or out
 * at the drawn minute: its perimeter is drawn cool instead of warm.
 */

export const CELL_STATE = {
  unburned: 0,
  /** Burning, flame length not classified (the arrival-window rule, or a caller with no flame data). */
  burning: 1,
  /** Its modelled fuel has finished flaming, no ember glow left: ash-grey char, quiet. */
  burnedOut: 2,
  /** Put out by suppression: wet slate with a pale hatch and a dashed cool outline. */
  extinguished: 3,
  /** Past its flaming time and within the smoulder window: ember glow that fades (heat channel). */
  smouldering: 4,
  /** Flaming front, surface flame < 4 ft: hand crews can hold it (Hauling chart). */
  flameLow: 5,
  /** 4-8 ft: engines and dozers. */
  flameModerate: 6,
  /** 8-11 ft: serious control problems, aircraft / indirect attack. */
  flameHigh: 7,
  /** > 11 ft: crowning, spotting, major runs; control efforts at the head ineffective. */
  flameExtreme: 8,
  /** The cell torches or crowns (solver crown type 1 passive or 2 active). */
  crown: 9,
} as const;

/** Set on a cell whose fire is contained or out at the drawn minute (the low bits are the code). */
export const CELL_CONTAINED_BIT = 0x80;
/** Mask for the state code part of a cell byte. */
export const CELL_CODE_MASK = 0x7f;
/** Highest code the scene understands. */
export const CELL_STATE_MAX = CELL_STATE.crown;

/** True for every code that is an open flame (drawn with flames, glow and smoke). */
export function isFlamingCode(code: number): boolean {
  return code === CELL_STATE.burning || (code >= CELL_STATE.flameLow && code <= CELL_STATE.crown);
}

/**
 * Flame band of a code, 0 (none or unclassified) .. 5 (crown): the GPU and the flame meshes
 * scale colour and height by it.
 */
export function flameBand(code: number): number {
  return code >= CELL_STATE.flameLow && code <= CELL_STATE.crown ? code - CELL_STATE.flameLow + 1 : 0;
}

/**
 * Colours of the legible fire states (sRGB hex), shared by the terrain shader, the flame meshes and
 * the legend swatches, so the legend always shows what the board draws. A sequential ramp from
 * deep red (low flames) to pale yellow-white (crown), as glowing fire reads hotter toward white.
 */
export const FIRE_STATE_COLORS = {
  flameLow: 0xc0281a,
  flameModerate: 0xf26a1b,
  flameHigh: 0xffb01f,
  flameExtreme: 0xffe27a,
  crown: 0xfff6d8,
  /** Ember glow of smouldering ground. */
  ember: 0xd2401a,
  /** Burned-out ground: ash grey over char. */
  ash: 0x4a4644,
  /** Perimeter of a burning fire (warm) and of a contained or out fire (cool). */
  perimeterBurning: 0xffd18c,
  perimeterContained: 0x5aa8ff,
} as const;

/** Flame band colours in band order 1..5 (FIRE_STATE_COLORS). */
export const FLAME_BAND_COLORS: readonly number[] = [
  FIRE_STATE_COLORS.flameLow,
  FIRE_STATE_COLORS.flameModerate,
  FIRE_STATE_COLORS.flameHigh,
  FIRE_STATE_COLORS.flameExtreme,
  FIRE_STATE_COLORS.crown,
];
