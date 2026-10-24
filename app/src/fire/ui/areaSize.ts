/** How wide a square of ground the board covers, chosen independently of the horizon. */
export type AreaSizeId = "local" | "city" | "region" | "bay";

export const AREA_SIZES: readonly {
  id: AreaSizeId;
  label: string;
  /** Minimum grid half-width in metres; null lets the horizon decide. */
  radiusMeters: number | null;
}[] = [
  { id: "local", label: "Local (fits the horizon)", radiusMeters: null },
  { id: "city", label: "10 km radius", radiusMeters: 10_000 },
  { id: "region", label: "25 km radius", radiusMeters: 25_000 },
  { id: "bay", label: "Largest (50 km radius)", radiusMeters: 50_000 },
];

export const DEFAULT_AREA_SIZE: AreaSizeId = "local";

/** Largest grid half-width the page will request. */
export const MAX_RADIUS_METERS = 50_000;
const MIN_AUTO_RADIUS_METERS = 3000;
/** Horizons up to this keep the original 12 km cap; longer ones may grow the box further. */
const LOCAL_CAP_HORIZON_MINUTES = 360;
const LOCAL_CAP_RADIUS_METERS = 12_000;
/** Generous fast-run spread rate used to size the box; bounds downloads, not a prediction. */
const ASSUMED_FAST_SPREAD_METERS_PER_MINUTE = 40;

/** Effective grid half-width: the larger of the horizon-fitted radius and the chosen size. */
export function effectiveRadiusMeters(horizonMinutes: number, size: AreaSizeId): number {
  const fitted = horizonMinutes * ASSUMED_FAST_SPREAD_METERS_PER_MINUTE;
  const cap =
    horizonMinutes <= LOCAL_CAP_HORIZON_MINUTES ? LOCAL_CAP_RADIUS_METERS : MAX_RADIUS_METERS;
  const auto = Math.min(Math.max(fitted, MIN_AUTO_RADIUS_METERS), cap);
  const chosen = AREA_SIZES.find((candidate) => candidate.id === size)?.radiusMeters ?? 0;
  return Math.min(MAX_RADIUS_METERS, Math.max(auto, chosen));
}
