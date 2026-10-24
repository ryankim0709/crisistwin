import { Tag } from "../ui";
import { PRIORITY_KIND_LABEL, impactBasis, observedAge } from "./format";
import type { MapFocus } from "./CommandMap";
import type { CheckTask, PriorityItem } from "./types";
import "./response.css";

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Items whose picture is oldest relative to how much they matter (ADR 0041). A row
 * focuses the map on the place: the line for a road segment, else the point. */
export default function StalePanel({
  items,
  tasks,
  serverNow,
  onFocus,
}: {
  items: PriorityItem[] | undefined;
  tasks: CheckTask[];
  serverNow: number;
  onFocus: (focus: MapFocus) => void;
}) {
  // Older servers omit the field: show nothing rather than an empty claim.
  if (!items) return null;
  const openTask = (p: PriorityItem) =>
    !!p.task_id && tasks.some((t) => t.id === p.task_id && (t.status === "open" || t.status === "accepted"));
  return (
    <details className="sp" open>
      <summary>Stale and critical</summary>
      {items.length === 0 ? (
        <p className="sp-empty">Nothing stale</p>
      ) : (
        <ul className="sp-list">
          {items.map((p) => {
            const basis = impactBasis(p);
            return (
              <li key={p.id}>
                <button
                  type="button"
                  className="sp-row"
                  onClick={() => onFocus({ id: p.id, coord: p.coord, line: p.line })}
                >
                  <span className="sp-head">
                    <strong>{p.name}</strong>
                    <Tag>{PRIORITY_KIND_LABEL[p.kind] ?? p.kind}</Tag>
                    {openTask(p) ? <Tag tone="info">Task open</Tag> : null}
                  </span>
                  <span className="sp-meta">
                    Priority {p.priority.toFixed(2)} · Impact {pct(p.impact)} · Change {pct(p.p_change)} · Stale{" "}
                    {pct(p.staleness)}
                  </span>
                  <span className="sp-meta">
                    {basis ? `${basis} · ` : ""}seen {observedAge(p.last_observed_at, serverNow)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </details>
  );
}
