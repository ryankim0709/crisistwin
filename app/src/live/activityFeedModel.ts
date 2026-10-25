/**
 * The /live activity feed (ActivityFeed.tsx): short plain-language lines built from the board's structured event
 * refs (demo/model.ts BoardEventRefs), Claude's decisions and the live drill's decisions. Pure:
 * no React. Every number shown comes from the model (refs logged with the event, or the zone's
 * counts now); nothing is parsed back out of the audit text, which stays in `records` for the
 * details view.
 *
 * Grouping (one line per group, oldest member's key as its id):
 * - an order arriving (or, with the rule-based response on in scripts, a run card) and the units it sent in one minute:
 *   "2 engines, 1 hand crew dispatched → S1-F1 (Panoramic Hill)". On /live nothing is dispatched automatically:
 *   Claude's orders appear as Claude decision lines, the controller's as "You sent ...";
 * - units parked and hiking in / walking a dozer in, per fire and mode within ACCESS_WINDOW min;
 * - units back at station (or covering one) within HOME_WINDOW min;
 * - releases, reliefs, cancellations, no-route refusals and move-ups in the same minute;
 * - aircraft over one fire within AIR_WINDOW min; one escalation stage's orders;
 * - Claude reviews with no change in a row; repeated drill actions within DRILL_WINDOW_MS.
 * States: proposed (Claude thinking / refused orders, an evacuation scheduled but not started),
 * in progress (dispatched, en route, hiking in, evacuating, returning, moving up), completed
 * (arrived, contained, out, back at station, reopened, everyone an evacuation sends out has left
 * and arrived, a schedule cancelled), info (everything else). A fire event alone never implies a response.
 * Report rule (demo/boardResponse.ts): the board logs no dispatch, order, escalation or zone
 * threat for a fire before its report, so none shows here; its Studio ignition line says it is not
 * yet reported (simulated), and the report itself is one line with the time and how it came in.
 */

import { isLiveOrder, type CommanderOrder, type DemoOrder } from "../demo/contracts";
import { nf, simClock } from "../demo/format";
import { zoneCounts, zoneOrderStatus, zonePeople, type Board, type BoardEvent, type BoardEventRefs } from "../demo/model";
import { REPORT_BY_LABEL, isReported } from "../demo/boardResponse";
import type { AgentDecision } from "../demo/useDemoAgent";
import { boardEventKeys, drillVerb } from "./auditEntries";
import type { Decision } from "./types";

export type FeedSource = "board" | "studio" | "you" | "claude" | "drill";
export type FeedState = "proposed" | "in_progress" | "completed" | "info";
export type FeedBoardRef = { kind: "fire" | "zone" | "team"; id: string };

export interface FeedAttention {
  tone: "warning" | "danger";
  /** Short tag text: never colour alone. */
  label: string;
}

/** One original audit line behind a feed item. */
export interface FeedRecord {
  text: string;
  /** Board minute (sim clock), or null for a drill decision. */
  minute: number | null;
  source: FeedSource;
}

export interface FeedClaude {
  summary: string;
  wokeBecause: string[];
  /** Claude's assessment (AI explanation). */
  reasoning: string;
  model: string;
  orders: { text: string; ok: boolean; error: string | null }[];
}

export interface FeedItem {
  id: string;
  source: FeedSource;
  state: FeedState;
  attention: FeedAttention | null;
  title: string;
  /** One quiet line under the title (progress from the model now, a note). */
  sub: string | null;
  /** Latest board minute of the group; null for drill items. */
  minute: number | null;
  /** Sort key: drill decision time, or when the page first saw the newest member. */
  wallMs: number;
  /** Members merged into this line. */
  count: number;
  records: FeedRecord[];
  /** Fire, zone, unit, destination, station and order ids the line is about. */
  ids: string[];
  boardRef: FeedBoardRef | null;
  reportIds: string[] | null;
  claude: FeedClaude | null;
  /** Drill decision taken by the auto policy. */
  automatic: boolean;
}

export interface FeedInput {
  board: Board | null;
  decisions: readonly AgentDecision[];
  liveDecisions: readonly Decision[];
  /** Zone / destination display name (the page's resolver). */
  name: (id: string) => string;
  /** When the page first saw `key` (serverNow frame); stable per key. */
  stamp: (key: string) => number;
}

export const FEED_CAP = 150;
const ACCESS_WINDOW = 30;
const HOME_WINDOW = 3;
const AIR_WINDOW = 15;
const NO_ROUTE_WINDOW = 5;
const DRILL_WINDOW_MS = 120_000;

// ---- names ----

const UNIT_KIND: Record<string, [string, string]> = {
  engine_t3: ["Engine", "engines"],
  engine_t1: ["Engine", "engines"],
  hand_crew_t1: ["Hand crew", "hand crews"],
  dozer_t2: ["Dozer", "dozers"],
  air_attack: ["Air attack", "air attack aircraft"],
  airtanker_s2t: ["Airtanker", "airtankers"],
  helicopter_t2: ["Helicopter", "helicopters"],
};

const RESOURCE: Record<string, [string, string]> = {
  engine_strike_team: ["engine strike team", "engine strike teams"],
  crew_strike_team: ["crew strike team", "crew strike teams"],
  dozer_strike_team: ["dozer strike team", "dozer strike teams"],
  airtanker: ["airtanker", "airtankers"],
  helicopter: ["helicopter", "helicopters"],
};

const plural = (n: number, [one, many]: [string, string]) => `${nf(n)} ${n === 1 ? one.toLowerCase() : many}`;

interface Ctx {
  board: Board | null;
  name: (id: string) => string;
  /** Fire id -> zone id it started in (ignition refs). */
  fireZone: Map<string, string>;
  /** Unit / aircraft id -> kind, for units still on the board. */
  unitKind: Map<string, string>;
}

/** A zone's display name without a leading "near " ("near Panoramic Hill" -> "Panoramic Hill"). */
export function placeName(raw: string): string {
  const t = raw.trim();
  return t.toLowerCase().startsWith("near ") ? t.slice(5).trim() : t;
}

function zoneName(ctx: Ctx, id: string): string {
  return placeName(ctx.board?.zones.find((z) => z.id === id)?.name ?? ctx.name(id));
}

function fireLabel(ctx: Ctx, fireId: string | undefined): string {
  if (!fireId) return "its fire";
  const zone = ctx.fireZone.get(fireId);
  return zone ? `${fireId} (${zoneName(ctx, zone)})` : fireId;
}

