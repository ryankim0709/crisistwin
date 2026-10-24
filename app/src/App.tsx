import { useEffect, useState } from "react";
import { fetchHealth } from "./lib/api";
import { EmptyResult, Metric, Panel, Tag, WorkspacePage } from "./pages/WorkspaceUI";
import {
  ARRIVED_BY_1800,
  CAMP_ID,
  INCIDENTS_URL,
  STRESS_URL,
  VARIANTS_URL,
  clockLabel,
  fmt,
  fmtDelta,
  formatDate,
  parseIncidents,
  parseStress,
  parseVariants,
  replayHref,
  useJson,
  type Incident,
  type Variant,
  type VariantsIndex,
} from "./pages/workspaceData";

type Connection =
  { status: "loading" } | { status: "connected"; version: string } | { status: "error" };

const CONNECTION_TIMEOUT_MS = 10_000;

/** The what-if with the largest gain in vehicles out by the early checkpoint, or null. */
function bestGain(index: VariantsIndex): { variant: Variant; delta: number } | null {
  let best: { variant: Variant; delta: number } | null = null;
  for (const variant of index.variants) {
    const delta = variant.headline[ARRIVED_BY_1800.key]?.delta ?? null;
    if (delta !== null && delta > 0 && (best === null || delta > best.delta))
      best = { variant, delta };
  }
  return best;
}

function WhatIfHeadline({ index, camp }: { index: VariantsIndex; camp: Incident | undefined }) {
  const best = bestGain(index);
  const when = (camp && clockLabel(ARRIVED_BY_1800.key, camp.date, camp.timezone)) ?? "18:00 UTC";
  if (!best) {
    return (
      <EmptyResult title="No what-if improves on the baseline">
        None of the {index.variants.length} listed what-ifs raises vehicles out by {when}.
      </EmptyResult>
    );
  }
  const hindsight = best.variant.changes.find((line) => /hindsight/i.test(line));
  return (
    <>
      <p className="headline-claim">
        <strong>{best.variant.title}</strong>: {fmtDelta(best.delta)} vehicles out by {when}
      </p>
      <p className="ui-help">
        Largest gain among {index.variants.length} what-ifs. Simulated and counterfactual, one seed;
        not a reconstruction of what would have happened.
        {hindsight ? ` ${hindsight}` : ""}
      </p>
      <a
        className="ui-text-link"
        href={replayHref(CAMP_ID, `&tab=whatif&variant=${encodeURIComponent(best.variant.id)}`)}
      >
        View on map →
      </a>{" "}
      <a className="ui-text-link" href="/comparison">
        Compare all what-ifs →
      </a>
    </>
  );
}

function ReplayOverview() {
  const incidents = useJson(INCIDENTS_URL, parseIncidents);
  const variants = useJson(VARIANTS_URL, parseVariants);
  const stress = useJson(STRESS_URL, parseStress);
  const list = incidents.status === "ready" ? incidents.data : null;
  const camp = list?.find((i) => i.id === CAMP_ID);
  const count = (state: { status: string }, n: number | null) =>
    n !== null ? fmt(n) : state.status === "loading" ? "…" : "—";
  const unavailable = (state: { status: string }, path: string) =>
    state.status === "loading" ? "Loading…" : `${path} unavailable`;

  return (
    <>
      <div className="ui-metrics">
        <Metric
          label="Historical fires"
          value={count(incidents, list?.length ?? null)}
          detail={
            list ? "In the incidents index" : unavailable(incidents, INCIDENTS_URL)
          }
        />
        <Metric
          label="What-if variants"
          value={count(
            variants,
            variants.status === "ready" ? variants.data.variants.length : null,
          )}
          detail={
            variants.status === "ready"
              ? "Simulated Camp Fire counterfactuals"
              : unavailable(variants, VARIANTS_URL)
          }
        />
        <Metric
          label="Stress-test runs"
          value={count(stress, stress.status === "ready" ? stress.data.runs.length : null)}
          detail={
            stress.status === "ready"
              ? "Simulated disruptions of the baseline"
              : unavailable(stress, STRESS_URL)
          }
        />
      </div>
      <div className="ui-split">
        <Panel
          title="Latest what-if headline"
          eyebrow="Camp Fire (2018)"
          aside={<Tag tone="amber">Simulated</Tag>}
        >
          {variants.status === "ready" ? (
            <WhatIfHeadline index={variants.data} camp={camp} />
          ) : (
            <EmptyResult
              title={
                variants.status === "loading" ? "Loading what-ifs…" : "No what-if results available"
              }
            >
              {variants.status === "error"
                ? variants.message
                : `Needs ${VARIANTS_URL}.`}
            </EmptyResult>
          )}
        </Panel>
        <Panel title="Fires available">
          {list && list.length > 0 ? (
            <div className="ui-list">
              {list.map((incident) => (
                <div className="ui-row" key={incident.id}>
                  <div>
                    <strong>{incident.name}</strong>
                    <p>
                      {incident.place} · {formatDate(incident.date)}
                    </p>
                  </div>
                  <a className="ui-text-link" href={replayHref(incident.id)}>
                    Open replay →
                  </a>
                </div>
              ))}
              <a className="ui-text-link" href="/simulate">
                Agent simulation (Camp Fire) →
              </a>
            </div>
          ) : (
            <EmptyResult
              title={incidents.status === "loading" ? "Loading fires…" : "No fires listed"}
            >
              {incidents.status === "error" ? incidents.message : `Needs ${INCIDENTS_URL}.`}
            </EmptyResult>
          )}
        </Panel>
      </div>
    </>
  );
}

