/**
 * What firefighting did in the last run: whether the crews put each fire out by direct attack
 * once on site (studio/initialAttack.ts), the best control-line plan the search found
 * (studio/firefighting.ts), and burned and developed area for both against no crews.
 */

import { formatElapsed } from "../fire/spread";
import { Notice, SegmentedControl, Tag, type SegmentedOption } from "../ui";
import { STRATEGY_LABELS, type FirefightingResult } from "./firefighting";
import type { FireAttack } from "./initialAttack";

/** Which fire the page shows: direct attack, the best line plan, or no crews. */
export type FireShown = "attack" | "line" | "none";

const ha = (squareMeters: number) =>
  (squareMeters / 10_000).toFixed(squareMeters < 100_000 ? 1 : 0);
const km = (meters: number) => (meters / 1000).toFixed(1);

function change(value: number, base: number): string {
  if (base <= 0) return "";
  const pct = ((value - base) / base) * 100;
  if (Math.abs(pct) < 0.5) return "no change";
  return `${pct > 0 ? "+" : "−"}${Math.abs(pct).toFixed(0)}%`;
}

function attackLine(fire: FireAttack, name: string, holds: number): string {
  if (fire.ignitedMinute === null) return `${name}: reached by another fire before it started.`;
  if (!fire.attackable) {
    return Number.isFinite(fire.headFlameFeet)
      ? `${name}: not attacked directly; head flames about ${fire.headFlameFeet.toFixed(0)} ft are longer than the ${holds} ft the crews can hold.`
      : `${name}: not attacked directly; it is crowning, which no crew can hold.`;
  }
  return fire.outMinute !== null
    ? `${name}: out at ${formatElapsed(Math.round(fire.outMinute))}, about ${ha(fire.areaSquareMeters)} ha and ${km(fire.perimeterMeters)} km of edge.`
    : `${name}: still burning at the horizon; its edge (about ${km(fire.perimeterMeters)} km) grows faster than the crews build line.`;
}

export interface FirefightingResultsProps {
  result: FirefightingResult;
  /** Fire names by source id, for the per-fire lines. */
  names: Record<string, string>;
  stale: boolean;
  shown: FireShown;
  onShownChange: (shown: FireShown) => void;
}

export default function FirefightingResults({
  result,
  names,
  stale,
  shown,
  onShownChange,
}: FirefightingResultsProps) {
  const { best, baseline, initialAttack } = result;
  const someWorse = result.candidates.some(
    (candidate) => candidate.burnedSquareMeters > baseline.burnedSquareMeters,
  );
  const options: readonly SegmentedOption<FireShown>[] = [
    { value: "attack", label: "Direct attack", disabled: !initialAttack },
    { value: "line", label: "Line plan", disabled: !best },
    { value: "none", label: "No crews" },
  ];
  const columns: { label: string; burned: number; developed: number }[] = [
    {
      label: "No crews",
      burned: baseline.burnedSquareMeters,
      developed: baseline.developedBurnedSquareMeters,
    },
    ...(initialAttack
      ? [
          {
            label: "Direct attack",
            burned: initialAttack.areas.burnedSquareMeters,
            developed: initialAttack.areas.developedBurnedSquareMeters,
          },
        ]
      : []),
    ...(best
      ? [
          {
            label: "Line plan",
            burned: best.score.burnedSquareMeters,
            developed: best.score.developedBurnedSquareMeters,
          },
        ]
      : []),
  ];
  const estimate = initialAttack?.estimate;

  return (
    <div className="studio-ff-result" aria-label="Firefighting result">
      <SegmentedControl
        label="Fire shown"
        options={options}
        value={shown}
        onChange={onShownChange}
      />
      {stale && (
        <p className="studio-hint">From the previous run; run again to include your edits.</p>
      )}
      <div className="ui-table-scroll">
        <table className="ui-table studio-ff-table">
          <caption>
            Burned at the horizon, ha <Tag>Simulated</Tag>
          </caption>
          <thead>
            <tr>
              <th scope="col">Land</th>
              {columns.map((column) => (
                <th key={column.label} scope="col" className="num">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(["burned", "developed"] as const).map((key) => (
              <tr key={key}>
                <th scope="row">{key === "burned" ? "All" : "Developed"}</th>
                {columns.map((column, index) => (
                  <td key={column.label} className="num">
                    {ha(column[key])}
                    {index > 0 && (
                      <small className="studio-ff-delta">
                        {change(column[key], columns[0][key])}
                      </small>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {estimate && (
        <section className="studio-ff-attack" aria-label="Direct attack once on site">
          <h4 className="studio-ff-heading">
            Once on site <Tag>Rough estimate</Tag>
          </h4>
          <p className="studio-hint">
            From {formatElapsed(estimate.onSiteMinute)} the crews build about{" "}
            {Math.round(estimate.lineMetersPerMinute * 60).toLocaleString()} m of line an hour in
            grass (less in brush and timber) around each fire&rsquo;s edge. A fire is out when the
            line built covers its edge, estimated from its size as an ellipse.
          </p>
          <ul className="studio-ff-fires">
            {estimate.fires.map((fire) => (
              <li key={fire.sourceId}>
                {attackLine(
                  fire,
                  names[fire.sourceId] ?? fire.sourceId,
                  estimate.holdsFlameLengthFeet,
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {best ? (
        <details className="studio-advanced">
          <summary>Best control-line plan</summary>
          <p className="studio-hint">
            <strong>Plan:</strong> {STRATEGY_LABELS[best.score.strategy]}, building around where the
            unchecked fire would be at {formatElapsed(best.score.isochroneMinute)}; crews start at{" "}
            {formatElapsed(result.startMinute)}.
          </p>
          <ul className="studio-ff-line" aria-label="Control line outcome">
            <li>
              <span className="studio-ff-swatch is-held" aria-hidden="true" />
              Held: {km(best.statusMeters[0])} km
            </li>
            <li>
              <span className="studio-ff-swatch is-breached" aria-hidden="true" />
              Burned over (flames too long there): {km(best.statusMeters[1])} km
            </li>
            <li>
              <span className="studio-ff-swatch is-outrun" aria-hidden="true" />
              Outrun (fire got there first): {km(best.statusMeters[2])} km
            </li>
            <li>
              <span className="studio-ff-swatch is-unbuilt" aria-hidden="true" />
              Not finished by the horizon: {km(best.statusMeters[3])} km
            </li>
          </ul>
          <p className="studio-hint">
            The line is one to two cells wide; a stretch can burn over while the rest of the line
            still stops the fire.
          </p>
          {best.score.burnedSquareMeters >= baseline.burnedSquareMeters && (
            <Notice compact tone="warning" className="studio-notice">
              No line plan reduced the burned area: these crews cannot hold this fire with line.
            </Notice>
          )}
          <p className="studio-hint">{result.candidates.length} plans tried:</p>
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
              that crown fire carries on where surface fire would otherwise have reached a stand
              first and stopped it; the search does not choose those plans.
            </p>
          )}
        </details>
      ) : (
        <Notice compact className="studio-notice">
          No control-line plan could be made: {result.note}
        </Notice>
      )}
    </div>
  );
}
