/**
 * Legend glyphs for the /live command board's 3D view: small 24x16 SVGs that mirror the 3D shapes
 * and colours (apparatusGlyphs.ts, board3dPalette.ts). Each glyph's SHAPE differs from the others,
 * so the legend never relies on colour alone.
 */

import type { ReactNode } from "react";
import { APPARATUS_COLORS as C, DEMO_3D_COLORS, DESTINATION_COLORS, FOLLOW_COLORS, hexCss } from "./board3dPalette";

const INK = "var(--ct-ink-muted)";

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg width="24" height="16" viewBox="0 0 24 16" aria-hidden="true">
      {children}
    </svg>
  );
}

/** Side view: red body, white-roofed cab with a glass band, two wheels, a light bar. */
export function EngineGlyph() {
  return (
    <Glyph>
      <rect x="1.5" y="6" width="13" height="6.5" fill={hexCss(C.engine)} stroke={INK} strokeWidth="0.6" />
      <path d="M14.5 4.5h4.5l3 3.5v4.5h-7.5Z" fill={hexCss(C.engine)} stroke={INK} strokeWidth="0.6" strokeLinejoin="round" />
      <path d="M14 4h5.4" stroke={hexCss(C.white)} strokeWidth="1.6" />
      <path d="M16 6h2.6l1.7 2h-4.3Z" fill={hexCss(C.glass)} />
      <rect x="16" y="2.4" width="2.6" height="1.2" fill={hexCss(C.aircraftRed)} stroke={INK} strokeWidth="0.4" />
      <circle cx="6" cy="12.8" r="2" fill={hexCss(C.steel)} stroke="var(--ct-surface)" strokeWidth="0.6" />
      <circle cx="18" cy="12.8" r="2" fill={hexCss(C.steel)} stroke="var(--ct-surface)" strokeWidth="0.6" />
    </Glyph>
  );
}

/** Side view: a long rounded tank in the darker red behind a small cab, three wheels. */
export function TenderGlyph() {
  return (
    <Glyph>
      <rect x="1" y="3.5" width="14.5" height="8" rx="4" fill={hexCss(C.tender)} stroke={INK} strokeWidth="0.6" />
      <path d="M5.5 4v7M10.5 4v7" stroke={hexCss(C.white)} strokeWidth="0.9" />
      <path d="M16 6h3.4l2.6 3v3.5H16Z" fill={hexCss(C.engine)} stroke={INK} strokeWidth="0.6" strokeLinejoin="round" />
      <path d="M17.6 7.2h1.6l1.2 1.6h-2.8Z" fill={hexCss(C.glass)} />
      <circle cx="4.5" cy="12.8" r="1.9" fill={hexCss(C.steel)} stroke="var(--ct-surface)" strokeWidth="0.6" />
      <circle cx="10.5" cy="12.8" r="1.9" fill={hexCss(C.steel)} stroke="var(--ct-surface)" strokeWidth="0.6" />
      <circle cx="19" cy="12.8" r="1.9" fill={hexCss(C.steel)} stroke="var(--ct-surface)" strokeWidth="0.6" />
    </Glyph>
  );
}

/** Side view: yellow body on a dark track, a tall steel blade in front, a small cab cage. */
export function DozerGlyph() {
  return (
    <Glyph>
      <rect x="3" y="8" width="13" height="4" fill={hexCss(C.dozer)} stroke={INK} strokeWidth="0.6" />
      <rect x="10" y="5.5" width="6" height="2.5" fill={hexCss(C.dozer)} stroke={INK} strokeWidth="0.6" />
      <path d="M4.5 4.2h4.6M5 4.2V8M8.6 4.2V8" stroke={hexCss(C.steel)} strokeWidth="1" fill="none" />
      <rect x="2" y="11" width="15" height="4" rx="2" fill={hexCss(C.steel)} />
      <rect x="18" y="4.5" width="2.8" height="10" rx="0.6" fill={hexCss(C.steel)} stroke="var(--ct-surface)" strokeWidth="0.5" />
      <path d="M16.5 10h1.6" stroke={hexCss(C.steel)} strokeWidth="1.4" />
    </Glyph>
  );
}

/** Side view: a long green box with a row of dark windows and two wheels. */
export function CrewCarrierGlyph() {
  return (
    <Glyph>
      <rect x="1" y="4" width="22" height="8.5" rx="1.2" fill={hexCss(C.hand_crew)} stroke={INK} strokeWidth="0.6" />
      <path d="M1.6 4h20.8" stroke={hexCss(C.white)} strokeWidth="1.2" />
      {[3, 7.6, 12.2, 16.8].map((x) => (
        <rect key={x} x={x} y="5.6" width="3.4" height="3" rx="0.4" fill={hexCss(C.glass)} />
      ))}
      <circle cx="6" cy="12.8" r="2" fill={hexCss(C.steel)} stroke="var(--ct-surface)" strokeWidth="0.6" />
      <circle cx="18" cy="12.8" r="2" fill={hexCss(C.steel)} stroke="var(--ct-surface)" strokeWidth="0.6" />
    </Glyph>
  );
}

