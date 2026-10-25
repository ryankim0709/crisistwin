// Two-way binding between one tab's own state and the shared world (docs/shared-world.md,
// "Syncing a tab"). A tab describes its state in world shape (`local`, only the fields it owns)
// and says how to take a remote change (`apply`); this hook does the rest:
//
// - remote → tab: when the active world changes a field this tab has not edited since its last
//   write, `apply(world, changed)` is called with the changed field paths;
// - tab → remote: when `local` changes a field (a user edit), the change is written ~500 ms later
//   (debounced, only the changed groups), never a value the tab just received from another tab;
// - a field the tab is editing (written-but-not-yet-sent) is never overwritten by a remote change;
// - "Don't sync this tab" (per tab, localStorage) turns both directions off for experiments.
//
// Values a tab cannot represent exactly (a custom region on a catalogue-only page, a percentile
// the board has no preset for) are absorbed: the tab's nearest local value is not written back.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { World, WorldChanges, WorldWriter } from "./contracts";
import { useWorld } from "./useWorld";

/** Leaf paths a tab can own. `region` and `fire.ignitions` are written whole. */
export const WORLD_PATHS = [
  "region",
  "conditions.startUtc",
  "conditions.weather.mode",
  "conditions.weather.percentile",
  "conditions.weather.windSpeedMph",
  "conditions.weather.windFromDegrees",
  "conditions.moisture.mode",
  "conditions.moisture.preset",
  "fire.ignitions",
  "fire.stochastic.enabled",
  "fire.stochastic.seed",
  "liveIncidentId",
  "seed",
] as const;
export type WorldPath = (typeof WORLD_PATHS)[number];

/** Paths written together: a mode is never sent without its mode-specific fields. */
function groupOf(path: WorldPath): string {
  if (path.startsWith("conditions.weather.")) return "weather";
  if (path.startsWith("conditions.moisture.")) return "moisture";
  if (path.startsWith("fire.stochastic.")) return "stochastic";
  return path;
}

const DEBOUNCE_MS = 500;
/** How long after applying a remote change the tab's own follow-up values are absorbed. */
const ABSORB_MS = 1500;
const DROPPED = "\u0000dropped";

export const WRITER_LABEL: Record<WorldWriter, string> = {
  fire: "Fire",
  simulation: "Studio",
  dispatch: "Dispatch",
  live: "Live",
  mcp: "Agent",
  api: "API",
};

