import { describe, expect, it } from "vitest";
import type { EvacuationSummary } from "./evacuation";
import type { ZonePlanChange } from "./evacuationOptimizer";
import { describeImprovement } from "./evacuationAdvice";

function summary(over: {
  caught: number;
  safe: number;
  hours: number;
  clear: number | null;
}): EvacuationSummary {
  return {
    totalsByMinute: [],
    final: { caught: over.caught, safe: over.safe, waiting: 0, onRoad: 0 },
    cutOffZones: 0,
    cutOffHomes: 0,
    allClearMinute: over.clear,
    householdHoursEvacuating: over.hours,
  } as unknown as EvacuationSummary;
}

const change = (over: Partial<ZonePlanChange>): ZonePlanChange => ({
  zoneId: "z",
  zoneName: "Zone",
  homes: 10,
  fastestExitId: "a",
  exitId: "a",
  afterZoneId: null,
  ...over,
});

describe("describeImprovement", () => {
  const base = summary({ caught: 200, safe: 800, hours: 50, clear: null });
  const best = summary({ caught: 60, safe: 940, hours: 37.7, clear: 80 });
  const changes = [
    change({ exitId: "b" }),
    change({ exitId: "b" }),
    change({ exitId: "b" }),
    change({ afterZoneId: "y" }),
    change({ afterZoneId: "y" }),
  ];

  it("states what changed and the engine's differences", () => {
    const text = describeImprovement({
      baseline: base,
      best,
      changes,
      improved: true,
      closureCount: 2,
    });
    expect(text).toBe(
      "With your closures, sending 3 zones to other exits and staging 2 zones in waves: " +
        "140 fewer households caught, 140 more households reaching an exit, " +
        "12.3 fewer household-hours, everyone ordered is out by the horizon.",
    );
  });

  it("says so when nothing beat the fastest exit", () => {
    expect(
      describeImprovement({
        baseline: base,
        best: base,
        changes: [],
        improved: false,
        closureCount: 1,
      }),
    ).toBe("No strategy tried beat the fastest open exit under these closures.");
  });

  it("names all roads open when nothing is closed and singularises", () => {
    const text = describeImprovement({
      baseline: summary({ caught: 5, safe: 10, hours: 4, clear: 90 }),
      best: summary({ caught: 4, safe: 11, hours: 4, clear: 75 }),
      changes: [change({ exitId: "b" })],
      improved: true,
      closureCount: 0,
    });
    expect(text).toBe(
      "With all roads open, sending 1 zone to other exits: 1 fewer household caught, " +
        "1 more household reaching an exit, all clear 15 min earlier.",
    );
  });
});
