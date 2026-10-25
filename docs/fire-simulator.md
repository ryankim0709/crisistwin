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
Canyon by default; _Region_ lists the 13 station-scale boards (11 Bay Area, 2 Los Angeles) in `app/src/fire/regions.ts`, each
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
the evidence class (Observed, Derived, Forecast), the station and its distance in km. By default the
run follows the **whole hourly series** (_Wind over the run_: **Hour by hour**): speed and direction
change inside the one solve, a strip under the playback bar draws the wind over the run and the
current hour's wind, and the speed and direction controls show the series' peak hour. **Peak hour**
holds that one wind for the whole run instead (a worst-hour run, not a replay). See
[Time-varying weather](#time-varying-weather-inside-one-solve). Station winds are converted to the
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
[ADR 0048](adr/0048-suppression-engine.md)); the `/fire` page runs without it. Plume-dominated behaviour is represented only by the opt-in,
simplified [fire-induced wind](#fire-induced-wind-simplified-opt-in) (off by default) — including
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
the grid; unless the run follows a weather series it is also constant in time, and fuel moisture
is uniform over the grid (a series can vary it hour by hour, `/fire`'s scenario-weather series
does not: that API has no moisture). LANDFIRE fuel is a 2025 mapped product, not an observation of today's vegetation.
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

### In the UI

`/fire` and the Simulation Studio (`/simulation`, `/dispatch`) share one "Natural variation"
control (`app/src/fire/ui/NaturalVariationControl.tsx`): off by default; on adds a seed, a
"New seed" button and, under "What varies", the Uneven spread (`rosSigma` 0 when off), Wind
gusts and shifts (`windWander`) and Ember spot fires (`spotting`) switches. On `/fire` the
observed gust factor comes from `gustFactorOf` on the weather sample the run's wind was taken
from. The results card shows the seed and spot fires started, labelled simulated.

`/fire` also has "Run N times" (10 to 50 members): `burnProbabilityEnsemble` runs in a worker
(`burnProbability.worker.ts`, progress per member) and the per-cell fraction burned is drawn on
the satellite map as "Chance this spot burns", labelled simulated. The 3D diorama does not draw
it yet. The layer hides when the scenario changes after the run.

## Time-varying weather inside one solve

`FireScenario.weatherSeries` (so `FireSettings.weatherSeries` in Studio scenarios) gives the
solver hourly or sub-hourly weather instead of one wind and one moisture
(`app/src/fire/weatherSeries.ts`, pure):

```ts
interface FireWeatherSeries {
  enabled: boolean;
  samples: {
    minute: number;            // simulation minute from T+0 (may be negative)
    windSpeedMph: number;      // open 20 ft wind, mph
    windFromDegrees: number;   // bearing the wind blows FROM, degrees true
    moisture?: FuelMoisture;   // fractions of oven-dry weight; absent = scenario moisture
    airTemperatureF?: number;  // firebrand ignition and Byram's convective number
  }[];                         // strictly ascending minutes, at most 433 samples
  source?: string;             // e.g. "historical_replay BUR"
  evidence?: "observed" | "forecast" | "derived" | "assumed";
}
```

How the solver uses it. It extends the stochastic wind wander's machinery rather than adding a
second one: the run is read in the same 10-minute steps (`WIND_STEP_MINUTES`), and a cell spreads
out at the weather of the step it ignites in (rate, heading, ellipse, crown state and ember reach
recomputed), so fire that ignited before a wind shift keeps its old heading and fire that ignites
after it takes the new one. A step reads the series at its start minute: speed and each moisture
fraction linear in time, direction along the shorter arc of the compass (350 to 10 degrees passes
north; an exact reversal turns clockwise), the first sample held before it and the last after it.
With wind wander on, the wander's anomaly is applied around each step's series wind. With
`enabled` absent or false every output is bit-for-bit unchanged; a one-sample series equal to the
scenario's wind and moisture also reproduces the constant run exactly (both checked by
fingerprinting arrival fields, cell behaviour and resumed solves before and after).

