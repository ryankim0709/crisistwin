/**
 * Live -> Studio region sync, for /simulation only (`enabled`). Once on load, Studio selects the
 * region of the Live command drill when it is a Studio drill package whose region is in the
 * catalog, overriding the remembered region; it never fights a later pick (a pick, or a run,
 * before the drill is read cancels the sync). Studio -> Live happens on Run (usePublishLiveFire).
 *
 * While the page is visible the drill is re-read every 15 s (and when the tab becomes visible),
 * so a drill switched from Live command updates `note`; the selected region is never changed
 * after the load sync.
 *
 * `note` says whether the selected region matches Live command, using the newest of the latest
 * publish and the latest read. Null while unknown or when the read failed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchLiveDrill } from "./liveSync";
import type { LiveFireState } from "./usePublishLiveFire";
import { parseStudioBoardId } from "./useRegionBoard";

const REFRESH_MS = 15_000;

interface Drill {
  name: string;
  regionId: string | null;
}

export function useLiveRegionSync({
  enabled,
  boardId,
  liveFire,
  blocked,
  select,
}: {
  enabled: boolean;
  /** Studio's current board id (`studioBoardId`: region id, plus `@<N>km` for a chosen size). */
  boardId: string;
  liveFire: LiveFireState;
  /** True once a run has started or finished: the load-time sync then stays out of the way. */
  blocked: boolean;
  select: (id: string) => void;
}): { note: string | null; userPicked: () => void } {
  const [read, setRead] = useState<{ drill: Drill; fire: LiveFireState } | null>(null);
  const fireRef = useRef(liveFire);
  const pickedRef = useRef(false);
  const blockedRef = useRef(blocked);
  const selectRef = useRef(select);
  useEffect(() => {
    fireRef.current = liveFire;
    blockedRef.current = blocked;
    selectRef.current = select;
  });

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetchLiveDrill(controller.signal)
      .then(({ active, regionId: drillRegion }) => {
        if (controller.signal.aborted) return;
        setRead({ drill: { name: active.name, regionId: drillRegion }, fire: fireRef.current });
        if (
          !pickedRef.current &&
          !blockedRef.current &&
          active.source === "package" &&
          drillRegion
        ) {
          // The drill's board id may carry a size ("<region>@10km"); the sync picks its region.
          const board = parseStudioBoardId(drillRegion);
          if (board) selectRef.current(board.region.id);
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let controller: AbortController | null = null;
    const refresh = () => {
      if (document.hidden) return;
      controller?.abort();
      const own = new AbortController();
      controller = own;
      fetchLiveDrill(own.signal)
        .then(({ active, regionId: drillRegion }) => {
          if (own.signal.aborted) return;
          setRead({ drill: { name: active.name, regionId: drillRegion }, fire: fireRef.current });
        })
        .catch(() => undefined);
    };
    const timer = window.setInterval(refresh, REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      controller?.abort();
    };
  }, [enabled]);

  const userPicked = useCallback(() => {
    pickedRef.current = true;
  }, []);

  const drill: Drill | null =
    liveFire.status === "done" && (!read || read.fire !== liveFire)
      ? { name: liveFire.response.incident_name, regionId: liveFire.regionId }
      : (read?.drill ?? null);
  let note: string | null = null;
  if (enabled && drill) {
    note =
      drill.regionId === boardId
        ? `Synced with Live command: ${drill.name}`
        : `Live command is on ${boardName(drill.regionId) ?? drill.name}; it switches when you run`;
  }
  return { note, userPicked };
}

/** "Berkeley Hills & Tilden (10 km)" for a Studio board id, or null when it names no known region. */
function boardName(boardId: string | null): string | null {
  const board = boardId ? parseStudioBoardId(boardId) : null;
  if (!board) return null;
  return board.radiusMeters === null ? board.region.name : `${board.region.name} (${board.radiusMeters / 1000} km)`;
}
