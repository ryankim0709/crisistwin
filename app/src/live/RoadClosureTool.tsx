import { Button, Notice, Panel, Tag } from "../ui";
import { simClock } from "../demo/format";
import type { RoadClosuresState } from "./useRoadClosures";

/**
 * The controller's drill road closure tool over the Live map: "Close road", then a click on a
 * road, then an inline confirm (no browser dialog); the closed roads with Reopen. A closure is a
 * drill action on the simulated board: fire units and evacuating households route around it.
 */
export default function RoadClosureTool({ state }: { state: RoadClosuresState }) {
  const { closures, candidate, armed, busy, error, canEdit, loadError } = state;
  const by = (who: string) => (who === "controller" ? "controller" : who.replace(/^agent:/, "agent "));
  return (
    <Panel glass compact className="lc-rc" aria-label="Road closures (drill)">
      <div className="lc-rc-head">
        <strong>Road closures</strong>
        <Tag tone="warning">Drill</Tag>
        {armed ? (
          <Button variant="ghost" size="sm" onClick={state.cancel}>
            Cancel
          </Button>
        ) : candidate ? null : (
          <Button variant="secondary" size="sm" onClick={state.arm} disabled={!canEdit || busy}>
            Close road
          </Button>
        )}
      </div>
      {armed ? <p className="lc-rc-hint">Click a road to close it. Esc cancels.</p> : null}
      {candidate ? (
        <div className="lc-rc-confirm" role="group" aria-label={candidate.closed ? "Closed road" : "Confirm road closure"}>
          {candidate.closed ? (
            <>
              <p>
                <strong>{candidate.name}</strong> is closed (drill
                {candidate.closure ? `, by ${by(candidate.closure.by)}` : ""}
                {candidate.closure?.boardMinute != null ? ` at ${simClock(candidate.closure.boardMinute)}` : ""}).
              </p>
              <div className="lc-rc-actions">
                <Button variant="secondary" size="sm" onClick={() => void state.reopen(candidate.segmentId)} disabled={busy}>
                  Reopen road
                </Button>
                <Button variant="ghost" size="sm" onClick={state.cancel}>
                  Close
                </Button>
              </div>
            </>
          ) : (
            <>
              <p>
                Close <strong>{candidate.name}</strong>? Drill closure: units and evacuees route around it (simulated).
              </p>
              <div className="lc-rc-actions">
                <Button variant="danger" size="sm" onClick={() => void state.confirmClose()} disabled={busy}>
                  Close road
                </Button>
                <Button variant="ghost" size="sm" onClick={state.cancel} disabled={busy}>
                  Cancel
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
      {error ? (
        <Notice tone="danger" compact>
          {error}
        </Notice>
      ) : null}
      {loadError ? (
        <Notice tone="warning" compact>
          {loadError}
        </Notice>
      ) : null}
      {closures.length ? (
        <ul className="lc-rc-list" aria-label="Closed roads">
          {closures.map((c) => (
            <li key={c.segmentId}>
              <span className="lc-rc-x" aria-hidden="true">
                X
              </span>
              <Button variant="ghost" size="sm" className="lc-rc-road" onClick={() => state.selectClosure(c.segmentId)}>
                {c.name}
              </Button>
              <span className="lc-rc-meta">
                Closed (drill){c.boardMinute != null ? ` ${simClock(c.boardMinute)}` : ""}
              </span>
              <Button variant="ghost" size="sm" onClick={() => void state.reopen(c.segmentId)} disabled={busy || !canEdit}>
                Reopen
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}
