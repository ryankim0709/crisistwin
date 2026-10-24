import {
  DataState,
  DeltaCell,
  EmptyResult,
  EvidenceTag,
  Metric,
  Panel,
  Tag,
  WorkspacePage,
} from "./WorkspaceUI";
import {
  ARRIVED_BY_1800,
  CAMP_ID,
  INCIDENTS_URL,
  OUTCOME_METRICS,
  STRESS_URL,
  clockLabel,
  fmt,
  fmtDelta,
  parseIncidents,
  parseStress,
  replayHref,
  useJson,
  type StressDoc,
  type StressRun,
} from "./workspaceData";

const MAX_EXIT_SHIFTS = 3;

const MODE_LABELS: Record<string, string> = {
  dry_run: "Dry run: fixed disruption list, no AI agent",
  agent: "AI agent proposed the disruptions",
};

function RunRow({ run }: { run: StressRun }) {
  const shifts = run.exitShifts.slice(0, MAX_EXIT_SHIFTS);
  return (
    <tr>
      <th scope="row">
        <strong>{run.label}</strong>
        <div className="ui-help">
          {run.runId}
          {run.rationale ? ` · ${run.rationale}` : ""}
        </div>
        <details className="variant-notes">
          <summary>What changed and where traffic moved</summary>
          <ul>
            {run.changes.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {shifts.length > 0 && (
            <>
              <p className="ui-help">Largest exit shifts (vehicles, change from baseline)</p>
              <ul>
                {shifts.map((s) => (
                  <li key={s.name}>
                    {s.name}: {fmt(s.baseline)} to {fmt(s.variant)} ({fmtDelta(s.delta)})
                  </li>
                ))}
              </ul>
            </>
          )}
        </details>
      </th>
      {OUTCOME_METRICS.map((spec) => (
        <td className="num" key={spec.key}>
          <DeltaCell metric={run.metrics[spec.key]} direction={spec.direction} />
        </td>
      ))}
      <td className="num">
        {run.zoneRiskChangedCount === null ? "n/a" : fmt(run.zoneRiskChangedCount)}
      </td>
      <td>
        <EvidenceTag kind={run.evidenceClass} />
      </td>
    </tr>
  );
}

function Results({ doc }: { doc: StressDoc }) {
  const incidents = useJson(INCIDENTS_URL, parseIncidents);
  const camp =
    incidents.status === "ready" ? incidents.data.find((i) => i.id === CAMP_ID) : undefined;
  const when = (camp && clockLabel(ARRIVED_BY_1800.key, camp.date, camp.timezone)) ?? "18:00 UTC";
  const { budget } = doc;
  return (
    <>
      <div className="ui-metrics">
        <Metric
          label="Runs completed"
          value={fmt(budget.runsUsed ?? doc.runs.length)}
          detail={
            budget.maxRuns === null
              ? "Run budget not recorded"
              : `Budget: up to ${fmt(budget.maxRuns)} runs`
          }
        />
        <Metric
          label="Run mode"
          value={doc.mode === "dry_run" ? "Dry run" : doc.mode === "agent" ? "AI agent" : doc.mode}
          detail={MODE_LABELS[doc.mode] ?? "Mode as recorded in the file"}
        />
        <Metric
          label={`Baseline: vehicles out by ${when}`}
          value={fmt(doc.baselineMetrics[ARRIVED_BY_1800.key] ?? null)}
          detail="Simulated; every run is compared with this"
        />
      </div>
      <Panel
        title="Disruption runs against the baseline"
        eyebrow="Computed results"
        aside={<Tag tone="amber">Counterfactual, not history</Tag>}
      >
        {doc.runs.length === 0 ? (
          <EmptyResult title="No stress runs recorded">
            The file lists no completed runs.
          </EmptyResult>
        ) : (
          <div className="ui-table-scroll">
            <table className="ui-table comparison-table">
              <caption>
                Each cell is the disrupted value, then its change from the baseline. Higher is
                better for vehicles out ({when}); lower is better for exposure and blocked vehicles.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Disruption</th>
                  {OUTCOME_METRICS.map((spec) => (
                    <th scope="col" className="num" key={spec.key}>
                      {spec.key === ARRIVED_BY_1800.key ? `${spec.label} ${when}` : spec.label} (
                      {spec.unit})
                    </th>
                  ))}
                  <th scope="col" className="num">
                    Zones with changed risk
                  </th>
                  <th scope="col">Evidence</th>
                </tr>
              </thead>
              <tbody>
                {doc.runs.map((run) => (
                  <RunRow key={run.runId} run={run} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {doc.rejected.length > 0 && (
          <ul className="ui-checklist">
            {doc.rejected.map((line) => (
              <li key={line}>Rejected before running: {line}</li>
            ))}
          </ul>
        )}
      </Panel>
      {doc.findings && (
        <Panel title="AI findings" aside={<EvidenceTag kind="ai_explanation" />}>
          <p className="ui-notice">
            <strong>AI explanation</strong> Written by {doc.findings.model ?? "an AI model"} from
            the numbers above, not computed.
          </p>
          <pre className="ai-findings">{doc.findings.markdown}</pre>
        </Panel>
      )}
      <div className="ui-columns">
        <Panel title="Where this comes from" eyebrow="Reproducibility">
          <dl className="ui-facts">
            <div>
              <dt>Findings</dt>
              <dd>
                {doc.findings
                  ? "AI explanation present"
                  : doc.mode === "dry_run"
                    ? "None: a dry run does not call an AI model"
                    : "None recorded"}
              </dd>
            </div>
            {budget.stopped && (
              <div>
                <dt>Stopped because</dt>
                <dd>{budget.stopped}</dd>
              </div>
            )}
          </dl>
          <div className="entry-links">
            <a className="ui-text-link" href="/simulate">
              Agent simulation →
            </a>
            <a className="ui-text-link" href={replayHref(CAMP_ID)}>
              Camp Fire replay →
            </a>
            <a className="ui-text-link" href="/comparison">
              Strategy comparison →
            </a>
          </div>
        </Panel>
        <Panel title="Limitations">
          {doc.limitations.length > 0 ? (
            <ul className="ui-checklist">
              {doc.limitations.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : (
            <EmptyResult title="No limitations recorded">
              The file lists none. Results are still a single-seed experiment.
            </EmptyResult>
          )}
        </Panel>
      </div>
    </>
  );
}

export default function StressTestsPage() {
  const load = useJson(STRESS_URL, parseStress);
  return (
    <WorkspacePage
      title="Stress testing"
      description="Where does the 2018 Camp Fire evacuation plan break? Each run disrupts the baseline once."
    >
      {load.status === "ready" ? (
        <Results doc={load.data} />
      ) : (
        <Panel title="Stress-test runs" eyebrow="Computed results">
          <DataState load={load} what="stress-test results" path={STRESS_URL} />
        </Panel>
      )}
    </WorkspacePage>
  );
}
