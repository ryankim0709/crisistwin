# CrisisTwin

CrisisTwin is a Cal Hacks wildfire evacuation planning simulator: an interactive digital twin that
lets an emergency planner see how fire spread, road capacity, evacuation demand and resource
decisions interact. It combines a physics-based fire spread model on real LANDFIRE fuels and terrain, a
multi-fire Simulation Studio, a Claude-powered dispatch agent that issues evacuation and engine
orders during playback, and a replay of historical California fires with traffic and evacuation
overlays. The web workspace serves planners; an iOS app is the civilian companion.

> **Safety:** this is an experimental planning simulator. Its outputs are not operational
> evacuation instructions; any future resident guidance should require approval by the
> responsible authority. Wind, moisture, demand and many other inputs are assumptions the pages
> label as such.

## What is implemented

Routes of the web app (`app/src/main.tsx`, `app/src/navigation.ts`); `/` redirects to `/fire`.

| Route | Page | What it does |
| ----- | ---- | ------------ |
| `/fire` | Fire spread model | Rothermel surface spread with crown fire, ember spotting and structure-to-structure spread on LANDFIRE fuels, canopy and terrain; 3D diorama or USGS imagery view; 41 prebuilt California regions or a live custom area; optional NWS wind. [Reference](docs/fire-simulator.md). |
| `/simulation` | Simulation Studio | Up to five scheduled ignitions in one solver pass on a shared landscape, Web Worker solve, JSON export/import, plus a 3D diorama view of the last run. [ADR 0011](docs/adr/0011-simulation-studio.md), [ADR 0016](docs/adr/0016-studio-diorama-view.md). |
| `/dispatch` | Dispatch agent | Currently the Simulation Studio UI (scheduled fires, map and 3D diorama, playback) with its own saved draft; the Claude dispatcher (OSM roads, stations and synthetic homes, zone evacuations and fire engines, needs `ANTHROPIC_API_KEY`) is being reattached on top of it and is not wired into the page yet. [ADR 0014](docs/adr/0014-dispatch-agent.md), [ADR 0017](docs/adr/0017-dispatch-anywhere.md). |
| `/replay` | Historical replay | Replay of past fires (Camp 2018, plus Marshall and Kincade packages) with perimeters, evacuation traffic and responder/evacuee views, driven by generated replay bundles. [Bundle contract](docs/replay-bundle.md). |
| `/simulate` | Agent simulation | Replay-style view of simulated agent runs (same map tooling as `/replay`). |
| `/diorama` | Evacuation diorama | Fictional, scripted ~90 s three.js evacuation of the made-up town Larkspur Hollow; synthetic data. [ADR 0010](docs/adr/0010-evacuation-diorama.md). |
| `/scenarios`, `/evacuation`, `/comparison`, `/incidents`, `/stress-tests` | Planning pages | UI scaffolds with temporary local input; they do not save scenarios or run evacuation models. [Details](docs/workspace-pages.md), [ADR 0006](docs/adr/0006-planning-ui-scaffolds.md). |

The workspace overview (`/overview`) and `/maps` pages were removed
([ADR 0015](docs/adr/0015-remove-overview-and-maps.md)).

Also in the repository:

- **Backend** (`app/backend/`): Django REST API with `GET /api/health`, `/api/landscapes` (prebuilt landscapes from MongoDB), `/api/dispatch/area` (OpenStreetMap roads and stations for a box), `/api/dispatch/decide`, `/api/replay/explain`, `/api/live` (resident-app drill feed) and `/api/families`. See [API contract](app/backend/README.md).
- **Fire watch agent** (`agent/`): a standalone Python package that drafts evacuation advisories from satellite detections for a human to approve; never notifies residents. [README](agent/README.md), [ADR 0008](docs/adr/0008-fire-watch-agent.md).
- **Historical replay simulator** (`sim/`): stdlib Python fire hindcast and evacuation traffic model that produces replay bundles. [README](sim/README.md).
- **iOS app** (`mobile/`): SwiftUI resident app. Its **Live drill** tab shows, on a native map, the fire a planner is
  playing on `/fire` (the page posts it to `POST /api/live/broadcast` while **Share with resident app** is
  on) and, while the dispatch agent runs, what the simulation tells the household's zone (the agent is
  detached from `/dispatch` for now). **Family** lets a household
  create or join a family by code to share meeting points and status. Everything shown is a labelled simulation drill,
  not an alert. [README](mobile/README.md), [ADR 0010](docs/adr/0010-civilian-ios-app.md),
  [ADR 0016](docs/adr/0016-resident-live-and-family.md).

- **Incident intelligence** (`/api/intel/…`): an Apify Actor fetches public agency
  pages (live, or Wayback Machine captures for past fires), Claude extracts candidate road closures,
  evacuation orders and shelter updates with a verbatim quote, and a planner confirms and maps each one.
  Every extracted record is `reported` and `unconfirmed` until a planner confirms it; Claude never
  outputs coordinates. `APIFY_TOKEN`, `APIFY_ACTOR_ID` and `ANTHROPIC_API_KEY` are read by Django only
  (never `VITE_*`); without them runs and extraction answer 503 and uploading Actor output still works.
  [Contract](docs/incident-intel.md), [ADR 0018](docs/adr/0018-apify-incident-intelligence.md).

