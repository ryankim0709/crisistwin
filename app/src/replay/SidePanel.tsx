import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { GROUP_LAYER, groupAvailability } from "./layerGroups";
import { COLORS, type LayerGroup } from "./mapLayers";
import { EVENT_CATEGORY_LABEL, EvidenceChip, EventGlyph, Sparkline } from "./parts";
import {
  clockParts,
  eventCategory,
  formatDuration,
  metricSeries,
  type EventCategory,
  type MetricKey,
} from "./timeline";
import ExplainPanel from "./ai/ExplainPanel";
import EvacueeTab from "./EvacueeTab";
import { splitSnappedNote } from "./narrative";
import ResponderTab from "./ResponderTab";
import type { EvidenceClass, LngLat, ReplayModel } from "./types";

const SPARK_POINTS = 120;

const METRICS: { key: MetricKey; label: string; hint: string }[] = [
  { key: "notDepartedVeh", label: "Not departed", hint: "Vehicles still at origin" },
  { key: "enRouteVeh", label: "En route", hint: "Vehicles on the network" },
  { key: "arrivedVeh", label: "Arrived", hint: "Reached a destination" },
  { key: "blockedVeh", label: "Blocked", hint: "En route; edge or every onward route closed" },
  { key: "exposedVeh", label: "Exposed", hint: "En route on edges inside the fire area in effect" },
];

function Metrics({ model, frameIndex, simTimeMs }: { model: ReplayModel; frameIndex: number; simTimeMs: number }) {
  const traffic = model.traffic;
  const series = useMemo(() => {
    const out: Partial<Record<MetricKey, ReturnType<typeof metricSeries>>> = {};
    if (traffic) for (const m of METRICS) out[m.key] = metricSeries(traffic.metrics, m.key, SPARK_POINTS);
    return out;
  }, [traffic]);
  if (!traffic) {
    const reason = model.layerStatus.traffic?.reason;
    return (
      <div className="rp-empty">
        <strong>No traffic simulation in this bundle.</strong>
        <span>{reason ?? "Fire perimeters, events and damage still replay."}</span>
      </div>
    );
  }
  const row = frameIndex >= 0 ? traffic.metrics[frameIndex] : null;
  return (
    <>
      <div className="rp-metrics">
        {METRICS.map((metric) => (
          <div key={metric.key} className={`rp-metric rp-metric--${metric.key}`} title={metric.hint}>
            <span className="rp-metric-label">{metric.label}</span>
            <span className="rp-metric-value">{row ? row[metric.key].toLocaleString("en-US") : "—"}</span>
            <Sparkline
              points={series[metric.key] ?? []}
              startMs={model.clock.startMs}
              endMs={model.clock.endMs}
              cursorMs={simTimeMs}
            />
          </div>
        ))}
      </div>
      <p className="rp-metric-foot">
        <EvidenceChip value={traffic.evidenceClass} /> {traffic.totalVeh?.toLocaleString("en-US") ?? "—"} vehicles ·
        clearance {traffic.clearanceTimeS == null ? "not reached" : formatDuration(traffic.clearanceTimeS)}
        {traffic.modelId && (
          <>
            {" "}
            · model {traffic.modelId}
            {traffic.modelVersion ? `@${traffic.modelVersion}` : ""}
            {traffic.seed != null ? `, seed ${traffic.seed}` : ""}
          </>
        )}
      </p>
    </>
  );
}

/**
 * Resident-state metrics from agent simulations. Field names are not fixed by the contract,
 * so every extra numeric metric is shown, labelled from its field name.
 */
