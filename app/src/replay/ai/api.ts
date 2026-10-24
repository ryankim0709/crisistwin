// Client for POST /api/replay/explain (contract: app/backend/README.md).
import type { ExplainContext } from "./context";

export interface ExplainResponse {
  answer_markdown: string;
  model: string;
  generated_at: string;
  evidence_class: "ai_explanation";
  context_digest: string;
}

/** A failed request; `detail` is the server's human-readable explanation when it sent one. */
export class ExplainError extends Error {
  readonly status: number | null;
  readonly code: string | null;

  constructor(message: string, status: number | null, code: string | null) {
    super(message);
    this.name = "ExplainError";
    this.status = status;
    this.code = code;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export async function fetchExplanation(
  question: string,
  context: ExplainContext,
  signal: AbortSignal,
): Promise<ExplainResponse> {
  const response = await fetch("/api/replay/explain", {
    method: "POST",
    signal,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ question, context }),
  });

  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    // Non-JSON body (e.g. proxy error page); handled below.
  }
  const record =
    typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;

  if (!response.ok) {
    const detail = isNonEmptyString(record?.detail)
      ? record.detail
      : `API returned HTTP ${response.status}.`;
    const code = isNonEmptyString(record?.error) ? record.error : null;
    throw new ExplainError(detail, response.status, code);
  }

  if (
    record === null ||
    !isNonEmptyString(record.answer_markdown) ||
    !isNonEmptyString(record.model) ||
    !isNonEmptyString(record.generated_at) ||
    record.evidence_class !== "ai_explanation" ||
    !isNonEmptyString(record.context_digest)
  ) {
    throw new ExplainError("The API returned an unexpected response.", response.status, null);
  }

  return {
    answer_markdown: record.answer_markdown,
    model: record.model,
    generated_at: record.generated_at,
    evidence_class: record.evidence_class,
    context_digest: record.context_digest,
  };
}
