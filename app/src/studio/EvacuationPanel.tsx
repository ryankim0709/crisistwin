/**
 * Evacuation and road closures for the Studio 3D view: turn the evacuation overlay on, choose
 * when the order goes out, close roads and bridges by clicking them, and compare the run with
 * and without the closures. Every number is the dispatch engine's (studio/evacuation.ts).
 */

import { roadLabel, type DispatchArea, type RoadEdge } from "../dispatch/area";
import type { Totals } from "../dispatch/engine";
import { formatElapsed } from "../fire/spread";
import type { BoardStreetsState } from "../fire/useBoardStreets";
import { Button, Field, LoadingState, Notice, Panel, SegmentedControl, Tag } from "../ui";
import { ORDER_MINUTE_CHOICES, type EvacuationSummary } from "./evacuation";
import { describeImprovement } from "./evacuationAdvice";
import type { EvacuationOptimization } from "./evacuationOptimizer";
import type { EvacuationOptimizerState } from "./useEvacuationOptimizer";

/** Which plan the 3D view plays: the default policy or the optimiser's best. */
export type PlayPlan = "fastest" | "optimized";

const PLAY_OPTIONS = [
  { value: "fastest", label: "Fastest exit", title: "Every zone to its fastest open exit" },
  { value: "optimized", label: "Optimized plan", title: "The best plan the search found" },
] as const;

export interface EvacuationPanelProps {
  streets: BoardStreetsState;
  /** A fire run exists for the board shown. */
  hasRun: boolean;
  /** The run predates edits to the scenario. */
  stale: boolean;
  enabled: boolean;
  onToggle: () => void;
  roadTool: boolean;
  onRoadTool: () => void;
  orderMinute: number;
  onOrderMinute: (minute: number) => void;
  closedEdges: readonly RoadEdge[];
  onReopen: (edge: number) => void;
  onReopenAll: () => void;
  baseline: EvacuationSummary | null;
  withClosures: EvacuationSummary | null;
  currentMinute: number;
  /** Road graph, for exit and zone names in the optimised plan. */
  area: DispatchArea | null;
  optimizer: EvacuationOptimizerState;
  playPlan: PlayPlan;
  onPlayPlan: (plan: PlayPlan) => void;
}

function clearText(summary: EvacuationSummary): string {
  return summary.allClearMinute === null
    ? "Not by horizon"
    : formatElapsed(Math.round(summary.allClearMinute));
}

function delta(value: number, base: number, digits = 0): string {
  const d = value - base;
  if (Math.abs(d) < 10 ** -digits / 2) return "";
  return `${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(digits)}`;
}

function rows(summary: EvacuationSummary) {
  const { final } = summary;
  return {
    safe: final.safe,
    caught: final.caught,
    out: final.waiting + final.onRoad,
    cutOff: summary.cutOffHomes,
    hours: summary.householdHoursEvacuating,
  };
}

function liveLine(totals: Totals | undefined, minute: number): string | null {
  if (!totals) return null;
  return `At ${formatElapsed(minute)}: ${totals.waiting} waiting, ${totals.onRoad} on the road, ${totals.safe} out, ${totals.caught} caught.`;
}

