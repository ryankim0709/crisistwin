/**
 * Headless evaluation of the /live command board (docs/command-demo-realism.md "Evaluation
 * harness"). Not a test: a tool that runs one scenario end to end and prints its outcome metrics
 * (demo/scoring.ts). It loads the board exactly as /live does (useCommandBoard): the active drill's
 * command zones, resource snapshot and Studio fires from the live API, the landscape and inputs
 * through demo/useDemoEnvironment.ts loadEnvironment, zone routes from POST /api/demo/routes and
 * unit road legs from POST /api/demo/crew_routes. The fire solver runs in-process
 * (fireField.ts solveFireField, the same code as the page's worker). The board clock is stepped
 * deterministically (model.step on whole minutes; every solve, route refresh and road leg is
 * awaited before the clock moves, as the page's holds do), and the commander is called at the
 * cadence of useDemoAgent: the monitor (observation.ts wakeReasons) every board minute, a new
 * reported fire at once, one call in flight, a follow-up as soon as it lands.
 *
 * Policies (--policy):
 *   claude   POST /api/demo/decide (the real endpoint and prompt; costs money). While it thinks the
 *            board advances as /live's Auto speed would: latency x 1 board min per real min on an
 *            urgent wake, x 5 on a routine one (autoSpeed.ts), then its orders apply.
 *   baseline the scripted policy in baselinePolicy.ts: only the observation's model decision aids,
 *            no LLM (free). Orders apply at once (or after --think-min board minutes).
 *   none     never orders anything (what the fire does on its own).
 *
 * Board-local: nothing is written to the live drill (no run-state PUTs, guidance, Studio
 * publishes or report triage). Road closures are not loaded (the harness board has none; the
 * routes endpoint still avoids any the controller set).
 *
 * Scenario (default: the drill's newest Studio publish per scenario, as a fresh /live board takes
 * it). Or a synthetic Studio fire for scenario search (never published):
 *   --ign lon,lat[;lon,lat...] --start 0 --report 4 --wind 25 --from 45 --moisture critical
 *   [--name text] [--board berkeley-hills-tilden@10km]
 * Or one listed publish: --fire-id sf_... (reproducible while newer publishes arrive).
 * --fast: coarser route refresh and prefetch for scenario search (see FAST).
 * Other flags: --seed N (default 1), --minutes N (max board minutes, default 360), --out file.json,
 * --base http://localhost:5173, --quiet.
 *
 * Run (from app/):
 *   npx esbuild scripts/live-eval/evaluate.ts --bundle --platform=node --format=esm \
 *     --outfile=/tmp/live-eval.mjs --log-level=error && node /tmp/live-eval.mjs --policy baseline
 */

import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fetchCommand, SERVER_TOKEN } from "../../src/live/api";
import { labelPoint } from "../../src/live/format";
import { fetchSnapshot } from "../../src/live/scenarioSnapshot";
import type { CommandResponse } from "../../src/live/types";
import { parseStudioBoardId } from "../../src/studio/useRegionBoard";
import { CREW_ROUTES_URL, DECIDE_URL, ROUTES_URL, demoUrl, type DecisionEvent, type DemoObservation, type DemoOrder, type StudioFire } from "../../src/demo/contracts";
import { solveFireField } from "../../src/demo/fireField";
import { fireRingsForRouting } from "../../src/demo/fireFootprint";
import {
  activeFires,
  applyFireSolve,
  applyOrder,
  buildFireSolveRequest,
  createBoard,
  fireSolveDue,
  ingestStudioFire,
  roadLegsAwaited,
  setRoutes,
  step,
  zoneForecasts,
  type BaseZone,
  type Board,
} from "../../src/demo/model";
import { afterDecision, buildObservation, newReportedFireIds, rememberDecision, wakeReasons, type MonitorMemory, type WakeUrgency } from "../../src/demo/observation";
import { boardOutcomes } from "../../src/demo/outcomes";
import { moistureOf, type MoistureId } from "../../src/demo/realism";
import { closureKey } from "../../src/demo/roadClosures";
import { caughtBreakdown, runScore, type CaughtBreakdown } from "../../src/demo/scoring";
import { expectedCaught } from "../../src/demo/decisionAids";
import { AUTO_SPEED } from "../../src/demo/autoSpeed";
import { applyCrewRoutes, crewRouteRequests } from "../../src/demo/useCrewRoutes";
import { WEATHER_PRESETS, loadEnvironment, zonesCenter, zonesExtent } from "../../src/demo/useDemoEnvironment";
import { ROUTE_REFRESH_MINUTES, resolveRoutes } from "../../src/demo/useDemoRoutes";
import { studioBaseline, studioFiresToIngest, fetchStudioFires } from "../../src/demo/useStudioFires";
import { DEFAULT_BOARD_RADIUS_METERS } from "../../src/fire/boardSize";
import { baselineOrders } from "./baselinePolicy";

