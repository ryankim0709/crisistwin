# Backend

Django 5.2 / Django REST Framework, Python 3.12, MongoDB through PyMongo 4. See the root
[README](../../README.md) for Docker and local development commands.

`config/` holds Django configuration; `api/` holds HTTP adapters and contract
tests. `api/mongodb.py` owns the shared connection pool. Keep future simulation
calculations in a separate pure Python package,
with explicit inputs/outputs, without importing Django or provider clients.

## API contract

`GET /api/health` (no trailing slash) is unauthenticated, read-only readiness.
It executes `ping` against the configured MongoDB database and returns
`Cache-Control: no-store`. It creates no collections and writes no records.
The ping checks connectivity and connection authentication when credentials are
supplied; it does not certify collection permissions, data availability, or
artifact integrity.

HTTP 200:

```json
{"status": "ok", "service": "crisistwin-api", "version": "0.1.0"}
```

HTTP 503 when MongoDB is unavailable, authentication fails, or PyMongo rejects
the connection configuration (no driver error or credential details in the body):

```json
{"status": "unavailable", "service": "crisistwin-api", "version": "0.1.0"}
```

Other methods return 405. `status` and `service` are literal strings; `version`
is a nonempty application version string. The frontend validates this boundary
in `src/lib/api.ts`. This endpoint reports service readiness only; it contains
no observations, simulation results, timestamps, coordinates, or physical units.
DRF retains `IsAuthenticated` as the default permission, so new endpoints remain
closed by default; the health route explicitly allows anonymous access. SQL-backed
auth/session apps and middleware are removed, authentication classes are empty,
and unauthenticated users are `None`. Add an explicit authentication/authorization
implementation before introducing shared resources. No shared scenario resources
exist yet.

## MongoDB configuration and boundary

- `MONGODB_URI`: required server-side `mongodb://` or `mongodb+srv://` URI; never
  expose it through a `VITE_*` variable. Compose reads the shell or `app/.env`;
  host Django reads only the shell. To use the team setup, export it from
  `~/.mongodb_uri` without printing the value. Django stores it under a secret
  setting and redacts the environment key from debug exception metadata.
- `MONGODB_DATABASE`: defaults to `crisistwin`, explicitly overriding the URI
  path; 1–63 ASCII letters, digits, underscores, or hyphens. This matches the
  team's database-scoped Atlas access even when its URI has no database path.
- `get_database() -> pymongo.database.Database[dict[str, Any]]`: shared database
  handle for future server-side adapters. One lazy, thread-safe client pool per
  worker, closed on normal process exit. Do not initialize it before forking.
  Datetimes decode as timezone-aware UTC. Provider, HTTP, and numerical model
  code must remain separate; no document schema is introduced in this change.
- Client-side operation, server selection, socket, and connection timeouts are
  each 3,000 milliseconds. There is no application retry loop. Cold SRV DNS
  resolution occurs during client creation and may add startup latency.

Missing URI/scheme or invalid database names fail startup with a credential-free
configuration error. Network/authentication failures return readiness 503 and can
recover on a later request. Django's SQL `DATABASES` is empty; do not run `migrate`
or `makemigrations`. No existing application data is migrated, and no Atlas users,
network rules, collections, or historical artifacts are changed by app startup.
The historical replay data tooling is a separate branch/integration; this change
does not implement artifact upload/download or expose those datasets over HTTP.

See [ADR 0008](../../docs/adr/0008-mongodb-backend.md) for the architecture tradeoff.

### `POST /api/replay/explain`

Optional AI explanation of a replay (paid Anthropic API, model `claude-opus-5-5`).
Implemented in `api/explain.py`; the client is `src/replay/ai/`. Anonymous for the
local demo and throttled to 10 requests per minute per client IP. The model only
explains the numbers it is sent: the system prompt forbids new figures, routes,
capacities or confidence levels, requires field citations and evidence classes,
and forbids directive phrasing. The context is treated as data, not instructions.

Request (body at most 64 000 bytes; canonical `context` JSON at most 48 000 chars):

```json
{"question": "Why did congestion form here?",
 "context": {"incident": {"id": "camp-2018-paradise-slice", "name": "Camp Fire (2018)"},
             "clock": {"now_utc": "2018-11-08T18:00:00Z"},
             "metrics_now": {"exposed_veh": 120, "evidence_class": "simulated"},
             "traffic_summary": {}, "insights": {}, "recent_events": [],
             "closures": {"closure_events_so_far": 40, "edges_closed_now": 12},
             "layer_status": {}, "assumptions": [], "limitations": []}}
```