function unitLabel(ctx: Ctx, id: string): string {
  const kind = ctx.unitKind.get(id);
  return kind && UNIT_KIND[kind] ? `${UNIT_KIND[kind][0]} ${id}` : `Unit ${id}`;
}

/** "2 engines, 1 hand crew" (units no longer on the board count as "units"). */
function unitCounts(ctx: Ctx, ids: readonly string[]): string {
  const counts = new Map<string, { n: number; label: [string, string] }>();
  for (const id of ids) {
    const kind = ctx.unitKind.get(id);
    const label = (kind && UNIT_KIND[kind]) || (["Unit", "units"] as [string, string]);
    const key = label[1];
    const c = counts.get(key) ?? { n: 0, label };
    c.n += 1;
    counts.set(key, c);
  }
  return [...counts.values()].map((c) => plural(c.n, c.label)).join(", ");
}

/** One unit by name, or the counts for several. */
function unitsText(ctx: Ctx, ids: readonly string[]): string {
  return ids.length === 1 ? unitLabel(ctx, ids[0]) : unitCounts(ctx, ids);
}

function stationName(ctx: Ctx, id: string | undefined): string {
  if (!id) return "its station";
  return ctx.board?.stations.find((s) => s.id === id)?.name ?? id;
}

const uniq = (xs: readonly (string | undefined | null)[]): string[] => [...new Set(xs.filter((x): x is string => !!x))];

// ---- board events ----

interface Member {
  key: string;
  ev: BoardEvent;
  refs: BoardEventRefs | null;
}

interface Group {
  family: string;
  key: string | null;
  members: Member[];
}

function sourceOf(ev: BoardEvent): FeedSource {
  return ev.actor === "you" ? "you" : ev.actor === "studio" ? "studio" : ev.actor === "agent" ? "claude" : "board";
}

/** The grouping key and window (minutes) of an event; null = a line of its own. */
function groupKey(ev: BoardEvent, r: BoardEventRefs): { family: string; key: string; window: number } | null {
  const f = r.fireId ?? "";
  const m = ev.minute;
  switch (r.action) {
    case "run_card":
    case "dispatched":
    case "aircraft_dispatched":
      return { family: "dispatch", key: `dispatch|${ev.actor}|${f}|${m}`, window: 0 };
    case "resources_ordered":
      return r.stage !== undefined
        ? { family: "escalation", key: `esc|${f}|${r.stage}`, window: Infinity }
        : { family: "order", key: `order|${ev.actor}|${f}|${m}`, window: 0 };
    case "escalation_due":
      return { family: "escalation", key: `esc|${f}|${r.stage ?? ""}`, window: Infinity };
    case "unit_access":
      return { family: "access", key: `access|${f}|${r.workMode ?? ""}`, window: ACCESS_WINDOW };
    case "released":
    case "relieved":
      return { family: "released", key: `rel|${r.action}|${ev.actor}|${f}|${m}`, window: 0 };
    case "back_at_station":
    case "covering_station":
      return { family: "home", key: `home|${r.action}`, window: HOME_WINDOW };
    case "aircraft_over_fire":
      return { family: "air_over", key: `air|${f}`, window: AIR_WINDOW };
    case "order_cancelled":
      return { family: "cancelled", key: `cancel|${f}|${m}`, window: 0 };
    case "no_route_fire":
      return { family: "no_route", key: `noroute|${f}`, window: NO_ROUTE_WINDOW };
    case "no_route_home":
      return { family: "no_route_home", key: `nrhome`, window: NO_ROUTE_WINDOW };
    case "move_up":
      return { family: "move_up", key: `moveup|${m}`, window: 0 };
    case "ignition_skipped":
      return { family: "skipped", key: `skip|${r.studioTag ?? ""}`, window: Infinity };
    default:
      return null;
  }
}

/** Groups board events oldest first. Agent events go to `agentEvents` (shown under Claude's decision). */
function groupBoard(board: Board): { groups: Group[]; agentEvents: Member[] } {
  const keys = boardEventKeys(board.events);
  const groups: Group[] = [];
  const open = new Map<string, { group: Group; last: number; window: number }>();
  const agentEvents: Member[] = [];
  const reassigned = new Map<string, Member>();
  for (let i = board.events.length - 1; i >= 0; i -= 1) {
    const ev = board.events[i];
    const member: Member = { key: keys[i], ev, refs: ev.refs ?? null };
    if (member.refs?.action === "monitoring_started") continue;
    if (ev.actor === "agent") {
      agentEvents.push(member);
      continue;
    }
    if (member.refs?.action === "reassigned") {
      // Shown inside the dispatch line that follows it (same unit, minute and actor) when there is one.
      reassigned.set(`${ev.actor}|${ev.minute}|${member.refs.teamIds?.[0] ?? ""}`, member);
      continue;
    }
    const g = member.refs ? groupKey(ev, member.refs) : null;
    if (g) {
      const cur = open.get(g.key);
      if (cur && ev.minute - cur.last <= cur.window) {
        cur.group.members.push(member);
        cur.last = ev.minute;
        continue;
      }
      const group: Group = { family: g.family, key: g.key, members: [member] };
      groups.push(group);
      open.set(g.key, { group, last: ev.minute, window: g.window });
      continue;
    }
    groups.push({ family: member.refs?.action ?? "plain", key: null, members: [member] });
  }
  // Reassignments with no dispatch line to join stand alone.
  const joined = new Set<Member>();
  for (const g of groups) {
    if (g.family !== "dispatch") continue;
    for (const m of [...g.members]) {
      if (m.refs?.action !== "dispatched") continue;
      const r = reassigned.get(`${m.ev.actor}|${m.ev.minute}|${m.refs.teamIds?.[0] ?? ""}`);
      if (r && !joined.has(r)) {
        joined.add(r);
        g.members.push(r);
      }
    }
  }
  for (const r of reassigned.values()) if (!joined.has(r)) groups.push({ family: "reassigned", key: null, members: [r] });
  return { groups, agentEvents };
}

type Rendered = Pick<FeedItem, "title" | "sub" | "state" | "attention" | "boardRef"> & { progressZone?: string };

/** A feed item before the evacuation-progress pass. */
type Draft = FeedItem & { progressZone?: string };

