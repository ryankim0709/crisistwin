/**
 * /run: one full-viewport scenario run. 1 Setup (curated Berkeley preset, published to the live
 * drill), 2 Baseline (the board runs with nobody acting; its score timeline is kept), 3 AI dispatch
 * (the board restarts on the same seed and the AI commander drives; the scoreboard compares both
 * runs at the same board minute). The 3D board, the AI and the scores are simulated; the board is
 * composed exactly as on /live (live/LiveCommandPage.tsx): active incident poll, useCommand,
 * useCommandBoard, useRoadClosures, useRunStateSync. This page writes nothing to the shared world
 * (no WorldBar, no size or weather changes).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, EmptyState, EvidenceTag, IconButton, LoadingState, Notice, Panel, Spinner, Tag } from "../ui";
import AgentInputsPanel from "../demo/AgentInputsPanel";
import DemoDiorama from "../demo/DemoDiorama";
import { BOARD_SPEED_STEPS, type BoardSpeed, type CommandBoard } from "../demo/useCommandBoard";
import { REALTIME_ROUTINE_GAP_MINUTES } from "../demo/useDemoAgent";
import { usePredictedFire } from "../demo/usePredictedFire";
import { useRunStateSync } from "../demo/useRunStateSync";
import type { RunTimeline } from "../demo/runContracts";
import { fetchActive } from "../live/active";
import { DEFAULT_INCIDENT_ID, INCIDENT_GONE_EVENT, drillAction, readToken } from "../live/api";
import { useCommand } from "../live/useCommand";
import { usePoll } from "../live/usePoll";
import { useFollowedPeople, type FollowedPerson } from "../live/followedPeople";
import { useRoadClosures } from "../live/useRoadClosures";
import "../demo/demo.css";
import { boardSeed, boardTimeline, hasRunModes, restartBoard, useRunBoard } from "./boardAdapter";
import { formatClock } from "./format";
import { PRESETS_ARE_CURATED, RUN_PRESETS } from "./optionalModules";
import { BERKELEY_REGION, publishScenario } from "./publishScenario";
import RunTimelineBar from "./RunTimelineBar";
import SetupPanel from "./SetupPanel";
import { draftFromPreset, type PrepareState, type RunPhase, type ScenarioDraft } from "./types";
import "./oneview.css";

const ACTIVE_POLL_MS = 5_000;
/** Baseline clock: board minutes per real minute (a fast, fixed pick; the fire solver still holds the clock while it solves). */
const BASELINE_SPEED: BoardSpeed = 120;
/**
 * AI dispatch clock: board minutes per real minute. The clock keeps running at this speed while
 * Claude decides (useCommandBoard aiPacing "realtime"; user decision 2026-10-25), so a 6 h run takes
 * about 6 real minutes plus fire-solver holds. UI choice.
 */
const AI_SPEED: BoardSpeed = 60;
/** The server drill clock's limit (app/backend/livecore/drill.py MAX_DRILL_SPEED). */
const MAX_DRILL_SPEED = 60;
/** A change of the wanted drill clock (running / speed) is posted only after it has held this long (Auto speed flips every time the agent starts or stops deciding); the first start goes out at once. */
const DRILL_DEBOUNCE_MS = 2_000;
const DRILL_START_DELAY_MS = 300;

const snapshotOf = (t: RunTimeline | null): RunTimeline | null => (t ? { ...t, points: t.points.slice() } : null);

type StepState = "todo" | "active" | "done";

function Step({ n, title, state, children }: { n: number; title: string; state: StepState; children?: React.ReactNode }) {
  return (
    <li className={`ov-step ov-step--${state}`} aria-current={state === "active" ? "step" : undefined}>
      <div className="ov-step-head">
        <span className="ov-step-n" aria-hidden="true">
          {state === "done" ? "✓" : n}
        </span>
        <h3>{title}</h3>
        <Tag tone={state === "done" ? "success" : state === "active" ? "brand" : "neutral"}>
          {state === "done" ? "Done" : state === "active" ? "Now" : "Next"}
        </Tag>
      </div>
      {children ? <div className="ov-step-body">{children}</div> : null}
    </li>
  );
}

/** Wall-clock now, refreshed every `ms` while `on` (display only: how long Claude has been deciding). */
function useNow(on: boolean, ms = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const id = window.setInterval(tick, ms);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [on, ms]);
  return now;
}

