import { useMemo, type KeyboardEvent } from "react";
import { EmptyState, SegmentedControl, Tag } from "../ui";
import { elapsed, nf, plural } from "./format";
import KindGlyph from "./Glyph";
import { isFixtureNote, matches, type QueueFilter, type QueueItem } from "./queue";

const FILTERS: { value: QueueFilter; label: string; title: string; empty: string }[] = [
  { value: "new", label: "New", title: "Not reviewed yet", empty: "No new reports" },
  {
    value: "conflicting",
    label: "Conflicting",
    title: "Blocked and passable on one road, or a fire report away from the estimate",
    empty: "No conflicting reports",
  },
  { value: "stale", label: "Stale", title: "Not re-observed within the still-there window", empty: "Nothing stale" },
  {
    value: "high",
    label: "High",
    title: "On a published route, or in ordered zones with many vehicles",
    empty: "Nothing on a route",
  },
];

function reporters(item: QueueItem): string {
  const parts: string[] = [];
  if (item.responders) parts.push(plural(item.responders, "responder"));
  if (item.civilians) parts.push(plural(item.civilians, "civilian"));
  return parts.join(", ") || plural(item.reports.length, "report");
}

export function impactLine(item: QueueItem): string | null {
  if (item.routeZones.length) {
    return `On ${plural(item.routeZones.length, "route")}, ${nf(item.vehicles)} vehicles`;
  }
  if (item.vehicles) return `${nf(item.vehicles)} vehicles in ordered zones`;
  return null;
}

function Row({
  item,
  selected,
  focusable,
  serverNow,
  onSelect,
  onKey,
}: {
  item: QueueItem;
  selected: boolean;
  focusable: boolean;
  serverNow: number;
  onSelect: () => void;
  onKey: (e: KeyboardEvent<HTMLLIElement>) => void;
}) {
  const impact = impactLine(item);
  const note = item.reports.find((r) => r.note && !isFixtureNote(r.note))?.note ?? null;
  return (
    <li
      id={`lc-q-${item.id}`}
      role="option"
      aria-selected={selected}
      tabIndex={focusable ? 0 : -1}
      className={`lc-q-row${selected ? " is-selected" : ""}`}
      onClick={onSelect}
      onKeyDown={onKey}
    >
      <span className={`lc-q-glyph lc-q-glyph--${item.kind}`}>
        <KindGlyph kind={item.kind} />
      </span>
      <span className="lc-q-body">
        <span className="lc-q-title">
          <strong>{item.title}</strong>
          {item.confirmed ? <Tag tone="danger">Confirmed</Tag> : null}
          {item.conflict ? <Tag tone="warning">Conflicting</Tag> : null}
          {item.stale ? <Tag>Stale</Tag> : null}
          {item.fixture ? <Tag>Fixture</Tag> : null}
          {item.record ? <Tag tone="info">2018 record</Tag> : null}
        </span>
        {note ? <span className="lc-q-quote">“{note}”</span> : null}
        <span className="lc-q-meta">
          {reporters(item)}, {elapsed(serverNow - new Date(item.newestObservedAt).getTime())} ago
        </span>
        {item.conflict ? <span className="lc-q-meta">{item.conflict}</span> : null}
        {impact ? <span className={`lc-q-impact${item.high ? " is-high" : ""}`}>{impact}</span> : null}
      </span>
    </li>
  );
}

export default function ReviewQueue({
  items,
  filter,
  onFilter,
  selectedId,
  onSelect,
  serverNow,
}: {
  items: QueueItem[];
  filter: QueueFilter;
  onFilter: (f: QueueFilter) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  serverNow: number;
}) {
  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.value, items.filter((i) => matches(i, f.value)).length])),
    [items],
  ) as Record<QueueFilter, number>;
  // The selected item stays in the list after a decision moves it out of the filter.
  const shown = useMemo(
    () => items.filter((i) => matches(i, filter) || i.id === selectedId),
    [items, filter, selectedId],
  );
  const options = FILTERS.map((f) => ({ value: f.value, label: `${f.label} ${counts[f.value]}`, title: f.title }));
  const current = FILTERS.find((f) => f.value === filter)!;

  const onKey = (e: KeyboardEvent<HTMLLIElement>, index: number) => {
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (step) {
      e.preventDefault();
      const next = shown[Math.max(0, Math.min(shown.length - 1, index + step))];
      if (next) {
        onSelect(next.id);
        document.getElementById(`lc-q-${next.id}`)?.focus();
      }
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(shown[index].id);
    } else if (e.key === "Escape") {
      onSelect(null);
    }
  };

  return (
    <section className="lc-col lc-queue" aria-labelledby="lc-queue-title">
      <header className="lc-col-head">
        <h2 id="lc-queue-title">Review queue</h2>
        <span className="lc-dim">By impact</span>
      </header>
      <SegmentedControl label="Queue filter" options={options} value={filter} onChange={onFilter} className="lc-filters" />
      <div className="lc-col-scroll">
        {shown.length === 0 ? (
          <EmptyState title={current.empty} symbol="✓" />
        ) : (
          <ul role="listbox" aria-keyshortcuts="J K C D R Escape" aria-label={`${current.label === "High" ? "High impact" : current.label} reports`} className="lc-q-list">
            {shown.map((item, i) => (
              <Row
                key={item.id}
                item={item}
                selected={item.id === selectedId}
                focusable={item.id === selectedId || (i === 0 && !shown.some((x) => x.id === selectedId))}
                serverNow={serverNow}
                onSelect={() => onSelect(item.id === selectedId ? null : item.id)}
                onKey={(e) => onKey(e, i)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
