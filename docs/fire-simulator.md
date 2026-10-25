# Fire spread simulator (`/fire`) reference

Moved from the root README. See also the [Simulation Studio and dispatch notes](workspace-pages.md).

## Map imagery

`app/src/maps/basemap.ts` holds the shared **MapLibre GL JS** USGS historical
imagery style used by the fire and replay maps. Cached-image sources, retrieval
times, and bounds are in `app/public/map-preview/provenance.json`. USGS imagery
is historical, not live fire data. See the
[map decision](adr/0002-geographic-map.md).

After pulling changed dependencies into an existing Docker setup, refresh its
separate npm volume:

```sh
cd app
docker compose exec -T frontend npm ci
docker compose restart frontend
```

## Fire spread simulator

Open **http://localhost:5173/fire**. The page opens on a three.js miniature of the loaded
landscape (see [ADR 0011](adr/0011-fire-diorama-view.md)), built from LANDFIRE fuels,
terrain elevation, and canopy. It opens on a prebuilt California region (Altadena & Eaton
Canyon by default; _Region_ lists the 41 station-scale boards in `app/src/fire/regions.ts`, each
framed around one fire station at 30 m, grouped by area and marked _not built_ when missing
from `GET /api/landscapes`), pulled from MongoDB through the backend
([ADR 0013](adr/0013-prebuilt-socal-landscapes.md)). The area readout says whether the
board is a _Stored landscape_ (build date, LANDFIRE 2025, cell size) or _Live from LANDFIRE_.
If a stored region is missing or the API is down, the page says so and loads that region live,
which takes longer. _Custom area…_ opens a locator map and SoCal presets and loads live;
there, _Area size_ sets how much ground the board covers (Local fits the horizon, up to 12 km
radius, or 10 km, 25 km, 50 km). A stored region's board is fixed, so the horizon does not
resize it and a long run may reach its edge. Cells coarsen from LANDFIRE's native 30 m on
large boards to keep the grid at most 900 cells a side; the page states radius and cell size
(fuels resampled by majority; Details has a resolution card) because coarser cells smooth narrow fuel breaks and small neighbourhoods. Click the landscape to place an ignition (in the 3D view, drag to pan, right-drag or Ctrl-drag to rotate, scroll to zoom; arrow keys pan)
point, set the 20-foot wind speed and the direction it blows from, pick a fuel-moisture
preset, then play the fire forward over a fixed 24 hour horizon. Playback is
continuous (1× is 10 model minutes per second, rising to horizon ÷ 18 for horizons past
3 h, so 80 model minutes per second at 24 h; 0.5×, 2×, and 4× are available) while the results use
the model's **15-minute** frames. The presets are the standard dead and live moisture
scenarios that go with the Scott & Burgan fuel models. The midflame wind factor, maximum
spotting distance, and structure-to-structure spread rate stay at their defaults (midflame
0.5, the share of the open wind that reaches flame height). When canopy data loaded for
the area, each cell instead gets its own factor from canopy cover, canopy height, and fuel
bed depth, lower under a closed stand than in the open.
_Wind source_ chooses where the wind comes from: **Assumed** (the slider and field below, the
default), **Historical** (a UTC date and time), **Worst** (a month and P90, P95 or P99 offshore peak,
a real observed episode picked statistically), or **Forecast** (NWS, from now). The last three call
`GET /api/weather/scenario` ([scenario weather](scenario-weather.md)) for the ignition point and show
the evidence class (Observed, Derived, Forecast), the station and its distance in km. The solver
takes a single wind per run, so the series is reduced to its **peak hour in the 24 hour window** and
that speed and direction drive the whole run; the panel says so. Station winds are converted to the
open 20 foot wind first (10 m stations x 0.87, RAWS unchanged, citation and limits in the scenario
weather doc), and the midflame factor below is then applied to that 20 foot wind. Changing the speed
or direction by hand goes back to Assumed. Simulation Studio has the same selector and records the
series and its provenance in drill packages.
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
See [the crown fire decision](adr/0008-crown-fire.md) for the sources, the
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
elevation tiles, over a radius scaled to the 24 hour horizon. Clicking the landscape places
the ignition point without refetching. **Change area** picks a new centre from the presets (Berkeley Hills, Paradise,
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
  horizonMinutes: FIRE_HORIZON_MINUTES, // 1440
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

`simulateScheduledFireSpread(landscape, input, controlLines?, outFromMinuteBySource?, extensions?)`
has two opt-in extensions used by the `/demo` command board (`app/src/demo/fireField.ts`); with
`extensions` omitted the solver is unchanged. `reportCellBehaviour` adds `run.cellBehaviour`, the
per-cell head rate, heading, ellipse eccentricity, backing floor, flame length and crown class the
solver propagated. `resume` (`ResumeFrom`) continues from an earlier run's arrival field at
`fromMinute`: cells burned by then keep their arrival and source, spread on at this run's rates
with the share of each in-progress step already covered at the earlier rates credited, and no
cell newly burns before `fromMinute`; cells of a put-out fire (or source -1) are burned but inert.
With unchanged settings a resumed run reproduces the uninterrupted one; this is how the board
follows an hourly wind series with a one-wind-per-run solver.

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

The surface physics models crown fire as well as surface spread. The only suppression is
control line built by Simulation Studio ground crews and aircraft ([ADR 0020](adr/0020-studio-firefighting.md),
[ADR 0048](adr/0048-suppression-engine.md)); the `/fire` page runs without it. Nothing in the model represents plume-dominated behaviour — including
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
[fire model decision](adr/0004-physics-fire-model.md), which supersedes the
[original ellipse](adr/0003-fire-spread-model.md), the
[interface mechanisms](adr/0007-wui-spread-mechanisms.md), the
[crown fire decision](adr/0008-crown-fire.md), and the
[solver direction set decision](adr/0009-solver-direction-set.md) for the constants,
their sources, and where they are least trustworthy.