/** Units of a dispatch line still driving to the fire now, and the soonest on-scene minute among them. */
function stillComing(
  ctx: Ctx,
  fireId: string | undefined,
  ids: readonly string[],
): { coming: number; pending: number; onScene: number; eta: number | null } {
  const board = ctx.board;
  let coming = 0;
  let pending = 0;
  let onScene = 0;
  let eta: number | null = null;
  if (!board || !fireId) return { coming, pending, onScene, eta };
  for (const id of ids) {
    const t = board.teams.find((x) => x.id === id);
    if (t) {
      if (t.fireId === fireId && (t.status === "on_scene" || t.status === "refilling")) onScene += 1;
      if (t.status !== "en_route" || t.fireId !== fireId) continue;
      coming += 1;
      if (t.travel === "pending") pending += 1;
      else if (t.arriveAt !== null) {
        const m = Math.max(0, Math.ceil(t.arriveAt - board.minute));
        eta = eta === null ? m : Math.min(eta, m);
      }
      continue;
    }
    const a = board.response.aircraft.find((x) => x.id === id);
    if (a && a.status === "over_fire" && a.fireId === fireId) onScene += 1;
    if (a && a.status === "en_route" && a.fireId === fireId) {
      coming += 1;
      if (a.overFireAt !== null) {
        const m = Math.max(0, Math.ceil(a.overFireAt - board.minute));
        eta = eta === null ? m : Math.min(eta, m);
      }
    }
  }
  return { coming, pending, onScene, eta };
}

/** "42 people reached safety · 30 on the road · 80 still home" for a zone now (model counts), or null. */
function zoneProgress(ctx: Ctx, zoneId: string): string | null {
  const zone = ctx.board?.zones.find((z) => z.id === zoneId);
  if (!zone || !ctx.board) return null;
  const c = zoneCounts(zone, ctx.board.minute);
  const p = zonePeople(zone, ctx.board.minute);
  const people = p.out !== null && p.enRoute !== null && p.home !== null;
  const unit = people ? "people" : "households";
  const out = people ? p.out! : c.out;
  const road = people ? p.enRoute! : c.enRoute;
  const home = people ? p.home! : c.home;
  const parts: string[] = [];
  if (out > 0) parts.push(`${nf(out)} ${unit} reached safety`);
  if (road > 0) parts.push(`${nf(road)} on the road`);
  if (home > 0 && zone.overrunAt === null) parts.push(`${nf(home)} still home`);
  if (c.noVehicleHome > 0) parts.push(`${nf(c.noVehicleHome)} households without a vehicle need transport`);
  return parts.length ? parts.join(" · ") : null;
}

