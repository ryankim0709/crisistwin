# 0003: Fire spread simulator and demo spread model

Date: 2026-10-23. Status: accepted.

Numbered 0003 because `origin/feat/berkeley-hills-maps` already publishes
`0002-geographic-map.md`. This branch was taken from `origin/main`, which does not
contain that map work.

## Decision

Add an interactive fire spread simulator at the `/fire` route. The planner clicks the
map to place an ignition point, sets wind speed and direction, and steps a perimeter
forward in 15-minute simulation-clock intervals over a 2, 3, or 6 hour horizon.

Keep the model in `app/src/fire/model.ts` with no React, DOM, network, or MapLibre
imports, so it runs and can be checked outside the browser. `FireMap.tsx` renders its
output and `FireSimulatorPage.tsx` owns scenario state; neither recomputes geometry.

## Model

`uniform-fuel-ellipse` v1.0.0 grows an ellipse from a point ignition on flat, uniform
fuel:

- Head rate of spread is linear in midflame wind: `2.4 m/min + 13 (m/min)/(m/s) × U`,
  where `U` is half the entered open wind speed. The constants are chosen so a 20 mph
  wind gives roughly 60 m/min, a fast continuous grass or shrub run; they are not
  fitted to observed fires.
- Ellipse elongation uses the Anderson (1983) length-to-breadth relationship, capped at
  8 so extreme winds stay finite. The backing rate follows from the head-to-back ratio
  of an ellipse ignited at its rear focus, and the ignition point stays at the rear
  while the ellipse centre drifts downwind.
- Perimeters are 96-vertex GeoJSON polygons placed by great-circle offsets from the
  origin. Burned area is the ellipse area, `π × semi-major × semi-minor`.

The run is fully determined by its scenario plus the exported model constants. No
randomness is used, so no seed is recorded; `simulateFire` returns the scenario, the
model id and version, and the derived rates alongside the frames.

## Units and boundaries

Coordinates are WGS84 decimal degrees, and GeoJSON positions are `[longitude, latitude]`.
Distances are metres and rates are metres per minute inside the model; miles per hour,
kilometres, hectares, and acres exist only in the UI, converted at the display boundary.
All times are elapsed simulation-clock minutes from ignition. Playback advances the frame
index on a timer but never reads wall-clock time into the model. Wind direction is
meteorological: the bearing the wind blows **from**.

Inputs are validated in the model, not only in the form: latitude within ±80°, longitude
within ±180°, wind speed 0–60 mph, wind direction in `[0, 360)`, and a horizon of at
least one step. Out-of-range scenarios throw a `RangeError` the page surfaces as an alert.

## Tradeoffs and limits

An elliptical growth model is the smallest thing that shows wind-driven spread, and it
stays cheap enough to recompute on every control change. It ignores fuel type and
moisture, terrain and slope, spotting, suppression, and barriers such as rivers,
ridgelines, and roads, so perimeters are indicative shapes rather than predictions. The
UI labels every perimeter as a simulated result, names the model and version, and states
that USGS aerial imagery is historical rather than live observation.

A terrain- or fuel-aware model would replace `model.ts` behind the same `FireScenario`
and `FireRun` types. Road closures, evacuation demand, and strategy comparison are not
part of this change.

## Dependency

`maplibre-gl` ^6.15.0 was added to `app/package.json` and `app/package-lock.json`.
`origin/feat/berkeley-hills-maps` adds the same dependency at the same version, so the
two branches should merge without a lockfile conflict on it.
