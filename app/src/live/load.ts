import { isClosedStatus } from "./format";
import type { CommandResponse, TwinMonitor } from "./types";

/** Simulated arrivals at or above this share of capacity_veh raise a warning. */
export const NEAR_FULL = 0.9;

export interface DestLoad {
  id: string;
  name: string;
  kind: string;
  /** Vehicles; null when the bundle has no capacity. */
  capacityVeh: number | null;
  /** Zones whose current guidance routes here. */
  zones: number;
  /** Phones (people) that chose this destination. Not vehicles. */
  phones: number;
  /** SIMULATED vehicles arrived in the traffic twin; null when the twin has no row. */
  simArrivedVeh: number | null;
  /** simArrivedVeh / capacityVeh, both vehicles; null when either is unknown. */
  simShare: number | null;
  reportedFull: boolean;
}

export function reportedFullIds(data: CommandResponse): Set<string> {
  const ids = new Set<string>();
  for (const i of data.public_items) if (i.kind === "shelter_full" && i.destination_id) ids.add(i.destination_id);
  for (const r of data.reports) {
    if (r.kind === "shelter_full" && r.destination_id && !isClosedStatus(r.status)) {
      ids.add(r.destination_id);
    }
  }
  return ids;
}

export function simShare(twin: TwinMonitor | null | undefined, id: string): number | null {
  const d = twin?.destinations.find((x) => x.id === id);
  return d && d.capacity_veh ? d.arrived_veh / d.capacity_veh : null;
}

export function destinationLoad(data: CommandResponse, twin: TwinMonitor | null): DestLoad[] {
  const full = reportedFullIds(data);
  const sim = new Map((twin?.destinations ?? []).map((d) => [d.id, d]));
  const zones = new Map<string, number>();
  for (const g of data.guidance) {
    const id = g.destination?.id;
    if (g.level !== "none" && id) zones.set(id, (zones.get(id) ?? 0) + 1);
  }
  const phones = new Map<string, number>();
  for (const p of data.destination_preferences ?? []) phones.set(p.destination_id, (phones.get(p.destination_id) ?? 0) + p.count);
  const rows = data.destinations.map((d): DestLoad => {
    const s = sim.get(d.id);
    return {
      id: d.id,
      name: d.name,
      kind: d.kind,
      capacityVeh: d.capacity_veh,
      zones: zones.get(d.id) ?? 0,
      phones: phones.get(d.id) ?? 0,
      simArrivedVeh: s ? s.arrived_veh : null,
      simShare: s && d.capacity_veh ? s.arrived_veh / d.capacity_veh : null,
      reportedFull: full.has(d.id),
    };
  });
  const score = (r: DestLoad) => (r.reportedFull ? 2 : 0) + (r.simShare ?? 0);
  return rows.sort((a, b) => score(b) - score(a) || b.zones - a.zones || b.phones - a.phones || a.name.localeCompare(b.name));
}
