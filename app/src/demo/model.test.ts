import { describe, expect, it } from "vitest";
import {
  BACK_RATIO,
  DEPARTURE_SPREAD_MINUTES,
    TEAM_LINE_M_PER_MIN,
  WIND_FROM_DEG,
  addReportFire,
  applyOrder,
  arrivalTau,
  closeFire,
  containedIn,
  createBoard,
  fireRing,
  fromLocal,
  ignite,
  perimeterGrowth,
  step,
  toLocal,
  totals,
  zoneCounts,
  MAX_ACTIVE_FIRES,
  REOPEN_MINUTES,
  OUT_KEEP_MINUTES,
  type BaseZone,
  type RouteOption,
} from "./model";
import type { LonLat } from "../live/types";

const ORIGIN: LonLat = [-121.6, 39.76];

function square(center: LonLat, halfM: number): LonLat[] {
  return [
    fromLocal(center, [-halfM, -halfM]),
    fromLocal(center, [halfM, -halfM]),
    fromLocal(center, [halfM, halfM]),
    fromLocal(center, [-halfM, halfM]),
  ];
}

function zones(): BaseZone[] {
  const far = fromLocal(ORIGIN, [20_000, 20_000]);
  return [
    { id: "Z1", name: "Zone 1", households: 100, ring: square(ORIGIN, 1500), core: ORIGIN },
    { id: "Z2", name: "Zone 2", households: 50, ring: square(far, 1500), core: far },
  ];
}

/** A point `m` metres from `p` toward bearing `deg` (degrees from north). */
function toward(p: LonLat, deg: number, m: number): LonLat {
  const r = (deg * Math.PI) / 180;
  return fromLocal(p, [Math.sin(r) * m, Math.cos(r) * m]);
}

const ROUTE: RouteOption = {
  destination_id: "D1",
  name: "Exit",
  kind: "exit",
  eta_min: 10,
  distance_m: 8000,
  via: [],
  safety: "clear",
  line: [ORIGIN, toward(ORIGIN, 0, 8000)],
};

describe("fire ellipse", () => {
  it("reaches a point downwind at the head rate and upwind at the back rate", () => {
    const fire = { origin: ORIGIN, headRate: 20 };
    const downwind = WIND_FROM_DEG + 180;
    expect(arrivalTau(fire, toward(ORIGIN, downwind, 600))).toBeCloseTo(30, 3);
    expect(arrivalTau(fire, toward(ORIGIN, WIND_FROM_DEG, 100))).toBeCloseTo(100 / (20 * BACK_RATIO), 3);
    expect(arrivalTau(fire, ORIGIN)).toBe(0);
  });

  it("draws its outline through the points it has reached", () => {
    const board = createBoard(zones(), "quiet", 1);
    const fire = ignite(board, ORIGIN, "manual", "you")!;
    fire.tau = 30;
    for (const p of fireRing(fire).slice(0, -1)) expect(arrivalTau(fire, p)).toBeCloseTo(30, 3);
  });

  it("round-trips local metres", () => {
    const p = fromLocal(ORIGIN, [1234, -567]);
    const [x, y] = toLocal(ORIGIN, p);
    expect(x).toBeCloseTo(1234, 6);
    expect(y).toBeCloseTo(-567, 6);
  });
});

describe("containment race", () => {
  it("is never won when the perimeter outgrows the line", () => {
    const board = createBoard(zones(), "quiet", 1);
    const fire = ignite(board, ORIGIN, "manual", "you")!;
    fire.headRate = 60;
    fire.tau = 10;
    expect(perimeterGrowth(60)).toBeGreaterThan(TEAM_LINE_M_PER_MIN);
    expect(containedIn(fire, [0])).toBeNull();
    expect(containedIn(fire, [0, 0, 0, 0])).not.toBeNull();
  });

  it("contains a fire once enough teams are on scene, then puts it out", () => {
    const board = createBoard(zones(), "quiet", 7);
    board.nextIgnitionAt = Infinity;
    const fire = ignite(board, ORIGIN, "manual", "you")!;
    for (const team of board.teams.slice(0, 3)) {
      team.position = ORIGIN;
      expect(applyOrder(board, { type: "send_crew", crew_id: team.id, fire_id: fire.id }, new Map(), "agent")).toBeNull();
    }
    step(board, 60);
    expect(fire.status).toBe("out");
    expect(fire.closedBy).toBe("teams");
    expect(board.teams.every((t) => t.status === "available")).toBe(true);
    expect(board.firesOutTotal).toBe(1);
  });
});

