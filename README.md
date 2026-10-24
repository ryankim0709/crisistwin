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
The workspace checks the API and database connection. The imagery map at `/maps`
starts over San Francisco and supports an illustrative fire-spread experiment:
choose an origin, set wind, and inspect the simulated footprint in 15-minute
steps. Calibrated fire/traffic models, persistent scenarios, and live incident
integrations are not implemented yet.

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

Open **http://localhost:5173/maps** for the map and fire-spread demo:

1. Click to choose the fire origin (or focus the map and press Enter).
2. Set wind speed in **mph** and the compass direction it comes **from**.
3. Select **Simulate fire**. The map focuses on the origin and shows +15 minutes.
4. Step, scrub, or play through **0–120 minutes in 15-minute intervals**.

Changing wind or origin clears the previous run. Playback advances through
precomputed frames; it does not change the model's simulation clock. The model
is an illustrative uniform-fuel approximation: terrain, water, buildings,
moisture, and suppression are not modeled. The map's imagery is not a model
input. See the [fire model and frame contract](docs/adr/0003-illustrative-fire-spread.md).

`app/src/maps/MapCanvas.tsx` is the reusable **MapLibre GL JS** component. It uses
USGS historical imagery and a bundled SF overview so the first view has geography
while detailed tiles stream. Cached-image sources, retrieval times, and bounds
are in `app/public/map-preview/provenance.json`. Outside that preview coverage,
imagery requires the remote service. WebGL2 is required; no API key is needed.
MapLibre's worker is explicitly bundled using Vite's `?worker&url` import so
GeoJSON simulation overlays can render in development and production.

```tsx
<MapCanvas
  center={{ latitude: 37.7749, longitude: -122.4194 }}
  zoom={11.5}
  selectedLocation={origin}
  firePerimeter={frame?.perimeter}
  onLocationSelect={setOrigin}
/>
```

The parent supplies a container height. `center` and `zoom` move the existing map;
`selectedLocation` controls the marker (`null` clears it); `firePerimeter` updates
only the GeoJSON overlay. Optional `mapStyle` accepts a MapLibre style object or
URL and recreates the map when changed. Keep style objects stable. Selection
callbacks return WGS84 decimal degrees, with longitude normalized to [-180, 180).
Arrow keys pan and `+`/`-` zoom when the map canvas is focused.

USGS imagery is historical, not live fire data. Detailed coverage is primarily
in the US. We cap remote requests at native zoom 16 and overscale at closer
views. A local SF overview, bounded image concurrency, tile caching, and
canceling obsolete zoom requests reduce loading stalls. **Retry imagery** retries
remote tiles on demand. See the [map decision](docs/adr/0002-geographic-map.md).

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
