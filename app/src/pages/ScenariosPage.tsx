import { useState, type FormEvent } from "react";
import IncidentSummary from "./IncidentSummary";
import {
  Button,
  DraftNotice,
  EmptyResult,
  Facts,
  Field,
  LinkButton,
  Panel,
  Tag,
  WorkspacePage,
} from "./WorkspaceUI";

const templates = [
  {
    name: "Wildfire baseline",
    detail: "Establish shared weather and ignition assumptions.",
    wind: "10",
    direction: "270",
  },
  {
    name: "Wind shift",
    detail: "Explore a different wind direction against the baseline.",
    wind: "20",
    direction: "180",
  },
  {
    name: "Calm conditions",
    detail: "Start with no wind in the illustrative fire model.",
    wind: "0",
    direction: "0",
  },
];

export default function ScenariosPage() {
  const [name, setName] = useState("Wildfire baseline");
  const [wind, setWind] = useState("10");
  const [direction, setDirection] = useState("270");
  const [notes, setNotes] = useState("");
  const [review, setReview] = useState(false);

  function reviewDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setReview(true);
  }

  return (
    <WorkspacePage
      title="Scenarios"
      description="Define the starting point. Keep every assumption in view."
      action={<LinkButton href="/fire">Open fire experiment ↗</LinkButton>}
    >
      <IncidentSummary
        title="Real fire inputs in the replays"
        eyebrow="Historical starting conditions"
        layers={["fire_perimeters", "fire_observations", "fire_simulated"]}
        intro="Replays start from recorded perimeters and observations, plus a simulated front fitted to them. The draft builder below uses illustrative assumptions instead."
      />
      <DraftNotice />
      <div className="ui-split">
        <Panel
          title="Build a scenario"
          eyebrow="01 / Starting conditions"
          aside={<Tag tone="warning">Unsaved draft</Tag>}
        >
          <form onSubmit={reviewDraft} onChange={() => setReview(false)}>
            <div className="ui-fields">
              <Field label="Scenario name">
                <input
                  required
                  maxLength={100}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field label="Study area">
                <select defaultValue="sf">
                  <option value="sf">San Francisco · demo map</option>
                </select>
              </Field>
              <Field label="Wind speed (mph)">
                <input
                  type="number"
                  required
                  min="0"
                  max="40"
                  step="1"
                  value={wind}
                  onChange={(event) => setWind(event.target.value)}
                />
              </Field>
              <Field label="Wind from">
                <select value={direction} onChange={(event) => setDirection(event.target.value)}>
                  {[
                    [0, "North"],
                    [45, "Northeast"],
                    [90, "East"],
                    [135, "Southeast"],
                    [180, "South"],
                    [225, "Southwest"],
                    [270, "West"],
                    [315, "Northwest"],
                  ].map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="ui-inset">
              <strong>Ignition point</strong>
              <p>
                Choose a location on the map in WGS84 latitude / longitude. This draft is not
                transferred to the map yet.
              </p>
              <a className="ui-text-link" href="/fire">
                Choose on map →
              </a>
            </div>
            <Field label="Assumptions & notes">
              <textarea
                rows={3}
                maxLength={2000}
                placeholder="What are you assuming about conditions?"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </Field>
            <div className="ui-actions">
              <Button type="submit">Review draft</Button>
              <span>Local preview only</span>
            </div>
          </form>
          {review && (
            <div className="ui-inset" role="status">
              <strong>{name.trim() || "Untitled draft"}</strong>
              <p>
                User assumptions: {wind} mph wind from {direction}° clockwise from north. Horizon:
                120 minutes; step: 15 minutes. {notes}
              </p>
              <p>Not saved or run. Ignition selection is still required on the map.</p>
            </div>
          )}
        </Panel>
        <div className="ui-stack">
          <Panel title="Start from a template" eyebrow="Sample assumptions">
            <div className="ui-list">
              {templates.map((template) => (
                <button
                  className="ws-template-option"
                  key={template.name}
                  type="button"
                  onClick={() => {
                    setName(template.name);
                    setWind(template.wind);
                    setDirection(template.direction);
                    setNotes("");
                    setReview(false);
                  }}
                >
                  <span>
                    <strong>{template.name}</strong>
                    <small>{template.detail}</small>
                  </span>
                  <span aria-hidden="true">↗</span>
                </button>
              ))}
            </div>
          </Panel>
          <Panel title="Run record" eyebrow="Reproducibility">
            <Facts
              items={[
                { label: "Model", value: "Illustrative fire spread" },
                { label: "Time step / horizon", value: "15 min / 120 min" },
                { label: "Randomness", value: "None in current model" },
                { label: "Source timestamps", value: "No observed inputs" },
                { label: "Run ID & model version", value: "Awaiting a run" },
              ]}
            />
          </Panel>
        </div>
      </div>
      <Panel title="Saved scenarios" aside={<Tag>Persistence not connected</Tag>}>
        <EmptyResult title="Your scenario library starts here">
          Saved inputs, model versions, source timestamps, and run history will appear here once
          scenario storage is connected.
        </EmptyResult>
      </Panel>
    </WorkspacePage>
  );
}