Moisture of extinction. A fuel's rate is zero only while its dead fuel is above the moisture of
extinction, and with a series that changes hour to hour. A cell counts as able to carry fire
(steps may enter or cross it, embers may land in it) if its fuel can spread at the moisture of
any step of the horizon. When fire reaches a cell at a step where its fuel cannot spread, the
arrival is moved to the first later step where it can (ASSUMPTION: the fire holds at the edge,
smouldering in heavier fuel, no burnout modelled), or dropped if no step in the horizon allows it.
`run.weatherSeries.delayedArrivals` and `droppedArrivals` count these. Rothermel's damping reaches
zero only to round-off (about 1e-16 ft/min at 25% dead moisture), so "cannot spread" is a no-wind
rate at or below `EXTINCT_RATE_FEET_PER_MINUTE` = 1e-9 ft/min, a numerical threshold. Measured on
a flat GR2 grid: wet (25% dead) from T+1 h to T+3 h held the front still (7.7 ha at both T+2 h and
T+3 h) and it resumed at T+3 h 10 min; an all-dry run burned 51.9 ha by T+3 h.

Building a series:

- `weatherSeriesFromRecord(record)` (`fire/scenarioWeather.ts`): a `/api/weather/scenario` record
  (wind only). T+0 is the query start. Hours with no speed are skipped; a calm hour without a
  direction carries the previous one; speeds above 60 mph are capped like the applied peak.
- `weatherSeriesFromConditions(conditions, t0Utc, {maxWindMph})` (`world/conditions.ts`): a
  `/api/conditions` answer, with wind, all five moisture classes and air temperature per hour.
  Hours `applyConditionsHour` refuses are skipped, never filled.

Pages: `/fire` and Studio use the record's whole series whenever the wind source is Historical,
Worst or Forecast (Studio always; `/fire` unless _Peak hour_ is chosen). Assumed stays one
constant wind. The `/fire` playback dock shows the wind strip (`fire/ui/WindStrip.tsx`: speed
line, direction arrows, a marker and "Wind now ... mph from ..." at the playback time) and the
results details list the series used. The /live board still re-solves hourly with `ResumeFrom`
(`app/src/demo/fireField.ts`); it could pass a series instead but does not yet.

Cost: a series run recomputes every cell when it ignites (as wind wander does) and prepares one
set of fuel beds per distinct moisture. Synthetic 241 x 201 grid, 6 h: 23 ms constant, 30 ms
one-sample series. Eaton 807 x 807 (24.8 m cells), 24 h: 0.2 to 2.6 s per deterministic solve,
up to 4.1 s with natural variation, growing with burned area.

## Fire-induced wind (simplified, opt-in)

`FireScenario.fireInducedWind = {enabled, seed?}` (`app/src/fire/fireInducedWind.ts`). Off by
default; `/fire` has a "Fire-induced wind (simplified)" switch under spread mechanisms, Studio one
under advanced model settings. With it off nothing changes (fingerprinted). Every output with it
on is simulated.

Published and used as published:

- Byram's convective number, `N_c = 2 g I / (rho c_p T_0 (U - R)^3)`, Byram (1959, in Davis (ed.),
  *Forest Fire: Control and Use*, pp. 90-123), derivation in Nelson (1993, *Int. J. Wildland Fire*
  3(3):131-138, doi:10.1071/WF9930131), in the form of Hassan et al. (2026, *Fire Safety Journal*
  162:104753, Eq. 1), with U "at a reference height (typically 10 m at field scale)". Here U is the
  ambient 10 m open wind of the cell's step (20 ft wind x 1.15, Turner & Lawson 1978), R the cell's
  head rate in m/s, I its fireline intensity, T_0 the step's air temperature (else the stochastic
  default 86 F), rho from the ideal gas law at sea-level standard pressure (ASSUMPTION: at 1,000 m
  the real density is about 11% lower, so N_c about 11% higher), c_p 1004 J/(kg K). Nelson (1993)
  itself was not readable for this change; the form above is the 2026 paper's.
