import { useState } from "react";
import IncidentSummary from "./IncidentSummary";
import { DraftNotice, EmptyResult, Field, Panel, Tag, WorkspacePage } from "./WorkspaceUI";

const initialZones = [
  { name: "Sample zone A", people: "600", vehicles: "200", departure: "0" },
  { name: "Sample zone B", people: "450", vehicles: "150", departure: "15" },
  { name: "Sample zone C", people: "300", vehicles: "100", departure: "30" },
];

export default function EvacuationPage() {
  const [zones, setZones] = useState(initialZones);
  const [strategy, setStrategy] = useState("waves");
  const [closed, setClosed] = useState(false);

  function updateZone(index: number, key: "people" | "vehicles" | "departure", value: string) {
    setZones((current) =>
      current.map((zone, row) => (row === index ? { ...zone, [key]: value } : zone)),
    );
  }

  return (
    <WorkspacePage
      title="Evacuation planning"
    >
      <IncidentSummary
        title="Real demand, orders and refuges in the replays"
        eyebrow="Historical evacuations"
        layers={["zones", "events", "destinations", "roads", "traffic"]}
        intro="Replays include zones with fixture demand, recorded orders and closures, refuges, and a simulated traffic run. The tables below are separate synthetic inputs."
      />
      <DraftNotice />
      <div className="ui-split">
        <Panel
          title="Population & departures"
          aside={<Tag tone="amber">Synthetic inputs</Tag>}
        >
          <Field label="Departure strategy">
            <select value={strategy} onChange={(event) => setStrategy(event.target.value)}>
              <option value="waves">Scheduled waves</option>
              <option value="simultaneous">Simultaneous departures</option>
            </select>
          </Field>
          <div className="ui-table-scroll">
            <table className="ui-table">
              <caption>
                Editable synthetic demand; minutes are relative to simulation start.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Origin</th>
                  <th scope="col">People</th>
                  <th scope="col">Vehicles</th>
                  <th scope="col">Depart (min)</th>
                </tr>
              </thead>
              <tbody>
                {zones.map((zone, index) => (
                  <tr key={zone.name}>
                    <th scope="row">{zone.name}</th>
                    {(["people", "vehicles", "departure"] as const).map((key) => (
                      <td key={key}>
                        <input
                          aria-label={`${zone.name} ${key === "departure" ? "departure minutes" : key}`}
                          type="number"
                          min="0"
                          max={key === "departure" ? "120" : "100000"}
                          step="1"
                          disabled={key === "departure" && strategy === "simultaneous"}
                          value={
                            key === "departure" && strategy === "simultaneous" ? "0" : zone[key]
                          }
                          onChange={(event) => updateZone(index, key, event.target.value)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel title="Shelter assumptions" aside={<Tag>Sample</Tag>}>
          <div className="ui-stack">
            {["Sample shelter A", "Sample shelter B"].map((name, index) => (
              <div className="ui-inset" key={name}>
                <strong>{name}</strong>
                <Field label="Capacity (people)">
                  <input
                    type="number"
                    min="0"
                    max="100000"
                    step="1"
                    defaultValue={index === 0 ? 800 : 600}
                  />
                </Field>
                <small>Location, accessibility, and availability unverified.</small>
              </div>
            ))}
          </div>
        </Panel>
      </div>
      <div className="ui-columns">
        <Panel title="Road availability">
          <div className="ui-row">
            <div>
              <strong>Sample connector A</strong>
              <p>Synthetic road · no geographic mapping</p>
            </div>
            <Tag tone={closed ? "amber" : "green"}>
              {closed ? "Assumed closed" : "Assumed open"}
            </Tag>
          </div>
          <label className="ui-check">
            <input
              type="checkbox"
              checked={closed}
              onChange={(event) => setClosed(event.target.checked)}
            />
            Close this connector in the draft
          </label>
          <Field label="Assumed road capacity (vehicles/hour)">
            <input type="number" min="0" max="10000" step="1" defaultValue="600" />
          </Field>
        </Panel>
        <Panel
          title="Plan results"
          aside={<Tag>Model not connected</Tag>}
        >
          <EmptyResult title="No results">Run a connected evacuation model to compute them.</EmptyResult>
          <button type="button" disabled>
            Run evacuation simulation
          </button>
        </Panel>
      </div>
    </WorkspacePage>
  );
}
