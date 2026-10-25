// App integration tab contracts (docs/app-integration.md "Participants API").
import type { LonLat } from "../live/types";

export type ParticipantKind = "real" | "simulated";
export type ParticipantRole = "resident" | "responder" | "observer";
export type ParticipantFlag =
  | "Stuck"
  | "Needs help"
  | "Late"
  | "Different road"
  | "Went back"
  | "Not leaving"
  | "In danger"
  | "Toward fire"
  | "Slowed";

export interface ParticipantBehaviour {
  /** Plain sentences, oldest first ("Waited to see the fire", "Went back for a pet"). */
  narrative: string[];
  /** The household's drawn choices (sim/behavior.py HouseholdChoices fields); simulated. */
  choices: Record<string, unknown>;
}

export interface Participant {
  id: string;
  kind: ParticipantKind;
  role: ParticipantRole;
  name: string;
  zone_id: string | null;
  position: LonLat | null;
  position_source: "gps" | "estimated" | null;
  /** Plain language, e.g. "Told to leave now", "Safely out". */
  status: string;
  flags: ParticipantFlag[];
  last_seen: string | null;
  behaviour: ParticipantBehaviour | null;
  evidence_class: "field_report" | "simulated";
}

export interface ParticipantMessage {
  /** Wall time. */
  at: string | null;
  /** Drill time, when known. */
  replay_at: string | null;
  direction: "to" | "from";
  text: string;
  participant_id: string | null;
  kind: ParticipantKind | null;
}

export interface ParticipantsResponse {
  incident_id: string;
  /** Wall time of the read. */
  now: string;
  /** Drill time of the read (additive). */
  replay_now?: string | null;
  participants: Participant[];
  counts: { real: number; simulated: number; by_role: Record<ParticipantRole, number> };
  /** One timeline of what went to and came from phones, newest first (additive). */
  messages?: ParticipantMessage[];
}
