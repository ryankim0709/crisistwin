import { useState } from "react";
import { EmptyResult, Field, Metric, Panel, Tag, WorkspacePage } from "./WorkspaceUI";

export default function IncidentsPage() {
  const [kind, setKind] = useState("All report types");
  const [query, setQuery] = useState("");
  const [example, setExample] = useState(false);
  return (
    <WorkspacePage
      title="Incident intelligence"
      description="Inspect the evidence before it becomes a scenario assumption."
      section="Analysis"
    >
      <p className="ui-notice">
        <strong>No sources connected</strong> This workspace is not monitoring incidents. The
        optional review example below is synthetic.
      </p>
      <div className="ui-metrics">
        <Metric label="Connected sources" value="0" detail="Ingestion not configured" />
        <Metric label="Reports to review" value="—" detail="No reports have been fetched" />
        <Metric label="Last retrieval" value="—" detail="No source timestamp available" />
      </div>
      <div className="ui-split">
        <Panel title="Report inbox" eyebrow="01 / Evidence" aside={<Tag>Disconnected</Tag>}>
          <div className="ui-fields">
            <Field label="Search reports">
              <input
                type="search"
                value={query}
                placeholder="Location or keyword"
                onChange={(event) => setQuery(event.target.value)}
              />
            </Field>
            <Field label="Report type">
              <select value={kind} onChange={(event) => setKind(event.target.value)}>
                <option>All report types</option>
                <option>Fire activity</option>
                <option>Road closure</option>
                <option>Shelter availability</option>
              </select>
            </Field>
          </div>
          <EmptyResult
            title={
              query || kind !== "All report types"
                ? "No reports match these filters"
                : "No public reports fetched"
            }
          >
            Connect a public source to review original links, observation times, retrieval times,
            and conflicting evidence. An empty inbox does not mean there are no incidents.
          </EmptyResult>
          <button
            type="button"
            className="ui-secondary"
            aria-expanded={example}
            aria-controls="incident-review"
            onClick={() => setExample((value) => !value)}
          >
            {example ? "Hide review example" : "Explore a synthetic review example"}
          </button>
        </Panel>
        <Panel
          title="Evidence review"
          eyebrow="02 / Human review"
          aside={<Tag tone="amber">{example ? "Synthetic example" : "No selection"}</Tag>}
        >
          <div id="incident-review">
            {example ? (
              <>
                <h3>Sample connector reported closed</h3>
                <p className="ui-help">
                  Fictional report for layout preview. No actual location or public source is
                  associated with this example.
                </p>
                <dl className="ui-facts">
                  <div>
                    <dt>Original source</dt>
                    <dd>None · synthetic fixture</dd>
                  </div>
                  <div>
                    <dt>Observed at (UTC)</dt>
                    <dd>Unavailable</dd>
                  </div>
                  <div>
                    <dt>Retrieved at (UTC)</dt>
                    <dd>Not fetched</dd>
                  </div>
                  <div>
                    <dt>Verification</dt>
                    <dd>Unverified example</dd>
                  </div>
                  <div>
                    <dt>Network match</dt>
                    <dd>Unresolved</dd>
                  </div>
                </dl>
                <div className="ui-inset">
                  <strong>Proposed hypothetical change</strong>
                  <p>
                    Close a matched road segment in a new scenario after evidence review. The
                    original baseline would remain available.
                  </p>
                </div>
                <button type="button" disabled>
                  Create scenario from report
                </button>
                <p className="ui-help">
                  Requires source evidence, a validated road match, and scenario storage.
                </p>
              </>
            ) : (
              <EmptyResult title="Select a report to inspect">
                Source provenance, freshness, contradictions, and proposed scenario changes will be
                shown here.
              </EmptyResult>
            )}
          </div>
        </Panel>
      </div>
      <Panel title="Source connections" eyebrow="Ingestion status">
        <div className="ui-columns">
          {["Public incident bulletins", "Road status reports", "Shelter availability"].map(
            (source) => (
              <div className="ui-inset" key={source}>
                <strong>{source}</strong>
                <p>Provider not configured</p>
                <Tag>Not connected</Tag>
              </div>
            ),
          )}
        </div>
      </Panel>
    </WorkspacePage>
  );
}
