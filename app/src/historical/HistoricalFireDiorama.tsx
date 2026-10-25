import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useMediaQuery } from "../diorama/ui/format";
import { BurnedGlyph, FireEdgeGlyph, StationBadgeGlyph } from "../diorama/ui/glyphs";
import { FireDioramaScene } from "../fire/diorama/FireDioramaScene";
import type { DioramaRun, FireDioramaSceneApi } from "../fire/diorama/types";
import { formatDuration } from "../fire/ui/format";
import {
  PLAYBACK_SPEEDS,
  useFirePlayback,
  type PlaybackSpeed,
} from "../fire/useFirePlayback";
import {
  Button,
  EvidenceTag,
  IconButton,
  Legend,
  Notice,
  SegmentedControl,
  Spinner,
  type SegmentedOption,
} from "../ui";
import { OBSERVED_ARRIVAL_LABEL } from "./arrivalFromPerimeters";
import { useHistoricalFireIndex } from "./data";
import { errorMessage, useHistoricalFireData, type FireLayer } from "./useHistoricalFireData";
import "./historical.css";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const HOUR = 60;
const DAY = 24 * HOUR;
/** Step for the arrow keys and the step buttons on the slider. */
const SEEK_STEP_MINUTES = 30;
/** `DioramaRun.scenario.stepMinutes`: only sizes the glow band of the burning edge. */
const DIORAMA_STEP_MINUTES = 60;

type Layer = FireLayer;
type Window = "day" | "three-days" | "all";

const SPEED_OPTIONS: readonly SegmentedOption<string>[] = PLAYBACK_SPEEDS.map((value) => ({
  value: String(value),
  label: `${value}×`,
}));

function formatLocal(t0: string, minutes: number, timeZone: string): string {
  const at = new Date(Date.parse(t0) + minutes * 60_000);
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(at);
}

function formatKm2(value: number): string {
  return `${value.toFixed(value < 10 ? 1 : 0)} km²`;
}

/** Elapsed time since t0: "5 h 40 min" or "2 d 3 h". */
function formatElapsed(minutes: number): string {
  if (minutes < 2 * DAY) return formatDuration(minutes);
  const days = Math.floor(minutes / DAY);
  const hours = Math.round((minutes - days * DAY) / HOUR);
  return hours ? `${days} d ${hours} h` : `${days} d`;
}

type Props = {
  fireId: string;
  /** Switch to another historical fire. */
  onSelectFire: (id: string) => void;
  /** Leave the historical view (back to the spread simulator). */
  onExit: () => void;
};

/**
 * A real fire as a 3D diorama: LANDFIRE fuels and terrain around the fire, with the observed
 * FEDS perimeters turned into an arrival-time raster (interpolated between snapshots), played
 * back on a slider. Optionally swaps in the replay bundle's simulated run, labelled simulated.
 */
