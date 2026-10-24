import { useEffect, useState } from "react";
import { fetchHealth } from "./lib/api";
import { EmptyResult, Metric, Panel, Tag, WorkspacePage } from "./pages/WorkspaceUI";
import { navigationItems } from "./navigation";

type Connection =
  { status: "loading" } | { status: "connected"; version: string } | { status: "error" };

const CONNECTION_TIMEOUT_MS = 10_000;

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
      description="A place to test what happens next."
      action={
        <a className="ui-button" href="/scenarios">
          Set up a scenario →
        </a>
      }
    >
      <section className="overview-hero" aria-labelledby="demo-title">
        <div>
          <p className="eyebrow">Disaster response, explored.</p>
          <h2 id="demo-title">
            One change can
            <br />
            reshape the whole plan.
          </h2>
          <p>
            Explore wildfire spread, prepare evacuation assumptions, and make room for the
            unexpected.
          </p>
          <a className="ui-button ui-button-light" href="/maps">
            Explore the map ↗
          </a>
          <a className="ui-button ui-button-light" href="/replay">
            Camp Fire (2018) replay ↗
          </a>
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
      <div className="ui-metrics">
        <Metric label="Fire experiment" value="Ready" detail="Illustrative model · map workspace" />
        <Metric label="Saved scenarios" value="—" detail="Scenario storage not connected" />
        <Metric label="Evacuation runs" value="—" detail="Traffic model not connected" />
      </div>
      <div className="ui-split">
        <Panel title="No scenarios yet" eyebrow="Recent work">
          <EmptyResult title="Start with a shared baseline">
            Choose a fire origin, set the wind, and explore spread in 15-minute steps. Scenario
            drafts and experiment runs are not saved yet.
          </EmptyResult>
          <a className="ui-text-link" href="/scenarios">
            Open scenario builder →
          </a>
        </Panel>
        <Panel title="Workspace readiness" eyebrow="Connections">
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
              <dt>Fire model</dt>
              <dd>
                <Tag tone="green">Illustrative demo</Tag>
              </dd>
            </div>
            <div>
              <dt>Traffic & optimization</dt>
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
      <Panel title="Your planning workflow" eyebrow="Explore the workspace">
        <div className="workflow-grid">
          {navigationItems
            .filter((item) => item.path !== "/")
            .map((item, index) => (
              <a key={item.path} href={item.path}>
                <span className="workflow-number">0{index + 1}</span>
                <strong>{item.label}</strong>
                <p>{item.description}</p>
                <span className="ui-text-link">Open workspace →</span>
              </a>
            ))}
        </div>
      </Panel>
    </WorkspacePage>
  );
}
