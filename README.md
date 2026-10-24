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
Vite and Tailwind CSS, a Django REST Framework API, MongoDB via PyMongo, Vitest,
and Docker.
The workspace has shared sidebar navigation, page-specific UI scaffolds, and an
overview that checks the API and database connection. Planning pages support
temporary local input editing; they do not save scenarios or execute evacuation
models. The imagery map at `/maps` starts over San Francisco and supports an
illustrative fire-spread experiment:
choose an origin, set wind, and inspect the simulated footprint in 15-minute
steps. A historical replay simulator for the 2018 Camp Fire is in progress in [`sim/`](sim/README.md);
persistent scenarios and live incident integrations are not implemented yet.
The `/diorama` page is a fictional, ~90-second looping wildfire evacuation of the
made-up town Larkspur Hollow, rendered in 3D with three.js. Its data are synthetic and
its fire, traffic and crew behaviour are scripted for visual demonstration, not a
validated model or operational guidance (see
[ADR 0010](docs/adr/0010-evacuation-diorama.md)).

The native iOS scaffold is in [`mobile/`](mobile/README.md): a SwiftUI workspace,
API/database readiness card, and a scenario empty state. Native maps, simulation,
and scenario synchronization are not implemented in the mobile app yet.

This is an experimental planning simulator. Its outputs are not operational evacuation instructions; any future resident guidance should require approval by the responsible authority.

## Historical data research

### Incident data in MongoDB Atlas

Large incident-package files (`raw/` and `normalized/`) are not stored in Git.
Each package's `manifest.json` stays in Git and lists every artifact with its SHA-256;
the bytes live in MongoDB Atlas (GridFS, deduplicated by hash). After cloning:

```sh
pip install -r tools/requirements.txt
export MONGODB_URI='mongodb+srv://...'   # ask a teammate; never commit it
python3 -m tools.mongo_data pull         # restores data/incidents/*/*/{raw,normalized}
```

After building a new package locally, run `python3 -m tools.mongo_data push` and commit its manifest.
`python3 -m tools.mongo_data status` reports local app data (replay bundles, variants, simulations)
that differs from the committed `app/data-manifest.json`, and with `MONGODB_URI` set, any listed
artifact missing from Atlas. If it reports drift after you pulled, the author has not yet run `record`, `push` and committed the manifest.

Prebuilt California fire landscapes from the San Francisco Bay Area to San Diego (ADR 0013) are built and uploaded with
[`tools/build_landscape_regions`](tools/build_landscape_regions/README.md):
`node tools/build_landscape_regions/run.mjs` then
`python3 -m tools.build_landscape_regions upload`.

