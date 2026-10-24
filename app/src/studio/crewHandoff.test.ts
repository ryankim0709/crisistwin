import { describe, expect, it } from "vitest";
import type { CrewDispatch, CrewTrip } from "./crewDispatch";
import { SIZE_UP_MINUTES, crewHandoff } from "./crewHandoff";
import type { FireAttack, InitialAttackEstimate } from "./initialAttack";

function trip(label: string, arriveMinute: number): CrewTrip {
  return {
    kind: "engine",
    label,
    stationName: "Station",
    departMinute: 1,
    atRoadMinute: arriveMinute,
    arriveMinute,
    path: [
      [0, 0],
      [0, 0],
    ],
    pathMinutes: [0, 0],
  };
}

const DISPATCH: CrewDispatch = {
  reportMinute: 0,
  fire: [0, 0],
  roadPoint: [0, 0],
  hikeMeters: 0,
  hikeMinutes: 0,
  trips: [trip("Engine 1", 12), trip("Engine 2", 20)],
};

function fire(overrides: Partial<FireAttack>): FireAttack {
  return {
    sourceId: "F1",
    ignitedMinute: 0,
    headFlameFeet: 3,
    attackable: true,
    outMinute: null,
    areaSquareMeters: 0,
    perimeterMeters: 0,
    ...overrides,
  };
}

function estimate(fires: FireAttack[]): InitialAttackEstimate {
  return {
    onSiteMinute: 12,
    lineMetersPerMinute: 20,
    holdsFlameLengthFeet: 8,
    fires,
    outFromMinuteBySource: fires.map((f) => f.outMinute ?? Infinity),
  };
}

describe("crew handoff to the evacuation", () => {
  it("keeps crews on a fire they put out", () => {
    const handoff = crewHandoff(DISPATCH, estimate([fire({ outMinute: 40 })]), { F1: "F1" });
    expect(handoff.overwhelmedReason).toBeNull();
    expect(handoff.leaveMinutes).toEqual([null, null]);
  });

  it("sends crews to the evacuation after sizing up a fire they cannot hold", () => {
    const handoff = crewHandoff(
      DISPATCH,
      estimate([fire({ headFlameFeet: 11, attackable: false })]),
      { F1: "Ridge fire" },
    );
    expect(handoff.overwhelmedReason).toContain("Ridge fire's 11.0 ft head flame");
    expect(handoff.leaveMinutes).toEqual([12 + SIZE_UP_MINUTES, 20 + SIZE_UP_MINUTES]);
  });

  it("names crowning and a line that cannot keep up", () => {
    const crowning = crewHandoff(
      DISPATCH,
      estimate([fire({ headFlameFeet: Infinity, attackable: false })]),
      {},
    );
    expect(crowning.overwhelmedReason).toBe("F1 is crowning");
    const outrun = crewHandoff(DISPATCH, estimate([fire({})]), {});
    expect(outrun.overwhelmedReason).toContain("cannot catch F1's edge");
  });

  it("finishes the fires it can put out before leaving for the rest", () => {
    const handoff = crewHandoff(
      DISPATCH,
      estimate([
        fire({ sourceId: "F1", outMinute: 50 }),
        fire({ sourceId: "F2", attackable: false, headFlameFeet: 12 }),
      ]),
      {},
    );
    expect(handoff.leaveMinutes).toEqual([50, 50]);
  });
});
