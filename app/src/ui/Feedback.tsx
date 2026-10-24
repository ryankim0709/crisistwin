import type { ReactNode } from "react";
import { cx } from "./cx";

export type NoticeTone = "warning" | "info" | "danger" | "success";

/**
 * Inline banner for caveats, provenance and errors. `title` is the bold lead-in, so the
 * tone is never conveyed by colour alone. Danger notices are announced (`role="alert"`).
 */
export function Notice({
  tone = "warning",
  title,
  children,
  compact,
  className,
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
  /** Tighter padding and no bottom margin, for side panels and docks. */
  compact?: boolean;
  className?: string;
}) {
  return (
    <p
      role={tone === "danger" ? "alert" : undefined}
      className={cx(
        "ui-notice",
        tone !== "warning" && `ui-notice--${tone}`,
        compact && "ui-notice--compact",
        className,
      )}
    >
      {title && <strong>{title}</strong>} {children}
    </p>
  );
}

/** "Nothing here yet" state with an optional call to action. */
export function EmptyState({
  title,
  children,
  symbol = "↗",
  action,
}: {
  title: string;
  children?: ReactNode;
  symbol?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="ui-empty">
      <span className="ui-empty-symbol" aria-hidden="true">
        {symbol}
      </span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div className="ui-cluster">{action}</div>}
    </div>
  );
}

export function Spinner({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span className={cx("ui-spinner", size === "lg" && "ui-spinner--lg")} aria-hidden="true" />
  );
}

/** Announced loading line: spinner plus text. */
export function LoadingState({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="ui-loading">
      <Spinner />
      {children}
    </p>
  );
}

/** Determinate progress bar; `value` is 0–1. */
export function ProgressBar({ value, label }: { value: number; label: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      className="ui-progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <span style={{ width: `${pct}%` }} />
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
  if (load.status === "loading") return <LoadingState>Loading {what}…</LoadingState>;
  if (load.status === "error") {
    return (
      <Notice tone="danger" title={`Cannot read ${what}`}>
        {load.message ?? "Unexpected file contents."}
      </Notice>
    );
  }
  return (
    <EmptyState title={`No ${what} available`}>
      <code>{path}</code> is not served. This is a missing file, not a result of zero differences.
    </EmptyState>
  );
}
