/**
 * Calls POST /api/dispatch/decide and reads its NDJSON stream (contracts.ts). The caller's
 * AbortSignal cancels both the request and the read. `streamNdjson` is the shared reader,
 * also used by the /demo agent (demo/useDemoAgent.ts).
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

/** A streamed delta line, common to every NDJSON decision endpoint. */
export type StreamDelta = { type: "thinking"; text: string } | { type: "text"; text: string };

function parseEvent(line: string, isFinal: (event: { type: string }) => boolean): { type: string } {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new DecisionError("bad_stream", "The agent service sent an unreadable line.");
  }
  const type = (value as { type?: unknown } | null)?.type;
  if (typeof type !== "string") {
    throw new DecisionError("bad_stream", "The agent service sent an unknown event.");
  }
  const event = value as { type: string };
  if (type !== "thinking" && type !== "text" && type !== "error" && !isFinal(event)) {
    throw new DecisionError("bad_stream", "The agent service sent an unknown event.");
  }
  return event;
}

/**
 * POSTs `body` as JSON to `url` and reads its NDJSON stream: "thinking"/"text" lines go to
 * `onEvent`, an "error" line throws DecisionError, and the first line `isFinal` accepts is
 * returned. Non-2xx responses throw with the body's `{ error, detail }` when it has one.
 */
export async function streamNdjson<TFinal>(
  url: string,
  body: unknown,
  isFinal: (event: { type: string }) => boolean,
  onEvent: (event: StreamDelta) => void,
  signal: AbortSignal,
): Promise<TFinal> {
  const response = await fetch(url, {
    method: "POST",
    // DRF negotiates a renderer before the view runs, so JSON must be acceptable too (error
    // bodies are JSON); a successful response is the NDJSON stream either way.
    headers: {
      "Content-Type": "application/json",
      Accept: "application/x-ndjson, application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    let detail = `The agent service returned HTTP ${response.status}.`;
    let code = "http_error";
    try {
      const data = (await response.json()) as { error?: string; detail?: string };
      if (data.detail) detail = data.detail;
      if (data.error) code = data.error;
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
        const event = parseEvent(line, isFinal);
        if (event.type === "error") {
          const { error, detail } = event as { error?: unknown; detail?: unknown };
          throw new DecisionError(String(error), String(detail));
        }
        if (event.type === "thinking" || event.type === "text") onEvent(event as StreamDelta);
        else return event as TFinal;
      }
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
  throw new DecisionError("bad_stream", "The agent stream ended without a decision.");
}

export function requestDecision(
  observation: Observation,
  onEvent: (event: Extract<DecisionEvent, { type: "thinking" | "text" }>) => void,
  signal: AbortSignal,
): Promise<FinalDecision> {
  return streamNdjson<FinalDecision>(
    DECIDE_URL,
    { observation },
    (event) => event.type === "orders",
    onEvent,
    signal,
  );
}
