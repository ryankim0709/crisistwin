import { Notice } from "../ui";
import { fmt, fmtDelta, verdict, type Direction, type MetricDelta } from "./workspaceData";

// Page-level helpers for the planning pages. Generic components live in ../ui; they are
// re-exported here so existing page imports keep working.
export {
  Page as WorkspacePage,
  Panel,
  Tag,
  EvidenceTag,
  Field,
  Metric,
  MetricGrid,
  Facts,
  Button,
  LinkButton,
  Notice,
  DataState,
} from "../ui";
export { EmptyState as EmptyResult } from "../ui";

export function DraftNotice() {
  return (
    <Notice title="UI preview">
      Drafts reset on reload; saving and simulation are not connected.
    </Notice>
  );
}

/** A variant value with its signed delta and an outcome word ("better" / "worse"). */
export function DeltaCell({
  metric,
  direction,
}: {
  metric: MetricDelta | undefined;
  direction: Direction;
}) {
  if (!metric || metric.variant === null) return <span className="ws-delta-cell">n/a</span>;
  const word = verdict(metric.delta, direction);
  return (
    <span className="ws-delta-cell">
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