/** The AI step's pacing line: the board kept running while Claude decided ("decided in 14 s = 14 board min at 60×"). */
function AiPacingNote({ agent, minute, speed }: { agent: CommandBoard["agent"]; minute: number | null; speed: number }) {
  const thinking = agent.status === "thinking";
  const now = useNow(thinking);
  const input = agent.lastInput;
  const last = agent.decisions[0] ?? null;
  const refused = last ? last.applied.filter((a) => a.error !== null).length + last.rejected.length : 0;
  return (
    <>
      {thinking && input && minute !== null ? (
        <p className="ov-dim">
          Claude deciding for {Math.max(0, Math.round((now - input.sentAtMs) / 1000))} s on the {formatClock(input.minute)} board; the board
          kept running {Math.max(0, Math.floor(minute) - input.minute)} board min since
          {agent.queued === "urgent" ? "; an urgent follow-up is queued" : ""}.
        </p>
      ) : null}
      {last ? (
        <p className="ov-dim">
          Last decision: decided in {Math.round(last.latencyMs / 1000)} s = {Math.max(0, Math.floor(last.landedMinute) - last.minute)} board min
          at {speed}&times; (saw {formatClock(last.minute)}, orders landed {formatClock(last.landedMinute)}
          {refused > 0 ? `; ${refused} refused` : ""}). {agent.decisions.length} decision{agent.decisions.length === 1 ? "" : "s"} so far.
        </p>
      ) : null}
    </>
  );
}

