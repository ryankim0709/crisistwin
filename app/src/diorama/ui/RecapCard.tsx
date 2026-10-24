import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RecapItem } from "../types";

type RecapCardProps = {
  items: readonly RecapItem[];
  summary: string;
  /** Seconds until the loop restarts by itself, or null when auto-restart is held. */
  autoRestartIn: number | null;
  onReplay: () => void;
  onExplore: () => void;
  /** Called on any pointer or keyboard interaction inside the card. */
  onInteract: () => void;
};

export default function RecapCard({ items, summary, autoRestartIn, onReplay, onExplore, onInteract }: RecapCardProps) {
  return (
    <section
      className="dio-recap dio-panel"
      aria-labelledby="dio-recap-title"
      onPointerDown={onInteract}
      onKeyDown={onInteract}
    >
      <p className="dio-recap-eyebrow">Scenario complete · Synthetic results</p>
      <h2 id="dio-recap-title">Recap</h2>
      <p className="dio-recap-summary">{summary}</p>
      {items.length > 0 && (
        <dl className="dio-recap-items">
          {items.map((item) => (
            <div key={item.label}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="dio-recap-actions">
        <button type="button" className="dio-recap-replay" onClick={onReplay}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4.5 2.5 13.5 8l-9 5.5z" fill="currentColor" />
          </svg>
          Replay
        </button>
        <button type="button" className="dio-recap-explore" onClick={onExplore}>
          Explore scene
        </button>
      </div>
      <p className="dio-recap-note">
        {autoRestartIn !== null ? `Replays automatically in ${autoRestartIn} s.` : "Loop paused. Press Replay to watch again."}
      </p>
    </section>
  );
}

/**
 * Countdown in whole seconds while `active`, calling `onDone` once when it reaches zero.
 * Returns null when inactive.
 */
export function useCountdown(active: boolean, seconds: number, onDone: () => void): number | null {
  const [remaining, setRemaining] = useState(seconds);
  const doneCb = useRef(onDone);
  useLayoutEffect(() => {
    doneCb.current = onDone;
  });

  useEffect(() => {
    if (!active) return;
    setRemaining(seconds);
    const started = performance.now();
    const id = window.setInterval(() => {
      const left = Math.max(0, seconds - Math.floor((performance.now() - started) / 1000));
      setRemaining(left);
      if (left === 0) {
        window.clearInterval(id);
        doneCb.current();
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [active, seconds]);

  return active ? remaining : null;
}
