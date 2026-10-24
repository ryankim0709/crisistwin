// The reference point captions measure fire distance from, derived per bundle (no per-fire
// constants): a named point the bundle provides, else the household-weighted centre of the
// demand zones, named from the incident's place when known. Pure module.
import { areaCenter } from "./insights";
import type { LngLat, ReplayModel } from "./types";

export interface ReferencePlace {
  name: string;
  coord: LngLat;
}

/**
 * "Paradise, Butte County, California" -> "Paradise". A list of several towns
 * ("Geyserville, Healdsburg and Windsor, ...") returns null: the weighted centre lies between
 * them, so naming any one town would misstate the distance.
 */
export function shortPlaceName(place: string | null | undefined): string | null {
  if (!place) return null;
  const parts = place.split(",").map((p) => p.trim()).filter(Boolean);
  const towns = parts.filter((p) => !/\b(county|parish|borough)\b/i.test(p));
  if (towns.length === 0 || parts.some((p) => /\band\b|&/.test(p))) return null;
  // "Sonoma County, CA": no town at all; distances to a county's centre would mislead.
  if (/\b(county|parish|borough)\b/i.test(parts[0])) return null;
  // "Town, County, State": one town before the county.
  const countyAt = parts.findIndex((p) => /\bcounty\b/i.test(p));
  if (countyAt > 1) return null;
  return parts[0];
}

/** Name used when the incident has no single town: the household-weighted centre of its zones. */
export const POPULATION_CENTRE = "the population centre";

export function referencePlace(model: ReplayModel, placeHint: string | null): ReferencePlace | null {
  if (model.incident.referencePoint) return model.incident.referencePoint;
  const name = shortPlaceName(model.incident.place) ?? shortPlaceName(placeHint) ?? POPULATION_CENTRE;
  const zones = model.zones?.items ?? [];
  let weight = 0;
  let x = 0;
  let y = 0;
  for (const z of zones) {
    const w = z.households ?? z.vehicles ?? 0;
    if (w <= 0) continue;
    const [lon, lat] = areaCenter(z.geometry);
    weight += w;
    x += w * lon;
    y += w * lat;
  }
  if (weight > 0) return { name, coord: [x / weight, y / weight] };
  return null;
}

/** Opening camera: frame the ignition and the reference place, else the bundle bbox. */
export function homeCoords(model: ReplayModel, place: ReferencePlace | null): LngLat[] {
  const out: LngLat[] = [];
  const ignition = model.fireSimulated?.ignition?.coord;
  if (ignition) out.push(ignition);
  if (place) out.push(place.coord);
  if (out.length < 2) {
    const [w, s, e, n] = model.bbox;
    return [
      [w, s],
      [e, n],
    ];
  }
  return out;
}
