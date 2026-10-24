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
The starter page checks the API and database connection. An interactive fire spread
simulator runs in the browser at `/fire`: Rothermel surface spread over the real
LANDFIRE fuel and terrain around the ignition point, so it needs internet access and
works only in the contiguous United States. Scenario persistence, evacuation demand,
road closures, strategy comparison, and data integrations are not implemented yet;
the items above describe the intended prototype.

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
- React **19**, TypeScript **5.8**, Vite **7**, Tailwind CSS **4**, MapLibre GL JS **6**.
- Fire landscape data fetched in the browser per scenario: LANDFIRE LF2025 FBFM40 fuel
  over WCS and AWS Open Data terrarium elevation tiles. No API key and no added
  dependency; the GeoTIFF reader lives in `app/src/fire/landscape.ts`.
- Django **5.2 LTS**, Django REST Framework **3**, PostgreSQL **17**.
- Vitest **3**, Testing Library, jsdom, ESLint, Prettier, and Ruff for local checks.

```text
app/
  src/                  React UI and API client (lib/), Vitest setup (test/)
    fire/               Rothermel spread model, fuel/terrain loader, map, simulator page
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

### Fire spread simulator

Open **http://localhost:5173/fire**. Click the map to place an ignition point, set the
20-foot wind speed and the direction it blows from, pick a fuel-moisture preset, then
play or step the perimeter forward in **15-minute** intervals over a 2, 3, or 6 hour
horizon. The presets are the standard dead and live moisture scenarios that go with the
Scott & Burgan fuel models; _Advanced: individual moisture classes_ opens the 1-hour,
10-hour, 100-hour, live herbaceous, and live woody values, plus the midflame wind factor
(the share of the open wind that reaches flame height, 0.5 by default). Switching the
click target to _Wind direction_ lets you click downwind of the ignition point to aim the
wind; the numeric field and the arrow at the ignition point stay in sync with it. _Show
the fuel layer the model is using_ draws the mapped fuel models under the perimeters, and
_Fit view to run_ frames the whole horizon. Each band is one 15-minute step, shaded by the
time the fire reached it, with the current perimeter outlined in bright amber.

Placing an ignition point fetches the real landscape around it: a LANDFIRE FBFM40 fuel
raster and terrain elevation tiles, over a radius scaled to the horizon — roughly 5 km at
two hours and 12 km at six.
The page therefore needs internet access and works only in the contiguous United States,
where LANDFIRE publishes this layer; elsewhere the run fails with an explicit error rather
than inventing fuel. Igniting on ground that carries no fire — water, pavement, bare rock,
developed land — is refused for the same reason. Wind and moisture edits re-solve without
refetching. Alongside the perimeters the panel reports the fuel model at the ignition
point, head rate of spread, flame length, slope, elevation, what share of the modelled
grid is burnable at all, and the grid and solve time; it warns when the effective wind is
past Rothermel's validated range, when the fire is boxed in by non-burnable ground before
the horizon, and when it has run off the edge of the modelled area.

Keyboard: focus the map, then use arrow keys to pan, `+`/`-` to zoom, and `Enter`
to act on the map centre. The map needs WebGL2. No API key, backend call, or
persistence is involved; the two data services are called directly from the browser.

| File                                 | Role                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `app/src/fire/fuelModels.ts`         | Scott & Burgan (2005) 40 fuel models, keyed by LANDFIRE FBFM40 code.       |
| `app/src/fire/rothermel.ts`          | Rothermel (1972) surface spread, wind/slope vectors, ellipse geometry.     |
| `app/src/fire/landscape.ts`          | LANDFIRE WCS fetch, GeoTIFF decode, terrain tiles, slope and aspect.       |
| `app/src/fire/spread.ts`             | Minimum-travel-time propagation, perimeter contouring, scenario types.     |
| `app/src/fire/FireMap.tsx`           | MapLibre GL JS map, USGS aerial imagery, fuel overlay, perimeter layers.   |
| `app/src/fire/FireSimulatorPage.tsx` | Scenario controls, landscape loading, 15-minute playback, metrics, legend. |

```ts
// Fuel and terrain around the ignition point. Network call; contiguous US only.
const landscape = await loadLandscape(-122.24, 37.88, 6000, signal); // ground metres

const run = simulateFireSpread(landscape, {
  origin: { latitude: 37.88, longitude: -122.24 }, // WGS84 decimal degrees
  windSpeedMph: 25, // open 20-foot wind
  windFromDegrees: 45, // bearing the wind blows FROM
  moisture: MOISTURE_PRESETS[0].moisture, // critical / Red Flag
  midflameAdjustment: DEFAULT_MIDFLAME_ADJUSTMENT, // 0.5 of the open wind
  stepMinutes: FIRE_STEP_MINUTES, // 15
  horizonMinutes: FIRE_HORIZON_MINUTES, // 180
});

run.ignition.fuelLabel; // "TU2 — Moderate load, humid climate timber-shrub"
run.ignition.spread.headRateFeetPerMinute; // Rothermel output stays Imperial
run.frames[12].perimeters; // GeoJSON Polygon features at T+3:00
run.frames[12].burnedAreaSquareMeters;
run.frames[12].maxReachMeters;
run.burnableFraction; // share of the modelled grid that carries fire at all
```

`simulateFireSpread` is deterministic: the same scenario over the same landscape gives the
same run, so nothing records a seed. It throws `NonBurnableIgnitionError` when the
ignition cell carries no fuel. Units are explicit at the boundaries. The Rothermel
equations keep the Imperial units they were published in and return feet per minute;
everything the solver does is in metres and metres per minute, and miles per hour,
kilometres, hectares, and acres are display conversions only. Wind direction is
meteorological, the bearing the wind blows **from**. Times are elapsed simulation-clock
minutes from ignition; playback advances the frame index on a timer and never reads
wall-clock time into the model.

One unit trap is worth stating outright: the grid is EPSG:3857, and **a Mercator metre is
not a ground metre**. One Mercator metre is cos(latitude) ground metres, about 0.79 at
Berkeley, so a 30 Mercator metre LANDFIRE cell is about 23.7 m across on the ground. Cell
addressing uses Mercator metres; slope, spread distance, burned area, and reach all use
ground metres, converted once where the landscape is built.

The model is **surface fire only**. There is no crown fire, no spotting or ember
transport, no suppression, and no structure-to-structure urban spread, so a fire that
reaches the edge of the vegetation simply stops — which understates real risk at the
wildland-urban interface. Wind is uniform over the grid and constant in time, fuel
moisture is uniform, and there is no diurnal weather change. LANDFIRE fuel is a 2025
mapped product, not an observation of today's vegetation. USGS imagery is historical
aerial coverage, not live fire observation, and its highest native zoom is 16. In the
Berkeley hills a wind-driven run often stalls within a few hundred metres because the
vegetated patch is small and bounded by streets; with the ellipse capped at 8:1 the
flanking rate is under 1 percent of the head rate, so a barrier directly downwind can halt
a run. That is the model reporting the landscape, not a defect. Outputs are planning
experiments, not operational evacuation instructions. See the
[fire model decision](docs/adr/0004-physics-fire-model.md), which supersedes the
[original ellipse](docs/adr/0003-fire-spread-model.md).

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
