/**
 * Publishes the fires of a finished Studio run to Live command, once per run. A run is
 * identified by `result.requestId`, so edits (stale results) and re-renders never republish,
 * while a rerun with identical inputs is a new run and publishes again.
 *
 * Studio leads: when the Live command drill is on another region than the run's board, Live
 * command is switched to this region first (the newest stored drill package of the region whose
 * road box holds the run's ignitions, else a package built from this run as "Use as live drill"
 * does), then the fire is posted, so it is stamped with the new incident. If switching fails the
 * fire is not posted. One publish at a time: a newer run aborts the older one and starts after
 * its in-flight request settles (an activation cannot be aborted).
 */

import { useEffect, useRef, useState } from "react";
import { activate, fetchPackages, type StoredPackage } from "../live/active";
import type { StudioRunResult } from "./contracts";
import { buildRunExport, postDrillPackage } from "./drillPackage";
import {
  buildLiveFirePayload,
  postLiveFire,
  type LiveFirePayload,
  type LiveFireResponse,
} from "./liveFire";
import { fetchLiveDrill, liveToken, packageRegionId } from "./liveSync";
import { parseStudioBoardId } from "./useRegionBoard";

export type LiveFireState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "switching"; regionName: string; building: boolean }
  | { status: "sending" }
  | {
      status: "done";
      response: LiveFireResponse;
      /** Region Live command is on now (the run's board). */
      regionId: string;
      /** Region name when this publish switched Live command, else null. */
      switchedTo: string | null;
    }
  | { status: "failed"; message: string };

const messageOf = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message ? cause.message : fallback;

/** A stored package's road box (`summary.bbox`, [west, south, east, north]) holds every ignition. */
function covers(pkg: StoredPackage, ignitions: LiveFirePayload["ignitions"]): boolean {
  const box = pkg.summary.bbox;
  if (!Array.isArray(box) || box.length !== 4 || !box.every((v) => typeof v === "number")) {
    return false;
  }
  const [west, south, east, north] = box as number[];
  return ignitions.every(
    ({ lon, lat }) => lon >= west && lon <= east && lat >= south && lat <= north,
  );
}

async function syncAndPublish(
  result: StudioRunResult,
  regionId: string,
  signal: AbortSignal,
  update: (next: LiveFireState) => void,
): Promise<void> {
  let body: LiveFirePayload;
  try {
    body = buildLiveFirePayload(result, regionId);
  } catch (cause) {
    update({ status: "failed", message: messageOf(cause, "Could not build the live fire.") });
    return;
  }

  const regionName = parseStudioBoardId(regionId)?.region.name ?? regionId;
  let switchedTo: string | null = null;
  let phase = "read the Live command drill";
  try {
    const drill = await fetchLiveDrill(signal);
    if (drill.regionId !== regionId) {
      phase = `switch Live command to ${regionName}`;
      update({ status: "switching", regionName, building: false });
      // Newest first (server order).
      const stored = (await fetchPackages(liveToken(), signal)).find(
        (pkg) => packageRegionId(pkg) === regionId && covers(pkg, body.ignitions),
      );
      let packageId = stored?.package_id ?? null;
      if (packageId === null) {
        update({ status: "switching", regionName, building: true });
        packageId = (await postDrillPackage(buildRunExport(result, new Date()), signal)).package_id;
      }
      if (signal.aborted) return;
      await activate(liveToken(), { package_id: packageId });
      switchedTo = regionName;
    }
  } catch (cause) {
    if (signal.aborted) return;
    update({
      status: "failed",
      message: `Could not ${phase}: ${messageOf(cause, "the live server did not answer.")}`,
    });
    return;
  }
  if (signal.aborted) return;

  update({ status: "sending" });
  try {
    const response = await postLiveFire(body, signal);
    update({ status: "done", response, regionId, switchedTo });
  } catch (cause) {
    if (signal.aborted) return;
    update({
      status: "failed",
      message: messageOf(cause, "Could not send the fire to Live command."),
    });
  }
}

export function usePublishLiveFire(
  result: StudioRunResult | null,
  regionId: string,
  enabled: boolean,
): LiveFireState {
  const [state, setState] = useState<LiveFireState>({ status: "idle" });
  // A result that already exists when this hook mounts (a hot reload, a remount) was not a run
  // the user just finished, so it is never sent: only runs completed while mounted start fires.
  const publishedRef = useRef<number | null>(result?.requestId ?? null);
  const abortRef = useRef<AbortController | null>(null);
  const chainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => () => abortRef.current?.abort(), []);

  const requestId = result?.requestId ?? null;
  useEffect(() => {
    if (!enabled || !result || requestId === null || publishedRef.current === requestId) return;
    publishedRef.current = requestId;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    const update = (next: LiveFireState) => {
      if (!signal.aborted) setState(next);
    };
    setState({ status: "checking" });
    const runRegion = result.boardId ?? regionId;
    chainRef.current = chainRef.current
      .then(() => (signal.aborted ? undefined : syncAndPublish(result, runRegion, signal, update)))
      .catch(() => undefined);
    // `result` (and the region it ran on) is keyed by its requestId: one publish per finished run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, requestId]);

  return state;
}