// ---- arguments ----

const argv = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const flag = (name: string) => argv.includes(`--${name}`);
const POLICY = (arg("policy") ?? "baseline") as "claude" | "baseline" | "none";
const SEED = Number(arg("seed") ?? 1);
const MAX_MINUTES = Number(arg("minutes") ?? 360);
const BASE = arg("base") ?? "http://localhost:5173";
const QUIET = flag("quiet");
const THINK_MIN = Number(arg("think-min") ?? 0);
/**
 * --fast (scenario search only, not /live's cadence): zone routes refresh every FAST_ROUTE_REFRESH_MINUTES
 * instead of ROUTE_REFRESH_MINUTES and one prefetch request per board minute instead of two. The
 * routes endpoint takes about 4 s per call on the dev backend, which dominates a run's wall time.
 */
const FAST = flag("fast");
const FAST_ROUTE_REFRESH_MINUTES = 15;
const ROUTE_REFRESH = FAST ? FAST_ROUTE_REFRESH_MINUTES : ROUTE_REFRESH_MINUTES;
/** Most crew_routes requests per board minute beyond the legs the clock waits on (prefetch for the options' road times). */
const PREFETCH_REQUESTS_PER_SETTLE = FAST ? 1 : 2;

// ---- browser stand-ins (Node): relative URLs go to the dev server, which signs controller calls ----

const nodeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" && input.startsWith("/") ? `${BASE}${input}` : input;
  return nodeFetch(url as RequestInfo, init);
}) as typeof fetch;
(globalThis as unknown as { window: unknown }).window = { dispatchEvent: () => true, location: { search: "" } };

const log = (...a: unknown[]) => {
  if (!QUIET) console.log(...a);
};

/** Retries a request on a network error or HTTP 5xx (the dev backend reloads when its code changes). */
async function withRetry(path: string, init: RequestInit): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const r = await fetch(path, init);
      if (r.status < 500 || attempt >= RETRIES) return r;
    } catch (e) {
      if (attempt >= RETRIES) throw e;
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_WAIT_MS));
  }
}
const RETRIES = 30;
const RETRY_WAIT_MS = 2000;

