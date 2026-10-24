import { useState } from "react";
import { DraftNotice, EmptyResult, Field, Panel, Tag, WorkspacePage } from "./WorkspaceUI";

export default function ComparisonPage() {
  const [candidate, setCandidate] = useState("Scheduled departures");
  return (
    <WorkspacePage
      title="Strategy comparison"
      description="Change a strategy. Compare outcomes against the same starting conditions."
      section="Analysis"
    >
      <DraftNotice />
      <div className="ui-columns">
        <Panel title="Baseline" eyebrow="Strategy A" aside={<Tag>Reference</Tag>}>
          <Field label="Departure strategy">
            <select defaultValue="Simultaneous departures">
              <option>Simultaneous departures</option>
            </select>
          </Field>
          <dl className="ui-facts">
            <div>
              <dt>Scenario snapshot</dt>
              <dd>Not selected</dd>
            </div>
            <div>
              <dt>Completed run</dt>
              <dd>None available</dd>
            </div>
          </dl>
        </Panel>
        <Panel
          title="Alternative"
          eyebrow="Strategy B"
          aside={<Tag tone="green">Candidate draft</Tag>}
        >
          <Field label="Candidate strategy">
            <select value={candidate} onChange={(event) => setCandidate(event.target.value)}>
              <option>Scheduled departures</option>
              <option>Alternative shelter allocation</option>
              <option>Alternative route assignment</option>
            </select>
          </Field>
          <dl className="ui-facts">
            <div>
              <dt>Intentional change</dt>
              <dd>{candidate}</dd>
            </div>
            <div>
              <dt>Completed run</dt>
              <dd>None available</dd>
            </div>
          </dl>
        </Panel>
      </div>
      <Panel
        title="Outcome comparison"
        eyebrow="Computed results"
        aside={<Tag>Awaiting compatible runs</Tag>}
      >
        <div className="ui-table-scroll">
          <table className="ui-table comparison-table">
            <caption>
              Values remain unavailable until both strategies have computed results.
            </caption>
            <thead>
              <tr>
                <th scope="col">Measure</th>
                <th scope="col">Baseline</th>
                <th scope="col">Alternative</th>
                <th scope="col">Difference</th>
              </tr>
            </thead>
            <tbody>
              {[
                "Clearance time (min)",
                "Total vehicle delay (vehicle-min)",
                "People reaching a shelter",
                "People remaining / unreachable",
                "People exposed to modeled hazard",
                "Shelters at capacity",
              ].map((metric) => (
                <tr key={metric}>
                  <th scope="row">{metric}</th>
                  <td>—</td>
                  <td>—</td>
                  <td>Pending</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <div className="ui-columns">
        <Panel title="Comparison requirements">
          <ul className="ui-checklist">
            <li>Same population and geographic network snapshot</li>
            <li>Same ignition, weather, and source timestamps</li>
            <li>Same model versions, time step, horizon, and seed</li>
            <li>Explicit record of changed strategy assumptions</li>
          </ul>
          <p className="ui-help">Compatibility has not been checked; no runs are loaded.</p>
        </Panel>
        <Panel title="Trade-offs & explanation">
          <EmptyResult title="No preferred strategy yet">
            Model-backed differences and their limitations belong here. No ranking or confidence
            score is available before simulation.
          </EmptyResult>
          <a className="ui-text-link" href="/evacuation">
            Configure evacuation assumptions →
          </a>
        </Panel>
      </div>
    </WorkspacePage>
  );
}
