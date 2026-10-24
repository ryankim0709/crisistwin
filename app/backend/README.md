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

## Updating dependencies

Edit the `.in` files, then resolve with [uv](https://docs.astral.sh/uv/pip/compile/):

```sh
uv pip compile requirements.in --python-version 3.12 --output-file requirements.txt
uv pip compile requirements-dev.in --constraint requirements.txt --python-version 3.12 --output-file requirements-dev.txt
```

Review and keep both generated lockfiles. Installation uses pip; uv is only
needed when changing the Python dependency set. No provider keys are required.
