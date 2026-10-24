import { useEffect, useRef, useState } from "react";
import { localTime } from "../timeline";
import type { ReplayModel } from "../types";
import { ExplainError, fetchExplanation, type ExplainResponse } from "./api";
import { buildExplainContext, MAX_CONTEXT_CHARS, type ExplainContext } from "./context";
import { Markdown } from "./markdown";
import "./explain.css";

const PRESETS = [
  "Why did congestion form here?",
  "Which zones had the least warning?",
  "What limits confidence in this?",
] as const;

const MAX_QUESTION_CHARS = 500;

interface Asked {
  question: string;
  clockMs: number;
  context: ExplainContext;
}

type State =
  | { status: "idle" }
  | { status: "loading"; asked: Asked }
  | { status: "done"; asked: Asked; answer: ExplainResponse }
  | { status: "error"; asked: Asked; message: string; code: string | null }
  | { status: "cancelled"; asked: Asked };

interface ExplainPanelProps {
  model: ReplayModel;
  frameIndex: number;
  simTimeMs: number;
}

export default function ExplainPanel({ model, frameIndex, simTimeMs }: ExplainPanelProps) {
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<State>({ status: "idle" });
  const controllerRef = useRef<AbortController | null>(null);
  // Only the latest request may update state; an older response is dropped.
  const requestIdRef = useRef(0);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const ask = (question: string) => {
    const trimmed = question.trim();
    if (!trimmed) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const id = ++requestIdRef.current;

    const context = buildExplainContext(model, frameIndex, simTimeMs);
    const asked: Asked = { question: trimmed, clockMs: simTimeMs, context };
    if (JSON.stringify(context).length > MAX_CONTEXT_CHARS) {
      setState({
        status: "error",
        asked,
        message: "The replay context is too large to send.",
        code: "too_large",
      });
      return;
    }
    setState({ status: "loading", asked });

    fetchExplanation(trimmed, context, controller.signal).then(
      (answer) => {
        if (id === requestIdRef.current) setState({ status: "done", asked, answer });
      },
      (err: unknown) => {
        if (id !== requestIdRef.current || controller.signal.aborted) return;
        if (err instanceof ExplainError) {
          setState({ status: "error", asked, message: err.message, code: err.code });
        } else {
          setState({
            status: "error",
            asked,
            message: "Could not reach the CrisisTwin API.",
            code: null,
          });
        }
      },
    );
  };

  const cancel = () => {
    if (state.status !== "loading") return;
    requestIdRef.current += 1;
    controllerRef.current?.abort();
    setState({ status: "cancelled", asked: state.asked });
  };

  const loading = state.status === "loading";
  const tz = model.incident.timezone;

  return (
    <div className="ai-panel">
      <section aria-labelledby="ai-ask-title">
        <h2 id="ai-ask-title" className="rp-section-title">
          Ask about this replay
        </h2>
        <p className="ai-intro">
          Sends the numbers shown at {localTime(simTimeMs, tz)} (metrics, insights, recent events,
          layer status, assumptions and limitations) to an AI model for a plain-language
          explanation.
        </p>
        <div className="ai-presets" role="group" aria-label="Preset questions">
          {PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              className="ai-chip"
              disabled={loading}
              onClick={() => ask(preset)}
            >
              {preset}
            </button>
          ))}
        </div>
        <form
          className="ai-form"
          onSubmit={(e) => {
            e.preventDefault();
            ask(draft);
          }}
        >
          <label htmlFor="ai-question" className="ai-label">
            Your question
          </label>
          <textarea
            id="ai-question"
            className="ai-input"
            rows={3}
            maxLength={MAX_QUESTION_CHARS}
            value={draft}
            placeholder="e.g. Why are so many vehicles blocked at this time?"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation(); // keep replay keyboard shortcuts out of the text box
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                ask(draft);
              }
            }}
          />
          <div className="ai-actions">
            {loading ? (
              <button type="button" className="ai-btn" onClick={cancel}>
                Cancel
              </button>
            ) : (
              <button type="submit" className="ai-btn ai-btn--primary" disabled={!draft.trim()}>
                Ask
              </button>
            )}
          </div>
        </form>
      </section>

      <section aria-labelledby="ai-answer-title" aria-live="polite" aria-busy={loading}>
        <h2 id="ai-answer-title" className="rp-section-title">
          Explanation
        </h2>
        {state.status === "idle" && (
          <div className="rp-empty">
            <strong>No question asked yet.</strong>
            <span>
              Pick a preset or type a question. Answers explain the simulation; they are not
              instructions.
            </span>
          </div>
        )}
        {state.status !== "idle" && (
          <p className="ai-asked">
            <span className="ai-asked-q">“{state.asked.question}”</span>
            <span className="ai-asked-t">at replay clock {localTime(state.asked.clockMs, tz)}</span>
          </p>
        )}
        {state.status === "loading" && (
          <p className="ai-status" role="status">
            <span className="ai-spinner" aria-hidden="true" /> Asking the model…
          </p>
        )}
        {state.status === "cancelled" && <p className="ai-status">Request cancelled.</p>}
        {state.status === "error" && (
          <div className="ai-error" role="alert">
            <strong>
              {state.code === "ai_unavailable"
                ? "AI explanation is not available"
                : "Explanation failed"}
            </strong>
            <span>{state.message}</span>
          </div>
        )}
        {state.status === "done" && (
          <article className="ai-answer">
            <p className="ai-badge">
              <span className="ai-badge-tag">AI</span>
              AI explanation — may be wrong; grounded in the simulation numbers shown
            </p>
            {state.asked.clockMs !== simTimeMs && (
              <p className="ai-stale">
                The replay clock has moved since this answer. Ask again to refresh it.
              </p>
            )}
            <div className="ai-markdown">
              <Markdown source={state.answer.answer_markdown} />
            </div>
            <p className="ai-meta">
              {state.answer.model} · generated {state.answer.generated_at} · context{" "}
              <code title={state.answer.context_digest}>
                {state.answer.context_digest.slice(0, 19)}
              </code>
            </p>
          </article>
        )}
        {state.status !== "idle" && (
          <details className="ai-context">
            <summary>Context sent to the model</summary>
            <pre>{JSON.stringify(state.asked.context, null, 2)}</pre>
          </details>
        )}
      </section>
    </div>
  );
}
