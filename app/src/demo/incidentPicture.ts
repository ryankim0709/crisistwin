/**
 * The live drill's incident picture for the AI commander: a bounded summary of what the command
 * poll (GET /api/live/incidents/{id}/command), the simulated people snapshot (.../people) and the
 * app participants list (.../participants) say right now. Pure: no React, network or LLM.
 *
 * Nothing here is computed by a model of our own: every count is a count of records the live API
 * returned, and every line names its evidence class (historical_record, field_report,
 * drill_fixture, simulated) and verification status. Times are drill time (the replay clock),
 * minutes before `as_of_drill`. Ids are the live API's ids, so the commander can act on them
 * (report ids, help request = need_help check-in ids, road segment ids).
 *
 * Wire shape: contracts.ts IncidentPicture. The block is capped at PICTURE_MAX_BYTES of JSON so
 * the decide body stays under its 200 kB limit.
 */

import type { ParticipantsResponse } from "../appint/types";
import { pointInArea } from "../live/geo";
import type { PeopleSnapshot } from "../live/people/types";
import type { CommandResponse, FieldReport, GroundChannel, ReportStatus } from "../live/types";
import type { IncidentPicture, PictureMessage, PictureSource } from "./contracts";

/** Upper bound of the block's JSON, bytes. */
export const PICTURE_MAX_BYTES = 14_000;
const MAX_MESSAGES = 14;
const MAX_HELP = 10;
const MAX_ROAD_REPORTS = 10;
const MAX_ROADS = 12;
const MAX_ZONES = 12;
const MAX_STUCK = 8;
const MAX_PHONE_REPORTS = 8;
const MAX_FLAGGED = 8;
const NOTE_CHARS = 90;
/** A destination at or above this share of its vehicle capacity is listed. */
const NEAR_CAPACITY = 0.8;
const CALL_CHANNELS = ["911", "radio", "rescue"] as const;
const OPEN: ReadonlySet<ReportStatus> = new Set(["unverified", "corroborated", "responder_confirmed", "confirmed"]);
/** Most urgent first. */
const KIND_RANK: Record<string, number> = { help_needed: 0, fire_seen: 1, road_blocked: 2, shelter_full: 3, hazard_down: 4, heavy_smoke: 5, heavy_traffic: 6, road_passable: 7 };

/** What the monitor compares between decisions (full sets, not the bounded lists). */
export interface PictureKeys {
  /** Open need_help check-ins and open help_needed reports. */
  help: string[];
  /** Open road_blocked reports. */
  blocked: string[];
  /** Reports from real phones (app participants). */
  realPhone: string[];
  /** Reports a controller or responder confirmed. */
  confirmed: string[];
}

export interface PictureResult {
  picture: IncidentPicture;
  keys: PictureKeys;
}

const clip = (s: string | null | undefined, n = NOTE_CHARS): string | null =>
  !s ? null : s.length <= n ? s : `${s.slice(0, n - 1)}…`;

function minutesBefore(asOf: string | null, at: string | null | undefined): number | null {
  if (!asOf || !at) return null;
  const d = (Date.parse(asOf) - Date.parse(at)) / 60_000;
  return Number.isFinite(d) ? Math.max(0, Math.round(d)) : null;
}