function renderGroup(ctx: Ctx, g: Group): Rendered {
  const ms = g.members;
  const first = ms[0];
  const r = first.refs;
  const last = ms[ms.length - 1];
  const teamIds = uniq(ms.flatMap((m) => m.refs?.teamIds ?? []));
  const fireId = r?.fireId;
  const fireRef: FeedBoardRef | null = fireId ? { kind: "fire", id: fireId } : null;
  const teamRef: FeedBoardRef | null = teamIds.length === 1 ? { kind: "team", id: teamIds[0] } : null;
  const quiet = (title: string, state: FeedState = "info", boardRef: FeedBoardRef | null = fireRef): Rendered => ({
    title,
    sub: null,
    state,
    attention: null,
    boardRef,
  });
  if (!r) {
    const kind = first.ev.kind;
    return quiet(first.ev.text, kind === "contained" || kind === "out" ? "completed" : "info", null);
  }
  const who = (ev: BoardEvent) => (ev.actor === "you" ? "You" : null);
  switch (g.family) {
    case "dispatch": {
      const sent = ms.filter((m) => m.refs?.action === "dispatched" || m.refs?.action === "aircraft_dispatched");
      const ids = uniq(sent.flatMap((m) => m.refs?.teamIds ?? []));
      const card = ms.some((m) => m.refs?.action === "run_card");
      const reassign = ms.some((m) => m.refs?.action === "reassigned");
      const position = uniq(sent.map((m) => m.refs?.positionId))[0];
      const to = `${fireLabel(ctx, fireId)}${position ? ` ${position}` : ""}`;
      if (ids.length === 0) {
        return {
          title: `Run card for ${fireLabel(ctx, fireId)}: no free unit could be sent.`,
          sub: null,
          state: "info",
          attention: { tone: "warning", label: "No units" },
          boardRef: fireRef,
        };
      }
      const now = stillComing(ctx, fireId, ids);
      const actor = who(first.ev);
      const title = `${actor ? "You sent " : ""}${unitsText(ctx, ids)}${actor ? "" : " dispatched"}${reassign ? " (reassigned)" : ""} → ${to}.`;
      const subParts: string[] = [];
      if (card) subParts.push("Run card");
      if (now.coming > 0) {
        if (now.eta !== null) subParts.push(`${now.coming === ids.length ? "" : `${now.coming} still `}en route, first on scene in ~${now.eta} min`.trim());
        else subParts.push(`${now.coming} en route`);
        if (now.pending > 0) subParts.push(`${now.pending} waiting for a road route`);
      } else if (now.onScene > 0) subParts.push(`${now.onScene} on scene`);
      return {
        title,
        sub: subParts.length ? cap(subParts.join(" · ")) : null,
        state: now.coming > 0 ? "in_progress" : "completed",
        attention: null,
        boardRef: ids.length === 1 ? { kind: "team", id: ids[0] } : fireRef,
      };
    }
    case "order": {
      const n = ms.reduce((s, m) => s + (m.refs?.count ?? 0), 0);
      const unfilled = ms.reduce((s, m) => s + (m.refs?.unfilled ?? 0), 0);
      const what = uniq(ms.map((m) => m.refs?.resource))
        .map((res) => plural(ms.filter((m) => m.refs?.resource === res).reduce((s, m) => s + (m.refs?.count ?? 0), 0), RESOURCE[res] ?? [res, res]))
        .join(", ");
      const actor = who(first.ev);
      return {
        title: `${actor ? "You ordered" : "Ordered"} ${what || `${nf(n)} resources`} for ${fireLabel(ctx, fireId)}.`,
        sub: unfilled > 0 ? `${nf(unfilled)} not filled yet` : null,
        state: "in_progress",
        attention: unfilled > 0 ? { tone: "warning", label: "Unfilled" } : null,
        boardRef: fireRef,
      };
    }
    case "escalation": {
      const stage = r.stage ?? last.refs?.stage;
      const orders = ms.filter((m) => m.refs?.action === "resources_ordered");
      const what = orders.map((m) => plural(m.refs?.count ?? 0, RESOURCE[m.refs?.resource ?? ""] ?? ["resource", "resources"])).join(", ");
      const unfilled = orders.reduce((s, m) => s + (m.refs?.unfilled ?? 0), 0);
      return {
        title: orders.length
          ? `${fireLabel(ctx, fireId)} escalated${stage ? ` (stage ${stage})` : ""}: ordered ${what}.`
          : `${fireLabel(ctx, fireId)}: extended attack${stage ? ` stage ${stage}` : ""} due; nothing is ordered until the AI agent (or you) orders it.`,
        sub: unfilled > 0 ? `${nf(unfilled)} not filled yet` : null,
        state: orders.length ? "in_progress" : "proposed",
        attention: { tone: "warning", label: orders.length ? "Escalation" : "Needs an order" },
        boardRef: fireRef,
      };
    }
    case "access": {
      const mode = r.workMode;
      const units = unitsText(ctx, teamIds);
      if (mode === "out_of_reach") {
        return {
          title: `${units} too far from ${fireLabel(ctx, fireId)} to build line.`,
          sub: null,
          state: "info",
          attention: { tone: "warning", label: "Can't reach" },
          boardRef: teamRef ?? fireRef,
        };
      }
      if (mode === "indirect") {
        return quiet(`${units} holding the road they parked on as indirect line: too far to reach ${fireLabel(ctx, fireId)}'s edge in time.`, "in_progress", teamRef ?? fireRef);
      }
      const verb = mode === "dozer" ? "walking the dozer in to" : "parked, hiking in to build line at";
      return quiet(`${units} ${verb} ${fireLabel(ctx, fireId)}.`, "in_progress", teamRef ?? fireRef);
    }
    case "released": {
      const relieved = r.action === "relieved";
      const actor = who(first.ev);
      return quiet(
        `${actor ? "You released " : ""}${unitsText(ctx, teamIds)}${actor ? "" : relieved ? " relieved" : " released"} from ${fireLabel(ctx, fireId)}${relieved ? " to rest (work/rest)" : ""}; returning to station.`,
        "in_progress",
        teamRef ?? fireRef,
      );
    }
    case "reassigned":
      return quiet(`${unitsText(ctx, teamIds)} pulled from ${fireLabel(ctx, fireId)} to be reassigned.`, "in_progress", teamRef);
    case "home": {
      const stations = uniq(ms.map((m) => m.refs?.stationId));
      const covering = r.action === "covering_station";
      const where = stations.length === 1 ? stationName(ctx, stations[0]) : "their stations";
      return quiet(
        covering ? `${unitsText(ctx, teamIds)} covering ${where}.` : `${unitsText(ctx, teamIds)} back at ${where}.`,
        "completed",
        teamRef,
      );
    }
    case "air_over":
      return quiet(`${unitsText(ctx, teamIds)} over ${fireLabel(ctx, fireId)}.`, "completed");
    case "cancelled": {
      const n = uniq(ms.flatMap((m) => m.refs?.orderIds ?? [])).length;
      return quiet(`${n === 1 ? "Resource order" : `${nf(n)} resource orders`} for ${fireLabel(ctx, fireId)} cancelled: no longer needed.`);
    }
    case "no_route":
      return {
        title: `${unitsText(ctx, teamIds)} cannot reach ${fireLabel(ctx, fireId)}: no road route.`,
        sub: null,
        state: "info",
        attention: { tone: "warning", label: "Can't reach" },
        boardRef: fireRef,
      };
    case "no_route_home":
      return {
        title: `${unitsText(ctx, teamIds)} ${teamIds.length === 1 ? "has" : "have"} no road route back to station; waiting and retrying.`,
        sub: null,
        state: "in_progress",
        attention: { tone: "warning", label: "No route" },
        boardRef: teamRef,
      };
    case "move_up": {
      const stations = uniq(ms.map((m) => m.refs?.stationId));
      return quiet(
        `${unitsText(ctx, teamIds)} moving up to cover ${stations.length === 1 ? stationName(ctx, stations[0]) : "empty stations"}.`,
        "in_progress",
        teamRef,
      );
    }
    case "skipped":
      return quiet(`${r.studioTag ?? "Studio"}: ${ms.length === 1 ? "1 ignition" : `${nf(ms.length)} ignitions`} skipped.`);
    default:
      break;
  }
  // Single events by action.
  switch (r.action) {
    case "solver_failed":
      return { title: "Fire model failed; the clock holds until it runs again.", sub: null, state: "info", attention: { tone: "danger", label: "Model error" }, boardRef: null };
    case "studio_received":
      return quiet(`Simulation Studio scenario ${r.studioTag ?? ""} received.`.replace(" .", "."), "info", null);
    case "ignition_started": {
      const where = r.zoneId ? ` in ${zoneName(ctx, r.zoneId)}` : "";
      const fire = r.fireId ? ctx.board?.fires.find((f) => f.id === r.fireId) : undefined;
      const unreported = !!(ctx.board && fire && fire.status === "burning" && !isReported(ctx.board, fire));
      return {
        title: `New fire ${r.fireId ?? ""}${where}${unreported ? " (simulated; not yet reported to dispatch, nobody can act on it yet)" : ""}.`,
        sub: null,
        state: "info",
        attention: unreported ? { tone: "warning", label: "Not yet reported" } : null,
        boardRef: fireRef,
      };
    }
    case "ignition_not_started":
      return { title: `Fire ${r.fireId ?? ""} not started: too many fires on the board.`, sub: null, state: "info", attention: { tone: "warning", label: "Not started" }, boardRef: null };
    case "report_joined":
      return quiet(`Field report joined to ${fireLabel(ctx, fireId)}.`);
    case "fire_reported": {
      const by = r.reportedBy;
      const how =
        by === "studio"
          ? "set in Studio"
          : by
            ? `${REPORT_BY_LABEL[by]}${r.reportAfterMin !== undefined ? `, ${nf(r.reportAfterMin)} min after ignition` : ""}`
            : null;
      // AI agent only (boardResponse.dispatchOnReport says so in the event): nothing goes until it is ordered.
      const waits = first.ev.text.includes("No automatic dispatch");
      return {
        ...quiet(`${fireLabel(ctx, fireId)} reported (${simClock(first.ev.minute)}${how ? `, ${how}` : ""}).`),
        sub: waits ? "No automatic dispatch: units go only when the AI agent (or you) orders them." : null,
      };
    }
    case "strategy_set":
      // A person's set_strategy (Claude's shows under its decision line).
      return quiet(`${who(first.ev) ? "You chose" : "Strategy"} ${r.label ? r.label.charAt(0).toLowerCase() + r.label.slice(1) : "a strategy"} for ${fireLabel(ctx, fireId)}.`, "in_progress");
    case "tactic":
      return quiet(`${fireLabel(ctx, fireId)}: ${r.label ? r.label.charAt(0).toLowerCase() + r.label.slice(1) : "tactic changed"}.`);
    case "line_breached":
      return { title: `Fire line breached on ${fireLabel(ctx, fireId)}.`, sub: null, state: "info", attention: { tone: "warning", label: "Line breached" }, boardRef: fireRef };
    case "line_finished":
      return quiet(`${r.lineM !== undefined ? `${nf(r.lineM)} m of line` : "Line"} finished on ${fireLabel(ctx, fireId)}${r.positionId ? ` ${r.positionId}` : ""}.`, "completed");
    case "line_late":
      return {
        title: `Fire reached ${fireLabel(ctx, fireId)}${r.positionId ? ` ${r.positionId}` : ""} before ${unitsText(ctx, teamIds)}.`,
        sub: "Did not engage; free to be re-tasked",
        state: "in_progress",
        attention: { tone: "warning", label: "Too late" },
        boardRef: fireRef,
      };
    case "line_overrun":
      return {
        title: `Fire reached ${fireLabel(ctx, fireId)}${r.positionId ? ` ${r.positionId}` : ""} before its line was finished${r.lineM !== undefined ? ` (${nf(r.lineM)} m built)` : ""}.`,
        sub: `${unitsText(ctx, teamIds)} pulled back; free to be re-tasked`,
        state: "info",
        attention: { tone: "warning", label: "Pulled back" },
        boardRef: fireRef,
      };
    case "road_cut":
      return {
        title: `Fire cut the road for ${unitsText(ctx, teamIds)} to ${fireLabel(ctx, fireId)}; rerouting.`,
        sub: null,
        state: "in_progress",
        attention: { tone: "warning", label: "Road cut" },
        boardRef: teamRef ?? fireRef,
      };
    case "road_blocked":
      return {
        title: `${unitsText(ctx, teamIds)} cannot reach ${fireLabel(ctx, fireId)}: fire keeps cutting the road.`,
        sub: "Trip given up; free to be re-tasked",
        state: "info",
        attention: { tone: "warning", label: "Can't reach" },
        boardRef: teamRef ?? fireRef,
      };
    case "road_closed": {
      // Controller drill road closure (demo/roadClosures.ts): units and zones the board rerouted.
      const n = teamIds.length;
      const zones = r.count ?? 0;
      const parts = [n ? `${n} unit${n === 1 ? "" : "s"}` : "", zones ? `${zones} zone${zones === 1 ? "" : "s"}` : ""].filter(Boolean);
      return {
        title: `Road closed: ${r.label ?? "a road"} (drill, by controller)${parts.length ? ` — ${parts.join(" and ")} rerouted` : " — nothing had to reroute"}.`,
        sub: null,
        state: "info",
        attention: { tone: "warning", label: "Road closed" },
        boardRef: teamRef,
      };
    }
    case "road_reopened":
      return quiet(`Road reopened: ${r.label ?? "a road"} (drill, by controller); routes recomputed.`, "completed", null);
    case "no_route_closure":
      return {
        title: `${r.zoneId ? zoneName(ctx, r.zoneId) : "A zone"}: no open route around the closed road; households wait.`,
        sub: null,
        state: "info",
        attention: { tone: "danger", label: "No route" },
        boardRef: r.zoneId ? { kind: "zone", id: r.zoneId } : null,
        progressZone: r.zoneId,
      };
    case "no_route_cover":
      return quiet(`${unitsText(ctx, teamIds)} cannot reach ${stationName(ctx, r.stationId)} to cover it; staying put.`, "info", teamRef);
    case "no_route_offboard":
      return quiet(`${unitsText(ctx, teamIds)} released from the board where it stands (no road off the board).`, "completed", teamRef);
    case "evacuation_ordered":
    case "evacuation_redirected": {
      const zone = r.zoneId ? zoneName(ctx, r.zoneId) : "Zone";
      const dest = r.destinationId ? ctx.name(r.destinationId) : "its destination";
      const actor = who(first.ev);
      const verb = r.action === "evacuation_redirected" ? "Evacuation redirected" : "Evacuation ordered";
      return {
        title: `${actor ? `You: ${verb.toLowerCase()}` : verb}: ${zone} → ${dest}${r.etaMin !== undefined ? ` (${nf(r.etaMin)} min drive)` : ""}.`,
        sub: null,
        state: "in_progress",
        attention: null,
        boardRef: r.zoneId ? { kind: "zone", id: r.zoneId } : null,
        progressZone: r.zoneId,
      };
    }
    case "evacuation_scheduled":
    case "evacuation_rescheduled": {
      const zone = r.zoneId ? zoneName(ctx, r.zoneId) : "Zone";
      const dest = r.destinationId ? ctx.name(r.destinationId) : "its destination";
      const verb = r.action === "evacuation_rescheduled" ? "Evacuation rescheduled" : "Evacuation scheduled";
      const at = r.startMinute !== undefined ? ` at ${simClock(r.startMinute)}` : "";
      return {
        title: `${who(first.ev) ? `You: ${verb.toLowerCase()}` : verb}: ${zone} → ${dest}${at}.`,
        sub: null,
        state: "proposed",
        attention: null,
        boardRef: r.zoneId ? { kind: "zone", id: r.zoneId } : null,
        progressZone: r.zoneId,
      };
    }
    case "evacuation_cancelled": {
      const zone = r.zoneId ? zoneName(ctx, r.zoneId) : "Zone";
      const at = r.startMinute !== undefined ? ` (was ${simClock(r.startMinute)})` : "";
      return {
        title: `${who(first.ev) ? "You cancelled" : "Cancelled"} the scheduled evacuation of ${zone}${at}.`,
        sub: null,
        state: "completed",
        attention: null,
        boardRef: r.zoneId ? { kind: "zone", id: r.zoneId } : null,
        progressZone: r.zoneId,
      };
    }
    case "evacuation_started": {
      const zone = r.zoneId ? zoneName(ctx, r.zoneId) : "Zone";
      const dest = r.destinationId ? ctx.name(r.destinationId) : "its destination";
      return {
        title: `Scheduled evacuation started: ${zone} → ${dest}${r.etaMin !== undefined ? ` (${nf(r.etaMin)} min drive)` : ""}.`,
        sub: null,
        state: "in_progress",
        attention: null,
        boardRef: r.zoneId ? { kind: "zone", id: r.zoneId } : null,
        progressZone: r.zoneId,
      };
    }
    case "zone_reached_no_order": {
      const zone = r.zoneId ? zoneName(ctx, r.zoneId) : "a zone";
      const scheduled = r.startMinute !== undefined;
      return {
        title: scheduled
          ? `Fire reached ${zone} before its scheduled evacuation (${simClock(r.startMinute!)}); households are still home.`
          : `Fire reached ${zone} with no evacuation order; households stay home until ordered out.`,
        sub: null,
        state: "info",
        attention: { tone: "warning", label: scheduled ? "Not started" : "No order" },
        boardRef: r.zoneId ? { kind: "zone", id: r.zoneId } : null,
        progressZone: r.zoneId,
      };
    }
    case "zone_overrun": {
      const zone = r.zoneId ? zoneName(ctx, r.zoneId) : "a zone";
      const hh = r.households ?? 0;
      const people = r.people === undefined ? undefined : r.people;
      const caught =
        hh > 0
          ? `${nf(hh)} households${people === null ? " (persons unknown)" : people !== undefined ? ` (${nf(people)} people)` : ""} still home`
          : "no households still home";
      // Report rule: a loss is shown, but say when no reported fire explains it yet (Claude does not see it then).
      const z = r.zoneId ? ctx.board?.zones.find((x) => x.id === r.zoneId) : undefined;
      const hidden = !!z && z.overrunAt !== null && z.knownTouchedAt === null;
      return {
        title: `Fire overran ${zone}: ${caught}.`,
        sub: hidden ? "The fire is not yet reported to dispatch (simulated); nobody could act on it" : null,
        state: "info",
        attention: hh > 0 ? { tone: "danger", label: "People caught" } : { tone: "warning", label: "Zone overrun" },
        boardRef: r.zoneId ? { kind: "zone", id: r.zoneId } : null,
      };
    }
    case "zone_reopened":
      return quiet(`${r.zoneId ? zoneName(ctx, r.zoneId) : "Zone"} reopened; households back home.`, "completed", r.zoneId ? { kind: "zone", id: r.zoneId } : null);
    case "contained":
      return quiet(`${fireLabel(ctx, fireId)} contained${r.areaHa !== undefined ? ` (${r.areaHa.toFixed(1)} ha)` : ""}.`, "completed");
    case "out":
      return quiet(`${fireLabel(ctx, fireId)} is out${r.areaHa !== undefined ? ` (${r.areaHa.toFixed(1)} ha burned)` : ""}; units heading back.`, "completed");
    case "closed_by_hand":
      return quiet(`You closed out ${fireLabel(ctx, fireId)}.`, "completed");
    case "knocked_down":
    case "mopped_up": {
      // demo/suppression.ts: cells put out since the last report (simulated).
      const ha = r.areaHa !== undefined ? `${r.areaHa.toFixed(1)} ha` : "part";
      const by = teamIds.length ? ` (${unitsText(ctx, teamIds)})` : "";
      return {
        ...quiet(
          r.action === "knocked_down"
            ? `${fireLabel(ctx, fireId)}: crews knocked down ${ha} of burning edge${by}.`
            : `${fireLabel(ctx, fireId)}: mop-up put out ${ha} still burning inside the line${by}.`,
          "info",
        ),
        sub: r.action === "knocked_down" ? "That edge stops advancing" : null,
      };
    }
    default:
      return quiet(first.ev.text);
  }
}

