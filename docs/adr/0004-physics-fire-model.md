# 0004: Physics- and vegetation-based fire spread model

Date: 2026-10-23. Status: accepted.

Amended by [0005](0007-wui-spread-mechanisms.md), which adds ember spotting and
structure-to-structure spread on top of this model and floors the directional rate. The
paragraphs below that it changed have been corrected in place and say where to read the
detail; everything else here still holds.

Supersedes [0003](0003-fire-spread-model.md), which was numbered 0003 because
`origin/feat/berkeley-hills-maps` already publishes `0002-geographic-map.md`; this
entry continues that sequence.

## Supersedes 0003

`uniform-fuel-ellipse` v1.0.0 grew an ellipse from the ignition point on flat, uniform
fuel. Its head rate of spread was linear in wind, `2.4 m/min + 13 (m/min)/(m/s) × U`,
with constants invented so that a 20 mph wind looked fast rather than fitted to any
observation. Because the model knew nothing about what was on the ground, an ignition in
the Berkeley Hills ran straight across San Francisco Bay and through dense residential
Berkeley at the rate it ran through brush. A 6.7 × 7.0 km box over that ignition area is
59.7 percent non-burnable, and urban or developed ground alone (FBFM40 code 91) accounts
for 59.5 of those points. A model that ignores most of its own landscape is not a useful
planning input, and no retuning of two constants fixes that. The ellipse is replaced
rather than extended.

## Decision

Use `rothermel-1972-mtt`, v2.0.0 at this decision and v3.0.0 since
[0005](0007-wui-spread-mechanisms.md): Rothermel surface spread per cell over a real fuel
and terrain raster, propagated as a minimum-travel-time arrival field. `fuelModels.ts`
holds the fuel table, `rothermel.ts` the spread equations, and `spread.ts` the propagation
and contouring; all three keep the rule from 0003 that the model imports no React, DOM,
MapLibre, or network code, and they take the landscape as an argument. The network lives
in `landscape.ts` alone, which fetches the fuel and elevation rasters and derives terrain
from them. `FireMap.tsx` renders the output and `FireSimulatorPage.tsx` owns scenario
state; neither recomputes geometry.

## Surface rate of spread

Surface spread is Rothermel (1972) in the formulation given by Andrews, "The Rothermel
surface fire spread model and associated developments: a comprehensive explanation"
(USDA Forest Service RMRS-GTR-371, 2018). The equations are kept in the Imperial units
they were published in and return feet per minute; conversion to metric happens at the
caller's boundary. Everything about a fuel bed that does not depend on wind or slope
(reaction intensity, no-wind spread rate, packing ratio, the wind coefficients) is
computed once per fuel model present and reused by every cell using that model, which is
what makes a landscape-sized run tractable.

## Fuel models

Fuels are the Scott & Burgan (2005) 40 standard fire behavior fuel models, RMRS-GTR-153,
keyed by the code LANDFIRE's FBFM40 layer encodes so a raster value indexes the table
directly. Loads are pounds per square foot, surface-area-to-volume ratios square feet per
cubic foot, and fuel bed depth feet. The dead 10-hour and 100-hour classes take fixed
ratios of 109 and 30. Low heat content is 8000 Btu/lb for every model except GR6, which
Scott & Burgan's own Table 7 gives a higher heat content of 9000 Btu/lb.

Dynamic fuel models transfer live herbaceous load into a dead herbaceous class as the
herb layer cures, fully cured at 30 percent herbaceous moisture and fully green at 120.
That transfer is what lets cured grass carry fire in the model, and it is why a moisture
change alters shape as well as speed. Live fuel moisture of extinction is not a constant:
it is computed from how dry the fine dead fuel is relative to its own extinction moisture
(Albini 1976).

## Wind, slope, and ellipse shape

Wind and slope each produce their own coefficient and each pushes in its own direction,
so they are combined as vectors rather than summed. The resultant sets both the heading
bearing and the combined coefficient applied to the no-wind rate, which means a cross-slope
wind turns the fire instead of only speeding it up.

