import { useCallback, useEffect, useRef, useState } from "react";
import type { Bbox } from "../dispatch/area";
import { IntelRequestError, listCandidates, type IntelCandidate } from "./api";

export type ConfirmedClosures =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; closures: IntelCandidate[] }
  | { status: "error"; message: string };

const CLOSURE_TYPES = ["road_closed", "road_blocked", "road_reopened"];

/**
 * Planner-confirmed closure reports whose mapped point lies in `bbox` (docs/incident-intel.md
 * (e)). Not filtered by mode here: `liveClosures` (closures.ts) decides which may touch a live
 * session. `refresh` re-fetches (keeping the current list meanwhile); only the newest request
 * may land, so an older response never overwrites a newer one.
 */
export function useConfirmedClosures(bbox: Bbox | null): [ConfirmedClosures, () => void] {
  const [state, setState] = useState<ConfirmedClosures>({ status: "idle" });
  const [generation, setGeneration] = useState(0);
  const latestRef = useRef(0);
  const loadedKeyRef = useRef("");
  const key = bbox ? bbox.join(",") : "";
  useEffect(() => {
    const request = ++latestRef.current;
    if (!bbox) {
      loadedKeyRef.current = "";
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && request === latestRef.current;
    // A new area starts over; a refresh of the same area keeps showing the last list.
    if (loadedKeyRef.current !== key) setState({ status: "loading" });
    listCandidates({ status: ["confirmed"], types: CLOSURE_TYPES, bbox }, controller.signal)
      .then((result) => {
        if (!current()) return;
        loadedKeyRef.current = key;
        setState({ status: "ready", closures: result.candidates });
      })
      .catch((cause) => {
        if (!current()) return;
        loadedKeyRef.current = "";
        setState({
          status: "error",
          message:
            cause instanceof IntelRequestError ? cause.detail : "Closure reports unavailable.",
        });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the bbox's value
  }, [key, generation]);
  const refresh = useCallback(() => setGeneration((value) => value + 1), []);
  return [state, refresh];
}
