/**
 * The dispatcher's road tool: close or reopen roads by clicking the 3D board, before or during
 * a session. Mid-run closures go straight to the engine and wake the agent (monitor.ts). Also
 * lists the roads the modelled fire has cut, which routing already avoids. See
 * docs/adr/0030-live-road-closures.md.
 */

import { roadLabel, type DispatchArea } from "./area";
import { Button, Tag } from "../ui";

function hhmm(minute: number): string {
  const m = Math.max(0, Math.round(minute));
  return `T+${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

export interface RoadClosuresProps {
  area: DispatchArea;
  /** The planner's closures, oldest first; minute 0 for ones made before the start. */
  closures: readonly { edge: number; minute: number }[];
  /** Road segments the fire model has cut (within the routing lookahead), and named roads. */
  fireCut: { segments: number; roads: readonly string[] } | null;
  tool: boolean;
  onTool: () => void;
  onReopen: (edge: number) => void;
  /** A session is running: changes apply now and wake the agent. */
  live: boolean;
  /** Last pick feedback ("No road there…"), or null. */
  notice: string | null;
}

export default function RoadClosures({
  area,
  closures,
  fireCut,
  tool,
  onTool,
  onReopen,
  live,
  notice,
}: RoadClosuresProps) {
  return (
    <section className="dsp-roads" aria-label="Road closures">
      <div className="dsp-roads__head">
        <strong>Road closures</strong>
        <Button
          size="sm"
          variant={tool ? "primary" : "secondary"}
          aria-pressed={tool}
          onClick={onTool}
        >
          {tool ? "Done closing roads" : "Close a road"}
        </Button>
      </div>
      {tool && (
        <p className="dsp-note" role="status">
          Click a road on the 3D board to close it; click a closed road to reopen it.{" "}
          {live
            ? "Traffic re-routes at once and the agent is woken to respond."
            : "Closures made now hold from T+0."}
        </p>
      )}
      {notice && (
        <p className="dsp-note" role="alert">
          {notice}
        </p>
      )}
      {closures.length > 0 && (
        <ul className="dsp-roads__list" aria-label="Closed roads">
          {closures.map(({ edge, minute }) => {
            const label = roadLabel(area.edges[edge]);
            return (
              <li key={edge}>
                <span>
                  ✕ {label} <span className="dsp-muted">since {hhmm(minute)}</span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Reopen ${label}`}
                  onClick={() => onReopen(edge)}
                >
                  Reopen
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {closures.length > 0 && (
        <p className="dsp-note">
          <Tag>Your assumption</Tag> Closures change traffic, not the fire.
        </p>
      )}
      {fireCut && fireCut.segments > 0 && (
        <p className="dsp-note">
          <Tag tone="danger">Fire</Tag> The modelled fire has cut {fireCut.segments} road segment
          {fireCut.segments === 1 ? "" : "s"}
          {fireCut.roads.length > 0 && ` (${fireCut.roads.join(", ")})`}; routes already avoid them.
        </p>
      )}
    </section>
  );
}
