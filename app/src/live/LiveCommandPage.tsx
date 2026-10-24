import { useCallback, useRef, useState, type FormEvent } from "react";
import { LiveError, readToken, writeToken } from "./api";
import CommandMap, { LEVEL_COLOR, MAP_COLOR, type MapFocus } from "./CommandMap";
import CommandPanel, { type RunAction } from "./CommandPanel";
import { LEVEL_LABEL, wallClock } from "./format";
import { useCommand } from "./useCommand";
import type { CommandResponse } from "./types";
import "./live.css";

function TokenForm({ error, onSubmit }: { error: string | null; onSubmit: (token: string) => void }) {
  const [value, setValue] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) onSubmit(value.trim());
  };
  return (
    <form className="lc-token" onSubmit={submit}>
      <label htmlFor="lc-token-input">Controller token</label>
      <div className="lc-token-row">
        <input
          id="lc-token-input"
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" className="lc-btn lc-btn--primary" disabled={!value.trim()}>
          Connect
        </button>
      </div>
      {error ? (
        <p className="lc-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

const EVIDENCE_LABEL: Record<CommandResponse["fire"]["evidence_class"], string> = {
  reconstructed: "Reconstructed",
  simulated: "Simulated",
  none: "",
};

function MapOverlays({ data }: { data: CommandResponse }) {
  const fire = data.fire;
  return (
    <>
      <div className="lc-overlay lc-overlay--top">
        <p className="lc-drill-label">
          <span className="lc-chip lc-chip--drill">Drill</span> {data.drill.label}
        </p>
        <p className="lc-fire-label">
          <span className="lc-swatch lc-swatch--fire" aria-hidden="true" />
          {fire.label}
          {EVIDENCE_LABEL[fire.evidence_class] ? (
            <span className={`lc-chip lc-chip--${fire.evidence_class}`}>{EVIDENCE_LABEL[fire.evidence_class]}</span>
          ) : null}
        </p>
      </div>
      <ul className="lc-overlay lc-legend" aria-label="Map legend">
        {(["evacuate_now", "be_ready", "none"] as const).map((level) => (
          <li key={level}>
            <span className="lc-swatch" style={{ background: LEVEL_COLOR[level] }} aria-hidden="true" />
            {LEVEL_LABEL[level]}
          </li>
        ))}
        <li>
          <span className="lc-swatch lc-swatch--line" style={{ background: MAP_COLOR.route }} aria-hidden="true" />
          Published route
        </li>
        <li>
          <span className="lc-swatch lc-swatch--fire" aria-hidden="true" />
          Fire estimate
        </li>
        <li>
          <span className="lc-dot" style={{ background: MAP_COLOR.hazard, borderColor: "#fff" }} aria-hidden="true" />
          Confirmed hazard
        </li>
        <li>
          <span className="lc-dot lc-dot--hollow" style={{ borderColor: MAP_COLOR.report }} aria-hidden="true" />
          Unverified report
        </li>
        <li>
          <span className="lc-dot" style={{ background: MAP_COLOR.responder }} aria-hidden="true" />
          Responder
        </li>
        <li>
          <span className="lc-dot lc-dot--hollow lc-dot--help" style={{ borderColor: MAP_COLOR.help }} aria-hidden="true" />
          Needs help
        </li>
      </ul>
    </>
  );
}

export default function LiveCommandPage() {
  const [token, setToken] = useState<string | null>(() => readToken());
  const command = useCommand(token);
  const [busy, setBusy] = useState<string | null>(null);
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const busyRef = useRef(false);
  const { refresh } = command;

  const run = useCallback<RunAction>(
    async (key, action) => {
      if (!token || busyRef.current) return null;
      busyRef.current = true;
      setBusy(key);
      try {
        await action(token);
        return null;
      } catch (error) {
        return error instanceof LiveError ? error.message : "Action failed.";
      } finally {
        busyRef.current = false;
        setBusy(null);
        refresh();
      }
    },
    [token, refresh],
  );

  const connect = (value: string) => {
    writeToken(value);
    if (value === token) refresh();
    else setToken(value);
  };
  const signOut = () => {
    writeToken(null);
    setToken(null);
  };

  const unauthorized = command.error?.unauthorized ?? false;
  const data = unauthorized ? null : command.data;

  let body;
  if (!token || unauthorized) {
    body = <TokenForm error={unauthorized ? command.error!.message : null} onSubmit={connect} />;
  } else if (!data) {
    body = command.error ? (
      <div className="lc-state">
        <p className="lc-error" role="alert">
          {command.error.message}
        </p>
        <button type="button" className="lc-btn" onClick={refresh}>
          Retry
        </button>
      </div>
    ) : (
      <p className="lc-state lc-dim" role="status">
        <span className="lc-spinner" aria-hidden="true" /> Loading…
      </p>
    );
  } else {
    body = <CommandPanel data={data} receivedAt={command.receivedAt} run={run} busy={busy} onFocus={setFocus} />;
  }

  return (
    <div className="lc-root">
      <main className="lc-stage">
        <CommandMap data={data} focus={focus} />
        {data ? <MapOverlays data={data} /> : null}
      </main>
      <aside className="lc-panel" aria-label="Live command">
        <header className="lc-panel-top">
          <a className="lc-back" href="/">
            ← Workspace
          </a>
          <h1>Live command</h1>
          {data ? (
            <span className={`lc-conn${command.error ? " lc-conn--lost" : ""}`} role="status">
              {command.error ? `Connection lost · ${wallClock(data.generated_at)}` : wallClock(data.generated_at)}
            </span>
          ) : null}
          {token ? (
            <button type="button" className="lc-link" onClick={signOut}>
              Sign out
            </button>
          ) : null}
        </header>
        <div className="lc-panel-body">{body}</div>
      </aside>
    </div>
  );
}
