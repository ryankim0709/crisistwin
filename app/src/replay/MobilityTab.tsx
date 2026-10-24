import { Button, LoadingState, Notice } from "../ui";
import { useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import {
  EVACUATION_AREA,
  MOBILITY_BUILD_HINT,
  MOBILITY_COLORS,
  RATIO_SATURATION_LOG2,
  SURROUNDING,
  baselineAt,
  dayTicks,
  hourIndexAt,
  mobilityRangeMs,
  weekIndexAt,
  type Mobility,
  type MobilitySeries,
} from "./mobility";
import { EvidenceChip } from "./parts";
import { clockParts, localTime } from "./timeline";
import type { MobilityState } from "./useMobility";
import type { LngLat } from "./types";

const CATEGORY_ORDER = [
  "all",
  "traveler_accommodation",
  "gasoline_stations",
  "grocery",
  "general_merchandise",
  "restaurants",
  "religious",
  "schools",
];
const TOP_DESTINATIONS = 6;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Chart drawing area in SVG user units. */
const W = 320;
const H = 104;
const PAD = { left: 4, right: 4, top: 8, bottom: 18 };

const fmt = (n: number) =>
  Number.isInteger(n)
    ? n.toLocaleString("en-US")
    : n.toLocaleString("en-US", { maximumFractionDigits: 1 });

const stamp = (ms: number, tz: string) => `${clockParts(ms, tz).date} ${localTime(ms, tz)}`;

function coordText([lon, lat]: LngLat): string {
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
}

interface ChartProps {
  m: Mobility;
  series: MobilitySeries;
  title: string;
  ticks: ReturnType<typeof dayTicks>;
  simTimeMs: number;
  clockStartMs: number;
  clockEndMs: number;
  onSeek: (ms: number) => void;
}

/** Visits (solid) against the hour-of-week baseline (dashed) over every event week. */
function SeriesChart({
  m,
  series,
  title,
  ticks,
  simTimeMs,
  clockStartMs,
  clockEndMs,
  onSeek,
}: ChartProps) {
  const [t0, t1] = mobilityRangeMs(m);
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (ms: number) => PAD.left + ((ms - t0) / (t1 - t0)) * innerW;
  const { visitsPath, baselinePath, yMax } = useMemo(() => {
    let max = 1;
    for (const v of series.visits) if (v > max) max = v;
    for (const b of series.baseline) if (b > max) max = b;
    const y = (v: number) => PAD.top + (1 - v / max) * innerH;
    const px = (ms: number) => PAD.left + ((ms - t0) / (t1 - t0)) * innerW;
    const pts = (value: (i: number) => number) =>
      m.hourStartsMs.map((ms, i) => `${px(ms).toFixed(1)},${y(value(i)).toFixed(1)}`).join(" ");
    return {
      visitsPath: pts((i) => series.visits[i]),
      baselinePath: pts((i) => baselineAt(series.baseline, i)),
      yMax: max,
    };
  }, [m, series, t0, t1, innerW, innerH]);

  const hour = hourIndexAt(m, simTimeMs);
  const cursorX = hour >= 0 ? x(simTimeMs) : null;
  const winStart = Math.max(clockStartMs, t0);
  const winEnd = Math.min(clockEndMs, t1);
  const hasWindow = winEnd > winStart;

  const seekFromX = (clientX: number, svg: SVGSVGElement) => {
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const unit = ((clientX - rect.left) / rect.width) * W;
    const frac = Math.min(1, Math.max(0, (unit - PAD.left) / innerW));
    onSeek(t0 + frac * (t1 - t0 - 1));
  };
  const onKey = (event: KeyboardEvent<SVGSVGElement>) => {
    const step =
      event.key === "ArrowLeft"
        ? -HOUR_MS
        : event.key === "ArrowRight"
          ? HOUR_MS
          : event.key === "PageUp"
            ? DAY_MS
            : event.key === "PageDown"
              ? -DAY_MS
              : 0;
    if (step === 0) return;
    // The replay's global arrow-key shortcut steps the clock by minutes; this control owns them.
    event.preventDefault();
    event.stopPropagation();
    onSeek(Math.min(t1 - 1, Math.max(t0, simTimeMs + step)));
  };

  const now = hour >= 0 ? series.visits[hour] : null;
  const base = hour >= 0 ? baselineAt(series.baseline, hour) : null;
  const clamped = Math.min(t1 - 1, Math.max(t0, simTimeMs));

  return (
    <figure className="rp-mob-chart">
      <figcaption>
        <strong>{title}</strong> <span className="rp-dim">· {fmt(series.poiCount)} places</span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="slider"
        tabIndex={0}
        aria-label={`${title}, ${series.label}: visits per hour against baseline. Click, or use the arrow keys (hour) and Page Up/Down (day), to move the replay clock.`}
        aria-valuemin={t0}
        aria-valuemax={t1 - 1}
        aria-valuenow={clamped}
        aria-valuetext={stamp(clamped, m.timezone)}
        onClick={(event: MouseEvent<SVGSVGElement>) =>
          seekFromX(event.clientX, event.currentTarget)
        }
        onKeyDown={onKey}
      >
        <rect x={PAD.left} y={PAD.top} width={innerW} height={innerH} className="rp-mob-plot" />
        {hasWindow && (
          <rect
            x={x(winStart)}
            y={PAD.top}
            width={Math.max(2, x(winEnd) - x(winStart))}
            height={innerH}
            className="rp-mob-window"
          />
        )}
        {ticks.map((t) => (
          <g key={t.index}>
            <line
              x1={x(m.hourStartsMs[t.index])}
              x2={x(m.hourStartsMs[t.index])}
              y1={PAD.top}
              y2={H - PAD.bottom + (t.major ? 4 : 2)}
              className={t.major ? "rp-mob-tick rp-mob-tick--major" : "rp-mob-tick"}
            />
            {t.major && (
              <text x={x(m.hourStartsMs[t.index]) + 2} y={H - 4} className="rp-mob-axis">
                {t.label}
              </text>
            )}
          </g>
        ))}
        <polyline points={baselinePath} className="rp-mob-baseline" />
        <polyline points={visitsPath} className="rp-mob-visits" />
        <text x={PAD.left + 3} y={PAD.top + 8} className="rp-mob-axis">
          max {fmt(yMax)}
        </text>
        {cursorX !== null && (
          <line
            x1={cursorX}
            x2={cursorX}
            y1={PAD.top}
            y2={H - PAD.bottom}
            className="rp-mob-cursor"
          />
        )}
      </svg>
      <p className="rp-mob-readout" aria-live="off">
        {now === null || base === null
          ? "Replay clock is outside this chart’s range."
          : `${stamp(simTimeMs, m.timezone)}: ${fmt(now)} visits · baseline ${fmt(base)}${
              base > 0 ? ` (${(now / base).toFixed(1)}×)` : ""
            }`}
      </p>
    </figure>
  );
}

function MissingNote() {
  return (
    <Notice tone="info" title="No phone-panel mobility file for this fire.">
      <span>
        Built from licensed Advan data (Dewey). Fetch the team copy with{" "}
        <code className="rp-mob-code">python3 -m tools.mongo_data pull</code>, or rebuild it:
      </span>
      <code className="rp-mob-code">{MOBILITY_BUILD_HINT}</code>
    </Notice>
  );
}

export interface MobilityTabProps {
  state: MobilityState;
  simTimeMs: number;
  /** The replay clock window (much shorter than the mobility range); shaded on the charts. */
  clockStartMs: number;
  clockEndMs: number;
  visible: boolean;
  onVisible: (visible: boolean) => void;
  showFlows: boolean;
  onShowFlows: (show: boolean) => void;
  /** Move the replay clock; the caller clamps to the replay's range. */
  onSeek: (ms: number) => void;
  onFocus: (coords: LngLat[]) => void;
}

/** "Movement" panel: Advan phone-panel visits around the incident, against a baseline week. */
export default function MobilityTab(props: MobilityTabProps) {
  const { state } = props;
  if (state.status === "loading") {
    return (
      <div className="rp-tab">
        <LoadingState>Loading phone-panel mobility…</LoadingState>
      </div>
    );
  }
  if (state.status === "missing") {
    return (
      <div className="rp-tab">
        <MissingNote />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="rp-tab">
        <Notice tone="danger" title="Mobility file could not be used.">
          {state.error}{" "}
          <span>
            Rebuild it with <code className="rp-mob-code">{MOBILITY_BUILD_HINT}</code>
          </span>
        </Notice>
      </div>
    );
  }
  return <ReadyTab {...props} m={state.data} />;
}

function ReadyTab({
  m,
  simTimeMs,
  clockStartMs,
  clockEndMs,
  visible,
  onVisible,
  showFlows,
  onShowFlows,
  onSeek,
  onFocus,
}: MobilityTabProps & { m: Mobility }) {
  const [category, setCategory] = useState("all");
  const ticks = useMemo(() => dayTicks(m), [m]);
  const categories = useMemo(() => {
    const present = new Map<string, string>();
    for (const s of m.series)
      if (s.region === EVACUATION_AREA && !present.has(s.category))
        present.set(s.category, s.label);
    return CATEGORY_ORDER.filter((id) => present.has(id)).map((id) => ({
      id,
      label: present.get(id) ?? id,
    }));
  }, [m]);
  const selected = categories.some((c) => c.id === category)
    ? category
    : (categories[0]?.id ?? "all");
  const regionLabel = (id: string) => m.regions[id]?.label ?? id.replace(/_/g, " ");
  const charts = [EVACUATION_AREA, SURROUNDING]
    .map((region) => ({
      region,
      series: m.series.find((s) => s.region === region && s.category === selected),
    }))
    .flatMap((c) => (c.series ? [{ region: c.region, series: c.series }] : []));

  const hour = hourIndexAt(m, simTimeMs);
  const weekIndex = weekIndexAt(hour);
  // Outside the range there is no current week; show the first event week and say so.
  const weekLabel = m.eventWeeks[weekIndex >= 0 ? weekIndex : 0];
  const flowWeek = m.originFlows?.weeks.find((w) => w.week === weekLabel);
  // Ranked by the increase over the baseline week: big towns get many visitors every week.
  const top = useMemo(
    () =>
      [...(flowWeek?.items ?? [])]
        .filter((f) => f.visitors > f.baselineVisitors)
        .sort((a, b) => b.visitors - b.baselineVisitors - (a.visitors - a.baselineVisitors))
        .slice(0, TOP_DESTINATIONS),
    [flowWeek],
  );
  const christmas = m.replayId.startsWith("marshall");

  return (
    <div className="rp-tab rp-mob">
      <section aria-labelledby="rp-mob-evidence">
        <p className="rp-mob-evidence" id="rp-mob-evidence">
          <EvidenceChip value={m.evidenceClass} />{" "}
          <strong>Derived · Advan phone-panel estimates (Dewey)</strong>
        </p>
        <ul className="rp-mob-caveats">
          <li>Phone-panel estimates of visits to places, not counts of people.</li>
          <li>
            Baseline: mean of {m.baselineWeeks.length} week{m.baselineWeeks.length === 1 ? "" : "s"}{" "}
            ({m.baselineWeeks.join(", ")}), same local hour of week. One baseline week per fire
            {christmas ? "; this one is Christmas week" : ""}, so ordinary week-to-week variation is
            not captured.
          </li>
          <li>
            Advan&apos;s handling of daylight-saving hours is unverified: hours after a clock change
            may be off by one hour.
          </li>
          <li>
            Licensed data: shared within the team through Atlas only; never commit it or share it
            outside the team.
          </li>
        </ul>
      </section>

      <fieldset className="rp-mob-toggles">
        <legend className="rp-sr">Map display</legend>
        <label>
          <input type="checkbox" checked={visible} onChange={(e) => onVisible(e.target.checked)} />{" "}
          Movement (device data) on the map
        </label>
        <label className={m.originFlows ? undefined : "rp-mob-off"}>
          <input
            type="checkbox"
            checked={showFlows && m.originFlows !== null}
            disabled={!visible || m.originFlows === null}
            onChange={(e) => onShowFlows(e.target.checked)}
          />{" "}
          Origin flows{m.originFlows ? "" : " (not in this file)"}
        </label>
      </fieldset>

      <section aria-labelledby="rp-mob-key">
        <h3 className="rp-subtitle" id="rp-mob-key">
          Map key
        </h3>
        <p className="rp-rule">
          {hour >= 0
            ? `Circles show the hour starting ${stamp(m.hourStartsMs[hour], m.timezone)} (the replay clock). Size is visits that hour; brightness compares them with the baseline for the same hour of the week.`
            : "The replay clock is outside the phone-panel date range, so no circles are drawn."}
        </p>
        <ul className="rp-mob-legend">
          <li>
            <span
              className="rp-mob-sw"
              style={{ background: MOBILITY_COLORS.below }}
              aria-hidden="true"
            />
            Dark grey: below baseline (down to {2 ** RATIO_SATURATION_LOG2}× lower)
          </li>
          <li>
            <span
              className="rp-mob-sw"
              style={{ background: MOBILITY_COLORS.near }}
              aria-hidden="true"
            />
            Mid grey: near baseline
          </li>
          <li>
            <span
              className="rp-mob-sw"
              style={{ background: MOBILITY_COLORS.above }}
              aria-hidden="true"
            />
            White: above baseline (up to {2 ** RATIO_SATURATION_LOG2}× higher)
          </li>
          <li>
            <span
              className="rp-mob-sw rp-mob-sw--fresh"
              style={{ background: "transparent", border: `1.5px solid ${MOBILITY_COLORS.fresh}` }}
              aria-hidden="true"
            />
            Hollow white ring: visits but no baseline visits that hour
          </li>
          <li>
            <span className="rp-mob-sw rp-mob-sw--ring" aria-hidden="true" />
            Thick outline: cell mostly inside the evacuation-area block groups
          </li>
          <li>
            <span
              className="rp-mob-line"
              style={{ background: MOBILITY_COLORS.flow }}
              aria-hidden="true"
            />
            Dashed grey line: residents’ trips from the reference place (straight lines, not routes)
          </li>
        </ul>
        <p className="rp-rule">Cells with no baseline and no visits are hidden.</p>
      </section>

      <section aria-labelledby="rp-mob-charts">
        <h3 className="rp-subtitle" id="rp-mob-charts">
          Visits per hour, all event weeks
        </h3>
        <div className="rp-mob-cats" role="group" aria-label="Place category">
          {categories.map((c) => (
            <Button
              key={c.id}
              variant="secondary"
              size="sm"
              aria-pressed={selected === c.id}
              onClick={() => setCategory(c.id)}
            >
              {c.id === "all" ? "All places" : c.label}
            </Button>
          ))}
        </div>
        <p className="rp-rule">
          Solid: visits. Dashed: baseline for that hour of the week. Vertical line: replay clock.
          Shaded: replay window. Click a chart to move the clock.
        </p>
        {charts.length === 0 && (
          <p className="rp-empty">No series for this category in the file.</p>
        )}
        {charts.map(({ region, series }) => (
          <SeriesChart
            key={series.id}
            m={m}
            series={series}
            title={regionLabel(region)}
            ticks={ticks}
            simTimeMs={simTimeMs}
            clockStartMs={clockStartMs}
            clockEndMs={clockEndMs}
            onSeek={onSeek}
          />
        ))}
      </section>

      {m.originFlows && (
        <section aria-labelledby="rp-mob-top">
          <h3 className="rp-subtitle" id="rp-mob-top">
            Largest increases in evacuation-area residents seen (this week vs baseline)
          </h3>
          <p className="rp-rule">
            {m.originFlows.originLabel}, week of {weekLabel}
            {hour < 0 ? " (replay clock is outside the range)" : ""}, seen at places outside the
            evacuation area, by grid cell. Baseline week: {m.originFlows.baselineWeek}. Lower
            bounds: Advan omits small home-area counts.
          </p>
          {top.length === 0 ? (
            <p className="rp-empty">No destination cell gained visitors over the baseline week.</p>
          ) : (
            <ol className="rp-mob-top">
              {top.map((f) => (
                <li key={f.cellId}>
                  <button
                    type="button"
                    className="rp-row-btn"
                    onClick={() => onFocus([f.center])}
                    aria-label={`Show cell near ${coordText(f.center)} on the map`}
                  >
                    <strong>{coordText(f.center)}</strong>
                    <span className="rp-dim">
                      {fmt(f.visitors)} visitors vs {fmt(f.baselineVisitors)} in the baseline week
                      {f.baselineVisitors > 0
                        ? ` (${(f.visitors / f.baselineVisitors).toFixed(1)}×)`
                        : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      {m.notes.length > 0 && (
        <details className="rp-mob-notes">
          <summary>Notes from the file ({m.notes.length})</summary>
          <ul>
            {m.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