export function buildIncidentPicture(
  data: CommandResponse,
  people: PeopleSnapshot | null,
  participants: ParticipantsResponse | null,
): PictureResult {
  const asOf = data.drill?.replay_now ?? null;
  const zoneName = new Map(data.zones.map((z) => [z.id, z.name]));
  // Point-in-zone is the costly step: done only for listed items, once per coordinate.
  const zoneCache = new Map<string, string | null>();
  const zoneOf = (coord: [number, number] | null | undefined): string | null => {
    if (!coord) return null;
    const key = `${coord[0]},${coord[1]}`;
    if (!zoneCache.has(key)) zoneCache.set(key, data.zones.find((z) => pointInArea(coord, z.geometry))?.id ?? null);
    return zoneCache.get(key) ?? null;
  };
  const real = new Set((participants?.participants ?? []).filter((p) => p.kind === "real").map((p) => p.id));
  const simulated = new Set((participants?.participants ?? []).filter((p) => p.kind === "simulated").map((p) => p.id));
  const sourceOf = (r: FieldReport): PictureSource => {
    if (r.evidence_class !== "field_report") return r.evidence_class;
    if (simulated.has(r.reporter.party_key) || (r.evidence_class as string) === "simulated") return "simulated_phone";
    return real.has(r.reporter.party_key) ? "real_phone" : "phone";
  };

  const reports = data.reports.filter((r) => r.status !== "withdrawn");
  const open = reports.filter((r) => OPEN.has(r.status));
  const at = (r: FieldReport) => r.replay_at ?? r.received_at;
  const newest = (a: FieldReport, b: FieldReport) => Date.parse(at(b)) - Date.parse(at(a));

  // ---- calls: 911 / radio / rescue of the ground record's window, per zone ----
  const gr = data.ground_record;
  const byZone = new Map<string, { "911": number; radio: number; rescue: number; help: number; fire: number }>();
  if (gr?.available) {
    const since = Date.parse(gr.until) - gr.window_min * 60_000;
    for (const item of gr.items) {
      if (!item.zone_id || Date.parse(item.at) < since || !(CALL_CHANNELS as readonly string[]).includes(item.channel)) continue;
      const z = byZone.get(item.zone_id) ?? { "911": 0, radio: 0, rescue: 0, help: 0, fire: 0 };
      z[item.channel as (typeof CALL_CHANNELS)[number]] += 1;
      byZone.set(item.zone_id, z);
    }
    for (const z of gr.zones) {
      const row = byZone.get(z.zone_id) ?? { "911": 0, radio: 0, rescue: 0, help: 0, fire: 0 };
      row.help = z.help;
      row.fire = z.fire;
      byZone.set(z.zone_id, row);
    }
  }
  const pick = (w: Record<GroundChannel, number> | undefined) => ({ "911": w?.["911"] ?? 0, radio: w?.radio ?? 0, rescue: w?.rescue ?? 0 });

  // ---- help requests: need_help check-ins (phones) and open help_needed reports ----
  const helpCheckins = data.checkins.need_help.filter((h) => h.help?.status !== "resolved");
  const helpReports = open.filter((r) => r.kind === "help_needed").sort(newest);
  const help: IncidentPicture["help_requests"]["items"] = [
    ...helpCheckins
      .slice()
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .map((h) => ({
        id: h.id,
        type: "checkin" as const,
        zone_id: h.zone_id,
        min_ago: minutesBefore(asOf, h.at),
        source: ((h as { simulated?: boolean }).simulated ? "simulated_phone" : "phone") as PictureSource,
        status: h.help?.status ?? "open",
        assignee: h.help?.assignee ?? null,
        task_id: h.help?.task_id ?? null,
        note: null,
      })),
    ...helpReports.map((r) => ({
      id: r.id,
      type: "report" as const,
      zone_id: null as string | null,
      min_ago: minutesBefore(asOf, at(r)),
      source: sourceOf(r),
      status: r.status,
      assignee: null,
      task_id: r.task_id,
      note: clip(r.note, 60),
    })),
  ];
  // Phones first, then newest.
  const helpRank = (h: (typeof help)[number]) => (h.source === "real_phone" || h.source === "phone" ? 0 : h.source === "simulated_phone" ? 1 : 2);
  help.sort((a, b) => helpRank(a) - helpRank(b) || (a.min_ago ?? 1e9) - (b.min_ago ?? 1e9));
  const helpListed = help.slice(0, MAX_HELP);
  const reportById = new Map(helpReports.map((r) => [r.id, r]));
  for (const h of helpListed) if (h.type === "report") h.zone_id = zoneOf(reportById.get(h.id)?.location.coord);

  // ---- messages: the most urgent / most recent open reports as short lines ----
  const msgRank = (r: FieldReport) => (sourceOf(r) === "real_phone" ? 0 : 1) * 100 + (r.status === "confirmed" || r.status === "responder_confirmed" ? 0 : 10) + (KIND_RANK[r.kind] ?? 9);
  // Real-phone reports are listed under participants; here only when that list is not loaded.
  const recent = open.filter((r) => !participants || sourceOf(r) !== "real_phone").sort(newest).slice(0, 60);
  const messages: PictureMessage[] = recent
    .sort((a, b) => msgRank(a) - msgRank(b) || newest(a, b))
    .slice(0, MAX_MESSAGES)
    .map((r) => messageOf(r));
  function messageOf(r: FieldReport): PictureMessage {
    const where = r.road_ref?.name ?? zoneName.get(zoneOf(r.location.coord) ?? "") ?? null;
    const channel = r.record?.channel ? `${r.record.channel}: ` : "";
    const line = `${channel}${r.kind.replace("_", " ")}${r.severity ? ` (${r.severity})` : ""}${where ? ` at ${where}` : ""}${r.note && !r.note.startsWith("2018 record") ? ` - "${clip(r.note, 60)}"` : ""}`;
    return {
      id: r.id,
      kind: r.kind,
      min_ago: minutesBefore(asOf, at(r)),
      line: clip(line, NOTE_CHARS) ?? "",
      source: sourceOf(r),
      evidence_class: r.evidence_class,
      status: r.status,
      road_id: r.road_ref?.segment_id ?? null,
      zone_id: zoneOf(r.location.coord),
    };
  }

  // ---- roads ----
  const roadReports = open
    .filter((r) => r.kind === "road_blocked" || r.kind === "heavy_traffic")
    .sort(newest)
    .slice(0, MAX_ROAD_REPORTS)
    .map((r) => ({
      id: r.id,
      kind: r.kind as "road_blocked" | "heavy_traffic",
      road_id: r.road_ref?.segment_id ?? null,
      road_name: r.road_ref?.name ?? null,
      severity: r.severity,
      status: r.status,
      source: sourceOf(r),
      min_ago: minutesBefore(asOf, at(r)),
    }));
  const roads = data.road_state
    .filter((s) => s.status === "blocked" || s.status === "slow")
    .slice(0, MAX_ROADS)
    .map((s) => ({
      road_id: s.segment_id,
      name: s.name,
      status: s.status,
      decided_by: s.decided_by,
      public: s.public,
      independent_parties: s.independent_parties,
      responder_reports: s.responder_reports,
    }));

  // ---- check-ins ----
  const checkins = data.checkins.by_zone
    .filter((z) => z.out + z.staying + z.need_help > 0)
    .sort((a, b) => b.need_help - a.need_help || b.staying - a.staying || b.out - a.out)
    .slice(0, MAX_ZONES)
    .map((z) => ({ zone_id: z.zone_id, out: z.out, staying: z.staying, need_help: z.need_help }));

  // ---- simulated people: stuck groups and destination load (traffic twin estimates) ----
  const capacity = new Map(data.destinations.map((d) => [d.id, d.capacity_veh]));
  const stuck = people
    ? {
        evidence_class: "simulated" as const,
        people_stuck: people.totals.people.stuck,
        by_reason: people.stuck_by_reason,
        groups: people.stuck
          .slice()
          .sort((a, b) => b.people - a.people)
          .slice(0, MAX_STUCK)
          .map((g) => ({ id: g.id, people: g.people, vehicles: g.veh, road: g.road, reason: g.reason, wait_min: g.longest_wait_min })),
      }
    : null;
  const destinations = people
    ? people.destinations.flatMap((d) => {
        const cap = capacity.get(d.id);
        if (!cap || cap <= 0 || d.veh / cap < NEAR_CAPACITY) return [];
        return [{ id: d.id, name: d.name, kind: d.kind, capacity_veh: cap, arrived_veh: d.veh, full: d.veh >= cap, evidence_class: "simulated" as const }];
      })
    : [];

  // ---- participants (app phones) ----
  const realReports = reports.filter((r) => sourceOf(r) === "real_phone").sort(newest);
  const parts = participants?.participants ?? [];
  const byRole: Record<string, number> = {};
  for (const p of parts) if (p.kind === "real") byRole[p.role] = (byRole[p.role] ?? 0) + 1;
  const participantsBlock = participants
    ? {
        real: { count: participants.counts.real, by_role: byRole },
        simulated: { count: participants.counts.simulated, evidence_class: "simulated" as const },
        real_phone_reports: realReports.slice(0, MAX_PHONE_REPORTS).map((r) => ({ ...messageOf(r), from_real_phone: true as const })),
        flagged: parts
          .filter((p) => p.flags.length > 0)
          .sort((a, b) => Number(a.kind !== "real") - Number(b.kind !== "real"))
          .slice(0, MAX_FLAGGED)
          .map((p) => ({ id: p.id, kind: p.kind, role: p.role, zone_id: p.zone_id, status: p.status, flags: p.flags })),
      }
    : null;

  const picture: IncidentPicture = {
    as_of_drill: asOf,
    evidence:
      "Counts of live drill records. historical_record = 2018 911/radio entry replayed (not a drill report); field_report from a real or simulated phone; drill_fixture = scripted; simulated = traffic twin estimate.",
    calls: {
      window_min: gr?.window_min ?? null,
      in_window: pick(gr?.window),
      total_so_far: pick(gr?.totals),
      by_zone: [...byZone.entries()]
        .map(([zone_id, c]) => ({ zone_id, ...c }))
        .sort((a, b) => b["911"] + b.radio + b.rescue + b.help - (a["911"] + a.radio + a.rescue + a.help))
        .slice(0, MAX_ZONES),
    },
    reports_open: {
      total: open.length,
      by_kind: open.reduce<Record<string, number>>((m, r) => ((m[r.kind] = (m[r.kind] ?? 0) + 1), m), {}),
      by_status: open.reduce<Record<string, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {}),
    },
    help_requests: { open_total: help.length, items: helpListed },
    messages,
    road_reports: roadReports,
    roads,
    checkins,
    stuck,
    destinations_near_capacity: destinations,
    comms: { no_signal_zone_ids: data.no_signal_zone_ids ?? [] },
    participants: participantsBlock,
  };

  const keys: PictureKeys = {
    help: [...helpCheckins.map((h) => h.id), ...helpReports.map((r) => r.id)],
    blocked: open.filter((r) => r.kind === "road_blocked").map((r) => r.id),
    realPhone: realReports.map((r) => r.id),
    confirmed: reports.filter((r) => r.status === "confirmed" || r.status === "responder_confirmed").map((r) => r.id),
  };
  return { picture: fitPicture(picture), keys };
}

