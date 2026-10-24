import { useMemo } from "react";
import { METRIC_INFO, deltaVerdict, formatDelta, formatValue, type Variant, type VariantIndex } from "./compare";
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
        fixture demand as the baseline run. They are planning experiments, not history. Fire perimeters, roads and
        damage shown on the map are unchanged.
      </p>

      <fieldset className="rp-variants">
        <legend className="rp-section-title">What if…</legend>
        <label className="rp-variant">
          <input type="radio" name="rp-variant" checked={selectedId === null} onChange={() => onSelect(null)} />
          <span>
            <strong>Baseline run</strong>
            <small>The replay as modelled, with no changes.</small>
          </span>
        </label>
        {index.variants.map((v) => (
          <label key={v.id} className="rp-variant">
            <input type="radio" name="rp-variant" checked={selectedId === v.id} onChange={() => onSelect(v.id)} />
            <span>
              <strong>{v.title}</strong>
              <small>{v.question}</small>
            </span>
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
            <p className="rp-rule">One seed and fixture demand: treat small differences as noise, not as significant.</p>
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
