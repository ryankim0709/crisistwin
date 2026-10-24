import { DataState, EmptyResult, Panel, Tag } from "./WorkspaceUI";
import {
  INCIDENTS_URL,
  formatDate,
  layerLabel,
  parseIncidents,
  replayHref,
  useJson,
} from "./workspaceData";

/** Which replay layers exist per incident, read from the index only (no bundle download). */
export default function IncidentSummary({
  title,
  eyebrow,
  layers,
  intro,
}: {
  title: string;
  eyebrow: string;
  layers: string[];
  intro: string;
}) {
  const load = useJson(INCIDENTS_URL, parseIncidents);
  return (
    <Panel title={title} eyebrow={eyebrow} aside={<Tag tone="success">Historical replays</Tag>}>
      <p className="ui-help">{intro}</p>
      {load.status !== "ready" ? (
        <DataState load={load} what="incidents index" path={INCIDENTS_URL} />
      ) : load.data.length === 0 ? (
        <EmptyResult title="No incidents listed">The replay index is empty.</EmptyResult>
      ) : (
        <div className="ui-list">
          {load.data.map((incident) => (
            <div className="ui-row" key={incident.id}>
              <div>
                <strong>{incident.name}</strong>
                <p>
                  {incident.place} · {formatDate(incident.date)}
                </p>
                <ul className="ui-chip-list">
                  {layers.map((key) => {
                    const status = incident.layerStatus[key] ?? "not listed";
                    return (
                      <li key={key}>
                        <Tag tone={status === "present" ? "success" : "warning"}>
                          {layerLabel(key)}: {status}
                        </Tag>
                      </li>
                    );
                  })}
                </ul>
              </div>
              <a className="ui-text-link" href={replayHref(incident.id)}>
                Open replay →
              </a>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
