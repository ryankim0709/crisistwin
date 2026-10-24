import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import {
  Button,
  EmptyResult,
  EvidenceTag,
  Facts,
  Field,
  Notice,
  Panel,
  Tag,
  WorkspacePage,
} from "./WorkspaceUI";
import { LoadingState } from "../ui";
import IncidentLibrary from "./IncidentLibrary";
import {
  IntelRequestError,
  extractDocument,
  ingestItems,
  ingestLatestRun,
  LIVE_PRESETS,
  isRoadType,
  listCandidates,
  listDocuments,
  reviewCandidate,
  startRun,
  type IngestResult,
  type IntelCandidate,
  type IntelDocument,
  type ReviewStatus,
} from "../intel/api";
import "../intel/intel.css";

const DEFAULT_INCIDENT = "camp-2018";
const DEFAULT_ZONE = "America/Los_Angeles";
const STATUS_OPTIONS: { value: ReviewStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "unconfirmed", label: "Unconfirmed" },
  { value: "confirmed", label: "Confirmed" },
  { value: "rejected", label: "Rejected" },
];

const typeLabel = (type: string) => type.replace(/_/g, " ");
const utc = (value: string | null) => (value ? value.replace("T", " ").replace(/:00Z$/, "Z") : "none");
const message = (cause: unknown) =>
  cause instanceof IntelRequestError ? cause.detail : "The intel service request failed.";

/* ---- As-of control: datetime-local in the incident's zone <-> UTC ---- */

function zoneParts(ms: number, zone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const out: Record<string, number> = {};
  for (const part of parts) if (part.type !== "literal") out[part.type] = Number(part.value);
  return out;
}

