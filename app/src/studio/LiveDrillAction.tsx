/** "Use as live drill": turns the current run into a drill package (drillPackage.ts). */

import { useEffect, useRef, useState } from "react";
import { Button, Notice } from "../ui";
import type { StudioRunResult } from "./contracts";
import { buildRunExport, postDrillPackage, type DrillPackageResponse } from "./drillPackage";

type State =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "done"; response: DrillPackageResponse }
  | { status: "failed"; message: string };

export default function LiveDrillAction({
  result,
  stale,
}: {
  result: StudioRunResult | null;
  stale: boolean;
}) {
  const [state, setState] = useState<State>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const send = () => {
    if (!result) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ status: "sending" });
    let body;
    try {
      body = buildRunExport(result, new Date());
    } catch (cause) {
      setState({
        status: "failed",
        message: cause instanceof Error ? cause.message : "Could not export the run.",
      });
      return;
    }
    postDrillPackage(body, controller.signal)
      .then((response) => setState({ status: "done", response }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "failed",
          message: cause instanceof Error ? cause.message : "Could not build the drill package.",
        });
      });
  };

  const disabled = !result || stale || state.status === "sending";
  return (
    <div className="studio-field">
      <Button variant="secondary" size="sm" disabled={disabled} onClick={send}>
        {state.status === "sending" ? "Building drill…" : "Use as live drill"}
      </Button>
      {!result || stale ? <p className="studio-hint">Run the simulation first.</p> : null}
      <div role="status" aria-live="polite">
        {state.status === "done" && (
          <p className="studio-status">
            Drill package {state.response.package_id} · {state.response.summary.zones} zones ·{" "}
            {state.response.summary.homes.toLocaleString()} synthetic homes · simulated fire. Not
            active yet.
          </p>
        )}
      </div>
      {state.status === "failed" && (
        <Notice tone="danger" compact className="studio-notice">
          {state.message}
        </Notice>
      )}
    </div>
  );
}