describe("households", () => {
  it("conserves households and catches those still home when fire reaches the core", () => {
    const board = createBoard(zones(), "quiet", 3);
    board.nextIgnitionAt = Infinity;
    const fire = ignite(board, toward(ORIGIN, WIND_FROM_DEG, 600), "manual", "you")!;
    fire.headRate = 20;
    const routes = new Map([["Z1", [ROUTE]]]);
    step(board, 5);
    expect(applyOrder(board, { type: "order_evacuation", zone_id: "Z1", destination_id: "D1" }, routes, "you")).toBeNull();
    step(board, 40);
    const zone = board.zones[0];
    expect(zone.overrunAt).not.toBeNull();
    expect(zone.caught).toBeGreaterThan(0);
    expect(zone.caught).toBeLessThan(zone.households);
    const c = zoneCounts(zone, board.minute);
    expect(c.home + c.enRoute + c.out + c.caught).toBe(zone.households);
    const t = totals(board);
    expect(t.home + t.enRoute + t.out + t.caught).toBe(t.households);
  });

  it("gets everyone out given the departure spread and drive time", () => {
    const board = createBoard(zones(), "quiet", 3);
    board.nextIgnitionAt = Infinity;
    const routes = new Map([["Z2", [ROUTE]]]);
    applyOrder(board, { type: "order_evacuation", zone_id: "Z2", destination_id: "D1" }, routes, "you");
    step(board, DEPARTURE_SPREAD_MINUTES + ROUTE.eta_min + 1);
    expect(zoneCounts(board.zones[1], board.minute)).toEqual({ home: 0, enRoute: 0, out: 50, caught: 0 });
  });
});

describe("continuous monitoring", () => {
  it("replays identically from the same seed", () => {
    const a = createBoard(zones(), "active", 42);
    const b = createBoard(zones(), "active", 42);
    step(a, 90);
    step(b, 90);
    expect(a.fires.map((f) => [f.id, f.origin, f.headRate])).toEqual(b.fires.map((f) => [f.id, f.origin, f.headRate]));
    expect(a.fires.length).toBeGreaterThan(1);
  });

  it("joins a field report to the fire already there and uses each report once", () => {
    const board = createBoard(zones(), "quiet", 5);
    const fire = ignite(board, ORIGIN, "manual", "you")!;
    fire.tau = 20;
    expect(addReportFire(board, "rpt_1", toward(ORIGIN, WIND_FROM_DEG + 180, 100))).toBeNull();
    expect(fire.reportIds).toEqual(["rpt_1"]);
    expect(addReportFire(board, "rpt_1", ORIGIN)).toBeNull();
    const far = addReportFire(board, "rpt_2", fromLocal(ORIGIN, [20_000, 20_000]));
    expect(far?.source).toBe("field_report");
  });

  it("closes a fire by hand and frees its teams", () => {
    const board = createBoard(zones(), "quiet", 5);
    const fire = ignite(board, ORIGIN, "manual", "you")!;
    applyOrder(board, { type: "send_crew", crew_id: "T1", fire_id: fire.id }, new Map(), "you");
    expect(closeFire(board, fire.id)).toBeNull();
    expect(fire.status).toBe("out");
    expect(board.teams[0].status).toBe("available");
    expect(closeFire(board, fire.id)).not.toBeNull();
  });

  it("keeps running with ignitions, removes old fires and bounds the active ones", () => {
    const board = createBoard(zones(), "severe", 9);
    step(board, 24 * 60);
    expect(board.minute).toBeCloseTo(24 * 60, 6);
    // Nobody fights these fires, so the board fills to the cap and ignitions wait.
    expect(board.fires.filter((f) => f.status !== "out").length).toBe(MAX_ACTIVE_FIRES);
    for (const fire of board.fires) closeFire(board, fire.id);
    step(board, OUT_KEEP_MINUTES + 30);
    expect(board.fires.every((f) => f.ignitedAt > 24 * 60)).toBe(true);
    expect(board.fireCount).toBeGreaterThan(MAX_ACTIVE_FIRES);
    expect(totals(board).burnedHa).toBeGreaterThan(0);
  });

  it("reopens an evacuated zone once no fire is near", () => {
    const board = createBoard(zones(), "quiet", 4);
    board.nextIgnitionAt = Infinity;
    applyOrder(board, { type: "order_evacuation", zone_id: "Z2", destination_id: "D1" }, new Map([["Z2", [ROUTE]]]), "you");
    step(board, REOPEN_MINUTES + 2);
    expect(board.zones[1].orderedAt).toBeNull();
    expect(zoneCounts(board.zones[1], board.minute).home).toBe(50);
  });
});
