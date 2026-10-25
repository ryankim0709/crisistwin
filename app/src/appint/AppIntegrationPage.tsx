// /app-integration: the phone app inside the server-side live drill (docs/app-integration.md "Tab").
// Real phones and simulated people on one map and one list, what waits for the controller's OK,
// the message timeline, and what a chosen person's phone shows. Separate from /live's simulated board.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, EvidenceTag, LoadingState, Metric, MetricGrid, Notice, Page, Panel, SegmentedControl, type SegmentedOption } from "../ui";
import { fetchActive } from "../live/active";
import { approveProposal, DEFAULT_INCIDENT_ID, drillAction, helpAction, readToken, rejectProposal } from "../live/api";
import { drillClock, drillNowAt } from "../live/format";
import InvitePhones from "../live/InvitePhones";
import { usePeople } from "../live/people";
import { useCommand } from "../live/useCommand";
import { usePoll } from "../live/usePoll";
import { addVirtualPeople, useParticipants } from "./api";
import AppMap, { type MapLayerKey } from "./AppMap";
import { BehaviourPanel, MessagesPanel, NeedsOk, ParticipantList, type Decide } from "./Panels";
import PhoneMirror from "./PhoneMirror";
import { everyoneElse, isJoinedNow, nf, personSummary } from "./plain";
import "./appint.css";

const ACTIVE_POLL_MS = 30_000;
type Speed = "0" | "1" | "5" | "20";
const LAYER_LABEL: Record<MapLayerKey, string> = {
  app: "Our app users",
  people: "Everyone else",
  zones: "Zones",
  fire: "Fire",
  closures: "Closed roads",
};

function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

