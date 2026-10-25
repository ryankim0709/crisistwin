// Saved scenarios: named snapshots of a world plus each tab's extras (docs/shared-world.md).
import { useCallback, useEffect, useRef, useState } from "react";
import { createScenario, deleteScenario, fetchScenario, listScenarios, loadScenario } from "./api";
import type { Scenario, ScenarioExtras, ScenarioSummary, World, WorldWriter } from "./contracts";
import { acceptWorld } from "./useWorld";

export interface SaveScenarioInput {
  name: string;
  notes?: string;
  tags?: string[];
  world: World;
  extras?: ScenarioExtras;
}

export interface UseScenarios {
  scenarios: ScenarioSummary[];
  status: "loading" | "ready" | "error";
  error: string | null;
  /** Re-list (the list is fetched on mount and after each save/delete). */
  refresh: () => Promise<void>;
  save: (input: SaveScenarioInput) => Promise<Scenario>;
  /** Make the scenario's world the active world; resolves to the full scenario (with extras). */
  load: (id: string) => Promise<Scenario>;
  /** The full saved scenario without loading it. */
  get: (id: string) => Promise<Scenario>;
  remove: (id: string) => Promise<void>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : "World API error.");

export function useScenarios(updatedBy: WorldWriter, enabled = true): UseScenarios {
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [status, setStatus] = useState<UseScenarios["status"]>("loading");
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const rows = await listScenarios();
      if (!mounted.current) return;
      setScenarios(rows);
      setStatus("ready");
      setError(null);
    } catch (err) {
      if (!mounted.current) return;
      setStatus("error");
      setError(message(err));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    if (enabled) {
      listScenarios(controller.signal).then(
        (rows) => {
          setScenarios(rows);
          setStatus("ready");
          setError(null);
        },
        (err: unknown) => {
          if (controller.signal.aborted) return;
          setStatus("error");
          setError(message(err));
        },
      );
    }
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [enabled]);

  const save = useCallback(
    async (input: SaveScenarioInput) => {
      const scenario = await createScenario({ ...input, updatedBy });
      void refresh();
      return scenario;
    },
    [refresh, updatedBy],
  );

  const load = useCallback(
    async (id: string) => {
      const { world, scenario } = await loadScenario(id, updatedBy);
      acceptWorld(world);
      return scenario;
    },
    [updatedBy],
  );

  const remove = useCallback(
    async (id: string) => {
      await deleteScenario(id);
      setScenarios((rows) => rows.filter((s) => s.id !== id));
      void refresh();
    },
    [refresh],
  );

  return { scenarios, status, error, refresh, save, load, get: fetchScenario, remove };
}