`question` is 1–500 characters. `context` allows only the keys shown; `incident`,
`clock` and `layer_status` are required. The frontend builds it from the loaded
bundle at the current clock (`src/replay/ai/context.ts`).

HTTP 200 (`Cache-Control: no-store`):

```json
{"answer_markdown": "…", "model": "claude-opus-5-5", "generated_at": "2026-10-23T21:40:00Z",
 "evidence_class": "ai_explanation", "context_digest": "sha256:<hex of canonical context>"}
```

Errors are `{"error": "<code>", "detail": "<human-readable>"}`: 400
`invalid_request`, 413 `too_large`, 429 throttled (DRF `{"detail"}`) or
`upstream_rate_limited`, 503 `ai_unavailable` (no `ANTHROPIC_API_KEY`, or the key was
rejected), 504 `upstream_timeout` (90 s, one retry), 502 `upstream_*` for other
provider errors, refusals or empty answers. Requests use server-side refusal
fallback (`fallbacks: "default"`).

Set `ANTHROPIC_API_KEY` in the backend's environment to enable it (see
`app/.env.example`). Never put it in frontend code or `VITE_*` variables. The
endpoint does not query MongoDB. Run the backend with a gunicorn timeout longer than a
model call, e.g. `gunicorn config.wsgi -b 127.0.0.1:8000 --timeout 120`.

### `GET /api/landscapes` and `GET /api/landscapes/<region_id>`

Public (`AllowAny`), read-only GET/HEAD endpoints in `api/landscapes.py` over the GridFS
bucket `landscape_packages` written by the offline builder (ADR 0013). The server never
writes and never creates indexes. Recommended index (the builder/uploader may create it):

```js
db.getCollection("landscape_packages.files").createIndex({ "metadata.regionId": 1, "metadata.builtAt": -1 })
```

List: `{"regions": [{id, name?, counties?, summary?, center?, radiusMeters?, cellMeters, width,
height, builtAt, bytes, sha256}]}`, newest package per `metadata.regionId`, at most 100,
`Cache-Control: public, max-age=60`. Catalogue fields (`name`, `counties`, `summary`,
`center`, `radiusMeters`) and lattice fields (`width`, `height`, `cellMeters`, from
`metadata.lattice`) are passed through when the builder stored them and omitted otherwise,
so the client should join missing ones with `src/fire/regions.ts`.

Package: `region_id` must match `^[a-z0-9-]{1,64}$`. Streams the newest package in GridFS
chunks with `Content-Type: application/gzip` (no `Content-Encoding`), `Content-Length`,
`ETag: "<sha256>"` and `Cache-Control: public, max-age=3600`; a matching `If-None-Match`
returns 304. Errors are JSON: 404 `{"error": "not_found"}` for unknown/unbuilt regions,
503 `{"error": "unavailable"}` on MongoDB/GridFS errors (no driver text).

### Live broadcast and families

`GET /api/live`, `POST /api/live/broadcast` (`api/live_broadcast.py`) and `/api/families…`
(`api/families.py`) serve the resident iOS app. They use MongoDB collections
`live_broadcast` and `families`. Request and response shapes are in
[ADR 0016](../../docs/adr/0016-resident-live-and-family.md) and
`app/src/live/contracts.ts`.

### Mobile data (`/api/mobile/…`)

`POST /api/mobile/devices` and `/api/mobile/data/<collection>[/<id>]` (`api/mobile_data.py`)
let the iOS app push any JSON object to Atlas and pull it back while its schema is designed.
A device registers once for a bearer token (stored as a hash) and sees only its own documents,
kept in the `mobile_documents` collection (devices in `mobile_devices`). Limits, errors and
examples are in [ADR 0029](../../docs/adr/0029-mobile-data-store.md).

### Command demo (`/api/demo/…`)

`api/demo.py` serves the `/demo` page ([ADR 0047](../../docs/adr/0047-command-demo.md); wire
shapes in `app/src/demo/contracts.ts`). Both endpoints are anonymous for the local demo, answer
`Cache-Control: no-store` and return errors as `{"error", "detail"}`. The game itself runs in the
browser; nothing here is stored.

- `POST /api/demo/routes` `{fires: [ring, ...]}` (at most 60 closed `[lon, lat]` rings of 4-200
  points; body at most 300 kB; 120/min) returns `{zones: [{zone_id, options}], evidence_class:
  "simulated"}`: each drill zone's best route and up to 3 alternatives around the fires, from
  `livecore.routing` over the drill road graph. Distances are metres, `eta_min` minutes.
