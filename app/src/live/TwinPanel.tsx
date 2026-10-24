import { useMemo, useState, type PointerEvent } from "react";
import type { MapFocus } from "./CommandMap";
import { drillClock, labelPoint } from "./format";
import type { LiveError } from "./api";
import type { CommandZone, TwinDestination, TwinEdge, TwinMonitor, TwinZone } from "./types";
import type { SeriesKey, SeriesPoint } from "./useTwin";

const ZONE_ROWS = 10;
const ROAD_ROWS = 5;
const nf = (n: number) => Math.round(n).toLocaleString("en-US");

/** Same accents as the replay's traffic metrics (replay.css .rp-metric--*). */
const METRICS: { key: SeriesKey; label: string; hint: string }[] = [
  { key: "not_departed_veh", label: "Not departed", hint: "Vehicles still at origin" },
  { key: "en_route_veh", label: "En route", hint: "Vehicles on the network" },
  { key: "arrived_veh", label: "Arrived", hint: "Reached a destination" },
  { key: "blocked_veh", label: "Blocked", hint: "En route; edge or every onward route closed" },
  { key: "exposed_veh", label: "Exposed", hint: "En route on edges inside the fire area" },
];

/** Stacked-bar order: done first, then moving, then still home. */
const SEGMENTS = ["arrived_veh", "en_route_veh", "not_departed_veh"] as const;

/** "Block Group 1, Census Tract 9.01" -> "Tract 9.01 · BG 1"; other names unchanged. */
export function shortZoneName(name: string): string {
  const m = /^Block Group (\S+), Census Tract (\S+)$/.exec(name);
  return m ? `Tract ${m[2]} · BG ${m[1]}` : name;
}

function Sparkline({
  points,
  metric,
  onHover,
}: {
  points: SeriesPoint[];
  metric: SeriesKey;
  onHover: (index: number | null) => void;
}) {
  const width = 100;
  const height = 26;
  if (points.length < 2) return <div className="lc-spark lc-spark--empty" aria-hidden="true" />;
  const start = points[0].atMs;
  const span = Math.max(1, points[points.length - 1].atMs - start);
  const max = Math.max(1, ...points.map((p) => p.values[metric]));
  const xy = points.map((p) => {
    const x = ((p.atMs - start) / span) * width;
    const y = height - 2 - (p.values[metric] / max) * (height - 4);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const move = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const at = start + ((e.clientX - rect.left) / Math.max(1, rect.width)) * span;
    let best = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(points[i].atMs - at) < Math.abs(points[best].atMs - at)) best = i;
    }
    onHover(best);
  };
  return (
    <svg
      className="lc-spark"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      onPointerMove={move}
      onPointerLeave={() => onHover(null)}
    >
      <polygon className="lc-spark-area" points={`0,${height} ${xy.join(" ")} ${width},${height}`} />
      <polyline className="lc-spark-line" points={xy.join(" ")} />
    </svg>
  );
}

