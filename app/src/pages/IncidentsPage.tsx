import { useState } from "react";
import { DataState, EmptyResult, Field, Metric, Panel, Tag, WorkspacePage } from "./WorkspaceUI";
import {
  CAMP_ID,
  INCIDENTS_URL,
  formatDate,
  layerLabel,
  orderedLayers,
  parseIncidents,
  replayHref,
  useJson,
  type Incident,
} from "./workspaceData";

function IncidentCard({ incident }: { incident: Incident }) {
  const layers = orderedLayers(incident.layerStatus);
  const clock = incident.clock;
  return (
    <article className="incident-card" aria-labelledby={`incident-${incident.id}`}>
      <div>
        <h3 id={`incident-${incident.id}`}>{incident.name}</h3>
        <p>{incident.place}</p>
      </div>
      <dl>
        <dt>Date</dt>
        <dd>{formatDate(incident.date)}</dd>
        <dt>Time zone</dt>
        <dd>{incident.timezone}</dd>
        {clock && (
          <>
            <dt>Replay clock</dt>
            <dd>
              {clock.start.replace("T", " ").replace(":00Z", "")} to{" "}
              {clock.end.replace("T", " ").replace(":00Z", "")} UTC, {clock.stepSeconds} s step
            </dd>
          </>
        )}
        {incident.packageVersion && (
          <>
            <dt>Data package</dt>
            <dd>{incident.packageVersion}</dd>
          </>
        )}
      </dl>
      <div>
        <p className="ui-help" id={`layers-${incident.id}`}>
          Data layers in this replay
        </p>
        <ul className="chip-list" aria-labelledby={`layers-${incident.id}`}>
          {layers.map(([key, status]) => (
            <li key={key}>
              <Tag
                tone={status === "present" ? "green" : status === "missing" ? "amber" : "neutral"}
              >
                {layerLabel(key)}: {status}
              </Tag>
            </li>
          ))}
        </ul>
      </div>
      <div className="card-actions">
        <a className="ui-button" href={replayHref(incident.id)}>
          Open replay →
        </a>
        {incident.id === CAMP_ID && (
          <a className="ui-button ui-button-light" href="/simulate">
            Agent simulation →
          </a>
        )}
      </div>
    </article>
  );
}

function IncidentLibrary() {
  const load = useJson(INCIDENTS_URL, parseIncidents);
  if (load.status !== "ready") {
    return (
      <Panel title="Historical incidents" eyebrow="Replay library">
        <DataState load={load} what="incidents index" path={INCIDENTS_URL} />
      </Panel>
    );
  }
  const incidents = load.data;
  if (incidents.length === 0) {
    return (
      <Panel title="Historical incidents" eyebrow="Replay library">
        <EmptyResult title="No incidents listed">
          <code>{INCIDENTS_URL}</code> has no incidents. Generate a replay bundle to add one.
        </EmptyResult>
      </Panel>
    );
  }
  const missing = incidents.reduce(
    (total, i) => total + Object.values(i.layerStatus).filter((s) => s === "missing").length,
    0,
  );
  return (
    <>
      <div className="ui-metrics">
        <Metric
          label="Historical incidents"
          value={String(incidents.length)}
          detail="Listed in the replay index"
        />
        <Metric
          label="Layers missing"
          value={String(missing)}
          detail="Across all incidents; a missing layer is not shown on that replay"
        />
        <Metric
          label="Live sources"
          value="0"
          detail="Ingestion not configured; replays are historical"
        />
      </div>
      <section className="incident-grid" aria-label="Historical incidents">
        {incidents.map((incident) => (
          <IncidentCard key={incident.id} incident={incident} />
        ))}
      </section>
    </>
  );
}

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
        <strong>Historical data only</strong> Replays use archived fire, road and order records.
        This workspace is not monitoring live incidents; the review example further down is
        synthetic.
      </p>
      <IncidentLibrary />
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
