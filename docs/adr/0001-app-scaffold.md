# 0001: Full stack app scaffold

Date: 2026-10-23. Status: accepted.

Keep application code in `app/`, following the local Duedi project: React 19,
TypeScript, Vite, Tailwind CSS 4, Vitest with Testing Library, and Django 5.2 LTS
with Django REST Framework and PostgreSQL 17. Use Node 22 (22.12+) and Python 3.12
in Docker and for the documented local setup.

The frontend lives in `app/src/`; Django configuration and API adapters live in
`app/backend/config/` and `app/backend/api/`. Future numerical simulation code
must remain independent of HTTP, Django models, React, and LLM providers. No
simulation algorithm or persistence schema has been selected by this scaffold.

Use npm with `package-lock.json` and pip with fully resolved, pinned
`requirements.txt` / `requirements-dev.txt`. The `.in` files declare direct Python
dependencies; uv's compiler generates the pip-compatible locks. Runtime and dev
locks share the same runtime versions. Docker uses the same locks.

Development Compose runs the frontend, backend, and database with hot reload and
health checks. Use host ports 5173, 8000, and 5434 so the app can coexist with
Duedi. API requests stay same-origin through Vite or Nginx. Redis, Celery, cloud
services, authentication flows, and simulation infrastructure are deferred until
needed. Local quality commands are available; CI is intentionally omitted for
the hackathon at the user's request.

This reuses Duedi's development patterns while avoiding its product-specific
dependencies. The tradeoff is two runtimes and a local database; Docker is the
default setup to keep that manageable. Production image build targets exist,
but hosting, TLS, secrets, and deployment configuration are not provisioned.