- Byram's buoyant velocity `U_B = (2 g I / (rho c_p T_0))^(1/3)` (same paper, Eq. 2), so
  `N_c = (U_B / (U - R))^3`; checked numerically to 3 decimals.
- Regimes: N_c <= 2 wind-driven, N_c >= 10 plume-dominated, mixed between (Nelson 2015,
  *Int. J. Wildland Fire* 24(7):1001-1007, after Pagni & Peterson 1973, as quoted by Hassan et al.
  2026; Nelson 2015 not read directly).
- Fireline intensity is Byram's I = H w R at the cell's final rate: the surface fire's heat per
  unit area (I / R from Rothermel) plus, where it crowns, crown fraction burned x canopy bulk
  density x crown depth x 18,608 kJ/kg (ASSUMPTIONS: canopy fuel spread evenly over the crown depth,
  and the SB40 low heat content 8,000 Btu/lb for canopy fuel).

Assumed (no source sets these; each is an exported constant with its reasoning):

| Effect | What it does | Constant |
| --- | --- | --- |
| Plume weight phi | 0 at N_c <= 2, 1 at N_c >= 10, linear in ln N_c between | (shape assumed) |
| Indraft | Adds a wind toward the fire's active centre (intensity-weighted centroid of the cells that ignited in the last 60 min, per fire) of phi x 0.2 x U_B, tapering linearly to 0 at 2 x the active area's equivalent radius (at least 3 cells). The cell then spreads with the summed wind through the ordinary Rothermel / crown / spotting code. | `INDRAFT_SPEED_FRACTION_OF_BUOYANT_VELOCITY` 0.2, `INDRAFT_RADIUS_FACTOR` 2, `INDRAFT_MIN_RADIUS_CELLS` 3, `PLUME_MEMORY_MINUTES` 60 |
| Direction variability | Seeded offset phi x 30 deg x z (z standard normal, clamped to +/- 2) on the summed wind; stream `STREAM_PLUME_DIRECTION`, keyed on the cell; seed = option seed, else the stochastic seed, else 0 | `PLUME_DIRECTION_SIGMA_DEGREES` 30 |
| Spotting | Stochastic firebrand launch probability x (1 + 2 phi); needs natural variation's spotting | `PLUME_SPOT_LAUNCH_MULTIPLIER` 3 |

Bounds: the indraft is at most 0.2 U_B (about 1.6 m/s for a 10,000 kW/m front, 3 to 5 m/s at the
most intense Eaton cells), zero beyond the reach and for wind-driven cells; the direction offset
is at most 60 degrees; the launch probability at most 3x. Run summary: `run.fireInducedWind`
(cells evaluated, mixed, plume-dominated, with indraft, largest finite N_c, largest indraft).
Under a strong wind it does nothing: at 25 mph on the synthetic grid the largest N_c was 0.13; at
3 mph it reached 6.2 and cut the 6 h area from 5.22 to 4.59 ha (the indraft opposes the head).

## Validation: Eaton Fire, 7-8 January 2025

Scratch run, not committed. Ignition 18:18 PST 7 Jan 2025 (02:18Z 8 Jan), CAL FIRE incident page
(`[34.203483, -118.069155]`, "Near Altadena Drive and Midwick Drive"); that point is at 1,210 m in
TL6 broadleaf litter under 65% canopy, which looks high for the street address, so the task's
approximate point (-118.084, 34.204; SH2, 882 m) was run as well. Landscape: `loadLandscape`
(upstream LANDFIRE LF2025, terrain tiles), centre (-118.10, 34.215), 10 km radius, 807 x 807 cells
of 24.8 m. Weather: `/api/conditions` `historical_replay` from 2025-01-08T02:00Z, 25 hours, through
`weatherSeriesFromConditions`; T+0 at ignition. Observed areas (Wikipedia, from incident updates):
>1,000 ac (405 ha) by 00:07 PST, 2,227 ac (901 ha) by 06:30, >10,600 ac (4,290 ha) by 10:36 on
8 January; final 14,021 ac (5,674 ha, CAL FIRE). Direction (LA County after-action review): spread
east first; around 03:00 on 8 January the wind strengthened and changed direction and the fire ran
west; the front crossed Lake Avenue (about -118.131) into west Altadena after 05:00.

