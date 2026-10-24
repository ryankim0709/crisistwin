/**
 * Compatibility re-exports. The MapLibre fire map was replaced by the diorama view
 * (ADR 0011); the palettes now live in `fuelPalette.ts`. Import from there.
 */
export { ARRIVAL_COLORS, CURRENT_PERIMETER_COLOR, FUEL_COLORS } from "./fuelPalette";
export type { GroundClickMode as ClickMode } from "./diorama/types";