/** One walking figure with a tool: yellow helmet, green body, striding legs. */
export function HikingCrewGlyph() {
  return (
    <Glyph>
      <path d="M11 10 8 15M11 10l3.4 5" stroke={hexCss(C.hand_crew)} strokeWidth="1.8" strokeLinecap="round" />
      <rect x="9.3" y="5.6" width="3.4" height="5.4" rx="1.4" fill={hexCss(C.hand_crew)} stroke={INK} strokeWidth="0.5" />
      <path d="M13 7.2 15.2 8.6" stroke={hexCss(C.hand_crew)} strokeWidth="1.4" strokeLinecap="round" />
      <path d="M14.6 14.6 18.2 3.2" stroke={hexCss(C.steel)} strokeWidth="1.1" strokeLinecap="round" />
      <path d="M17 2.6h3" stroke={hexCss(C.steel)} strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="11" cy="3.6" r="2.3" fill={hexCss(DEMO_3D_COLORS.crewHelmet)} stroke={INK} strokeWidth="0.6" />
    </Glyph>
  );
}

/** Side view: red fuselage with a glass nose, tail boom and fin, skids, and a rotor bar on a mast. */
export function HelicopterGlyph() {
  return (
    <Glyph>
      <path d="M2 2.4h20" stroke={hexCss(C.rotor)} strokeWidth="1.2" strokeLinecap="round" />
      <path d="M11 2.6v2.4" stroke={hexCss(C.steel)} strokeWidth="1.2" />
      <path d="M13 8 2.5 6.6v2.2L13 9.6Z" fill={hexCss(C.aircraftRed)} stroke={INK} strokeWidth="0.5" strokeLinejoin="round" />
      <path d="M2.5 4.6v4.4" stroke={hexCss(C.aircraftRed)} strokeWidth="1.6" />
      <ellipse cx="14" cy="8.6" rx="6.4" ry="3.8" fill={hexCss(C.aircraftRed)} stroke={INK} strokeWidth="0.6" />
      <path d="M17.5 6.2a4 3.2 0 0 1 3.2 3.4h-4.4Z" fill={hexCss(C.glass)} />
      <path d="M8 14.2h13M10.5 12.3v1.9M17.5 12.3v1.9" stroke={hexCss(C.steel)} strokeWidth="1" strokeLinecap="round" />
    </Glyph>
  );
}

/** Top-down: red fuselage with a white top stripe, straight wings, two engines, tail plane. */
export function AirtankerGlyph() {
  return (
    <Glyph>
      <rect x="1.5" y="6.2" width="2.8" height="3.6" rx="0.5" fill={hexCss(C.white)} stroke={INK} strokeWidth="0.5" />
      <rect x="8" y="1" width="5" height="14" rx="0.8" fill={hexCss(C.white)} stroke={INK} strokeWidth="0.6" />
      <rect x="8" y="1" width="5" height="2.2" fill={hexCss(C.aircraftRed)} />
      <rect x="8" y="12.8" width="5" height="2.2" fill={hexCss(C.aircraftRed)} />
      <rect x="11.2" y="3.4" width="4" height="2.4" rx="1" fill={hexCss(C.aircraftRed)} stroke={INK} strokeWidth="0.5" />
      <rect x="11.2" y="10.2" width="4" height="2.4" rx="1" fill={hexCss(C.aircraftRed)} stroke={INK} strokeWidth="0.5" />
      <path d="M1 8 4 6.6h13.5q4 1.4 5.5 1.4-1.5 0-5.5 1.4H4Z" fill={hexCss(C.aircraftRed)} stroke={INK} strokeWidth="0.6" strokeLinejoin="round" />
      <path d="M5 8h10" stroke={hexCss(C.white)} strokeWidth="0.9" />
    </Glyph>
  );
}

/** Top-down and smaller: white pod, short straight wing, twin booms, an orange band and tail plane. */
export function AirAttackGlyph() {
  return (
    <Glyph>
      <path d="M4 5.2h8M4 10.8h8" stroke={hexCss(C.airAttack)} strokeWidth="1.2" />
      <path d="M4 5.2h8M4 10.8h8" stroke={INK} strokeWidth="0.4" />
      <rect x="2.6" y="3.6" width="1.6" height="8.8" fill={hexCss(C.airAttackBand)} stroke={INK} strokeWidth="0.4" />
      <rect x="9" y="2.4" width="3.6" height="11.2" rx="0.6" fill={hexCss(C.airAttack)} stroke={INK} strokeWidth="0.6" />
      <rect x="9" y="2.4" width="3.6" height="1.6" fill={hexCss(C.airAttackBand)} />
      <rect x="9" y="12" width="3.6" height="1.6" fill={hexCss(C.airAttackBand)} />
      <rect x="10.4" y="4.2" width="4.4" height="1.9" rx="0.9" fill={hexCss(C.airAttack)} stroke={INK} strokeWidth="0.5" />
      <rect x="10.4" y="9.9" width="4.4" height="1.9" rx="0.9" fill={hexCss(C.airAttack)} stroke={INK} strokeWidth="0.5" />
      <ellipse cx="14" cy="8" rx="4.6" ry="1.9" fill={hexCss(C.airAttack)} stroke={INK} strokeWidth="0.6" />
      <rect x="11" y="6.1" width="2" height="3.8" fill={hexCss(C.airAttackBand)} />
      <ellipse cx="17.2" cy="8" rx="1.3" ry="0.8" fill={hexCss(C.glass)} />
    </Glyph>
  );
}

