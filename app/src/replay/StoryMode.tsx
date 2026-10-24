import { useCallback, useEffect, useRef, useState } from "react";
import { CaveatChip } from "./CompareTab";
import { VARIANT_CAVEATS } from "./compare";
import { EvidenceChip } from "./parts";
import type { Chapter, RevealRow } from "./story";
import { localTime } from "./timeline";
import type { EvidenceClass, LngLat, TrafficMetrics } from "./types";

/** How long a chapter stays on screen before autoplay moves on. */
const HOLD_MS = 11_000;
/** Wall seconds the clock takes to run into a chapter. */
const TRAVEL_S = 4;
/** Longer gaps are skipped: the clock jumps to this much sim time before the chapter, then runs. */
const MAX_RUN_IN_MS = 40 * 60_000;
const MIN_SPEED = 60;
/** Keep the framed area clear of the story card (right) and the HUD and dock. */
const FOCUS_PADDING = { top: 150, bottom: 190, left: 80, right: 450 };

export interface StoryModeProps {
  chapters: Chapter[];
  revealRows: RevealRow[];
  simTimeMs: number;
  timezone: string;
  metrics: TrafficMetrics | null;
  trafficEvidence: EvidenceClass | null;
  /** Demand tag shown with the live counts, e.g. "CENSUS DEMAND (DERIVED)". */
  demandLabel: string | null;
  /** Run the clock to `ms` at `speed` (sim s per wall s), then call onArrive. */
  playTo: (ms: number, speed: number, onArrive: () => void) => void;
  seek: (ms: number) => void;
  focus: (coords: LngLat[], padding: typeof FOCUS_PADDING) => void;
  onShowVariant: (id: string) => void;
  onClose: () => void;
  /** Paused by the user (dock button, Space or the card's Pause): no auto-advance, no run-in. */
  paused: boolean;
  onTogglePause: () => void;
  /** Bumped when the user resumes, to re-enter the current chapter (finish its run-in, then hold). */
  resumeKey: number;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** Guided autoplay through bundle-anchored chapters; the camera and clock follow each one. */
export default function StoryMode({
  chapters,
  revealRows,
  simTimeMs,
  timezone,
  metrics,
  trafficEvidence,
  demandLabel,
  playTo,
  seek,
  focus,
  onShowVariant,
  onClose,
  paused,
  onTogglePause,
  resumeKey,
}: StoryModeProps) {
  const [index, setIndex] = useState(0);
  const [arrived, setArrived] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef(simTimeMs);
  useEffect(() => {
    timeRef.current = simTimeMs;
  }, [simTimeMs]);
  const chapter = chapters[index];
  const last = index === chapters.length - 1;

  const goTo = useCallback(
    (i: number) => {
      const ch = chapters[i];
      if (!ch) return;
      setIndex(i);
      setArrived(false);
      if (ch.focus.length > 0) focus(ch.focus, FOCUS_PADDING);
      if (ch.reveal) {
        seek(ch.atMs);
        setArrived(true);
        return;
      }
      let ahead = ch.atMs - timeRef.current;
      if (ahead <= 60_000) {
        seek(ch.atMs);
        setArrived(true);
        return;
      }
      if (ahead > MAX_RUN_IN_MS) {
        seek(ch.atMs - MAX_RUN_IN_MS);
        ahead = MAX_RUN_IN_MS;
      }
      const speed = Math.max(MIN_SPEED, ahead / 1000 / TRAVEL_S);
      playTo(ch.atMs, speed, () => setArrived(true));
    },
    [chapters, focus, playTo, seek],
  );

  // Start from the first chapter when opened (deferred so StrictMode's remount runs it once).
  const goToRef = useRef(goTo);
  useEffect(() => {
    goToRef.current = goTo;
  }, [goTo]);
  useEffect(() => {
    cardRef.current?.focus();
    const timer = window.setTimeout(() => goToRef.current(0), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (paused || !arrived || last) return;
    const timer = window.setTimeout(() => goTo(index + 1), HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [paused, arrived, last, index, goTo]);

  // Resume: re-enter the current chapter, which finishes an interrupted run-in or holds.
  const indexRef = useRef(index);
  useEffect(() => {
    indexRef.current = index;
  }, [index]);
  useEffect(() => {
    if (resumeKey === 0) return;
    const timer = window.setTimeout(() => goToRef.current(indexRef.current), 0);
    return () => window.clearTimeout(timer);
  }, [resumeKey]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  if (!chapter) return null;
  const notOut = metrics ? metrics.notDepartedVeh + metrics.enRouteVeh : null;
  const total = metrics ? metrics.notDepartedVeh + metrics.enRouteVeh + metrics.arrivedVeh : null;
  const maxBar = Math.max(100, ...revealRows.map((r) => r.exposurePct));

  return (
    <section
      ref={cardRef}
      className={`rp-story${chapter.reveal ? " rp-story--reveal" : ""}`}
      aria-label="Story mode"
      aria-roledescription="guided story"
      tabIndex={-1}
    >
      <header className="rp-story-head">
        <span className="rp-story-count">
          Story · {index + 1} / {chapters.length}
        </span>
        <button
          type="button"
          className="rp-story-close"
          onClick={onClose}
          aria-label="Close story mode"
        >
          ×
        </button>
      </header>
      <ol className="rp-story-dots" aria-label="Chapters">
        {chapters.map((c, i) => (
          <li key={c.id}>
            <button
              type="button"
              aria-label={`Chapter ${i + 1}: ${c.title}`}
              aria-current={i === index ? "step" : undefined}
              className={i < index ? "rp-story-dot--done" : undefined}
              onClick={() => goTo(i)}
            />
          </li>
        ))}
      </ol>

      <div aria-live="polite">
        {!chapter.reveal && (
          <p className="rp-story-when">
            {localTime(chapter.atMs, timezone)}
            {paused ? (
              <span className="rp-dim"> · paused</span>
            ) : (
              !arrived && <span className="rp-dim"> · clock running…</span>
            )}
          </p>
        )}
        <h2 className="rp-story-title">{chapter.title}</h2>
        <p className="rp-story-body">
          <EvidenceChip value={chapter.evidence} /> {chapter.body}
        </p>
      </div>

      {chapter.reveal ? (
        <div className="rp-reveal">
          <div className="rp-reveal-row rp-reveal-row--base">
            <span className="rp-reveal-name">
              Baseline run
              {revealRows[0]?.arrivedBaseline != null && (
                <small>{fmt(revealRows[0].arrivedBaseline)} out by 10:00</small>
              )}
            </span>
            <span className="rp-reveal-bar" aria-hidden="true">
              <span style={{ width: `${(100 / maxBar) * 100}%` }} />
            </span>
            <span className="rp-reveal-value">100%</span>
          </div>
          {revealRows.map((r) => {
            const change = Math.round(r.exposurePct - 100);
            return (
              <button
                key={r.id}
                type="button"
                className="rp-reveal-row"
                onClick={() => onShowVariant(r.id)}
                title={VARIANT_CAVEATS[r.id]?.text ?? r.question}
                aria-label={`${r.title}: exposure ${Math.round(r.exposurePct)}% of the baseline${
                  VARIANT_CAVEATS[r.id]
                    ? ` (${VARIANT_CAVEATS[r.id].label}: ${VARIANT_CAVEATS[r.id].text})`
                    : ""
                }. Show on map.`}
              >
                <span className="rp-reveal-name">
                  {r.title}
                  {r.arrivedVariant !== null && <small>{fmt(r.arrivedVariant)} out by 10:00</small>}
                  <CaveatChip id={r.id} />
                </span>
                <span className="rp-reveal-bar" aria-hidden="true">
                  <span style={{ width: `${(r.exposurePct / maxBar) * 100}%` }} />
                </span>
                <span className="rp-reveal-value">
                  {Math.round(r.exposurePct)}%
                  <small>
                    {change > 0 ? "+" : change < 0 ? "−" : "±"}
                    {Math.abs(change)}%
                  </small>
                </span>
              </button>
            );
          })}
          <p className="rp-reveal-note">
            Exposure = vehicle-minutes inside the fire area, on roads plus at home before leaving,
            as a share of the baseline (model, one seed). A relative comparison, not a count of
            people. Pick a row to watch it on the map.
          </p>
        </div>
      ) : (
        metrics &&
        notOut !== null &&
        total !== null && (
          <div className="rp-story-stakes" aria-label="Modelled vehicles at this moment">
            <div>
              <strong>{fmt(notOut)}</strong>
              <span>not yet out of {fmt(total)}</span>
            </div>
            <div className="rp-story-stakes--risk">
              <strong>{fmt(metrics.exposedVeh)}</strong>
              <span>on roads inside the fire</span>
            </div>
            <div>
              <strong>{fmt(metrics.arrivedVeh)}</strong>
              <span>out safely</span>
            </div>
            <p>
              {trafficEvidence && <EvidenceChip value={trafficEvidence} />}
              {demandLabel && (
                <span
                  className={
                    demandLabel.startsWith("FIXTURE")
                      ? "rp-fixture-tag"
                      : "rp-chip rp-chip--derived"
                  }
                >
                  {demandLabel}
                </span>
              )}{" "}
              modelled vehicles, live with the clock
            </p>
          </div>
        )
      )}

      <footer className="rp-story-actions">
        <button
          type="button"
          className="rp-tour-btn"
          onClick={() => goTo(index - 1)}
          disabled={index === 0}
        >
          Back
        </button>
        {!last && (
          <button
            type="button"
            className="rp-tour-btn"
            aria-pressed={paused}
            onClick={onTogglePause}
          >
            {paused ? "Resume" : "Pause"}
          </button>
        )}
        <button
          type="button"
          className="rp-tour-btn rp-tour-btn--primary"
          onClick={() => (last ? onClose() : goTo(index + 1))}
        >
          {last ? "Explore freely" : "Next"}
        </button>
      </footer>
    </section>
  );
}
