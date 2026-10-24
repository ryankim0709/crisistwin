import {
  Button,
  DataState,
  EmptyResult,
  LinkButton,
  Metric,
  MetricGrid,
  Panel,
  Tag,
} from "./WorkspaceUI";
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

function IncidentCard({
  incident,
  selected,
  onSelect,
}: {
  incident: Incident;
  selected: boolean;
  onSelect: (incident: Incident) => void;
}) {
  const layers = orderedLayers(incident.layerStatus);
  const clock = incident.clock;
  return (
    <article className="ui-card ws-incident-card" aria-labelledby={`incident-${incident.id}`}>
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
        <ul className="ui-chip-list" aria-labelledby={`layers-${incident.id}`}>
          {layers.map(([key, status]) => (
            <li key={key}>
              <Tag
                tone={
                  status === "present" ? "success" : status === "missing" ? "warning" : "neutral"
                }
              >
                {layerLabel(key)}: {status}
              </Tag>
            </li>
          ))}
        </ul>
      </div>
      <div className="ws-card-actions">
        <Button
          variant={selected ? "primary" : "secondary"}
          aria-pressed={selected}
          onClick={() => onSelect(incident)}
        >
          {selected ? "Reviewing reports" : "Review reports"}
        </Button>
        <LinkButton variant="soft" href={replayHref(incident.id)}>Open replay →</LinkButton>
        {incident.id === CAMP_ID && (
          <LinkButton variant="soft" href="/simulate">
            Agent simulation →
          </LinkButton>
        )}
      </div>
    </article>
  );
}

/** Historical incidents from the replay index; picking one scopes the report review below. */
export default function IncidentLibrary({
  selectedId,
  onSelect,
}: {
  selectedId: string;
  onSelect: (incident: Incident) => void;
}) {
  const load = useJson(INCIDENTS_URL, parseIncidents);
  if (load.status !== "ready") {
    return (
      <Panel title="Historical incidents">
        <DataState load={load} what="incidents index" path={INCIDENTS_URL} />
      </Panel>
    );
  }
  const incidents = load.data;
  if (incidents.length === 0) {
    return (
      <Panel title="Historical incidents">
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
      <MetricGrid>
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
      </MetricGrid>
      <section className="ws-incident-grid" aria-label="Historical incidents">
        {incidents.map((incident) => (
          <IncidentCard
            key={incident.id}
            incident={incident}
            selected={incident.id === selectedId}
            onSelect={onSelect}
          />
        ))}
      </section>
    </>
  );
}
