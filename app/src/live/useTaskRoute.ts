import { useEffect, useState } from "react";
import { fetchTaskRoute, LiveError } from "./api";
import type { TaskRoute } from "./types";

const REFRESH_MS = 15_000;

export interface TaskRouteState {
  taskId: string;
  route: TaskRoute | null;
  /** "no_origin" when the responder's location is unknown, else an error message. */
  error: string | null;
}

/** The responder route for one task, refetched every 15 s while a task id is given. */
export function useTaskRoute(token: string | null, taskId: string | null): TaskRouteState | null {
  const [state, setState] = useState<TaskRouteState | null>(null);
  useEffect(() => {
    if (!token || !taskId) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const route = await fetchTaskRoute(token, taskId, controller.signal);
        setState({ taskId, route, error: null });
      } catch (error) {
        if (controller.signal.aborted) return;
        const e = error instanceof LiveError ? error : null;
        setState({ taskId, route: null, error: e?.code === "no_origin" ? "no_origin" : (e?.message ?? "Route unavailable.") });
      }
    };
    void load();
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      controller.abort();
      window.clearInterval(id);
    };
  }, [token, taskId]);
  return taskId && state?.taskId === taskId ? state : null;
}