async function getJson<T>(path: string): Promise<T> {
  const r = await withRetry(path, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const r = await withRetry(path, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
  const data = (await r.json().catch(() => null)) as T & { detail?: string };
  if (!r.ok || !data) throw new Error(`${path}: HTTP ${r.status} ${data?.detail ?? ""}`);
  return data;
}

/** useCommandBoard.ts baseZones (copied: that module is a React hook file). */
function baseZones(data: CommandResponse): BaseZone[] {
  return data.zones.flatMap((z) => {
    const polys = z.geometry.type === "Polygon" ? [z.geometry.coordinates] : z.geometry.coordinates;
    const ring = polys.map((p) => p[0] ?? []).sort((a, b) => b.length - a.length)[0];
    const core = labelPoint(z.geometry);
    return ring && ring.length >= 4 && core ? [{ id: z.id, name: z.name, households: z.households, vehicles: z.vehicles, ring, core }] : [];
  });
}

/** A synthetic Studio fire from the flags (scenario search; never published). */
function syntheticFire(incidentId: string, regionId: string): StudioFire | null {
  const ign = arg("ign");
  if (!ign) return null;
  const preset = (arg("moisture") ?? "critical") as MoistureId;
  const m = moistureOf(preset);
  const start = Number(arg("start") ?? 0);
  const report = arg("report");
  return {
    fire_id: `eval-${Date.now()}`,
    published_at: new Date().toISOString(),
    incident_id: incidentId,
    name: arg("name") ?? "Evaluation scenario (not published)",
    scenario_id: "eval",
    region_id: regionId,
    ignitions: ign.split(";").map((p, i) => {
      const [lon, lat] = p.split(",").map(Number);
      return { id: `ign-${i + 1}`, name: `F${i + 1}`, lon, lat, start_minute: start, report_minute: report === undefined ? null : start + Number(report) };
    }),
    wind: { speed_mph: Number(arg("wind") ?? 25), from_deg: Number(arg("from") ?? 45), source: "assumed", label: "Assumed wind (evaluation scenario)" },
    moisture: { preset, label: preset, values: { dead1h: m.dead1h, dead10h: m.dead10h, dead100h: m.dead100h, liveHerb: m.liveHerb, liveWoody: m.liveWoody } },
    horizon_minutes: 360,
    outside_drill: [],
    weather_series: null,
  };
}

// ---- load the board as /live does ----

const active = await getJson<{ incident_id: string; region_id: string | null }>("/api/live/active");
const incidentId = arg("incident") ?? active.incident_id;
const boardId = arg("board") ?? active.region_id;
const signal = new AbortController().signal;
const command = await fetchCommand(SERVER_TOKEN, incidentId, signal);
let snapshot = null;
let snapshotProblem: string | null = null;
try {
  snapshot = await fetchSnapshot(SERVER_TOKEN, incidentId, signal);
} catch (e) {
  snapshotProblem = e instanceof Error ? e.message : String(e);
}
const drillBoard = boardId ? parseStudioBoardId(boardId) : null;
const radius = drillBoard ? (drillBoard.radiusMeters ?? drillBoard.region.radiusMeters) : DEFAULT_BOARD_RADIUS_METERS;
const env = await loadEnvironment(
  WEATHER_PRESETS[0],
  incidentId,
  zonesCenter(command.zones),
  signal,
  zonesExtent(command.zones)?.halfWidthMeters ?? null,
  () => log("landscape: loading live from LANDFIRE (slow)"),
  radius,
  drillBoard ? { region: drillBoard.region, radiusMeters: drillBoard.radiusMeters } : null,
);
const grid = env.landscape;
const board: Board = createBoard(baseZones(command), SEED, env, { snapshot, problem: snapshotProblem });
// useCommandBoard aiOnly: the live board has no rule-based dispatch or escalation.
board.response.autoDispatch = false;
board.response.autoEscalate = false;

const synthetic = syntheticFire(incidentId, drillBoard?.region.id ?? boardId ?? "");
let studioFires: StudioFire[];
if (synthetic) studioFires = [synthetic];
else {
  const listed = await fetchStudioFires(SERVER_TOKEN, incidentId, signal);
  const pinned = arg("fire-id");
  if (pinned) {
    // One listed publish by id (reproducible while newer publishes arrive).
    studioFires = listed.filter((f) => f.fire_id === pinned);
    if (studioFires.length === 0) throw new Error(`Studio fire ${pinned} is not in the feed (${listed.map((f) => f.fire_id).join(", ")})`);
    board.studioBaseline = listed.filter((f) => f.fire_id !== pinned).map((f) => f.fire_id);
  } else {
    board.studioBaseline = studioBaseline(listed, true);
    studioFires = studioFiresToIngest(listed, board.studioBaseline, board.studioFireIds);
  }
}
for (const f of studioFires) ingestStudioFire(board, f);
log(
  `board: ${incidentId} on ${env.landscapeRegion.name} (${env.landscapeSource}, ${grid.width}x${grid.height} cells of ${grid.groundCellSizeMeters} m); ` +
    `${board.zones.length} zones, ${board.teams.length} units, ${board.response.aircraft.length} aircraft; seed ${SEED}; policy ${POLICY}`,
);
for (const f of studioFires) {
  log(`fire: '${f.name}' wind ${f.wind.speed_mph} mph from ${f.wind.from_deg}°, ${f.moisture.preset}; ignitions ${f.ignitions.map((i) => `${i.name} [${i.lon.toFixed(5)}, ${i.lat.toFixed(5)}] start ${i.start_minute} report ${i.report_minute}`).join("; ")}`);
}

// ---- the page's background work, awaited (fire solves, zone routes, unit road legs) ----

let solves = 0;
let solveMs = 0;
const routeMemo = { key: "\u0000", minute: -Infinity };
let routeCalls = 0;
let crewCalls = 0;
let routeMs = 0;
let crewMs = 0;
let observeMs = 0;
/** Largest decide body sent (api/demo.py MAX_DECIDE_BODY_BYTES is 200 kB). */
let maxObservationBytes = 0;
/** Board minute of the last prefetch round (prefetch at most once per whole board minute). */
let prefetchMinute = -1;

async function refreshRoutesIfDue(): Promise<boolean> {
  const fires = activeFires(board);
  const key = `${fires.map((f) => `${f.id}:${f.status}`).join(",")}|${closureKey(board)}`;
  const burning = fires.some((f) => f.status === "burning");
  if (key === routeMemo.key && !(burning && board.minute - routeMemo.minute >= ROUTE_REFRESH)) return false;
  routeMemo.key = key;
  routeMemo.minute = board.minute;
  const t0 = performance.now();
  const data = await postJson<Parameters<typeof resolveRoutes>[0]>(demoUrl(ROUTES_URL, incidentId), { fires: fireRingsForRouting(board, 48) });
  routeMs += performance.now() - t0;
  routeCalls += 1;
  setRoutes(board, resolveRoutes(data));
  return true;
}

async function crewRoutes(): Promise<number> {
  const requests = crewRouteRequests(board, new Set());
  if (requests.length === 0) return 0;
  const t0 = performance.now();
  const data = await postJson<{ routes: Parameters<typeof applyCrewRoutes>[1] }>(demoUrl(CREW_ROUTES_URL, incidentId), { fires: fireRingsForRouting(board, 48), requests });
  crewMs += performance.now() - t0;
  crewCalls += 1;
  applyCrewRoutes(board, data.routes);
  return requests.length;
}

async function settle(): Promise<void> {
  for (let guard = 0; guard < 200; guard += 1) {
    if (fireSolveDue(board) !== null) {
      const minute = board.minute;
      const result = solveFireField(grid, structuredClone(buildFireSolveRequest(board)));
      solves += 1;
      solveMs += result.computeMilliseconds;
      if (!applyFireSolve(board, result, minute)) throw new Error(`solve at ${minute} not applied`);
      continue;
    }
    if (await refreshRoutesIfDue()) continue;
    // Legs the clock waits on (dispatched / returning units) always; the prefetch for the options'
    // road times (useCrewRoutes) in at most PREFETCH_REQUESTS_PER_SETTLE requests per board minute.
    const whole = Math.floor(board.minute + 1e-9);
    if (whole !== prefetchMinute) {
      prefetchMinute = whole;
      prefetchLeft = PREFETCH_REQUESTS_PER_SETTLE;
    }
    if (roadLegsAwaited(board).length > 0 || prefetchLeft > 0) {
      const asked = await crewRoutes();
      if (asked > 0) {
        prefetchLeft -= 1;
        continue;
      }
    }
    return;
  }
  throw new Error(`settle did not converge at minute ${board.minute}`);
}
let prefetchLeft = 0;

async function advance(minutes: number): Promise<void> {
  const target = board.minute + minutes;
  for (let guard = 0; board.minute < target - 1e-9 && guard < 100_000; guard += 1) {
    await settle();
    step(board, target - board.minute);
  }
  await settle();
}

// ---- policies ----

/** Per-call usage as api/dispatch.py decision_usage reports it on the orders line (when the backend sends it). */
interface CallUsage {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
}
const streamUsage: CallUsage[] = [];

interface Decision {
  orders: DemoOrder[];
  rejected: string[];
  summary: string;
  latencyMs: number;
  model: string;
}

/** Wall-clock windows (ms since epoch) of this run's decide calls, to match the backend's usage log lines. */
const callWindows: { start: number; end: number }[] = [];

async function decideClaude(observation: DemoObservation, urgency: WakeUrgency): Promise<Decision> {
  const t0 = performance.now();
  const window = { start: Date.now(), end: Date.now() };
  callWindows.push(window);
  const r = await fetch(demoUrl(DECIDE_URL, incidentId), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson, application/json" },
    body: JSON.stringify({ observation, urgency }),
  });
  if (!r.ok || !r.body) throw new Error(`decide: HTTP ${r.status} ${await r.text()}`);
  const text = await r.text();
  const latencyMs = performance.now() - t0;
  window.end = Date.now();
  for (const line of text.split("\n").filter(Boolean)) {
    const event = JSON.parse(line) as DecisionEvent | { type: "error"; error: string; detail: string };
    if (event.type === "error") throw new Error(`decide: ${(event as { detail: string }).detail}`);
    if (event.type === "orders") {
      const u = (event as { usage?: CallUsage | null }).usage;
      if (u) streamUsage.push(u);
      return { orders: event.orders, rejected: event.rejected.map((x) => x.reason), summary: event.summary, latencyMs, model: event.model };
    }
  }
  throw new Error("decide: no orders line");
}

async function decide(observation: DemoObservation, urgency: WakeUrgency): Promise<Decision> {
  if (POLICY === "claude") return decideClaude(observation, urgency);
  if (POLICY === "none") return { orders: [], rejected: [], summary: "none policy", latencyMs: 0, model: "none" };
  const { orders, summary } = baselineOrders(observation);
  return { orders, rejected: [], summary, latencyMs: 0, model: "baseline" };
}

// ---- the run ----

const startedAt = new Date();
let memory: MonitorMemory | null = null;
let previous: DemoObservation["previous"] = null;
const calledFireIds = new Set<string>();
let lastBucket: number | null = null;
let calls = 0;
let urgentCalls = 0;
let ordersApplied = 0;
let ordersRefused = 0;
let thinkBoardMinutes = 0;
const decisions: { minute: number; urgency: WakeUrgency; applyMinute: number; summary: string; orders: string[]; refused: string[] }[] = [];
const overruns: { zoneId: string; minute: number; households: number; people: number | null; breakdown: CaughtBreakdown; orderedAt: number | null }[] = [];
const recorded = new Set<string>();
const fireTimes = new Map<string, { ignitedAt: number; reportedAt: number | null; containedAt: number | null; outAt: number | null; maxAreaHa: number }>();
const timeline: { minute: number; areaHa: number; burning: number; caught: number; ordered: number; homesBurned: number }[] = [];
let sawFire = false;

const eventLog: { minute: number; actor: string; text: string }[] = [];
const seenEvents = new WeakSet<object>();

function record(): void {
  for (const e of [...board.events].reverse()) {
    if (seenEvents.has(e)) continue;
    seenEvents.add(e);
    eventLog.push({ minute: e.minute, actor: e.actor, text: e.text });
  }
  for (const zone of board.zones) {
    const key = `${zone.id}@${zone.overrunAt}`;
    if (zone.overrunAt !== null && !recorded.has(key)) {
      recorded.add(key);
      overruns.push({ zoneId: zone.id, minute: zone.overrunAt, households: zone.caught, people: zone.caughtPeople, breakdown: caughtBreakdown(zone), orderedAt: zone.orderedAt });
    }
  }
  for (const f of board.fires) {
    sawFire = true;
    const t = fireTimes.get(f.id) ?? { ignitedAt: f.ignitedAt, reportedAt: null, containedAt: null, outAt: null, maxAreaHa: 0 };
    const fr = board.response.fires.get(f.id);
    if (fr && board.minute >= fr.reportAt) t.reportedAt = fr.reportAt;
    t.containedAt = f.containedAt ?? t.containedAt;
    t.outAt = f.outAt ?? t.outAt;
    t.maxAreaHa = Math.max(t.maxAreaHa, f.areaHa);
    fireTimes.set(f.id, t);
  }
}

await settle();
while (board.minute < MAX_MINUTES) {
  record();
  const forecasts = zoneForecasts(board, "reported");
  const urgentNew = newReportedFireIds(board, memory).some((id) => !calledFireIds.has(id));
  const bucket = Math.floor(board.minute + 1e-9);
  if (bucket !== lastBucket || urgentNew) {
    lastBucket = bucket;
    const wake = wakeReasons(board, forecasts, memory);
    if (wake.triggers.length > 0) {
      const tObs = performance.now();
      const observation = buildObservation(board, board.routes, forecasts, wake.reasons, previous, wake.urgency);
      observeMs += performance.now() - tObs;
      maxObservationBytes = Math.max(maxObservationBytes, JSON.stringify({ observation, urgency: wake.urgency }).length);
      for (const f of observation.fires) calledFireIds.add(f.id);
      const seen = rememberDecision(board, forecasts);
      const wokeOnRefusal = wake.triggers.some((t) => t.kind === "refused");
      const minute = observation.clock.minute;
      calls += 1;
      if (wake.urgency === "urgent") urgentCalls += 1;
      const decision = await decide(observation, wake.urgency);
      // The clock keeps running while the commander thinks (Auto speed: autoSpeed.ts).
      const think = POLICY === "claude" ? (decision.latencyMs / 60_000) * AUTO_SPEED[wake.urgency === "urgent" ? "thinking" : "reviewing"] : THINK_MIN;
      thinkBoardMinutes += think;
      if (think > 0) await advance(think);
      const errors = decision.orders.map((o) => applyOrder(board, o, board.routes, "agent"));
      const applied = decision.orders.filter((_, i) => errors[i] === null);
      const refused = [...decision.rejected, ...errors.filter((e): e is string => e !== null).map((e) => `Not applied: ${e}`)];
      ordersApplied += applied.length;
      ordersRefused += refused.length;
      memory = afterDecision(seen, board, applied, refused.length, wokeOnRefusal);
      previous = { minute, summary: decision.summary, rejected: refused };
      lastBucket = null;
      decisions.push({
        minute,
        urgency: wake.urgency,
        applyMinute: Math.round(board.minute * 10) / 10,
        summary: decision.summary,
        orders: applied.map((o) => JSON.stringify(o)),
        refused,
      });
      log(`T+${minute} ${wake.urgency} -> ${applied.length} orders${refused.length ? `, ${refused.length} refused` : ""}${think > 0 ? ` (applied T+${board.minute.toFixed(1)})` : ""}: ${decision.summary.slice(0, 160)}`);
      for (const r of refused) log(`   refused: ${r.slice(0, 200)}`);
      await settle();
      continue;
    }
  }
  if (sawFire && board.scheduled.length === 0 && board.fires.every((f) => f.status === "out")) break;
  if (bucket % 10 === 0 && (timeline.length === 0 || timeline[timeline.length - 1].minute !== bucket)) {
    const s = runScore(board);
    timeline.push({ minute: bucket, areaHa: s.areaBurnedHa, burning: s.fires.burning, caught: board.caughtTotal, ordered: board.zones.filter((z) => z.orderedAt !== null || z.pendingOrder !== null).length, homesBurned: s.homesBurned });
    if (bucket % 30 === 0) log(`  T+${bucket}: ${s.areaBurnedHa} ha, ${s.fires.burning} burning / ${s.fires.contained} contained, caught ${board.caughtTotal} hh (${board.caughtPeopleTotal ?? "?"} people), homes burned ${s.homesBurned}, zones ordered ${timeline[timeline.length - 1].ordered}`);
  }
  await advance(1);
}
record();

// ---- report ----

const score = runScore(board);
const outcomes = boardOutcomes(board, zoneForecasts(board, "reported"));
const people = (n: number | null) => (n === null ? "unknown" : String(n));
// Token usage and cost: api/dispatch.py logs one "Decision usage" line per call (with cost_usd).
// Other sessions may call decide at the same time, so a line counts only when its timestamp falls
// inside one of this run's calls (docker logs -t); a call window holding several lines is ambiguous
// (the line closest to the call's end is taken, and the count of ambiguous calls is reported).
let usage: { calls: number; matched: number; ambiguous: number; input: number; cacheRead: number; cacheWrite: number; output: number; costUsd: number; model: string | null } | null = null;
if (POLICY === "claude") {
  try {
    const logs = execSync(`docker logs -t --since ${startedAt.toISOString()} crisistwin-backend-1 2>&1`, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    const re = /^(\S+) .*Decision usage: model=(\S+) .*?input=(\d+) cache_read=(\d+) (.*?)output=(\d+)(?: cost_usd=([\d.]+))?/gm;
    const lines = [...logs.matchAll(re)].map((m) => ({
      at: Date.parse(m[1]),
      model: m[2],
      input: Number(m[3]),
      cacheRead: Number(m[4]),
      cacheWrite: [...m[5].matchAll(/cache_write\w*=(\d+)/g)].reduce((a, w) => a + Number(w[1]), 0),
      output: Number(m[6]),
      cost: m[7] === undefined ? 0 : Number(m[7]),
    }));
    usage = { calls: callWindows.length, matched: 0, ambiguous: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0, model: null };
    const used = new Set<number>();
    for (const w of callWindows) {
      const inside = lines.map((l, i) => ({ l, i })).filter(({ l, i }) => !used.has(i) && l.at >= w.start - 1000 && l.at <= w.end + 2000);
      if (inside.length === 0) continue;
      if (inside.length > 1) usage.ambiguous += 1;
      const pick = inside.sort((a, b) => Math.abs(a.l.at - w.end) - Math.abs(b.l.at - w.end))[0];
      used.add(pick.i);
      usage.matched += 1;
      usage.model = pick.l.model;
      usage.input += pick.l.input;
      usage.cacheRead += pick.l.cacheRead;
      usage.cacheWrite += pick.l.cacheWrite;
      usage.output += pick.l.output;
      usage.costUsd += pick.l.cost;
    }
    usage.costUsd = Math.round(usage.costUsd * 10000) / 10000;
  } catch (e) {
    log(`usage: could not read backend logs (${e instanceof Error ? e.message : e})`);
  }
}
const firesOut = [...fireTimes.entries()].map(([id, t]) => ({ id, ...t }));
const lastContained = firesOut.every((f) => f.containedAt !== null) ? Math.max(...firesOut.map((f) => f.containedAt!)) : null;
const lastOut = firesOut.every((f) => f.outAt !== null) ? Math.max(...firesOut.map((f) => f.outAt!)) : null;
// Floor for this run's fire: the expected caught had every overrun zone been ordered out at the
// first fire report (decisionAids.expectedCaught at that zone's actual core arrival). The board's
// catch rule makes carless and non-complying households unavoidable once fire reaches a core.
const firstReport = Math.min(...[...fireTimes.values()].map((t) => t.reportedAt ?? Infinity));
const floor = { households: 0, people: 0 as number | null, reportMinute: Number.isFinite(firstReport) ? firstReport : null };
for (const o of overruns) {
  const zone = board.zones.find((z) => z.id === o.zoneId)!;
  const e = expectedCaught(zone, Number.isFinite(firstReport) ? firstReport : 0, o.minute);
  floor.households += e.households;
  floor.people = floor.people === null || e.people === null ? null : floor.people + e.people;
}
const report = {
  incidentId,
  board: env.landscapeRegion.name,
  policy: POLICY,
  seed: SEED,
  scenario: studioFires.map((f) => ({ name: f.name, wind: f.wind, moisture: f.moisture.preset, ignitions: f.ignitions })),
  endMinute: Math.round(board.minute),
  casualties: {
    people: board.caughtPeopleTotal,
    households: board.caughtTotal,
    byZone: overruns,
    breakdown: score.casualties.breakdown,
    floorIfAllOrderedAtReport: floor,
  },
  unableToReachSafety: outcomes.unable,
  closeCalls: outcomes.closeCalls,
  homesBurned: score.homesBurned,
  homesReachedSaved: score.homesReachedSaved,
  homesByZone: score.homesByZone,
  homesMethod: score.homesMethod,
  areaBurnedHa: score.areaBurnedHa,
  fires: firesOut,
  containedAtMinute: lastContained,
  outAtMinute: lastOut,
  zonesOrdered: board.zones.filter((z) => z.orderedAt !== null).map((z) => ({ id: z.id, at: z.orderedAt })),
  agent: { calls, urgentCalls, ordersApplied, ordersRefused, thinkBoardMinutes: Math.round(thinkBoardMinutes * 10) / 10, usage, streamUsage },
  compute: { solves, solveMs: Math.round(solveMs), routeCalls, routeMs: Math.round(routeMs), crewCalls, crewMs: Math.round(crewMs), observeMs: Math.round(observeMs), maxObservationKb: Math.round(maxObservationBytes / 1024), wallS: Math.round((Date.now() - startedAt.getTime()) / 1000) },
  timeline,
  decisions,
  /** Board audit log, oldest first: what was captured each minute (model.ts keeps the newest 200). */
  events: eventLog,
  units: board.teams.map((t) => ({ id: t.id, kind: t.kind, status: t.status, fireId: t.fireId, workMode: t.workMode, travel: t.travel })),
};
const out = arg("out");
if (out) writeFileSync(out, JSON.stringify(report, null, 1));
console.log(
  `RESULT ${POLICY} seed ${SEED}: end T+${report.endMinute}; casualties ${people(board.caughtPeopleTotal)} people (${board.caughtTotal} households; ` +
    `no vehicle ${score.casualties.breakdown.noVehicle.households}, no order ${score.casualties.breakdown.noOrder.households}, stayed despite order ${score.casualties.breakdown.stayedDespiteOrder.households}, ordered too late ${score.casualties.breakdown.tooLate.households}); ` +
    `unable to reach safety ${people(outcomes.unable.people)} people; homes burned ${score.homesBurned} (+${score.homesReachedSaved} reached, saved); area ${score.areaBurnedHa} ha; ` +
    `contained ${lastContained === null ? "no" : `T+${Math.round(lastContained)}`}, out ${lastOut === null ? "no" : `T+${Math.round(lastOut)}`}; ` +
    `${calls} calls (${urgentCalls} urgent), ${ordersApplied} orders, ${ordersRefused} refused`,
);
console.log(`FLOOR: had every overrun zone been ordered at the report (T+${floor.reportMinute}), expected caught ${people(floor.people)} people (${floor.households} households) at the same core arrivals`);
if (usage) console.log(`USAGE (backend log) ${JSON.stringify(usage)}`);
if (streamUsage.length) {
  const sum = (k: keyof CallUsage) => streamUsage.reduce((a, u) => a + (u[k] ?? 0), 0);
  console.log(`USAGE (orders lines) calls ${streamUsage.length}: input ${sum("input_tokens")}, cache read ${sum("cache_read_input_tokens")}, cache write ${sum("cache_creation_input_tokens")}, output ${sum("output_tokens")}, cost $${sum("cost_usd").toFixed(4)}`);
}