function OptimizedPlan({
  optimizer,
  area,
  closureCount,
  playPlan,
  onPlayPlan,
}: {
  optimizer: EvacuationOptimizerState;
  area: DispatchArea | null;
  closureCount: number;
  playPlan: PlayPlan;
  onPlayPlan: (plan: PlayPlan) => void;
}) {
  const result = optimizer.status === "ready" ? optimizer.result : undefined;
  const exitName = (id: string | null) =>
    id === null ? "no exit" : (area?.exits.find((exit) => exit.id === id)?.name ?? id);
  const zoneName = (id: string) => area?.zones.find((zone) => zone.id === id)?.name ?? id;

  return (
    <section className="studio-evac__plan" aria-labelledby="studio-evac-plan-title">
      <div className="studio-evac__head">
        <strong id="studio-evac-plan-title">Optimized plan</strong>
        <Tag>Simulated</Tag>
      </div>

      <div role="status" aria-live="polite" className="studio-evac__status">
        {optimizer.status === "running" && (
          <LoadingState>
            Testing strategies…
            {optimizer.progress ? ` ${optimizer.progress.done}/${optimizer.progress.total}` : ""}
          </LoadingState>
        )}
        {optimizer.status === "error" && (
          <Notice tone="danger" compact title="The search failed">
            {optimizer.error}
          </Notice>
        )}
        {result && (
          <p className="studio-evac__summary">
            {describeImprovement({
              baseline: result.baseline.summary,
              best: result.best.summary,
              changes: result.changes,
              improved: result.improved,
              closureCount,
            })}
          </p>
        )}
      </div>

      {result && (
        <>
          <StrategyTable result={result} />
          {result.best.summary.stagedHomes > 0 && (
            <p className="studio-evac__note">
              In the best plan {result.best.summary.stagedHomes} households in staged zones were
              still at home waiting for their wave at the horizon.
            </p>
          )}
          {result.changes.length > 0 && (
            <details className="studio-evac__changes">
              <summary>
                What changes in the best plan ({result.changes.length}{" "}
                {result.changes.length === 1 ? "zone" : "zones"})
              </summary>
              <ul>
                {result.changes.map((change) => {
                  const moved = change.exitId !== change.fastestExitId;
                  return (
                    <li key={change.zoneId}>
                      <strong>{change.zoneName}</strong> ({change.homes} homes):{" "}
                      {moved
                        ? `${exitName(change.fastestExitId)} → ${exitName(change.exitId)}`
                        : `stays on ${exitName(change.exitId)}`}
                      {change.afterZoneId && `, waits for ${zoneName(change.afterZoneId)}`}
                    </li>
                  );
                })}
              </ul>
            </details>
          )}
        </>
      )}

      <SegmentedControl
        label="Plan played in the 3D view"
        options={PLAY_OPTIONS.map((option) => ({
          ...option,
          disabled: option.value === "optimized" && !result,
        }))}
        value={playPlan}
        onChange={onPlayPlan}
        className="studio-evac__play"
      />
      {playPlan === "optimized" && !result && (
        <p className="studio-evac__note">Playing the fastest exit until the search finishes.</p>
      )}

      {result && (
        <p className="studio-evac__note">
          Model experiment over synthetic homes, not an instruction to anyone. The search tried{" "}
          {result.evaluations} strategies and re-runs when you change closures or the order time.
        </p>
      )}
    </section>
  );
}

