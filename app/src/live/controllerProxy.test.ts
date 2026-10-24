import { describe, expect, it } from "vitest";
import { shouldSignController } from "../../controllerProxy";

describe("shouldSignController", () => {
  it("default: only a loopback peer", () => {
    expect(shouldSignController(undefined, "127.0.0.1", {})).toBe(true);
    expect(shouldSignController(undefined, "::ffff:127.0.0.1", {})).toBe(true);
    expect(shouldSignController(undefined, "192.168.1.20", { host: "localhost:5173" })).toBe(false);
  });

  it("host mode: a browser that typed localhost, with no forwarding headers", () => {
    expect(shouldSignController("host", "172.18.0.1", { host: "localhost:5173" })).toBe(true);
    expect(shouldSignController("host", "172.18.0.1", { host: "127.0.0.1:5173" })).toBe(true);
  });

  it("host mode: never a phone on the .local name, a tunnel host, or a forwarded request", () => {
    expect(shouldSignController("host", "172.18.0.1", { host: "macbook.local:5173" })).toBe(false);
    expect(shouldSignController("host", "172.18.0.1", { host: "x.trycloudflare.com" })).toBe(false);
    const forwarded = { host: "localhost:5173", "x-forwarded-for": "1.2.3.4" };
    expect(shouldSignController("host", "172.18.0.1", forwarded)).toBe(false);
    expect(
      shouldSignController("host", "172.18.0.1", {
        host: "localhost",
        "cf-connecting-ip": "1.2.3.4",
      }),
    ).toBe(false);
  });
});