export default function HistoricalFireDiorama({ fireId, onSelectFire, onExit }: Props) {
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const index = useHistoricalFireIndex();
  const [layer, setLayer] = useState<Layer>("observed");
  const [windowChoice, setWindowChoice] = useState<Window>("three-days");
  const [scene, setScene] = useState<FireDioramaSceneApi | null>(null);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<FireDioramaSceneApi | null>(null);

  const { fire, landscape, simulated, observed, simulatedArrival, retry } = useHistoricalFireData(
    fireId,
    layer,
  );
  const simulatedFile = fire.status === "ready" ? fire.value.simulated_file : null;
  const grid = landscape.status === "ready" ? landscape.value : null;
  const fireData = fire.status === "ready" ? fire.value : null;
  // Another fire starts on the observed layer.
  useEffect(() => setLayer("observed"), [fireId]);

  const windowOptions = useMemo((): SegmentedOption<Window>[] => {
    const full = observed?.horizonMinutes ?? Infinity;
    return [
      { value: "day", label: "First day", disabled: full <= DAY },
      { value: "three-days", label: "3 days", disabled: full <= 3 * DAY },
      { value: "all", label: "Whole fire" },
    ];
  }, [observed]);
  const effectiveWindow =
    windowOptions.find((o) => o.value === windowChoice && !o.disabled)?.value ?? "all";

  const showSimulated = layer === "simulated" && simulatedArrival !== null;
  const horizonMinutes = showSimulated
    ? Math.max(HOUR, Math.ceil(simulatedArrival.lastMinute / 30) * 30)
    : observed
      ? effectiveWindow === "day"
        ? DAY
        : effectiveWindow === "three-days"
          ? 3 * DAY
          : observed.horizonMinutes
      : DAY;

  const run = useMemo((): DioramaRun | null => {
    const arrivalMinutes = showSimulated ? simulatedArrival.arrival : observed?.arrivalMinutes;
    if (!arrivalMinutes) return null;
    return {
      arrivalMinutes,
      scenario: { horizonMinutes, stepMinutes: DIORAMA_STEP_MINUTES },
    };
  }, [showSimulated, simulatedArrival, observed, horizonMinutes]);

  // Burned area at the slider time, from the drawn raster.
  const sortedArrival = useMemo(() => {
    if (!run) return null;
    const finite = run.arrivalMinutes.filter((v) => Number.isFinite(v));
    return finite.sort();
  }, [run]);

  // Scene lifecycle.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let created: FireDioramaSceneApi;
    try {
      created = new FireDioramaScene(host, { reducedMotion });
    } catch (cause) {
      setSceneError(errorMessage(cause, "WebGL could not be initialised."));
      return;
    }
    created.setStationSuffix("today's station");
    sceneRef.current = created;
    setScene(created);
    return () => {
      sceneRef.current = null;
      setScene(null);
      created.dispose();
    };
    // The scene is built once; reduced motion is pushed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onTime = useCallback((minutes: number) => sceneRef.current?.setTime(minutes), []);
  const playback = useFirePlayback(horizonMinutes, onTime);
  const { seek, pause, getTime } = playback;

  useEffect(() => scene?.setReducedMotion(reducedMotion), [scene, reducedMotion]);
  // No wind is recorded with the perimeters, so the scene's wind arrow would invent one.
  useEffect(() => scene?.setWindVisible(false), [scene]);
  useEffect(() => scene?.setLandscape(grid), [scene, grid]);
  useEffect(() => {
    scene?.setRun(run);
    scene?.setTime(getTime());
  }, [scene, run, getTime]);
  useEffect(() => {
    scene?.setIgnitions(
      fireData
        ? fireData.ignitions.map((ig) => ({
            id: ig.id,
            point: { longitude: ig.coord[0], latitude: ig.coord[1] },
            label: fireData.ignitions.length > 1 ? ig.name : "",
          }))
        : [],
    );
  }, [scene, fireData]);
  // A new fire starts paused at ignition with the whole board in view.
  useEffect(() => {
    pause();
    seek(0);
  }, [fireId, pause, seek]);
  useEffect(() => {
    if (scene && grid) scene.resetView(false);
  }, [scene, grid]);

  // Keep the camera framing clear of the floating panels.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !scene) return;
    const measure = () => {
      const box = stage.getBoundingClientRect();
      let left = 0;
      let bottom = 0;
      for (const el of Array.from(stage.querySelectorAll<HTMLElement>("[data-hf-inset]"))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (el.dataset.hfInset === "left") left = Math.max(left, r.right - box.left);
        else bottom = Math.max(bottom, box.bottom - r.top);
      }
      scene.setViewInsets({ top: 0, right: 0, bottom, left });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    for (const el of Array.from(stage.querySelectorAll<HTMLElement>("[data-hf-inset]")))
      observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [scene, panelOpen]);

  const t = Math.min(playback.t, horizonMinutes);
  const cellKm2 = grid ? (grid.groundCellSizeMeters * grid.groundCellSizeMeters) / 1e6 : 0;
  let burnedKm2 = 0;
  if (sortedArrival) {
    let lo = 0;
    let hi = sortedArrival.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedArrival[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    burnedKm2 = lo * cellKm2;
  }
  const snapshots = fireData?.perimeters.snapshots ?? [];
  let latest: (typeof snapshots)[number] | null = null;
  for (const s of snapshots) if (s.minute <= t) latest = s;
  const next = snapshots.find((s) => s.minute > t) ?? null;
  const snapshotTicks = showSimulated
    ? []
    : snapshots.filter((s) => s.minute <= horizonMinutes).map((s) => s.minute);
  const labelEvery = horizonMinutes <= 12 * HOUR ? 2 * HOUR : horizonMinutes <= 3 * DAY ? 12 * HOUR : DAY;
  const labelMarks = Array.from(
    { length: Math.floor(horizonMinutes / labelEvery) + 1 },
    (_, i) => i * labelEvery,
  );
  const fires = index.status === "ready" ? index.index.fires : [];
  const loadingText =
    fire.status === "loading"
      ? "Loading the fire record…"
      : landscape.status === "loading" && fireData
        ? `Sculpting terrain from LANDFIRE fuels and elevation… ${(fireData.board.radius_m / 1000).toFixed(1)} km radius · ${fireData.board.cell_m} m cells`
        : null;
  const ready = run !== null;

  const onSliderKey = (event: KeyboardEvent<HTMLInputElement>) => {
    const step = event.shiftKey ? 6 * HOUR : SEEK_STEP_MINUTES;
    const now = playback.getTime();
    let target: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") target = now - step;
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") target = now + step;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = horizonMinutes;
    if (target === null) return;
    event.preventDefault();
    playback.pause();
    playback.seek(target);
  };

  return (
    <div className="fr-stage hf-stage" ref={stageRef}>
      <div
        className="fr-scene"
        ref={hostRef}
        role="group"
        aria-label={fireData ? `3D landscape of the ${fireData.name}` : "3D landscape"}
      />

      {sceneError && (
        <div className="fr-error fr-panel" role="alert">
          <p className="fr-error-title">3D view unavailable in this browser</p>
          <p>The diorama needs WebGL, which appears to be disabled or unsupported here.</p>
          <p className="fr-error-detail">{sceneError}</p>
        </div>
      )}

      {loadingText && !sceneError && (
        <div className="fr-veil" role="status">
          <Spinner size="lg" />
          <p>{loadingText}</p>
        </div>
      )}

      {(fire.status === "error" || landscape.status === "error") && (
        <div className="fr-error fr-panel" role="alert">
          <p className="fr-error-title">This fire could not be loaded</p>
          <p>
            {fire.status === "error"
              ? fire.message
              : landscape.status === "error"
                ? landscape.message
                : ""}
          </p>
          <div className="fr-error-actions">
            <Button onClick={retry}>Retry</Button>
            <Button variant="secondary" onClick={onExit}>
              Back to simulator
            </Button>
          </div>
        </div>
      )}

      <div className="fr-overlay">
        <section
          className="fr-scenario fr-panel hf-panel"
          aria-labelledby="hf-title"
          data-hf-inset="left"
        >
          <header className="fr-scenario-head">
            <h1 id="hf-title">{fireData?.name ?? "Historical fire"}</h1>
            <IconButton
              label={panelOpen ? "Collapse panel" : "Expand panel"}
              aria-expanded={panelOpen}
              aria-controls="hf-body"
              onClick={() => setPanelOpen((v) => !v)}
            >
              <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                <path
                  d={panelOpen ? "M2.5 4.5 6 8l3.5-3.5" : "M2.5 7.5 6 4l3.5 3.5"}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
              </svg>
            </IconButton>
          </header>
          <div className="fr-scenario-body" id="hf-body" hidden={!panelOpen}>
            <div className="fr-field">
              <label htmlFor="hf-fire">Historical fire</label>
              <div className="hf-row">
                <select
                  id="hf-fire"
                  className="ui-input"
                  value={fireId}
                  onChange={(event) => onSelectFire(event.target.value)}
                >
                  {fires.length === 0 && <option value={fireId}>{fireData?.name ?? fireId}</option>}
                  {fires.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
                <Button variant="secondary" size="sm" onClick={onExit}>
                  Simulator
                </Button>
              </div>
              {fireData && <p className="hf-muted">{fireData.place}</p>}
            </div>

            <div className="fr-field">
              <span className="fr-field-title">Fire layer</span>
              <SegmentedControl
                label="Fire layer"
                options={[
                  { value: "observed", label: "Observed" },
                  {
                    value: "simulated",
                    label: "Simulated",
                    disabled: !simulatedFile,
                    title: simulatedFile
                      ? "Model run from the replay bundle"
                      : "No simulated run was built for this fire",
                  },
                ]}
                value={layer}
                onChange={(value) => {
                  setLayer(value);
                  pause();
                  seek(0);
                }}
              />
            </div>

            {layer === "observed" && (
              <div className="fr-field">
                <span className="fr-field-title">Time window</span>
                <SegmentedControl
                  label="Time window"
                  options={windowOptions}
                  value={effectiveWindow}
                  onChange={setWindowChoice}
                />
              </div>
            )}

            {fireData && layer === "observed" && (
              <div className="hf-readout">
                <p className="hf-tagline">
                  <EvidenceTag kind="observed" /> {OBSERVED_ARRIVAL_LABEL}
                </p>
                <dl className="hf-facts">
                  <dt>Burned by now</dt>
                  <dd>{ready ? `${formatKm2(burnedKm2)} (interpolated)` : "…"}</dd>
                  <dt>Last observed perimeter</dt>
                  <dd>
                    {latest
                      ? `${formatLocal(fireData.t0, latest.minute, fireData.timezone)} · ${formatKm2(latest.area_km2)}`
                      : "None yet: before the first snapshot"}
                  </dd>
                  <dt>Next perimeter</dt>
                  <dd>
                    {next
                      ? `${formatLocal(fireData.t0, next.minute, fireData.timezone)} · ${formatKm2(next.area_km2)}`
                      : "None: last snapshot shown"}
                  </dd>
                  <dt>Ignition</dt>
                  <dd>
                    {fireData.ignitions
                      .map((ig) => `${ig.name}: ${formatLocal(fireData.t0, ig.minute, fireData.timezone)} (${ig.evidence_class})`)
                      .join("; ")}
                  </dd>
                </dl>
                <Notice compact>
                  Perimeters are NASA FEDS satellite estimates snapped to local noon or midnight
                  (half-day precision); the front between them is interpolated, not observed.
                </Notice>
              </div>
            )}

            {layer === "simulated" && (
              <div className="hf-readout">
                {simulated?.status === "loading" && (
                  <p className="hf-muted" role="status">
                    <Spinner /> Loading the simulated run…
                  </p>
                )}
                {simulated?.status === "error" && (
                  <Notice tone="danger" compact>
                    {simulated.message}
                  </Notice>
                )}
                {simulated?.status === "ready" && (
                  <>
                    <p className="hf-tagline">
                      <EvidenceTag kind="simulated" /> Model run, not observed
                    </p>
                    <dl className="hf-facts">
                      <dt>Model</dt>
                      <dd>
                        {simulated.value.model.id ?? "unknown"}
                        {simulated.value.model.version ? ` ${simulated.value.model.version}` : ""}
                      </dd>
                      <dt>Burned by now</dt>
                      <dd>{ready ? `${formatKm2(burnedKm2)} (simulated)` : "…"}</dd>
                      <dt>Covers</dt>
                      <dd>
                        {simulatedArrival
                          ? `0 to ${formatElapsed(simulatedArrival.lastMinute)} after ignition`
                          : "…"}
                      </dd>
                      {simulated.value.calibration_headline && (
                        <>
                          <dt>Fit</dt>
                          <dd>{simulated.value.calibration_headline}</dd>
                        </>
                      )}
                    </dl>
                    <Notice compact>
                      Model output from the historical replay, shown only for its own run window.
                      Compare it with the observed layer; it is not a record of the fire.
                    </Notice>
                  </>
                )}
              </div>
            )}

            {fireData && (
              <details className="hf-sources">
                <summary>Sources</summary>
                <ul>
                  {fireData.sources.map((source) => (
                    <li key={source.id}>
                      <a className="ui-text-link" href={source.documentation ?? source.url} target="_blank" rel="noreferrer">
                        {source.provider}
                      </a>{" "}
                      (fire {fireData.perimeters.feds_fire_id}; licence {source.license}; package
                      label: {fireData.perimeters.source_evidence_class.join(", ")})
                    </li>
                  ))}
                  {fireData.ignitions.map((ig) => (
                    <li key={ig.id}>
                      Ignition, {ig.name}: {ig.provenance}
                    </li>
                  ))}
                  <li>
                    Package <code>{fireData.package.path}</code>; geometry simplified to{" "}
                    {fireData.perimeters.simplified_tolerance_m} m.
                  </li>
                </ul>
              </details>
            )}
          </div>
        </section>

        <section className="fr-legend fr-panel hf-legend" aria-label="Legend">
          <Legend
            items={[
              { label: "Fire front at this time", color: "var(--ct-fire)", glyph: <FireEdgeGlyph /> },
              { label: "Burned by this time", color: "var(--ct-burned)", glyph: <BurnedGlyph /> },
              { label: "Ignition pin", color: "var(--ct-ink)", shape: "dot" },
              { label: "Fire station (today's station)", color: "#c8352a", glyph: <StationBadgeGlyph /> },
            ]}
          />
        </section>

        <section className="fr-dock fr-panel hf-dock" aria-label="Fire playback" data-hf-inset="bottom">
          <div className="fr-dock-buttons">
            <IconButton
              variant="primary"
              label={playback.playing ? "Pause" : "Play"}
              onClick={playback.toggle}
              disabled={!ready}
            >
              {playback.playing ? (
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4.5 2.5 13.5 8l-9 5.5z" />
                </svg>
              )}
            </IconButton>
            <IconButton variant="secondary" label="Restart" onClick={playback.restart} disabled={!ready}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
                <path
                  d="M3 2.5v3.2h3.2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </IconButton>
          </div>

          <div className="fr-scrub">
            <div className="fr-scrub-rail" aria-hidden="true">
              <span
                className="fr-scrub-fill"
                style={{ width: `${horizonMinutes > 0 ? (t / horizonMinutes) * 100 : 0}%` }}
              />
              {snapshotTicks.map((minutes) => (
                <span
                  key={minutes}
                  className="fr-scrub-tick is-hour hf-snapshot-tick"
                  style={{ left: `${(minutes / horizonMinutes) * 100}%` }}
                />
              ))}
            </div>
            <input
              type="range"
              className="fr-scrub-input"
              min={0}
              max={horizonMinutes}
              step="any"
              value={t}
              disabled={!ready}
              onChange={(event) => {
                playback.pause();
                playback.seek(Number(event.target.value));
              }}
              onKeyDown={onSliderKey}
              aria-label="Time since ignition"
              aria-valuetext={`${formatElapsed(t)} after ignition`}
            />
            <ol className="fr-scrub-labels" aria-label="Time since ignition">
              {labelMarks.map((minutes) => (
                <li key={minutes} style={{ left: `${(minutes / horizonMinutes) * 100}%` }}>
                  <button
                    type="button"
                    className="fr-scrub-label"
                    disabled={!ready}
                    onClick={() => {
                      playback.pause();
                      playback.seek(minutes);
                    }}
                    aria-label={`Jump to ${formatElapsed(minutes)} after ignition`}
                  >
                    {minutes === 0
                      ? "0"
                      : labelEvery >= DAY
                        ? `${minutes / DAY} d`
                        : `${minutes / HOUR} h`}
                  </button>
                </li>
              ))}
            </ol>
          </div>

          <p className="fr-time">
            <span className="fr-time-now">T+{formatElapsed(t)}</span>
            <span className="fr-time-total">
              {fireData ? formatLocal(fireData.t0, t, fireData.timezone) : ""}
            </span>
          </p>

          <div className="fr-dock-end">
            <SegmentedControl
              className="fr-speed"
              label="Playback speed"
              options={SPEED_OPTIONS}
              value={String(playback.speed)}
              onChange={(value) => playback.setSpeed(Number(value) as PlaybackSpeed)}
            />
            <Button
              variant="secondary"
              className="fr-dock-action"
              onClick={() => sceneRef.current?.resetView(true)}
              disabled={!scene || !ready}
            >
              Focus fire
            </Button>
          </div>
          <p className="fr-speed-note">
            {showSimulated ? (
              <>
                <EvidenceTag kind="simulated" /> Simulated run
              </>
            ) : (
              <>
                <EvidenceTag kind="observed" /> {OBSERVED_ARRIVAL_LABEL}
                {snapshotTicks.length ? " · tall ticks mark perimeter snapshots" : ""}
              </>
            )}
          </p>
        </section>
      </div>

      <p className="fr-attribution">
        Perimeters: NASA VEDA FEDS · Fuel: LANDFIRE · Terrain: AWS terrain tiles (USGS 3DEP and others)
        {showSimulated ? " · Fire layer: simulated" : ""}
      </p>
    </div>
  );
}
