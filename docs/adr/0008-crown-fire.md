# 0008: Crown fire

Date: 2026-10-23. Status: accepted.

Amends [0004](0004-physics-fire-model.md) and [0007](0007-wui-spread-mechanisms.md) rather
than replacing either: the Rothermel surface model, the fuel table, the landscape sources,
the two interface mechanisms, and the minimum-travel-time propagation are all unchanged.
This entry records a mechanism added above them, and the one input it replaces. The solver
change that landed in the same commit is a separate decision and is recorded in
[0009](0009-solver-direction-set.md); the two interact only in that both move the numbers
0007 reports.

## Why

The surface model is right and still too slow. A calibration study of this branch ran the
Rothermel implementation against Andrews, "The Rothermel surface fire spread model and
associated developments" (USDA Forest Service RMRS-GTR-371, 2018), Table 17, and
reproduced it to three or four significant figures, so the surface equations, the fuel
table, and the unit handling are not where the error is. Over live LANDFIRE fuels the same
implementation gave timber head rates of 4.5 m/min in TL3, 11.1 m/min in TU5, and
28.9 m/min in TU2. Published rates for wind-driven forest fires are ten to twenty times
that. A gap that large, in a model that matches its own reference table, is a missing
mechanism rather than a miscalibrated coefficient: real forest fires move through the
canopy, and nothing in the surface model knows the canopy is there.

## Decision

`rothermel-1972-mtt` is v4.0.0. `crownFire.ts` sits above the surface model and decides,
per cell, whether the surface fire stays on the ground, torches individual trees, or runs
through the crowns, and returns the rate that results. `spread.ts` propagates that rate.
The module imports nothing from the surface equations and modifies none of them; the
surface result is still computed, still reported, and is what the crown decision is made
against.

Both crown fire questions — whether this cell's own surface fire initiates crowning, and
whether this cell's canopy could sustain an active crown fire arriving from outside — are
evaluated once per cell in the precompute, never inside the relaxation loop. What the loop
does, once per cell at the moment that cell settles, is choose which of the two already-
computed answers to spread with: the self-initiated one, unless the fire arrived from a
neighbour that was itself actively crowning and this cell's own canopy can sustain it, in
which case the cell continues as active regardless of whether its own surface fire alone
would have reached Van Wagner's threshold. `spread.ts`'s `settled` guard and the property
that a Dijkstra relaxation over nonnegative edge weights settles each cell for good the
first time it is popped are what make a single, irrevocable choice at settle time correct
rather than a race. Crown fire of either kind is evaluated at all only when
`LandscapeGrid.canopyComplete` is true. The module is metric
throughout; `rothermel.ts` reports Btu/ft/s and `spread.ts` multiplies by the named
`KW_PER_METER_PER_BTU_PER_FOOT_PER_SECOND`, 3.4613, exactly once, at the call. Nothing
here uses randomness, so a scenario plus a landscape still reproduces a run exactly.

## Initiation

Whether the canopy ignites at all is Van Wagner (1977), Can. J. For. Res. 7:23-34, eq. 4:
the critical surface fireline intensity `I_0 = (0.01 × CBH × (460 + 25.9 × M))^1.5`, with
canopy base height in metres, foliar moisture content in percent, and `I_0` in kW/m. The
460 kJ/kg is the heat needed to bring foliage to ignition and the 25.9 kJ/kg the extra
heat per percent of moisture. Van Wagner's own worked example, a 6 m base height at
100 percent foliar moisture, gives 2476 kW/m, which the implementation reproduces. Below
`I_0` the canopy does not ignite however dense it is.

Foliar moisture is not read from a raster. It is a constant 100 percent of dry weight, the
standard western-conifer value in Van Wagner (1977) and in Scott & Reinhardt (2001) and
the FARSITE and FlamMap default; seasonal values run roughly 85 to 130 percent. The run
reports the value it assumed on `FireRun.crownFire.foliarMoistureFraction` rather than
leaving it implicit.

