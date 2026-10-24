# CrisisTwin incident intelligence Actor

Fetches public agency, road-status, shelter and news pages and returns one cleaned text
document per page or capture. It never calls an LLM. Extraction into candidate records happens
later in the backend (`POST /api/intel/documents/<id>/extract`), and every record stays
`reported` / `unconfirmed` until a planner reviews it. Contract:
[docs/incident-intel.md](../../docs/incident-intel.md), decision:
[ADR 0018](../../docs/adr/0018-apify-incident-intelligence.md).

- `archive` mode queries the Wayback Machine CDX API for captures inside `window` and fetches
  each raw capture (`.../web/<timestamp>id_/<url>`).
- `live` mode fetches each URL now and honours `robots.txt`.
- Both modes: User-Agent `CrisisTwin-IncidentIntel/0.1 (wildfire planning research)`, 20 s
  timeout, 1 s between requests, `text/html` and `text/plain` only, bodies over 3 MB skipped.
  Page text is data; nothing in it is interpreted.
- A source that fails is logged and skipped; partial items are never pushed.

Apify runs are paid. They are started only by a planner through `POST /api/intel/runs`, never
automatically. On the platform the standard `apify/actor-python` base image is used.

## Input

```json
{
  "mode": "archive",
  "sources": [
    {"id": "example-agency", "url": "https://www.example.gov/incident-page", "kind": "agency"}
  ],
  "window": {"from": "2018-11-08T00:00:00Z", "to": "2018-11-12T00:00:00Z"},
  "max_documents": 25,
  "max_captures_per_source": 10
}
```

`window` (UTC, `from < to`) is required in `archive` and ignored in `live`. Invalid input fails
the run with a message.

## Output item (illustrative only, not a real capture)

```json
{
  "kind": "crisistwin_intel_document",
  "schema_version": "1.0.0",
  "source_id": "example-agency",
  "source_kind": "agency",
  "mode": "archive",
  "url": "https://web.archive.org/web/20181108201512id_/https://www.example.gov/incident-page",
  "original_url": "https://www.example.gov/incident-page",
  "fetched_at": "<UTC time of the fetch>",
  "archived_at": "2018-11-08T20:15:12Z",
  "http_status": 200,
  "content_type": "text/html",
  "sha256": "<64 hex of the UTF-8 text>",
  "title": "<page title or null>",
  "text": "<cleaned page text, at most 50,000 characters>",
  "text_truncated": false,
  "language": "en",
  "wayback_digest": "<CDX digest>"
}
```

`archived_at` and `wayback_digest` are `null` in `live` mode.

### Real sample

[`examples/camp-2018-calfire-incident.json`](examples/camp-2018-calfire-incident.json) holds
eight real archive-mode items: every Wayback capture of the CAL FIRE Camp Fire incident page
(`http://www.fire.ca.gov/current_incidents/incidentdetails/Index/2277`) from 2018-11-08 to
2018-11-11 UTC. They were produced by this Actor's own `validate_input` and `archive_documents`
run locally, with the Apify SDK stubbed, on 2026-10-24. The same three captures were also fetched
through Apify's `apify/web-fetch` Actor and their page text matched. Wayback returned HTTP 500 to
most direct requests until the retry with backoff was added. Use this file as an upload to
`POST /api/intel/ingest`.

## Run locally (no Apify platform)

```sh
cd actors/incident-intel
pip install -r requirements.txt
export APIFY_LOCAL_STORAGE_DIR=./storage
mkdir -p storage/key_value_stores/default
# write the input shown above to storage/key_value_stores/default/INPUT.json
python -m src
```

Items land in `storage/datasets/default/*.json`. To build an ingest body for
`POST /api/intel/ingest`, merge them into a list:

```sh
python -c "import json,glob; print(json.dumps({'incident': 'camp-2018', 'items': [json.load(open(f)) for f in sorted(glob.glob('storage/datasets/default/*.json'))]}))" > ingest.json
```

Ingest accepts at most 200 items and 2 MB per request. Do not commit `storage/` or `ingest.json`.

## Scheduling

To poll live sources, create an Apify schedule in the console (for example every 15 minutes)
that starts this Actor with `mode: "live"` and the sources as input; this repo creates none and
each run is billed. In CrisisTwin, "Ingest latest live run" on the Intel page
(`POST /api/intel/ingest` with `{"latest_run": true}`) ingests the newest `SUCCEEDED` run once;
calling it again before another run finishes does nothing. Suggested live sources and the ones
checked and rejected are listed in [docs/incident-intel.md](../../docs/incident-intel.md#live-presets).
