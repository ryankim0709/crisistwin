/**
 * Client for `/api/intel/` (app/backend/api/intel.py, docs/incident-intel.md, ADR 0018).
 * Candidates are publicly reported, extracted by a model and unconfirmed until a planner
 * reviews them. Wire field names stay snake_case. Page text is data; render it as text only.
 *
 * Units: UTC `YYYY-MM-DDTHH:MM:SSZ`; WGS84 [longitude, latitude]; metres.
 */

export const INTEL_API = "/api/intel";

export const ROAD_TYPES = [
  "road_closed",
  "road_blocked",
  "road_access_restricted",
  "road_reopened",
  "contraflow_reported",
] as const;
export const INTEL_TYPES = [
  ...ROAD_TYPES,
  "evacuation_order",
  "evacuation_warning",
  "alert_sent",
  "shelter_opened",
  "shelter_full",
  "shelter_closed",
] as const;
/** Candidate types created by the open live feeds (ADR 0032-open-live-feeds), not by extraction. */
export const FEED_TYPES = ["weather_alert", "road_closure", "fire_incident"] as const;
export type IntelType = (typeof INTEL_TYPES)[number] | (typeof FEED_TYPES)[number];
export type ReviewStatus = "unconfirmed" | "confirmed" | "rejected";

export const isRoadType = (type: string): boolean => (ROAD_TYPES as readonly string[]).includes(type);

export interface IntelMapping {
  road_name: string;
  point: [number, number];
  radius_m: number;
  edge_ids: string[] | null;
}

export interface IntelCandidate {
  event_id: string;
  incident: string;
  type: IntelType;
  occurred_at: string;
  occurred_from: string | null;
  occurred_to: string | null;
  time_precision: string;
  time_role: string;
  observation_window_min: number | null;
  available_at: string;
  available_at_status: string;
  available_at_reason: string;
  local_time_as_written: string | null;
  target: {
    osm_way_ids?: number[] | null;
    osm_way_ids_status?: string;
    road_name?: string | null;
    from_desc?: string | null;
    to_desc?: string | null;
    place_name?: string | null;
  };
  geometry: { type: "Point"; coordinates: [number, number] } | null;
  geocode_method: string;
  description: string;
  quote: string;
  action_status: string | null;
  source_time_method: string;
  source_number: number | null;
  evidence_class: "reported";
  source_id: string;
  source_locator: string;
  document_id: string;
  mode: string;
  review_status: ReviewStatus;
  reviewer: string | null;
  reviewer_note: string | null;
  reviewed_at: string | null;
  mapping: IntelMapping | null;
  flags: string[];
  extraction: {
    model: string;
    prompt_version: string;
    extracted_at: string;
    document_sha256: string;
  } | null;
  created_at: string;
  /** Set on candidates made by an open feed ("nws", "caltrans", "wfigs"). */
  feed?: string;
  source_url?: string;
  fetched_at?: string;
  /** Feed-specific fields as published (acres, containment, closure id, severity, ...). */
  details?: Record<string, unknown>;
}

export interface IntelDocument {
  document_id: string;
  incident: string;
  source_id: string;
  source_kind: string;
  mode: string;
  url: string;
  original_url: string;
  title: string | null;
  fetched_at: string;
  archived_at: string | null;
  sha256: string;
  text_chars: number;
  excerpt: string;
  extracted_at: string | null;
  candidate_count: number;
}

export interface Rejection {
  index: number;
  reason: string;
}
export interface IngestResult {
  incident: string;
  stored: number;
  duplicates: number;
  rejected: Rejection[];
  document_ids: string[];
  run_id?: string;
  already_ingested?: boolean;
}
export interface ExtractResult {
  document_id: string;
  model: string;
  extracted_at: string;
  candidates: IntelCandidate[];
  dropped: Rejection[];
}
export interface RunResult {
  run_id: string;
  dataset_id: string;
  status: string;
  incident: string;
  started_at: string;
}
export interface CandidateQuery {
  incident?: string;
  status?: readonly ReviewStatus[];
  types?: readonly string[];
  asOf?: string | null;
  bbox?: readonly number[];
}
export interface ReviewBody {
  review_status: ReviewStatus;
  reviewer: string | null;
  reviewer_note: string | null;
  mapping: { road_name: string; point: [number, number]; radius_m?: number } | null;
}