## The active threshold

Once the canopy has ignited, whether the fire can carry through it is Van Wagner's
critical mass flow rate, 0.05 kg per square metre per second. A crown fire must move fast
enough to draw that mass flow of canopy fuel through the flame front, so the critical
crown rate is `0.05 × 60 / CBD` metres per minute: 20 m/min at a bulk density of
0.15 kg/m3 and 60 m/min at 0.05. Scott & Reinhardt's active ratio is the rate the canopy
can actually achieve divided by that critical rate, and the fire is active at 1.

The two tests are independent and both must pass. The active ratio is a property of the
canopy and the weather alone and says nothing about whether the canopy has ignited, so
`CrownFireResult.activeRatio` can reach 1 in a stand whose surface fire never reaches
`I_0`. `CrownFireResult.type` is the authoritative field, and it is "active" only when the
surface intensity has reached `I_0` **and** the mass flow criterion is met. Below a
10 percent canopy cover or a 0.01 kg/m3 bulk density the stand is treated as too open or
too sparse to carry crown fire at all and the surface answer passes through untouched.

## Active rate of spread, and why not Rothermel (1991)

The active crown rate is Cruz, Alexander & Wakimoto (2005), Can. J. For. Res.
35:1626-1639, eq. 6, the model behind the Canadian CFIS:
`R_active = 11.02 × U10^0.90 × CBD^0.19 × exp(-0.17 × EFFM)`, with `R_active` in m/min,
the 10 m open wind in km/h, bulk density in kg/m3, and fine fuel moisture in percent. US
fire weather reports a 20-foot wind and `FireScenario.windSpeedMph` is documented as that,
so it is converted with `U_10m = 1.15 × U_20ft` (Turner & Lawson 1978, the same ratio
Scott & Reinhardt and CFIS use). Fine fuel moisture is held between 3 and 18 percent
before it enters the exponential, because below 3 percent the exponential inflates the
rate past anything the source supports and above about 18 percent crown fire was not
observed in that dataset at all.

The alternative was Rothermel (1991, INT-438), which sets the active crown rate at
3.34 times an Anderson Fuel Model 10 surface run made at 0.4 of the 20-foot wind. It was
rejected for two separate reasons. The inputs are not available: this model carries one
fine fuel moisture, not the five-class moisture vector an FM10 run needs, and FM10 is an
Anderson (1982) thirteen-model entry that is not in the Scott & Burgan 40-model set this
simulator uses, so supplying either would mean inventing a fuel model and four moisture
values rather than reading them off the landscape. The behaviour is also wrong for this
problem: the 3.34 factor is a correlation fitted to eight northern Rocky Mountain crown
fires and carries no canopy bulk density term at all, so it returns the same crown rate
for a dense Douglas-fir stand and an open woodland — exactly the distinction a Santa Cruz
Mountains or Berkeley Hills run has to make. Cruz et al. is fitted to 58 conifer crown
fires and takes bulk density directly. The two are not averaged; Cruz is used alone.

## Passive crown fire, and how narrow its band is

A cell that ignites its canopy but fails the mass flow test is passive — a surface fire
torching individual trees. Scott & Reinhardt (2001, RMRS-RP-29) interpolate linearly in
surface spread rate between the rate at which torching begins and the rate at which the
canopy would go active, and blend the surface and crown rates by the resulting crown
fraction burned. Byram's intensity is linear in spread rate at a fixed heat per unit area,
so the lower anchor is `R_surface × I_0 / I_surface`.

One substitution is left visible. Scott & Reinhardt obtain the upper anchor by inverting
Rothermel (1991), whose crown rate is a function of the surface rate; the Cruz rate is
not, so the upper anchor here is Van Wagner's critical crown rate itself, the same
quantity the active test uses. The linear ramp is Scott & Reinhardt's stated assumption
rather than a measured relationship, and what it produces — torching fires only modestly
faster than the surface fire beneath them — is the right shape.

