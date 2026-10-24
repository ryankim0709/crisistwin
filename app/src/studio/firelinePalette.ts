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
