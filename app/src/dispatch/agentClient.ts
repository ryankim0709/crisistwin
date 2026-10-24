/**
 * Calls POST /api/dispatch/decide and reads its NDJSON stream (contracts.ts). The caller's
 * AbortSignal cancels both the request and the read.
 */

import { DECIDE_URL, type DecisionEvent, type Observation } from "./contracts";

export type FinalDecision = Extract<DecisionEvent, { type: "orders" }>;

export class DecisionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DecisionError";
  }
}

function parseEvent(line: string): DecisionEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new DecisionError("bad_stream", "The agent service sent an unreadable line.");
  }
  const type = (value as { type?: unknown } | null)?.type;
  if (type !== "thinking" && type !== "text" && type !== "orders" && type !== "error") {
    throw new DecisionError("bad_stream", "The agent service sent an unknown event.");
  }
  return value as DecisionEvent;
}

export async function requestDecision(
  observation: Observation,
  onEvent: (event: Extract<DecisionEvent, { type: "thinking" | "text" }>) => void,
  signal: AbortSignal,
): Promise<FinalDecision> {
  const response = await fetch(DECIDE_URL, {
    method: "POST",
    // DRF negotiates a renderer before the view runs, so JSON must be acceptable too (error
    // bodies are JSON); a successful response is the NDJSON stream either way.
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson, application/json" },
    body: JSON.stringify({ observation }),
    signal,
  });
  if (!response.ok) {
    let detail = `The agent service returned HTTP ${response.status}.`;
    let code = "http_error";
    try {
      const body = (await response.json()) as { error?: string; detail?: string };
      if (body.detail) detail = body.detail;
      if (body.error) code = body.error;
    } catch {
      // Not JSON (for example a proxy error page); keep the status message.
    }
    throw new DecisionError(code, detail);
  }
  if (!response.body) throw new DecisionError("bad_stream", "The agent service sent no body.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const event = parseEvent(line);
        if (event.type === "orders") return event;
        if (event.type === "error") throw new DecisionError(event.error, event.detail);
        onEvent(event);
      }
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
  throw new DecisionError("bad_stream", "The agent stream ended without a decision.");
}