The passive band is narrow at the winds this demo runs at, and that is a property of the
numbers rather than a choice. The mass flow test is passed when `R_active ≥ 0.05 × 60 /
CBD`. At the demo default of 40 mph with the critical moisture preset the Cruz rate is at
its 100 m/min ceiling, so the test is passed by any canopy denser than 0.03 kg/m3, while
crown fire is skipped entirely below 0.01. Passive therefore survives only in the sliver
between those two numbers, and the LANDFIRE bulk densities measured over Santa Cruz
Mountains forest cluster around 0.11 to 0.22. At the demo wind, a stand that ignites its
canopy at all goes straight to active almost everywhere. Passive is reachable — it is what
a lower wind, a wetter preset, or a genuinely sparse canopy produces — but a run at the
defaults should not be expected to show much of it, and
`FireRun.crownFireBreakdown.passiveCrownSquareMeters` reporting near zero is the model
agreeing with its own thresholds rather than a failure to classify.

## Midflame wind per cell, and why surface fire got slower

The solver previously applied a flat 0.5 of the open wind at midflame height everywhere.
That is a round figure a BehavePlus user reaches for, not a measurement. The per-cell
factor is now Albini & Baughman (1979, INT-221) in the form Andrews (2012, RMRS-GTR-266)
presents. In unsheltered fuel, with the fuel bed depth `h` in feet,
`WAF = 1.83 / ln((20 + 0.36 h) / (0.13 h))`, which reproduces the published per-fuel-model
table: 0.28 at 0.2 ft of conifer litter, 0.36 at 1 ft, 0.42 at 2 ft, 0.44 at 2.5 ft, 0.46
at 3 ft and 0.55 at 6 ft. Under a canopy, with stand height `H` in feet and `f` the crown
fill portion, `WAF = 0.555 / (sqrt(f H) × ln((20 + 0.36 H) / (0.13 H)))`. The crown fill
portion is canopy cover times crown ratio, and because the canopy base height raster is
available the crown ratio is `(height − base height) / height` rather than the `cover / 3`
substitute used where base height is unknown. An overstory can only slow the wind reaching
the fuel bed, so the sheltered value is additionally not allowed to exceed the open-fuel
value for the same bed; that guard is ours, not Albini & Baughman's.

The consequence is stated on purpose, because it looks like a regression and is not. The
flat 0.5 was 1.2 to 1.7 times the unsheltered Albini & Baughman value across most of the
Scott & Burgan set, and under a closed conifer canopy the sheltered value is near 0.1, a
fivefold difference. Adopting this function therefore makes **surface** spread under
forest much slower than it was. It must not be "fixed" by raising the factor back: in real
forest the speed comes from the canopy, not from the litter layer, and crown fire is what
supplies it above. The two halves only make sense together, and a run with this factor and
without crown fire would be slower than the model it replaced.

One number in it is chosen from a range rather than computed. The factor is floored at 0.1
because Rothermel (1983, INT-143) tabulates 0.1 to 0.2 for fuel fully sheltered beneath a
timber stand and Andrews (2012) recommends 0.2 as the sheltered default when stand data is
missing, while the Albini & Baughman equation runs below that entire measured range for
tall closed stands — about 0.04 for a 30 m redwood canopy — which is
extrapolation past any measurement behind it. The floor therefore binds, rather than
sitting unused as a guard: in the tallest closed stands the model is reporting the bottom
of a published range and not the equation. Halving it roughly halves surface fireline
intensity under forest and moves where crown fire initiates, so it is the most
load-bearing single number in this entry.