function stable(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

function get(value: unknown, path: string): unknown {
  let cur = value;
  for (const key of path.split(".")) {
    cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[key] : undefined;
  }
  return cur;
}

type Flat = Map<WorldPath, string | undefined>;

function flatten(value: unknown): Flat {
  return new Map(WORLD_PATHS.map((p) => [p, stable(get(value, p))]));
}

/** A partial world from leaf values. */
function build(values: ReadonlyMap<WorldPath, unknown>): WorldChanges {
  const out: Record<string, unknown> = {};
  for (const [path, value] of values) {
    const keys = path.split(".");
    let node = out;
    for (const key of keys.slice(0, -1)) {
      node[key] = (node[key] as Record<string, unknown> | undefined) ?? {};
      node = node[key] as Record<string, unknown>;
    }
    node[keys[keys.length - 1]] = value;
  }
  return out as WorldChanges;
}

const storageKey = (tab: string) => `crisistwin.world.sync.${tab}`;

export function readSyncEnabled(tab: string): boolean {
  try {
    return window.localStorage.getItem(storageKey(tab)) !== "off";
  } catch {
    return true;
  }
}

export interface WorldSyncOptions {
  tab: WorldWriter;
  /** The tab's state in world shape; a path left undefined is not this tab's to write. Null: write nothing by diffing (use `write`). */
  local: WorldChanges | null;
  /** Take a remote change. `changed` lists the paths that differ from what this tab last saw. */
  apply: (world: World, changed: ReadonlySet<WorldPath>) => void;
}

export interface WorldSync {
  world: World;
  loaded: boolean;
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  status: ReturnType<typeof useWorld>["status"];
  error: string | null;
  /** Write these fields (debounced) without going through `local`, e.g. a one-off action. */
  write: (changes: WorldChanges) => void;
  /** Absorb the tab's own follow-up changes for a moment (after restoring a scenario's extras). */
  hold: () => void;
}

export function useWorldSync({ tab, local, apply }: WorldSyncOptions): WorldSync {
  const { world, loaded, status, error, update } = useWorld();
  const [enabled, setEnabledState] = useState(() => readSyncEnabled(tab));
  const [nonce, setNonce] = useState(0);

  const seen = useRef<Flat | null>(null);
  const sent = useRef<Flat>(new Map());
  const absorb = useRef<{ paths: Set<WorldPath>; until: number }>({ paths: new Set(), until: 0 });
  const explicit = useRef<Flat>(new Map());
  const timer = useRef<number | null>(null);
  const localRef = useRef(local);
  const applyRef = useRef(apply);
  // The tab's state when it started syncing, to tell its user's early edits from its defaults.
  const firstLocal = useRef<Flat | null>(null);
  // Before the effects below read them.
  useLayoutEffect(() => {
    localRef.current = local;
    applyRef.current = apply;
    if (firstLocal.current === null && local) firstLocal.current = flatten(local);
  });

  const setEnabled = useCallback(
    (on: boolean) => {
      try {
        window.localStorage.setItem(storageKey(tab), on ? "on" : "off");
      } catch {
        // The choice then lasts for this visit only.
      }
      seen.current = null; // re-enabling takes the active world as on a fresh load
      firstLocal.current = localRef.current ? flatten(localRef.current) : null;
      setEnabledState(on);
    },
    [tab],
  );

  const flush = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (!seen.current) return;
    const lf = localRef.current ? flatten(localRef.current) : new Map<WorldPath, string | undefined>();
    const groups = new Set<string>();
    for (const p of WORLD_PATHS) {
      const v = explicit.current.get(p) ?? lf.get(p);
      if (v === undefined || v === sent.current.get(p)) continue;
      sent.current.set(p, v);
      // Already what the world says (e.g. the tab caught up with a remote change): nothing to send.
      if (v !== seen.current.get(p)) groups.add(groupOf(p));
    }
    if (groups.size === 0) {
      explicit.current.clear();
      return;
    }
    // Every field of a changed group; explicit writes override the projection for their paths.
    const values = new Map<WorldPath, unknown>();
    for (const p of WORLD_PATHS) {
      if (!groups.has(groupOf(p))) continue;
      const e = explicit.current.get(p);
      const v = e !== undefined ? (JSON.parse(e) as unknown) : get(localRef.current, p);
      if (v !== undefined) values.set(p, v);
    }
    explicit.current.clear();
    const changes = build(values);
    for (const [p, v] of values) seen.current.set(p, stable(v));
    void update(changes, tab).then((stored) => {
      if (stored || !seen.current) return;
      // Dropped (another tab changed the same field first) or failed: take the world's version.
      for (const p of values.keys()) seen.current.set(p, DROPPED);
      setNonce((n) => n + 1);
    });
  }, [tab, update]);

  const schedule = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, DEBOUNCE_MS);
  }, [flush]);

  // Remote → tab.
  useEffect(() => {
    if (!enabled || !loaded) return;
    const remote = flatten(world);
    const lf = localRef.current ? flatten(localRef.current) : null;
    if (seen.current === null) {
      seen.current = remote;
      // Edits the user made before the world answered are kept and written, not overwritten.
      const base = firstLocal.current;
      const edited = new Set(
        WORLD_PATHS.filter((p) => {
          const now = lf?.get(p);
          const before = base?.get(p);
          return now !== undefined && before !== undefined && now !== before;
        }),
      );
      sent.current = new Map(WORLD_PATHS.map((p) => [p, edited.has(p) ? base?.get(p) : lf?.get(p)]));
      if (edited.size > 0) schedule();
      // Nobody has written a world yet (revision 0): the tab keeps its own defaults.
      if (world.revision === 0) return;
      const changed = new Set(
        WORLD_PATHS.filter((p) => !edited.has(p) && (!lf || lf.get(p) !== remote.get(p))),
      );
      if (changed.size === 0) return;
      absorb.current = { paths: changed, until: Date.now() + ABSORB_MS };
      applyRef.current(world, changed);
      return;
    }
    const changed = new Set<WorldPath>();
    for (const p of WORLD_PATHS) {
      if (remote.get(p) === seen.current.get(p)) continue;
      seen.current.set(p, remote.get(p));
      // A field this tab is editing (not yet sent) keeps the tab's value; the write follows.
      const editing = lf !== null && lf.get(p) !== undefined && lf.get(p) !== sent.current.get(p);
      if (!editing && !explicit.current.has(p)) changed.add(p);
    }
    if (changed.size === 0) return;
    const now = Date.now();
    const keep = now < absorb.current.until ? absorb.current.paths : new Set<WorldPath>();
    absorb.current = { paths: new Set([...keep, ...changed]), until: now + ABSORB_MS };
    applyRef.current(world, changed);
  }, [world, loaded, enabled, nonce, schedule]);

  // Tab → remote.
  const localKey = useMemo(() => (local ? stable(local) : null), [local]);
  useEffect(() => {
    if (!enabled || !loaded || seen.current === null || !localRef.current) return;
    const lf = flatten(localRef.current);
    const now = Date.now();
    let dirty = false;
    for (const p of WORLD_PATHS) {
      const v = lf.get(p);
      if (v === undefined || v === sent.current.get(p)) continue;
      if (now < absorb.current.until && absorb.current.paths.has(p)) {
        // The tab's own follow-up to a remote change (once per change), not a user edit.
        sent.current.set(p, v);
        absorb.current.paths.delete(p);
        continue;
      }
      dirty = true;
    }
    if (dirty) schedule();
  }, [localKey, enabled, loaded, schedule]);

  // Send a pending edit rather than lose it when the page unmounts.
  useEffect(
    () => () => {
      if (timer.current !== null) flush();
    },
    [flush],
  );

  const write = useCallback(
    (changes: WorldChanges) => {
      if (!enabled || !seen.current) return;
      const f = flatten(changes);
      for (const p of WORLD_PATHS) {
        const v = f.get(p);
        if (v !== undefined) explicit.current.set(p, v);
      }
      schedule();
    },
    [enabled, schedule],
  );

  const hold = useCallback(() => {
    absorb.current = { paths: new Set(WORLD_PATHS), until: Date.now() + ABSORB_MS };
  }, []);

  return { world, loaded, enabled, setEnabled, status, error, write, hold };
}
