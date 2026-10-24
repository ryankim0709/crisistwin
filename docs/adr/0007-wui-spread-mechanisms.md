# 0007: Wildland-urban interface spread mechanisms

Date: 2026-10-23. Status: accepted.

Amends [0004](0004-physics-fire-model.md) rather than replacing it: the Rothermel surface
model, the fuel table, the landscape sources, and the minimum-travel-time propagation are
unchanged. This entry records what was added on top of them, and the one correction made
inside them. The number collides with `0005-workspace-navigation.md`, which another branch
already published; as with the duplicate 0003 and 0004, the fire sequence keeps its own
numbering rather than renumbering a decision that is already in the repository.

## Why

0004 recorded the Berkeley behaviour as a finding rather than a defect: a wind-driven run
in the hills stalled within a few hundred metres because the vegetated patch is small and
bounded by streets, and the solver gave every cell without a Scott & Burgan fuel model an
infinite cost. LANDFIRE maps roads, parking lots, and residential subdivisions all as
FBFM40 code 91, which is 59.5 percent of a 6.7 × 7.0 km box over that ignition area, so
the model was asserting that a two-lane road is a perfect firebreak and that a subdivision
is a wall. Tubbs (2017), Camp (2018), and Marshall (2021) are the fires this tool is aimed
at, and in all three the fire crossed roads on embers and then moved house to house. A
model that cannot represent either mechanism is not reporting the landscape; it is
reporting its own omission, and it understates risk exactly where a planner needs it.

## Decision

`rothermel-1972-mtt` v3.0.0 adds two optional mechanisms to the surface model and floors
the directional rate. Both mechanisms are deterministic, so a scenario plus a landscape
still reproduces a run exactly and no seed is recorded. Both default to on
(`DEFAULT_SPOTTING`, `DEFAULT_STRUCTURE_SPREAD`) and both can be switched off at the model
layer and from the page. Neither is physics: they are assumptions with sources, and the
run reports how much of the burn each one delivered so a reader can separate them from the
Rothermel part.

Attribution is per cell, credited once to the mechanism that set that cell's final
arrival time, and `FireRun.arrivalBreakdown` carries the cell counts and areas. The credit
follows the *source* cell, not the ground that burns: a vegetated cell spreading into a
house counts as surface spread, and a burning developed cell spreading into brush counts
as structure spread. Open water (98), snow or ice (92), agricultural land (93), and bare
ground (99) remain inert under both mechanisms and are never assigned an arrival time.

The `SPREAD_MODEL` descriptor returned with every run names both additions as assumptions
rather than as physics, alongside the Rothermel, fuel model, ellipse, and propagation
citations, so a run carries that distinction with it wherever it is read.

## Ember spotting

A burning cell launches firebrands only when the cell one step directly downwind holds no
vegetated fuel model. That single condition is what keeps the mechanism honest: it lets
embers turn a road, a parking lot, a subdivision, or a river into a delay instead of a
wall, and it makes it impossible for a spot to leapfrog continuous wildland fuel and
inflate the head rate beyond anything the surface model supports.

Five rays sample the downwind cone at `SPOTTING_BEARING_OFFSETS_DEGREES`, −30, −15, 0, 15,
and 30 degrees from the wind bearing. Each ray walks outward one cell at a time, skipping
unvegetated cells, and ignites the first vegetated cell it reaches after passing over at
least one of them. One ignition per ray, then the ray stops and the ordinary surface
solver takes over from the landing cell.

Reach scales as `SPOTTING_DISTANCE_COEFFICIENT` (0.25 m per mph per √(Btu/ft/s)) × wind
speed × √(fireline intensity), the form the Albini (1979, 1983) firebrand models and the
Alexander & Cruz (2006) fits take, because a more intense fire lofts larger brands higher
and a stronger wind carries them further. Below
`SPOTTING_MIN_FIRELINE_INTENSITY_BTU_PER_FOOT_PER_SECOND`, 100 Btu/ft/s — the four-foot
flame length at which direct attack by hand crews stops being possible (Andrews &
Rothermel, INT-131, 1982) — no brands are thrown at all. The coefficient is set so that a
45 mph wind over a 2000 Btu/ft/s shrubland fire reaches the ceiling, and it gives about
140 m at 25 mph over a 500 Btu/ft/s brush fire, which is across a four-lane road rather
than across a subdivision.

