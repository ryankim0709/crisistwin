/**
 * Colours baked into the /live command board's 3D view (DemoBoardOverlay.ts and its glyph and
 * marker modules). CSS cannot reach WebGL, so these are the one place the board's 3D hex colours
 * live (app/AGENTS.md: "keep those in the feature's palette module"); the 3D legend
 * (DemoDiorama.tsx, boardLegendGlyphs.tsx) mirrors them through `hexCss`.
 */

import { LEVEL_COLOR } from "../live/CommandMap";
import { STATION_STYLE } from "../maps/stations";
import { CREW_COLORS } from "../studio/firelinePalette";

export const DEMO_3D_COLORS = {
  stationWall: 0xefe4d6,
  stationRoof: CREW_COLORS.engine,
  /** Fire station roof (the shared red firehouse, fire/diorama/stationMarkers.ts). */
  station: STATION_STYLE.roof,
  route: 0x6b5bd2,
  ordered: LEVEL_COLOR.evacuate_now,
  threatened: LEVEL_COLOR.be_ready,
  overrun: "#b3140c",
  /** Fire line ahead of a fire (boardMapLayers BOARD_COLOR.fireLine). */
  fireLine: "#3b2a1a",
  /** Evacuating vehicles (simulated, sampled), on their zone's road route. */
  evacuee: 0x1f6feb,
  /** Helmet of a firefighter figure (its body is in its unit's family colour). */
  crewHelmet: 0xffd23f,
} as const;

/** Apparatus and aircraft glyphs (apparatusGlyphs.ts). Body colours follow CAL FIRE livery (red/white) where it applies. */
export const APPARATUS_COLORS = {
  engine: CREW_COLORS.engine,
  /** Water tender: same red family as engines, darker so the tank body reads apart. */
  tender: 0x8f2119,
  hand_crew: CREW_COLORS.hand_crew,
  dozer: CREW_COLORS.dozer,
  /** Dozer tracks and blade. */
  steel: 0x3a3a3a,
  /** Cab glass. */
  glass: 0x24323d,
  /** White cab roof / aircraft upper fuselage. */
  white: 0xf4f4f2,
  /** Airtanker (S-2T) and helicopter fuselage. */
  aircraftRed: 0xd2342a,
  /** Air attack / lead plane: white with an orange band, so it reads apart from tankers. */
  airAttack: 0xf2f2ee,
  airAttackBand: 0xf08a24,
  /** ALS ambulance: white box body and cab, red stripe, cross and roof light bar. */
  ambulanceBody: 0xf7f7f5,
  ambulanceStripe: 0xc8281e,
  /** Spinning rotor disc (translucent). */
  rotor: 0x2b2b2b,
  /** Retardant (pink-red, Phos-Chek) and water drop curtains. */
  retardant: 0xe2557a,
  water: 0x7fc4ff,
  /** Ground shadow under an aircraft at altitude (so height reads). */
  shadow: 0x101010,
} as const;

/** Safe-area destinations (destinationMarkers.ts): marker, fill gauge and its states. */
export const DESTINATION_COLORS = {
  marker: 0x1f8a4c,
  pole: 0xf4f4f2,
  gaugeFrame: 0x1f2a24,
  gaugeOk: 0x1f8a4c,
  gaugeBusy: 0xe0a61c,
  gaugeFull: 0xb3140c,
  gaugeUnknown: 0x9da29f,
} as const;

/** Followed people (setFollowed) and the predicted fire perimeters (setPredictedFire). */
export const FOLLOW_COLORS = {
  person: 0xd6249f,
  personRing: 0xffffff,
  path: 0xd6249f,
  travelled: 0x6a0f4e,
  /** Predicted perimeters, +30 / +60 / +120 min (darker = sooner). */
  forecast: [0xb3140c, 0xd8432f, 0xf08a24] as readonly number[],
} as const;

/** CSS colour for a palette entry (hex number or CSS string), for the legend. */
export function hexCss(color: number | string): string {
  return typeof color === "number" ? `#${color.toString(16).padStart(6, "0")}` : color;
}
