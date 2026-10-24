import { Button, Metric, Panel } from "../../ui";
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

export default function RecapCard({
  items,
  summary,
  autoRestartIn,
  onReplay,
  onExplore,
  onInteract,
}: RecapCardProps) {
  return (
    // The wrapper only watches for interaction (pointer or key) to hold the auto-restart.
    <div className="dio-recap" onPointerDown={onInteract} onKeyDown={onInteract}>
      <Panel
        glass
        title="Recap"
        eyebrow="Scenario complete · Synthetic results"
        aria-label="Scenario recap"
      >
        <p className="dio-recap-summary">{summary}</p>
        {items.length > 0 && (
          <div className="dio-recap-items">
            {items.map((item) => (
              <Metric key={item.label} label={item.label} value={item.value} />
            ))}
          </div>
        )}
        <div className="dio-recap-actions">
          <Button
            onClick={onReplay}
            icon={
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4.5 2.5 13.5 8l-9 5.5z" />
              </svg>
            }
          >
            Replay
          </Button>
          <Button variant="secondary" onClick={onExplore}>
            Explore scene
          </Button>
        </div>
        <p className="ui-help">
          {autoRestartIn !== null
            ? `Replays automatically in ${autoRestartIn} s.`
            : "Loop paused. Press Replay to watch again."}
        </p>
      </Panel>
    </div>
  );
}
