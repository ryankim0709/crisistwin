import type { LayerGroup } from "./mapLayers";
import type { EvidenceClass, LayerStatus, ReplayModel } from "./types";

/** Which bundle layer each toggle group reads, for status and evidence. */
export const GROUP_LAYER: Record<LayerGroup, { layer: string; label: string }> = {
  fire: { layer: "fire_perimeters", label: "Fire perimeter in effect" },
  history: { layer: "fire_perimeters", label: "Earlier perimeters" },
  simFire: { layer: "fire_simulated", label: "Simulated fire front (model, before first perimeter)" },
  roads: { layer: "roads", label: "Roads & congestion" },
  particles: { layer: "traffic", label: "Vehicle dots (illustrative)" },
  zones: { layer: "zones", label: "Evacuation zones" },
  destinations: { layer: "destinations", label: "Destinations" },
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
  const evidence: Record<LayerGroup, EvidenceClass | null> = {
    fire: model.perimeters[0]?.evidenceClass ?? null,
    history: model.perimeters[0]?.evidenceClass ?? null,
    simFire: model.fireSimulated?.evidenceClass ?? null,
    roads: model.roads?.evidenceClass ?? null,
    particles: model.traffic?.evidenceClass ?? null,
    zones: model.zones?.evidenceClass ?? null,
    destinations: model.destinations?.evidenceClass ?? null,
    damage: model.damage?.evidenceClass ?? null,
  };
  const available: Record<LayerGroup, boolean> = {
    fire: model.perimeters.length > 0,
    history: model.perimeters.length > 1,
    simFire: (model.fireSimulated?.fronts.length ?? 0) > 0,
    roads: (model.roads?.items.length ?? 0) > 0,
    particles: model.traffic !== null && model.roads !== null,
    zones: (model.zones?.items.length ?? 0) > 0,
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