// ---- Claude ----

/** "chose direct attack on S1-F1 (model: contained in ~45 min with 4 Type 3 engines)": the model's numbers from when it was chosen. */
function strategyShort(ctx: Ctx, o: Extract<DemoOrder, { type: "set_strategy" }>): string {
  const chosen = ctx.board?.response.fires.get(o.fire_id)?.strategy;
  const same = chosen && chosen.id === o.strategy_id ? chosen : null;
  const name = same ? same.name.charAt(0).toLowerCase() + same.name.slice(1) : o.strategy_id;
  const where = same?.positionId ? `${name} of ${fireLabel(ctx, o.fire_id)}` : `${name} on ${fireLabel(ctx, o.fire_id)}`;
  return `chose ${where}${same ? ` (model: ${same.predictionText})` : ""}`;
}

function orderShort(ctx: Ctx, o: CommanderOrder): string {
  if (o.type === "send_rescue") return `send a responder to help request ${o.help_id}`;
  if (o.type === "close_road") return `close road ${o.road_id} (live drill)`;
  if (o.type === "reopen_road") return `reopen road ${o.road_id} (live drill)`;
  if (o.type === "confirm_report") return `confirm report ${o.report_id}`;
  if (o.type === "dismiss_report") return `dismiss report ${o.report_id}`;
  if (o.type === "set_strategy") return strategyShort(ctx, o);
  if (o.type === "send_crew") return `send ${unitLabel(ctx, o.crew_id)} → ${fireLabel(ctx, o.fire_id)}${o.position_id ? ` ${o.position_id}` : ""}`;
  if (o.type === "release_crew") return `release ${unitLabel(ctx, o.crew_id)}`;
  if (o.type === "order_resources") return `order ${plural(o.count, RESOURCE[o.resource] ?? [o.resource, o.resource])} for ${fireLabel(ctx, o.fire_id)}`;
  if (o.type === "cancel_evacuation") return `cancel the scheduled evacuation of ${zoneName(ctx, o.zone_id)}`;
  const at = o.start_minute != null ? ` at ${simClock(o.start_minute)}` : "";
  return `evacuate ${zoneName(ctx, o.zone_id)} → ${ctx.name(o.destination_id)}${at}`;
}

