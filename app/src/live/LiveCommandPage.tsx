import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Button, Field, LoadingState, Notice } from "../ui";
import { LiveError, readToken, runImpact, writeToken } from "./api";
import CommandMap, { LAYER_KEYS, type LayerKey, type MapFocus } from "./CommandMap";
import EvacuationPicture from "./EvacuationPicture";
import ProposalPanel from "./ProposalPanel";
import { buildQueue, proposalFor, type QueueFilter } from "./queue";
import ReviewQueue from "./ReviewQueue";
import SelectedItem, { type ImpactState, type RunAction } from "./SelectedItem";
import { useCommand } from "./useCommand";
import { useTwin } from "./useTwin";
import WorkspaceHeader from "./WorkspaceHeader";
import "./live.css";

const HIGHLIGHT_MS = 2_500;
const LAYER_LABEL: Record<LayerKey, string> = {
  zones: "Zones",
  fire: "Fire",
  reports: "Reports",
  roads: "Roads",
  shelters: "Shelters",
};

function TokenForm({ error, onSubmit }: { error: string | null; onSubmit: (token: string) => void }) {
  const [value, setValue] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) onSubmit(value.trim());
  };
  return (
    <form className="lc-token" onSubmit={submit}>
      <Field label="Controller token">
        <input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
      <Button type="submit" disabled={!value.trim()}>
        Connect
      </Button>
      {error ? (
        <Notice tone="danger" compact>
          {error}
        </Notice>
      ) : null}
    </form>
  );
}

/** Map layer toggles; each one is also its legend entry. */
function LayerToggles({
  layers,
  onToggle,
}: {
  layers: Record<LayerKey, boolean>;
  onToggle: (key: LayerKey) => void;
}) {
  return (
    <div className="lc-layers" role="group" aria-label="Map layers">
      {LAYER_KEYS.map((key) => (
        <button key={key} type="button" className="lc-layer" aria-pressed={layers[key]} onClick={() => onToggle(key)}>
          <span className={`lc-sw lc-sw--${key}`} aria-hidden="true" />
          {LAYER_LABEL[key]}
        </button>
      ))}
    </div>
  );
}

/** Re-renders every `ms` so clocks and ages advance between polls. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

export default function LiveCommandPage() {
  const [token, setToken] = useState<string | null>(() => readToken());
  const command = useCommand(token);
  const twin = useTwin(token);
  const [busy, setBusy] = useState<string | null>(null);
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const [filter, setFilter] = useState<QueueFilter>("new");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [impact, setImpact] = useState<ImpactState | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [layers, setLayers] = useState<Record<LayerKey, boolean>>({
    zones: true,
    fire: true,
    reports: true,
    roads: true,
    shelters: true,
  });
  const now = useNow(1000);
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

  const unauthorized = command.error?.unauthorized ?? false;
  const data = unauthorized ? null : command.data;
  const twinData = data ? twin.data : null;
  const serverNow =
    data && command.receivedAt !== null ? new Date(data.generated_at).getTime() + (now - command.receivedAt) : now;
  // The queue re-sorts on each poll only, so rows do not jump while ages tick.
  const items = useMemo(() => (data ? buildQueue(data, new Date(data.generated_at).getTime()) : []), [data]);
  const selected = items.find((i) => i.id === selectedId) ?? null;

  // A map click selects an item outside the current filter too; the queue keeps it listed.
  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    setFocus(null);
    setImpact((cur) => (cur && cur.itemId === id ? cur : null));
  }, []);

  const onRunImpact = async () => {
    if (!token || !selected?.segmentId) return;
    const itemId = selected.id;
    setImpact({ itemId, loading: true, result: null, error: null });
    try {
      const result = await runImpact(token, { segment_id: selected.segmentId });
      setImpact((cur) => (cur?.itemId === itemId ? { itemId, loading: false, result, error: null } : cur));
    } catch (error) {
      const message = error instanceof LiveError ? error.message : "Impact analysis failed.";
      setImpact((cur) => (cur?.itemId === itemId ? { itemId, loading: false, result: null, error: message } : cur));
    }
  };

  const reviewProposal = (id: string) => {
    setHighlight(id);
    const el = document.getElementById(`lc-prop-${id}`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    el?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!highlight) return;
    const id = window.setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(id);
  }, [highlight]);

  const connect = (value: string) => {
    writeToken(value);
    if (value === token) refresh();
    else setToken(value);
  };
  const signOut = () => {
    writeToken(null);
    setToken(null);
  };

  let gate = null;
  if (!token || unauthorized) {
    gate = <TokenForm error={unauthorized ? command.error!.message : null} onSubmit={connect} />;
  } else if (!data) {
    gate = command.error ? (
      <div className="lc-token">
        <Notice tone="danger" compact>
          {command.error.message}
        </Notice>
        <Button variant="secondary" onClick={refresh}>
          Retry
        </Button>
      </div>
    ) : (
      <div className="lc-token">
        <LoadingState>Loading the incident…</LoadingState>
      </div>
    );
  }

  const impactResult = impact && selected && impact.itemId === selected.id ? impact.result : null;

  return (
    <div className={`lc-root ui-theme-dark${data ? "" : " lc-root--gate"}`}>
      <WorkspaceHeader
        data={data}
        twin={twinData}
        receivedAt={command.receivedAt}
        now={now}
        connectionError={data && command.error ? command.error.message : null}
        run={run}
        busy={busy}
        onSignOut={token ? signOut : null}
      />
      {data ? (
        <ReviewQueue
          items={items}
          filter={filter}
          onFilter={setFilter}
          selectedId={selectedId}
          onSelect={select}
          serverNow={serverNow}
        />
      ) : null}
      <main className="lc-stage">
        <CommandMap
          data={data}
          twin={twinData}
          items={items}
          selected={selected}
          focus={focus}
          layers={layers}
          impact={impactResult}
          onSelect={select}
        />
        {data ? <LayerToggles layers={layers} onToggle={(k) => setLayers((l) => ({ ...l, [k]: !l[k] }))} /> : null}
        {gate}
      </main>
      {data ? (
        <aside className="lc-col lc-right" aria-label="Decisions and evacuation picture">
          <div className="lc-col-scroll">
            <ProposalPanel data={data} run={run} busy={busy} serverNow={serverNow} highlightId={highlight} />
            {selected ? (
              <SelectedItem
                key={selected.id}
                item={selected}
                data={data}
                serverNow={serverNow}
                run={run}
                busy={busy}
                impact={impact}
                proposalId={proposalFor(selected, data)}
                onRunImpact={() => void onRunImpact()}
                onReviewProposal={reviewProposal}
                onClose={() => select(null)}
              />
            ) : null}
            <EvacuationPicture data={data} twin={twinData} twinError={twin.error} onFocus={setFocus} />
          </div>
        </aside>
      ) : null}
    </div>
  );
}
