import { memo, useEffect, useMemo, useRef, useState } from "react";
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
import EvacueeTab from "./EvacueeTab";
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
    rows.push({
      index,
      id: event.id,
      atMs: event.atMs,
      category,
      label: event.label,
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
        <span className="rp-key rp-key--fire" aria-hidden="true" />
        Fire perimeter in effect — solid ember fill, glowing edge
      </li>
      <li>
        <span className="rp-key rp-key--sim" aria-hidden="true" />
        Simulated fire front — pink hatching, dashed edge; model output from an assumed ignition
      </li>
      <li>
        <span className="rp-key rp-key--history" aria-hidden="true" />
        Earlier perimeters — thin rings, fainter with age
      </li>
      <li>
        <span className="rp-key rp-key--line" style={{ background: COLORS.free }} aria-hidden="true" />
        Flowing — mean speed ≥ 70% of limit
      </li>
      <li>
        <span className="rp-key rp-key--line" style={{ background: COLORS.slow }} aria-hidden="true" />
        Slow — 35–70% of limit
      </li>
      <li>
        <span className="rp-key rp-key--line" style={{ background: COLORS.jam }} aria-hidden="true" />
        Congested — under 35%; hover a road for numbers
      </li>
      <li>
        <span className="rp-key rp-key--width" aria-hidden="true" />
        Line thickness — modelled vehicles on the edge
      </li>
      <li>
        <span className="rp-key rp-key--closed" aria-hidden="true" />
        Closed (event or modelled fire hazard) — red dashes, “× CLOSED” label when zoomed in
      </li>
      <li>
        <span className="rp-key rp-key--threat" aria-hidden="true" />
        Fire expected (model) — pulsing dashed band: amber within 30 min, red within 10 min
      </li>
      <li>
        <span className="rp-key rp-key--bridge" aria-hidden="true" />
        Bridge — double casing, labelled “BRIDGE” when zoomed in
      </li>
      <li>
        <span className="rp-key rp-key--dot" aria-hidden="true" />
        Vehicle dots — {perParticle ? `1 dot ≈ ${perParticle} modelled vehicle${perParticle === 1 ? "" : "s"}` : "modelled counts"};
        pink, motionless dots are stopped. Illustrative, not tracked vehicles; above 1 min/s
        playback their motion is slowed for legibility
      </li>
      <li>
        <span className="rp-key rp-key--zone" aria-hidden="true" />
        Zone — dashed outline; solid amber, hatched, “ORDERED” label once ordered
      </li>
      <li>
        <span className="rp-key rp-key--dest" aria-hidden="true" />
        Destination — ring marker with name and kind
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
}

export type PanelTab = "overview" | "responder" | "evacuee";

const TABS: { id: PanelTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "responder", label: "Responder brief" },
  { id: "evacuee", label: "Evacuee view" },
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
}: SidePanelProps) {
  return (
    <div className="rp-panel-body">
      <header className="rp-incident">
        <p className="rp-eyebrow">Historical replay · {model.mode}</p>
        <h1>{model.incident.name}</h1>
        <p className="rp-incident-meta">
          {model.incident.id}
          {model.incident.packageVersion && <> · package {model.incident.packageVersion.slice(0, 8)}</>} · schema{" "}
          {model.schemaVersion}
        </p>
      </header>

      <div className="rp-tabs" role="tablist" aria-label="Replay panels">
        {TABS.map((t) => (
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
              const i = TABS.findIndex((x) => x.id === tab);
              const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
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
      </div>
    </div>
  );
}