- `POST /api/demo/decide` `{observation}` (at most 200 kB; 40/min) streams `application/x-ndjson`
  like `/api/dispatch/decide`: `thinking`/`text` lines, then one `orders` or `error` line. Claude
  can `send_crew`, `release_crew` or `order_evacuation`; each order is validated against the ids
  in the observation (at most 20 per decision). Needs `ANTHROPIC_API_KEY` (else 503
  `ai_unavailable`) and reuses `DISPATCH_AGENT_MODEL` and `DISPATCH_AGENT_EFFORT`.

### Live drill API (`/api/live/…`)

Implements v1 and v2 of [docs/live-reports.md](../../docs/live-reports.md) (ADR 0011, 0012):
field reports, road state, public map, check tasks, the drill clock, the fire estimate,
per-zone guidance with controller proposals, check-ins and responder location. Code:
`api/live/` (HTTP + MongoDB) over the pure `livecore/` package (rules, planner, routing).
Everything is a labeled drill of the 2018 Camp Fire; nothing is a real incident. It shares
the `/api/live` prefix with the broadcast above but no code or collections (`live_*`).

- Auth: `Authorization: Bearer <token>`. `POST /api/live/devices` issues civilian tokens;
  `POST /api/live/incidents/camp-2018-drill/join {"invite_code"}` issues responder tokens
  (`LIVE_INVITE_CODE`, unset -> 403). The controller needs no token while
  `LIVE_CONTROLLER_TOKEN` is unset; setting it requires that bearer token. Device tokens are stored as SHA-256 hashes.
- The planner fixes every level, route and number. The rationale LLM
  (`LIVE_RATIONALE_MODEL`, `ANTHROPIC_API_KEY`) only rewrites the template text in a
  background thread (10 s timeout); without a key the template stays.
- `LIVE_DRILL_BUNDLE` points at the replay bundle (default
  `app/public/replays/camp-2018.json`); it is parsed once per process on first use.
- `POST incidents/{id}/impact` (controller) compares one road segment blocked and unblocked:
  two planner runs give the affected zones and their ETA delta, and one twin what-if
  (simulated, about 1-3 s) gives the vehicles at risk and window metrics (`api/live/impact.py`).