function Residents({ model, frameIndex }: { model: ReplayModel; frameIndex: number }) {
  const extra = model.traffic?.extraMetrics ?? {};
  const keys = Object.keys(extra);
  if (keys.length === 0) return null;
  return (
    <section aria-labelledby="rp-residents-title">
      <h2 id="rp-residents-title" className="rp-section-title">
        Residents (modelled agents)
      </h2>
      <dl className="rp-residents">
        {keys.map((key) => {
          const value = frameIndex >= 0 ? extra[key][frameIndex] : null;
          return (
            <div key={key}>
              <dt>{humanizeMetric(key)}</dt>
              <dd>{value == null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 1 })}</dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

function humanizeMetric(key: string): string {
  const text = key
    .replace(/_(veh|n|count)$/, "")
    .replace(/^residents?_/, "")
    .replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

interface FeedRow {
  index: number;
  id: string;
  atMs: number;
  category: EventCategory;
  label: string;
  time: string;
  date: string;
  ariaLabel: string;
  evidence: EvidenceClass;
  precision: string | null;
  /** Road names when this row groups simulated closures from one minute. */
  members: string[] | null;
  /** Muted provenance note, e.g. "[snapped: …]" on NIST road events. */
  note: string | null;
}

const CLOSURE_LABEL_PREFIX = /^Modelled fire closure:\s*/;
const GROUP_PREVIEW_NAMES = 2;

/**
 * One row per event, except simulated closures, which collapse into one row per minute
 * (hundreds of edges close as the fire overruns the town).
 */
function buildFeedRows(model: ReplayModel): FeedRow[] {
  const rows: FeedRow[] = [];
  const tz = model.incident.timezone;
  model.events.forEach((event, index) => {
    const category = eventCategory(event.type);
    const local = clockParts(event.atMs, tz);
    const minute = Math.floor(event.atMs / 60_000);
    const last = rows[rows.length - 1];
    const groupable = category === "closure" && event.evidenceClass === "simulated";
    const name = event.label.replace(CLOSURE_LABEL_PREFIX, "");
    if (groupable && last?.members && Math.floor(last.atMs / 60_000) === minute) {
      last.index = index;
      if (!last.members.includes(name)) last.members.push(name);
      const preview = last.members.slice(0, GROUP_PREVIEW_NAMES).join(", ");
      last.label = `Modelled fire closures: ${last.members.length} roads incl. ${preview}`;
      last.ariaLabel = `Jump to ${local.time} ${local.zone}: ${last.label}`;
      return;
    }
    const { text, note } = splitSnappedNote(event.label);
    rows.push({
      note,
      index,
      id: event.id,
      atMs: event.atMs,
      category,
      label: text,
      time: local.time.slice(0, 5),
      date: local.date.slice(5),
      ariaLabel: `Jump to ${local.time} ${local.zone}: ${event.label}`,
      evidence: event.evidenceClass,
      precision:
        event.timePrecision && event.timePrecision !== "minute" ? event.timePrecision.replace(/_/g, " ") : null,
      members: groupable ? [name] : null,
    });
  });
  return rows;
}

const FeedItem = memo(function FeedItem({
  row,
  state,
  onSeek,
}: {
  row: FeedRow;
  state: "past" | "current" | "future";
  onSeek: (ms: number) => void;
}) {
  return (
    <li className={`rp-feed-item rp-feed-item--${state}`} data-current={state === "current"}>
      <button type="button" className="rp-feed-btn" onClick={() => onSeek(row.atMs)} aria-label={row.ariaLabel}>
        <EventGlyph category={row.category} />
        <span className="rp-feed-time">
          {row.time}
          <small>{row.date}</small>
        </span>
        <span className="rp-feed-label">
          {row.label}
          {row.note && <span className="rp-snapped">{row.note}</span>}
          <span className="rp-feed-meta">
            <EvidenceChip value={row.evidence} />
            {row.precision && <span className="rp-precision">precision: {row.precision}</span>}
            {state === "future" && <span className="rp-sr">(not yet reached)</span>}
          </span>
        </span>
      </button>
      {row.members && row.members.length > 1 && (
        <details className="rp-feed-group">
          <summary>Show {row.members.length} roads</summary>
          <p>{row.members.join(", ")}</p>
        </details>
      )}
    </li>
  );
});

const EventFeed = memo(function EventFeed({
  model,
  eventIndex,
  onSeek,
}: {
  model: ReplayModel;
  eventIndex: number;
  onSeek: (ms: number) => void;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  const [hidden, setHidden] = useState<ReadonlySet<EventCategory>>(() => new Set());

  // Formatting is done once per bundle; rows then re-render only when their state changes.
  const rows = useMemo(() => buildFeedRows(model), [model]);
  const counts = useMemo(() => {
    const out = new Map<EventCategory, number>();
    for (const row of rows) out.set(row.category, (out.get(row.category) ?? 0) + 1);
    return out;
  }, [rows]);
  const visible = useMemo(() => rows.filter((row) => !hidden.has(row.category)), [rows, hidden]);

  // The highlighted row is the latest visible event at or before the replay time.
  let currentIndex = -1;
  for (const row of visible) {
    if (row.index > eventIndex) break;
    currentIndex = row.index;
  }

  useEffect(() => {
    const list = listRef.current;
    const current = list?.querySelector<HTMLElement>("[data-current='true']");
    if (!list) return;
    if (!current) {
      list.scrollTo({ top: 0 });
      return;
    }
    list.scrollTo({ top: current.offsetTop - list.clientHeight / 2, behavior: "smooth" });
  }, [currentIndex]);

  if (rows.length === 0) {
    return <p className="rp-empty">No events in this bundle.</p>;
  }
  return (
    <>
      <div className="rp-feed-filters" role="group" aria-label="Show event types">
        {Array.from(counts.entries()).map(([category, count]) => (
          <button
            key={category}
            type="button"
            className="rp-filter"
            aria-pressed={!hidden.has(category)}
            onClick={() =>
              setHidden((prev) => {
                const next = new Set(prev);
                if (next.has(category)) next.delete(category);
                else next.add(category);
                return next;
              })
            }
          >
            <EventGlyph category={category} size={10} />
            {EVENT_CATEGORY_LABEL[category]} <span className="rp-count">{count}</span>
          </button>
        ))}
      </div>
      {visible.length === 0 ? (
        <p className="rp-empty">All event types are hidden.</p>
      ) : (
        <ol className="rp-feed" ref={listRef}>
          {visible.map((row) => (
            <FeedItem
              key={row.id}
              row={row}
              state={
                row.index === currentIndex ? "current" : row.index <= eventIndex ? "past" : "future"
              }
              onSeek={onSeek}
            />
          ))}
        </ol>
      )}
    </>
  );
});

function Legend({ perParticle }: { perParticle: number | null }) {
  return (
    <ul className="rp-legend">
      <li>
        <span className="rp-key rp-key--satellite" aria-hidden="true" />
        Satellite fire perimeter — white dashed outline, “SATELLITE ESTIMATE” tag
      </li>
      <li>
        <span className="rp-key rp-key--sim" aria-hidden="true" />
        Model fire — burned char inside, orange-yellow newest band (last 30 min), glowing edge; simulated
        from an assumed ignition
      </li>
      <li>
        <span className="rp-key rp-key--history" aria-hidden="true" />
        Earlier perimeters — thin rings, fainter with age
      </li>
      <li>
        <span className="rp-key rp-key--line" style={{ background: COLORS.free }} aria-hidden="true" />
        Flowing (cyan) — mean speed ≥ 70% of limit
      </li>
      <li>
        <span className="rp-key rp-key--line" style={{ background: COLORS.slow }} aria-hidden="true" />
        Slow (blue) — 35–70% of limit
      </li>
      <li>
        <span className="rp-key rp-key--line" style={{ background: COLORS.jam }} aria-hidden="true" />
        Jammed (violet, thick) — under 35%; hover a road for numbers
      </li>
      <li>
        <span className="rp-key rp-key--width" aria-hidden="true" />
        Line thickness — modelled vehicles on the edge
      </li>
      <li>
        <span className="rp-key rp-key--closed" aria-hidden="true" />
        Closed (event or modelled fire hazard) — grey dashes, “× CLOSED” label when zoomed in
      </li>
      <li>
        <span className="rp-key rp-key--threat" aria-hidden="true" />
        Fire expected (model) — thin pulsing dashes: amber within 30 min, orange within 10 min
      </li>
      <li>
        <span className="rp-key rp-key--bridge" aria-hidden="true" />
        Bridge — double casing, labelled “BRIDGE” when zoomed in
      </li>
      <li>
        <span className="rp-key rp-key--dot" aria-hidden="true" />
        Vehicle dots — {perParticle ? `1 dot ≈ ${perParticle} modelled vehicle${perParticle === 1 ? "" : "s"}` : "modelled counts"};
        violet, motionless dots are stopped. Illustrative, not tracked vehicles; above 1 min/s
        playback their motion is slowed for legibility
      </li>
      <li>
        <span className="rp-key rp-key--zone" aria-hidden="true" />
        Zone (synthetic, off by default) — outline flashes amber when an order is issued; hover for name
      </li>
      <li>
        <span className="rp-key rp-key--dest" aria-hidden="true" />
        Destination — ring marker; hover for name and kind
      </li>
      <li>
        <span className="rp-key rp-key--damage" aria-hidden="true" />
        Damage — hollow dot, post-fire assessment (no damage time)
      </li>
    </ul>
  );
}

export interface SidePanelProps {
  model: ReplayModel;
  frameIndex: number;
  eventIndex: number;
  simTimeMs: number;
  visibility: Record<LayerGroup, boolean>;
  perParticle: number | null;
  onToggleLayer: (group: LayerGroup) => void;
  onSeek: (ms: number) => void;
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  pin: LngLat | null;
  onPin: (p: LngLat | null) => void;
  onFocus: (coords: LngLat[]) => void;
  /** Header eyebrow, e.g. "Historical replay" or "Agent simulation". */
  eyebrow: string;
  /** Optional tabs supplied by the view (what-if, stress test), appended after the built-ins. */
  extraTabs?: { id: PanelTab; label: string; content: ReactNode }[];
}

export type PanelTab = "overview" | "responder" | "evacuee" | "explain" | "whatif" | "stress";

const TABS: { id: PanelTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "responder", label: "Responder brief" },
  { id: "evacuee", label: "Evacuee view" },
  { id: "explain", label: "Ask / Explain" },
];

export default function SidePanel({
  model,
  frameIndex,
  eventIndex,
  simTimeMs,
  visibility,
  perParticle,
  onToggleLayer,
  onSeek,
  tab,
  onTab,
  pin,
  onPin,
  onFocus,
  eyebrow,
  extraTabs = [],
}: SidePanelProps) {
  const tabs = [...TABS, ...extraTabs.map(({ id, label }) => ({ id, label }))];
  const extra = extraTabs.find((t) => t.id === tab);
  return (
    <div className="rp-panel-body">
      <header className="rp-incident">
        <p className="rp-eyebrow">
          {eyebrow} · {model.mode}
        </p>
        <h1>{model.incident.name}</h1>
        <p className="rp-incident-meta">
          {model.incident.id}
          {model.incident.packageVersion && <> · package {model.incident.packageVersion.slice(0, 8)}</>} · schema{" "}
          {model.schemaVersion}
        </p>
      </header>

      <div className="rp-tabs" role="tablist" aria-label="Replay panels">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`rp-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`rp-tabpanel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            className="rp-tab-btn"
            onClick={() => onTab(t.id)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
              e.preventDefault();
              e.stopPropagation();
              const i = tabs.findIndex((x) => x.id === tab);
              const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
              onTab(next.id);
              document.getElementById(`rp-tab-${next.id}`)?.focus();
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`rp-tabpanel-${tab}`} aria-labelledby={`rp-tab-${tab}`} className="rp-tabpanel">
        {tab === "overview" && (
          <>
        <section aria-labelledby="rp-metrics-title">
          <h2 id="rp-metrics-title" className="rp-section-title">
            Simulated evacuation state
          </h2>
          <Metrics model={model} frameIndex={frameIndex} simTimeMs={simTimeMs} />
        </section>
        <Residents model={model} frameIndex={frameIndex} />

        <section aria-labelledby="rp-events-title" className="rp-events">
          <h2 id="rp-events-title" className="rp-section-title">
            Event feed <span className="rp-count">{Math.max(0, eventIndex + 1)}/{model.events.length}</span>
          </h2>
          <EventFeed model={model} eventIndex={eventIndex} onSeek={onSeek} />
        </section>

        <section aria-labelledby="rp-layers-title">
          <h2 id="rp-layers-title" className="rp-section-title">
            Layers
          </h2>
          <ul className="rp-layers">
            {(Object.keys(GROUP_LAYER) as LayerGroup[]).map((group) => {
              const { available, status, evidence } = groupAvailability(model, group);
              const id = `rp-layer-${group}`;
              return (
                <li key={group} className={available ? undefined : "rp-layer--missing"}>
                  <input
                    id={id}
                    type="checkbox"
                    checked={available && visibility[group]}
                    disabled={!available}
                    onChange={() => onToggleLayer(group)}
                  />
                  <label htmlFor={id}>
                    {GROUP_LAYER[group].label}
                    {!available && (
                      <span className="rp-layer-reason">
                        Missing{status?.reason ? `: ${status.reason}` : ""}
                      </span>
                    )}
                  </label>
                  {evidence && <EvidenceChip value={evidence} />}
                </li>
              );
            })}
          </ul>
        </section>

        <section aria-labelledby="rp-legend-title">
          <h2 id="rp-legend-title" className="rp-section-title">
            Legend
          </h2>
          <Legend perParticle={perParticle} />
        </section>

        {(model.assumptions.length > 0 || model.limitations.length > 0) && (
          <details className="rp-notes">
            <summary>Assumptions & limitations</summary>
            {model.limitations.length > 0 && (
              <>
                <h3>Limitations</h3>
                <ul>
                  {model.limitations.map((text) => (
                    <li key={text}>{text}</li>
                  ))}
                </ul>
              </>
            )}
            {model.assumptions.length > 0 && (
              <>
                <h3>Assumptions</h3>
                <ul>
                  {model.assumptions.map((text) => (
                    <li key={text}>{text}</li>
                  ))}
                </ul>
              </>
            )}
          </details>
        )}
          </>
        )}
        {tab === "responder" && <ResponderTab model={model} simTimeMs={simTimeMs} onFocus={onFocus} />}
        {tab === "evacuee" && (
          <EvacueeTab model={model} simTimeMs={simTimeMs} frameIndex={frameIndex} pin={pin} onPin={onPin} />
        )}
        {tab === "explain" && <ExplainPanel model={model} frameIndex={frameIndex} simTimeMs={simTimeMs} />}
        {extra?.content}
      </div>
    </div>
  );
}
