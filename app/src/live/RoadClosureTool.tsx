import { Button, Notice, Panel, Tag } from "../ui";
import { simClock } from "../demo/format";
import type { RoadClosuresState } from "./useRoadClosures";

const by = (who: string) => (who === "controller" ? "controller" : who.replace(/^agent:/, "agent "));

/**
 * The controller's drill road closures in the right column's Controls block, the same in the
 * Map and 3D views: "Close a road" arms the tool (the prompt over the stage then says what to
 * do), and the closed roads are listed with Reopen. A closure is a drill action on the simulated
 * board: fire units and evacuating households route around it.
 */
export default function RoadClosureTool({ state }: { state: RoadClosuresState }) {
  const { closures, armed, candidate, busy, canEdit, disabledReason, loadError } = state;
  const active = armed || !!candidate;
  return (
    <div className="lc-rc" role="group" aria-labelledby="lc-rc-title">
      <div className="lc-rc-head">
        <span id="lc-rc-title" className="lc-sim-label">
          Road closures
        </span>
        <Tag tone="warning">Drill</Tag>
        {active ? (
          <Button variant="ghost" size="sm" onClick={state.cancel}>
            Cancel
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={state.arm}
            disabled={!canEdit || busy}
            title={disabledReason ?? "Pick a road on the map or the 3D board, then confirm"}
          >
            Close a road
          </Button>
        )}
      </div>
      {disabledReason ? <p className="lc-rc-hint">{disabledReason}</p> : null}
      {armed ? <p className="lc-rc-hint">Click a road on the map or the 3D board. Esc cancels.</p> : null}
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
              <Button variant="ghost" size="sm" className="lc-rc-road" onClick={() => state.selectClosure(c.segmentId)} title={`Show ${c.name}`}>
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
      ) : canEdit ? (
        <p className="lc-rc-hint">No roads closed.</p>
      ) : null}
    </div>
  );
}

/**
 * Over the stage (Map or 3D view), top centre: the armed tool's instruction, the picked road's
 * inline confirm (no browser dialog), a closed road's Reopen, and a short notice after a close
 * or reopen saying whether Claude (the AI agent) gets the change now.
 */
export function RoadClosurePrompt({ state, agentOn }: { state: RoadClosuresState; agentOn: boolean }) {
  const { candidate, armed, busy, error, notice } = state;
  if (!armed && !candidate && !error && !notice) return null;
  return (
    <div className="lc-rc-stage">
      {armed ? (
        <Panel glass compact className="lc-rc-prompt" role="group" aria-label="Close a road (drill)">
          <p>
            <span className="lc-rc-x" aria-hidden="true">
              X
            </span>{" "}
            <strong>Click a road to close it.</strong> <span className="lc-dim">Esc cancels.</span>
          </p>
          <Button variant="ghost" size="sm" onClick={state.cancel}>
            Cancel
          </Button>
        </Panel>
      ) : null}
      {candidate ? (
        <Panel glass compact className="lc-rc-prompt lc-rc-confirm" role="group" aria-label={candidate.closed ? "Closed road" : "Confirm road closure"}>
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
                  Done
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
        </Panel>
      ) : null}
      {error ? (
        <Notice tone="danger" compact className="lc-rc-toast">
          {error}
        </Notice>
      ) : null}
      {notice && !armed && !candidate ? (
        <div className="lc-rc-toast" role="status" aria-live="polite">
          <Notice tone={notice.kind === "closed" ? "info" : "success"} compact title={notice.kind === "closed" ? "Road closed:" : "Road reopened:"}>
            {notice.name}.{" "}
            {agentOn
              ? "Claude has been told."
              : "Claude will see it when the AI agent is turned on."}
          </Notice>
          <Button variant="ghost" size="sm" onClick={state.dismissNotice}>
            Dismiss
          </Button>
        </div>
      ) : null}
    </div>
  );
}