export class IntelRequestError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "IntelRequestError";
  }
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new IntelRequestError("bad_response", `The intel service returned an unexpected ${what}.`);
  return value as Record<string, unknown>;
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value))
    throw new IntelRequestError("bad_response", `The intel service returned an unexpected ${what}.`);
  return value;
}

async function request(path: string, signal: AbortSignal | undefined, body?: unknown) {
  const init: RequestInit = { signal, headers: { Accept: "application/json" } };
  if (body !== undefined) {
    init.method = "POST";
    init.headers = { ...init.headers, "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  let response: Response;
  try {
    response = await fetch(`${INTEL_API}${path}`, init);
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new IntelRequestError("unreachable", "The intel service could not be reached.");
  }
  if (!response.ok) {
    let code = "http_error";
    let detail = `The intel service returned HTTP ${response.status}.`;
    try {
      const failure = (await response.json()) as { error?: string; detail?: string };
      if (failure.error) code = failure.error;
      if (failure.detail) detail = failure.detail;
    } catch {
      // Not JSON (a proxy error page, or the backend is not running); keep the status message.
    }
    throw new IntelRequestError(code, detail);
  }
  try {
    return record(await response.json(), "response");
  } catch (cause) {
    if (cause instanceof IntelRequestError) throw cause;
    throw new IntelRequestError("bad_response", "The intel service returned invalid JSON.");
  }
}

const num = (value: unknown, name: string): number => {
  if (typeof value !== "number") throw new IntelRequestError("bad_response", `Missing ${name}.`);
  return value;
};
const str = (value: unknown, name: string): string => {
  if (typeof value !== "string") throw new IntelRequestError("bad_response", `Missing ${name}.`);
  return value;
};
const rejections = (value: unknown): Rejection[] =>
  list(value, "rejection list").map((raw) => {
    const row = record(raw, "rejection");
    return { index: num(row.index, "index"), reason: str(row.reason, "reason") };
  });

function candidate(raw: unknown): IntelCandidate {
  const row = record(raw, "candidate");
  str(row.event_id, "event_id");
  str(row.type, "type");
  str(row.available_at, "available_at");
  str(row.review_status, "review_status");
  if (!Array.isArray(row.flags)) row.flags = [];
  return row as unknown as IntelCandidate;
}

function document(raw: unknown): IntelDocument {
  const row = record(raw, "document");
  str(row.document_id, "document_id");
  str(row.url, "url");
  return row as unknown as IntelDocument;
}

export async function listCandidates(
  query: CandidateQuery,
  signal?: AbortSignal,
): Promise<{ candidates: IntelCandidate[]; count: number; as_of: string | null }> {
  const params = new URLSearchParams();
  if (query.incident) params.set("incident", query.incident);
  if (query.status?.length) params.set("status", query.status.join(","));
  if (query.types?.length) params.set("types", query.types.join(","));
  if (query.asOf) params.set("as_of", query.asOf);
  if (query.bbox) params.set("bbox", query.bbox.map((v) => v.toFixed(5)).join(","));
  const body = await request(`/candidates?${params}`, signal);
  const candidates = list(body.candidates, "candidate list").map(candidate);
  return {
    candidates,
    count: typeof body.count === "number" ? body.count : candidates.length,
    as_of: typeof body.as_of === "string" ? body.as_of : null,
  };
}

export async function listDocuments(incident: string, signal?: AbortSignal): Promise<IntelDocument[]> {
  const body = await request(`/documents?incident=${encodeURIComponent(incident)}`, signal);
  return list(body.documents, "document list").map(document);
}

export async function ingestItems(
  incident: string,
  items: unknown[],
  timeZone: string,
  signal?: AbortSignal,
): Promise<IngestResult> {
  const body = await request("/ingest", signal, { incident, time_zone: timeZone, items });
  return {
    incident: str(body.incident, "incident"),
    stored: num(body.stored, "stored"),
    duplicates: num(body.duplicates, "duplicates"),
    rejected: rejections(body.rejected ?? []),
    document_ids: list(body.document_ids ?? [], "id list").map((id) => str(id, "document id")),
    ...(typeof body.run_id === "string" ? { run_id: body.run_id } : {}),
    ...(typeof body.already_ingested === "boolean" ? { already_ingested: body.already_ingested } : {}),
  };
}

/** Ingests the Actor's latest SUCCEEDED run; a run already ingested is reported, not repeated. */
export async function ingestLatestRun(
  incident: string,
  timeZone: string,
  signal?: AbortSignal,
): Promise<IngestResult> {
  const body = await request("/ingest", signal, { incident, time_zone: timeZone, latest_run: true });
  return {
    incident: str(body.incident, "incident"),
    stored: num(body.stored, "stored"),
    duplicates: num(body.duplicates, "duplicates"),
    rejected: rejections(body.rejected ?? []),
    document_ids: list(body.document_ids ?? [], "id list").map((id) => str(id, "document id")),
    ...(typeof body.run_id === "string" ? { run_id: body.run_id } : {}),
    ...(typeof body.already_ingested === "boolean" ? { already_ingested: body.already_ingested } : {}),
  };
}

/** Confirmed-reachable public sources for a live run (docs/incident-intel.md, "Live presets"). */
export interface LivePreset {
  label: string;
  id: string;
  url: string;
  kind: "agency" | "road_status" | "shelter" | "news" | "other";
  /** Set when the URL takes a highway number in place of `{route}`. */
  routeTemplate?: boolean;
}
export const LIVE_PRESETS: LivePreset[] = [
  {
    label: "Caltrans highway conditions (route)",
    id: "caltrans-route",
    url: "https://roads.dot.ca.gov/roadscell.php?roadnumber={route}",
    kind: "road_status",
    routeTemplate: true,
  },
  {
    label: "Caltrans road information",
    id: "caltrans-road-info",
    url: "https://roads.dot.ca.gov/",
    kind: "road_status",
  },
];

/** Paid: sends the document to Claude. Only call from an explicit planner action. */
export async function extractDocument(
  documentId: string,
  signal?: AbortSignal,
): Promise<ExtractResult> {
  const body = await request(`/documents/${encodeURIComponent(documentId)}/extract`, signal, {});
  return {
    document_id: str(body.document_id, "document_id"),
    model: str(body.model, "model"),
    extracted_at: str(body.extracted_at, "extracted_at"),
    candidates: list(body.candidates, "candidate list").map(candidate),
    dropped: rejections(body.dropped ?? []),
  };
}

export async function startRun(
  incident: string,
  input: unknown,
  timeZone: string,
  signal?: AbortSignal,
): Promise<RunResult> {
  const body = await request("/runs", signal, { incident, time_zone: timeZone, input });
  return {
    run_id: str(body.run_id, "run_id"),
    dataset_id: str(body.dataset_id, "dataset_id"),
    status: str(body.status, "status"),
    incident: str(body.incident, "incident"),
    started_at: str(body.started_at, "started_at"),
  };
}

export async function reviewCandidate(
  eventId: string,
  review: ReviewBody,
  signal?: AbortSignal,
): Promise<IntelCandidate> {
  return candidate(
    await request(`/candidates/${encodeURIComponent(eventId)}/review`, signal, review),
  );
}

export type FeedName = "nws" | "caltrans" | "wfigs";
export interface FeedStatus {
  feed: FeedName;
  label: string;
  status: "never" | "ok" | "error";
  last_poll_at: string | null;
  error: { code: string; detail: string } | null;
  counts: { unconfirmed: number; confirmed: number; rejected: number };
}
export interface PollResult {
  feed: FeedName;
  candidates: number;
  created: number;
  updated: number;
  unchanged: number;
}

export async function listFeeds(incident: string, signal?: AbortSignal): Promise<FeedStatus[]> {
  const body = await request(`/feeds?incident=${encodeURIComponent(incident)}`, signal);
  return list(body.feeds, "feed list").map((raw) => {
    const row = record(raw, "feed");
    str(row.feed, "feed");
    str(row.label, "label");
    record(row.counts, "counts");
    return row as unknown as FeedStatus;
  });
}

/** Fetches one open feed now; candidates arrive unconfirmed. `bbox` is [west, south, east, north]. */
export async function pollFeed(
  feed: FeedName,
  options: { incident: string; bbox: readonly number[] },
  signal?: AbortSignal,
): Promise<PollResult> {
  const body = await request(`/feeds/${feed}/poll`, signal, options);
  return {
    feed: str(body.feed, "feed") as FeedName,
    candidates: num(body.candidates, "candidates"),
    created: num(body.created, "created"),
    updated: num(body.updated, "updated"),
    unchanged: num(body.unchanged, "unchanged"),
  };
}
