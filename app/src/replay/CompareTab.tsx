import { useMemo } from "react";
import {
  METRIC_INFO,
  VARIANT_CAVEATS,
  pctChange,
  deltaVerdict,
  formatDelta,
  formatValue,
  type MetricDelta,
  type Variant,
  type VariantIndex,
} from "./compare";
import { EvidenceChip } from "./parts";
import { RiskChip } from "./ResponderTab";
import type { ReplayModel } from "./types";

export type VariantLoad =
  | { status: "idle" }
  | { status: "loading"; id: string }
  | { status: "ready"; variant: Variant }
  | { status: "error"; id: string; message: string };

export interface CompareTabProps {
  baseline: ReplayModel;
  index: VariantIndex;
  load: VariantLoad;
  showVariant: boolean;
  onSelect: (id: string | null) => void;
  onShowVariant: (show: boolean) => void;
}

/** "What if…" panel: pick a precomputed counterfactual and compare it with the baseline. */
export default function CompareTab({ baseline, index, load, showVariant, onSelect, onShowVariant }: CompareTabProps) {
  const zoneNames = useMemo(() => new Map((baseline.zones?.items ?? []).map((z) => [z.id, z.name])), [baseline]);
  const selectedId =
    load.status === "ready" ? load.variant.id : load.status === "loading" || load.status === "error" ? load.id : null;

  return (
    <div className="rp-tab">
      <p className="rp-disclaimer rp-disclaimer--top" role="note">
        <EvidenceChip value="simulated" /> What-if variants are simulated counterfactuals on the same seed, network and
        demand
        {index.demandTotalVeh != null && <> ({index.demandTotalVeh.toLocaleString("en-US")} vehicles)</>} as the
        baseline run. They are planning experiments, not history. Fire perimeters, roads and damage shown on the map
        are unchanged.
      </p>

      {load.status === "ready" && (
        <HeadlineDelta id={load.variant.id} metrics={load.variant.metrics} title={load.variant.title} />
      )}

      <fieldset className="rp-variants">
        <legend className="rp-section-title">What if…</legend>
        <label className="rp-variant">
          <input type="radio" name="rp-variant" checked={selectedId === null} onChange={() => onSelect(null)} />
          <span>
            <strong>Baseline run</strong>
          </span>
        </label>
        {index.variants.map((v) => (
          <label key={v.id} className="rp-variant">
            <input type="radio" name="rp-variant" checked={selectedId === v.id} onChange={() => onSelect(v.id)} />
            <span>
              <strong>{v.title}</strong>
              <small>{v.question}</small>
            </span>
            <ExposureBadge id={v.id} delta={v.headline.total_exposed_veh_min} />
          </label>
        ))}
      </fieldset>
      {index.skipped.length > 0 && (
        <p className="rp-rule">
          Not available: {index.skipped.map((s) => `${s.title} (${s.reason})`).join("; ")}
        </p>
      )}

      {load.status === "loading" && (
        <p role="status" className="rp-pin-hint">
          <span className="rp-spinner" aria-hidden="true" /> Loading variant…
        </p>
      )}
      {load.status === "error" && (
        <p role="alert" className="rp-empty">
          This variant could not be loaded: {load.message}
        </p>
      )}

      {load.status === "ready" && (
        <>
          <div className="rp-speed rp-compare-toggle" role="group" aria-label="Traffic shown on the map">
            <button type="button" className="rp-speed-btn" aria-pressed={!showVariant} onClick={() => onShowVariant(false)}>
              Map: baseline
            </button>
            <button type="button" className="rp-speed-btn" aria-pressed={showVariant} onClick={() => onShowVariant(true)}>
              Map: what-if
            </button>
          </div>

          <section aria-labelledby="rp-changes-title">
            <h3 id="rp-changes-title" className="rp-section-title">
              What changed
            </h3>
            <ul className="rp-notes-list">
              {load.variant.changes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="rp-delta-title">
            <h3 id="rp-delta-title" className="rp-section-title">
              Difference from baseline (modelled)
            </h3>
            <div className="rp-table-wrap">
              <table className="rp-table">
                <caption className="rp-sr">Variant metrics against the baseline run</caption>
                <thead>
                  <tr>
                    <th scope="col">Metric</th>
                    <th scope="col">Baseline</th>
                    <th scope="col">What-if</th>
                    <th scope="col">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(load.variant.metrics).map(([key, m]) => {
                    const info = METRIC_INFO[key] ?? { label: key.replace(/_/g, " "), unit: "veh", better: "higher" };
                    const verdict = deltaVerdict(m.delta, info.better);
                    return (
                      <tr key={key}>
                        <th scope="row">{info.label}</th>
                        <td>{formatValue(m.baseline, info.unit)}</td>
                        <td>{formatValue(m.variant, info.unit)}</td>
                        <td className={`rp-delta rp-delta--${verdict}`}>
                          {formatDelta(m.delta, info.unit)}
                          <small>{verdict === "n/a" ? "not comparable" : verdict}</small>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="rp-rule">One seed: treat small differences as noise, not as significant.</p>
          </section>

          <section aria-labelledby="rp-risk-title">
            <h3 id="rp-risk-title" className="rp-section-title">
              Zone risk changes
            </h3>
            {load.variant.zoneRiskChanged.length === 0 ? (
              <p className="rp-empty">No zone changed risk level.</p>
            ) : (
              <ul className="rp-rows">
                {load.variant.zoneRiskChanged.map((z) => (
                  <li key={z.zoneId} className="rp-row-static rp-risk-change">
                    <span className="rp-row-main">{zoneNames.get(z.zoneId) ?? z.zoneId}</span>
                    <span className="rp-row-side">
                      <RiskChip level={z.baseline} /> → <RiskChip level={z.variant} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {load.variant.limitations.length > 0 && (
            <details className="rp-notes">
              <summary>Limitations of this variant</summary>
              <ul>
                {load.variant.limitations.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function signed(pct: number): string {
  return `${pct > 0 ? "+" : pct < 0 ? "−" : "±"}${Math.abs(pct)}%`;
}

export function CaveatChip({ id }: { id: string }) {
  const caveat = VARIANT_CAVEATS[id];
  if (!caveat) return null;
  return (
    <span className={`rp-caveat rp-caveat--${caveat.kind}`} title={caveat.text}>
      {caveat.label}
    </span>
  );
}

/** Combined exposure change (road + home) from the index, shown on each option before loading. */
function ExposureBadge({ id, delta }: { id: string; delta: MetricDelta | undefined }) {
  const pct = pctChange(delta);
  if (pct === null || !delta) return null;
  const caveat = VARIANT_CAVEATS[id];
  // A caveated result is not shown as an improvement.
  const verdict = caveat ? "n/a" : deltaVerdict(delta.delta, "lower");
  return (
    <span className={`rp-peak-badge rp-delta--${verdict}`} title="Change in total exposure, road + home (model)">
      {signed(pct)}
      <small>exposure (road + home)</small>
      <CaveatChip id={id} />
    </span>
  );
}

/** The first thing to read: combined exposure, then road and home separately, baseline vs what-if. */
function HeadlineDelta({ id, metrics, title }: { id: string; metrics: Record<string, MetricDelta>; title: string }) {
  const total = metrics.total_exposed_veh_min;
  const pct = pctChange(total);
  if (!total || pct === null) return null;
  const caveat = VARIANT_CAVEATS[id];
  const parts: [string, MetricDelta | undefined][] = [
    ["On roads", metrics.exposed_veh_min],
    ["At home, not yet left", metrics.exposed_at_origin_veh_min],
  ];
  const arrived = metrics.arrived_by_1800z_veh;
  return (
    <section className="rp-headline-delta" aria-labelledby="rp-headline-delta-title">
      <h3 id="rp-headline-delta-title" className="rp-section-title">
        {title}: exposure to fire, road + home <EvidenceChip value="simulated" />
      </h3>
      <p className="rp-headline-delta-nums">
        <span>
          <small>Change vs baseline</small>
          <strong className={`rp-delta--${caveat ? "n/a" : deltaVerdict(total.delta, "lower")}`}>{signed(pct)}</strong>
        </span>
        {caveat && <CaveatChip id={id} />}
      </p>
      <ul className="rp-headline-parts">
        {parts.map(([label, m]) => {
          const p = pctChange(m);
          if (!m || p === null) return null;
          const ratio = m.baseline && m.variant != null ? m.variant / m.baseline : null;
          return (
            <li key={label} className={`rp-delta--${deltaVerdict(m.delta, "lower")}`}>
              {label}: {signed(p)}
              {ratio !== null && ratio >= 2 && <> (×{ratio.toFixed(1)})</>}
            </li>
          );
        })}
        {arrived && arrived.baseline != null && arrived.variant != null && (
          <li className={`rp-delta--${deltaVerdict(arrived.delta, "higher")}`}>
            Out by 10:00 PST: {formatValue(arrived.baseline, "veh")} → {formatValue(arrived.variant, "veh")} vehicles
          </li>
        )}
      </ul>
      {caveat && <p className="rp-rule">{caveat.text}</p>}
      <p className="rp-rule">
        Relative comparison only: vehicle-minutes are dominated by stranded vehicles and are not a count of people.
      </p>
    </section>
  );
}
