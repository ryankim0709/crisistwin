/**
 * Evacuation and road closures for the Studio 3D view: turn the evacuation overlay on, choose
 * when the order goes out, close roads and bridges by clicking them, and compare the run with
 * and without the closures. Every number is the dispatch engine's (studio/evacuation.ts).
 */

import type { RoadEdge } from "../dispatch/area";
import type { Totals } from "../dispatch/engine";
import { formatElapsed } from "../fire/spread";
import type { BoardStreetsState } from "../fire/useBoardStreets";
import { Button, Field, LoadingState, Panel, Tag } from "../ui";
import { ORDER_MINUTE_CHOICES, type EvacuationSummary } from "./evacuation";

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
}

function roadLabel(edge: RoadEdge): string {
  const name = edge.name ?? `Unnamed ${edge.roadClass.replace("_", " ")} road`;
  return edge.bridge ? `${name} (bridge)` : name;
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
  } = props;
  const ready = streets.status === "ready";
  const shown = withClosures ?? baseline;
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
                  {liveLine(shown.totalsByMinute[minute], minute)}
                </p>
              )}
              {stale && (
                <p className="studio-evac__note">
                  Evacuating against the previous run&rsquo;s fire; run again to include your edits.
                </p>
              )}
            </>
          )}

          <p className="studio-evac__note">
            Every zone is ordered at {formatElapsed(orderMinute)} to its fastest open exit and
            re-routed when fire cuts its route. Closures change traffic only, not the fire. Homes
            and zones are synthetic; counts are model output, not casualty estimates.
          </p>
        </>
      )}
    </Panel>
  );
}
