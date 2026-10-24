import type { ReactNode } from "react";
import { cx } from "./cx";

export type TagTone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

/** Compact status/category label. Always carries text, so meaning never depends on colour. */
export function Tag({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: TagTone | "green" | "amber";
  className?: string;
}) {
  return (
    <span className={cx("ui-tag", tone !== "neutral" && `ui-tag--${tone}`, className)}>
      {children}
    </span>
  );
}

const EVIDENCE_LABELS: Record<string, string> = {
  simulated: "Simulated",
  observed: "Observed",
  reported: "Reported",
  reconstructed: "Reconstructed",
  fixture: "Fixture",
  derived: "Derived",
  ai_explanation: "AI explanation",
};

/**
 * Provenance label required by AGENTS.md (observed vs simulated vs AI). Use it wherever
 * a number or layer could be mistaken for live or observed data.
 */
export function EvidenceTag({ kind }: { kind: string }) {
  const tone: TagTone =
    kind === "observed" ? "success" : kind === "ai_explanation" ? "info" : "warning";
  return <Tag tone={tone}>{EVIDENCE_LABELS[kind] ?? kind}</Tag>;
}

/** Headline number with a label and a one-line explanation. */
export function Metric({
  label,
  value,
  detail,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("ui-metric", className)}>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

export function MetricGrid({ children }: { children: ReactNode }) {
  return <div className="ui-metrics">{children}</div>;
}

/** Label/value rows (a description list). */
export function Facts({ items }: { items: readonly { label: ReactNode; value: ReactNode }[] }) {
  return (
    <dl className="ui-facts">
      {items.map((item, index) => (
        <div key={index}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ui-kbd">{children}</kbd>;
}
