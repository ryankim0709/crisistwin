// Controller client for the live API v2 (docs/live-reports.md). The server needs no controller
// token unless LIVE_CONTROLLER_TOKEN is set; then it is typed in at the console and kept in
// sessionStorage only, never bundled.
import type {
  ApproveProposalRequest,
  ApproveProposalResponse,
  CommandResponse,
  CreateTaskRequest,
  DrillRequest,
  HelpAction,
  DrillResponse,
  ImpactRequest,
  ImpactResponse,
  LiveApiError,
  RejectProposalResponse,
  TaskRoute,
  TriageAction,
  TwinMonitor,
} from "./types";

/** Fallback when `/api/live/active` is unreachable; the live incident is otherwise read from it (active.ts). */
export const DEFAULT_INCIDENT_ID = "camp-2018-drill";
const BASE = "/api/live/";
const TOKEN_KEY = "crisistwin.live.controllerToken";

/** No token in the page: the dev proxy signs controller calls (vite.config.ts). The token form
 * appears only if the server rejects them. */
export const SERVER_TOKEN = "server";

export function readToken(): string | null {
  if (import.meta.env.DEV) {
    // Dev only (stripped from production builds): ?devToken=... seeds the token for headless screenshots.
    const dev = new URLSearchParams(window.location.search).get("devToken");
    if (dev) writeToken(dev);
  }
  try {
    return window.sessionStorage.getItem(TOKEN_KEY) ?? SERVER_TOKEN;
  } catch {
    return SERVER_TOKEN;
  }
}

export function writeToken(token: string | null): void {
  try {
    if (token) window.sessionStorage.setItem(TOKEN_KEY, token);
    else window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage blocked: the token then lives only in component state for this page view.
  }
}

/** The server's answer for an incident that is not (or no longer) the active one. */
const UNKNOWN_INCIDENT_DETAIL = "Unknown incident.";
/** Window event fired when a request named an incident the server no longer knows. */
export const INCIDENT_GONE_EVENT = "crisistwin:live-incident-gone";

export class LiveError extends Error {
  readonly status: number;
  readonly code: string | null;
  /** The parsed JSON error body, when there was one (extra fields such as a 409's owner details). */
  readonly body: Record<string, unknown> | null;
  constructor(status: number, code: string | null, message: string, body: Record<string, unknown> | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
  get unauthorized(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

function describe(status: number, body: Partial<LiveApiError> | null): string {
  if (status === 401 || status === 403) return "Enter the controller token.";
  if (status === 409) return body?.detail ?? "Already decided or changed. Refreshed.";
  if (body?.detail) return body.detail;
  if (body?.error) return body.error.replace(/_/g, " ");
  return `Live API returned HTTP ${status}.`;
}

export async function request<T>(
  token: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(BASE + path, {
      method,
      signal,
      headers: {
        Accept: "application/json",
        ...(token === SERVER_TOKEN ? {} : { Authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new LiveError(0, "network", "Live API unreachable.");
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
    const err = (typeof data === "object" && data !== null ? data : null) as Partial<LiveApiError> | null;
    if (response.status === 404 && err?.detail === UNKNOWN_INCIDENT_DETAIL) {
      // The active drill changed under this page (e.g. a Studio run switched it): let the page re-read it now.
      window.dispatchEvent(new Event(INCIDENT_GONE_EVENT));
    }
    throw new LiveError(response.status, err?.error ?? err?.reason ?? null, describe(response.status, err), err as Record<string, unknown> | null);
  }
  if (data === null && response.status !== 204) {
    throw new LiveError(response.status, "bad_response", "The live API returned an unexpected response.");
  }
  return data as T;
}

function isCommand(data: unknown): data is CommandResponse {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.incident_id === "string" &&
    typeof d.drill === "object" &&
    d.drill !== null &&
    typeof d.fire === "object" &&
    d.fire !== null &&
    Array.isArray(d.zones) &&
    Array.isArray(d.guidance) &&
    Array.isArray(d.proposals) &&
    Array.isArray(d.reports) &&
    Array.isArray(d.public_items) &&
    Array.isArray(d.responders) &&
    Array.isArray(d.tasks) &&
    typeof d.checkins === "object" &&
    d.checkins !== null
  );
}

export async function fetchCommand(token: string, incidentId: string, signal: AbortSignal): Promise<CommandResponse> {
  const data = await request<unknown>(token, "GET", `incidents/${encodeURIComponent(incidentId)}/command`, undefined, signal);
  if (!isCommand(data)) throw new LiveError(200, "bad_response", "The live API returned an unexpected response.");
  return data;
}

function isTwin(data: unknown): data is TwinMonitor {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    d.kind === "crisistwin_live_twin" &&
    typeof d.clock === "object" &&
    d.clock !== null &&
    typeof d.totals === "object" &&
    d.totals !== null &&
    Array.isArray(d.zones) &&
    Array.isArray(d.congested_edges) &&
    Array.isArray(d.destinations) &&
    Array.isArray(d.commands)
  );
}

export async function fetchTwin(token: string, incidentId: string, signal: AbortSignal): Promise<TwinMonitor> {
  const data = await request<unknown>(token, "GET", `incidents/${encodeURIComponent(incidentId)}/twin`, undefined, signal);
  if (!isTwin(data)) throw new LiveError(200, "bad_response", "The twin returned an unexpected response.");
  return data;
}

export const triageReport = (token: string, reportId: string, action: TriageAction) =>
  request<unknown>(token, "POST", `reports/${encodeURIComponent(reportId)}/triage`, { action });

export const helpAction = (token: string, checkinId: string, action: HelpAction, assignee?: string | null) =>
  request<unknown>(token, "POST", `checkins/${encodeURIComponent(checkinId)}/help`, {
    action,
    ...(action === "assign" ? { assignee: assignee ?? null } : {}),
  });

export const createTask = (token: string, incidentId: string, body: CreateTaskRequest) =>
  request<unknown>(token, "POST", `incidents/${encodeURIComponent(incidentId)}/tasks`, body);

// The twin-controller proposal flow is off on Live (LIVE_PROPOSALS, the AI agent decides); approve answers
// 410 then. Kept for /app-integration, which shows pending proposals when the flow is on.
export const approveProposal = (token: string, id: string, zoneIds?: string[]) => {
  const body: ApproveProposalRequest = zoneIds ? { zone_ids: zoneIds } : {};
  return request<ApproveProposalResponse>(token, "POST", `proposals/${encodeURIComponent(id)}/approve`, body);
};

export const rejectProposal = (token: string, id: string) =>
  request<RejectProposalResponse>(token, "POST", `proposals/${encodeURIComponent(id)}/reject`, {});

export const drillAction = (token: string, incidentId: string, body: DrillRequest) =>
  request<DrillResponse>(token, "POST", `incidents/${encodeURIComponent(incidentId)}/drill`, body);

export const runImpact = (token: string, incidentId: string, body: ImpactRequest) =>
  request<ImpactResponse>(token, "POST", `incidents/${encodeURIComponent(incidentId)}/impact`, body);

/** The route from the responder (or the assignee's last location) to an open task. */
export const fetchTaskRoute = (token: string, taskId: string, signal?: AbortSignal) =>
  request<TaskRoute>(token, "GET", `tasks/${encodeURIComponent(taskId)}/route`, undefined, signal);
