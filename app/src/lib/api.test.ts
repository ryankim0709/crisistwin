import { describe, expect, it, vi } from "vitest";
import { fetchHealth } from "./api";

describe("health API contract", () => {
  it("validates the successful response and forwards cancellation", async () => {
    const health = { status: "ok", service: "crisistwin-api", version: "0.1.0" };
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => health });
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    await expect(fetchHealth(signal)).resolves.toEqual(health);
    expect(fetch).toHaveBeenCalledWith("/api/health", {
      signal,
      headers: { Accept: "application/json" },
    });
  });

  it("rejects unavailable responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await expect(fetchHealth(new AbortController().signal)).rejects.toThrow("HTTP 503");
  });

  it.each([
    null,
    {},
    { status: "ok", service: "another-api", version: "1" },
    { status: "ok", service: "crisistwin-api", version: 1 },
    { status: "ok", service: "crisistwin-api", version: "" },
  ])("rejects malformed JSON data: %j", async (data) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => data }));
    await expect(fetchHealth(new AbortController().signal)).rejects.toThrow("unexpected response");
  });
});
