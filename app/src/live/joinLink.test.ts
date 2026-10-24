import { describe, expect, it } from "vitest";
import { buildJoinLink, checkServerOrigin } from "./joinLink";

describe("checkServerOrigin", () => {
  it("accepts https anywhere and http for .local", () => {
    expect(checkServerOrigin("https://x.trycloudflare.com/")).toEqual({
      ok: true,
      origin: "https://x.trycloudflare.com",
    });
    expect(checkServerOrigin("http://mac.local:5173")).toEqual({
      ok: true,
      origin: "http://mac.local:5173",
    });
  });

  it("rejects plain http elsewhere, paths, logins and phone-unreachable localhost", () => {
    const bad = [
      "http://192.168.1.4:5173",
      "http://example.com",
      "https://a.com/x",
      "https://u:p@a.com",
      "http://localhost:5173",
      "nope",
    ];
    for (const address of bad) expect(checkServerOrigin(address).ok, address).toBe(false);
  });
});

describe("buildJoinLink", () => {
  it("encodes the origin and omits an empty code", () => {
    expect(buildJoinLink("http://mac.local:5173", "")).toBe(
      "crisistwin://join?server=http%3A%2F%2Fmac.local%3A5173",
    );
    expect(buildJoinLink("https://a.com", " DRILL 1 ")).toBe(
      "crisistwin://join?server=https%3A%2F%2Fa.com&code=DRILL+1",
    );
  });
});
