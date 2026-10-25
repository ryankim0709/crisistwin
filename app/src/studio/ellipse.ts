/**
 * Fire-shape geometry with no imports, shared by the Studio initial attack (studio/initialAttack.ts)
 * and the dispatch agent (dispatch/fireAttack.ts). It lives in its own module so that
 * dispatch/fireAttack.ts does not import studio/initialAttack.ts, which imports dispatch/engine.ts
 * (a cycle that left `MAX_ROAD_GAP_METERS` uninitialised when /dispatch loaded).
 */

/** Ramanujan's perimeter of the ellipse with this area and length-to-breadth ratio. */
export function ellipsePerimeter(areaSquareMeters: number, lengthToBreadth: number): number {
  if (areaSquareMeters <= 0) return 0;
  const ratio = Math.max(1, lengthToBreadth);
  const a = Math.sqrt((areaSquareMeters * ratio) / Math.PI);
  const b = a / ratio;
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}
