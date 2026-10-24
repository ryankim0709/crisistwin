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

## Live drill API (`/api/live/`)

Implements v1 and v2 of [docs/live-reports.md](../../docs/live-reports.md) (ADR 0011, 0012):
field reports, road state, public map, check tasks, the drill clock, the fire estimate,
per-zone guidance with controller proposals, check-ins and responder location. Code:
`api/live/` (HTTP + MongoDB) over the pure `livecore/` package (rules, planner, routing).
Everything is a labeled drill of the 2018 Camp Fire; nothing is a real incident.

- Auth: `Authorization: Bearer <token>`. `POST /api/live/devices` issues civilian tokens;
  `POST /api/live/incidents/camp-2018-drill/join {"invite_code"}` issues responder tokens
  (`LIVE_INVITE_CODE`); the controller uses `LIVE_CONTROLLER_TOKEN`. Unset secrets fail
  closed (403). Device tokens are stored as SHA-256 hashes.
- The planner fixes every level, route and number. The rationale LLM
  (`LIVE_RATIONALE_MODEL`, `ANTHROPIC_API_KEY`) only rewrites the template text in a
  background thread (10 s timeout); without a key the template stays.
- `LIVE_DRILL_BUNDLE` points at the replay bundle (default
  `app/public/replays/camp-2018.json`); it is parsed once per process on first use.
- Not implemented yet: `POST incidents/{id}/impact` and `POST incidents/{id}/route` return 501.

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

## Updating dependencies

Edit the `.in` files, then resolve with [uv](https://docs.astral.sh/uv/pip/compile/):

```sh
uv pip compile requirements.in --python-version 3.12 --output-file requirements.txt
uv pip compile requirements-dev.in --constraint requirements.txt --python-version 3.12 --output-file requirements-dev.txt
```

Review and keep both generated lockfiles. Installation uses pip; uv is only
needed when changing the Python dependency set. Atlas credentials stay local, and only
the optional explain endpoint needs a provider key (`ANTHROPIC_API_KEY`).
Optional existing contract tests mock the MongoDB boundary; they still require a
syntactically valid `MONGODB_URI` environment variable to load Django settings.
