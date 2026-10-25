/**
 * Bottom band of /run: the board clock with play/pause and speed, and the scoreboard comparing the
 * baseline run (nobody acts) with the AI dispatch run at the same board minute, with a sparkline
 * per measure. All values are simulated (the board's score timeline, demo/runContracts.ts).
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
}

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
}: RunTimelineBarProps) {
  const horizon = Math.max(1, horizonMinutes);
  const now = minute ?? 0;
  const progress = Math.min(1, now / horizon);
  const speeds = [...new Set([...SHOWN_SPEEDS.filter((s) => speedSteps.includes(s)), speed])].sort((a, b) => a - b);
  const speedOptions: SegmentedOption<string>[] = speeds.map((s) => ({ value: String(s), label: `${s}×`, title: `${s} board minutes per real minute` }));
  // The AI run compares against the baseline at its own minute; during the baseline only that column fills.
  const shownAi = phase === "ai" ? ai : null;
  const shownBase = phase === "setup" ? null : baseline;

  return (
    <div className="ov-timeline">
      <div className="ov-clock">
        <div className="ov-clock-row">
          <strong className="ov-clock-now">{formatClock(minute)}</strong>
          <span className="ov-dim">of {formatDuration(horizon)}</span>
        </div>
        <div className="ov-track" role="progressbar" aria-label="Run progress, board minutes" aria-valuemin={0} aria-valuemax={horizon} aria-valuenow={Math.round(now)}>
          <span style={{ width: `${progress * 100}%` }} />
        </div>
        <span className="ov-caption">Simulated board clock</span>
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
        <SegmentedControl label="Speed" options={speedOptions} value={String(speed)} onChange={(v) => onSpeed(Number(v))} />
      </div>

      <div className="ov-score">
        <div className="ov-score-head">
          <h2>Scoreboard</h2>
          <span className="ov-dim">
            {phase === "ai" ? `Both runs compared at ${formatClock(minute)}` : phase === "baseline" ? "Baseline run in progress" : "Waiting for the baseline"}
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
