// The active shared world for any tab (docs/shared-world.md "Frontend"). One store per browser
// tab, shared by every component that calls useWorld(): it polls GET /api/world/active every
// 2 s while mounted (paused when the page is hidden) and listens on
// BroadcastChannel("crisistwin-world") so tabs in the same browser update at once.
//
// update(changes, updatedBy) applies the change locally at once (optimistic), then PATCHes it
// with the revision it was based on. On a 409 the change is re-applied to the newer world only
// if that newer revision left the same fields alone; otherwise the other writer wins and the
// hook reports it in `error`, so a tab never silently overwrites another tab's newer change.
import { useCallback, useSyncExternalStore } from "react";
import { fetchWorld, patchWorld, WorldApiError } from "./api";
import { DEFAULT_WORLD, type World, type WorldChanges, type WorldWriter } from "./contracts";

export type WorldStatus = "loading" | "ready" | "saving" | "error";

export interface WorldState {
  /** The confirmed world with this tab's pending changes applied on top. */
  world: World;
  /** False until the first GET answers (the world is DEFAULT_WORLD until then). */
  loaded: boolean;
  status: WorldStatus;
  error: string | null;
}

export interface UseWorld extends WorldState {
  /** Write only the fields this tab's user changed. Resolves to the stored world, or null when
   * the change was dropped (conflict with a newer change to the same fields, or an error). */
  update: (changes: WorldChanges, updatedBy: WorldWriter) => Promise<World | null>;
  /** Fetch now instead of waiting for the next poll. */
  refresh: () => void;
}

const POLL_MS = 2000;
const CHANNEL = "crisistwin-world";
const MAX_REBASES = 3;

type Json = unknown;
const isPlainObject = (v: Json): v is Record<string, Json> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Same rule as the server: objects merge key by key; arrays, scalars and null replace. */
export function mergeWorld<T>(base: T, changes: Json): T {
  if (!isPlainObject(base) || !isPlainObject(changes)) return changes as T;
  const out: Record<string, Json> = { ...base };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    out[key] =
      isPlainObject(value) && isPlainObject(out[key]) ? mergeWorld(out[key], value) : value;
  }
  return out as T;
}

/** Leaf paths a change writes (arrays count as one leaf). */
function changedPaths(changes: Json, prefix: string[] = []): string[][] {
  if (!isPlainObject(changes)) return [prefix];
  return Object.entries(changes).flatMap(([k, v]) =>
    v === undefined ? [] : changedPaths(v, [...prefix, k]),
  );
}

function at(value: Json, path: string[]): Json {
  let cur = value;
  for (const key of path) cur = isPlainObject(cur) ? cur[key] : undefined;
  return cur;
}

/** True when `newer` left every field `changes` writes as it was in `base`. */
function untouched(changes: WorldChanges, base: World, newer: World): boolean {
  return changedPaths(changes).every(
    (p) => JSON.stringify(at(base, p)) === JSON.stringify(at(newer, p)),
  );
}

// ---- the store (module singleton) ----

interface Pending {
  changes: WorldChanges;
}

let confirmed: World = DEFAULT_WORLD;
let loaded = false;
let pending: Pending[] = [];
let lastError: string | null = null;
let fetchFailed = false;
let snapshot: WorldState = { world: DEFAULT_WORLD, loaded: false, status: "loading", error: null };
const listeners = new Set<() => void>();
let writeChain: Promise<unknown> = Promise.resolve();
let channel: BroadcastChannel | null = null;
let timer: number | null = null;
let inflight: AbortController | null = null;

function publish(): void {
  const world = pending.reduce<World>((w, p) => mergeWorld(w, p.changes), confirmed);
  const status: WorldStatus = !loaded
    ? fetchFailed
      ? "error"
      : "loading"
    : pending.length > 0
      ? "saving"
      : lastError || fetchFailed
        ? "error"
        : "ready";
  snapshot = {
    world,
    loaded,
    status,
    error:
      lastError ?? (fetchFailed ? "World API unreachable; showing the last known world." : null),
  };
  for (const listener of listeners) listener();
}

/** Adopt a server world if it is newer than what this tab has. */
function adopt(world: World): void {
  if (
    !loaded ||
    world.revision > confirmed.revision ||
    (world.revision === confirmed.revision && world.updatedAt !== confirmed.updatedAt)
  ) {
    confirmed = world;
  }
  loaded = true;
}

async function poll(): Promise<void> {
  if (typeof document !== "undefined" && document.hidden && loaded) return;
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  try {
    const world = await fetchWorld(controller.signal);
    adopt(world);
    fetchFailed = false;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    fetchFailed = true;
  } finally {
    if (inflight === controller) inflight = null;
  }
  publish();
}

function onMessage(event: MessageEvent): void {
  const data = event.data as { type?: string; world?: World } | null;
  if (data?.type === "world" && data.world) {
    adopt(data.world);
    publish();
  }
}

function onVisible(): void {
  if (!document.hidden) void poll();
}

function start(): void {
  void poll();
  timer = window.setInterval(() => void poll(), POLL_MS);
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(CHANNEL);
    channel.addEventListener("message", onMessage);
  }
  document.addEventListener("visibilitychange", onVisible);
}

function stop(): void {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
  inflight?.abort();
  channel?.close();
  channel = null;
  document.removeEventListener("visibilitychange", onVisible);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

async function send(entry: Pending, updatedBy: WorldWriter): Promise<World | null> {
  let base = confirmed;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const world = await patchWorld(base.revision, updatedBy, entry.changes);
        adopt(world);
        lastError = null;
        channel?.postMessage({ type: "world", world });
        return world;
      } catch (error) {
        if (!(error instanceof WorldApiError) || !error.conflict || !error.world) throw error;
        const newer = error.world;
        adopt(newer);
        if (attempt >= MAX_REBASES || !untouched(entry.changes, base, newer)) {
          lastError = `${newer.updatedBy ?? "Another tab"} changed the same setting first; showing its version.`;
          return null;
        }
        base = newer; // the newer revision left these fields alone: re-apply on top of it
      }
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : "Could not save the world.";
    return null;
  } finally {
    pending = pending.filter((p) => p !== entry);
    publish();
  }
}

function update(changes: WorldChanges, updatedBy: WorldWriter): Promise<World | null> {
  const entry: Pending = { changes };
  pending = [...pending, entry];
  lastError = null;
  publish();
  // Serialise writes so each one is based on the revision the previous one produced.
  const result = writeChain.then(() => send(entry, updatedBy));
  writeChain = result.catch(() => undefined);
  return result;
}

/** Take a world another call wrote (e.g. a scenario load) and tell the other tabs. */
export function acceptWorld(world: World): void {
  adopt(world);
  lastError = null;
  channel?.postMessage({ type: "world", world });
  if (!channel && typeof BroadcastChannel !== "undefined") {
    const once = new BroadcastChannel(CHANNEL);
    once.postMessage({ type: "world", world });
    once.close();
  }
  publish();
}

const getSnapshot = () => snapshot;

export function useWorld(): UseWorld {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const refresh = useCallback(() => void poll(), []);
  return { ...state, update, refresh };
}
