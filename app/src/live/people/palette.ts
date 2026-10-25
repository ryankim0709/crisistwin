/**
 * People layer colours. MapLibre paint cannot read CSS variables, so the hues live here; `driving`
 * mirrors --ct-evacuee and `out` --ct-shelter. Never the only cue: the legend, labels and shapes carry
 * the meaning too.
 */
export const PEOPLE_COLOR = {
  home: "#A5B4FC",
  homeEdge: "#3730A3",
  driving: "#5EEAD4",
  drivingEdge: "#0F1720",
  queued: "#FACC15",
  queuedEdge: "#713F12",
  stuck: "#FF2E93",
  stuckEdge: "#FFFFFF",
  stuckInk: "#9D174D",
  out: "#22C55E",
  outEdge: "#14532D",
  halo: "#FFFFFF",
  ink: "#0F1720",
};