export default function AppIntegrationPage() {
  const [token] = useState<string | null>(() => readToken());
  const active = usePoll(token, fetchActive, ACTIVE_POLL_MS, "Live API");
  const incidentId = active.data?.incident_id ?? DEFAULT_INCIDENT_ID;
  const incidentToken = active.loading ? null : token;
  const command = useCommand(incidentToken, incidentId);
  const people = usePeople(incidentToken, incidentId);
  const roster = useParticipants(incidentToken, incidentId);
  const nowMs = useNow(1000);

  const data = command.data;
  const participants = useMemo(() => roster.data?.participants ?? [], [roster.data]);
  const [showInvite, setShowInvite] = useState(false);
  const [layers, setLayers] = useState<Record<MapLayerKey, boolean>>({ app: true, people: true, zones: true, fire: true, closures: true });
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [forcedRealTime, setForcedRealTime] = useState(false);
  const busyRef = useRef(false);
  const refreshCommand = command.refresh;
  const refreshRoster = roster.refresh;

  // The chosen person while they are still listed, else the first real phone, else anyone.
  const [picked, setSelectedId] = useState<string | null>(null);
  const selectedId =
    picked && participants.some((p) => p.id === picked)
      ? picked
      : ((participants.find((p) => p.kind === "real") ?? participants[0])?.id ?? null);

  const joinedReal = participants.filter((p) => isJoinedNow(p, nowMs)).length;
  const drill = data?.drill ?? null;
  const speedNow = drill ? (drill.started_at && drill.running ? drill.speed : 0) : 0;

  const decide = useCallback<Decide>(
    async (key, action) => {
      if (!token || busyRef.current) return;
      busyRef.current = true;
      setBusy(key);
      setActionError(null);
      try {
        await action();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "That did not go through.");
      } finally {
        busyRef.current = false;
        setBusy(null);
        refreshCommand();
        refreshRoster();
      }
    },
    [token, refreshCommand, refreshRoster],
  );

  // Real phones follow the real clock: a practice speed-up stops as soon as a real phone is joined.
  useEffect(() => {
    if (!token || !drill || joinedReal === 0 || !drill.running || drill.speed <= 1 || busyRef.current) return;
    setForcedRealTime(true);
    void decide("speed", () => drillAction(token, incidentId, { action: "set_speed", speed: 1 }));
  }, [token, drill, joinedReal, incidentId, decide]);

  const setSpeed = (value: Speed) => {
    if (!token || !drill) return;
    const speed = Number(value);
    if (!drill.started_at) {
      if (speed > 0) void decide("speed", () => drillAction(token, incidentId, { action: "start", replay_start: drill.replay_now, speed }));
      return;
    }
    void decide("speed", () => drillAction(token, incidentId, { action: "set_speed", speed }));
  };

  const addSimulated = async () => {
    if (!token || adding) return;
    setAdding(true);
    setAddError(null);
    try {
      // A fresh seed per click, so each added household draws its own choices; the server keeps it.
      await addVirtualPeople(token, incidentId, 1, Math.floor(Math.random() * 1_000_000_000));
      roster.refresh();
    } catch (e) {
      const status = (e as { status?: number }).status;
      setAddError(status === 404 || status === 405 ? "Simulated people are not available on this server yet." : e instanceof Error ? e.message : "Could not add one.");
    } finally {
      setAdding(false);
    }
  };

  const speedOptions: SegmentedOption<Speed>[] = [
    { value: "0", label: "Pause" },
    { value: "1", label: "Real time" },
    {
      value: "5",
      label: "×5",
      disabled: joinedReal > 0,
      title: joinedReal > 0 ? "Real phones are joined, so the drill runs in real time" : "Practice speed: only with no real phones",
    },
    {
      value: "20",
      label: "×20",
      disabled: joinedReal > 0,
      title: joinedReal > 0 ? "Real phones are joined, so the drill runs in real time" : "Practice speed: only with no real phones",
    },
  ];
  const speedValue: Speed = speedNow <= 0 ? "0" : speedNow <= 1 ? "1" : speedNow <= 5 ? "5" : "20";

  const selected = participants.find((p) => p.id === selectedId) ?? null;
  const rest = people.data ? everyoneElse(people.data.totals.people, participants) : null;
  const counts = roster.data?.counts;
  const clock = drill ? drillClock(drillNowAt(drill, command.receivedAt, nowMs)) : "—";

  const header = (
    <div className="aix-header-actions">
      <span className="aix-clock" aria-live="off">
        <strong>{clock}</strong> drill time
      </span>
      {drill ? <SegmentedControl label="Drill speed" options={speedOptions} value={speedValue} onChange={setSpeed} /> : null}
      <Button variant="secondary" onClick={() => setShowInvite(true)}>
        Invite phones
      </Button>
    </div>
  );

  const unauthorized = command.error?.unauthorized;
  return (
    <Page
      title="App integration"
      description={active.data ? `${active.data.name} · practice run` : "Practice run"}
      action={header}
    >
      {showInvite ? <InvitePhones onClose={() => setShowInvite(false)} /> : null}
      {unauthorized ? (
        <Notice tone="danger" title="Not signed in as the controller.">
          Open Live command once to enter the controller token, then come back.
        </Notice>
      ) : null}
      {!data && command.error && !unauthorized ? (
        <Notice tone="danger" title="Can't reach the live drill.">
          {command.error.message}{" "}
          <Button size="sm" variant="secondary" onClick={command.refresh}>
            Retry
          </Button>
        </Notice>
      ) : null}
      {!data && !command.error ? <LoadingState>Loading the drill…</LoadingState> : null}
      {data ? (
        <>
          {joinedReal > 0 ? (
            <Notice tone="info" compact>
              {joinedReal === 1 ? "A real phone is" : `${joinedReal} real phones are`} joined, so the drill runs in real time.
              {forcedRealTime ? " It was sped up, so it went back to real time." : ""}
            </Notice>
          ) : (
            <p className="aix-note">No real phones yet, so you can speed up for practice.</p>
          )}
          <section className="aix-stats" aria-label="Where people are">
            <MetricGrid>
              <Metric label="Still at home" value={rest ? nf(rest.home) : "…"} />
              <Metric label="Driving out" value={rest ? nf(rest.driving) : "…"} />
              <Metric label="In traffic" value={rest ? nf(rest.queued) : "…"} />
              <Metric label="Stuck" value={rest ? nf(rest.stuck) : "…"} />
              <Metric label="Safely out" value={rest ? nf(rest.out) : "…"} />
              <Metric
                label="On our app"
                value={counts ? `${counts.real} real` : "…"}
                detail={counts ? `${counts.simulated} simulated` : undefined}
              />
            </MetricGrid>
            <p className="aix-note">
              <EvidenceTag kind="simulated" /> Everyone else is an estimate from the traffic model
              {people.error && !people.data ? ` (${people.error.code === "twin_warming" ? "still loading" : "not available"})` : ""}.
              Our app users are counted once, as their own dots.
            </p>
          </section>

          <div className="aix-grid">
            <ParticipantList
              participants={participants}
              selectedId={selectedId}
              onSelect={setSelectedId}
              nowMs={nowMs}
              loading={roster.loading}
              error={roster.error && !roster.data ? roster.error.message : null}
              adding={adding}
              addError={addError}
              onAdd={() => void addSimulated()}
              onInvite={() => setShowInvite(true)}
            />

            <Panel compact className="aix-map-panel" aria-label="Map">
              <div className="aix-layers" role="group" aria-label="Show on the map">
                {(Object.keys(LAYER_LABEL) as MapLayerKey[]).map((key) => (
                  <Button
                    key={key}
                    size="sm"
                    variant={layers[key] ? "primary" : "secondary"}
                    aria-pressed={layers[key]}
                    onClick={() => setLayers((l) => ({ ...l, [key]: !l[key] }))}
                  >
                    {LAYER_LABEL[key]}
                  </Button>
                ))}
              </div>
              <AppMap data={data} people={people.data} participants={participants} selectedId={selectedId} layers={layers} onSelect={setSelectedId} />
              <ul className="aix-legend" aria-label="Map key">
                <li>
                  <span className="aix-key aix-key--real" aria-hidden="true" />
                  Real phone
                </li>
                <li>
                  <span className="aix-key aix-key--sim" aria-hidden="true" />
                  Simulated person
                </li>
                <li>
                  <span className="aix-key aix-key--leave" aria-hidden="true" />
                  Leave now
                </li>
                <li>
                  <span className="aix-key aix-key--ready" aria-hidden="true" />
                  Get ready
                </li>
                <li>
                  <span className="aix-key aix-key--fire" aria-hidden="true" />
                  Fire ({data.fire.method === "satellite_perimeter" ? "satellite outline" : data.fire.method === "model_nowcast" ? "model estimate" : "none yet"})
                </li>
                <li>
                  <span className="aix-key aix-key--closed" aria-hidden="true" />
                  Road closed
                </li>
              </ul>
              <p className="aix-note">
                Practice data. The fire and everyone not on our app are estimates; the dotted roads are where they drive. A
                simulated person's position is approximate.
              </p>
            </Panel>

            <div className="aix-side">
              <NeedsOk
                data={data}
                people={people.data}
                participants={participants}
                busy={busy}
                error={actionError}
                onDecide={decide}
                approve={(id) => approveProposal(token!, id)}
                reject={(id) => rejectProposal(token!, id)}
                assignHelp={(id) => helpAction(token!, id, "assign", null)}
                acknowledgeHelp={(id) => helpAction(token!, id, "acknowledge")}
                nowMs={nowMs}
              />
              <MessagesPanel messages={roster.data?.messages ?? []} loading={roster.loading} />
            </div>
          </div>

          <div className="aix-bottom">
            <Panel compact className="aix-sees" aria-label="What their phone shows">
              <div className="aix-sees-text">
                <h2>{selected ? `What ${selected.name} sees` : "What their phone shows"}</h2>
                {selected ? (
                  <>
                    <p className="aix-dim">Their screen right now. Pick someone on the left to switch.</p>
                    <p>{personSummary(selected, data)}</p>
                    {selected.behaviour?.narrative?.length ? (
                      <ul className="aix-story" aria-label="What they did">
                        {selected.behaviour.narrative.map((line, i) => (
                          <li key={i}>{line}</li>
                        ))}
                      </ul>
                    ) : null}
                  </>
                ) : (
                  <p className="aix-dim">Pick someone on the left to see their phone.</p>
                )}
              </div>
              {selected ? <PhoneMirror key={selected.id} incidentId={incidentId} participantId={selected.id} /> : null}
            </Panel>
            <BehaviourPanel participants={participants} onAdd={() => void addSimulated()} adding={adding} />
          </div>
        </>
      ) : null}
    </Page>
  );
}
