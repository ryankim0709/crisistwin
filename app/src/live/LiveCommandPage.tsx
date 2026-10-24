import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Button, Field, IconButton, Kbd, LoadingState, Notice } from "../ui";
import ActivityLog from "./ActivityLog";
import { useTriageKeys } from "./useTriageKeys";
import "./activity.css";
import { useTaskRoute } from "./useTaskRoute";
import { fetchActive } from "./active";
import { DEFAULT_INCIDENT_ID, LiveError, readToken, runImpact, SERVER_TOKEN, writeToken } from "./api";
import CommandMap, { LAYER_KEYS, type LayerKey, type MapFocus } from "./CommandMap";
import EvacuationPicture from "./EvacuationPicture";
import FireBehaviorPanel from "./FireBehaviorPanel";
import { headBehavior } from "./fireBehavior";
import MapLegend from "./MapLegend";
import ProposalPanel from "./ProposalPanel";
import { buildQueue, matches, proposalFor, type QueueFilter } from "./queue";
import ResponseRecord from "./ResponseRecord";
import GroundRecord from "./GroundRecord";
import { labelPoint } from "./format";
import StalePanel from "./StalePanel";
import ReviewQueue from "./ReviewQueue";
import SelectedItem, { type ImpactState, type RunAction } from "./SelectedItem";
import { useCommand } from "./useCommand";
import { usePoll } from "./usePoll";
import { useFireBehavior } from "./useFireBehavior";
import { useTwin } from "./useTwin";
import WorkspaceHeader from "./WorkspaceHeader";
import "./live.css";

const HIGHLIGHT_MS = 2_500;
const ACTIVE_POLL_MS = 30_000;
const LAYER_LABEL: Record<LayerKey, string> = {
  zones: "Zones",
  fire: "Fire",
  reports: "Reports",
  roads: "Roads",
  shelters: "Shelters",
};

function TokenForm({
  error,
  onSubmit,
}: {
  error: string | null;
  onSubmit: (token: string) => void;
}) {
  const [value, setValue] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) onSubmit(value.trim());
  };
  return (
    <form className="lc-token" onSubmit={submit}>
      <Field label="Controller token">
        <input
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
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
        <button
          key={key}
          type="button"
          className="lc-layer"
          aria-pressed={layers[key]}
          onClick={() => onToggle(key)}
        >
          <span className={`lc-sw lc-sw--${key}`} aria-hidden="true" />
          {LAYER_LABEL[key]}
        </button>
      ))}
    </div>
  );
}

const KEY_HINTS: [string, string][] = [
  ["j / k", "Next, previous"],
  ["c", "Confirm"],
  ["d", "Dismiss"],
  ["r", "Resolve"],
  ["Esc", "Clear selection"],
];