Ellipse elongation uses the Anderson (1983) length-to-breadth relationship from effective
wind speed, capped at 8 as FARSITE does, since the relationship is unbounded in strong
wind. The rate at an angle away from the heading direction follows Alexander (1985) for
an ellipse ignited at its rear focus. That rate is now floored at the no-wind, no-slope
rate of spread, as BehavePlus computes backing spread; see
[0005](0007-wui-spread-mechanisms.md) for why the unfloored 0.4 percent of head was wrong
and why the cap of 8 was left alone.

## The effective wind limit is reported, not enforced

Rothermel (1972) carries an effective wind limit of 0.9 times reaction intensity, beyond
which the model is outside its validation. Enforcing it capped grass spread at roughly
5 mi/h effective wind and left the model nearly insensitive to any wind above that, which
is the wrong behaviour for a tool whose whole subject is wind-driven fire. Following
Andrews, Cruz & Rothermel (2013), and FARSITE and FlamMap, which also do not enforce it,
the limit is reported instead: every spread result carries `beyondValidatedWind`, true
when the run is extrapolating past the validated range. The number is still produced; the
flag says how much to trust it.

## Propagation

Spread is propagated as a minimum-travel-time arrival field over the grid, after Finney
(2002). A binary min-heap settles cells in arrival order, and each settled cell offers its
neighbours the elliptical rate for the direction of travel, so heading, flanking, and
backing spread all fall out of one field rather than being special-cased.

Each cell offers sixteen neighbours, not eight. With only the immediate ring, spread
directions quantise to 45 degrees and perimeters come out visibly octagonal. A two-cell
step must find a passable cell roughly halfway along it, so a step cannot hop a one-cell
barrier such as a road. A cell with no spread rate of its own is never reached at all,
which is what keeps fire out of the bay. At this decision that was every cell without a
fuel model; since [0005](0007-wui-spread-mechanisms.md) developed ground carries a rate of
its own while structure spread is on, so it can be entered and can pass fire on, and
embers can cross a gap to vegetation beyond it. Water, snow or ice, agricultural land, and
bare ground stay unreachable under every mechanism.

Perimeters are produced per frame by marching squares over the burned/unburned mask at
that elapsed time, assembled into GeoJSON polygons with holes identified by containment
depth rather than winding order. A 675 × 676 grid, about 456,000 cells, solved in roughly
100 to 140 ms when this was measured, which is fast enough to re-solve when a control
changes. The mechanisms added in [0005](0007-wui-spread-mechanisms.md) cost about a third
more on the grid measured there.

## Landscape data

Fuel comes from LANDFIRE LF2025 FBFM40 CONUS, fetched live per scenario with a WCS 2.0.1
GetCoverage request to `https://edcintl.cr.usgs.gov/geoserver/landfire/wcs`, coverage id
`landfire__LF2025_FBFM40_CONUS`. The service returns EPSG:3857 at 30 m as a tiled,
uncompressed 16-bit GeoTIFF. `landscape.ts` decodes exactly that layout and rejects
anything else rather than silently misreading it, so no GeoTIFF dependency was added.
EPSG:3857 is the projection MapLibre renders in, so the grid needs no reprojection. The
coverage is United States only: outside the contiguous US the run fails with an explicit
error instead of an empty landscape. One request per scenario did not survive contact
with the service; how the grid is now fetched, and what the browser needed before it
could reach the service at all, is in [0005](0007-wui-spread-mechanisms.md).

Terrain comes from the keyless AWS Open Data terrarium elevation tiles at zoom 13, whose
pixels are near the 30 m fuel cell, decoded as `R × 256 + G + B / 256 − 32768` metres and
sampled onto the fuel grid. Slope and aspect are derived by Horn's method over the eight
neighbours of each cell. A tile that cannot be fetched is reported on the grid rather
than read as sea level, which had been silently flattening slope.

## Units: Mercator metres are not ground metres

