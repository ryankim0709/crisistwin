# CrisisTwin

A Cal Hacks project exploring disaster response and evacuation planning through an interactive digital twin.

CrisisTwin will let emergency planners test how fire spread, road closures, evacuation demand, and resource decisions interact before comparing possible responses.

## Initial demo scope

- Visualize a wildfire scenario and a surrounding road network.
- Simulate community evacuation demand and traffic bottlenecks.
- Inject changes such as a wind shift, bridge closure, or simultaneous departures.
- Compare evacuation strategies, departure times, and shelter assignments.
- Show assumptions, uncertainty, and which missing observations could change a decision.

## Project status

The full stack development scaffold is in [`app/`](app/): React/TypeScript with
Vite and Tailwind CSS, a Django REST Framework API, PostgreSQL, Vitest, and Docker.
The starter page checks the API and database connection. Scenario creation,
simulation, maps, and data integrations are not implemented yet; the items above
describe the intended prototype.

This is an experimental planning simulator. Its outputs are not operational evacuation instructions; any future resident guidance should require approval by the responsible authority.

## Development

Clone the repository:

```sh
git clone https://github.com/ryankim0709/crisistwin.git
cd crisistwin
```

### Start with Docker

Install Docker with Compose v2 or newer. From the repository root:

```sh
cd app
docker compose up --build --wait
```

Open **http://localhost:5173**. The API is at **http://localhost:8000/api/health**;
PostgreSQL is exposed on `127.0.0.1:5434`. These ports differ from Duedi's local
ports so both projects can run together. Frontend and backend source changes
reload automatically. The backend applies migrations before starting; PostgreSQL
data is retained in a named volume.

No environment file or API keys are required. Optional local overrides are
documented in [`app/.env.example`](app/.env.example); copy it to `app/.env` for
Compose. Development credentials are local placeholders. Keep real credentials
out of Git and browser environment variables.

```sh
# Follow logs / stop the stack (keeps database data)
docker compose logs -f
docker compose down

# After changing dependencies, rebuild and refresh the frontend dependency volume
docker compose build
docker compose run --rm --no-deps frontend npm ci
docker compose up --wait
```

### Stack and directory map

- Node.js **22.12+** (Node 22 in Docker and `.nvmrc`), **npm**, and `package-lock.json`.
- Python **3.12**, **pip**, and fully pinned runtime/development `requirements*.txt`.
- React **19**, TypeScript **5.8**, Vite **7**, Tailwind CSS **4**.
- Django **5.2 LTS**, Django REST Framework **3**, PostgreSQL **17**.
- Vitest **3**, Testing Library, jsdom, ESLint, Prettier, and Ruff for local checks.

```text
app/
  src/                  React UI and API client (lib/), Vitest setup (test/)
  backend/
    config/             Django settings, routes, WSGI
    api/                HTTP endpoints and backend contract tests
    requirements*.in    Direct Python dependency declarations
    requirements*.txt   Resolved, pinned Python dependencies
  docker-compose.yml    Development frontend + backend + PostgreSQL
  Dockerfile.dev        Vite development image
  Dockerfile            Built frontend served by Nginx, with /api proxy
  backend/Dockerfile    Django runtime and development image targets
docs/adr/               Shared architecture decisions
```

See the [scaffold decision](docs/adr/0001-app-scaffold.md) and
[API contract](app/backend/README.md). There are no CI workflows for this
hackathon; checks run locally when needed.

### Local checks in Docker

With the stack running, execute these from `app/`:

```sh
docker compose exec frontend npm run check
docker compose exec frontend npm run test:coverage
docker compose exec backend ruff check .
docker compose exec backend ruff format --check .
docker compose exec backend python manage.py check
docker compose exec backend python manage.py makemigrations --check --dry-run
docker compose exec backend python manage.py test --noinput
```

`npm run check` runs Prettier, ESLint, TypeScript, Vitest, and the frontend build.
Individual commands are `npm run format:check`, `npm run lint`,
`npm run typecheck`, `npm test`, and `npm run build`. Use `npm run test:watch`
while developing. Tests use mocked network/database boundaries; Docker startup
and the health endpoint check the real database connection.

### Run app processes on your host

Use the versions above. Start only PostgreSQL with Docker, then create a local
Python environment. From `app/`:

```sh
docker compose up -d --wait db
python3.12 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements-dev.txt
backend/.venv/bin/python backend/manage.py migrate
backend/.venv/bin/python backend/manage.py runserver 127.0.0.1:8000
```

In a second terminal, from `app/`:

```sh
nvm use
npm ci
npm run dev
```

The default host configuration uses the same local database values as Compose.
Django reads environment variables from the shell; it does not load `.env`
automatically. If you change database credentials in Compose, export the matching
`POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD` in the backend shell.
Vite proxies `/api` to `http://127.0.0.1:8000` on the host and `http://backend:8000`
in Docker. To change the host target, use
`VITE_API_PROXY_TARGET=http://127.0.0.1:8000 npm run dev`.

Host backend checks run from `app/backend/` using `.venv/bin/ruff check .`,
`.venv/bin/ruff format --check .`, `.venv/bin/python manage.py check`,
`.venv/bin/python manage.py makemigrations --check --dry-run`, and
`.venv/bin/python manage.py test --noinput`.

### Build runtime images

From `app/`, `docker build -t crisistwin-frontend .` builds the Nginx frontend
image. `docker build --target runtime -t crisistwin-backend backend` builds the
Gunicorn backend image. Nginx expects a backend reachable at `backend:8000`.
`npm run preview` only previews static build output; use Compose to exercise
the full stack. Deployment, TLS, hosting, and production secrets are not
configured by this scaffold.

## Working with coding agents

[AGENTS.md](AGENTS.md) contains the shared engineering, collaboration, verification, and simulation rules. Read it before starting work and keep team decisions in the repository so both partners' agents see the same context.

Codex uses `AGENTS.md` directly. Cursor, Claude Code, and GitHub Copilot have small adapters that point to the same file. Change shared guidance in `AGENTS.md` to keep the tools aligned.

For concurrent work, use separate branches and checkouts/worktrees and agree on shared interfaces before editing overlapping files. Use the pull request template to hand off changes and verification results.

## Concept background

The project grew out of [this planning conversation](https://chatgpt.com/share/6adc0b53-b864-83e8-84f7-8560e24d2a15).
