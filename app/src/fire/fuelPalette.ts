/** Colours shared by the fire page legend and the diorama renderer (ADR 0011). */

export const ARRIVAL_COLORS = {
  earliest: "#7f1d1d",
  middle: "#ea580c",
  latest: "#fbbf24",
} as const;
export const CURRENT_PERIMETER_COLOR = "#fde68a";

/** Fuel overlay palette, grouped by Scott & Burgan family. */
export const FUEL_COLORS: readonly { label: string; color: string }[] = [
  { label: "Grass (GR)", color: "#d9c15e" },
  { label: "Grass-shrub (GS)", color: "#b08a3e" },
  { label: "Shrub (SH)", color: "#8c6f3a" },
  { label: "Timber understory (TU)", color: "#4f7a43" },
  { label: "Timber litter (TL)", color: "#2f5d3a" },
  { label: "Slash / blowdown (SB)", color: "#6b4f2a" },
  { label: "Non-burnable", color: "#5b6168" },
];