[Historical incident packages](docs/historical-replay.md) proposes source acquisition,
data formats, provenance, timing, and offline replay semantics for historical wildfire
scenarios. [The historical package decision](docs/adr/0005-historical-incident-packages.md)
records the proposed tradeoffs. The first [Camp Fire incident package](data/incidents/camp-2018-paradise-slice/a6d2cc03f525ed65/manifest.json)
contains 290 public structure assessments in a bounded Paradise area from
[CAL FIRE DINS](https://publish.data.ca.gov/dataset/cal-fire-damage-inspection-dins-data)
and 45 historical satellite-derived fire perimeters from
[NASA VEDA FEDS](https://docs.openveda.cloud/user-guide/notebooks/tutorials/mapping-fires.html).
It includes original API responses, normalized GeoJSON, attribution, and checksums.
The damage data describe post-fire outcomes, not building ignition times. The
perimeters are half-day estimates, not exact fire arrival times. A small offline
replay tool selects the latest observed perimeter and reports its age. Road
closures, traffic, and population movement have not been added to this package.

The collector uses the Python standard library and curl; it adds no dependency to
the app's Python lockfile. From the repository root, with Python 3.12 and curl:

```sh
python3.12 -m tools.build_camp_history --verify-package data/incidents/camp-2018-paradise-slice/a6d2cc03f525ed65
python3.12 -m tools.replay_camp_history --package data/incidents/camp-2018-paradise-slice/a6d2cc03f525ed65 --at 2018-11-09T15:00:00Z --output /tmp/camp-frame.geojson
```

To reacquire these sources, run `python3.12 -m tools.build_camp_history --output-root data/incidents`
with internet access. The queries fix the incident, date window, box, and selected
fields and do not collect addresses or parcel numbers. Six DINS records lie
slightly outside the requested box; the manifest records the actual extent. The
replay command writes a GeoJSON frame for viewing or testing and makes no claim
about information availability to responders at that historical time.

## Development

Clone the repository:

```sh
git clone https://github.com/ryankim0709/crisistwin.git
cd crisistwin
```

### Start with Docker

Install Docker with Compose v2 or newer and configure your MongoDB connection.
For the existing Atlas setup, keep your personal connection string in
`~/.mongodb_uri` with permissions `600`. Your Atlas database user needs access to
`crisistwin`, and your current IP must be allowed in the project network access
list. From the repository root:

```sh
cd app
export MONGODB_URI="$(cat ~/.mongodb_uri)"
docker compose up --build --wait
```

Open **http://localhost:5173**. The API is at **http://localhost:8000/api/health**;
the backend connects directly to MongoDB Atlas. Frontend and backend source
changes reload automatically. Compose runs only the app processes; it does not
provision a database or run SQL migrations.

Alternatively copy [`app/.env.example`](app/.env.example) to ignored `app/.env`
and replace the URI placeholder there. `MONGODB_URI` is required;
`MONGODB_DATABASE` defaults to `crisistwin` and overrides any database in the URI
path. Keep real credentials out of Git, logs, and browser environment variables.
Do not paste connection strings or share expanded `docker compose config` output.
A local MongoDB server is also supported: use `mongodb://127.0.0.1:27017` for a
host backend, or `mongodb://host.docker.internal:27017` for Docker Desktop if the
server is reachable from containers. There is no automatic local fallback.

When replacing an existing PostgreSQL stack, stop it with `docker compose down`
from its original checkout before starting this worktree (both use the same
Compose project name and app ports). Keep its volumes; this change does not
transfer PostgreSQL data. No application persistence models exist on `main` yet.

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
- Django **5.2 LTS**, Django REST Framework **3**, PyMongo **4** with MongoDB Atlas
  or an existing compatible MongoDB server.
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
    config/             Django settings, routes, WSGI, credential redaction
    api/                HTTP endpoints and backend contract tests
      mongodb.py        Shared MongoDB client and explicit database selection
    requirements*.in    Direct Python dependency declarations
    requirements*.txt   Resolved, pinned Python dependencies
  docker-compose.yml    Development frontend + backend (external MongoDB)
  Dockerfile.dev        Vite development image
  Dockerfile            Built frontend served by Nginx, with /api proxy
  backend/Dockerfile    Django runtime and development image targets
mobile/
  CrisisTwin.xcodeproj/  Native iPhone/iPad project and shared scheme
  CrisisTwin/            SwiftUI app, features, API adapter, resources
  Config/                Debug/Release configuration and local override example
docs/adr/               Shared architecture decisions
```

See the [scaffold decision](docs/adr/0001-app-scaffold.md),
[MongoDB decision](docs/adr/0008-mongodb-backend.md), and
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

The sidebar home link uses the transparent logo at
`app/public/brand/crisistwin-logo.png`, served at `/brand/crisistwin-logo.png`.
Asset usage and the generation prompt are in `app/public/brand/logo-notes.txt`.

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

### Fire spread simulator

Open **http://localhost:5173/fire**. The page opens on a three.js miniature of the loaded
landscape (see [ADR 0011](docs/adr/0011-fire-diorama-view.md)), built from LANDFIRE fuels,
terrain elevation, and canopy. It opens on a prebuilt California region (Altadena & Eaton
Canyon by default; _Region_ lists the 41 station-scale boards in `app/src/fire/regions.ts`, each
framed around one fire station at 30 m, grouped by area and marked _not built_ when missing
from `GET /api/landscapes`), pulled from MongoDB through the backend
([ADR 0013](docs/adr/0013-prebuilt-socal-landscapes.md)). The area readout says whether the
board is a _Stored landscape_ (build date, LANDFIRE 2025, cell size) or _Live from LANDFIRE_.
If a stored region is missing or the API is down, the page says so and loads that region live,
which takes longer. _Custom area…_ opens a locator map and SoCal presets and loads live;
there, _Area size_ sets how much ground the board covers (Local fits the horizon, up to 12 km
radius, or 10 km, 25 km, 50 km). A stored region's board is fixed, so the horizon does not
resize it and a long run may reach its edge. Cells coarsen from LANDFIRE's native 30 m on
large boards to keep the grid at most 900 cells a side; the page states radius and cell size
(fuels resampled by majority; Details has a resolution card) because coarser cells smooth narrow fuel breaks and small neighbourhoods. Click the landscape to place an ignition (in the 3D view, drag to pan, right-drag or Ctrl-drag to rotate, scroll to zoom; arrow keys pan)
point, set the 20-foot wind speed and the direction it blows from, pick a fuel-moisture
preset, then play the fire forward over a 2, 3, 6, 12, or 24 hour horizon. Playback is
continuous (1× is 10 model minutes per second, rising to horizon ÷ 18 for horizons past
3 h, so 80 model minutes per second at 24 h; 0.5×, 2×, and 4× are available) while the results use
the model's **15-minute** frames. The presets are the standard dead and live moisture
scenarios that go with the Scott & Burgan fuel models; _Advanced: moisture classes and
spread parameters_ opens the 1-hour, 10-hour, 100-hour, live herbaceous, and live woody
values, the midflame wind factor (the share of the open wind that reaches flame height, 0.5
by default), the maximum spotting distance, and the structure-to-structure spread rate. The
midflame factor is a user override, not the model's preferred input: while it is left at its
default and canopy data loaded for the area, each cell instead gets its own factor from
canopy cover, canopy height, and fuel bed depth, lower under a closed stand than in the
open; moving the control off its default applies that one flat value everywhere instead.
Switching the click target to _Wind direction_ lets you click downwind of the ignition point
to aim the wind; the numeric field and the arrow at the ignition point stay in sync with it.
The _View_ switch flips between the diorama and the original USGS aerial-imagery map (needs a network connection) with the same run, time, and clicks; the choice is remembered in the browser. _Show the fuel layer the model is using_ tints the ground by fuel family, _Focus fire_
frames the burn, and _Reset view_ frames the whole board. Controls and results float over
the stage; the scenario panel collapses (a bottom sheet on phones) and the results strip
expands to the full breakdowns. Trees and houses are symbols for fuel classes, not observed
detail.

Two wildland-urban interface mechanisms sit on top of the Rothermel surface model, under
_Extra spread mechanisms (your assumptions)_, both on by default and both switchable off.
**Ember spotting** carries firebrands downwind across ground that holds no fuel model and
lands them in the first vegetation past it, so a road, a parking lot, or a subdivision is
a delay rather than a wall; it never jumps continuous wildland fuel.
**Structure-to-structure spread** gives developed ground (FBFM40 code 91) its own
wind-driven rate, so a neighbourhood burns instead of acting as a firebreak, and placing
the ignition point on developed ground is accepted while that toggle is on, refused while
it is off. Neither is physics: both are coarse
assumptions with sources, the page warns as much while structure spread is on, and the
panel attributes every burned cell to the mechanism that reached it first — surface
spread, spotting, or structure-to-structure — so you can see how much of a run is the
Rothermel model and how much is an assumption you switched on.

Above the surface model, **crown fire** decides per cell whether a forest fire stays on
the ground, torches individual trees, or runs through the crowns, where forest fires get
most of their speed. The panel reports whether crown fire was modelled for the run (it
needs canopy data; a run without it says so rather than reading as treeless ground), the
burned area split by surface, passive (torching), and active crown fire, and the
length-to-breadth applied to actively crowning cells at the run's wind. Crown fire can
also carry from an already-crowning cell into a neighbour whose own canopy can sustain it,
not only where a cell's own surface fire is intense enough to start crowning on its own.
See [the crown fire decision](docs/adr/0008-crown-fire.md) for the sources, the
constants, and where it is least trustworthy.

**Use current NWS wind** replaces the wind speed and direction with the US National
Weather Service hourly forecast for the ignition point, labelled as **observed** data with
the location, forecast hour, and the source's own wording, including when the reported
speed was a range and the upper bound was taken. Until then — and the moment you edit
either wind control by hand — the page says the wind is an assumption you set. The default
moisture preset (critical / Red Flag) and the default 40 mph wind are demo settings chosen
to show peak fire weather; they are **explicitly unvalidated**, and the page says so.

The page loads the real landscape around an area centre when it opens (default Berkeley
Hills, 37.88, -122.24): a LANDFIRE FBFM40 fuel raster, four more LANDFIRE layers for canopy
base height, bulk density, cover, and height that the crown fire model needs, and terrain
elevation tiles, over a radius scaled to the horizon — roughly 5 km at two hours and 12 km
at six. Clicking the landscape places the ignition point without refetching. Changing the
horizon refetches around the same centre and drops the ignition point if it falls outside
the new box. **Change area** picks a new centre from the presets (Berkeley Hills, Paradise,
Malibu / Woolsey) or a small locator map, and clears the ignition point and run. The canopy
layers cost a real extra download — five coverages' worth of sub-requests instead of one —
and a run still proceeds as surface fire only, clearly labelled as such, if any of them fails
to load or fails a plausibility check.
The page therefore needs internet access and works only in the contiguous United States,
where LANDFIRE publishes this layer; elsewhere the run fails with an explicit error rather
than inventing fuel. The fuel and canopy rasters are each fetched as a mosaic of bounded
sub-requests through a same-origin proxy, with bounded retry; the browser never calls
LANDFIRE directly. Igniting on water, snow, agricultural land, or bare ground is refused, and so is
developed land while structure-to-structure spread is switched off. Wind and moisture
edits re-solve without refetching. Alongside the perimeters the panel reports the fuel
model at the ignition point, head rate of spread, flame length, slope, elevation, what
share of the modelled grid is burnable at all and what share is developed, the burned area
split across the three mechanisms, and the grid and solve time; it warns when the
effective wind is past Rothermel's validated range, when the fire is boxed in by
non-burnable ground before the horizon, and when it has run off the edge of the modelled
area. A fire started on developed ground reports its Rothermel quantities as zero, because
they are undefined for a burning subdivision rather than measured to be nothing.

Keyboard: `Space` plays or pauses the run once one exists, unless a focused control owns the
key. On the timeline slider, arrow keys step one 15-minute frame, Shift+arrow, `PageUp` and
`PageDown` step an hour, and `Home` and `End` jump to ignition and the horizon. The fire
stage and the locator map need WebGL; without it the page shows a notice instead of the
diorama. No API key, backend call, or persistence is involved; terrain tiles and the
National Weather Service forecast are called straight from the browser, and LANDFIRE through
the same-origin proxy.

| File                                 | Role                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `app/src/fire/fuelModels.ts`         | Scott & Burgan (2005) 40 fuel models, keyed by LANDFIRE FBFM40 code.       |
| `app/src/fire/rothermel.ts`          | Rothermel (1972) surface spread, wind/slope vectors, ellipse geometry.     |
| `app/src/fire/landscape.ts`          | LANDFIRE WCS mosaic fetch, GeoTIFF decode, canopy rasters, terrain.       |
| `app/src/fire/crownFire.ts`          | Van Wagner initiation, Cruz active rate, Scott & Reinhardt blending.      |
| `app/src/fire/spread.ts`             | Propagation, crown fire, spotting, structure spread, contouring.          |
| `app/src/fire/weather.ts`            | National Weather Service wind lookup with provenance; no UI state.         |
| `app/src/fire/diorama/`              | three.js fire diorama renderer and its contract (`types.ts`).              |
| `app/src/fire/fuelPalette.ts`        | Fuel-family and arrival colours shared by the legend and the renderer.     |
| `app/src/fire/FireSimulatorPage.tsx` | Scenario panel, area picker, playback dock, results, attribution.          |
| `app/src/fire/useFirePlayback.ts`    | Playback clock for the run: play, pause, seek and speed in model minutes.  |
| `app/src/fire/ui/AreaPicker.tsx`     | Change-area dialog: place presets and a locator map (contiguous US only).  |
| `app/src/fire/ui/FireDock.tsx`       | Playback dock: play/pause, timeline slider and speed control.              |
| `app/src/fire/ui/FireLegend.tsx`     | Fuel-family and arrival legend; each colour is paired with a glyph.        |

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
  spotting: DEFAULT_SPOTTING, // { enabled: true, maxDistanceMeters: 500 }
  structureSpread: DEFAULT_STRUCTURE_SPREAD, // { enabled: true, rateMetersPerMinute: 4 }
});

run.ignition.fuelLabel; // "TU2 — Moderate load, humid climate timber-shrub"
run.ignition.spread.headRateFeetPerMinute; // Rothermel output stays Imperial
run.frames[12].perimeters; // GeoJSON Polygon features at T+3:00
run.frames[12].burnedAreaSquareMeters;
run.frames[12].maxReachMeters;
run.burnableFraction; // share of the modelled grid holding a vegetated fuel model
run.developedFraction; // share mapped as urban or developed, FBFM40 91
run.arrivalBreakdown; // burned area by surface, spotting, and structure spread
run.appliedOptions; // the two mechanisms as actually applied, for reproducibility
```

Both mechanism options are optional in `FireScenario`; omitting one applies its default,
and the defaults have both mechanisms on. Switch them off by passing `enabled: false`.

`simulateFireSpread` is deterministic, spotting and structure spread included: the same
scenario over the same landscape gives the same run, so nothing records a seed. It throws
`NonBurnableIgnitionError` when the ignition cell can carry no fire under the options
given. Units are explicit at the boundaries. The Rothermel equations keep the Imperial
units they were published in and return feet per minute;
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

The surface physics models crown fire as well as surface spread, but there is still **no
suppression**, and nothing in the model represents plume-dominated behaviour — including
in cells that are now predicted to crown, which is why ember spotting stays on the surface
fireline intensity with its 500 m ceiling even there, well short of the Camp Fire's
measured 6.3 km maximum spot. The two interface mechanisms
are assumptions layered on that surface model, not validated models: spotting is
deterministic, so every ember landing in receptive fuel ignites with no ignition
probability, and structure spread ignores building materials, spacing, defensible space,
and suppression, resting on an assumed fireline intensity for a burning structure. Their
combination can compound — structures carry fire into a subdivision, burning structures
throw embers into the next patch of brush — which is what the 2017 and 2018 California
fires did, and is also the most likely place this model runs hot. LANDFIRE gives roads and
houses the same code 91, so a freeway burns like a street of houses. Wind is uniform over
the grid and constant in time, fuel moisture is uniform, and there is no diurnal weather
change. LANDFIRE fuel is a 2025 mapped product, not an observation of today's vegetation.
The locator map uses historical USGS aerial imagery, not live fire observation. A run that still stalls is fuel-limited: with both mechanisms off, or
where the vegetated patch is bounded by water or bare rock, the fire stops where its fuel
does, and the page says so rather than hiding it. Outputs are planning experiments, not
operational evacuation instructions. See the
[fire model decision](docs/adr/0004-physics-fire-model.md), which supersedes the
[original ellipse](docs/adr/0003-fire-spread-model.md), the
[interface mechanisms](docs/adr/0007-wui-spread-mechanisms.md), the
[crown fire decision](docs/adr/0008-crown-fire.md), and the
[solver direction set decision](docs/adr/0009-solver-direction-set.md) for the constants,
their sources, and where they are least trustworthy.

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
docker compose exec backend python manage.py test --noinput
```

`npm run check` runs Prettier, ESLint, TypeScript, Vitest, and the frontend build.
Individual commands are `npm run format:check`, `npm run lint`,
`npm run typecheck`, `npm test`, and `npm run build`. Use `npm run test:watch`
while developing. Tests use mocked network/database boundaries; Docker startup
and the health endpoint check the real database connection.

### Run app processes on your host

Use the versions above and the existing Atlas connection (or a running local
MongoDB server), then create a local Python environment. From `app/`:

```sh
export MONGODB_URI="$(cat ~/.mongodb_uri)"
python3.12 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements-dev.txt
backend/.venv/bin/python backend/manage.py runserver 127.0.0.1:8000
```

In a second terminal, from `app/`:

```sh
nvm use
npm ci
npm run dev
```

Django reads environment variables from the shell; it does not load `.env`
automatically. Export `MONGODB_URI` and, if needed, `MONGODB_DATABASE` in the backend
shell. The default database is `crisistwin` for both host and Compose.
Vite proxies `/api` to `http://127.0.0.1:8000` on the host and `http://backend:8000`
in Docker. To change the host target, use
`VITE_API_PROXY_TARGET=http://127.0.0.1:8000 npm run dev`.

Optional host backend checks run from `app/backend/` using `.venv/bin/ruff check .`,
`.venv/bin/ruff format --check .`, `.venv/bin/python manage.py check`, and
`.venv/bin/python manage.py test --noinput`.

### Simulation Studio (`/simulation`)

Place up to five fires on the map, give each a start time in elapsed simulation minutes,
set constant wind and fuel moisture, press **Run simulation**, and play the combined spread
on one timeline. All fires run through one solver pass on one shared landscape, so overlap
and "fire F1 reached F3 before its scheduled start" are modelled, not overlaid. The solve runs
in a Web Worker; the draft is kept in `localStorage` ("Saved on this device") and can be
exported or imported as JSON. Model and contracts: `docs/adr/0011-simulation-studio.md`.

Limits: wind and moisture are constant for the whole run; horizons are 1, 2, 3 or 6 hours;
fires must be close enough to share one landscape (at most about 24 km across, including
spread room); edits mark the result stale and nothing re-runs automatically; a run that
reaches the grid edge is incomplete from that minute. It is a planning experiment, not an
operational forecast.

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

Claude's [subagent model-selection rule](AGENTS.md#claude-subagent-model-selection)
routes easy, low-impact tasks to Haiku, medium tasks to Sonnet, and hard or
important tasks to Opus. It requires assessment before each launch and explicit
model selection using the available [Claude Code subagent controls](https://code.claude.com/docs/en/sub-agents#choose-a-model).
This is agent guidance, not an enforced runtime router or a change to the parent
session's model; model availability and host settings still apply.

For concurrent work, use separate branches and checkouts/worktrees and agree on shared interfaces before editing overlapping files. Use the pull request template to hand off changes and verification results.

## Concept background

The project grew out of [this planning conversation](https://chatgpt.com/share/6adc0b53-b864-83e8-84f7-8560e24d2a15).
