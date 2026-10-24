# Backend

Django 5.2 / Django REST Framework, Python 3.12, PostgreSQL 17. See the root
[README](../../README.md) for Docker and local development commands.

`config/` holds Django configuration; `api/` holds HTTP adapters and contract
tests. Keep future simulation calculations in a separate pure Python package,
with explicit inputs/outputs, without importing Django or provider clients.

## API contract

`GET /api/health` (no trailing slash) is unauthenticated, read-only readiness.
It executes `SELECT 1` against PostgreSQL and returns `Cache-Control: no-store`.

HTTP 200:

```json
{"status": "ok", "service": "crisistwin-api", "version": "0.1.0"}
```

HTTP 503 when PostgreSQL is unavailable:

```json
{"status": "unavailable", "service": "crisistwin-api", "version": "0.1.0"}
```

Other methods return 405. `status` and `service` are literal strings; `version`
is a nonempty application version string. The frontend validates this boundary
in `src/lib/api.ts`. This endpoint reports service readiness only; it contains
no observations, simulation results, timestamps, coordinates, or physical units.
New DRF endpoints require authentication by default; the health route explicitly
allows anonymous access. No shared scenario resources exist yet.

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
endpoint does not touch PostgreSQL, so for a demo without a database run
`gunicorn config.wsgi -b 127.0.0.1:8000 --timeout 120` from `app/backend/`
(`runserver` checks migrations and exits when PostgreSQL is down).

## Updating dependencies

Edit the `.in` files, then resolve with [uv](https://docs.astral.sh/uv/pip/compile/):

```sh
uv pip compile requirements.in --python-version 3.12 --output-file requirements.txt
uv pip compile requirements-dev.in --constraint requirements.txt --python-version 3.12 --output-file requirements-dev.txt
```

Review and keep both generated lockfiles. Installation uses pip; uv is only
needed when changing the Python dependency set. Only the optional explain endpoint needs a provider key.
