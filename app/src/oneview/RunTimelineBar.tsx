/**
 * Bottom band of /run: the board clock with play/pause and speed, and the scoreboard comparing the
 * baseline run (nobody acts) with the AI dispatch run at the same board minute, with a sparkline
 * per measure. All values are simulated (the board's score timeline, demo/runContracts.ts).
 * Once a run is recorded the progress track becomes a scrubber (RunScrub): the scoreboard then
 * reads both runs at the scrubbed minute and the page shows that run's recorded board.
 */

import { useMemo } from "react";
import { Button, EvidenceTag, SegmentedControl, Tag, type SegmentedOption } from "../ui";
import type { RunTimeline } from "../demo/runContracts";
import { formatClock, formatDuration } from "./format";
import { SCORE_METRICS, compare, pointAt, type ScoreMetric } from "./scoreCompare";
import type { RunPhase } from "./types";
import "./timeline.css";

const SHOWN_SPEEDS = [1, 5, 20, 60, 120, 240];
const SPARK_W = 96;
const SPARK_H = 24;

function sparkPath(timeline: RunTimeline | null, key: ScoreMetric["key"], horizon: number, max: number): string {
  if (!timeline || timeline.points.length === 0) return "";
  const x = (m: number) => (Math.min(m, horizon) / horizon) * SPARK_W;
  const y = (v: number) => SPARK_H - 2 - (max > 0 ? (v / max) * (SPARK_H - 4) : 0);
  return timeline.points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.minute).toFixed(1)},${y(p[key]).toFixed(1)}`).join("");
}

function Sparkline({
  metric,
  baseline,
  ai,
  horizon,
  minute,
}: {
  metric: ScoreMetric;
  baseline: RunTimeline | null;
  ai: RunTimeline | null;
  horizon: number;
  minute: number;
}) {
  const { base, mine, label } = useMemo(() => {
    let max = 0;
    for (const t of [baseline, ai]) for (const p of t?.points ?? []) max = Math.max(max, p[metric.key]);
    const b = pointAt(baseline, minute);
    const a = pointAt(ai, minute);
    return {
      base: sparkPath(baseline, metric.key, horizon, max),
      mine: sparkPath(ai, metric.key, horizon, max),
      label: `${metric.label} over time: baseline ${b ? metric.format(b[metric.key]) : "no data"}, AI ${a ? metric.format(a[metric.key]) : "no data"} at ${formatClock(minute)}`,
    };
  }, [metric, baseline, ai, horizon, minute]);
  const cursor = (Math.min(minute, horizon) / horizon) * SPARK_W;
  return (
    <svg className="ov-spark" width={SPARK_W} height={SPARK_H} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} role="img" aria-label={label}>
      <title>{label}</title>
      <line className="ov-spark-cursor" x1={cursor} x2={cursor} y1={0} y2={SPARK_H} />
      {base ? <path className="ov-spark-base" d={base} /> : null}
      {mine ? <path className="ov-spark-ai" d={mine} /> : null}
    </svg>
  );
}

export interface RunTimelineBarProps {
  phase: RunPhase;
  minute: number | null;
  horizonMinutes: number;
  running: boolean;
  canPlay: boolean;
  onPlayPause: () => void;
  speed: number;
  speedSteps: readonly number[];
  onSpeed: (speed: number) => void;
  autoSpeed: boolean | null;
  onAutoSpeed: ((on: boolean) => void) | null;
  baseline: RunTimeline | null;
  ai: RunTimeline | null;
  /** The baseline run has reached the run length (header says "recorded" instead of "in progress"). */
  baselineDone?: boolean;
  /** The baseline being computed at full model speed (oneview fast run): board minute reached. Null otherwise. */
  computing?: { minute: number } | null;
  /** Scrubbing recorded runs; null while nothing recorded can be scrubbed. */
  scrub?: RunScrub | null;
}

/** Which recorded run's board the 3D view shows while scrubbing. */
export type ScrubView = "baseline" | "ai";

export interface RunScrub {
  /** Board minute shown, or null for live / the end of the run ("now"). */
  minute: number | null;
  /** Last board minute that can be shown (the longest recorded run). */
  max: number;
  onScrub: (minute: number | null) => void;
  view: ScrubView;
  /** Runs with a recorded board (one entry: no toggle). */
  views: ScrubView[];
  onView: (view: ScrubView) => void;
  /** Board minute of the recorded board drawn (the nearest snapshot at or before `minute`, or the run's end), or null. */
  boardMinute?: number | null;
}

const VIEW_LABEL: Record<ScrubView, string> = { baseline: "Baseline", ai: "AI dispatch" };

export default function RunTimelineBar({
  phase,
  minute,
  horizonMinutes,
  running,
  canPlay,
  onPlayPause,
  speed,
  speedSteps,
  onSpeed,
  autoSpeed,
  onAutoSpeed,
  baseline,
  ai,
  baselineDone = false,
  computing = null,
  scrub = null,
}: RunTimelineBarProps) {
  const horizon = Math.max(1, horizonMinutes);
  const scrubbing = scrub !== null && scrub.minute !== null;
  // The scoreboard and sparkline cursors read the scrubbed minute while scrubbing, else the clock.
  const now = scrubbing ? scrub.minute! : (computing?.minute ?? minute ?? 0);
  const progress = Math.min(1, now / horizon);
  const speeds = [...new Set([...SHOWN_SPEEDS.filter((s) => speedSteps.includes(s)), speed])].sort((a, b) => a - b);
  const speedOptions: SegmentedOption<string>[] = speeds.map((s) => ({ value: String(s), label: `${s}×`, title: `${s} board minutes per real minute` }));
  // The AI run compares against the baseline at its own minute; during the baseline only that column fills.
  const shownAi = phase === "ai" || scrubbing ? ai : null;
  const shownBase = phase === "setup" ? null : baseline;

  return (
    <div className="ov-timeline">
      <div className="ov-clock">
        <div className="ov-clock-row">
          <strong className="ov-clock-now">{formatClock(scrubbing || computing ? now : minute)}</strong>
          <span className="ov-dim">of {formatDuration(horizon)}</span>
          {scrubbing ? <Tag tone="warning">Recorded</Tag> : computing ? <Tag tone="brand">Computing</Tag> : null}
        </div>
        {scrub ? (
          <input
            type="range"
            className="ov-scrubber"
            aria-label="Scrub the recorded runs, board minutes"
            aria-valuetext={`${formatClock(now)} of ${formatClock(scrub.max)} recorded`}
            min={0}
            max={horizon}
            step={1}
            value={Math.round(scrubbing ? scrub.minute! : Math.min(now, scrub.max))}
            onChange={(event) => scrub.onScrub(Math.min(scrub.max, Math.max(0, Number(event.target.value))))}
            style={{ ["--ov-recorded" as string]: `${(Math.min(1, scrub.max / horizon) * 100).toFixed(1)}%` }}
          />
        ) : (
          <div className="ov-track" role="progressbar" aria-label="Run progress, board minutes" aria-valuemin={0} aria-valuemax={horizon} aria-valuenow={Math.round(now)}>
            <span style={{ width: `${progress * 100}%` }} />
          </div>
        )}
        <span className="ov-caption">
          {scrubbing
            ? `3D: recorded ${VIEW_LABEL[scrub.view]} board at ${formatClock(scrub.boardMinute ?? now)} (simulated; scrubbing never changes a run)`
            : scrub
              ? "Simulated board clock · drag to replay the recorded runs"
              : "Simulated board clock"}
        </span>
        {scrub ? (
          <div className="ov-clock-controls">
            <Button size="sm" variant={scrubbing ? "primary" : "secondary"} disabled={!scrubbing} onClick={() => scrub.onScrub(null)}>
              {phase === "ai" && running ? "Back to live" : "Back to now"}
            </Button>
            {scrub.views.length > 1 ? (
              <SegmentedControl
                label="Board shown while scrubbing"
                options={scrub.views.map((v) => ({ value: v, label: VIEW_LABEL[v], title: `Show the ${VIEW_LABEL[v]} run's board at the scrubbed minute` }))}
                value={scrub.view}
                onChange={(v) => scrub.onView(v as ScrubView)}
              />
            ) : null}
          </div>
        ) : null}
        <div className="ov-clock-controls">
          <Button size="sm" variant="secondary" disabled={!canPlay} aria-pressed={running} onClick={onPlayPause}>
            {running ? "Pause" : "Play"}
          </Button>
          {onAutoSpeed && autoSpeed !== null ? (
            <Button size="sm" variant="ghost" aria-pressed={autoSpeed} onClick={() => onAutoSpeed(!autoSpeed)} title="Auto slows the clock while the AI decides">
              Auto speed
            </Button>
          ) : null}
        </div>
        {computing ? null : <SegmentedControl label="Speed" options={speedOptions} value={String(speed)} onChange={(v) => onSpeed(Number(v))} />}
      </div>

      <div className="ov-score">
        <div className="ov-score-head">
          <h2>Scoreboard</h2>
          <span className="ov-dim">
            {scrubbing
              ? `Recorded values at ${formatClock(now)} (each run where it has data)`
              : phase === "ai"
                ? `Both runs compared at ${formatClock(minute)}`
                : phase === "baseline"
                  ? baselineDone
                    ? `Baseline recorded to ${formatClock(baseline?.points.at(-1)?.minute ?? minute)}`
                    : computing
                      ? `Computing the baseline at full model speed: ${formatClock(computing.minute)}`
                      : "Baseline run in progress"
                  : "Waiting for the baseline"}
          </span>
          <EvidenceTag kind="simulated" />
          <span className="ov-legend" aria-hidden="true">
            <span className="ov-key ov-key--base" /> Baseline <span className="ov-key ov-key--ai" /> AI dispatch
          </span>
        </div>
        {phase === "setup" && !baseline ? (
          <p className="ov-dim">Prepare a scenario and run the baseline to start the scoreboard.</p>
        ) : (
          <div className="ui-table-scroll">
            <table className="ui-table ov-score-table">
              <thead>
                <tr>
                  <th scope="col">Measure</th>
                  <th scope="col" className="num">Baseline (nobody acts)</th>
                  <th scope="col" className="num">AI dispatch</th>
                  <th scope="col">Difference</th>
                  <th scope="col">Over time</th>
                </tr>
              </thead>
              <tbody>
                {SCORE_METRICS.map((metric) => {
                  const b = pointAt(shownBase, now);
                  const a = pointAt(shownAi, now);
                  const diff = b && a ? compare(metric, b[metric.key], a[metric.key]) : null;
                  return (
                    <tr key={metric.key}>
                      <th scope="row">{metric.label}</th>
                      <td className="num">{b ? metric.format(b[metric.key]) : "—"}</td>
                      <td className="num">{a ? metric.format(a[metric.key]) : "—"}</td>
                      <td>
                        {diff ? (
                          <span className="ov-diff">
                            {diff.text}
                            {diff.verdict !== "same" ? <Tag tone={diff.verdict === "better" ? "success" : "danger"}>{diff.verdict}</Tag> : null}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        <Sparkline metric={metric} baseline={shownBase} ai={shownAi} horizon={horizon} minute={now} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
