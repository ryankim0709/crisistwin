/**
 * Live -> Studio region sync, for /simulation only (`enabled`). Once on load, Studio selects the
 * region of the Live command drill when it is a Studio drill package whose region is in the
 * catalog, overriding the remembered region; it never fights a later pick (a pick, or a run,
 * before the drill is read cancels the sync). Studio -> Live happens on Run (usePublishLiveFire).
 *
 * `note` says whether the selected region matches Live command, using the latest publish when
 * there is one, else the drill read on load. Null while unknown or when the read failed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchLiveDrill } from "./liveSync";
import type { LiveFireState } from "./usePublishLiveFire";
import { findRegion } from "./useRegionBoard";

interface Drill {
  name: string;
  regionId: string | null;
}

export function useLiveRegionSync({
  enabled,
  regionId,
  liveFire,
  blocked,
  select,
}: {
  enabled: boolean;
  regionId: string;
  liveFire: LiveFireState;
  /** True once a run has started or finished: the load-time sync then stays out of the way. */
  blocked: boolean;
  select: (id: string) => void;
}): { note: string | null; userPicked: () => void } {
  const [onLoad, setOnLoad] = useState<Drill | null>(null);
  const pickedRef = useRef(false);
  const blockedRef = useRef(blocked);
  const selectRef = useRef(select);
  useEffect(() => {
    blockedRef.current = blocked;
    selectRef.current = select;
  });

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetchLiveDrill(controller.signal)
      .then(({ active, regionId: drillRegion }) => {
        if (controller.signal.aborted) return;
        setOnLoad({ name: active.name, regionId: drillRegion });
        if (
          !pickedRef.current &&
          !blockedRef.current &&
          active.source === "package" &&
          drillRegion &&
          findRegion(drillRegion)
        ) {
          selectRef.current(drillRegion);
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [enabled]);

  const userPicked = useCallback(() => {
    pickedRef.current = true;
  }, []);

  const drill: Drill | null =
    liveFire.status === "done"
      ? { name: liveFire.response.incident_name, regionId: liveFire.regionId }
      : onLoad;
  let note: string | null = null;
  if (enabled && drill) {
    note =
      drill.regionId === regionId
        ? `Synced with Live command: ${drill.name}`
        : `Live command is on ${
            (drill.regionId && findRegion(drill.regionId)?.name) || drill.name
          }; it switches when you run`;
  }
  return { note, userPicked };
}
