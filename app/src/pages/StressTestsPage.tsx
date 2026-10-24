import { useState } from "react";
import { DraftNotice, EmptyResult, Field, Panel, Tag, WorkspacePage } from "./WorkspaceUI";

const disruptions = [
  { name: "Road failure", detail: "Remove a road segment and inspect network reachability." },
  { name: "Wind shift", detail: "Vary wind assumptions and recompute modeled hazard." },
  { name: "Departure delay", detail: "Shift a neighborhood’s departure window later." },
  { name: "Shelter capacity loss", detail: "Reduce available capacity and inspect unmet demand." },
];

export default function StressTestsPage() {
  const [selected, setSelected] = useState(["Road failure", "Wind shift"]);
  const [budget, setBudget] = useState("10");
  return (
    <WorkspacePage
      title="Stress testing"
      description="Ask where a plan breaks, then investigate the evidence."
      section="Analysis"
    >
      <DraftNotice />
      <div className="ui-split">
        <Panel
          title="Configure an investigation"
          eyebrow="01 / Perturbations"
          aside={<Tag tone="amber">Draft configuration</Tag>}
        >
          <Field label="Baseline run">
            <select disabled defaultValue="">
              <option value="">No completed evacuation runs available</option>
            </select>
          </Field>
          <fieldset className="ui-fieldset">
            <legend>Conditions to vary</legend>
            {disruptions.map((item) => (
              <label className="disruption-option" key={item.name}>
                <input
                  type="checkbox"
                  checked={selected.includes(item.name)}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, item.name]
                        : current.filter((name) => name !== item.name),
                    )
                  }
                />
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.detail}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="ui-fields">
            <Field label="Maximum candidate runs">
              <input
                type="number"
                min="1"
                max="20"
                step="1"
                value={budget}
                onChange={(event) => setBudget(event.target.value)}
              />
            </Field>
            <Field label="Primary measure">
              <select defaultValue="People unable to reach shelter">
                <option>People unable to reach shelter</option>
                <option>Clearance time</option>
                <option>Modeled hazard exposure</option>
              </select>
            </Field>
          </div>
          <div className="ui-actions">
            <button type="button" disabled>
              Start investigation
            </button>
            <span>{selected.length} disruption types selected</span>
          </div>
          <p className="ui-help">
            Requires a completed baseline, a simulation runner, and validated perturbation ranges.
            No background jobs are running.
          </p>
        </Panel>
        <div className="ui-stack">
          <Panel title="Investigation progress" eyebrow="02 / Execution">
            <ol className="ui-steps">
              <li>
                <strong>Load baseline</strong>
                <span>Waiting for a completed run</span>
              </li>
              <li>
                <strong>Generate bounded candidates</strong>
                <span>Not started</span>
              </li>
              <li>
                <strong>Simulate & compare</strong>
                <span>Not started</span>
              </li>
              <li>
                <strong>Review evidence</strong>
                <span>No findings available</span>
              </li>
            </ol>
          </Panel>
          <Panel title="Questions to investigate">
            <ul className="ui-checklist">
              <li>Does a closure isolate any modeled population?</li>
              <li>Where does shelter capacity become insufficient?</li>
              <li>Which missing observation could change the preferred plan?</li>
            </ul>
            <p className="ui-help">
              Example investigation questions, not discovered vulnerabilities.
            </p>
          </Panel>
        </div>
      </div>
      <Panel
        title="Findings & sensitivity"
        eyebrow="03 / Results"
        aside={<Tag>No computed findings</Tag>}
      >
        <EmptyResult title="No stress tests run yet">
          Ranked vulnerabilities will include changed inputs, affected populations, metric
          differences, run IDs, and model limitations.
        </EmptyResult>
      </Panel>
    </WorkspacePage>
  );
}
