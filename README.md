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
| `/simulation` | Simulation Studio | Up to five scheduled ignitions in one solver pass on a shared landscape, Web Worker solve, JSON export/import, plus a 3D diorama view of the last run. In 3D, **Evacuation & closures** evacuates the board's synthetic households against the run and lets you close roads or bridges, comparing results with and without them (closures change traffic, not the fire). An **optimizer** re-runs on every closure change, searching other exits and staged waves per zone, and shows its best plan against the fastest-exit policy; the 3D view can play either. **Firefighters** in the config panel send hand crews, engines, dozers and aircraft, driving in over the roads each vehicle class can use (rules in `docs/suppression-data.md`) or flying from the nearest CAL FIRE bases, to build control line; the run estimates whether they put each fire out by direct attack once on site, searches anchor points and line distances for the best control line, and compares both with no crews. Crews the fire overwhelms leave it after a size-up and help the evacuation in the most threatened zones. [ADR 0011](docs/adr/0011-simulation-studio.md), [ADR 0016](docs/adr/0016-studio-diorama-view.md), [ADR 0018](docs/adr/0018-road-closures.md), [ADR 0020](docs/adr/0020-studio-firefighting.md), [ADR 0023](docs/adr/0023-studio-crew-dispatch.md), [ADR 0048](docs/adr/0048-suppression-engine.md), [ADR 0024](docs/adr/0024-studio-crews-assist-evacuation.md), [ADR 0029](docs/adr/0027-evacuation-optimizer.md). |
| `/dispatch` | Dispatch agent | The Simulation Studio UI (scheduled fires, map and 3D diorama) with its own saved draft, plus a live Claude dispatcher beside it (needs `ANTHROPIC_API_KEY`). After a run it builds OSM roads, stations and synthetic homes. A monitor checks the simulation every few simulated minutes and calls Claude only when something changes. Claude orders zones out or stages them in waves, and sends engines either to fight a fire or to support an evacuation. For each fire Claude picks a tactic (direct attack, flanking from the heel, or indirect line ahead) from options the simulator has solved (homes reached, area burned, time to contain); the fire model decides where a line holds; the console shows each zone's simulated resident notice (nothing is sent). [ADR 0014](docs/adr/0014-dispatch-agent.md), [ADR 0017](docs/adr/0017-dispatch-anywhere.md), [ADR 0019](docs/adr/0019-live-dispatch-monitor.md), [ADR 0022](docs/adr/0022-dispatch-fire-attack.md), [ADR 0025](docs/adr/0025-dispatch-fire-tactics.md). **Road closures**: click roads closed or open on the 3D board before or during a run; traffic re-routes, roads the fire cuts are avoided, and the agent is woken to respond ([ADR 0030](docs/adr/0030-live-road-closures.md)). Each run's decisions and outcome are journalled in MongoDB Atlas, and the agent is shown earlier runs on the same roads as lessons ([ADR 0031](docs/adr/0031-dispatch-run-memory.md)). |
| `/live` | Live command | Controller workspace for the active live drill: field-report triage, per-zone guidance approval, the drill clock and the real-time twin, plus a simulated command board with an AI incident commander on the same drill zones (the former `/demo`, which now redirects here). The left column switches between **Reports** (the review queue) and **Fires & units** (the board); the centre switches between the map and a **3D diorama** of the board. The board runs a 24/7 simulation clock in the browser with its own speed, fire activity (Quiet, Active, Severe) and wind preset: fires come from seeded ignitions, spot fires, `fire_seen` field reports from the drill and fires you add on the map; engine strike teams race each fire and households leave on an order. The Claude commander (needs `ANTHROPIC_API_KEY`) is **off by default** and is only called while **AI monitoring** is on (or by **Ask Claude now**). Board content is labelled simulated and kept apart from live drill data; closing a board fire resolves its field reports. Not operational guidance. [Contract](docs/live-reports.md), [ADR 0012](docs/adr/0012-controller-guidance.md), [ADR 0047](docs/adr/0047-command-demo.md). |
| `/live/report` | After-action report | Drill score with its component breakdown, per-zone leave-now vs 2018, triage and help times, and the decision timeline; Export JSON. Opened from the `/live` header menu. [Contract](docs/live-reports.md#after-action-report). |
| `/replay` | Historical replay | Replay of past fires (Camp 2018, plus Marshall and Kincade packages) with perimeters, evacuation traffic and responder/evacuee views, driven by generated replay bundles. [Bundle contract](docs/replay-bundle.md). |
| `/simulate` | Agent simulation | Replay-style view of simulated agent runs (same map tooling as `/replay`). |
| `/diorama` | Evacuation diorama | Fictional, scripted ~90 s three.js evacuation of the made-up town Larkspur Hollow; synthetic data. [ADR 0010](docs/adr/0010-evacuation-diorama.md). |
| `/comparison`, `/stress-tests` | Planning pages | UI scaffolds with temporary local input; they do not save scenarios or run evacuation models. `/evacuation` was removed and redirects to `/simulation`. [Details](docs/workspace-pages.md), [ADR 0006](docs/adr/0006-planning-ui-scaffolds.md). |

The workspace overview (`/overview`) and `/maps` pages were removed
([ADR 0015](docs/adr/0015-remove-overview-and-maps.md)).

Also in the repository:

- **Backend** (`app/backend/`): Django REST API with `GET /api/health`, `/api/landscapes` (prebuilt landscapes from MongoDB), `/api/dispatch/area` (OpenStreetMap roads and stations for a box), `/api/dispatch/decide`, `/api/dispatch/runs` (run journal in Atlas), `/api/demo/…` (command demo: fire-aware routes and the Claude commander, [ADR 0047](docs/adr/0047-command-demo.md)), `/api/replay/explain`, `/api/live` (resident-app simulation feed), `/api/sim-state/…` (Studio evacuation state per synthetic home; [contract](docs/sim-state-api.md)), `/api/live/…` (live drill: field reports, controller guidance, twin; [contract](docs/live-reports.md)) `/api/families` and `/api/mobile/…` (schema-free iOS app data in Atlas, [ADR 0029](docs/adr/0029-mobile-data-store.md)). See [API contract](app/backend/README.md).
- **Fire watch agent** (`agent/`): a standalone Python package that drafts evacuation advisories from satellite detections for a human to approve; never notifies residents. [README](agent/README.md), [ADR 0008](docs/adr/0008-fire-watch-agent.md).
- **Live scenario runner** (`python manage.py live_run_scenario --spec api/live/specs/camp-2018-live-typical.json --base http://127.0.0.1:8000 --speed 10 --start`): fills the active live drill with simulated residents, generated 911/radio/rescue calls, simulated responders and injects on the drill clock, all labelled simulated. [Doc](docs/live-scenario-runner.md).
- **Controller MCP server** (`orchestrator_mcp/`): a stdio MCP server that lets an external orchestrator agent act as the controller of the live drill through the controller API, with every write attributed to the agent. [README](orchestrator_mcp/README.md), [ADR 0033](docs/adr/0033-controller-mcp-server.md).
- **Historical replay simulator** (`sim/`): stdlib Python fire hindcast and evacuation traffic model that produces replay bundles. [README](sim/README.md).
- **iOS app** (`mobile/`): SwiftUI resident app for the **live drill** on the 2018 Camp road network: a map
  with the fire estimate and the zone guidance a controller approves on `/live`, field reports and **I'm out** /
  **Need help** check-ins ([contract](docs/live-reports.md), [ADR 0011](docs/adr/0011-live-field-reports.md),
  [ADR 0012](docs/adr/0012-controller-guidance.md)). Its menu also holds **My Plan**, **Family** (create or join a
  family by code to share meeting points and status) and **Web simulation**, the fire a planner plays on `/fire` or
  `/dispatch` with **Share with resident app** on, including what the dispatch
  simulation tells the household's zone ("stay home, your zone leaves in a later wave" for staged zones).
  From `/simulation`, **Share with resident app (homes)** publishes Studio's evacuation and every playback tick
  to Atlas, so the app can show the household's saved home as leave now, leave at T+h:mm, already left, or no order
  ([contract](docs/sim-state-api.md), [ADR 0029](docs/adr/0029-simulation-state-for-mobile.md)).
  Everything shown is a labelled drill or simulation, not an
  alert. [README](mobile/README.md), [ADR 0010](docs/adr/0010-civilian-ios-app.md),
  [ADR 0016](docs/adr/0016-resident-live-and-family.md).
- **Live twin** (`app/backend/livecore/`, `sim/`): the planner and a steppable traffic engine behind `/live`'s what-if
  ([ADR 0013](docs/adr/0013-realtime-twin.md), [twin API](docs/twin-api.md)).

- **Incident intelligence** (`/intel`, API `/api/intel/…`): the page lists the historical incidents from the
  replay index (pick one to scope the review; `/incidents` redirects here). An Apify Actor fetches public agency
  pages (live, or Wayback Machine captures for past fires), Claude extracts candidate road closures,
  evacuation orders and shelter updates with a verbatim quote, and a planner confirms and maps each one.
  Every extracted record is `reported` and `unconfirmed` until a planner confirms it; Claude never
  outputs coordinates. `APIFY_TOKEN`, `APIFY_ACTOR_ID` and `ANTHROPIC_API_KEY` are read by Django only
  (never `VITE_*`); without them runs and extraction answer 503 and uploading Actor output still works.
  [Contract](docs/incident-intel.md), [ADR 0018](docs/adr/0018-apify-incident-intelligence.md).

Not implemented: persistent scenarios, live incident integrations, a validated evacuation model.
Suppression is limited to control lines built by Simulation Studio ground crews and aircraft ([ADR 0020](docs/adr/0020-studio-firefighting.md), [ADR 0048](docs/adr/0048-suppression-engine.md)); the fire model is unvalidated at demo settings.

## Repository map

```text
app/                  Web app
  src/                React 19 + TypeScript frontend (see app/AGENTS.md)
    ui/               Design tokens and shared component kit: the UI standard, see app/src/ui/README.md
    fire/ studio/ dispatch/ demo/ replay/ diorama/ live/ pages/ maps/ lib/
  backend/            Django 5.2 REST API + PyMongo (config/, api/, livecore/ live-drill rules and planner)
  public/             Static assets (brand logo, map imagery; replay bundles are generated)
  data-manifest.json  Hashes of generated app data stored in MongoDB Atlas
  docker-compose.yml  Development stack (frontend + backend, external MongoDB)
agent/                Fire watch agent (Anthropic SDK, standalone)
orchestrator_mcp/     Controller MCP server for an external orchestrator agent (standalone)
sim/                  Historical replay simulator (stdlib Python)
tools/                Data acquisition and sync scripts (see tools/README.md)
tests/                Unit tests for the tools incident builders
data/incidents/       Incident packages; manifests in Git, bytes in MongoDB Atlas
mobile/               Native iOS app (Xcode project)
docs/                 Docs index: docs/README.md; decisions: docs/adr/
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

Scenario resource snapshots (households, fire stations and engines at T+0 of each live drill,
[docs/scenario-snapshots.md](docs/scenario-snapshots.md)), once per database and again after
changing `tools/snapshot_assumptions.json` (a few minutes on a rate-limited Atlas tier):

```sh
docker exec crisistwin-backend-1 python manage.py live_init_db          # collections + validators
docker exec crisistwin-backend-1 python manage.py live_seed_snapshots   # Camp, Berkeley Hills, Palisades
```

For the phone's voice mode (`POST /api/live/incidents/{id}/voice`), Cartesia is the speech
provider (speech-to-text and text-to-speech; paid, server-side only). Set `CARTESIA_API_KEY`
alongside `ANTHROPIC_API_KEY` (optionally `CARTESIA_VOICE_ID`, `CARTESIA_TTS_MODEL`,
`VOICE_MODEL`) in the backend environment, for example
`export CARTESIA_API_KEY=... ANTHROPIC_API_KEY=...` before `docker compose up`. Without
`CARTESIA_API_KEY` recorded audio answers 503 and typed `text` turns work without speech. Contract:
[docs/live-reports.md](docs/live-reports.md#voice-mode); a curl example is in
[`app/backend/README.md`](app/backend/README.md#voice-mode-post-apiliveincidentsidvoice).
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

If `status` reports drift after you pull, the author has not yet run `record`, `push` and
committed the manifest.

See [docs/historical-data.md](docs/historical-data.md) and [tools/README.md](tools/README.md).

### iOS app

```sh
open mobile/CrisisTwin.xcodeproj
```

Select the **CrisisTwin** scheme and an iOS 26 simulator (Xcode 26), then Product > Run. Debug uses
`http://localhost:8000/api/health`, so start the Docker stack for the readiness card. Details:
[mobile/README.md](mobile/README.md). Mobile builds and tests have not been run in this repository's
checks.

### Multi-phone drill

One backend and console, several real phones, one iOS build. Phones get the server from a join
link `crisistwin://join?server=<origin>&code=<invite>` (open it, or scan its QR code in Plan >
About > Server). The console's /live "..." menu > **Invite phones** shows the link and QR code
([ADR 0034](docs/adr/0034-multi-phone-hosting.md)). Always set `LIVE_CONTROLLER_TOKEN` (without
it every client is the controller) and `LIVE_INVITE_CODE`, in your shell or `app/.env`.

**(a) Same Wi-Fi, the Mac serves.** Find the name with `scutil --get LocalHostName` (`<mac>.local`).
```sh
cd app
export LIVE_CONTROLLER_TOKEN=<token> LIVE_INVITE_CODE=<code>
CT_BIND_ADDR=0.0.0.0 DJANGO_ALLOWED_HOSTS=localhost,127.0.0.1,backend,<mac>.local docker compose up --build
```
Open `http://localhost:5173/live` on the Mac (no token form), Invite phones, server
`http://<mac>.local:5173`. Phones use the Vite proxy on 5173 (plain HTTP works only for `.local`;
allow local network access when iOS asks). macOS may ask to allow incoming connections.

**(b) HTTPS tunnel you start yourself.** Start the stack as above (it can stay on `127.0.0.1`),
then in another terminal `cloudflared tunnel --url http://localhost:5173`. With the printed
`https://<name>.trycloudflare.com`, restart Compose with
`DJANGO_ALLOWED_HOSTS=localhost,127.0.0.1,backend,<name>.trycloudflare.com VITE_ALLOWED_HOSTS=<name>.trycloudflare.com`
(add `DJANGO_CSRF_TRUSTED_ORIGINS=https://<name>.trycloudflare.com` only if a browser POST is
refused). Invite phones with that origin. Visitors on the tunnel, including a console opened
there, see the token form. The hostname changes every run; regenerate the QR code.

**(c) Cloud host later.** Run the backend (`app/backend/Dockerfile`, `runtime` stage) behind HTTPS with
`DJANGO_DEBUG=false`, `DJANGO_SECRET_KEY`, `DJANGO_ALLOWED_HOSTS=<host>`, `MONGODB_URI`,
`LIVE_CONTROLLER_TOKEN`, `LIVE_INVITE_CODE`, and serve the built web app and `/api` from one
origin. Invite phones with that origin. Nothing in the app changes.

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
- [docs/adr/](docs/adr/): architecture decisions. Some numbers repeat, so cite them by full file name.
- [app/src/ui/README.md](app/src/ui/README.md): the UI standard (tokens and shared components every page uses).
- [app/AGENTS.md](app/AGENTS.md) and [AGENTS.md](AGENTS.md): rules for coding agents. Change shared guidance in `AGENTS.md`;
  Claude's [subagent model rule](AGENTS.md#choosing-a-model-for-subagents) is there too.
- Component READMEs: [app/backend](app/backend/README.md), [agent](agent/README.md),
  [orchestrator_mcp](orchestrator_mcp/README.md), [sim](sim/README.md),
  [tools](tools/README.md), [mobile](mobile/README.md).

The project grew out of [this planning conversation](https://chatgpt.com/share/6adc0b53-b864-83e8-84f7-8560e24d2a15).
