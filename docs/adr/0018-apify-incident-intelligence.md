# 0018: Incident intelligence from public pages (Apify + Claude, planner-confirmed)

Date: 2026-10-24. Status: accepted for the demo; implementation in progress.

Builds on [0005-historical-incident-packages](0005-historical-incident-packages.md),
[0008-mongodb-backend](0008-mongodb-backend.md) and [0017-dispatch-anywhere](0017-dispatch-anywhere.md).
Contract: [docs/incident-intel.md](../incident-intel.md).

## Context

Road closures, evacuation orders and shelter status are often published only as agency web
pages (county alert pages, CHP/Caltrans incident pages, sheriff posts). Where an official API
exists (for example NWS alerts) we use it; where none exists, a planner currently retypes the
page. The `/incidents` inbox says "Ingestion not configured", and historical packages hold only
hand-curated tables, with `available_at` always `unknown`.

## Decision

- **Crawler: an Apify Actor** (`actors/incident-intel/`, Apify Python SDK). Apify gives us a
  hosted, scheduled crawler with retries and a dataset per run, without running our own
  scraping infrastructure. It only fetches public pages and only outputs source documents
  (text plus provenance); it does no interpretation.
  - `live` mode fetches each configured source URL now.
  - `archive` mode lists Wayback Machine captures of each URL in a time window (CDX API) and
    fetches the raw captures, so a past incident can be replayed "as it was published".
- **Provenance on every document:** `url`, `original_url`, `fetched_at`, `archived_at`
  (Wayback capture time, archive mode), `sha256` of the extracted text. Raw HTML and third-party
  page bodies are not bundled into the app or incident packages; the backend keeps bounded text
  in MongoDB.
- **Claude extracts, never computes.** The backend sends one stored document at a time to
  Claude with a strict JSON schema and validates every field server-side. Claude may only
  categorise (event type), copy times and road/place names as written, quote the supporting
  sentence verbatim, and flag `ambiguous`, `outdated` or `contradicts:<event_id>`. It never
  produces coordinates, edge ids, capacities, routes or metrics. A candidate whose quote is not
  found verbatim in the document is dropped. Page text is wrapped in delimiter tags and treated
  as untrusted data, never as instructions.
- **Planner confirmation gate.** Every extracted record is `evidence_class: "reported"` and
  `review_status: "unconfirmed"`. Only a planner action (confirm, with a road/point mapping)
  makes it usable: confirmed closures are applied to live routing and can be exported to the
  historical replay. Rejected and unconfirmed records never reach a model run.
- **Two consumers.** Historical: `python3 -m sim.intel` exports confirmed candidates as
  `events.jsonl`-shaped rows and the `reported-closures` variant adds them to the Camp replay as
  a labelled `simulated` counterfactual (the baseline bundle is unchanged). Live: the studio and
  dispatch engine fetch confirmed closures for their area and block the matched road edges in
  routing (never folded into fire exposure).
- **Availability time.** `available_at` is the Wayback capture time (archive) or fetch time
  (live), stored with `available_at_status` `archive_capture_upper_bound` /
  `fetched_upper_bound`: an upper bound on when the information was public, not when it was
  published or known to responders. The "as of" control filters by it.

## Consequences

- Secrets (`APIFY_TOKEN`, `ANTHROPIC_API_KEY`) are read only by Django from the environment;
  without them `POST /api/intel/runs` and extraction answer 503 and everything else still works
  (JSON upload of Actor output, review, export). Never in `VITE_*`, responses, logs or fixtures.
- Cost: Apify runs and Claude calls are paid and only start from an explicit planner action
  (no automatic extraction on ingest, no schedules in the repo). `max_documents` caps a run;
  extraction is one document per request and throttled.
- Limitations: Wayback coverage is sparse and capture times lag publication by minutes to days;
  pages change in place, so one URL yields many versions (deduplicated by `sha256`); extraction
  can miss or misread events, which is why review is mandatory; road-name mapping to the OSM
  graph is heuristic and may match too few or too many edges (the UI shows the match count);
  confirming a 2018 notice today uses hindsight, so replay-as-live shows what was public, not
  what a planner would have confirmed at the time.
- Robots and terms: the Actor sends a descriptive User-Agent, honours `robots.txt` in live mode,
  fetches each source at most once per run and keeps request volume low.
