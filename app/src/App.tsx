import { useEffect, useState } from "react";
import { fetchHealth } from "./lib/api";

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
    <main className="shell">
      <header className="masthead">
        <a className="wordmark" href="/" aria-label="CrisisTwin home">
          <span className="mark" aria-hidden="true">
            CT
          </span>
          CrisisTwin
        </a>
        <span className="badge">Cal Hacks / Prototype</span>
      </header>

      <section className="intro" aria-labelledby="title">
        <p className="eyebrow">Disaster response, explored.</p>
        <h1 id="title">
          A place to test
          <br />
          what happens next.
        </h1>
        <p className="description">
          Explore how wildfire, road closures, and evacuation decisions interact. The workspace is
          ready to explore; scenarios and simulations are coming next.
        </p>
      </section>

      <section className="workspace" aria-labelledby="workspace-title">
        <div>
          <p className="eyebrow">Your workspace</p>
          <h2 id="workspace-title">No scenarios yet</h2>
          <p>Open the geographic map to explore a location.</p>
          <p>
            <a href="/maps">Open map →</a>
          </p>
        </div>
        <div className="connection" aria-live="polite" aria-atomic="true">
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
      </section>

      <footer>
        Experimental planning only. Outputs are not operational evacuation instructions.
      </footer>
    </main>
  );
}
