/** Status of the "send this run's fires to Live command" publish (usePublishLiveFire). */

import { Notice } from "../ui";
import type { LiveFireState } from "./usePublishLiveFire";

function timeOf(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export default function LiveFireStatus({ state }: { state: LiveFireState }) {
  if (state.status === "idle") return null;
  return (
    <div className="studio-field" role="status" aria-live="polite">
      {(state.status === "checking" || state.status === "sending") && (
        <p className="studio-status">Sending to Live command…</p>
      )}
      {state.status === "switching" && (
        <>
          <p className="studio-status">Switching Live command to {state.regionName}…</p>
          {state.building && (
            <p className="studio-hint">Building roads and homes for this region, ~30 s.</p>
          )}
        </>
      )}
      {state.status === "done" && (
        <>
          <p className="studio-status">
            Sent to Live command ({state.response.incident_name}) ·{" "}
            {timeOf(state.response.published_at)}
          </p>
          {state.switchedTo && (
            <p className="studio-hint">Live command switched to {state.switchedTo} for this run.</p>
          )}
          <p className="studio-hint">
            Live command starts these fires; its AI agent responds when it is on.
          </p>
          {state.response.outside_drill.length > 0 && (
            <Notice tone="warning" compact className="studio-notice">
              {state.response.outside_drill.join(", ")}{" "}
              {state.response.outside_drill.length === 1 ? "is" : "are"} outside the live drill's
              area ({state.response.incident_name}); Live command can't start{" "}
              {state.response.outside_drill.length === 1 ? "it" : "them"}. Move the fire, or build a
              drill around it (Use as live drill).
            </Notice>
          )}
        </>
      )}
      {state.status === "failed" && (
        <Notice tone="danger" compact className="studio-notice">
          {state.message}
        </Notice>
      )}
    </div>
  );
}