The precedence is explicit and reported. A scenario `midflameAdjustment` moved off its
default wins everywhere, because a number a user chose by hand should not be silently
replaced by a derived one. Otherwise, when the canopy rasters loaded, each cell gets its
own factor. When they did not load, the flat default is used unchanged, because without
canopy data there is no honest way to tell a sheltered cell from an open one and applying
the unsheltered formula everywhere would assert that the landscape has no trees.
`FireRun.midflameWind` says which of the three applied and reports the mean, minimum, and
maximum factor actually used.

## Crown fire shape

Shape is handled explicitly rather than inherited. The surface ellipse uses the Anderson
(1983) length-to-breadth driven by the midflame wind, and under a closed canopy that wind
is now a small fraction of the open wind: a 40 mph day over a dense stand gives a midflame
wind near 4 mph and an Anderson length-to-breadth near 2.5. That is the shape of the
sheltered surface fire and emphatically not the shape of a crown fire running on the wind
above the canopy. Leaving crowning cells on it would have given a 40 mph crown run a
near-circular perimeter and inflated its area several-fold.

Actively crowning cells therefore take the length-to-breadth relation fitted to conifer
forest fires driven by the open wind, `1 + 8.729 × (1 − exp(−0.030 U))^2.155` with `U` in
km/h — Alexander, "Estimating the length-to-breadth ratio of elliptical forest fire
patterns" (Proc. 8th Conf. Fire and Forest Meteorology, 1985), as adopted by the Canadian
Forest Fire Behavior Prediction System (Forestry Canada Fire Danger Group, Information
Report ST-X-3, 1992, eq. 79) for its conifer fuel types. It is asymptotic to 9.729 rather
than unbounded, and at the 40 mph demo wind it returns about 7.8, a little below the
Anderson cap of 8 an unsheltered surface fire would sit at in the same wind, which is the
less elongated, plume-influenced shape a crown fire is expected to take.

Passively crowning cells keep the surface ellipse. In Scott & Reinhardt's formulation a
passive crown fire is a surface fire that torches individual trees; its perimeter is the
surface fire's perimeter, and no source supports giving it a different shape. The jump at
the passive/active boundary is a real discontinuity in the classification and is already
present in the spread rate.

## Canopy data

Four more LANDFIRE LF2025 coverages are fetched alongside the FBFM40 fuel raster, from the
same WCS service, the same vintage, and the same 30 m EPSG:3857 grid: canopy base height
(`LF2025_CBH_CONUS`), canopy bulk density (`LF2025_CBD_CONUS`), canopy cover
(`LF2025_CC_CONUS`), and canopy height (`LF2025_CH_CONUS`). Each goes through the same
bounded sub-request chunking, retry, and in-flight de-duplication as the fuel raster, and
all four share the fuel raster's concurrency budget of four parallel requests so that four
layers do not multiply the load on the service. The cost is real: placing an ignition
point now issues five coverages' worth of sub-requests instead of one, and the canopy
fetch overlaps the terrain tiles, which come from a different host.

LANDFIRE publishes these as scaled 16-bit integers, not SI floats, and the scale factors
were measured against the live service rather than assumed. Over Santa Cruz Mountains
redwood and Douglas-fir (37.441, −122.317, a 1.5 km box, 15876 cells) raw CBH ran 0 to 100
with modes at 32, 33, 39, 41 and 47, raw CBD 0 to 34 with modes at 22, 16, 11 and 12, raw
CC 0 to 85, and raw CH 0 to 430 with modes at 230, 190, 270 and 310. Base height and stand
height are therefore decimetres and divide by 10, bulk density is kg/m3 × 100 and divides
by 100, and cover is already a percentage. After scaling, a 43 m stand with a 3 to 5 m
crown base and 0.16 to 0.22 kg/m3 of bulk density is the right shape for the stand type.
The control was Carrizo Plain grassland (35.19, −119.80, 15129 cells), where every canopy
layer reads exactly 0 while FBFM40 reads grass and bare ground.

