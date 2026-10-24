# 0003: Illustrative wind-driven fire spread

Date: 2026-10-23. Status: accepted for the MVP demonstration.

Add an explicitly illustrative geometric spread model in `app/src/simulation/fire.ts`
so the map supports the requested interaction now: choose an origin, set wind,
run, and inspect the footprint in 15-minute steps. Keep this pure TypeScript
module independent of React, MapLibre, the network, and wall-clock time.
It is a temporary frontend model, not the future coupled Python fire/traffic
engine described in the project scope. No backend or traffic contracts change.

The model grows an ellipse through a uniform fuel field, with faster downwind
growth and slower backing growth. The rate constants are deliberate demo
assumptions, not fitted measurements, a Rothermel implementation, or a validated
prediction. Terrain, fuels, moisture, water, structures, spotting, and suppression
are absent. Consequently it can grow across water or buildings. Keep this
limitation visible next to the controls rather than implying the imagery feeds
the model. Background imagery and user assumptions remain distinct from results.

## Input and output contract

`simulateFire({ origin: { latitude, longitude }, windSpeedMph, windFromDegrees })`
returns a `FireRun` containing a copied input snapshot, model ID/version and rate
parameters, step/horizon, and nine `FireFrame` values at 0, 15, …, 120 minutes.
There is no randomness or external source input; identical inputs and model
version produce identical results. Wind is a user assumption, not fetched weather.

- Origin is WGS84 decimal degrees. The demo accepts latitude in [-80, 80] and
  longitude in [-180, 180]. Validation rejects nonfinite or unsupported inputs.
- Wind speed is 0–40 mph, converted once to m/s with `mph * 0.44704`.
- Wind direction is meteorological **from**, degrees clockwise from north in
  [0, 360). The UI offers eight compass directions and shows the direction of
  travel. For example, 270° means wind from west, spreading preferentially east.
- `elapsedMinutes` is simulation time since ignition. Frame zero has an empty
  GeoJSON collection and the selected origin marker; later frames contain one
  Polygon with a closed, counterclockwise, 72-segment ring.
- Polygon coordinates use [longitude, latitude]. Longitudes are continuous
  around the origin (and may exceed ±180 at the date line) to avoid a spurious
  polygon spanning the whole map. Offsets are projected on a sphere of radius
  6,371,008.8 m; this is a small-area approximation.

## Numerical assumptions

With `w` in m/s and `t` in seconds since ignition:

```text
base rate       = 0.1 m/s
downwind rate   = base * (1 + 0.35 * w)
backing rate    = base / (1 + 0.15 * w)
semimajor axis  = (downwind rate + backing rate) * t / 2
center offset  = (downwind rate - backing rate) * t / 2, downwind
semiminor axis  = base * t
```

Both rates are positive over the supported input range. Zero wind reduces to a
circle centered at ignition. At fixed wind each footprint is a positive scaling
of the same shape about ignition, so it contains the origin and earlier
footprints in the model's local plane. These are mathematical design properties;
automated numerical verification has not been run under the repository's
pre-commit-only policy. Population, capacities, routing, and evacuation metrics
are outside this model.

## UI integration

Calculating all frames requires only 576 projected vertices and happens locally
on **Simulate fire**. Initial output is +15 minutes; previous/next controls and a
range input inspect the run. Playback displays one precomputed frame per second,
stopping at +120 minutes; display timing never changes model results. Changing
origin or wind stops playback and clears the previous run and overlay.

MapLibre receives `firePerimeter` as GeoJSON and updates its source without
recreating the map or reloading imagery. Map controls remain usable during
playback. A future model can replace `simulateFire` while retaining the frame
contract, but it must identify its own inputs, source timestamps, model version,
units, and limitations.
