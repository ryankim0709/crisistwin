import type { ControllerInfo, TwinEvidence, TwinMetrics } from "./types";

const nf = (n: number) => Math.round(n).toLocaleString("en-US");

/** Evidence fields newer than types.ts (docs/twin-api.md "Controller evidence"). */
type Evidence = TwinEvidence & { worse_than_baseline?: boolean; no_signal?: boolean };

/** Rows of the comparison; `better` is the direction a controller wants. */
const ROWS: { key: keyof TwinMetrics | "cost"; label: string; better: "lower" | "higher" }[] = [
  { key: "cost", label: "Cost, veh-min", better: "lower" },
  { key: "total_exposed_veh_min", label: "Exposed, veh-min", better: "lower" },
  { key: "arrived_in_window_veh", label: "Arrived", better: "higher" },
  { key: "blocked_at_horizon_veh", label: "Blocked at end", better: "lower" },
  { key: "trapped_by_fire_at_horizon_veh", label: "Trapped by fire", better: "lower" },
  { key: "remaining_at_horizon_veh", label: "Still to arrive", better: "lower" },
];

function Delta({ value, better }: { value: number; better: "lower" | "higher" }) {
  const rounded = Math.round(value);
  if (rounded === 0) return <span className="lc-dim">0</span>;
  const good = better === "lower" ? rounded < 0 : rounded > 0;
  return (
    <span className={good ? "lc-delta--better" : "lc-delta--worse"}>
      {rounded > 0 ? "+" : "−"}
      {nf(Math.abs(rounded))}
    </span>
  );
}

export function controllerLabel(controller: ControllerInfo | undefined): string | null {
  if (!controller) return null;
  const name = controller.id === "twin" ? "Twin controller" : controller.id === "rule" ? "Rule planner" : controller.id;
  return controller.fallback ? `${name} (${controller.fallback.replace(/_/g, " ")})` : name;
}

/** One line stating a regression against no new actions (icon + text, never color alone). */
function worseLine(twin: Evidence, metrics: TwinMetrics): string {
  return metrics.trapped_by_fire_at_horizon_veh > twin.baseline.metrics.trapped_by_fire_at_horizon_veh
    ? "Twin: more vehicles trapped by fire than no action"
    : "Twin: worse than no action";
}

/** Baseline (no new actions) vs the chosen set from the proposal's twin what-if. All simulated. */
export default function TwinEvidenceView({ twin }: { twin: Evidence }) {
  const chosen = twin.candidates[twin.chosen];
  if (!chosen?.metrics || chosen.cost === null) return null;
  const value = (m: TwinMetrics, cost: number, key: (typeof ROWS)[number]["key"]) => (key === "cost" ? cost : m[key]);
  const worse = twin.worse_than_baseline ? (
    <p className="lc-error" role="note">
      <span aria-hidden="true">⚠ </span>
      {worseLine(twin, chosen.metrics)}
    </p>
  ) : null;
  if (twin.no_signal) {
    const tieOnly = Math.abs(chosen.cost - twin.baseline.cost) >= twin.objective.min_gain_veh_min;
    return (
      <figure className="lc-ev" title={`Simulated ${twin.horizon_min} min what-if`}>
        {worse ?? (
          <figcaption>
            <span className="lc-chip lc-chip--simulated">Simulated</span>{" "}
            {tieOnly
              ? `Twin: no measurable difference between sets in ${twin.horizon_min} min · ${chosen.cost < twin.baseline.cost ? "−" : "+"}${nf(Math.abs(chosen.cost - twin.baseline.cost))} veh-min vs no action`
              : `Twin: no measurable difference in ${twin.horizon_min} min`}
          </figcaption>
        )}
      </figure>
    );
  }
  return (
    <figure className="lc-ev">
      <figcaption>
        <span className="lc-chip lc-chip--simulated">Simulated</span> {twin.horizon_min} min what-if
        {twin.fire_ahead === "frozen" ? ", fire held" : ""}
      </figcaption>
      {worse}
      <table className="lc-ev-table">
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col">No action</th>
            <th scope="col" title={chosen.label}>
              Proposed
            </th>
            <th scope="col">Δ</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => {
            const base = value(twin.baseline.metrics, twin.baseline.cost, row.key);
            const next = value(chosen.metrics!, chosen.cost!, row.key);
            return (
              <tr key={row.key}>
                <th scope="row">{row.label}</th>
                <td>{nf(base)}</td>
                <td>{nf(next)}</td>
                <td>
                  <Delta value={next - base} better={row.better} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {twin.candidates.length > 1 ? (
        <details className="lc-details">
          <summary>{twin.candidates.length} sets scored</summary>
          <ol className="lc-ev-sets">
            {twin.candidates.map((c, i) => (
              <li key={i} className={i === twin.chosen ? "lc-ev-chosen" : undefined}>
                <span>{c.label}</span>
                <span className="lc-mono">
                  {c.valid && c.cost !== null ? nf(c.cost) : "invalid"}
                  {i === twin.chosen ? " · chosen" : ""}
                </span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </figure>
  );
}