/** A plane silhouette with a pink retardant curtain widening below it. */
export function DropGlyph() {
  return (
    <Glyph>
      <path d="M10 5.5h4L19.5 15h-15Z" fill={hexCss(C.retardant)} fillOpacity="0.85" stroke={hexCss(C.retardant)} strokeWidth="0.6" strokeLinejoin="round" />
      <path d="M8.5 9.5 12 7M15.5 9.5 12 7M12 6v8.5" stroke={hexCss(C.white)} strokeWidth="0.6" strokeOpacity="0.8" fill="none" />
      <path d="M3 3.2 5.2 2.2h11l3.8 1.5-3.8 1.2h-11Z" fill={hexCss(C.aircraftRed)} stroke={INK} strokeWidth="0.6" strokeLinejoin="round" />
      <path d="M10 2.4v-1M5 2.6V1.4h2" stroke={INK} strokeWidth="0.6" fill="none" />
      <path d="M8 3.6h8" stroke={hexCss(C.white)} strokeWidth="0.9" />
    </Glyph>
  );
}

/** A red house: red walls, white pitched roof, dark bay door. */
export function FireStationGlyph() {
  return (
    <Glyph>
      <rect x="4" y="7" width="16" height="8" fill={hexCss(DEMO_3D_COLORS.station)} stroke={INK} strokeWidth="0.7" />
      <path d="M2 8 12 1.5 22 8Z" fill={hexCss(C.white)} stroke={INK} strokeWidth="0.8" strokeLinejoin="round" />
      <rect x="8.6" y="9.4" width="6.8" height="5.6" rx="0.4" fill={hexCss(C.glass)} />
      <path d="M8.6 11.3h6.8M8.6 13.1h6.8" stroke={hexCss(DEMO_3D_COLORS.station)} strokeWidth="0.5" />
    </Glyph>
  );
}

/** A green flag on a pole beside a vertical gauge filled to `fill` (0..1). */
export function SafeAreaGlyph({ fill = 0.6 }: { fill?: number }) {
  const level = Math.max(0, Math.min(1, fill));
  const gaugeTop = 2;
  const gaugeHeight = 12;
  const filled = gaugeHeight * level;
  return (
    <Glyph>
      <rect x="5.4" y="1.5" width="1.2" height="13.5" fill={hexCss(DESTINATION_COLORS.pole)} stroke={INK} strokeWidth="0.5" />
      <path d="M6.6 2 14.5 4.3 6.6 7.6Z" fill={hexCss(DESTINATION_COLORS.marker)} stroke={INK} strokeWidth="0.5" strokeLinejoin="round" />
      <rect x="17" y={gaugeTop} width="4" height={gaugeHeight} rx="0.8" fill="var(--ct-surface)" stroke={hexCss(DESTINATION_COLORS.gaugeFrame)} strokeWidth="1" />
      <rect x="17.5" y={gaugeTop + gaugeHeight - filled} width="3" height={filled} fill={hexCss(DESTINATION_COLORS.gaugeOk)} />
    </Glyph>
  );
}

/** A magenta dot with a white ring and a short path behind it: dashed older track, solid recent track. */
export function FollowedPersonGlyph() {
  return (
    <Glyph>
      <path d="M1.5 12.5Q4 9.5 7 11" stroke={hexCss(FOLLOW_COLORS.path)} strokeWidth="1.4" strokeDasharray="2 1.6" fill="none" strokeLinecap="round" />
      <path d="M7 11Q10 12.5 13 9" stroke={hexCss(FOLLOW_COLORS.travelled)} strokeWidth="1.8" fill="none" strokeLinecap="round" />
      <circle cx="17.5" cy="8" r="5" fill="none" stroke={INK} strokeWidth="0.6" />
      <circle cx="17.5" cy="8" r="3.6" fill={hexCss(FOLLOW_COLORS.person)} stroke={hexCss(FOLLOW_COLORS.personRing)} strokeWidth="1.6" />
    </Glyph>
  );
}

/** Three nested dashed ellipses, the darkest (soonest) inside. */
export function ForecastRingGlyph() {
  const [soon, mid, late] = FOLLOW_COLORS.forecast;
  return (
    <Glyph>
      <ellipse cx="12" cy="8" rx="10.6" ry="6.8" fill="none" stroke={hexCss(late)} strokeWidth="1.3" strokeDasharray="3.2 2" />
      <ellipse cx="12" cy="8" rx="7" ry="4.5" fill="none" stroke={hexCss(mid)} strokeWidth="1.3" strokeDasharray="3 1.8" />
      <ellipse cx="12" cy="8" rx="3.6" ry="2.3" fill={hexCss(soon)} fillOpacity="0.18" stroke={hexCss(soon)} strokeWidth="1.4" strokeDasharray="2.4 1.6" />
    </Glyph>
  );
}
