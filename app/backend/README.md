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

## Updating dependencies

Edit the `.in` files, then resolve with [uv](https://docs.astral.sh/uv/pip/compile/):

```sh
uv pip compile requirements.in --python-version 3.12 --output-file requirements.txt
uv pip compile requirements-dev.in --constraint requirements.txt --python-version 3.12 --output-file requirements-dev.txt
```

Review and keep both generated lockfiles. Installation uses pip; uv is only
needed when changing the Python dependency set. Atlas credentials stay local.
Optional existing contract tests mock the MongoDB boundary; they still require a
syntactically valid `MONGODB_URI` environment variable to load Django settings.
