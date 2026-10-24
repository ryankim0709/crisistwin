import {
  DataState,
  DeltaCell,
  EmptyResult,
  EvidenceTag,
  Facts,
  LinkButton,
  Metric,
  MetricGrid,
  Panel,
  Tag,
  WorkspacePage,
} from "./WorkspaceUI";
import {
  ARRIVED_BY_1800,
  CAMP_ID,
  INCIDENTS_URL,
  OUTCOME_METRICS,
  VARIANTS_URL,
  clockLabel,
  fmt,
  parseIncidents,
  parseVariants,
  replayHref,
  useJson,
  type Variant,
  type VariantsIndex,
} from "./workspaceData";

const MAX_CHANGE_LINES = 5;

function metricLabel(spec: (typeof OUTCOME_METRICS)[number], when: string) {
  return spec.key === ARRIVED_BY_1800.key ? `${spec.label} ${when}` : spec.label;
}

function VariantRow({ variant }: { variant: Variant }) {
  const shown = variant.changes.slice(0, MAX_CHANGE_LINES);
  const hidden = variant.changes.length - shown.length;
  return (
    <tr>
      <th scope="row">
        <strong>{variant.title}</strong>
        <div className="ui-help">{variant.question}</div>
        <details className="ws-variant-notes">
          <summary>What changed and caveats</summary>
          <ul>
            {shown.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {hidden > 0 && (
            <p className="ui-help">
              {hidden} more lines in the replay&rsquo;s What if&hellip; tab.
            </p>
          )}
          {variant.fireChanged && (
            <p className="ui-help">This what-if also changes the simulated fire front.</p>
          )}
        </details>
      </th>
      {OUTCOME_METRICS.map((spec) => (
        <td className="num" key={spec.key}>
          <DeltaCell metric={variant.headline[spec.key]} direction={spec.direction} />
        </td>
      ))}
      <td className="num">
        {variant.zoneRiskChanged === null ? "n/a" : fmt(variant.zoneRiskChanged)}
      </td>
      <td>
        <EvidenceTag kind={variant.evidenceClass} />
      </td>
      <td>
        <a
          className="ui-text-link"
          href={replayHref(CAMP_ID, `&tab=whatif&variant=${encodeURIComponent(variant.id)}`)}
        >
          View on map →
        </a>
      </td>
    </tr>
  );
}

function basisFacts(basis: VariantsIndex["basis"]): [string, string][] {
  const o = (v: unknown) =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const text = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : null);
  const clock = o(basis.clock);
  const network = o(basis.network);
  const demand = o(basis.demand);
  const models = o(basis.models);
  const facts: [string, string | null][] = [
    ["Random seed", text(basis.seed)],
    [
      "Clock (UTC)",
      text(clock.start) && text(clock.end)
        ? `${text(clock.start)} to ${text(clock.end)}, ${text(clock.step_s) ?? "?"} s step`
        : null,
    ],
    [
      "Road network",
      text(network.edges)
        ? `${text(network.edges)} edges, ${text(network.nodes) ?? "?"} nodes`
        : null,
    ],
    [
      "Demand",
      text(demand.total_veh)
        ? `${Number(demand.total_veh).toLocaleString("en-US")} vehicles in ${text(demand.zones) ?? "?"} zones`
        : null,
    ],
    [
      "Models",
      Object.keys(models).length
        ? Object.entries(models)
            .map(([k, v]) => `${k}: ${text(v)}`)
            .join(" · ")
        : null,
    ],
  ];
  return facts.filter((f): f is [string, string] => f[1] !== null);
}

function Comparison({ index }: { index: VariantsIndex }) {
  const incidents = useJson(INCIDENTS_URL, parseIncidents);
  const camp =
    incidents.status === "ready" ? incidents.data.find((i) => i.id === CAMP_ID) : undefined;
  const when = (camp && clockLabel(ARRIVED_BY_1800.key, camp.date, camp.timezone)) ?? "18:00 UTC";
  const base = index.baselineMetrics;
  const facts = basisFacts(index.basis);

  return (
    <>
      <MetricGrid>
        <Metric
          label={`Baseline: vehicles out by ${when}`}
          value={fmt(base[ARRIVED_BY_1800.key] ?? null)}
          detail="Simulated, the replayed 2018 plan"
        />
        <Metric
          label="Baseline: total exposure"
          value={fmt(base.total_exposed_veh_min ?? null)}
          detail="Simulated vehicle-minutes, on roads plus at home"
        />
        <Metric
          label="Baseline: peak blocked"
          value={fmt(base.peak_blocked_veh ?? null)}
          detail="Simulated vehicles"
        />
      </MetricGrid>
      <Panel
        title="What-if outcomes against the baseline"
        aside={<Tag tone="warning">Counterfactual, not history</Tag>}
      >
        <div className="ui-table-scroll">
          <table className="ui-table ws-comparison-table">
            <caption>
              Each cell is the what-if value, then its change from the baseline. Higher is better
              for vehicles out; lower is better for exposure and blocked vehicles.
            </caption>
            <thead>
              <tr>
                <th scope="col">What if&hellip;</th>
                {OUTCOME_METRICS.map((spec) => (
                  <th scope="col" className="num" key={spec.key}>
                    {metricLabel(spec, when)} ({spec.unit})
                  </th>
                ))}
                <th scope="col" className="num">
                  Zones with changed risk
                </th>
                <th scope="col">Evidence</th>
                <th scope="col">Map</th>
              </tr>
            </thead>
            <tbody>
              {index.variants.map((variant) => (
                <VariantRow key={variant.id} variant={variant} />
              ))}
            </tbody>
          </table>
        </div>
        {index.skipped.length > 0 && (
          <ul className="ui-checklist">
            {index.skipped.map((s) => (
              <li key={s.id}>
                Not run: {s.title}. {s.reason}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <div className="ui-columns">
        <Panel title="Same inputs for every run">
          <Facts items={facts.map(([label, value]) => ({ label, value }))} />
        </Panel>
        <Panel title="Limitations">
          {index.limitations.length > 0 ? (
            <ul className="ui-checklist">
              {index.limitations.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : (
            <EmptyResult title="No limitations recorded">
              Treat results as a single-seed planning experiment.
            </EmptyResult>
          )}
        </Panel>
      </div>
    </>
  );
}

export default function ComparisonPage() {
  const load = useJson(VARIANTS_URL, parseVariants);
  return (
    <WorkspacePage
      title="Strategy comparison"
      action={
        <LinkButton href={replayHref(CAMP_ID, "&tab=whatif")}>
          Open What if&hellip; on the map →
        </LinkButton>
      }
    >
      {load.status !== "ready" ? (
        <Panel title="What-if variants">
          <DataState load={load} what="what-if variants" path={VARIANTS_URL} />
        </Panel>
      ) : load.data.variants.length === 0 ? (
        <Panel title="What-if variants">
          <EmptyResult title="No what-if variants listed">
            Generate them with <code>python3 -m sim.variants</code>.
          </EmptyResult>
        </Panel>
      ) : (
        <Comparison index={load.data} />
      )}
    </WorkspacePage>
  );
}
