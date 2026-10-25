// Fetch helpers for the shared world (docs/shared-world.md). Reads are open; writes carry the
// live controller token when the console has one (same sessionStorage token as /live; the dev
// proxy signs local calls otherwise, vite.config.ts).
import { readToken, SERVER_TOKEN } from "../live/api";
import {
  WORLD_SCHEMA,
  type CreateScenarioRequest,
  type LoadScenarioResponse,
  type Scenario,
  type ScenarioSummary,
  type World,
  type WorldChanges,
  type WorldWriter,
} from "./contracts";

const BASE = "/api/world/";

export class WorldApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  /** The server's current world on a 409 revision conflict. */
  readonly world: World | null;
  constructor(status: number, code: string | null, message: string, world: World | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.world = world;
  }
  get conflict(): boolean {
    return this.status === 409 && this.world !== null;
  }
  get unauthorized(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Shape check at the boundary; the server validates every field on write. */
export function parseWorld(data: unknown): World | null {
  if (
    !isObject(data) ||
    data.schema !== WORLD_SCHEMA ||
    typeof data.revision !== "number" ||
    !isObject(data.region) ||
    !Array.isArray(data.region.center) ||
    !isObject(data.conditions) ||
    typeof data.conditions.startUtc !== "string" ||
    !isObject(data.fire) ||
    !Array.isArray(data.fire.ignitions) ||
    typeof data.seed !== "number"
  ) {
    return null;
  }
  return data as unknown as World;
}

async function request<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const token = method === "GET" ? SERVER_TOKEN : readToken();
  let response: Response;
  try {
    response = await fetch(BASE + path, {
      method,
      signal,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(token && token !== SERVER_TOKEN ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new WorldApiError(0, "network", "World API unreachable.");
  }
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    const err = isObject(data) ? data : {};
    const code = typeof err.error === "string" ? err.error : null;
    const detail =
      response.status === 401 || response.status === 403
        ? "Enter the controller token on /live to change the shared world."
        : typeof err.detail === "string"
          ? err.detail
          : `World API returned HTTP ${response.status}.`;
    throw new WorldApiError(
      response.status,
      code,
      detail,
      response.status === 409 ? parseWorld(err.world) : null,
    );
  }
  return data as T;
}

function expectWorld(data: unknown): World {
  const world = parseWorld(data);
  if (!world)
    throw new WorldApiError(200, "bad_response", "The world API returned an unexpected response.");
  return world;
}

export async function fetchWorld(signal?: AbortSignal): Promise<World> {
  return expectWorld(await request<unknown>("GET", "active", undefined, signal));
}

/** PATCH the active world. Throws `WorldApiError` with `.conflict` and `.world` when `baseRevision` is stale. */
export async function patchWorld(
  baseRevision: number,
  updatedBy: WorldWriter,
  changes: WorldChanges,
): Promise<World> {
  return expectWorld(
    await request<unknown>("PATCH", "active", { baseRevision, updatedBy, changes }),
  );
}

export async function listScenarios(signal?: AbortSignal): Promise<ScenarioSummary[]> {
  const data = await request<unknown>("GET", "scenarios", undefined, signal);
  if (!isObject(data) || !Array.isArray(data.scenarios)) return [];
  return data.scenarios.filter(
    (s): s is ScenarioSummary => isObject(s) && typeof s.id === "string",
  );
}

export async function fetchScenario(id: string, signal?: AbortSignal): Promise<Scenario> {
  return request<Scenario>("GET", `scenarios/${encodeURIComponent(id)}`, undefined, signal);
}

export async function createScenario(body: CreateScenarioRequest): Promise<Scenario> {
  return request<Scenario>("POST", "scenarios", body);
}

/** Make a saved scenario's world the active world (a new revision). Without `baseRevision` the
 * load replaces whatever is active. */
export async function loadScenario(
  id: string,
  updatedBy: WorldWriter,
  baseRevision?: number,
): Promise<LoadScenarioResponse> {
  const data = await request<unknown>("POST", `scenarios/${encodeURIComponent(id)}/load`, {
    updatedBy,
    ...(baseRevision === undefined ? {} : { baseRevision }),
  });
  if (!isObject(data) || !isObject(data.scenario)) {
    throw new WorldApiError(200, "bad_response", "The world API returned an unexpected response.");
  }
  return { world: expectWorld(data.world), scenario: data.scenario as unknown as Scenario };
}

export async function deleteScenario(id: string): Promise<void> {
  await request<unknown>("DELETE", `scenarios/${encodeURIComponent(id)}`);
}