function StrategyTable({ result }: { result: EvacuationOptimization }) {
  return (
    <div className="ui-table-scroll">
      <table className="ui-table studio-evac__table studio-evac__strategies">
        <caption className="studio-evac__sr">Strategies tried at the horizon, best first</caption>
        <thead>
          <tr>
            <th scope="col">Strategy</th>
            <th scope="col" className="num" title="Households that reached an exit">
              Out
            </th>
            <th scope="col" className="num" title="Households caught by the fire">
              Caught
            </th>
            <th scope="col" className="num" title="Household-hours evacuating">
              HH-hours
            </th>
            <th scope="col" className="num" title="Everyone ordered is out by">
              All clear
            </th>
          </tr>
        </thead>
        <tbody>
          {result.tried.map((candidate) => {
            const { final } = candidate.summary;
            return (
              <tr key={candidate.id} title={candidate.description}>
                <th scope="row">
                  {candidate.label}
                  {candidate.id === result.best.id && (
                    <>
                      {" "}
                      <Tag tone="success">Best</Tag>
                    </>
                  )}
                </th>
                <td className="num">{final.safe}</td>
                <td className="num">{final.caught}</td>
                <td className="num">{candidate.summary.householdHoursEvacuating.toFixed(1)}</td>
                <td className="num">{clearText(candidate.summary)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function EvacuationPanel(props: EvacuationPanelProps) {
  const {
    streets,
    hasRun,
    stale,
    enabled,
    onToggle,
    roadTool,
    onRoadTool,
    orderMinute,
    onOrderMinute,
    closedEdges,
    onReopen,
    onReopenAll,
    baseline,
    withClosures,
    currentMinute,
    area,
    optimizer,
    playPlan,
    onPlayPlan,
  } = props;
  const ready = streets.status === "ready";
  const playingOptimized = playPlan === "optimized" && optimizer.status === "ready";
  const shown =
    playingOptimized && optimizer.result
      ? optimizer.result.best.summary
      : (withClosures ?? baseline);
  const minute = Math.floor(currentMinute);

  return (
    <Panel glass compact className="studio-evac" aria-label="Evacuation and road closures">
      <div className="studio-evac__head">
        <strong>Evacuation &amp; closures</strong>
        <Button
          size="sm"
          variant={enabled ? "secondary" : "primary"}
          aria-pressed={enabled}
          disabled={!ready}
          onClick={onToggle}
        >
          {enabled ? "Hide" : "Show"}
        </Button>
      </div>

      {streets.status === "loading" && <LoadingState>Loading roads…</LoadingState>}
      {streets.status === "idle" && <p className="studio-evac__note">Load a board first.</p>}
      {streets.status === "empty" && (
        <p className="studio-evac__note">This board has no drivable roads to evacuate on.</p>
      )}
      {streets.status === "error" && (
        <p className="studio-evac__note">Roads could not be loaded: {streets.message}</p>
      )}

      {ready && !enabled && (
        <p className="studio-evac__note">
          Evacuate the board&rsquo;s homes against the modelled fire, and close roads or bridges to
          see what changes.
        </p>
      )}

      {ready && enabled && (
        <>
          <Field label="Evacuation order goes out at">
            <select
              className="ui-input"
              value={orderMinute}
              onChange={(event) => onOrderMinute(Number(event.target.value))}
            >
              {ORDER_MINUTE_CHOICES.map((choice) => (
                <option key={choice} value={choice}>
                  {formatElapsed(choice)}
                </option>
              ))}
            </select>
          </Field>

          <div className="studio-evac__tool">
            <Button
              size="sm"
              variant={roadTool ? "primary" : "secondary"}
              aria-pressed={roadTool}
              onClick={onRoadTool}
            >
              {roadTool ? "Done closing roads" : "Close roads or bridges"}
            </Button>
            {roadTool && (
              <p className="studio-evac__note" role="status">
                Click a road on the board to close it; click a closed road to reopen it.
              </p>
            )}
          </div>

          {closedEdges.length > 0 && (
            <div className="studio-evac__closures">
              <div className="studio-evac__head">
                <span>
                  {closedEdges.length} closed for the whole run <Tag>Your assumption</Tag>
                </span>
                <Button size="sm" variant="ghost" onClick={onReopenAll}>
                  Reopen all
                </Button>
              </div>
              <ul>
                {closedEdges.map((edge) => (
                  <li key={edge.index}>
                    <span>✕ {roadLabel(edge)}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Reopen ${roadLabel(edge)}`}
                      onClick={() => onReopen(edge.index)}
                    >
                      Reopen
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!hasRun && (
            <p className="studio-evac__note">
              Run the simulation to evacuate against its fire. Closures can be set now.
            </p>
          )}

          {hasRun && baseline && (
            <>
              <div className="ui-table-scroll">
                <table className="ui-table studio-evac__table">
                  <caption>
                    At the horizon <Tag>Simulated</Tag>
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Households</th>
                      <th scope="col" className="num">
                        All open
                      </th>
                      {withClosures && (
                        <th scope="col" className="num">
                          Your closures
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      [
                        ["Reached an exit", "safe", 0],
                        ["Caught by the fire", "caught", 0],
                        ["Still evacuating", "out", 0],
                        ["Cut off (no open exit)", "cutOff", 0],
                        ["Household-hours evacuating", "hours", 1],
                      ] as const
                    ).map(([label, key, digits]) => {
                      const base = rows(baseline)[key];
                      const change = withClosures
                        ? delta(rows(withClosures)[key], base, digits)
                        : "";
                      return (
                        <tr key={key}>
                          <th scope="row">{label}</th>
                          <td className="num">{base.toFixed(digits)}</td>
                          {withClosures && (
                            <td className="num">
                              {rows(withClosures)[key].toFixed(digits)}
                              {change && (
                                <small className="studio-evac__delta">{change} vs open</small>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                    <tr>
                      <th scope="row">Everyone ordered is out by</th>
                      <td className="num">{clearText(baseline)}</td>
                      {withClosures && <td className="num">{clearText(withClosures)}</td>}
                    </tr>
                  </tbody>
                </table>
              </div>
              {shown && (
                <p className="studio-evac__live" aria-live="off">
                  {playingOptimized ? "Optimized plan. " : ""}
                  {liveLine(shown.totalsByMinute[minute], minute)}
                </p>
              )}
              {stale && (
                <p className="studio-evac__note">
                  Evacuating against the previous run&rsquo;s fire; run again to include your edits.
                </p>
              )}
              <OptimizedPlan
                optimizer={optimizer}
                area={area}
                closureCount={closedEdges.length}
                playPlan={playPlan}
                onPlayPlan={onPlayPlan}
              />
            </>
          )}

          <p className="studio-evac__note">
            Unless you play the optimized plan, every zone is ordered at{" "}
            {formatElapsed(orderMinute)} to its fastest open exit and re-routed when fire cuts its
            route. Closures change traffic only, not the fire. Homes and zones are synthetic; counts
            are model output, not casualty estimates.
          </p>
        </>
      )}
    </Panel>
  );
}
