/**
 * What firefighting did in the last run: the best plan the search found, burned and developed
 * area with and without it, how its line fared, and every plan tried. Numbers are solver
 * output (studio/firefighting.ts).
 */

import { formatElapsed } from "../fire/spread";
import { Notice, SegmentedControl, Tag, type SegmentedOption } from "../ui";
import { STRATEGY_LABELS, type FirefightingResult } from "./firefighting";

export type FireShown = "with" | "without";
const SHOWN_OPTIONS: readonly SegmentedOption<FireShown>[] = [
  { value: "with", label: "With firefighters" },
  { value: "without", label: "No firefighters" },
];

const ha = (squareMeters: number) =>
  (squareMeters / 10_000).toFixed(squareMeters < 100_000 ? 1 : 0);
const km = (meters: number) => (meters / 1000).toFixed(1);

function change(value: number, base: number): string {
  if (base <= 0) return "";
  const pct = ((value - base) / base) * 100;
  if (Math.abs(pct) < 0.5) return " (no change)";
  return ` (${pct > 0 ? "+" : "−"}${Math.abs(pct).toFixed(0)}%)`;
}

export interface FirefightingResultsProps {
  result: FirefightingResult;
  stale: boolean;
  shown: FireShown;
  onShownChange: (shown: FireShown) => void;
}

export default function FirefightingResults({
  result,
  stale,
  shown,
  onShownChange,
}: FirefightingResultsProps) {
  const { best, baseline } = result;
  if (!best) {
    return (
      <Notice compact className="studio-notice">
        No firefighting plan could be made: {result.note}
      </Notice>
    );
  }
  const { score, statusMeters } = best;
  const helped = score.burnedSquareMeters < baseline.burnedSquareMeters;
  const someWorse = result.candidates.some(
    (candidate) => candidate.burnedSquareMeters > baseline.burnedSquareMeters,
  );
  return (
    <div className="studio-ff-result" aria-label="Firefighting result">
      <SegmentedControl
        label="Fire shown"
        options={SHOWN_OPTIONS}
        value={shown}
        onChange={onShownChange}
      />
      {stale && (
        <p className="studio-hint">From the previous run; run again to include your edits.</p>
      )}
      <div className="ui-table-scroll">
        <table className="ui-table studio-ff-table">
          <caption>
            At the horizon <Tag>Simulated</Tag>
          </caption>
          <thead>
            <tr>
              <th scope="col">Burned</th>
              <th scope="col" className="num">
                No crews
              </th>
              <th scope="col" className="num">
                Best plan
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">All land, ha</th>
              <td className="num">{ha(baseline.burnedSquareMeters)}</td>
              <td className="num">
                {ha(score.burnedSquareMeters)}
                <small className="studio-ff-delta">
                  {change(score.burnedSquareMeters, baseline.burnedSquareMeters)}
                </small>
              </td>
            </tr>
            <tr>
              <th scope="row">Developed land, ha</th>
              <td className="num">{ha(baseline.developedBurnedSquareMeters)}</td>
              <td className="num">
                {ha(score.developedBurnedSquareMeters)}
                <small className="studio-ff-delta">
                  {change(score.developedBurnedSquareMeters, baseline.developedBurnedSquareMeters)}
                </small>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="studio-hint">
        <strong>Plan:</strong> {STRATEGY_LABELS[score.strategy]}, building around where the
        unchecked fire would be at {formatElapsed(score.isochroneMinute)}; crews start at{" "}
        {formatElapsed(result.startMinute)}.
      </p>
      <ul className="studio-ff-line" aria-label="Control line outcome">
        <li>
          <span className="studio-ff-swatch is-held" aria-hidden="true" />
          Held: {km(statusMeters[0])} km
        </li>
        <li>
          <span className="studio-ff-swatch is-breached" aria-hidden="true" />
          Burned over (flames too long there): {km(statusMeters[1])} km
        </li>
        <li>
          <span className="studio-ff-swatch is-outrun" aria-hidden="true" />
          Outrun (fire got there first): {km(statusMeters[2])} km
        </li>
        <li>
          <span className="studio-ff-swatch is-unbuilt" aria-hidden="true" />
          Not finished by the horizon: {km(statusMeters[3])} km
        </li>
      </ul>
      <p className="studio-hint">
        The line is one to two cells wide; a stretch can burn over while the rest of the line still
        stops the fire.
      </p>
      {!helped && (
        <Notice compact tone="warning" className="studio-notice">
          No plan reduced the burned area: these crews cannot hold this fire.
        </Notice>
      )}
      <details className="studio-advanced">
        <summary>{result.candidates.length} plans tried</summary>
        <ol className="studio-ff-candidates">
          {result.candidates.map((candidate) => (
            <li key={`${candidate.strategy}-${candidate.isochroneMinute}`}>
              {candidate.strategy === "heel" ? "Heel" : "Head"} anchor, outline at{" "}
              {formatElapsed(candidate.isochroneMinute)}: {ha(candidate.burnedSquareMeters)} ha
              burned, {km(candidate.plannedMeters)} km line ({km(candidate.builtMeters)} km built)
            </li>
          ))}
        </ol>
        {someWorse && (
          <p className="studio-hint">
            Some plans burn more than no crews at all. In this model a line can divert the fire so
            that crown fire carries on where surface fire would otherwise have reached a stand first
            and stopped it; the search does not choose those plans.
          </p>
        )}
      </details>
    </div>
  );
}
