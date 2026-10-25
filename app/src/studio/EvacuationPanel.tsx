/**
 * Evacuation and road closures for the Studio 3D view: turn the evacuation overlay on, choose
 * when the order goes out, close roads and bridges by clicking them, and compare the run with
 * and without the closures. Every number is the dispatch engine's (studio/evacuation.ts).
 */

import { roadLabel, type DispatchArea, type RoadEdge } from "../dispatch/area";
import type { Totals } from "../dispatch/engine";
import { formatElapsed } from "../fire/spread";
import type { BoardStreetsState } from "../fire/useBoardStreets";
import "../live/live-share.css";
import { Button, Field, LoadingState, Notice, Panel, SegmentedControl, Tag } from "../ui";
import {
  ORDER_MINUTE_CHOICES,
  TRIGGER_SAFETY_BUFFER_MINUTES,
  type EvacuationSummary,
} from "./evacuation";
import type { AreaCoverage } from "./areaCoverage";
import AreaCoverageNotice from "./AreaCoverageNotice";
import { describeImprovement } from "./evacuationAdvice";
import type { EvacuationOptimization } from "./evacuationOptimizer";
import type { EvacuationOptimizerState } from "./useEvacuationOptimizer";
import type { SimStatePublishStatus } from "./useSimStatePublisher";
import {
  HOUSEHOLD_BEHAVIOR_OPTIONS,
  householdBehaviorText,
  type HouseholdBehaviorMode,
} from "../population/householdBehavior";

/** Which plan the 3D view plays: the default policy or the optimiser's best. */
export type PlayPlan = "fastest" | "optimized";

const PLAY_OPTIONS = [
  {
    value: "fastest",
    label: "Away from fire",
    title: "Every zone to its fastest exit leading away from the fire",
  },
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
  /** Null: threat-based trigger orders; a number: order everyone at that minute. */
  orderMinute: number | null;
  onOrderMinute: (minute: number | null) => void;
  closedEdges: readonly RoadEdge[];
  onReopen: (edge: number) => void;
  onReopenAll: () => void;
  baseline: EvacuationSummary | null;
  withClosures: EvacuationSummary | null;
  currentMinute: number;
  /** Road graph, for exit and zone names in the optimised plan. */
  area: DispatchArea | null;
  /** Which part of the board the area covers, and what the fires do outside it. */
  coverage?: AreaCoverage | null;
  optimizer: EvacuationOptimizerState;
  playPlan: PlayPlan;
  onPlayPlan: (plan: PlayPlan) => void;
  /** Share the run's homes and advice with the resident app (docs/sim-state-api.md). */
  publish: boolean;
  onPublish: (on: boolean) => void;
  publishStatus: SimStatePublishStatus;
  /** How households respond to the order (population/householdBehavior.ts); hidden when absent. */
  behavior?: HouseholdBehaviorMode;
  onBehavior?: (mode: HouseholdBehaviorMode) => void;
}

function publishText(status: SimStatePublishStatus): string {
  switch (status.state) {
    case "idle":
      return "Not shared. Shares once a run exists.";
    case "publishing":
      return "Publishing homes and zones…";
    case "live":
      return status.minute === null
        ? "Published. Waiting for the first playback minute."
        : `Resident app sees T+${status.minute} min (simulated).`;
    case "error":
      return `Could not share: ${status.message}`;
  }
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
    out: final.waiting - (final.staying ?? 0) + final.onRoad,
    staying: final.staying ?? 0,
    cutOff: summary.cutOffHomes,
    unthreatened: summary.unthreatenedHomes,
    hours: summary.householdHoursEvacuating,
  };
}

function liveLine(totals: Totals | undefined, minute: number): string | null {
  if (!totals) return null;
  const staying = totals.staying ?? 0;
  return `At ${formatElapsed(minute)}: ${totals.waiting - staying} waiting, ${totals.onRoad} on the road, ${totals.safe} out, ${totals.caught} caught${staying ? `, ${staying} staying home` : ""}.`;
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
    coverage,
    optimizer,
    playPlan,
    onPlayPlan,
    publish,
    onPublish,
    publishStatus,
    behavior,
    onBehavior,
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
        <p className="studio-evac__note">No drivable roads around these fires to evacuate on.</p>
      )}
      {ready && <AreaCoverageNotice coverage={coverage ?? null} />}
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
          <Field label="Evacuation orders">
            <select
              className="ui-input"
              value={orderMinute === null ? "threat" : String(orderMinute)}
              onChange={(event) =>
                onOrderMinute(event.target.value === "threat" ? null : Number(event.target.value))
              }
            >
              <option value="threat">When the fire threatens a zone</option>
              {ORDER_MINUTE_CHOICES.map((choice) => (
                <option key={choice} value={choice}>
                  Order everyone at {formatElapsed(choice)}
                </option>
              ))}
            </select>
          </Field>

          {behavior && onBehavior && (
            <Field label="Households" hint={householdBehaviorText(behavior)}>
              <select
                className="ui-input"
                value={behavior}
                onChange={(event) => onBehavior(event.target.value as HouseholdBehaviorMode)}
              >
                {HOUSEHOLD_BEHAVIOR_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>
          )}

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
                        ["Stayed home (did not leave)", "staying", 0],
                        ["Cut off (no open exit)", "cutOff", 0],
                        ["Still home (not threatened)", "unthreatened", 0],
                        ["Household-hours evacuating", "hours", 1],
                      ] as const
                    )
                      .filter(
                        ([, key]) =>
                          (key !== "staying" && key !== "unthreatened") ||
                          rows(baseline)[key] > 0 ||
                          (withClosures !== null && rows(withClosures)[key] > 0),
                      )
                      .map(([label, key, digits]) => {
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

          {hasRun && (
            <div className="live-share">
              <input
                id="studio-evac-publish"
                type="checkbox"
                checked={publish}
                onChange={(event) => onPublish(event.target.checked)}
              />
              <label htmlFor="studio-evac-publish">Share with resident app (homes)</label>{" "}
              <Tag>Simulated</Tag>
              <p className="live-share__status" role="status" data-state={publishStatus.state}>
                {publishText(publishStatus)}
              </p>
              <p className="studio-evac__note">
                Sends this run&rsquo;s synthetic homes and made-up street addresses with leave-now /
                leave-later advice as playback moves. A planning experiment, not an evacuation
                order.
              </p>
            </div>
          )}

          <p className="studio-evac__note">
            {orderMinute === null
              ? `A zone is told to get ready, then to leave, once the modelled fire is within its time to clear (departure + drive + ${TRIGGER_SAFETY_BUFFER_MINUTES} min assumed buffer; Cova et al. 2005 triggers). Zones the fire does not threaten stay home.`
              : `Every zone is ordered at ${formatElapsed(orderMinute)}.`}{" "}
            Unless you play the optimized plan, people head away from the fire, to the fastest exit
            that leads away (else the fastest open one), and are re-routed when fire cuts their
            route. Closures change traffic only, not the fire. Homes and zones are synthetic; counts
            are model output, not casualty estimates.
          </p>
        </>
      )}
    </Panel>
  );
}