/** Trims the longest lists until the block's JSON fits PICTURE_MAX_BYTES. */
function fitPicture(p: IncidentPicture): IncidentPicture {
  const size = () => JSON.stringify(p).length;
  const lists: (() => unknown[])[] = [
    () => p.messages,
    () => p.help_requests.items,
    () => p.road_reports,
    () => p.calls.by_zone,
    () => p.roads,
    () => p.checkins,
    () => p.participants?.real_phone_reports ?? [],
    () => p.participants?.flagged ?? [],
    () => p.stuck?.groups ?? [],
  ];
  for (let guard = 0; size() > PICTURE_MAX_BYTES && guard < 200; guard++) {
    const longest = lists.map((l) => l()).sort((a, b) => b.length - a.length)[0];
    if (!longest || longest.length === 0) break;
    longest.pop();
  }
  return p;
}

// ---- monitor ----

/** Wake reasons for new picture items since `seen` (null = nothing seen yet: no reason). */
export function pictureWakeReasons(keys: PictureKeys | null, seen: PictureKeys | null, picture: IncidentPicture | null): string[] {
  if (!keys || !seen) return [];
  const fresh = (now: string[], before: string[]) => {
    const b = new Set(before);
    return now.filter((id) => !b.has(id));
  };
  const list = (ids: string[]) => (ids.length <= 6 ? ids.join(", ") : `${ids.slice(0, 6).join(", ")} and ${ids.length - 6} more`);
  const reasons: string[] = [];
  const help = fresh(keys.help, seen.help);
  if (help.length) reasons.push(`New help request${help.length > 1 ? "s" : ""}: ${list(help)}.`);
  const blocked = fresh(keys.blocked, seen.blocked);
  if (blocked.length) {
    const names = blocked.map((id) => picture?.road_reports.find((r) => r.id === id)?.road_name ?? id);
    reasons.push(`New road-blocked report${blocked.length > 1 ? "s" : ""}: ${list(names)}.`);
  }
  const phone = fresh(keys.realPhone, seen.realPhone);
  if (phone.length) reasons.push(`New report${phone.length > 1 ? "s" : ""} from a real phone: ${list(phone)}.`);
  const confirmed = fresh(keys.confirmed, seen.confirmed);
  if (confirmed.length) reasons.push(`Report${confirmed.length > 1 ? "s" : ""} confirmed: ${list(confirmed)}.`);
  return reasons;
}
