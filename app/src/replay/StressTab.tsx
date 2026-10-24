import { LoadingState, Notice } from "../ui";
import { useEffect, useState } from "react";
import { Markdown } from "./ai/markdown";
import {
  METRIC_INFO,
  deltaVerdict,
  fetchJson,
  formatDelta,
  formatValue,
  type MetricDelta,
} from "./compare";
import { EvidenceChip } from "./parts";
import { arr, isObj, obj, objOrEmpty, optNum, strList } from "./validate";

interface StressRun {
  id: string;
  label: string;
  rationale: string | null;
  changes: string[];
  metrics: Record<string, MetricDelta>;
}

interface StressResult {
  mode: string | null;
  runs: StressRun[];
  findings: string | null;
  limitations: string[];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Defensive parse: the stress-test file is optional and its shape may still change. */
function parseStress(data: unknown): StressResult {
  const s = obj(data, "stress");
  const runs = arr(s.runs ?? [], "runs").map((r, i): StressRun => {
    const run = objOrEmpty(r);
    const spec = objOrEmpty(run.requested_spec);
    const result = objOrEmpty(run.result);
    const metrics: Record<string, MetricDelta> = {};
    for (const [key, m] of Object.entries(objOrEmpty(result.metrics))) {
      const item = objOrEmpty(m);
      metrics[key] = {
        baseline: optNum(item.baseline, key),
        variant: optNum(item.variant, key),
        delta: optNum(item.delta, key),
      };
    }
    return {
      id: text(run.run_id) ?? text(run.id) ?? `run-${i + 1}`,
      label: text(spec.label) ?? text(run.label) ?? `Run ${i + 1}`,
      rationale: text(spec.rationale),
      changes: strList(run.changes, `runs[${i}].changes`),
      metrics,
    };
  });
  const findings = isObj(s.findings) ? text(objOrEmpty(s.findings).markdown) : text(s.findings);
  return { mode: text(s.mode), runs, findings, limitations: strList(s.limitations, "limitations") };
}

type Load =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "ready"; result: StressResult }
  | { status: "error"; message: string };

const HEADLINE_METRICS = [
  "arrived_by_1800z_veh",
  "peak_exposed_veh",
  "exposed_veh_min",
  "peak_blocked_veh",
];

export default function StressTab({ url }: { url: string }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    fetchJson(url, controller.signal)
      .then((data) => {
        if (!active) return;
        setLoad(
          data === null ? { status: "missing" } : { status: "ready", result: parseStress(data) },
        );
      })
      .catch((error: unknown) => {
        if (active && !(error instanceof DOMException && error.name === "AbortError")) {
          setLoad({
            status: "error",
            message: error instanceof Error ? error.message : "Could not load.",
          });
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [url]);

  if (load.status === "loading") {
    return <LoadingState>Loading stress test…</LoadingState>;
  }
  if (load.status === "missing")
    return <p className="rp-empty">No stress test has been run yet.</p>;
  if (load.status === "error")
    return <Notice tone="danger">Stress test unavailable: {load.message}</Notice>;

  const { result } = load;
  return (
    <div className="rp-tab">
      <Notice tone="info">
        <EvidenceChip value="simulated" /> Disruptions were proposed by an AI agent and run through
        the simulator. Every number below comes from simulator runs.
        {result.mode === "dry_run" && " This was a dry run (no AI findings)."}
      </Notice>

      {result.runs.length === 0 ? (
        <p className="rp-empty">The stress test has no runs.</p>
      ) : (
        result.runs.map((run) => (
          <section key={run.id} className="rp-stress-run" aria-label={run.label}>
            <h3 className="rp-row-main">{run.label}</h3>
            {run.rationale && <p className="rp-rule">Why: {run.rationale}</p>}
            {run.changes.length > 0 && (
              <ul className="rp-notes-list">
                {run.changes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            )}
            <table className="rp-table">
              <caption className="rp-sr">{run.label}: change from baseline</caption>
              <tbody>
                {HEADLINE_METRICS.filter((k) => run.metrics[k]).map((key) => {
                  const info = METRIC_INFO[key];
                  const m = run.metrics[key];
                  const verdict = deltaVerdict(m.delta, info.better);
                  return (
                    <tr key={key}>
                      <th scope="row">{info.label}</th>
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
          </section>
        ))
      )}

      <section aria-labelledby="rp-findings-title">
        <h3 id="rp-findings-title" className="rp-section-title">
          AI explanation — numbers come from simulator runs
        </h3>
        {result.findings ? (
          <div className="rp-findings">
            <Markdown source={result.findings} />
          </div>
        ) : (
          <p className="rp-empty">No AI findings in this file.</p>
        )}
      </section>

      {result.limitations.length > 0 && (
        <details className="rp-notes">
          <summary>Limitations</summary>
          <ul>
            {result.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