function MetricTile({
  metric,
  value,
  series,
}: {
  metric: (typeof METRICS)[number];
  value: number;
  series: SeriesPoint[];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const point = hover === null ? null : series[hover];
  return (
    <div className={`lc-metric lc-metric--${metric.key}`} title={metric.hint}>
      <span className="lc-metric-label">
        {metric.label}
        {point ? <span className="lc-dim"> · {drillClock(new Date(point.atMs).toISOString())}</span> : null}
      </span>
      <span className="lc-metric-value">{nf(point ? point.values[metric.key] : value)}</span>
      <Sparkline points={series} metric={metric.key} onHover={setHover} />
    </div>
  );
}

function ZoneRow({ zone, name, onFocus }: { zone: TwinZone; name: string; onFocus: () => void }) {
  const total = Math.max(1, zone.vehicles);
  const share = Math.round((zone.arrived_veh / total) * 100);
  const detail = `${name}: ${nf(zone.arrived_veh)} arrived, ${nf(zone.en_route_veh)} en route, ${nf(zone.not_departed_veh)} not departed of ${nf(zone.vehicles)} vehicles${zone.exposed_veh ? `; ${nf(zone.exposed_veh)} exposed` : ""}${zone.blocked_veh ? `; ${nf(zone.blocked_veh)} blocked` : ""}`;
  return (
    <li>
      <button type="button" className="lc-zone-row" onClick={onFocus} title={detail} aria-label={detail}>
        <span className="lc-zone-name">{shortZoneName(name)}</span>
        <span className="lc-stack" aria-hidden="true">
          {SEGMENTS.filter((k) => zone[k] > 0).map((k) => (
            <span key={k} className={`lc-stack-seg lc-stack-seg--${k}`} style={{ flexGrow: zone[k] }} />
          ))}
        </span>
        <span className="lc-zone-num">
          {zone.exposed_veh > 0 ? <span className="lc-zone-alert">▲{nf(zone.exposed_veh)} </span> : null}
          {share}%
        </span>
      </button>
    </li>
  );
}

function ZonesBlock({
  twin,
  zones,
  onFocus,
}: {
  twin: TwinMonitor;
  zones: CommandZone[];
  onFocus: (focus: MapFocus) => void;
}) {
  const byId = useMemo(() => new Map(zones.map((z) => [z.id, z])), [zones]);
  const rows = useMemo(
    () =>
      twin.zones
        .filter((z) => z.ordered_at !== null || z.en_route_veh > 0 || z.arrived_veh > 0)
        .sort((a, b) => b.not_departed_veh + b.en_route_veh - (a.not_departed_veh + a.en_route_veh) || a.id.localeCompare(b.id)),
    [twin.zones],
  );
  if (rows.length === 0) return null;
  const focus = (z: TwinZone) => {
    const zone = byId.get(z.id);
    const coord = zone ? labelPoint(zone.geometry) : null;
    if (coord) onFocus({ id: z.id, coord });
  };
  const row = (z: TwinZone) => (
    <ZoneRow key={z.id} zone={z} name={byId.get(z.id)?.name ?? z.id} onFocus={() => focus(z)} />
  );
  return (
    <div className="lc-block">
      <div className="lc-block-head">
        <h3>Zones moving</h3>
        <ul className="lc-key" aria-label="Zone bar key">
          <li><span className="lc-key-sw lc-stack-seg--arrived_veh" />Arrived</li>
          <li><span className="lc-key-sw lc-stack-seg--en_route_veh" />En route</li>
          <li><span className="lc-key-sw lc-stack-seg--not_departed_veh" />Not departed</li>
          <li className="lc-zone-alert">▲ Exposed</li>
        </ul>
      </div>
      <ul className="lc-zone-list">{rows.slice(0, ZONE_ROWS).map(row)}</ul>
      {rows.length > ZONE_ROWS ? (
        <details className="lc-details">
          <summary>{rows.length - ZONE_ROWS} more</summary>
          <ul className="lc-zone-list">{rows.slice(ZONE_ROWS).map(row)}</ul>
        </details>
      ) : null}
    </div>
  );
}

function DestinationRow({ d, max }: { d: TwinDestination; max: number }) {
  const full = d.capacity_veh !== null && d.remaining_capacity_veh === 0;
  const scale = d.capacity_veh ?? max;
  return (
    <li className="lc-dest">
      <span className="lc-dest-name">
        {d.name}
        {d.status === "closed" ? <span className="lc-status lc-status--rejected">Closed</span> : null}
        {full ? <span className="lc-status lc-status--rejected">Full</span> : null}
      </span>
      <span className="lc-dest-num">
        {nf(d.arrived_veh)}
        {d.capacity_veh !== null ? <span className="lc-dim"> / {nf(d.capacity_veh)}</span> : null}
      </span>
      <span className="lc-bar" aria-hidden="true">
        <span style={{ width: `${Math.min(100, (d.arrived_veh / Math.max(1, scale)) * 100)}%` }} />
      </span>
      <span className="lc-dest-meta lc-dim">
        +{nf(d.arrived_last_10_min_veh)} last 10 min
        {d.assigned_zones ? ` · ${d.assigned_zones} zone${d.assigned_zones === 1 ? "" : "s"} assigned` : ""}
      </span>
    </li>
  );
}

interface RoadGroup {
  name: string;
  queued: number;
  veh: number;
  worst: TwinEdge;
}

function roads(edges: TwinEdge[]): RoadGroup[] {
  const groups = new Map<string, RoadGroup>();
  for (const e of edges) {
    const name = e.name ?? "Unnamed road";
    const g = groups.get(name);
    if (!g) groups.set(name, { name, queued: e.queued_veh, veh: e.veh, worst: e });
    else {
      g.queued += e.queued_veh;
      g.veh += e.veh;
      if (e.speed_kph / e.free_flow_kph < g.worst.speed_kph / g.worst.free_flow_kph) g.worst = e;
    }
  }
  return [...groups.values()].sort((a, b) => b.queued - a.queued || b.veh - a.veh).slice(0, ROAD_ROWS);
}

export default function TwinPanel({
  twin,
  error,
  series,
  zones,
  onFocus,
}: {
  twin: TwinMonitor | null;
  error: LiveError | null;
  series: SeriesPoint[];
  zones: CommandZone[];
  onFocus: (focus: MapFocus) => void;
}) {
  const roadRows = useMemo(() => (twin ? roads(twin.congested_edges) : []), [twin]);
  const maxArrived = useMemo(() => Math.max(1, ...(twin?.destinations.map((d) => d.arrived_veh) ?? [])), [twin]);
  const warming = error?.code === "twin_warming";

  let body;
  if (!twin) {
    body =
      error && !warming ? (
        <p className="lc-error" role="alert">
          {error.code === "twin_failed" ? "Twin unavailable; proposals use the rule planner." : error.message}
        </p>
      ) : (
        <p className="lc-state lc-dim" role="status">
          <span className="lc-spinner" aria-hidden="true" /> Loading twin…
        </p>
      );
  } else {
    body = (
      <>
        <div className="lc-metrics">
          {METRICS.map((m) => (
            <MetricTile key={m.key} metric={m} value={twin.totals[m.key]} series={series} />
          ))}
        </div>
        {!twin.conserved ? (
          <p className="lc-error" role="alert">
            Vehicle counts do not add up; treat this twin snapshot as unreliable.
          </p>
        ) : null}
        <ZonesBlock twin={twin} zones={zones} onFocus={onFocus} />
        {twin.destinations.length ? (
          <div className="lc-block">
            <div className="lc-block-head">
              <h3>Destinations</h3>
            </div>
            <ul className="lc-dest-list">
              {twin.destinations.map((d) => (
                <DestinationRow key={d.id} d={d} max={maxArrived} />
              ))}
            </ul>
          </div>
        ) : null}
        <div className="lc-block">
          <div className="lc-block-head">
            <h3>Queues</h3>
          </div>
          {roadRows.length === 0 ? <p className="lc-empty">No queues</p> : null}
          <ul className="lc-road-list">
            {roadRows.map((r) => (
              <li key={r.name}>
                <button
                  type="button"
                  className="lc-road"
                  onClick={() => onFocus({ id: `edge:${r.worst.edge_index}`, coord: r.worst.coord })}
                >
                  <span className="lc-road-name">{r.name}</span>
                  <span className="lc-road-num">{nf(r.queued)} queued</span>
                  <span className="lc-dim lc-road-speed">
                    {Math.round(r.worst.speed_kph)}/{Math.round(r.worst.free_flow_kph)} km/h
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        {twin.commands.length || twin.command_errors.length ? (
          <details className="lc-details">
            <summary>
              Commands applied ({twin.commands.length})
              {twin.command_errors.length ? <span className="lc-error"> · {twin.command_errors.length} rejected</span> : null}
            </summary>
            <ul className="lc-cmd-list">
              {twin.command_errors.map((e) => (
                <li key={`err:${e.key}`} className="lc-error">
                  {e.key}: {e.detail ?? e.code ?? e.error}
                </li>
              ))}
              {[...twin.commands].reverse().map((c) => (
                <li key={c.id}>
                  <span className="lc-mono">{drillClock(c.effective_at)}</span> {c.label ?? c.type}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </>
    );
  }

  return (
    <aside className="lc-twin" aria-labelledby="lc-twin-title">
      <header className="lc-panel-top">
        <h1 id="lc-twin-title">Traffic twin</h1>
        <span className="lc-chip lc-chip--simulated" title={twin?.label ?? "Simulated traffic twin"}>
          Simulated
        </span>
        {twin ? (
          <span className={`lc-conn${error ? " lc-conn--lost" : ""}`} role="status">
            {drillClock(twin.clock.now, true)} UTC
          </span>
        ) : null}
      </header>
      <div className="lc-panel-body lc-twin-body">{body}</div>
    </aside>
  );
}
