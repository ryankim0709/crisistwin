// The reference point captions measure fire distance from, derived per bundle (no per-fire
// constants): a named point the bundle provides, else the household-weighted centre of the
// demand zones, named from the incident's place when known. Pure module.
import { areaCenter } from "./insights";
import type { LngLat, ReplayModel } from "./types";

export interface ReferencePlace {
  name: string;
  coord: LngLat;
}

/** "Paradise, CA" -> "Paradise"; empty -> null. */
export function shortPlaceName(place: string | null | undefined): string | null {
  const name = place?.split(",")[0]?.trim();
  return name ? name : null;
}

export function referencePlace(model: ReplayModel, placeHint: string | null): ReferencePlace | null {
  if (model.incident.referencePoint) return model.incident.referencePoint;
  const name = shortPlaceName(model.incident.place) ?? shortPlaceName(placeHint) ?? "the populated area";
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
