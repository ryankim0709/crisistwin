import type { ReactNode } from "react";
import { fmt, fmtDelta, verdict, type Direction, type MetricDelta } from "./workspaceData";

export function WorkspacePage({
  title,
  description,
  section = "Workspace",
  action,
  children,
}: {
  title: string;
  description: string;
  section?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="workspace-page" id="main-content" tabIndex={-1}>
      <header className="workspace-heading">
        <div>
          <p className="eyebrow">{section} / CrisisTwin</p>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        {action}
      </header>
      {children}
      <footer>
        Experimental planning only. Outputs are not operational evacuation instructions.
      </footer>
    </main>
  );
}

export function Panel({
  title,
  eyebrow,
  aside,
  children,
}: {
  title: string;
  eyebrow?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="ui-panel">
      <div className="panel-heading">
        <div>
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h2>{title}</h2>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Tag({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "green" | "amber";
}) {
  return <span className={`ui-tag ui-tag-${tone}`}>{children}</span>;
}

export function DraftNotice() {
  return (
    <p className="ui-notice">
      <strong>UI preview</strong> Sample inputs are editable on this page. Drafts reset when you
      leave or reload; saving and simulation services are not connected.
    </p>
  );
}

export function EmptyResult({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="ui-empty">
      <span className="empty-symbol" aria-hidden="true">
        ↗
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="ui-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="ui-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

/** Loading, missing-file and error states for a panel that reads a static data file. */
export function DataState({
  load,
  what,
  path,
}: {
  load: { status: "loading" | "missing" | "error"; message?: string };
  what: string;
  path: string;
}) {
  if (load.status === "loading") {
    return (
      <p role="status" className="ui-help">
        Loading {what}…
      </p>
    );
  }
  if (load.status === "error") {
    return (
      <p role="alert" className="ui-notice">
        <strong>Cannot read {what}</strong> {load.message ?? "Unexpected file contents."}
      </p>
    );
  }
  return (
    <EmptyResult title={`No ${what} available`}>
      <code>{path}</code> is not served, so there is nothing to show. An empty page does not mean
      the analysis found no differences.
    </EmptyResult>
  );
}

const EVIDENCE_LABELS: Record<string, string> = {
  simulated: "Simulated",
  observed: "Observed",
  reconstructed: "Reconstructed",
  fixture: "Fixture",
  derived: "Derived",
  ai_explanation: "AI explanation",
};

/** Evidence label (AGENTS.md): kept as text, so meaning never depends on colour. */
export function EvidenceTag({ kind }: { kind: string }) {
  const tone = kind === "observed" ? "green" : kind === "neutral" ? "neutral" : "amber";
  return <Tag tone={tone}>{EVIDENCE_LABELS[kind] ?? kind}</Tag>;
}

/** A variant value with its signed delta and an outcome word ("better" / "worse"). */
export function DeltaCell({
  metric,
  direction,
}: {
  metric: MetricDelta | undefined;
  direction: Direction;
}) {
  if (!metric || metric.variant === null) return <span className="delta-cell">n/a</span>;
  const word = verdict(metric.delta, direction);
  return (
    <span className="delta-cell">
      <strong>{fmt(metric.variant)}</strong>
      <small>
        {fmtDelta(metric.delta)}
        {word && word !== "unchanged" ? ` (${word})` : ""}
        {metric.pct !== null && metric.delta !== 0
          ? ` · ${metric.pct > 0 ? "+" : "−"}${Math.abs(metric.pct)}%`
          : ""}
      </small>
    </span>
  );
}