export default function App() {
  const [connection, setConnection] = useState<Connection>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(() => controller.abort(), CONNECTION_TIMEOUT_MS);

    fetchHealth(controller.signal)
      .then((health) => {
        if (active) setConnection({ status: "connected", version: health.version });
      })
      .catch(() => {
        if (active) setConnection({ status: "error" });
      })
      .finally(() => window.clearTimeout(timeout));

    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [attempt]);

  function retry() {
    setConnection({ status: "loading" });
    setAttempt((value) => value + 1);
  }

  return (
    <WorkspacePage
      title="Workspace overview"
      action={
        <a className="ui-button" href={replayHref(CAMP_ID)}>
          Open the Camp Fire replay →
        </a>
      }
    >
      <section className="overview-hero" aria-labelledby="demo-title">
        <div>
          <h2 id="demo-title">
            One change can
            <br />
            reshape the whole plan.
          </h2>
          <div className="hero-actions">
            <a className="ui-button ui-button-light" href="/maps">
              Explore the map ↗
            </a>
            <a className="ui-button ui-button-light" href={replayHref(CAMP_ID)}>
              Historical replay ↗
            </a>
            <a className="ui-button ui-button-light" href="/simulate">
              Agent simulation ↗
            </a>
          </div>
        </div>
        <ol className="hero-workflow">
          <li>
            <span>01</span>Define a scenario
          </li>
          <li>
            <span>02</span>Simulate & inspect
          </li>
          <li>
            <span>03</span>Compare & stress-test
          </li>
        </ol>
      </section>
      <ReplayOverview />
      <div className="ui-split">
        <Panel title="No scenarios yet">
          <EmptyResult title="Nothing saved">Scenario drafts and runs are not saved yet.</EmptyResult>
          <a className="ui-text-link" href="/scenarios">
            Open scenario builder →
          </a>
        </Panel>
        <Panel title="Workspace readiness">
          <div className="readiness-connection" aria-live="polite" aria-atomic="true">
            <span className="connection-label">System connection</span>
            {connection.status === "loading" && <p role="status">Connecting to the API…</p>}
            {connection.status === "connected" && (
              <p role="status">
                API and database connected <span>v{connection.version}</span>
              </p>
            )}
            {connection.status === "error" && (
              <>
                <p role="alert">Cannot reach the API or database.</p>
                <button type="button" onClick={retry}>
                  Try again
                </button>
              </>
            )}
          </div>
          <dl className="ui-facts">
            <div>
              <dt>Map fire model</dt>
              <dd>
                <Tag tone="green">Illustrative demo</Tag>
              </dd>
            </div>
            <div>
              <dt>Replay traffic & what-ifs</dt>
              <dd>
                <Tag tone="green">Precomputed files</Tag>
              </dd>
            </div>
            <div>
              <dt>Live traffic & optimization</dt>
              <dd>
                <Tag>Not connected</Tag>
              </dd>
            </div>
            <div>
              <dt>Incident ingestion</dt>
              <dd>
                <Tag>Not connected</Tag>
              </dd>
            </div>
          </dl>
        </Panel>
      </div>
    </WorkspacePage>
  );
}