function FollowedChips({ people }: { people: FollowedPerson[] }) {
  if (people.length === 0) return null;
  return (
    <div className="ov-follow" role="group" aria-label="Simulated people followed on phones">
      <span className="ov-follow-title">
        Phones following <EvidenceTag kind="simulated" />
      </span>
      <ul>
        {people.map((p) => (
          <li key={p.personId} className="ov-chip" title={p.destination ? `Heading to ${p.destination.name}` : p.status}>
            <strong>{p.label}</strong>
            <span>{p.status}</span>
            {p.followers > 1 ? <span>{p.followers} phones</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function OneViewPage() {
  const [token] = useState<string | null>(() => readToken());
  // The hosted instance's one active incident (re-read every 5 s and right after a switch).
  const active = usePoll(token, fetchActive, ACTIVE_POLL_MS, "Live API");
  const refreshActive = active.refresh;
  useEffect(() => {
    window.addEventListener(INCIDENT_GONE_EVENT, refreshActive);
    return () => window.removeEventListener(INCIDENT_GONE_EVENT, refreshActive);
  }, [refreshActive]);
  const incidentId = active.data?.incident_id ?? DEFAULT_INCIDENT_ID;
  const incidentToken = active.loading ? null : token;
  const command = useCommand(incidentToken, incidentId);
  const unauthorized = command.error?.unauthorized ?? false;
  const data = unauthorized ? null : command.data;

  const [phase, setPhase] = useState<RunPhase>("setup");
  // Each run's clock speed is the page's own pick (useCommandBoard `speed`), so /run never writes /live's saved Auto choice.
  const [baselineSpeed, setBaselineSpeed] = useState<BoardSpeed>(BASELINE_SPEED);
  const [aiSpeed, setAiSpeed] = useState<BoardSpeed>(AI_SPEED);
  const cb = useRunBoard({
    token,
    incidentId,
    data,
    studioBoardId: active.data?.region_id ?? null,
    runMode: phase === "ai" ? "ai" : "baseline",
    speed: phase === "ai" ? aiSpeed : phase === "baseline" ? baselineSpeed : null,
    // The AI step: the clock keeps running at aiSpeed while Claude decides (user decision 2026-10-25).
    aiPacing: "realtime",
  });
  // As on /live: controller road closures re-route the board, and the run state is saved for the server's simulated people.
  useRoadClosures({ token: unauthorized ? null : token, incidentId, board: cb.board, routes: cb.routes, bump: cb.bump });
  useRunStateSync({ token: unauthorized ? null : token, incidentId, board: cb.board, forecasts: cb.forecasts });
  // Simulated people phones follow (server live_virtual_people); drawn on the 3D board and listed in the top bar.
  const followed = useFollowedPeople(incidentId, unauthorized ? null : token).people;
  const cbRef = useRef(cb);
  useEffect(() => {
    cbRef.current = cb;
  });
  const board = cb.board;
  const predictedFire = usePredictedFire(board);
  const runModes = hasRunModes(cb);

  // ---- 1 Setup -------------------------------------------------------------------------------
  const [draft, setDraft] = useState<ScenarioDraft>(() => draftFromPreset(RUN_PRESETS[0]));
  const preset = RUN_PRESETS.find((p) => p.id === draft.presetId) ?? RUN_PRESETS[0];
  const horizon = draft.horizonMinutes;
  const [prepare, setPrepare] = useState<PrepareState>({ status: "idle" });
  const prepareAbort = useRef<AbortController | null>(null);
  useEffect(() => () => prepareAbort.current?.abort(), []);
  const onPrepare = () => {
    prepareAbort.current?.abort();
    const controller = new AbortController();
    prepareAbort.current = controller;
    void publishScenario(draft, preset, controller.signal, setPrepare).then(() => {
      if (!controller.signal.aborted) refreshActive();
    });
  };
  // The board holds still during Setup (the operator's Pause), so a published fire starts at T+0.
  useEffect(() => {
    if (phase === "setup") cbRef.current.setRunning(false);
  }, [phase, board]);
  const fireId = prepare.status === "done" ? prepare.fireId : null;
  const fireOnBoard = !!board && fireId !== null && board.studioFireIds.includes(fireId);
  // Both runs use the preset's seed: once the fire is on the board, restart it on that seed (same fire, T+0).
  const seedKick = useRef<string | null>(null);
  useEffect(() => {
    if (phase !== "setup" || !fireOnBoard || !board || !fireId || board.seed === draft.seed) return;
    if (seedKick.current === `${fireId}:${draft.seed}`) return;
    seedKick.current = `${fireId}:${draft.seed}`;
    restartBoard(cbRef.current, draft.seed);
  }, [phase, fireOnBoard, board, fireId, draft.seed]);
  const seedOk = !runModes || (board?.seed ?? null) === draft.seed;
  const ready = fireOnBoard && seedOk && (board?.minute ?? 1) === 0;

  // ---- 2 Baseline ----------------------------------------------------------------------------
  const live = boardTimeline(cb);
  const [baseline, setBaseline] = useState<RunTimeline | null>(null);
  const [ai, setAi] = useState<RunTimeline | null>(null);
  const [baselineDone, setBaselineDone] = useState(false);
  const [aiDone, setAiDone] = useState(false);
  const startBaseline = () => {
    setBaseline(null);
    setAi(null);
    setBaselineDone(false);
    setAiDone(false);
    setPhase("baseline");
    cb.setRunning(true);
  };
  const finishBaseline = useCallback(() => {
    const c = cbRef.current;
    c.setRunning(false);
    const t = boardTimeline(c);
    if (t && t.mode === "baseline") setBaseline(snapshotOf(t));
    setBaselineDone(true);
  }, []);

  // ---- 3 AI dispatch -------------------------------------------------------------------------
  const aiKick = useRef(false);
  const kickBoard = useRef<object | null>(null);
  const [aiNotice, setAiNotice] = useState<string | null>(null);
  const startAi = () => {
    aiKick.current = false;
    setAi(null);
    setAiDone(false);
    setAiNotice(null);
    setPhase("ai");
  };
  // After the board hook has re-rendered in "ai" mode: same seed, T+0, the agent on (it starts the clock).
  useEffect(() => {
    if (phase !== "ai" || aiKick.current) return;
    aiKick.current = true;
    const c = cbRef.current;
    // The baseline's board: the run-length check below waits for the restarted one.
    kickBoard.current = c.board;
    const seed = baseline?.seed ?? draft.seed;
    if (!restartBoard(c, seed)) setAiNotice("This build's board cannot restart on a chosen seed yet, so the AI run continues the current board.");
    c.setAutopilot(true);
  }, [phase, baseline, draft.seed]);
  const finishAi = useCallback(() => {
    const c = cbRef.current;
    c.setAutopilot(false);
    c.setRunning(false);
    const t = boardTimeline(c);
    if (t && t.mode === "ai") setAi(snapshotOf(t));
    setAiDone(true);
  }, []);

  // A run ends at the chosen run length.
  const minute = board?.minute ?? null;
  useEffect(() => {
    if (minute === null || minute < horizon) return;
    if (phase === "baseline" && !baselineDone) finishBaseline();
    if (phase === "ai" && !aiDone && aiKick.current && (board !== kickBoard.current || !runModes)) finishAi();
  }, [minute, horizon, phase, baselineDone, aiDone, finishBaseline, finishAi, board, runModes]);

  const startOver = () => {
    const c = cbRef.current;
    c.setAutopilot(false);
    c.setRunning(false);
    setPhase("setup");
    setBaselineDone(false);
    setAiDone(false);
    setBaseline(null);
    setAi(null);
    seedKick.current = null;
    restartBoard(c, draft.seed);
  };

  // ---- Server drill clock (AI phase): the server's simulated people move in step with the board.
  const drill = useRef<{ started: boolean; speed: number }>({ started: false, speed: 0 });
  const [drillNote, setDrillNote] = useState<string | null>(null);
  const aiRunning = phase === "ai" && !aiDone && cb.running;
  const drillWanted = aiRunning ? Math.min(MAX_DRILL_SPEED, cb.speed) : 0;
  useEffect(() => {
    if (!token || unauthorized) return;
    const id = window.setTimeout(() => {
      const d = drill.current;
      const fail = (e: unknown) => setDrillNote(`Server drill clock: ${e instanceof Error ? e.message : "request failed"}`);
      if (!d.started && drillWanted > 0) {
        d.started = true;
        d.speed = drillWanted;
        setDrillNote(null);
        drillAction(token, incidentId, { action: "start", speed: drillWanted }).catch(fail);
      } else if (d.started && d.speed !== drillWanted) {
        d.speed = drillWanted;
        drillAction(token, incidentId, { action: "set_speed", speed: drillWanted }).catch(fail);
      }
    }, drill.current.started ? DRILL_DEBOUNCE_MS : DRILL_START_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [drillWanted, token, unauthorized, incidentId]);
  // A new AI run (or Start over) re-anchors the drill clock at T+0 with "start".
  useEffect(() => {
    if (phase === "ai") return;
    const d = drill.current;
    if (d.started && token) {
      if (d.speed !== 0) drillAction(token, incidentId, { action: "set_speed", speed: 0 }).catch(() => undefined);
    }
    drill.current = { started: false, speed: 0 };
  }, [phase, token, incidentId]);
  useEffect(
    () => () => {
      const d = drill.current;
      if (d.started && d.speed !== 0 && token) drillAction(token, incidentId, { action: "set_speed", speed: 0 }).catch(() => undefined);
    },
    [token, incidentId],
  );

  // ---- What the bottom bar compares
  const liveBaseline = phase === "baseline" && live?.mode === "baseline" ? live : null;
  const liveAi = phase === "ai" && live?.mode === "ai" ? live : null;
  const baselineShown = baselineDone ? baseline : (liveBaseline ?? baseline);
  const aiShown = aiDone ? ai : (liveAi ?? ai);
  const canPlay = !!board && ((phase === "baseline" && !baselineDone) || (phase === "ai" && !aiDone));
  const onPlayPause = () => cb.setRunning(!cb.running);

  // ---- Status lines
  const isBerkeley = (active.data?.region_id ?? "").split("@")[0] === BERKELEY_REGION;
  const drillName = active.data?.name ?? incidentId;
  let stage: React.ReactNode = null;
  if (unauthorized) {
    stage = (
      <EmptyState title="The live server refused this page">
        Open <a className="ui-text-link" href="/live">Live command</a> once to enter the controller token, then come back.
      </EmptyState>
    );
  } else if (!data) {
    stage = command.error ? (
      <Notice tone="danger" title="Live drill unavailable">
        {command.error.message}{" "}
        <Button size="sm" variant="secondary" onClick={command.refresh}>
          Retry
        </Button>
      </Notice>
    ) : (
      <LoadingState>Loading the live drill&hellip;</LoadingState>
    );
  } else if (!board) {
    stage = cb.environment.error ? (
      <Notice tone="danger" title="The board's landscape did not load">
        {String(cb.environment.error)}{" "}
        <Button size="sm" variant="secondary" onClick={cb.retryEnvironment}>
          Retry
        </Button>
      </Notice>
    ) : (
      <LoadingState>Building the simulated board for {drillName}&hellip;</LoadingState>
    );
  } else if (!cb.landscape) {
    stage = (
      <EmptyState title="No 3D landscape covers this drill">
        The live drill is {drillName}. Prepare a Berkeley Hills &amp; Tilden scenario to switch to a drill with a prebuilt 3D landscape.
      </EmptyState>
    );
  }

  return (
    <main className="ov-root" id="main-content" tabIndex={-1}>
      <h1 className="ov-sr">Scenario run: baseline vs AI dispatch (simulated)</h1>
      <div className="ov-stage">
        {board && cb.landscape ? (
          <DemoDiorama
            board={board}
            version={cb.version}
            field={cb.field}
            landscape={cb.landscape}
            regionName={board.env.landscapeRegion?.name ?? null}
            forecasts={cb.forecasts}
            wind={cb.windNow}
            selected={cb.selection}
            followed={followed}
            predictedFire={predictedFire}
          />
        ) : (
          <div className="ov-stage-msg">{stage}</div>
        )}
      </div>

      <div className="ov-topbar">
        <a className="ov-home" href="/live" aria-label="Back to Live command">
          CrisisTwin
        </a>
        <span className="ov-title">Scenario run</span>
        <EvidenceTag kind="simulated" />
        <span className="ov-dim ov-drill">
          {/* A stored package is reused for any preset on its board, so its name can belong to another preset. */}
          {isBerkeley
            ? `Berkeley Hills & Tilden board${fireId !== null ? ` · ${preset.label}` : ""}`
            : `Live drill: ${drillName} (not Berkeley yet)`}
        </span>
        <FollowedChips people={followed} />
      </div>

      <Panel glass compact className="ov-panel ov-left" aria-label="Run steps">
        <ol className="ov-steps">
          <Step n={1} title="Setup" state={phase === "setup" ? "active" : "done"}>
            {phase === "setup" ? (
              <>
                {!PRESETS_ARE_CURATED ? (
                  <Notice tone="info" compact>
                    Curated presets are not in this build yet; a stand-in Berkeley preset (assumed values) is shown.
                  </Notice>
                ) : null}
                <SetupPanel
                  presets={RUN_PRESETS}
                  draft={draft}
                  onChange={(d) => {
                    setDraft(d);
                    if (prepare.status === "done" || prepare.status === "failed") setPrepare({ status: "idle" });
                  }}
                  onPrepare={onPrepare}
                  prepare={prepare}
                  disabled={!token || unauthorized}
                />
                {prepare.status === "done" && !ready ? (
                  <p className="ov-status" role="status">
                    <Spinner /> Waiting for the board to take the fire{runModes ? " and the preset seed" : ""}&hellip;
                  </p>
                ) : null}
              </>
            ) : (
              <p className="ov-dim">
                {preset.label} &middot; seed {boardSeed(cb) ?? draft.seed}
              </p>
            )}
          </Step>
          <Step n={2} title="Baseline: nobody acts" state={phase === "setup" ? "todo" : phase === "baseline" && !baselineDone ? "active" : "done"}>
            <p className="ov-dim">No firefighting, no evacuation orders: the fire and traffic run on their own.</p>
            {phase === "setup" ? (
              <Button onClick={startBaseline} disabled={!ready}>
                Run baseline
              </Button>
            ) : phase === "baseline" && !baselineDone ? (
              <>
                <p className="ov-status" role="status">
                  {cb.running ? <Spinner /> : null} {formatClock(minute)} of {formatClock(horizon)} at {cb.speed}&times;
                </p>
                <Button variant="secondary" size="sm" onClick={finishBaseline}>
                  Stop and keep this baseline
                </Button>
              </>
            ) : (
              <p className="ov-dim">
                Recorded to {formatClock(baseline?.points.at(-1)?.minute ?? null)}
                {baseline ? "" : " (no score timeline in this build)"}.
              </p>
            )}
            {!runModes && phase !== "ai" ? (
              <Notice tone="warning" compact>
                This build&rsquo;s board has no baseline mode yet: its clock only runs with the AI agent on.
              </Notice>
            ) : null}
          </Step>
          <Step n={3} title="AI dispatch" state={phase === "ai" ? (aiDone ? "done" : "active") : "todo"}>
            <p className="ov-dim">
              Same seed and fire; the AI commander dispatches units and orders evacuations. The clock keeps running at {aiSpeed}&times; while
              Claude decides, like a dispatcher under time pressure: its orders apply at the board minute they arrive. New fires, zones too
              late and life-threat calls call it at once; other reviews come at most every {REALTIME_ROUTINE_GAP_MINUTES} board min.
            </p>
            {phase !== "ai" ? (
              <Button onClick={startAi} disabled={!baselineDone}>
                Run AI dispatch
              </Button>
            ) : !aiDone ? (
              <>
                <p className="ov-status" role="status">
                  {cb.running ? <Spinner /> : null} {formatClock(minute)} of {formatClock(horizon)} at {cb.speed}&times; &middot; agent{" "}
                  {cb.agent.status}
                </p>
                <AiPacingNote agent={cb.agent} minute={minute} speed={cb.speed} />
                <Button variant="secondary" size="sm" onClick={finishAi}>
                  Stop the AI run
                </Button>
              </>
            ) : (
              <>
                <p className="ov-dim">Finished at {formatClock(minute)}.</p>
                <AiPacingNote agent={cb.agent} minute={minute} speed={cb.speed} />
              </>
            )}
            {aiNotice ? (
              <Notice tone="warning" compact>
                {aiNotice}
              </Notice>
            ) : null}
            {phase === "ai" && cb.agent.error ? (
              <Notice tone="danger" compact>
                AI agent: {cb.agent.error}
              </Notice>
            ) : null}
            {phase === "ai" && drillWanted > 0 ? (
              <p className="ov-dim">
                Server simulated people run at {drillWanted}&times;
                {cb.speed > MAX_DRILL_SPEED ? ` (the server caps it at ${MAX_DRILL_SPEED}×; the board runs faster)` : ""}.
              </p>
            ) : null}
            {drillNote ? (
              <Notice tone="warning" compact>
                {drillNote}
              </Notice>
            ) : null}
            <p className="ov-foot">
              Not bit-reproducible: the seed fixes the fire, wind, people and units, but Claude&rsquo;s response time varies from call to call,
              so its orders land at different board minutes (and it sees a different board) on every AI run. The baseline replays exactly on its
              seed.
            </p>
          </Step>
        </ol>
        {phase !== "setup" ? (
          <div className="ov-actions">
            <Button variant="ghost" size="sm" onClick={startOver}>
              Start over
            </Button>
          </div>
        ) : null}
        {cb.notice ? (
          <div className="ov-notice">
            <Notice tone="warning" compact>
              {cb.notice}
            </Notice>
            <IconButton label="Dismiss" size="sm" variant="ghost" onClick={() => cb.setNotice(null)}>
              &times;
            </IconButton>
          </div>
        ) : null}
        <p className="ov-foot">
          Planning experiment on a simulated board: fires, units, people and the AI&rsquo;s actions are simulated. Not operational guidance.
        </p>
      </Panel>

      <Panel glass compact className="ov-panel ov-right" title="What the agent sees" aside={<EvidenceTag kind="simulated" />}>
        <AgentInputsPanel agent={cb.agent} board={board} forecasts={cb.forecasts} phase={phase} embedded />

      </Panel>

      <Panel glass compact className="ov-panel ov-bottom" aria-label="Clock and scoreboard">
        <RunTimelineBar
          phase={phase}
          minute={minute}
          horizonMinutes={horizon}
          running={cb.running}
          canPlay={canPlay}
          onPlayPause={onPlayPause}
          speed={cb.speed}
          speedSteps={BOARD_SPEED_STEPS}
          onSpeed={(s) => {
            if (!BOARD_SPEED_STEPS.some((v) => v === s)) return;
            if (phase === "ai") setAiSpeed(s as BoardSpeed);
            else if (phase === "baseline") setBaselineSpeed(s as BoardSpeed);
            else cb.setSpeed(s as BoardSpeed);
          }}
          autoSpeed={null}
          onAutoSpeed={null}
          baseline={baselineShown}
          ai={aiShown}
          baselineDone={baselineDone}
        />
      </Panel>
    </main>
  );
}