Findings, honestly:

1. The API's automatic station is unusable for this fire. For the ignition point it picks Mount
   Wilson ASOS (MWS, 3.3 km away, on the summit): 1 to 8 mph all day, 0 to 7 C. Burbank (BUR,
   22 km west, valley floor) recorded 25 to 35 mph 20 ft winds from 10 to 30 degrees in the first
   hours, gusts to 71 mph, then lulls and north-westerly hours (330 to 350) around 01:00 to 03:00
   PST and north-easterly again from 05:00. Neither is Eaton Canyon; the runs below that use BUR
   are a station substitution.
2. The assumed live fuel moisture dominates. `/api/conditions` gives live herb 230% and live woody
   87% (its phenology calendar, an assumption). With those, every run burned 50 to 250 ha in 24 h
   against roughly 5,500 ha observed, with constant or time-varying wind, from either station.
   With live herb and woody set to 60% (a drought sensitivity value, not data) areas reach the
   observed order.
3. Constant peak hour vs hour by hour (BUR, live 60%, task point):

   | Run | 00:07 | 06:30 | 10:36 | +24 h | Growth bearing T+0-8.7 h / 8.7-16.3 h / 16.3-24 h | West edge at Lake Ave |
   | --- | --- | --- | --- | --- | --- | --- |
   | Observed | 405 | 901 | 4,290 | ~5,500 | east, then west after 03:00 | after 05:00 PST |
   | Constant peak (35 mph from 20) | 489 | 2,820 | 5,017 | 8,311 | 189 / 201 / 324 deg | 11:08 PST |
   | Hour by hour | 211 | 1,693 | 3,346 | 11,984 (edge) | 109 / 38 / 289 deg | 13:48 PST |
   | Hour by hour + fire-induced | 209 | 1,929 | 3,825 | 13,261 (edge) | 111 / 38 / 258 deg | 13:48 PST |
   | Hour by hour + variation, 3 seeds | 169 to 2,672 at 06:30; 321 to 4,827 at 10:36; 2,400 to 14,727 at +24 h | | | | | 13:48 PST for two seeds, never for one |

   Hour by hour does change the shape the way the wind does: the series run grows east-south-east
   first (the north-westerly hours push it there), then north-east upslope in the lulls, then west
   (289 degrees) once north-easterlies return, where the constant run heads south-south-west all
   day. But the westward run comes about 8 to 9 hours later than observed (Lake Avenue at 13:48
   against after 05:00), and its early direction comes from Burbank's north-westerly hours, which
   are not the Eaton Canyon winds; the after-action review gives no compass directions to check
   against. Area: the series run is within a factor of two of the observed area at 00:07, 06:30
   and 10:36 (0.52x, 1.88x, 0.78x), but overshoots by +24 h (the board edge at 10 km truncates it). At the CAL FIRE point (TL6 under
   canopy) the same settings give 9, 71, 214 and 1,092 ha (hour by hour) and 18, 1,209, 2,559 and
   5,249 ha (constant peak).
4. Fire-induced wind under these winds: under the constant 35 mph peak every cell was wind-driven
   (largest N_c 1.9); in the series' lulls N_c reached 160, about 54,000 of 215,000 evaluated cells
   were mixed or plume-dominated, and indrafts reached 3 to 5 m/s. Its area effect was -1% to +14%
   in deterministic runs, and it changes which embers launch in stochastic runs.

What we trust: the solver does what it is told with a time-varying wind (the fire turns with it),
and a single held peak hour cannot represent a shift at all. What we do not trust: any single run
as a reconstruction of Eaton. The local wind field (canyon and downslope winds, gusts of 60 to
100 mph reported in the area) is not in any station the API offers, and the live fuel moisture is
an assumption. No constant was changed to close the gap.
