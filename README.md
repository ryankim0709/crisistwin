# CrisisTwin

A Cal Hacks project exploring disaster response and evacuation planning through an interactive digital twin.

CrisisTwin will let emergency planners test how fire spread, road closures, evacuation demand, and resource decisions interact before comparing possible responses.

## Full project scope

See the [Cal Hacks 13.0 project scope](docs/project-scope.md) for the full feature
plan, priorities, sponsor integrations, three-person team responsibilities, and
target demo. It describes proposed work, not implemented functionality. Its
suggested technology choices are proposals; the current stack and setup are
documented below and in the [scaffold decision](docs/adr/0001-app-scaffold.md).

## Initial demo scope

- Visualize a wildfire scenario and a surrounding road network.
- Simulate community evacuation demand and traffic bottlenecks.
- Inject changes such as a wind shift, bridge closure, or simultaneous departures.
- Compare evacuation strategies, departure times, and shelter assignments.
- Show assumptions, uncertainty, and which missing observations could change a decision.

## Project status

The full stack development scaffold is in [`app/`](app/): React/TypeScript with
Vite and Tailwind CSS, a Django REST Framework API, PostgreSQL, Vitest, and Docker.
The workspace checks the API and database connection. An imagery-based geographic map at
`/maps` supports zooming, panning, and selecting a location. Scenario creation,
simulation, and data integrations are not implemented yet; the items above
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

### Map component

Open **http://localhost:5173/maps** for the map. `app/src/maps/MapCanvas.tsx`
provides a reusable **MapLibre GL JS** component with USGS aerial imagery,
smooth zoom/pan, compass controls, and location selection. It defaults to a
Sierra Nevada view, with no region restrictions or demo overlays. The map needs
WebGL2 and internet access; no API key or backend is needed.

```tsx
<MapCanvas
  center={{ latitude: 37.75, longitude: -119.6 }}
  zoom={11}
  onLocationSelect={({ latitude, longitude }) => {
    // Decimal degrees in WGS84; connect to scenario inputs here.
  }}
/>
```

The parent supplies a container height. `center`, `zoom`, and optional `mapStyle`
(a MapLibre style object or URL) reset the map when changed. Keep object props
stable when the view should be preserved. `onLocationSelect` receives a WGS84
coordinate on click, or when Enter selects the map center. Arrow keys pan;
`+`/`-` zoom. Selection is local UI state and does not run a simulation.

USGS imagery is historical, not live fire data. Detailed aerial coverage is
primarily in the US; other regions may have only coarse imagery. The default
source's highest native zoom is 16; closer views enlarge those tiles. Supply an
appropriately licensed `mapStyle` for another provider or coverage area. See the
[map decision](docs/adr/0002-geographic-map.md).

After pulling changed dependencies into an existing Docker setup, refresh its
separate npm volume:

```sh
cd app
docker compose exec -T frontend npm ci
docker compose restart frontend
```

### Default hackathon check

Run only pre-commit before committing, from the repository root:

```sh
python3 -m pip install pre-commit
pre-commit run --all-files
```

The hooks check merge-conflict markers, trailing whitespace, and final newlines.
Agents should not add or run tests, coverage, lint, type checks, builds, Docker
verification, or browser verification unless explicitly requested.

### Optional local checks in Docker

These commands are available on request; they are not required for the hackathon.
With the stack running, execute them from `app/`:

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

Optional host backend checks run from `app/backend/` using `.venv/bin/ruff check .`,
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
