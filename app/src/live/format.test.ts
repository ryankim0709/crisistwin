import { describe, expect, it } from "vitest";
import { answersLine, impactBasis, observedAge } from "./format";
import type { PriorityItem, TaskAnswers } from "./types";

const NOW = Date.parse("2026-10-24T18:11:00Z");
const base: TaskAnswers = {
  road_passable: 0,
  road_blocked: 0,
  heavy_traffic: 0,
  shelter_full: 0,
  passive: 0,
  total: 0,
  last_at: null,
};

describe("answersLine", () => {
  it("says no answers when total is 0 or missing", () => {
    expect(answersLine(base, NOW)).toBe("no answers");
    expect(answersLine(null, NOW)).toBe("no answers");
  });
  it("omits zero counts and appends freshness", () => {
    const a = { ...base, road_passable: 3, road_blocked: 1, total: 4, last_at: "2026-10-24T18:07:00Z" };
    expect(answersLine(a, NOW)).toBe("3 open, 1 blocked, 4 min ago");
  });
  it("maps slow and full", () => {
    const a = { ...base, heavy_traffic: 2, shelter_full: 1, total: 3 };
    expect(answersLine(a, NOW)).toBe("2 slow, 1 full");
  });
});

describe("impactBasis", () => {
  const p = (o: Partial<PriorityItem>) => ({ kind: "segment", ...o }) as PriorityItem;
  it("formats per kind", () => {
    expect(impactBasis(p({ vehicles: 1240, zones: 3 }))).toBe("1,240 veh · 3 routes");
    expect(impactBasis(p({ kind: "destination", load: 0.92 }))).toBe("load 0.92");
    expect(impactBasis(p({ kind: "gateway", households: 820 }))).toBe("820 households");
    expect(impactBasis(p({ kind: "gateway", households: null }))).toBe("");
  });
});

describe("observedAge", () => {
  it("handles never and ages", () => {
    expect(observedAge(null, NOW)).toBe("never");
    expect(observedAge("2026-10-24T18:01:00Z", NOW)).toBe("10 min ago");
  });
});