Because the scale factors are a published convention that could change with a vintage,
each layer is checked against a physical ceiling after scaling — 30 m of base height, 1
kg/m3, a cover fraction of 1, 120 m of stand height — and a layer that puts more than
0.5 percent of its cells above one is rejected outright instead of feeding the crown model
numbers that are off by a factor of ten. A layer missing data for more than 1 percent of
the fuel-mapped cells is rejected on the same terms. LANDFIRE's −9999 and the 32767 this
service has also been observed to return both read as missing rather than as zero canopy.

A failure degrades the run rather than ending it: the arrays come back zeroed and
`canopyComplete` is false, which means **unknown canopy, not treeless ground**. The solver
then skips crown fire entirely, keeps the flat scenario midflame factor rather than
applying the unsheltered Albini & Baughman formula to a landscape it cannot see, and the
run carries `CROWN_FIRE_UNAVAILABLE_REASON` for the page to show verbatim. Reading a
zeroed canopy as bare ground would turn a data outage into a statement about the
landscape, which is the one thing this grid must not do.

## What it does on real ground

Measured at particular ignition points, as in 0007, and not a calibrated envelope. A
closed Douglas-fir stand went from 4 to 29 m/min of surface spread to roughly 71 to
100 m/min once the canopy carried the fire. At one Santa Cruz Mountains timber ignition
the three-hour burn went from 98 ha and 2.51 km to roughly 232 ha. Grass is unchanged
except for the corrected wind factor, which is the expected result: a grass cell has no
canopy, so crown fire is skipped and only the midflame factor moved. An open oak woodland
control never crowns, and it fails both criteria independently — the sheltered surface
fire never reaches `I_0`, and the bulk density is too low to meet the mass flow
requirement even at the capped crown rate — so neither test is carrying that result alone.

## Where timber litter does not initiate

Under a closed canopy the timber-litter fuels do not independently reach Van Wagner's
threshold. The chain is mechanical: the correct sheltered wind adjustment factor is near
the 0.1 floor, that starves the surface fire, the surface fireline intensity falls below
`I_0` for any realistic canopy base height, and the cell is classified surface however
dense its canopy is. It is the under-prediction Cruz & Alexander (2010) criticise directly
in linked surface-crown models: a model that drives crown initiation from a sheltered
surface fire will under-predict crowning in exactly the stands that crown in reality.

`spread.ts` closes exactly this gap, but only for a cell next to an already-crowning
neighbour, not for an isolated sheltered stand. Alongside the self-initiated test, the
precompute separately evaluates `canSustainActiveCrown` for every cell — Van Wagner's
critical mass flow criterion alone, on this cell's own canopy and the scenario weather,
with no reference to this cell's own surface intensity — and stores the active rate it
would run at if that criterion is met. Neither answer is selected yet. At the moment a
cell settles in the minimum-travel-time relaxation, `spread.ts` checks whether the edge
that produced its arrival time came from a neighbour that was itself spreading as an
active crown fire; if it did, and this cell's canopy can sustain an active crown fire on
its own terms, the cell continues as active — at the Cruz rate, with the active-crown
ellipse — regardless of whether its own sheltered surface fire ever reached `I_0`. A cell
that can sustain active crown but is only ever reached by surface or passive neighbours
stays on its precompute answer, and ember spotting always breaks the chain: a spot
ignition crosses unvegetated ground by construction, so it can never carry an active
crown state across the gap. This is a correctness-sensitive choice made exactly once,
at the time each cell is popped off the solver's heap for good, which is safe because a
Dijkstra relaxation over nonnegative edge weights never revisits a settled cell. The
result is that continuous closed canopy carries an active crown fire through cells that
could never have started one on their own — which is the behaviour Cruz & Alexander
(2010) say a linked model needs — while an isolated sheltered stand with no crowning
neighbour still reports surface only, exactly as the mechanical chain above describes.

## Where this is least trustworthy

