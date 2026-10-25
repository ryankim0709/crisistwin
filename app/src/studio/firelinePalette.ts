/** Control-line colours baked into the 3D board and map layers (CSS uses tokens instead). */
export const FIRELINE_COLORS = {
  /** Built line, holding so far. */
  held: 0x2a2320,
  /** Burned after it was built. */
  breached: 0xd8432f,
  /** Fire got there before the crew. */
  outrun: 0xf08a24,
} as const;

export function firelineCss(hex: number): string {
  return `#${hex.toString(16).padStart(6, "0")}`;
}

/** Fire facilities on the map (studio/useMapStations.ts): marker fill, outline and label halo. */
export const STATION_COLORS = {
  fill: 0xffffff,
  ink: 0x1f2a24,
  halo: 0xffffff,
} as const;

/** Firefighting vehicles and their routes on the 3D board and the map. */
export const CREW_COLORS = {
  engine: 0xc8352a,
  hand_crew: 0x2f6b4f,
  dozer: 0xe0a61c,
  route: 0xc8352a,
} as const;