function ShortcutHint() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (
        e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div className="lc-keys" ref={ref}>
      <IconButton
        label="Keyboard shortcuts"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </IconButton>
      {open ? (
        <div className="lc-keys-pop" role="dialog" aria-label="Keyboard shortcuts">
          {KEY_HINTS.map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <span>
                <Kbd>{k}</Kbd>
              </span>
              <span>{v}</span>
            </div>
          ))}
        </div>
      ) : null}
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
  // The hosted instance's one active incident; re-read every 30 s and right after a switch. If it
  // cannot be read, the console falls back to the default incident rather than staying blank.
  const active = usePoll(token, fetchActive, ACTIVE_POLL_MS, "Live API");
  const incidentId = active.data?.incident_id ?? DEFAULT_INCIDENT_ID;
  const incidentToken = active.loading ? null : token;
  const command = useCommand(incidentToken, incidentId);
  const twin = useTwin(incidentToken, incidentId);
  const fireInputs = useFireBehavior(incidentToken, incidentId);
  const [busy, setBusy] = useState<string | null>(null);
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const [filter, setFilter] = useState<QueueFilter>("new");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showRecord, setShowRecord] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [impact, setImpact] = useState<ImpactState | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [layers, setLayers] = useState<Record<LayerKey, boolean>>({
    zones: true,
    fire: true,
    reports: true,
    roads: true,
    shelters: true,
  });
  // A different incident: drop the selection and per-incident panels (the polls restart themselves).
  useEffect(() => {
    setSelectedId(null);
    setFocus(null);
    setImpact(null);
    setActionError(null);
    setHighlight(null);
  }, [incidentId]);
  const now = useNow(1000);
  const busyRef = useRef(false);
  const { refresh } = command;

  const run = useCallback<RunAction>(
    async (key, action) => {
      if (!token || busyRef.current) return null;
      busyRef.current = true;
      setBusy(key);
      try {
        await action(token, incidentId);
        return null;
      } catch (error) {
        return error instanceof LiveError ? error.message : "Action failed.";
      } finally {
        busyRef.current = false;
        setBusy(null);
        refresh();
      }
    },
    [token, incidentId, refresh],
  );

  const unauthorized = command.error?.unauthorized ?? false;
  const data = unauthorized ? null : command.data;
  const twinData = data ? twin.data : null;
  // Only inputs for the incident on screen (the poll keeps the last answer across a switch).
  const fireData = data && fireInputs.data?.incident_id === incidentId ? fireInputs.data : null;
  const head = useMemo(() => headBehavior(fireData), [fireData]);
  const serverNow =
    data && command.receivedAt !== null
      ? new Date(data.generated_at).getTime() + (now - command.receivedAt)
      : now;
  // The queue re-sorts on each poll only, so rows do not jump while ages tick.
  const items = useMemo(
    () => (data ? buildQueue(data, new Date(data.generated_at).getTime()) : []),
    [data],
  );
  const selected = items.find((i) => i.id === selectedId) ?? null;
  // Hiding 2018 record items keeps the selected one listed, as filters do.
  const listed = useMemo(
    () => (showRecord ? items : items.filter((i) => !i.record || i.id === selectedId)),
    [items, showRecord, selectedId],
  );
  const routeTask =
    selected?.task && (selected.task.status === "open" || selected.task.status === "accepted")
      ? selected.task.id
      : null;
  // Route the assignee's own apparatus class when it declared one (simulated station engines do).
  const assigneeClass =
    (selected?.task?.assignee && data?.responders.find((r) => r.party_key === selected.task!.assignee)?.apparatus?.access_class) ||
    null;
  const taskRoute = useTaskRoute(data ? token : null, routeTask, assigneeClass);

  // A map click selects an item outside the current filter too; the queue keeps it listed.
  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    setActionError(null);
    setFocus(null);
    setImpact((cur) => (cur && cur.itemId === id ? cur : null));
  }, []);

  const onRunImpact = async () => {
    if (!token || !selected?.segmentId) return;
    const itemId = selected.id;
    setImpact({ itemId, loading: true, result: null, error: null });
    try {
      const result = await runImpact(token, incidentId, { segment_id: selected.segmentId });
      setImpact((cur) =>
        cur?.itemId === itemId ? { itemId, loading: false, result, error: null } : cur,
      );
    } catch (error) {
      const message = error instanceof LiveError ? error.message : "Impact analysis failed.";
      setImpact((cur) =>
        cur?.itemId === itemId ? { itemId, loading: false, result: null, error: message } : cur,
      );
    }
  };

  const shown = useMemo(
    () => listed.filter((i) => matches(i, filter) || i.id === selectedId),
    [listed, filter, selectedId],
  );
  useTriageKeys({ shown, selected, busy, run, onSelect: select, onError: setActionError });

  const selectFromLog = (reportIds: string[]) => {
    const hit = items.find((i) => i.reports.some((r) => reportIds.includes(r.id)));
    if (hit) select(hit.id);
    return !!hit;
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
        onSignOut={token && token !== SERVER_TOKEN ? signOut : null}
        token={token}
        active={active.data}
        onSwitched={active.refresh}
      />
      {data ? (
        <ReviewQueue
          items={listed}
          showRecord={showRecord}
          onShowRecord={setShowRecord}
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
          taskRoute={taskRoute?.route?.route?.line ?? null}
          fireInputs={fireData}
          head={head}
          onSelect={select}
        />
        {data ? (
          <LayerToggles
            layers={layers}
            onToggle={(k) => setLayers((l) => ({ ...l, [k]: !l[k] }))}
          />
        ) : null}
        {data ? <MapLegend /> : null}
        {gate}
      </main>
      {data ? (
        <aside className="lc-col lc-right" aria-label="Decisions and evacuation picture">
          <div className="lc-col-scroll">
            <div style={{ display: "flex", justifyContent: "flex-end", padding: "4px 8px 0" }}>
              <ShortcutHint />
            </div>
            <ProposalPanel
              data={data}
              twin={twinData}
              run={run}
              busy={busy}
              serverNow={serverNow}
              highlightId={highlight}
            />
            {actionError ? (
              <Notice tone="danger" compact>
                {actionError}
              </Notice>
            ) : null}
            {selected ? (
              <SelectedItem
                key={selected.id}
                item={selected}
                data={data}
                serverNow={serverNow}
                run={run}
                busy={busy}
                impact={impact}
                route={taskRoute}
                proposalId={proposalFor(selected, data)}
                headFlameFeet={head?.headFlameFeet ?? null}
                onRunImpact={() => void onRunImpact()}
                onReviewProposal={reviewProposal}
                onClose={() => select(null)}
              />
            ) : null}
            <StalePanel
              items={data.stale_critical}
              tasks={data.tasks}
              serverNow={serverNow}
              onFocus={setFocus}
            />
            <FireBehaviorPanel
              inputs={fireData}
              error={fireInputs.error && !fireInputs.error.unauthorized ? fireInputs.error.message : null}
              head={head}
              data={data}
              onFocus={setFocus}
            />
            <EvacuationPicture
              data={data}
              twin={twinData}
              twinError={twin.error}
              onFocus={setFocus}
            />
            <GroundRecord
              record={data.ground_record}
              zones={data.zones}
              onFocusZone={(id) => {
                const zone = data.zones.find((z) => z.id === id);
                const coord = zone ? labelPoint(zone.geometry) : null;
                if (coord) setFocus({ id: `zone:${id}`, coord });
              }}
            />
            <ResponseRecord items={data.response_record ?? []} />
            <ActivityLog
              decisions={data.decisions ?? []}
              serverNow={serverNow}
              onSelect={selectFromLog}
            />
          </div>
        </aside>
      ) : null}
    </div>
  );
}