function orderRef(o: CommanderOrder): FeedBoardRef | null {
  // Live drill actions name live records (help requests, roads, reports), not board items.
  if (isLiveOrder(o)) return null;
  if (o.type === "send_crew" || o.type === "order_resources" || o.type === "set_strategy") return { kind: "fire", id: o.fire_id };
  if (o.type === "release_crew") return { kind: "team", id: o.crew_id };
  return { kind: "zone", id: o.zone_id };
}

function orderIds(o: CommanderOrder): string[] {
  if (isLiveOrder(o)) return [];
  if (o.type === "send_crew") return [o.crew_id, o.fire_id];
  if (o.type === "release_crew") return [o.crew_id];
  if (o.type === "order_resources" || o.type === "set_strategy") return [o.fire_id];
  if (o.type === "cancel_evacuation") return [o.zone_id];
  return [o.zone_id, o.destination_id];
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function claudeItems(ctx: Ctx, decisions: readonly AgentDecision[], agentEvents: Member[], stamp: (k: string) => number): FeedItem[] {
  const sorted = [...decisions].sort((a, b) => a.minute - b.minute || a.id - b.id);
  // Each applied board event goes to the latest decision at or before its minute.
  const byDecision = new Map<number, Member[]>();
  const loose: Member[] = [];
  for (const m of agentEvents) {
    let owner: AgentDecision | null = null;
    for (const d of sorted) if (d.minute <= m.ev.minute) owner = d;
    if (!owner) loose.push(m);
    else byDecision.set(owner.id, [...(byDecision.get(owner.id) ?? []), m]);
  }
  const out: FeedItem[] = [];
  let quietRun: FeedItem | null = null;
  for (const d of sorted) {
    const ok = d.applied.filter((a) => !a.error);
    const refused = [...d.applied.filter((a) => a.error).map((a) => a.error as string), ...d.rejected.map((x) => x.reason)];
    const applied = byDecision.get(d.id) ?? [];
    const claude: FeedClaude = {
      summary: d.summary,
      wokeBecause: d.wokeBecause,
      reasoning: d.assessment,
      model: d.model,
      orders: [
        ...d.applied.map((a) => ({ text: cap(orderShort(ctx, a.order)) + (a.order.reason ? ` · ${a.order.reason}` : ""), ok: !a.error, error: a.error })),
        ...d.rejected.map((x) => ({ text: "Order rejected", ok: false, error: x.reason })),
      ],
    };
    const records: FeedRecord[] = applied.map((m) => ({ text: m.ev.text, minute: m.ev.minute, source: "claude" as const }));
    const ids = uniq([...d.applied.flatMap((a) => orderIds(a.order)), ...applied.flatMap((m) => [...(m.refs?.teamIds ?? []), m.refs?.fireId, m.refs?.zoneId])]);
    const key = `claude-${d.id}`;
    const wallMs = Math.max(stamp(key), ...applied.map((m) => stamp(m.key)));
    if (ok.length === 0 && refused.length === 0) {
      // Reviews with no change in a row collapse into one line.
      if (quietRun) {
        quietRun.count += 1;
        quietRun.minute = d.minute;
        quietRun.wallMs = Math.max(quietRun.wallMs, wallMs);
        quietRun.title = `Claude reviewed the board ${quietRun.count} times: no change.`;
        quietRun.claude = claude;
        continue;
      }
      quietRun = {
        id: key,
        source: "claude",
        state: "info",
        attention: null,
        title: "Claude reviewed the board: no change.",
        sub: d.summary || null,
        minute: d.minute,
        wallMs,
        count: 1,
        records,
        ids,
        boardRef: null,
        reportIds: null,
        claude,
        automatic: false,
      };
      out.push(quietRun);
      continue;
    }
    quietRun = null;
    const shorts = ok.map((a) => orderShort(ctx, a.order));
    const title =
      ok.length === 0
        ? `Claude's ${refused.length === 1 ? "order was" : `${refused.length} orders were`} refused.`
        : ok.length === 1
          ? ok[0].order.type === "set_strategy"
            ? `Claude ${shorts[0]}.`
            : `Claude: ${shorts[0]}.`
          : `Claude issued ${ok.length} orders.`;
    const sub =
      ok.length === 0
        ? refused[0]
        : ok.length > 1
          ? `${cap(shorts.slice(0, 2).join(" · "))}${ok.length > 2 ? ` · +${ok.length - 2} more` : ""}`
          : refused.length
            ? `Refused: ${refused[0]}`
            : null;
    out.push({
      id: key,
      source: "claude",
      state: ok.length ? "in_progress" : "proposed",
      attention: refused.length ? { tone: "warning", label: ok.length ? `${refused.length} refused` : "Refused" } : null,
      title,
      sub,
      minute: d.minute,
      wallMs,
      count: 1,
      records,
      ids,
      boardRef: ok[0] ? orderRef(ok[0].order) : null,
      reportIds: null,
      claude,
      automatic: false,
    });
  }
  for (const m of loose) {
    out.push({
      id: `feed-${m.key}`,
      source: "claude",
      state: "in_progress",
      attention: null,
      title: m.ev.text,
      sub: null,
      minute: m.ev.minute,
      wallMs: stamp(m.key),
      count: 1,
      records: [{ text: m.ev.text, minute: m.ev.minute, source: "claude" }],
      ids: uniq([...(m.refs?.teamIds ?? []), m.refs?.fireId, m.refs?.zoneId]),
      boardRef: m.refs?.fireId ? { kind: "fire", id: m.refs.fireId } : null,
      reportIds: null,
      claude: null,
      automatic: false,
    });
  }
  return out;
}

// ---- drill ----

const DRILL_IN_PROGRESS = new Set(["task_create", "help_acknowledge", "help_assign"]);
/** live_decisions action of resident guidance published from the board's orders (app/backend/api/live/board_guidance.py). */
const BOARD_GUIDANCE_ACTION = "board_guidance";
/** The old twin-controller planner's decisions: off on Live (the AI agent decides), so not in the feed;
 * the full audit log still lists them, labelled "(old planner)". */
const PLANNER_ACTIONS = new Set(["replan", "approve", "reject", "auto_approve"]);

function drillItems(decisions: readonly Decision[]): FeedItem[] {
  const out: FeedItem[] = [];
  const seen = new Map<string, number>();
  let prev: { item: FeedItem; action: string; at: number } | null = null;
  // Oldest first, so ids and runs are stable as new decisions arrive at the front.
  for (let i = decisions.length - 1; i >= 0; i -= 1) {
    const d = decisions[i];
    if (PLANNER_ACTIONS.has(d.action)) continue;
    const t = new Date(d.at).getTime();
    const at = Number.isNaN(t) ? 0 : t;
    const base = `${d.at}|${d.action}|${d.report_ids.join(",")}|${d.proposal_id ?? ""}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const verb = drillVerb(d.action);
    const record: FeedRecord = { text: d.note ? `${verb}: ${d.note}` : verb, minute: null, source: "drill" };
    if (d.action === BOARD_GUIDANCE_ACTION && d.note) {
      // Resident guidance published from a board order (backend board_guidance.py): one line each, the note is the line.
      out.push({
        id: `drill-${base}|${n}`,
        source: "drill",
        state: "completed",
        attention: null,
        title: d.note,
        sub: d.actor === "ai_agent" ? "From the AI agent's order on the simulated board" : d.actor === "controller" ? "From your order on the simulated board" : "From the simulated board",
        minute: null,
        wallMs: at,
        count: 1,
        records: [record],
        ids: [],
        boardRef: null,
        reportIds: null,
        claude: null,
        automatic: false,
      });
      prev = null;
      continue;
    }
    if (prev && prev.action === d.action && Math.abs(at - prev.at) <= DRILL_WINDOW_MS) {
      const it = prev.item;
      it.count += 1;
      it.title = `${verb} (×${it.count})`;
      it.wallMs = Math.max(it.wallMs, at);
      it.records.push(record);
      it.reportIds = uniq([...(it.reportIds ?? []), ...d.report_ids]);
      it.ids = uniq([...it.ids, ...d.report_ids, d.proposal_id]);
      it.sub = null;
      it.automatic = it.automatic && d.actor === "auto_policy";
      prev.at = at;
      continue;
    }
    const item: FeedItem = {
      id: `drill-${base}|${n}`,
      source: "drill",
      state: d.action.startsWith("drill_") ? "info" : DRILL_IN_PROGRESS.has(d.action) ? "in_progress" : "completed",
      attention: null,
      title: verb,
      sub: d.note,
      minute: null,
      wallMs: at,
      count: 1,
      records: [record],
      ids: uniq([...d.report_ids, d.proposal_id, d.checkin_id]),
      boardRef: null,
      reportIds: d.report_ids.length ? [...d.report_ids] : null,
      claude: null,
      automatic: d.actor === "auto_policy",
    };
    out.push(item);
    prev = { item, action: d.action, at };
  }
  return out;
}

// ---- the feed ----

/** All feed items, newest first (at most FEED_CAP). */
export function buildActivityFeed({ board, decisions, liveDecisions, name, stamp }: FeedInput): FeedItem[] {
  const ctx: Ctx = { board, name, fireZone: new Map(), unitKind: new Map() };
  const items: Draft[] = [];
  let agentEvents: Member[] = [];
  if (board) {
    for (const e of board.events) if (e.refs?.action === "ignition_started" && e.refs.fireId && e.refs.zoneId) ctx.fireZone.set(e.refs.fireId, e.refs.zoneId);
    for (const t of board.teams) ctx.unitKind.set(t.id, t.kind);
    for (const a of board.response.aircraft) ctx.unitKind.set(a.id, a.kind);
    const grouped = groupBoard(board);
    agentEvents = grouped.agentEvents;
    for (const g of grouped.groups) {
      const r = renderGroup(ctx, g);
      const ms = g.members;
      const lastMinute = Math.max(...ms.map((m) => m.ev.minute));
      items.push({
        id: `feed-${ms[0].key}`,
        source: sourceOf(ms[0].ev),
        state: r.state,
        attention: r.attention,
        title: r.title,
        sub: r.sub,
        minute: lastMinute,
        wallMs: Math.max(...ms.map((m) => stamp(m.key))),
        count: ms.length,
        records: ms.map((m) => ({ text: m.ev.text, minute: m.ev.minute, source: sourceOf(m.ev) })),
        ids: uniq(
          ms.flatMap((m) => [
            m.refs?.fireId,
            m.refs?.zoneId,
            ...(m.refs?.teamIds ?? []),
            m.refs?.destinationId,
            m.refs?.stationId,
            m.refs?.positionId,
            ...(m.refs?.orderIds ?? []),
          ]),
        ),
        boardRef: r.boardRef,
        reportIds: null,
        claude: null,
        automatic: false,
        progressZone: r.progressZone,
      });
    }
  }
  items.push(...claudeItems(ctx, decisions, agentEvents, stamp));
  items.push(...drillItems(liveDecisions));
  // Ties (items first seen together): later board minute first, then the later-built item (newer).
  const order = new Map(items.map((it, i) => [it, i]));
  items.sort((a, b) => b.wallMs - a.wallMs || (b.minute ?? -1) - (a.minute ?? -1) || order.get(b)! - order.get(a)!);
  // Evacuation progress (the zone's counts now) on the newest line about each zone only.
  const progressed = new Set<string>();
  for (const it of items) {
    const zoneId = it.progressZone;
    delete it.progressZone;
    if (!zoneId) continue;
    if (progressed.has(zoneId)) {
      it.state = "info";
      continue;
    }
    progressed.add(zoneId);
    const zone = board?.zones.find((z) => z.id === zoneId);
    const progress = zoneProgress(ctx, zoneId);
    it.sub = progress;
    if (!zone || !board) continue;
    const status = zoneOrderStatus(zone, board.minute);
    if (status === "overrun") it.state = "info";
    else if (status === "scheduled" && zone.pendingOrder) {
      // Decided, not started: households stay home until the start minute.
      const start = zone.pendingOrder.startMinute;
      const wait = Math.max(0, Math.ceil(start - board.minute));
      it.state = it.state === "info" ? "info" : "proposed";
      it.sub = `Leaves at ${simClock(start)} (in ${nf(wait)} min)${progress ? ` · ${progress}` : ""}`;
    } else if (status === "leaving") {
      if (it.state === "proposed") it.state = "in_progress";
    } else if (it.state === "in_progress" || it.state === "proposed") it.state = "completed";
  }
  return items.slice(0, FEED_CAP);
}

/** Display label of a feed source (shown once per line, subtly). */
export const FEED_SOURCE_LABEL: Record<FeedSource, string> = {
  board: "Simulated board",
  studio: "Simulation Studio",
  you: "You",
  claude: "Claude",
  drill: "Drill",
};

/** Screen-reader text of a state mark. */
export const FEED_STATE_LABEL: Record<FeedState, string> = {
  proposed: "Proposed",
  in_progress: "In progress",
  completed: "Completed",
  info: "Update",
};
