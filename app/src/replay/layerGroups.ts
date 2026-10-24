import type { LayerGroup } from "./mapLayers";
import { hasPeopleLayer } from "./population";
import type { EvidenceClass, LayerStatus, ReplayModel } from "./types";

/** Which bundle layer each toggle group reads, for status and evidence. */
export const GROUP_LAYER: Record<LayerGroup, { layer: string; label: string }> = {
  fire: { layer: "fire_perimeters", label: "Fire perimeter in effect" },
  history: { layer: "fire_perimeters", label: "Earlier perimeters" },
  simFire: { layer: "fire_simulated", label: "Simulated fire front (model, before first perimeter)" },
  fireObs: { layer: "fire_observations", label: "Fire observed here (NIST points, appear at their time)" },
  roads: { layer: "roads", label: "Roads & congestion" },
  particles: { layer: "traffic", label: "Vehicle dots (illustrative)" },
  zones: { layer: "zones", label: "Demand areas" },
  people: { layer: "zones", label: "People at home (household dots)" },
  destinations: { layer: "destinations", label: "Exits and refuges" },
  damage: { layer: "damage", label: "Damage — post-fire assessment (no damage time)" },
};

export function groupAvailability(model: ReplayModel, group: LayerGroup): {
  available: boolean;
  status: LayerStatus | null;
  evidence: EvidenceClass | null;
} {
  const { layer } = GROUP_LAYER[group];
  // Bundles name the perimeter layer "fire_perimeters"; accept the block name "fire" too.
  const status = model.layerStatus[layer] ?? (layer === "fire_perimeters" ? model.layerStatus.fire : null) ?? null;
  // A "mixed" layer has no single class; its items carry their own.
  const single = (c: EvidenceClass | "mixed" | undefined) => (c === undefined || c === "mixed" ? null : c);
  const evidence: Record<LayerGroup, EvidenceClass | null> = {
    fire: model.perimeters[0]?.evidenceClass ?? null,
    history: model.perimeters[0]?.evidenceClass ?? null,
    simFire: model.fireSimulated?.evidenceClass ?? null,
    fireObs: model.fireObservations?.evidenceClass ?? null,
    roads: single(model.roads?.evidenceClass),
    particles: model.traffic?.evidenceClass ?? null,
    zones: single(model.zones?.evidenceClass),
    people: single(model.zones?.evidenceClass),
    destinations: single(model.destinations?.evidenceClass),
    damage: single(model.damage?.evidenceClass),
  };
  const available: Record<LayerGroup, boolean> = {
    fire: model.perimeters.length > 0,
    history: model.perimeters.length > 1,
    simFire: (model.fireSimulated?.fronts.length ?? 0) > 0,
    fireObs: (model.fireObservations?.items.length ?? 0) > 0,
    roads: (model.roads?.items.length ?? 0) > 0,
    particles: model.traffic !== null && model.roads !== null,
    zones: (model.zones?.items.length ?? 0) > 0,
    people: hasPeopleLayer(model),
    destinations: (model.destinations?.items.length ?? 0) > 0,
    damage: (model.damage?.items.length ?? 0) > 0,
  };
  return {
    available: available[group],
    status,
    evidence:
      evidence[group] ?? (status?.evidenceClass === "mixed" ? null : (status?.evidenceClass ?? null)),
  };
}