`DEFAULT_SPOTTING.maxDistanceMeters` is 500 m, and it is a ceiling rather than a typical
distance. Surface fires and intermittent torching produce maximum spot distances of a few
hundred metres (Albini, "Spot fire distance from burning trees", INT-56, 1979). The
kilometre-plus spots reported on Camp and Tubbs came from plume-dominated crown fire,
which this model does not represent, so claiming that reach here would not be supported by
anything in the model. `SPOTTING_MAX_PATH_CELLS` bounds a ray at 48 cells so that raising
the distance from the page cannot make the solver quadratic; at the 23.7 m Berkeley ground
cell that is about 1.1 km, so the 500 m ceiling binds first.

Arrival time at a landing cell is the launch cell's own arrival time, plus flight time at
`SPOTTING_EMBER_SPEED_FRACTION` (0.5) of the open wind, plus
`SPOTTING_IGNITION_DELAY_MINUTES`, a flat 10 minutes. Flight is the small term: at 40 mph
the whole 500 m ceiling is crossed in under a minute.

The delay carries the weight, and it is a simplification standing in for a probability.
The model is deterministic, so every receptive landing ignites, whereas the real
per-brand ignition probability is far below one. The delay is what stops that
simplification from turning a barrier into free spread, so it is set at the long end of
observed incubation rather than the middle: lofting and flight lag beyond plain
advection, smouldering-to-flaming incubation, and above all the wait for a brand that
actually establishes. The test it has to pass is that crossing a gap must not be cheaper
than burning through the same width of fuel. A shorter delay was tried and failed that
test: encountering a road came out *faster* than burning through the equivalent fuel,
which is plainly wrong, and it would have made spotting an accelerator rather than a way
past barriers.

Ten minutes passes that test in the fuels this demo runs in, not everywhere. The
shortest possible spot, over one gap cell into the next, covers about 47 m at the Berkeley
ground cell, which the grass and shrub models burn through in well under two minutes at
the default wind. In the slowest models — timber litter at a few metres a minute — 47 m of
fuel itself takes ten minutes or more, so there the delay stops being a guard and a spot
can still be the faster path. The constant is a single number standing in for an ignition
probability, and it is sized for the fuels at the wildland-urban edge.

## Structure-to-structure spread

Developed cells, FBFM40 code 91, get their own spread rate rather than a fuel bed.
`DEFAULT_STRUCTURE_SPREAD.rateMetersPerMinute` is 4 m/min downwind at
`STRUCTURE_SPREAD_REFERENCE_WIND_MPH`, 20 mph open wind. The anchor is Tubbs: the fire
crossed US-101 into Coffey Park around 01:30 on 9 October 2017 and had consumed most of a
tract roughly 1.2 km across by dawn, which is of order 5 m/min of front progression. Part
of that progression was ember transport, which this model counts separately through
spotting, so the structure-to-structure rate alone is set below the observed figure rather
than at it.

The rate scales linearly with the open wind, bounded by `STRUCTURE_WIND_FACTOR_MIN` 0.25
and `STRUCTURE_WIND_FACTOR_MAX` 3, so a calm night does not freeze the conflagration
outright and a 60 mph gust does not extrapolate one anchor point into nonsense. No
midflame reduction is applied, because a structure is exposed at roof height rather than
inside a fuel bed. There is no slope term at all: Rothermel's slope coefficient describes
flame contact with fuel up a hill and means nothing for a building, so inventing a value
would be worse than omitting one.

Directionality is Hamada (1951), still the basis of Japanese and post-earthquake
conflagration models, which gives downwind urban spread of order three times the upwind
rate. That ratio sets both `STRUCTURE_LENGTH_TO_BREADTH`, 3, and
`STRUCTURE_BACKING_RATE_FRACTION`, one third, the floor under every direction. A burning
neighbourhood is far less elongated than a wind-driven wildland fire because it moves
building to building by radiation and short-range firebrands, and the spacing between
structures rather than the wind sets much of the rate.

