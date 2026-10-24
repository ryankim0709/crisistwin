import { describe, expect, it } from "vitest";
import {
  DEPARTURE_SPREAD_MINUTES,
  WIND_FROM_DEG,
  applyOrder,
  createBoard,
  fromLocal,
  ignite,
  zoneForecasts,
  type BaseZone,
  type Board,
  type RouteOption,
} from "./model";
import {
  REVIEW_EVERY_MINUTES,
  SLACK_ALERT_MINUTES,
  buildObservation,
  rememberDecision,
  wakeReasons,
} from "./observation";
import type { LonLat } from "../live/types";

const ORIGIN: LonLat = [-121.6, 39.76];
const DOWNWIND = WIND_FROM_DEG + 180;

function square(center: LonLat, halfM: number): LonLat[] {
  return [
    fromLocal(center, [-halfM, -halfM]),
    fromLocal(center, [halfM, -halfM]),
    fromLocal(center, [halfM, halfM]),
    fromLocal(center, [-halfM, halfM]),
  ];
}

/** A point `m` metres from `p` toward bearing `deg` (degrees from north). */
function toward(p: LonLat, deg: number, m: number): LonLat {
  const r = (deg * Math.PI) / 180;
  return fromLocal(p, [Math.sin(r) * m, Math.cos(r) * m]);
}

function zone(id: string, core: LonLat, households = 100): BaseZone {
  return { id, name: `Zone ${id}`, households, ring: square(core, 200), core };
}

function route(destination: string, eta: number): RouteOption {
  return {
    destination_id: destination,
    name: `Exit ${destination}`,
    kind: "exit",
    eta_min: eta,
    distance_m: eta * 800,
    via: ["Skyway"],
    safety: "clear",
    line: [ORIGIN, toward(ORIGIN, 0, 8000)],
  };
}

/**
 * A: the fire starts at its core. B: its core 1600 m downwind of the fire (fire core ETA 80
 * min at 20 m/min). C: 20 km upwind, never reached.
 */
function setup(): { board: Board; routes: Map<string, RouteOption[]> } {
  const board = createBoard(
    [zone("A", ORIGIN), zone("B", toward(ORIGIN, DOWNWIND, 1600)), zone("C", toward(ORIGIN, WIND_FROM_DEG, 20_000))],
    "quiet",
    7,
  );
  const routes = new Map<string, RouteOption[]>([
    ["A", [route("D1", 12), route("D2", 18.4)]],
    ["B", [route("D2", 9)]],
    ["C", [route("D1", 30)]],
  ]);
  return { board, routes };
}

function igniteAtA(board: Board) {
  const fire = ignite(board, ORIGIN, "manual", "you")!;
  fire.headRate = 20;
  return fire;
}

describe("buildObservation", () => {
  it("lists threatened zones with their route options and only counts quiet ones", () => {
    const { board, routes } = setup();
    const fire = igniteAtA(board);
    const obs = buildObservation(board, routes, zoneForecasts(board), ["New fire"], null);

    expect(obs.zones.map((z) => z.id).sort()).toEqual(["A", "B"]);
    expect(obs.quiet_zone_count).toBe(1);
    for (const z of obs.zones) {
      expect(z.options.map((o) => o.destination_id)).toEqual(routes.get(z.id)!.map((r) => r.destination_id));
      expect(Object.keys(z.options[0]).sort()).toEqual(["destination_id", "eta_min", "name", "safety"]);
    }
    expect(obs.zones.find((z) => z.id === "A")!.options[1].eta_min).toBe(18);

    const b = obs.zones.find((z) => z.id === "B")!;
    expect(b.status).toBe("no_order");
    expect(b.fire_core_eta_min).toBe(80);
    expect(b.order_slack_min).toBe(80 - DEPARTURE_SPREAD_MINUTES);

    expect(obs.fires).toHaveLength(1);
    expect(obs.fires[0].id).toBe(fire.id);
    expect(obs.fires[0].threatens_zone_ids.sort()).toEqual(["A", "B"]);
    expect(obs.fires[0].contained_in_min).toBeNull();
    expect(obs.fires[0].options.length).toBeGreaterThan(0);
    expect(obs.crews.every((c) => c.status === "available")).toBe(true);
    expect(obs.totals.crews_available).toBe(obs.crews.length);
    expect(obs.monitor.woke_because).toEqual(["New fire"]);
  });

  it("lists an ordered zone even when no fire threatens it", () => {
    const { board, routes } = setup();
    expect(applyOrder(board, { type: "order_evacuation", zone_id: "C", destination_id: "D1" }, routes, "you")).toBeNull();
    const obs = buildObservation(board, routes, zoneForecasts(board), [], null);
    expect(obs.zones.map((z) => z.id)).toEqual(["C"]);
    expect(obs.zones[0]).toMatchObject({ status: "ordered", destination_id: "D1", fire_eta_min: null });
    expect(obs.quiet_zone_count).toBe(2);
  });

  it("stays well under the 200 kB request cap on a full board", () => {
    const cores = Array.from({ length: 43 }, (_, i) => fromLocal(ORIGIN, [(i % 7) * 900, Math.floor(i / 7) * 900]));
    const board = createBoard(
      cores.map((c, i) => zone(`Z${i}`, c, 500)),
      "severe",
      3,
    );
    const routes = new Map(cores.map((_, i) => [`Z${i}`, [route("D1", 10), route("D2", 14), route("D3", 20)]]));
    for (let i = 0; i < 25; i += 1) ignite(board, cores[i], "scenario", "board")!.tau = 20;
    const obs = buildObservation(board, routes, zoneForecasts(board), ["Periodic review"], {
      minute: 0,
      summary: "x".repeat(600),
      rejected: [],
    });
    expect(obs.fires).toHaveLength(25);
    expect(JSON.stringify(obs).length).toBeLessThan(100_000);
  });
});