- `GET incidents/{id}/aar` (controller) returns the after-action report and drill score
  (`api/live/aar.py`; [contract](../../docs/live-reports.md#after-action-report)).
- Not implemented yet: `POST incidents/{id}/route` returns 501.

Local run (Docker MongoDB on 127.0.0.1:27017):

```sh
export MONGODB_URI=mongodb://127.0.0.1:27017 MONGODB_DATABASE=crisistwin_live_dev
export LIVE_CONTROLLER_TOKEN=dev-controller LIVE_INVITE_CODE=DRILL
python manage.py live_init_db            # indexes + validators, once per database
python manage.py live_drill --reset --seed   # start the clock; add labeled drill-fixture reports
python manage.py runserver 127.0.0.1:8000
```

`live_drill` also takes `--speed` (0..60 drill seconds per wall second) and
`--replay-start`. `--seed` inserts three synthetic civilian reports of a full block on
Skyway in Paradise (`evidence_class: "drill_fixture"`, note says synthetic).
`live_init_db --drop-drill-data` drops all live drill data but keeps device tokens.

`python manage.py live_smoke` (same env, server running) checks the whole phone ↔ `/live` loop
over HTTP in about 5 s, with no simulator or browser: report, triage, replan and approve,
guidance on the phone, destination choice, check-ins, responder position and a check task. It
writes synthetic drill data; run `live_drill --reset` afterwards.

`python manage.py live_compare_record --confirm-delay-min 5 --out /tmp/record-compare` (same env;
no server, no database writes, about 1-2 min) is a simulated planning experiment: the live twin
and planner headless from 14:30Z to 18:00Z, without a controller, with one who confirms the 2018
record's `road_blocked`/`fire_seen` entries N minutes late, and with the previous free-flow
planner. It writes `.json` and `.md`; see [live-reports.md](../../docs/live-reports.md)
("Record comparison harness") and ADR `0031-congestion-aware-planner.md`.

`python manage.py live_loadtest --base http://127.0.0.1:8020 --ramp 10,50,100,200 --duration 30
--out results.json` ramps simulated phones and consoles against a server started with
`LIVE_LOADTEST_RELAX_LIMITS=1` and prints p50/p95/p99 per endpoint; `--cleanup` removes its
data. Use a separate server and database, never the shared one. Method and results:
[docs/live-loadtest.md](../../docs/live-loadtest.md).

`python manage.py live_batch --spec api/live/specs/camp-2018-pilot.json --strategies
historical_only,rule_auto,record_delay_5 --workers 8 --out /tmp/batch-pilot` (same env; no
server, no database writes; about 3 min for 24 runs on 8 cores) is the headless batch runner:
scenario × strategy × seed in lockstep on the drill clock, scored with the AAR in drill minutes,
one `RunManifest` per run and a paired comparison table. Simulated planning experiments; see
[batch-runner.md](../../docs/batch-runner.md) and ADR `0049-batch-runner.md`.

### Incident intelligence (`/api/intel/…`)

Public agency pages, fetched by the Apify Actor in `actors/incident-intel/`, become source
documents; Claude extracts candidate events from one document at a time; a planner confirms,
maps or rejects each candidate. Full request/response shapes, field rules and examples:
[docs/incident-intel.md](../../docs/incident-intel.md) (decision:
[ADR 0018](../../docs/adr/0018-apify-incident-intelligence.md)). Views in `api/intel.py`,
prompt/schema/candidate rules in `api/intel_extract.py` (pure), Apify wrapper in
`api/intel_apify.py`. MongoDB collections `intel_runs`, `intel_documents`,
`intel_candidates`.

| Endpoint | Purpose |
| -------- | ------- |
| `POST /api/intel/runs` | Start the Actor on Apify (paid; 5/min). 202 `{run_id, dataset_id, status, incident, started_at}` |
| `POST /api/intel/ingest` | Store Actor output by `run_id`, `dataset_id`, or uploaded `items` (<= 2 MB, <= 200). `sha256` is recomputed; no extraction |
| `GET /api/intel/documents?incident=` | Stored documents (excerpt, no full text) |
| `POST /api/intel/documents/<document_id>/extract` | Claude extraction of one document (paid; 10/min) |
| `GET /api/intel/candidates?incident=&status=&types=&as_of=&bbox=` | Candidates, sorted by `available_at`, at most 500 |
| `POST /api/intel/candidates/<event_id>/review` | Planner confirm/reject/reset; confirming a road event requires `mapping.point` |

Every candidate is `evidence_class: "reported"` and starts `review_status: "unconfirmed"`;
only the review endpoint changes it. Claude copies text and categorises; it never outputs
coordinates or edge ids, and an event whose quote is not in the page is dropped. Page text is
sent inside `<scraped_page>` tags as untrusted data. Endpoints are anonymous for the local demo,
throttled, and answer `Cache-Control: no-store`; errors are `{"error", "detail"}`.

Environment (server-side only, never `VITE_*`): `APIFY_TOKEN` and `APIFY_ACTOR_ID` enable
runs and ingest by run/dataset id; without them (or without the `apify-client` package) those
answer 503 `apify_unavailable`, while uploading `items`, listing, review and export still
work. `ANTHROPIC_API_KEY` enables extraction; without it, 503 `ai_unavailable`. MongoDB
outages answer 503 `database_unavailable`.

## Updating dependencies

Edit the `.in` files, then resolve with [uv](https://docs.astral.sh/uv/pip/compile/):

```sh
uv pip compile requirements.in --python-version 3.12 --output-file requirements.txt
uv pip compile requirements-dev.in --constraint requirements.txt --python-version 3.12 --output-file requirements-dev.txt
```

Review and keep both generated lockfiles. Installation uses pip; uv is only
needed when changing the Python dependency set. Atlas credentials stay local, and only
the optional explain, dispatch and intel extraction endpoints need a provider key
(`ANTHROPIC_API_KEY`); intel runs need `APIFY_TOKEN`/`APIFY_ACTOR_ID`.
Optional existing contract tests mock the MongoDB boundary; they still require a
syntactically valid `MONGODB_URI` environment variable to load Django settings.

### Simulation state (`/api/sim-state/…`)

`api/sim_state.py` stores the Studio's evacuation run and serves per-home advice to the
iOS app. Everything is simulated (synthetic homes and addresses). No auth; throttled.
Collections `sim_runs` (run, zones, current tick state) and `sim_homes` (one document per
home with a 2dsphere `location`); only the 3 newest runs are kept. Full contract, limits
and documents: [`docs/sim-state-api.md`](../../docs/sim-state-api.md).

- `POST /api/sim-state/runs`: publish a run (zones and homes), returns `201 {run_id}`.
- `POST /api/sim-state/runs/<run_id>/tick`: push the state at one simulation minute.
- `GET /api/sim-state/latest`: latest run, current minute and per-zone state.
- `GET /api/sim-state/advice?lon=&lat=` or `?home_id=`: advice for one home.
- `GET /api/sim-state/homes?q=&limit=`: address search.
