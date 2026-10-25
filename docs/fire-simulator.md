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

## Stochastic spread (opt-in, seeded)

The solver (`app/src/fire/spread.ts`) can run as one realisation of a seeded random fire
instead of the single deterministic answer. The random parts live in
`app/src/fire/stochastic.ts` (pure); an ensemble helper is in `app/src/fire/ensemble.ts`.
It is off unless a caller sets it, and with it off (absent, or `enabled: false`) every output
is bit-for-bit the deterministic run (checked by fingerprinting the arrival fields, cell
behaviour and resumed solves of /fire, Studio-style scheduled and /live board solves before
and after the change).

### Options

`FireScenario.stochastic` (so `FireSettings.stochastic` in Studio scenarios and
`FireSolveRequest.stochastic` on the /live board):

```ts
interface StochasticSpreadOptions {
  enabled: boolean;
  seed: number;                  // any finite number, reduced to uint32
  rosSigma?: number;             // sd of ln(ROS multiplier); default ln(1.35) = 0.300
  rosCorrelationMeters?: number; // default 90 m
  spotting?: boolean;            // default true; also needs scenario spotting.enabled
  windWander?: boolean;          // default true
  gustFactor?: number | null;    // peak gust / mean wind; default Durst 3-s gust 1.52
  airTemperatureF?: number;      // for ignition probability; default 86 F
}
```

The shared world's `fire.stochastic: {enabled, seed}` maps straight onto this. A run that
used it carries `run.stochastic`: `evidence: "simulated"`, the resolved options (seed
included), spot launches and ignitions, and the range of wind factors drawn. Studio's
firefighting and initial-attack re-solves inherit the same settings, so every tactic is
compared on the same realisation. `gustFactorOf(sample)` turns a weather sample's
`gustMs / speedMs` into the gust factor.

Every draw is a pure function of (seed, stream, cell or wind step), a counter-based hash,
not a sequential generator. So the same seed reproduces the same field whatever order
cells settle in, and a resumed /live solve (`ResumeFrom`) makes the same draws for the
same cells; measured: an unchanged-settings resume at minute 120 matched the uninterrupted
stochastic run cell for cell (no membership differences, largest arrival difference 0.006
min, from float32 storage of the earlier behaviour). Keep a board's seed fixed and include
the options in its solve key.

### Model, sources and evidence

| Mechanism | What it does | Source | Evidence |
| --- | --- | --- | --- |
| ROS field | Per-cell multiplier exp(sigma z), z a unit-variance Gaussian field (white noise blurred by a separable Gaussian, rescaled to unit variance at every cell, edges included). Scales head, flank/backing floor and sustained-crown rates of vegetated cells; intensity scales with it and flame length with its 0.46 power (Byram 1959). Crown classification stays on the unperturbed fire. | sigma = ln(1.35): Cruz & Alexander (2013) propose a 35% error interval as about one standard deviation of heading-ROS prediction error with accurate inputs (49 datasets, 1278 fires; most datasets had 51-75% mean absolute error, so this is the narrow end). | Sigma sourced; applying a whole-fire error as cell-scale variability, the 90 m correlation length and median 1 (their under-prediction bias not applied) are assumptions. |
| Wind wander | Each 10-minute step draws a speed factor exp(s z - s^2/2) capped at the gust factor, and a direction offset 0.8 s z' radians, independent per step. A cell spreads out at the wind of the step it ignites in (rate, heading, ellipse, crown state recomputed). | s = (G - 1) x 0.117 / 1.267: 0.117 is Durst's (1960) ratio of 10-minute to 3-second gust excess over the hourly mean (ASCE 7-05 form), 1.267 the expected maximum of six independent normals; 0.8 = sigma_v / sigma_u (Kaimal & Finnigan 1994). Default G = Durst's 3-second gust, 1.52; an observed gust replaces it. At the default s = 0.048 (speed) and 2.2 degrees (direction). | Formulas sourced; independent steps, reading the sample's speed as the hourly mean, and the 10-minute step are assumptions. |
| Stochastic spotting | A cell above 100 Btu/ft/s launches one firebrand with probability 1 - exp(-0.001 per m x cell width) (2.9% at 30 m), at most 5000 per solve. Distance is lognormal with median a quarter of the maximum and the maximum at the 99th percentile; draws past it or past the scenario's spotting ceiling start nothing. Direction is downwind plus the direction sigma. Only vegetated, unburned fuel outside built line can ignite. Arrival = flight at half the wind + the existing 10-minute delay. | Maximum distance: Albini (1979, 1983) surface-fire spotting as implemented in BehavePlus (`firelab/behave` `spot.cpp`), flat terrain. Ignition: Schroeder (1969) probability of ignition as in BehavePlus `ignite.cpp`, fuel temperature = air + 25 F - 20 F x shade, shade = landing cell's canopy cover. Lognormal shape: Sardoy et al. (2008), Himoto & Tanaka (2005). | Albini and Schroeder sourced (ignition reproduces BehavePlus's worked examples to 8 decimals); launch rate, median fraction, air temperature, closed-canopy cut-off (cover >= 0.5) are assumptions. |

The deterministic gap-crossing spotting (above) still runs alongside; stochastic spots are
the only mechanism that lands embers in continuous fuel ahead of the front.

What was measured (synthetic 300 x 300 grid of GR2 / SH5 / TU5 with a road and a pond,
20 mph, 6-hour /fire run, 229.8 ha deterministic; 20 seeds each):

| Configuration | Burned area, ha: min / median / max |
| --- | --- |
| ROS field only | 190 / 233 / 282 |
| Wind wander only | 247 / 261 / 269 |
| Stochastic spotting only | 230 / 230 / 231 (about 70 launches, 8 spot ignitions per run) |
| All on | 214 / 260 / 310 |

Wind wander biases area upward (+13% at default): each 10-minute cohort of cells spreads on
its own heading and the minimum-travel-time front is their envelope, which is Huygens'
principle doing what it does under a varying wind. An earlier variant drew independent
1-minute winds with the instantaneous turbulence intensity; it burned 79% more than
deterministic because a step's rate is fixed when its source cell ignites and a step lasts
up to about 12 minutes, so a one-minute gust direction persisted for the whole step. That
was rejected as a lattice artifact, and the 10-minute step matches how long a solver step
lasts.

Not verified: BehavePlus's spotting worked example (GS4, 5 mph, 30 ft closed cover, 0.22005
mi) needs a 15.8 ft flame; this solver's own GS4 surface run at those inputs gives 5.5 to 6.2
ft, the live-fuel discrepancy of [integration-todo](integration-todo.md) section 4, so the
example could not be reproduced end to end. The spotting formulas were checked term by term
against `spot.cpp` instead. That discrepancy is unchanged here.

Cost (507 x 507 grid, two fires, 6 hours, about 24,000 burned cells): 201 ms deterministic,
243 ms all on with a cached field, 262 ms with a new seed (the rate field takes 30 ms and is
cached for the last seed and grid). `burnProbabilityEnsemble(landscape, input, {members,
baseSeed})` runs `members` seeds (`memberSeed(baseSeed, k)`, at most 200) and returns the
per-cell fraction burned by the horizon, `evidence: "simulated"`: 20 members of the
300 x 300 test took 1.5 s. Run it in a worker.

Every output of a stochastic run is simulated. A burn-probability raster is a fraction of
model runs, not a calibrated probability, and must be labelled that way in any UI.
