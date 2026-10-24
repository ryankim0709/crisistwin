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
The workspace has shared sidebar navigation, page-specific UI scaffolds, and an
overview that checks the API and database connection. Planning pages support
temporary local input editing; they do not save scenarios or execute evacuation
models. The imagery map at `/maps` starts over San Francisco and supports an
illustrative fire-spread experiment:
choose an origin, set wind, and inspect the simulated footprint in 15-minute
steps. Calibrated fire/traffic models, persistent scenarios, and live incident
integrations are not implemented yet.

The native iOS scaffold is in [`mobile/`](mobile/README.md): a SwiftUI workspace,
API/database readiness card, and a scenario empty state. Native maps, simulation,
and scenario synchronization are not implemented in the mobile app yet.

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
- Mobile: **iOS 17+**, **Xcode 16.2+**, bundled Swift compiler in **Swift 5** mode,
  SwiftUI/Foundation only. Future Swift dependencies use Swift Package Manager;
  no package dependencies or resolved lockfile are needed for this scaffold.

```text
app/
  src/                  React UI and API client (lib/), Vitest setup (test/)
    AppShell.tsx        Shared sidebar and responsive navigation
    navigation.ts       Route labels and descriptions
    pages/              Planning page scaffolds, shared UI, and not-found page
  backend/
    config/             Django settings, routes, WSGI
    api/                HTTP endpoints and backend contract tests
    requirements*.in    Direct Python dependency declarations
    requirements*.txt   Resolved, pinned Python dependencies
  docker-compose.yml    Development frontend + backend + PostgreSQL
  Dockerfile.dev        Vite development image
  Dockerfile            Built frontend served by Nginx, with /api proxy
  backend/Dockerfile    Django runtime and development image targets
mobile/
  CrisisTwin.xcodeproj/  Native iPhone/iPad project and shared scheme
  CrisisTwin/            SwiftUI app, features, API adapter, resources
  Config/                Debug/Release configuration and local override example
docs/adr/               Shared architecture decisions
```

See the [scaffold decision](docs/adr/0001-app-scaffold.md) and
[API contract](app/backend/README.md). There are no CI workflows for this
hackathon; checks run locally when needed.

### Run the iOS app

From the repository root, open the checked-in Xcode project:

```sh
open mobile/CrisisTwin.xcodeproj
```

Select the **CrisisTwin** scheme, an iOS 17+ simulator, then **Product > Run**.
No package installation or project generation is required. Debug uses
`http://localhost:8000/api/health`; start the Docker stack above to enable the
readiness card. Without the backend, the app displays a connection error with
manual retry. Release requires an explicitly configured HTTPS API origin.

See the [mobile setup and API boundary](mobile/README.md) for physical devices,
local configuration, directory details, and current limitations, and the
[mobile scaffold decision](docs/adr/0004-mobile-swift-scaffold.md) for tradeoffs.
The default check remains `pre-commit run --all-files` from the repository root.
Mobile builds, tests, and simulator verification have not been run and require
an explicit request under the repository policy.

### Workspace navigation

The web app shares a sidebar across all pages. On narrow screens, **Menu**
expands the navigation. The current page is marked with an arrow and
`aria-current`; a keyboard-accessible **Skip to content** link reaches the main
content. Each page has its own URL and document title:

- `/`: workflow shortcuts, recent-work empty state, and API/database readiness.
- `/maps`: working imagery map and illustrative fire simulation, a footprint
  visibility toggle, and a collapsible preview of future map layers and tools.
- `/scenarios`: editable name/weather/notes, sample templates, a local draft
  review, reproducibility fields, and the future scenario library.
- `/evacuation`: synthetic population/vehicle inputs, departure strategy and
  timings, shelter capacity, a sample road-closure toggle, and pending results.
- `/comparison`: baseline/candidate strategy controls, a metric comparison
  layout, compatibility requirements, and an explanation empty state.
- `/incidents`: disconnected source status, inbox search/type controls, and an
  optional clearly labeled synthetic evidence-review example.
- `/stress-tests`: selectable disruptions, a bounded candidate-run budget,
  investigation progress, and findings/unknowns empty states.

These are UI scaffolds based on [the project scope](docs/project-scope.md).
Editable inputs are temporary component state and reset on navigation/reload;
they do not transfer between pages or modify map inputs. No scenario saving,
traffic execution, comparison results, incident ingestion, or stress-test jobs
are connected. Unsupported execution buttons are disabled with explanations.
Sample inputs are synthetic user assumptions, and unavailable results use empty
states or dashes rather than fabricated metrics. Unknown paths show a not-found page. Trailing slashes are
accepted. Navigation uses normal links and the existing Vite/Nginx HTML fallback,
so direct links, refresh, and browser history use document navigation. Temporary
map state resets when leaving or reloading the page; no scenario is saved.

To integrate a feature, extend its component in `app/src/pages/`, retaining its
URL and shared `AppShell`. `WorkspaceUI.tsx` and `workspace.css` provide common
page headers, panels, fields, status tags, and empty states. `navigationItems`
holds route metadata only. Pages own their main landmark with `id="main-content"`
and `tabIndex={-1}`. No backend contract changed. See the
[navigation decision](docs/adr/0005-workspace-navigation.md) and
[UI scaffold boundaries](docs/adr/0006-planning-ui-scaffolds.md).

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
