// Drill injects (docs/live-reports.md "Injects"): wire types, client calls and map features.
// Every inject is simulated and labeled; nothing is sent to real people.
import { request } from "./api";
import type { CommandResponse, IsoTime, LonLat } from "./types";

export type InjectType = "psap_reroute" | "comms_outage" | "silent_closure" | "shelter_full" | "fire_jump";
export type InjectStatus = "scheduled" | "active" | "ended";

export interface DrillInject {
  id: string;
  type: InjectType;
  /** Per type; times are drill time (UTC ISO). */
  params: Record<string, unknown>;
  at: IsoTime;
  status: InjectStatus;
  actor: string;
  label: string;
  evidence_class: "simulated";
  /** Where to mark it on the map (null for zone injects). */
  coord: LonLat | null;
  zone_ids: string[];
}

export interface SegmentChoice {
  id: string;
  name: string;
  length_m: number;
}

export interface InjectList {
  injects: DrillInject[];
  replay_now: IsoTime;
  choices: { segments: SegmentChoice[] };
}

export interface InjectRequest {
  type: InjectType;
  params: Record<string, unknown>;
  /** Drill time; omitted = now. */
  at?: IsoTime;
}

export const INJECT_LABEL: Record<InjectType, string> = {
  psap_reroute: "911 rerouted",
  comms_outage: "No signal",
  silent_closure: "Silent closure",
  shelter_full: "Shelter full",
  fire_jump: "Fire jump",
};

export const INJECT_TYPES = Object.keys(INJECT_LABEL) as InjectType[];

const path = (incidentId: string) => `incidents/${encodeURIComponent(incidentId)}/injects`;
export const listInjects = (token: string, incidentId: string) => request<InjectList>(token, "GET", path(incidentId));
export const createInject = (token: string, incidentId: string, body: InjectRequest) =>
  request<unknown>(token, "POST", path(incidentId), body);
export const deleteInject = (token: string, incidentId: string, id: string) =>
  request<unknown>(token, "DELETE", `${path(incidentId)}/${encodeURIComponent(id)}`);

type Feature = GeoJSON.Feature<GeoJSON.Geometry, Record<string, string | number | boolean | null>>;
const collection = (features: Feature[]): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features });

/** Map sources of the injects: hatched zones with no signal, and a labeled mark per inject. */
export function buildInjectSources(data: CommandResponse): Record<string, GeoJSON.FeatureCollection> {
  const dead = new Set(data.no_signal_zone_ids ?? []);
  const zones: Feature[] = data.zones
    .filter((z) => dead.has(z.id))
    .map((z) => ({ type: "Feature", geometry: z.geometry, properties: { id: z.id, text: "NO SIGNAL" } }));
  const marks: Feature[] = (data.injects ?? [])
    .filter((i) => i.coord && i.status !== "ended")
    .map((i) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: i.coord! },
      properties: { text: `INJECT · ${INJECT_LABEL[i.type]}${i.status === "scheduled" ? " (scheduled)" : ""}`, label: i.label },
    }));
  return { "lc-nosignal": collection(zones), "lc-inject-marks": collection(marks) };
}