The 100 m/min ceiling on the active crown rate binds, and at the demo defaults it binds
almost everywhere. Cruz et al. is a regression and extrapolates without bound; at 40 mph
with the critical moisture preset's 3 percent dead fine fuel moisture it returns about
225 m/min for a 0.16 kg/m3 stand, and about 135 m/min at 6 percent. The ceiling is set at
100 m/min because documented sustained conifer crown fire runs top out near there — the
Camp Fire's fastest sustained push was about 91 m/min — so the model emits a number that
can be pointed at an observation rather than whatever the fit produces. The arithmetic of
when it binds is worth stating plainly: at 3 percent moisture the Cruz rate passes
100 m/min above roughly 16 mph of open wind for a 0.16 kg/m3 stand, and above roughly 21
and 14 mph for 0.05 and 0.30 kg/m3. At the demo wind the reported active crown rate is
therefore the cap and not Cruz et al., the measured 71 to 100 m/min range has the ceiling
as its upper end, and the model is insensitive to further wind in actively crowning cells.
That is a deliberate refusal to extrapolate, not a calibration.

The cap binding this hard leaves almost nothing for the passive band to classify. Measured
at the demo defaults, `FireRun.crownFireBreakdown.passiveCrownSquareMeters` is 0.0 percent
of burned area: every cell whose canopy ignites at these winds clears the mass flow
criterion too, so it lands in active rather than passive. That is the model agreeing with
the arithmetic in the section above, not a bug in the classification, but it also means
the passive branch of `crownFireBehaviour` is effectively unexercised at the settings this
demo actually runs with, and whatever confidence a reader has in it should come from the
Scott & Reinhardt source rather than from anything this run has demonstrated.

The chaparral anchor moved and has not been recovered. The calibration study had placed a
chaparral control within about 1.5 times the observed Palisades Fire, which crownFire.ts
still cites; once [0009](0009-solver-direction-set.md) resolved the ellipse the solver had
been losing, the same control moved to roughly three times that anchor. The honest reading
is not that crown fire or the stencil broke it. It is that the original agreement was
measured on a solver that was losing two to four times its own intended ellipse, so the
1.5 figure was never a sound anchor and the agreement it reported was partly two errors
cancelling. The current factor-of-three disagreement is unresolved, it is in the direction
of over-prediction, and chaparral is not a crown fire fuel, so nothing in this entry
explains it. It is recorded here as an open question rather than as a tolerance.

Plume-dominated behaviour is still absent, and now sits closer to the surface. The model
has no fire-generated wind, no convection column, and no plume collapse, and spotting is
deliberately left on the surface fireline intensity with its 500 m ceiling even in cells
that are now predicted to crown, because the spotting coefficient and that ceiling were
both calibrated on fires that were not crowning. The Camp Fire's measured maximum spot was
about 6.3 km. The model will not produce that, and feeding crown intensity through a
relation fitted to non-crowning fires would manufacture the reach rather than model it, so
this model understates spotting wherever it now predicts crown fire. That is a known
conservative simplification rather than an oversight, and it is the clearest remaining gap
between this model and the fires it is aimed at.

Everything 0004 and 0007 list as absent is still absent. There is no suppression, no
acceleration from a point ignition to a steady-state front, and no time-varying weather:
wind speed, wind direction, and fuel moisture are uniform over the grid and constant for
the whole run, so a wind shift — which is what turned Tubbs and Camp — cannot be
represented at all. The grid is 30 m, which is finer than the fuel data's own mapping
accuracy but far coarser than a stand edge or a road width. Canopy cover, base height,
bulk density, and stand height are mapped 2025 products, not an observation of today's
vegetation, and foliar moisture is a constant rather than a measurement.

The demo defaults remain explicitly unvalidated presentation choices: the critical
moisture preset at 40 mph puts the simulator in peak fire weather on a first click, and
the page says so. The crown fire mechanism makes those defaults produce much larger fires
in forest, which makes the lack of validation matter more rather than less. Outputs remain
planning experiments, not operational evacuation instructions.
