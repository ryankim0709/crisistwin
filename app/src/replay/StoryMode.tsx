import { useCallback, useEffect, useRef, useState } from "react";
import { CaveatChip } from "./CompareTab";
import { VARIANT_CAVEATS } from "./compare";
import { EvidenceChip } from "./parts";
import { chapterFrame, cutoffClock, type Chapter, type RevealRow, type Spotlight } from "./story";
import { localTime } from "./timeline";
import type { EvidenceClass, LngLat, ReplayModel, TrafficMetrics } from "./types";

/** How long a chapter stays on screen before autoplay moves on. */
const HOLD_MS = 9_000;
/** Wall seconds the clock takes to run into a chapter. */
const TRAVEL_S = 4;
/** Longer gaps are skipped: the clock jumps to this much sim time before the chapter, then runs. */
const MAX_RUN_IN_MS = 40 * 60_000;
const MIN_SPEED = 60;
/**
 * Symmetric padding, so the chapter's subject sits in the middle of the window; wide enough at
 * the sides to keep the framed area clear of the story card, narrowed on small screens.
 */
function focusPadding(): FocusPadding {
  const side = Math.max(40, Math.min(420, (window.innerWidth - 320) / 2));
  const vertical = Math.max(40, Math.min(170, (window.innerHeight - 240) / 2));
  return { top: vertical, bottom: vertical, left: side, right: side };
}
type FocusPadding = { top: number; bottom: number; left: number; right: number };

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
  focus: (coords: LngLat[], padding: FocusPadding) => void;
  /** Highlight the current chapter's subject on the map. */
  onSpotlight: (spot: Spotlight) => void;
  onShowVariant: (id: string) => void;
  onClose: () => void;
  /** End of story: open the next fire straight into its story. */
  nextFire: { label: string; open: () => void } | null;
  /** Paused by the user (dock button, Space or the card's Pause): no auto-advance, no run-in. */
  paused: boolean;
  onTogglePause: () => void;
  /** Bumped when the user resumes, to re-enter the current chapter (finish its run-in, then hold). */
  resumeKey: number;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** "Nov 9" in the given zone. */
function localDay(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(ms);
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
  onSpotlight,
  onShowVariant,
  onClose,
  nextFire,
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
      if (ch.focus.length > 0) focus(chapterFrame(ch), focusPadding());
      onSpotlight(ch.spot);
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
    [chapters, focus, onSpotlight, playTo, seek],
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
  // Dates only when the story runs over more than one local day.
  const multiDay = new Set(chapters.filter((c) => !c.reveal).map((c) => localDay(c.atMs, timezone))).size > 1;
  // The what-if "out by" count is taken at the first 18:00 UTC after the first order.
  const firstOrder = chapters.find((c) => c.id === "first-order");
  const cutoff = firstOrder ? cutoffClock(firstOrder.atMs, timezone) : null;

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
            {multiDay && `${localDay(chapter.atMs, timezone)} · `}
            {localTime(chapter.atMs, timezone)}
            {paused ? (
              <span className="rp-dim"> · paused</span>
            ) : (
              !arrived && <span className="rp-dim"> · clock running…</span>
            )}
          </p>
        )}
        {chapter.lead && chapter.lead.length > 0 && (
          <ul className="rp-story-lead" aria-label="Before this">
            {chapter.lead.map((note) => (
              <li key={note.text}>
                <EvidenceChip value={note.evidence} /> {note.text}
              </li>
            ))}
          </ul>
        )}
        <h2 className="rp-story-title">{chapter.title}</h2>
        <p className="rp-story-body">
          <EvidenceChip value={chapter.evidence} /> {chapter.body}
        </p>
        {chapter.then && chapter.then.length > 0 && (
          <ul className="rp-story-then" aria-label="What followed">
            {chapter.then.map((note) => (
              <li key={note.text}>
                <EvidenceChip value={note.evidence} /> {note.text}
              </li>
            ))}
          </ul>
        )}
      </div>

      {chapter.reveal ? (
        <div className="rp-reveal">
          <div className="rp-reveal-row rp-reveal-row--base">
            <span className="rp-reveal-name">
              Baseline run
              {revealRows[0]?.arrivedBaseline != null && cutoff && (
                <small>
                  {fmt(revealRows[0].arrivedBaseline)} out by {cutoff}
                </small>
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
                  {r.arrivedVariant !== null && cutoff && (
                    <small>
                      {fmt(r.arrivedVariant)} out by {cutoff}
                    </small>
                  )}
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
        {last ? (
          <>
            <button type="button" className="rp-tour-btn" onClick={onClose}>
              Explore this fire
            </button>
            {nextFire && (
              <button type="button" className="rp-tour-btn rp-tour-btn--primary" onClick={nextFire.open}>
                Watch {nextFire.label} ▶
              </button>
            )}
          </>
        ) : (
          <button type="button" className="rp-tour-btn rp-tour-btn--primary" onClick={() => goTo(index + 1)}>
            Next
          </button>
        )}
      </footer>
    </section>
  );
}

/** Rough wall-clock length of the story: hold plus run-in per chapter. */
export function storySeconds(chapters: number): number {
  return chapters * (HOLD_MS / 1000 + TRAVEL_S);
}

/** "Camp Fire, Nov 8 2018": incident name without its "(year)", plus the local start date. */
export function storyTitle(model: ReplayModel): string {
  const startMs = model.fireSimulated?.ignition?.atMs ?? model.clock.startMs;
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: model.incident.timezone,
    month: "short",
    day: "numeric",
    year: "numeric",
  })
    .format(startMs)
    .replace(",", "");
  return `${model.incident.name.replace(/\s*\(\d{4}\)\s*$/, "")}, ${date}`;
}

/** Story-first landing: the fire, its chapter count and one big Play. */
export function StoryLanding({
  title,
  chapters,
  seconds,
  onPlay,
  onExplore,
}: {
  title: string;
  chapters: number;
  seconds: number;
  onPlay: () => void;
  onExplore: () => void;
}) {
  const playRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    playRef.current?.focus();
  }, []);
  return (
    <section className="rp-landing" aria-labelledby="rp-landing-title">
      <p className="rp-landing-eyebrow">Historical replay · the story</p>
      <h1 id="rp-landing-title">{title}</h1>
      <p className="rp-landing-meta">
        {chapters} chapters · about {Math.max(1, Math.round(seconds / 60))} min · hands-free
      </p>
      <button ref={playRef} type="button" className="rp-landing-play" onClick={onPlay}>
        <span aria-hidden="true">▶</span> Play the story
      </button>
      <button type="button" className="rp-landing-explore" onClick={onExplore}>
        Explore freely
      </button>
      <p className="rp-landing-note">
        Historical records and modelled traffic, each labelled. A planning experiment, not instructions.
      </p>
    </section>
  );
}