`STRUCTURE_FIRELINE_INTENSITY_BTU_PER_FOOT_PER_SECOND`, 1000, is an assumption and not a
computed quantity. Rothermel does not apply to structures, so nothing in the model
derives an intensity for one. The value exists only to size a burning structure's ember
reach and to report a flame length at a structure ignition, and it is deliberately kept in
the same order as a high-intensity brush fire instead of pretending to model a structure
plume. It is the most load-bearing number in the combination: it sets how far a burning
subdivision throws brands, and through the feedback described below it is what makes the
Berkeley result as large as it is.

## Backing rate

The rear-focus ellipse (Alexander 1985) drives the rate away from the head to almost
nothing once the fire is elongated. At the Anderson (1983) length-to-breadth cap of 8 the
flank rate is 0.78 percent of the head rate and the backing rate 0.39 percent, measured
independently in the in-progress calibration review of this branch, which also confirmed
that `directionalRate` implements the rear-focus polar form correctly: the near-zero
backing rate is the parameterisation behaving as specified, not a bug. It is still the
wrong number. Observed backing spread is not that slow, and Rothermel-based systems do not
compute it that way: BehavePlus takes the backing rate of spread to be the no-wind,
no-slope rate (Andrews, RMRS-GTR-371, 2018). Every directional rate is now floored at that
no-wind rate, which puts flanking and backing at roughly 2 to 5 percent of the head rate
in these fuels. Developed cells take the Hamada floor instead, one third of their own head
rate.

This was measured, not assumed, and at a three-hour horizon it is a small effect: it
widens the fire slightly and keeps a single barrier cell directly downwind from stalling a
run outright, but it does not drive the Berkeley result. The length-to-breadth cap of 8 is
deliberately left alone. FARSITE uses the same value, observed wind-driven ratios reach
it, and lowering it to widen the fire would be less well founded than fixing the floor.
What the calibration review does show is that the cap is load-bearing rather than a rail
that rarely binds: it binds at any effective midflame wind above 8.5 mph, and at the demo
default of 40 mph open wind the uncapped Anderson relation returns a length-to-breadth of
158, so at that setting the model is reporting the cap and not Anderson's curve.

## Ignition and reporting on developed ground

Igniting on developed ground is now accepted when structure spread is switched on and
refused when it is off, because refusing it while the rest of the run carries fire through
subdivisions would contradict the model. Snow or ice, agricultural land, open water, and
bare ground still refuse in every configuration, with `NonBurnableIgnitionError` naming the
ground.

For a structure ignition every Rothermel quantity is reported as zero — no-wind rate,
reaction intensity, wind coefficient, slope coefficient, effective wind. Those quantities
are undefined for a burning subdivision, and reporting zero is honest rather than a bug;
inventing them would put fabricated physics in the ignition card. Only the assumed head
rate, the heading, the Hamada ellipse, the assumed fireline intensity, and the flame
length that intensity implies are filled in.

## What it changes

Measured at one Berkeley Hills ignition under the demo defaults, before and after, over a
three-hour horizon. The run went from stalling at 3.1 ha and 0.37 km to 95.7 ha and
1.86 km, split 32 percent surface spread, 10 percent spotting, and 58 percent structure
spread. Spotting alone did not fix the stall: without structure spread the fire still had
nowhere to go once it crossed the first street, because what lies past the street in that
box is more street. A Los Padres control, which is almost entirely wildland, was
bit-identical through two hours and gained 28 percent area by three; with little developed
ground and few gaps to cross there, that difference is best read as the backing floor
widening the flanks rather than as either interface mechanism. Solve time went from about
62 ms to about 80 ms.

These are figures for particular ignition points, not a calibrated envelope. A different
point in the same hills ran 146 ha and 2.43 km over the same horizon. Where the point is
placed relative to the vegetated patch and the first street changes the answer by more
than any parameter in this entry.

