import { describe, expect, it } from "vitest";
import { isCurrent, parseActive, parsePackages } from "./active";

const base = {
  incident_id: "pkg-x",
  name: "Test fire",
  mode: "drill",
  label: "Drill",
  join: { invite_required: true },
  source: "package",
  package_id: "pkg_0123456789ab",
  activated_at: null,
};

describe("parseActive", () => {
  it("reads the contract shape", () => {
    expect(parseActive(base)).toMatchObject({
      incident_id: "pkg-x",
      source: "package",
      join: { invite_required: true },
    });
  });
  it("rejects a response without an incident id", () => {
    expect(parseActive({ name: "x" })).toBeNull();
    expect(parseActive(null)).toBeNull();
  });
  it("defaults unknown source to bundle", () => {
    expect(parseActive({ incident_id: "camp-2018-drill", source: "?" })?.source).toBe("bundle");
  });
});

describe("parsePackages", () => {
  it("keeps order and drops malformed rows", () => {
    const rows = parsePackages({
      packages: [
        { package_id: "pkg_a", incident_id: "i1", created_at: "t", summary: { name: "A", place: "P", zones: 3, homes: 9 } },
        { nope: true },
        { package_id: "pkg_b", incident_id: "i2" },
      ],
    });
    expect(rows.map((r) => r.package_id)).toEqual(["pkg_a", "pkg_b"]);
    expect(rows[1].summary).toMatchObject({ name: "pkg_b", zones: 0 });
  });
});

describe("isCurrent", () => {
  it("matches a package by id and Camp by incident", () => {
    const active = parseActive(base);
    expect(isCurrent(active, { package_id: "pkg_0123456789ab" })).toBe(true);
    expect(isCurrent(active, { incident_id: "camp-2018-drill" })).toBe(false);
    expect(isCurrent(parseActive({ incident_id: "camp-2018-drill" }), { incident_id: "camp-2018-drill" })).toBe(true);
  });
});