Not implemented: persistent scenarios, live incident integrations, a validated evacuation model.
The fire model has no suppression and is unvalidated at demo settings.

## Repository map

```text
app/                  Web app
  src/                React 19 + TypeScript frontend (see app/AGENTS.md)
    ui/               Design tokens and shared component kit: the UI standard, see app/src/ui/README.md
    fire/ studio/ dispatch/ replay/ diorama/ pages/ maps/ lib/
  backend/            Django 5.2 REST API + PyMongo (config/, api/)
  public/             Static assets (brand logo, map imagery; replay bundles are generated)
  data-manifest.json  Hashes of generated app data stored in MongoDB Atlas
  docker-compose.yml  Development stack (frontend + backend, external MongoDB)
agent/                Fire watch agent (Anthropic SDK, standalone)
sim/                  Historical replay simulator (stdlib Python)
tools/                Data acquisition and sync scripts (see tools/README.md)
tests/                Unit tests for the tools incident builders
data/incidents/       Incident packages; manifests in Git, bytes in MongoDB Atlas
mobile/               Native iOS app (Xcode project)
docs/                 Docs index: docs/README.md; decisions: docs/adr/README.md
AGENTS.md             Shared rules for coding agents (CLAUDE.md, Cursor and Copilot adapt it)
```

## Quick start

Requirements: Docker with Compose v2 and a MongoDB connection (Atlas or local). Keep the
connection string in `~/.mongodb_uri` (permissions `600`); your IP must be in the Atlas
network access list. Never commit or paste it.

```sh
git clone https://github.com/ryankim0709/crisistwin.git
cd crisistwin/app
export MONGODB_URI="$(cat ~/.mongodb_uri)"
docker compose up --build --wait
```

Open **http://localhost:5173** (redirects to `/fire`). The API health check is at
**http://localhost:8000/api/health**. Frontend and backend source changes reload automatically.
Compose runs only the app processes; it does not provision a database.

Alternatively copy [`app/.env.example`](app/.env.example) to ignored `app/.env`. `MONGODB_URI` is
required; `MONGODB_DATABASE` defaults to `crisistwin`. Do not share expanded `docker compose config`
output.

```sh
docker compose logs -f      # follow logs
docker compose down         # stop the stack
```

For the dispatch agent, set `ANTHROPIC_API_KEY` (optionally `DISPATCH_AGENT_MODEL`,
`DISPATCH_AGENT_EFFORT`) in the backend environment; without it the endpoint returns 503.
The dispatch area endpoint needs internet the first time a box is used (results are cached).
The `/fire` page needs internet access (LANDFIRE, terrain tiles, NWS) and works in the contiguous US only.

Stack: Node 22.12+ with npm, Python 3.12, React 19, TypeScript 5.8, Vite 7, Tailwind CSS 4, Django 5.2,
DRF 3, PyMongo 4, Vitest. Running on the host without Docker, checks, and runtime images:
[docs/development.md](docs/development.md).

### Data

Large incident-package files (`raw/`, `normalized/`) and generated replay bundles are not in Git; they
live in MongoDB Atlas. After cloning:

```sh
pip install -r tools/requirements.txt
export MONGODB_URI='mongodb+srv://...'   # ask a teammate; never commit it
python3 -m tools.mongo_data pull
python3 -m tools.mongo_data status       # drift vs the committed manifests
```

See [docs/historical-data.md](docs/historical-data.md) and [tools/README.md](tools/README.md).

### iOS app

```sh
open mobile/CrisisTwin.xcodeproj
```

Select the **CrisisTwin** scheme and an iOS 17+ simulator (Xcode 16.2+), then Product > Run. Debug uses
`http://localhost:8000/api/health`, so start the Docker stack for the readiness card. Details:
[mobile/README.md](mobile/README.md). Mobile builds and tests have not been run in this repository's
checks.

### Checks

The only default check is pre-commit (merge-conflict markers, trailing whitespace, final newlines):

```sh
python3 -m pip install pre-commit
pre-commit run --all-files
```

Tests, lint, type checks and builds are optional and listed in [docs/development.md](docs/development.md).
There are no CI workflows.

## Documentation

- [docs/README.md](docs/README.md): index of all docs. [Project scope](docs/project-scope.md) (proposals, not status).
- [docs/adr/README.md](docs/adr/README.md): architecture decisions, with duplicate numbers disambiguated.
- [app/src/ui/README.md](app/src/ui/README.md): the UI standard (tokens and shared components every page uses).
- [app/AGENTS.md](app/AGENTS.md) and [AGENTS.md](AGENTS.md): rules for coding agents. Change shared guidance in `AGENTS.md`;
  Claude's [subagent model rule](AGENTS.md#choosing-a-model-for-subagents) is there too.
- Component READMEs: [app/backend](app/backend/README.md), [agent](agent/README.md), [sim](sim/README.md),
  [tools](tools/README.md), [mobile](mobile/README.md).

The project grew out of [this planning conversation](https://chatgpt.com/share/6adc0b53-b864-83e8-84f7-8560e24d2a15).