Both mechanisms are exposed on the page as assumptions the user switches on, with the
maximum spotting distance and the structure rate in the advanced panel, bounded at 2000 m
and 20 m/min, and a label on any spotting distance past the supported 500 m. The burn
breakdown is shown as three lines, with only the surface line described as physics.

## Data plumbing

The fuel raster is fetched as a mosaic of bounded sub-requests, at most 320 cells a side,
four in parallel, stitched on the shared 30 m Mercator lattice. One large GetCoverage does
not work: the service snaps the request up to its own 1024-cell tile and truncates the
body at 2 MiB, the proxy sees the connection die, and the page gets a 500. Requests retry
up to three times with bounded, jittered backoff, treating a short 200 as a truncated
coverage, and one URL means one upstream request through an in-flight map, so React's
double-invoked development effects cannot issue the same large download twice. The jitter
on that backoff is the only `Math.random` in `app/src/fire`, and it schedules a request
rather than entering the model, so runs stay reproducible and no seed is recorded.

The browser could not reach the service at all before this. Docker forwards container
lookups to the host resolver, which drops queries intermittently and surfaced in the Vite
proxy as `getaddrinfo ENOTFOUND edcintl.cr.usgs.gov`. The frontend container now pins
public resolvers, the dev proxy uses a keep-alive agent with an IPv4-only lookup that
serves the last good address while resolution is failing — LANDFIRE publishes an AAAA
record that the Docker bridge network has no route to — and the Nginx upstream moved from
a literal host to a variable with its own resolver, so a DNS blip at boot no longer stops
the built image from starting. The hostname is unchanged in both proxies, so TLS
verification and SNI still apply and the proxy still only ever reaches LANDFIRE.

Missing terrain tiles are now reported through `LandscapeGrid.elevationComplete` instead of
reading as sea level, which had been silently flattening slope. The flag is carried on the
grid; no page surfaces it yet.

## Where this runs hot

The Berkeley combination is superlinear, and that is the honest reading of the 58 percent
structure share. Structure spread carries fire into a subdivision, the burning structures
throw embers into the next vegetated patch, that patch burns and throws again. The
feedback is real — it is what Tubbs and Camp did — but in this model it rests on an
assumed structure fireline intensity, and it is the most likely place the model runs hot.
There may also be double counting between the two mechanisms: a burning structure both
spreads to its neighbours and launches brands sized by the same assumed intensity, and
nothing checks that the combination is not counting one physical process twice.

Every receptive landing ignites. There is no ignition probability, no structure hardening,
no defensible space, and no suppression anywhere in the model, so each of those omissions
pushes the result in the same direction.

FBFM40 gives roads, parking lots, and houses the same code 91, which the model cannot
tell apart. A freeway therefore burns like a street of houses. In a wildland-urban
interface box developed ground is the overwhelming majority of the non-burnable area,
which is why it gets a mechanism while the other inert codes do not, but the lumping is
real and it overstates spread across wide paved ground.

Agricultural land, code 93, is kept inert and ember-transparent. Cured stubble does carry
fire, so treating a harvested field as a barrier understates risk in season, but a mapped
agricultural cell may equally be bare dirt or an irrigated row crop, and inventing a fuel
model for the code would be a worse error than leaving it out. Because it is transparent
to embers rather than a wall, a fire can still cross a field by spotting without burning
it, which bounds the error.

Spot-driven acceleration inside continuous fuel is deliberately not modelled: real
wind-driven fires run faster than their surface rate because short-range spotting
continually seeds the fuel just ahead of the head. The launch condition here forbids that
entirely. It understates rather than overstates, which is the direction to err in when the
alternative is an unbounded head rate.

The demo defaults — the critical moisture preset at 40 mph — remain unvalidated
presentation choices, and the calibration review of this branch is still in progress. What
it has measured so far is that at 40 mph open wind 54 of 84 fuel, moisture, and slope
combinations are already past Rothermel's validated effective wind. Outputs remain
planning experiments, not operational evacuation instructions.
