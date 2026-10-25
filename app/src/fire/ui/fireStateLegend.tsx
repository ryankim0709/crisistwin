/**
 * Legend rows for the legible fire states (fire/fireStates.ts, drawn by the 3D diorama and the 2D
 * maps in fire/diorama/cellStates.ts FIRE_STATE_COLORS), shared by Studio and /fire so every
 * simulated-fire view explains its states the same way. Simulated data only; never for observed or
 * hindcast perimeters (/replay, historical dioramas).
 */

import { useId } from "react";
import type { LegendItem } from "../../ui";
import { BurnedGlyph, FireEdgeGlyph } from "../../diorama/ui/glyphs";
import { EXTINGUISHED_LEGEND } from "../diorama/board";
import { FIRE_STATE_COLORS } from "../diorama/cellStates";
import { SMOULDER_WINDOW_MINUTES } from "../fireStates";

/** sRGB hex number to CSS "#rrggbb". */
export const fireStateCss = (color: number): string => `#${color.toString(16).padStart(6, "0")}`;

/** A flame of the given colour and height (px of 16), for the flame-band rows. */
export function FlameGlyph({ color, height }: { color: number; height: number }) {
  const top = 15 - height;
  return (
    <svg width="24" height="16" viewBox="0 0 24 16" aria-hidden="true">
      <rect x="2" y="13" width="20" height="3" rx="1" fill="#2a1a14" />
      <path
        d={`M8 15 C8 ${top + height * 0.5} 11 ${top + height * 0.35} 12 ${top} C13 ${top + height * 0.35} 16 ${top + height * 0.5} 16 15Z`}
        fill={fireStateCss(color)}
        stroke="#5a1a0a"
        strokeWidth="0.6"
      />
    </svg>
  );
}

/** Dark ground with ember specks (smouldering). */
export function EmberGlyph() {
  return (
    <svg width="24" height="16" viewBox="0 0 24 16" aria-hidden="true">
      <rect x="2" y="2" width="20" height="12" rx="2" fill="#1a0d0a" />
      {[[6, 6], [11, 10], [16, 5], [18, 11], [9, 4]].map(([x, y]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r="1.3" fill={fireStateCss(FIRE_STATE_COLORS.ember)} />
      ))}
    </svg>
  );
}

/** Put-out ground: slate with a pale diagonal hatch and a dashed outline, no glow. */
export function ExtinguishedGlyph() {
  const id = useId();
  return (
    <svg width="24" height="16" viewBox="0 0 24 16" aria-hidden="true">
      <defs>
        <pattern id={id} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="4" height="4" fill={EXTINGUISHED_LEGEND.fill} />
          <line x1="0" y1="0" x2="0" y2="4" stroke={EXTINGUISHED_LEGEND.hatch} strokeWidth="1.4" />
        </pattern>
      </defs>
      <rect x="2" y="2" width="20" height="12" rx="2" fill={`url(#${id})`} stroke={EXTINGUISHED_LEGEND.edge} strokeWidth="1.4" strokeDasharray="3 2" />
    </svg>
  );
}

export interface FireStateLegendOptions {
  /** The view classifies flame bands (it has the solver's per-cell flame and crown); else one "burning" row. */
  flameBands: boolean;
  /** The view has fires that crews contain or put out (blue edge, put-out cells). */
  containment: boolean;
  /** The view has cells crews put out one by one (the command board's suppression). */
  putOutCells?: boolean;
}

/** The fire-state rows, same wording as the command board's 3D legend (demo/DemoDiorama.tsx). */
export function fireStateLegendItems({ flameBands, containment, putOutCells = false }: FireStateLegendOptions): LegendItem[] {
  const C = FIRE_STATE_COLORS;
  const rows: LegendItem[] = flameBands
    ? [
        { label: "Flaming front (simulated), flames under 4 ft: deep red, dim. Hand crews can hold it (Hauling chart, PMS 465)", color: fireStateCss(C.flameLow), glyph: <FlameGlyph color={C.flameLow} height={4} /> },
        { label: "Flames 4 to 8 ft: orange. Engines and dozers", color: fireStateCss(C.flameModerate), glyph: <FlameGlyph color={C.flameModerate} height={7} /> },
        { label: "Flames 8 to 11 ft: amber, bright. Serious control problems; aircraft, indirect line", color: fireStateCss(C.flameHigh), glyph: <FlameGlyph color={C.flameHigh} height={10} /> },
        { label: "Flames over 11 ft: pale yellow, brightest. Crowning, spotting, head not attackable", color: fireStateCss(C.flameExtreme), glyph: <FlameGlyph color={C.flameExtreme} height={12} /> },
        { label: "Crown fire (the fire model has the cell torching or crowning): near-white glow", color: fireStateCss(C.crown), glyph: <FlameGlyph color={C.crown} height={14} /> },
      ]
    : [{ label: "Flaming front (simulated): glows, with flames and smoke", color: "var(--ct-fire)", glyph: <FireEdgeGlyph /> }];
  rows.push(
    {
      label: `Smouldering (simulated): dark ground with an ember glow fading over ${SMOULDER_WINDOW_MINUTES} min after flaming ends (the window is an assumption)${containment ? "; also heat left inside a contained fire" : ""}`,
      color: fireStateCss(C.ember),
      glyph: <EmberGlyph />,
    },
    { label: "Burned out (simulated): ash-grey char, no glow", color: fireStateCss(C.ash), glyph: <BurnedGlyph /> },
  );
  if (containment)
    rows.push({ label: "Fire edge: warm line while burning; solid blue once the fire is contained or out (its label says which)", color: fireStateCss(C.perimeterContained), glyph: <FireEdgeGlyph /> });
  if (putOutCells)
    rows.push({ label: "Put out by crews (simulated): slate with a pale hatch and a dashed outline, no glow", color: EXTINGUISHED_LEGEND.fill, glyph: <ExtinguishedGlyph /> });
  return rows;
}