describe("wakeReasons", () => {
  it("is quiet when nothing changed since the last decision", () => {
    const { board } = setup();
    igniteAtA(board);
    const memory = rememberDecision(board);
    expect(wakeReasons(board, zoneForecasts(board), memory)).toEqual([]);
  });

  it("wakes on a new fire", () => {
    const { board } = setup();
    const memory = rememberDecision(board);
    const fire = igniteAtA(board);
    const reasons = wakeReasons(board, zoneForecasts(board), memory);
    expect(reasons[0]).toBe(`New fire since the last decision: ${fire.id} (manual).`);
    // It started at A's core, so A is already late as well.
    expect(reasons[1]).toMatch(/^A \(Zone A\) has no evacuation order and is already late/);
    expect(reasons).toHaveLength(2);
  });

  it("wakes when a busy crew is freed", () => {
    const { board, routes } = setup();
    const fire = igniteAtA(board);
    applyOrder(board, { type: "send_crew", crew_id: "T1", fire_id: fire.id }, routes, "agent");
    const memory = rememberDecision(board);
    applyOrder(board, { type: "release_crew", crew_id: "T1" }, routes, "you");
    expect(wakeReasons(board, zoneForecasts(board), memory)).toContain("Crew freed: T1.");
  });

  it("wakes when an unordered zone runs short of order slack, once per tier", () => {
    const { board } = setup();
    const fire = igniteAtA(board);
    const memory = rememberDecision(board);
    // Thirty minutes of burning later B's core is 50 min away: 5 min of order slack.
    fire.tau = 30;
    board.minute = 30;
    const forecasts = zoneForecasts(board);
    const slack = forecasts.get("B")!.coreEta! - DEPARTURE_SPREAD_MINUTES;
    expect(slack).toBeLessThanOrEqual(SLACK_ALERT_MINUTES);
    const reasons = wakeReasons(board, forecasts, memory);
    expect(reasons).toEqual([`B (Zone B) has no evacuation order and ${slack} min of order slack.`]);
    expect(wakeReasons(board, forecasts, rememberDecision(board, forecasts))).toEqual([]);
  });

  it("asks for a periodic review while fires burn", () => {
    const { board } = setup();
    igniteAtA(board);
    const memory = rememberDecision(board);
    board.minute = REVIEW_EVERY_MINUTES - 1;
    expect(wakeReasons(board, zoneForecasts(board), memory)).toEqual([]);
    board.minute = REVIEW_EVERY_MINUTES;
    const reasons = wakeReasons(board, zoneForecasts(board), memory);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/^Periodic review: 30 min since the last decision/);
  });

  it("does not review an empty board", () => {
    const { board } = setup();
    const memory = rememberDecision(board);
    board.minute = 5 * REVIEW_EVERY_MINUTES;
    expect(wakeReasons(board, zoneForecasts(board), memory)).toEqual([]);
  });
});
