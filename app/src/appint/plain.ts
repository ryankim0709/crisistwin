// Plain-language wording and small derivations for the App integration tab. No React, no network.
import { shortZoneName } from "../live/format";
import type { PeopleCounts, PeopleSnapshot } from "../live/people";
import type { CommandResponse, Proposal } from "../live/types";
import type { Participant, ParticipantFlag } from "./types";

export const nf = (n: number) => Math.round(n).toLocaleString("en-US");

/** A real phone heard from within this long (wall time) is on our app now: list, counts, map and the real-time rule. */
export const JOINED_WINDOW_MS = 60 * 60_000;

export const isJoinedNow = (p: Participant, nowMs: number) =>
  p.kind === "real" && !!p.last_seen && nowMs - new Date(p.last_seen).getTime() <= JOINED_WINDOW_MS;

const URGENT: ParticipantFlag[] = ["Needs help", "In danger", "Stuck", "Toward fire"];
export const flagTone = (f: ParticipantFlag): "danger" | "warning" => (URGENT.includes(f) ? "danger" : "warning");

export function zoneLabel(data: CommandResponse | null, zoneId: string | null): string {
  if (!zoneId) return "no zone";
  const z = data?.zones.find((zone) => zone.id === zoneId);
  return z ? shortZoneName(z.name) : zoneId;
}

export function zonesPhrase(names: string[]): string {
  if (names.length === 0) return "no zones";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} more zones`;
}

export function ago(iso: string | null, nowMs: number): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

// ---- "Needs your OK": a pending proposal in plain words ----

export interface PlainProposal {
  id: string;
  title: string;
  lines: string[];
  zoneIds: string[];
}

const ACTION: Record<string, string> = {
  evacuate_now: "to leave now",
  be_ready: "to get ready to leave",
  none: "the order is lifted",
  reroute: "a new way out",
  route_lost: "there is no open way out",
};

export function plainProposal(p: Proposal, data: CommandResponse | null): PlainProposal {
  const groups = new Map<string, string[]>();
  for (const c of p.changes) {
    const key = c.kind === "reroute" ? "reroute" : c.kind === "route_lost" ? "route_lost" : c.to.level;
    const list = groups.get(key) ?? [];
    list.push(zoneLabel(data, c.zone_id));
    groups.set(key, list);
  }
  const lines = [...groups.entries()].map(([key, names]) =>
    `${key === "reroute" ? "Send" : "Tell"} ${zonesPhrase(names)} ${ACTION[key] ?? key}`,
  );
  if (p.tasks.length) lines.push(`Ask a responder to check ${p.tasks.length === 1 ? "a road" : `${p.tasks.length} roads`}`);
  const title = lines[0] ?? "Update phones";
  return { id: p.id, title, lines: lines.slice(1), zoneIds: p.changes.map((c) => c.zone_id) };
}

/** Residents in these zones: the people estimate when loaded, else households x 2.41 (the twin's assumption). */
export function peopleInZones(zoneIds: string[], people: PeopleSnapshot | null, data: CommandResponse | null): number | null {
  const ids = new Set(zoneIds);
  if (people) return people.zones.filter((z) => ids.has(z.id)).reduce((a, z) => a + z.population, 0);
  if (!data) return null;
  return data.zones.filter((z) => ids.has(z.id)).reduce((a, z) => a + z.households * 2.41, 0);
}

// ---- "What simulated people did" ----

export const BEHAVIOURS = [
  "Followed the order",
  "Left late",
  "Took a different road",
  "Went back home",
  "Stayed home",
  "Waited to see the fire",
  "Drove toward the fire",
] as const;
export type Behaviour = (typeof BEHAVIOURS)[number];

/**
 * One headline behaviour per simulated household, from its drawn choices (sim/behavior.py
 * HouseholdChoices), in this order: stayed, waited, drove toward the fire (a family pickup),
 * went back (a trip home first), different road (reroutes in traffic), left late (milling or
 * 60+ min delay), else followed. Falls back to its flags when it has no choices.
 */
export function behaviourOf(p: Participant): Behaviour {
  const c = p.behaviour?.choices ?? {};
  const action = c.protective_action;
  if (action === "stay_and_defend" || action === "shelter_in_place") return "Stayed home";
  if (action === "wait_and_see") return "Waited to see the fire";
  if (c.pickup_trip === true) return "Drove toward the fire";
  if (typeof c.trip_before_leaving === "string" && c.trip_before_leaving) return "Went back home";
  if (c.reroutes_in_congestion === true) return "Took a different road";
  const delay = typeof c.departure_delay_min === "number" ? c.departure_delay_min : null;
  if (c.milling === true || (delay !== null && delay >= 60)) return "Left late";
  if (action) return "Followed the order";
  const f = new Set(p.flags);
  if (f.has("Not leaving")) return "Stayed home";
  if (f.has("Toward fire")) return "Drove toward the fire";
  if (f.has("Went back")) return "Went back home";
  if (f.has("Different road")) return "Took a different road";
  if (f.has("Late")) return "Left late";
  return "Followed the order";
}

// ---- No double counting: app residents are part of the estimated population ----

type PeopleState = "home" | "driving" | "queued" | "stuck" | "out";

/** The one people-snapshot state an app resident is in, from its status line and flags. */
export function peopleStateOf(p: Participant): PeopleState {
  const s = p.status.toLowerCase();
  if (/\bout\b|safe|arrived/.test(s)) return "out";
  if (p.flags.includes("Stuck") || /stuck|turned back|blocked/.test(s)) return "stuck";
  if (p.flags.includes("Slowed") || /traffic|slow/.test(s)) return "queued";
  if (/driv|leaving|on the way|heading/.test(s)) return "driving";
  return "home";
}

export interface EveryoneElse {
  home: number;
  driving: number;
  queued: number;
  stuck: number;
  out: number;
  population: number;
  appResidents: number;
}

/**
 * The estimate minus our app's residents: each app resident is one of the estimated people, so
 * it is taken out of the state it is in (clamped at 0) and drawn as its own dot instead.
 */
export function everyoneElse(totals: PeopleCounts & { population: number }, participants: Participant[]): EveryoneElse {
  const out: EveryoneElse = {
    home: totals.home + totals.home_no_car + totals.staying,
    driving: totals.driving,
    queued: totals.queued,
    stuck: totals.stuck,
    out: totals.out,
    population: totals.population,
    appResidents: 0,
  };
  for (const p of participants) {
    if (p.role !== "resident") continue;
    const state = peopleStateOf(p);
    out[state] = Math.max(0, out[state] - 1);
    out.population = Math.max(0, out.population - 1);
    out.appResidents += 1;
  }
  return out;
}

/** One line about the selected person, next to their phone. */
export function personSummary(p: Participant, data: CommandResponse | null): string {
  const who = p.kind === "real" ? "Real person" : "Simulated person";
  const role = p.role === "responder" ? " (responder)" : p.role === "observer" ? " (watching)" : "";
  const zone = p.zone_id ? ` in ${zoneLabel(data, p.zone_id)}` : "";
  const where = p.position_source === "estimated" ? " Position is approximate." : "";
  return `${who}${role}${zone}. ${p.status || "No news yet"}.${where}`;
}
