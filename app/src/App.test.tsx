import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const health = { status: "ok", service: "crisistwin-api", version: "0.1.0" };
const ready = () => ({ ok: true, json: async () => health });

afterEach(() => vi.useRealTimers());

describe("workspace connection", () => {
  it("shows the empty workspace and a confirmed connection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ready()));
    render(<App />);
    expect(screen.getByRole("status")).toHaveTextContent("Connecting");
    expect(screen.getByRole("heading", { name: "No scenarios yet" })).toBeInTheDocument();
    expect(await screen.findByText(/API and database connected/)).toBeInTheDocument();
  });

  it("lets the user retry after a failure", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(ready());
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot reach");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/API and database connected/)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("cancels the pending request on unmount", () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, options: RequestInit) => {
        signal = options.signal ?? undefined;
        return new Promise(() => {});
      }),
    );
    const { unmount } = render(<App />);
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("aborts requests that exceed the connection timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      ),
    );
    render(<App />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Cannot reach");
  });
});