One Mercator metre is cos(latitude) ground metres, about 0.79 at Berkeley, so a 30
Mercator metre cell is about 23.7 metres on the ground. The grid carries both: signed
Mercator cell sizes for addressing and a single ground cell size for physics. Slope,
spread distances, burned area, and reach are ground metres; only cell addressing and the
conversion of contours back to longitude and latitude use Mercator. Getting this wrong
inflates every distance by about 27 percent at this latitude and flattens every slope by
the same factor, so the correction is applied once, where the landscape is built.

Inside the model distances are metres and rates metres per minute. Miles per hour,
kilometres, hectares, and acres exist only at the display boundary. Wind direction is
meteorological, the bearing the wind blows from, converted once to a toward-bearing. All
times are elapsed simulation-clock minutes from ignition.

## Determinism and refusals

The run is fully determined by its scenario and the fetched landscape. No randomness is
used, so no seed is recorded; a run returns the scenario, the model id and version, the
derived spread rates at the ignition cell, the burnable fraction of the modelled area,
whether fire reached the edge of that area, and the solve time. Since
[0005](0007-wui-spread-mechanisms.md) it also returns the options actually applied, the
developed and fire-carrying fractions, and the burned area split by the mechanism that
delivered fire to it.

Igniting on a cell that carries no fuel — 92 snow or ice, 93 agricultural, 98 open water,
99 bare ground — is refused with `NonBurnableIgnitionError` naming the ground, rather than
producing a fire that could not start there. Developed ground, 91, was refused on the same
terms at this decision; since 0005 it is accepted when structure-to-structure spread is
switched on and refused when it is off, because the rest of the run carries fire through
developed ground.

## What it does on real ground

At Napa / Atlas Peak with a 25 mph wind and critical moisture, ignition lands in TU2, the
head rate is 14.9 m/min, and the fire reaches 33 ha and 1.29 km by T+3:00 over a landscape
that is 87 percent burnable. In Los Padres chaparral, ignition lands in TU5, the head rate
is 6.5 m/min, and the fire reaches 36 ha and 1.47 km by T+3:00 at 90 percent burnable.

The Berkeley wildland-urban interface behaved differently, and at this decision that was
read as a finding rather than a defect. A wind-driven run there stalled within a few
hundred metres: the vegetated patch is small and bounded by streets, and with
length-to-breadth capped at 8 the flanking rate was under 1 percent of the head rate, so
a non-burnable barrier directly downwind could halt the run outright. The old ellipse hid
this by burning through the same ground at full speed.

That reading was only half right. Where the barrier is water or bare rock, the stall is
the landscape. Across a street it was the model omitting two mechanisms that carry real
interface fires, and the backing rate it leaned on was not how Rothermel-based systems
compute backing. [0005](0007-wui-spread-mechanisms.md) records both corrections and what
they do to this run.

## Limits

At this decision the surface physics was surface fire only, with no crown fire and no
suppression, and the Rothermel part of the model stopped at the edge of the vegetation.
[0008](0008-crown-fire.md) adds crown fire above this surface model without changing it;
suppression is still absent.

Spotting and structure-to-structure spread were absent at this decision, and the second
omission mattered most: a fire that reached the edge of the vegetation simply stopped,
which understated real wildland-urban interface risk, where structures have historically
carried fire through exactly the developed ground this model treated as inert. Both now
exist, as deterministic and optional assumptions layered on top of the surface model
rather than as physics, and the burned area each delivers is reported separately. Their
constants, sources, and the places they are most likely to run hot are in
[0005](0007-wui-spread-mechanisms.md). Crown fire no longer is: see
[0008](0008-crown-fire.md). Suppression is still absent, and no part of the model
represents plume-dominated behaviour, including the crown fire 0008 adds.

Weather is static. Wind is uniform over the grid and constant in time, fuel moisture is
uniform across the landscape, and there is no diurnal change in either. LANDFIRE fuel is a
2025 mapped product, not an observation of today's vegetation, so recent fire, clearing,
and regrowth are not in it.

Outputs remain planning experiments, not operational evacuation instructions.
