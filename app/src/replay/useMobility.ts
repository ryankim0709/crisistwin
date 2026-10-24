import { useEffect, useState } from "react";
import { fetchMobility, type Mobility } from "./mobility";

export type MobilityState =
  | { status: "loading"; data: null; error: null }
  | { status: "missing"; data: null; error: null }
  | { status: "error"; data: null; error: string }
  | { status: "ready"; data: Mobility; error: null };

const LOADING: MobilityState = { status: "loading", data: null, error: null };
const MISSING: MobilityState = { status: "missing", data: null, error: null };

/**
 * Loads the optional mobility sidecar. A null url (e.g. the agent-simulation route) is
 * "missing". Results are tagged with their url and aborted on change, so a slow response for a
 * previous incident can never replace the current one.
 */
export function useMobility(url: string | null): MobilityState {
  const [result, setResult] = useState<{ url: string; state: MobilityState } | null>(null);

  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    fetchMobility(url, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setResult({
          url,
          state: data ? { status: "ready", data, error: null } : MISSING,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setResult({
          url,
          state: {
            status: "error",
            data: null,
            error: error instanceof Error ? error.message : "The mobility sidecar could not be loaded.",
          },
        });
      });
    return () => controller.abort();
  }, [url]);

  if (!url) return MISSING;
  return result?.url === url ? result.state : LOADING;
}