function zoneOffsetMs(ms: number, zone: string): number {
  const p = zoneParts(ms, zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** "YYYY-MM-DDTHH:MM" wall time in `zone` to UTC "YYYY-MM-DDTHH:MM:SSZ"; null when invalid. */
export function localToUtc(local: string, zone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  try {
    let ms = wall - zoneOffsetMs(wall, zone);
    ms = wall - zoneOffsetMs(ms, zone);
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  } catch {
    return null;
  }
}

function utcToLocal(isoUtc: string, zone: string): string {
  const p = zoneParts(Date.parse(isoUtc), zone);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${two(p.month)}-${two(p.day)}T${two(p.hour)}:${two(p.minute)}`;
}

/* ---- Candidate card ---- */

function CandidateCard({
  candidate,
  reviewer,
  onChanged,
}: {
  candidate: IntelCandidate;
  reviewer: string;
  onChanged: (updated: IntelCandidate) => void;
}) {
  const road = isRoadType(candidate.type);
  const id = `intel-${candidate.event_id}`;
  const [roadName, setRoadName] = useState(
    candidate.mapping?.road_name ?? candidate.target.road_name ?? "",
  );
  const [lon, setLon] = useState(candidate.mapping ? String(candidate.mapping.point[0]) : "");
  const [lat, setLat] = useState(candidate.mapping ? String(candidate.mapping.point[1]) : "");
  const [radius, setRadius] = useState(String(candidate.mapping?.radius_m ?? 75));
  const [note, setNote] = useState(candidate.reviewer_note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (status: ReviewStatus) => {
    setError(null);
    let mapping = null;
    const hasPoint = lon.trim() !== "" || lat.trim() !== "";
    if (status === "confirmed" && road && !(roadName.trim() && lon.trim() && lat.trim())) {
      setError("Confirming a road report needs a road name and a point (longitude and latitude).");
      return;
    }
    if (hasPoint) {
      const point: [number, number] = [Number(lon), Number(lat)];
      if (!Number.isFinite(point[0]) || !Number.isFinite(point[1]) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) {
        setError("Longitude must be within ±180 and latitude within ±90.");
        return;
      }
      const radius_m = radius.trim() === "" ? undefined : Number(radius);
      if (radius_m !== undefined && !(radius_m >= 25 && radius_m <= 500)) {
        setError("Radius must be 25 to 500 m.");
        return;
      }
      mapping = { road_name: roadName.trim(), point, radius_m };
    }
    setBusy(true);
    try {
      onChanged(
        await reviewCandidate(candidate.event_id, {
          review_status: status,
          reviewer: reviewer.trim() || null,
          reviewer_note: note.trim() || null,
          mapping,
        }),
      );
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const statusTone =
    candidate.review_status === "confirmed" ? "success" : candidate.review_status === "rejected" ? "danger" : "warning";
  const statusText =
    candidate.review_status === "unconfirmed"
      ? "Reported · unconfirmed"
      : candidate.review_status === "confirmed"
        ? "Reported · confirmed by planner"
        : "Rejected";
  const place = candidate.target.road_name ?? candidate.target.place_name;

  return (
    <li className="intel-item">
      <div className="intel-tags">
        <h3 id={id}>{typeLabel(candidate.type)}</h3>
        <EvidenceTag kind="reported" />
        <Tag tone={statusTone}>{statusText}</Tag>
        {candidate.flags.map((flag) => (
          <Tag key={flag} tone="info">
            Flag: {flag}
          </Tag>
        ))}
      </div>
      {place && (
        <p className="intel-meta">
          {place}
          {candidate.target.from_desc ? ` · from ${candidate.target.from_desc}` : ""}
          {candidate.target.to_desc ? ` · to ${candidate.target.to_desc}` : ""}
        </p>
      )}
      <p>{candidate.description}</p>
      <p className="intel-quote">{candidate.quote}</p>
      <Facts
        items={[
          { label: "Time as written", value: candidate.local_time_as_written ?? "none" },
          { label: "Occurred at (UTC)", value: utc(candidate.occurred_at) },
          {
            label: "Public by (UTC, upper bound)",
            value: `${utc(candidate.available_at)}; the page may have been public earlier`,
          },
          {
            label: "Source",
            value: /^https?:\/\//.test(candidate.source_locator) ? (
              <>
                <a
                  className="ui-text-link"
                  href={candidate.source_locator.split(";")[0]}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {candidate.source_id}
                </a>
                <span className="intel-meta"> {candidate.source_locator}</span>
              </>
            ) : (
              candidate.source_locator
            ),
          },
        ]}
      />
      {candidate.reviewed_at && (
        <p className="intel-meta">
          Reviewed {utc(candidate.reviewed_at)}
          {candidate.reviewer ? ` by ${candidate.reviewer}` : ""}
          {candidate.mapping ? ` · mapped to ${candidate.mapping.road_name}` : ""}
        </p>
      )}
      <div className="intel-review" role="group" aria-labelledby={id}>
        {road && (
          <>
            <Field label="Road name">
              <input value={roadName} maxLength={200} onChange={(e) => setRoadName(e.target.value)} />
            </Field>
            <Field label="Longitude">
              <input inputMode="decimal" value={lon} onChange={(e) => setLon(e.target.value)} />
            </Field>
            <Field label="Latitude">
              <input inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} />
            </Field>
            <Field label="Radius (m)">
              <input inputMode="numeric" value={radius} onChange={(e) => setRadius(e.target.value)} />
            </Field>
          </>
        )}
        <Field label="Note">
          <input value={note} maxLength={600} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      {error && <Notice tone="danger" compact>{error}</Notice>}
      <div className="intel-actions">
        <Button size="sm" disabled={busy || candidate.review_status === "confirmed"} onClick={() => submit("confirmed")}>
          Confirm
        </Button>
        <Button size="sm" variant="secondary" disabled={busy || candidate.review_status === "rejected"} onClick={() => submit("rejected")}>
          Reject
        </Button>
        <Button size="sm" variant="ghost" disabled={busy || candidate.review_status === "unconfirmed"} onClick={() => submit("unconfirmed")}>
          Back to unconfirmed
        </Button>
      </div>
    </li>
  );
}

/* ---- Page ---- */

export default function IntelPage() {
  const [incident, setIncident] = useState(DEFAULT_INCIDENT);
  const [zone, setZone] = useState(DEFAULT_ZONE);
  const [reviewer, setReviewer] = useState("");
  const [status, setStatus] = useState<ReviewStatus | "all">("unconfirmed");
  const [asOfLocal, setAsOfLocal] = useState("");
  const asOf = asOfLocal ? localToUtc(asOfLocal, zone) : null;

  const [documents, setDocuments] = useState<IntelDocument[] | null>(null);
  const [documentsError, setDocumentsError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<IntelCandidate[] | null>(null);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const incidentId = incident.trim();
  useEffect(() => {
    if (!incidentId) return;
    const controller = new AbortController();
    setDocuments(null);
    setDocumentsError(null);
    listDocuments(incidentId, controller.signal)
      .then(setDocuments)
      .catch((cause) => !controller.signal.aborted && setDocumentsError(message(cause)));
    return () => controller.abort();
  }, [incidentId, reload]);

  useEffect(() => {
    if (!incidentId) return;
    const controller = new AbortController();
    setCandidates(null);
    setCandidatesError(null);
    listCandidates(
      { incident: incidentId, status: status === "all" ? undefined : [status], asOf },
      controller.signal,
    )
      .then((result) => setCandidates(result.candidates))
      .catch((cause) => !controller.signal.aborted && setCandidatesError(message(cause)));
    return () => controller.abort();
  }, [incidentId, status, asOf, reload]);

  const replaceCandidate = useCallback(
    (updated: IntelCandidate) =>
      setCandidates((rows) =>
        rows
          ? rows
              .map((row) => (row.event_id === updated.event_id ? updated : row))
              .filter((row) => status === "all" || row.review_status === status)
          : rows,
      ),
    [status],
  );

  const step = (hours: number) => {
    if (!asOf) return;
    const next = new Date(Date.parse(asOf) + hours * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    setAsOfLocal(utcToLocal(next, zone));
  };

  // Extraction (paid) per document
  const [extracting, setExtracting] = useState<string | null>(null);
  const [extractNote, setExtractNote] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const extract = async (doc: IntelDocument) => {
    setExtracting(doc.document_id);
    setExtractNote(null);
    try {
      const result = await extractDocument(doc.document_id);
      setExtractNote({
        tone: "success",
        text: `${result.candidates.length} candidate(s) extracted, ${result.dropped.length} dropped. Review them below.`,
      });
      setReload((n) => n + 1);
    } catch (cause) {
      setExtractNote({ tone: "danger", text: message(cause) });
    } finally {
      setExtracting(null);
    }
  };

  // Upload of Actor dataset items
  const [ingest, setIngest] = useState<{ result?: IngestResult; error?: string } | null>(null);
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!Array.isArray(parsed)) throw new Error();
      const result = await ingestItems(incidentId, parsed, zone);
      setIngest({ result });
      setReload((n) => n + 1);
    } catch (cause) {
      setIngest({
        error: cause instanceof IntelRequestError ? cause.detail : "The file must be a JSON array of Actor dataset items.",
      });
    }
  };

  const [latestBusy, setLatestBusy] = useState(false);
  const ingestLatest = async () => {
    setLatestBusy(true);
    try {
      const result = await ingestLatestRun(incidentId, zone);
      setIngest({ result });
      setReload((n) => n + 1);
    } catch (cause) {
      setIngest({ error: message(cause) });
    } finally {
      setLatestBusy(false);
    }
  };

  // Optional Apify run
  const [route, setRoute] = useState("299");
  const applyPreset = (index: string) => {
    const preset = LIVE_PRESETS[Number(index)];
    if (!preset) return;
    const n = route.trim();
    setRun((r) => ({
      ...r,
      mode: "live",
      id: preset.routeTemplate ? `${preset.id}-${n}` : preset.id,
      url: preset.url.replace("{route}", encodeURIComponent(n)),
      kind: preset.kind,
    }));
  };
  const [run, setRun] = useState({ mode: "archive", id: "", url: "", kind: "agency", from: "", to: "" });
  const [runNote, setRunNote] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const submitRun = async (event: FormEvent) => {
    event.preventDefault();
    setRunNote(null);
    const toUtc = (v: string) => (v ? `${v}:00Z` : "");
    try {
      const result = await startRun(
        incidentId,
        {
          mode: run.mode,
          sources: [{ id: run.id, url: run.url, kind: run.kind }],
          ...(run.mode === "archive" ? { window: { from: toUtc(run.from), to: toUtc(run.to) } } : {}),
        },
        zone,
      );
      setRunNote({
        tone: "success",
        text: `Run ${result.run_id} ${result.status.toLowerCase()}. When it finishes, export its dataset and upload it above.`,
      });
    } catch (cause) {
      setRunNote({ tone: "danger", text: message(cause) });
    }
  };

  return (
    <WorkspacePage
      title="Incident intelligence"
      description="Historical incidents and the publicly reported records fetched for them, confirmed by a planner before use."
    >
      <Notice title="Reported, not observed" tone="info">
        Records are extracted by a model from page text and stay unconfirmed until you confirm
        them. Page content is untrusted. Nothing here is fetched until you add it.
      </Notice>
      <IncidentLibrary
        selectedId={incidentId}
        onSelect={(picked) => {
          setIncident(picked.id);
          setZone(picked.timezone);
        }}
      />
      <Panel title="Incident" eyebrow="Scope">
        <div className="ui-fields">
          <Field label="Incident id">
            <input value={incident} onChange={(e) => setIncident(e.target.value.toLowerCase())} />
          </Field>
          <Field label="Time zone" hint="Local times on pages and the as-of control">
            <input value={zone} onChange={(e) => setZone(e.target.value)} />
          </Field>
          <Field label="Reviewer" hint="Self-declared; there is no sign-in">
            <input value={reviewer} maxLength={80} onChange={(e) => setReviewer(e.target.value)} />
          </Field>
        </div>
      </Panel>

      <div className="ui-split">
        <Panel title="Documents" eyebrow="01 / Fetched pages">
          {extractNote && <Notice tone={extractNote.tone === "danger" ? "danger" : "success"} compact>{extractNote.text}</Notice>}
          {documentsError ? (
            <Notice tone="danger">{documentsError}</Notice>
          ) : documents === null ? (
            <LoadingState>Loading documents…</LoadingState>
          ) : documents.length === 0 ? (
            <EmptyResult title="Nothing fetched yet">
              Upload Actor dataset items below to add source documents for this incident.
            </EmptyResult>
          ) : (
            <ul className="intel-list">
              {documents.map((doc) => (
                <li className="intel-item" key={doc.document_id}>
                  <div className="intel-tags">
                    <h3>{doc.title ?? doc.source_id}</h3>
                    <Tag>{doc.mode}</Tag>
                    <Tag>{doc.candidate_count} candidates</Tag>
                  </div>
                  <p className="intel-meta">
                    <a className="ui-text-link" href={doc.original_url} target="_blank" rel="noopener noreferrer">
                      {doc.original_url}
                    </a>
                  </p>
                  <p className="intel-meta">
                    Captured {utc(doc.archived_at ?? doc.fetched_at)} · {doc.text_chars} characters
                    {doc.extracted_at ? ` · extracted ${utc(doc.extracted_at)}` : " · not extracted"}
                  </p>
                  <p className="intel-quote">{doc.excerpt}</p>
                  <div className="intel-actions">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={extracting !== null}
                      onClick={() => extract(doc)}
                      title="Sends this page to Claude; a paid call"
                    >
                      {extracting === doc.document_id ? "Extracting…" : "Extract with Claude"}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Add documents" eyebrow="02 / Actor output">
          <Field label="Actor dataset (JSON)" hint="A JSON array of dataset items, up to 200 and 2 MB">
            <input type="file" accept="application/json,.json" onChange={upload} />
          </Field>
          {ingest?.error && <Notice tone="danger" compact>{ingest.error}</Notice>}
          {ingest?.result && (
            <>
              <Facts
                items={[
                  { label: "Stored", value: ingest.result.stored },
                  { label: "Duplicates", value: ingest.result.duplicates },
                  { label: "Rejected", value: ingest.result.rejected.length },
                ]}
              />
              {ingest.result.rejected.length > 0 && (
                <ul className="intel-meta">
                  {ingest.result.rejected.map((r) => (
                    <li key={r.index}>
                      Item {r.index}: {r.reason}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <Button variant="secondary" disabled={latestBusy} onClick={ingestLatest}>
            Ingest latest live run
          </Button>
          {ingest?.result?.already_ingested && (
            <Notice tone="success" compact>Run {ingest.result.run_id} was already ingested.</Notice>
          )}
          <details>
            <summary>Start an Apify run</summary>
            <form onSubmit={submitRun} className="ui-stack">
              <Field label="Live preset" hint="Fills the source below and sets mode to live">
                <select value="" onChange={(e) => applyPreset(e.target.value)}>
                  <option value="">Choose…</option>
                  {LIVE_PRESETS.map((p, i) => (
                    <option key={p.id} value={i}>{p.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Route number (Caltrans preset)">
                <input inputMode="numeric" pattern="[0-9]{1,3}" maxLength={3} value={route} onChange={(e) => setRoute(e.target.value)} />
              </Field>
              <Field label="Mode">
                <select value={run.mode} onChange={(e) => setRun({ ...run, mode: e.target.value })}>
                  <option value="archive">Archive (Wayback)</option>
                  <option value="live">Live</option>
                </select>
              </Field>
              <Field label="Source id">
                <input required pattern="[a-z0-9][a-z0-9\-]{1,63}" value={run.id} onChange={(e) => setRun({ ...run, id: e.target.value })} />
              </Field>
              <Field label="Source URL">
                <input required type="url" maxLength={2000} value={run.url} onChange={(e) => setRun({ ...run, url: e.target.value })} />
              </Field>
              <Field label="Kind">
                <select value={run.kind} onChange={(e) => setRun({ ...run, kind: e.target.value })}>
                  {["agency", "road_status", "shelter", "news", "other"].map((k) => (
                    <option key={k} value={k}>{typeLabel(k)}</option>
                  ))}
                </select>
              </Field>
              {run.mode === "archive" && (
                <>
                  <Field label="Window from (UTC)">
                    <input required type="datetime-local" value={run.from} onChange={(e) => setRun({ ...run, from: e.target.value })} />
                  </Field>
                  <Field label="Window to (UTC)">
                    <input required type="datetime-local" value={run.to} onChange={(e) => setRun({ ...run, to: e.target.value })} />
                  </Field>
                </>
              )}
              <Button type="submit" variant="secondary">Start run</Button>
            </form>
            {runNote && <Notice tone={runNote.tone === "danger" ? "danger" : "success"} compact>{runNote.text}</Notice>}
          </details>
        </Panel>
      </div>

      <Panel title="Candidates" eyebrow="03 / Review">
        <div className="intel-asof">
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value as ReviewStatus | "all")}>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </Field>
          <Field label={`As of (${zone})`}>
            <input type="datetime-local" value={asOfLocal} onChange={(e) => setAsOfLocal(e.target.value)} />
          </Field>
          <Button size="sm" variant="secondary" disabled={!asOf} onClick={() => step(-1)}>−1 h</Button>
          <Button size="sm" variant="secondary" disabled={!asOf} onClick={() => step(1)}>+1 h</Button>
          <Button size="sm" variant="soft" disabled={!asOfLocal} onClick={() => setAsOfLocal("")}>Latest</Button>
        </div>
        <p className="ui-help">
          {asOf ? `Showing reports public by ${utc(asOf)} (UTC). ` : "Showing latest. "}
          Review state is current, not as of this time.
        </p>
        {candidatesError ? (
          <Notice tone="danger">{candidatesError}</Notice>
        ) : candidates === null ? (
          <LoadingState>Loading candidates…</LoadingState>
        ) : candidates.length === 0 ? (
          <EmptyResult title="No candidates">
            None fetched yet, or none match these filters. Extract a document to create candidates.
          </EmptyResult>
        ) : (
          <ul className="intel-list" aria-label="Candidate reports">
            {candidates.map((c) => (
              <CandidateCard key={c.event_id} candidate={c} reviewer={reviewer} onChanged={replaceCandidate} />
            ))}
          </ul>
        )}
      </Panel>
    </WorkspacePage>
  );
}
