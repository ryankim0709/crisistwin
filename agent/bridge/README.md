# Fire model bridge

`fire-bridge.mjs` is a one-shot stdio sidecar that runs the project's **existing**
TypeScript fire model for the Python fire-watch agent. The model is
`app/src/fire/{rothermel,fuelModels,landscape,spread}.ts` — Rothermel (1972) surface
spread over the Scott & Burgan (2005) fuel models, propagated as a minimum-travel-time
field. None of that physics is reimplemented here or in Python, and it must not be: one
agreed model, driven from two places.

The Python side is `agent/crisistwin_agent/simulation/bridge.py` (`NodeFireBridge`), which
implements the `FireSpreadModel` port.

## Setup and the exact run command

```bash
cd agent/bridge
npm ci                 # or: npm install   (installs TypeScript, the only dependency)

# One run, by hand:
echo '{"origin":{"latitude":37.88,"longitude":-122.24},"windSpeedMph":25,
       "windFromDegrees":45,"moisturePresetId":"critical","midflameAdjustment":0.5,
       "stepMinutes":15,"horizonMinutes":120,"groundRadiusMeters":4800}' \
  | node fire-bridge.mjs
```

No Node flags are required. `NodeFireBridge` invokes exactly
`<node> <repo>/agent/bridge/fire-bridge.mjs`, where `<node>` is `CRISISTWIN_NODE_BIN` or
`node` on `PATH`.

A run needs internet access to LANDFIRE and to the terrarium elevation tiles, and works
only in the contiguous United States. Outside it the sidecar fails with
`out_of_coverage` rather than inventing fuel.

| Variable                             | Default  | Meaning                                                     |
| ------------------------------------ | -------- | ----------------------------------------------------------- |
| `CRISISTWIN_FIRE_BRIDGE_TIMEOUT_MS`  | `120000` | `AbortSignal.timeout` budget for the landscape fetches.      |
| `CRISISTWIN_FIRE_MODULE_DIR`         | `../../app/src/fire` | Absolute path to the model modules, for an unusual checkout. |

## How TypeScript is executed, and why

**Chosen: a `node:module` hook that transpiles `.ts` with the repo's own TypeScript
compiler.** `registerHooks` installs two synchronous hooks — a `resolve` hook that tries
`<specifier>.ts` for extensionless relative imports, and a `load` hook that runs
`ts.transpileModule` with the compiler options from `app/tsconfig.app.json`.

What was ruled out, and why:

- **Node's native type stripping** (`--experimental-strip-types`, on by default in
  Node 26). It gets most of the way — the only non-type import in these four files is
  `import type { Feature, Polygon, Position } from "geojson"`, which is type-only and
  erased, and `landscape.ts` has a hand-written GeoTIFF reader, so there is no runtime
  GeoTIFF dependency to install. Two things stop it:
  1. `spread.ts` declares `constructor(readonly fuelCode: number)` in
     `NonBurnableIgnitionError`. A parameter property needs a real transform, and Node 26
     reports `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` (`process.features.typescript === "strip"`;
     `--experimental-transform-types` no longer exists in this Node).
  2. The modules import siblings extensionless (`./fuelModels`), which a bundler resolves
     and Node does not.
     A `resolve` hook fixes (2) on its own, but nothing short of a transform fixes (1),
     and the app's files are owned elsewhere, so patching that one line was not an option.
- **`tsx` or `esbuild`.** Either would handle resolution and transform with no hook code,
  but each is a genuinely new library for this repo and ships a platform-specific native
  binary. `typescript` is already the repo's compiler (`app/package.json` devDependency,
  `~5.8.3`), is pure JavaScript, and compiles these files exactly as `npm run build` does.
  Pinning the same range here keeps one compiler version across the repo.

**Dependencies added: one, `typescript@~5.8.3`** — the version `app/package.json` already
uses. `package-lock.json` is committed so `npm ci` is reproducible.

## The two other things the browser provides and Node does not

**1. The `/landfire` proxy.** `landscape.ts` fetches the relative path `/landfire/wcs`,
which only resolves behind the Vite dev server. The sidecar installs a global `fetch`
wrapper that applies the same rewrite `app/vite.config.ts` does — `/landfire` →
`https://edcintl.cr.usgs.gov/geoserver/landfire` — and otherwise delegates to the real
`fetch`. `landscape.ts` is **not** edited; it is owned by another branch, and the fix
belongs on this side of the seam anyway. If the Vite proxy rule changes, change the two
constants at the top of `fire-bridge.mjs` to match.

**2. `createImageBitmap` / `OffscreenCanvas`.** `landscape.ts` decodes terrarium elevation
PNGs through a 2D canvas. Node has neither API, so both are polyfilled over a ~90-line
reader for the 8-bit non-interlaced RGB/RGBA PNGs that tile set publishes (`node:zlib`
inflate plus the five standard PNG row filters); any other PNG layout is rejected rather
than misread. Terrain is decoded for real rather than skipped: `fetchTerrainTile` returns
`null` for a tile it cannot get and `sampleElevation` then uses 0 m, so a stubbed-out
polyfill would quietly produce a flat landscape with no slope effect — a fabricated
result, not a missing one.

## Protocol

One JSON request on stdin, one JSON response on stdout, then exit. **stdout carries
nothing but that single JSON line**; every log, warning and progress note goes to stderr.

Request:

```json
{
  "origin": { "latitude": 37.88, "longitude": -122.24 },
  "windSpeedMph": 25,
  "windFromDegrees": 45,
  "moisturePresetId": "critical",
  "midflameAdjustment": 0.5,
  "stepMinutes": 15,
  "horizonMinutes": 120,
  "groundRadiusMeters": 4800
}
```

`origin`, `windSpeedMph`, `windFromDegrees`, `moisturePresetId` and `groundRadiusMeters`
are required. `midflameAdjustment`, `stepMinutes` and `horizonMinutes` fall back to
`DEFAULT_MIDFLAME_ADJUSTMENT`, `FIRE_STEP_MINUTES` and `FIRE_HORIZON_MINUTES` from
`spread.ts`. `moisturePresetId` is resolved against `MOISTURE_PRESETS` (`critical`, `dry`,
`moderate`, `wet`); an unknown id is an error, never a silent default.

Success — the `FireRun` exactly as `simulateFireSpread` returned it, frames included:

```json
{ "ok": true, "run": { "model": {...}, "scenario": {...}, "frames": [...], "ignition": {...},
                       "burnableFraction": 0.54, "reachedEdge": false,
                       "cellSizeMeters": 23.68, "computeMilliseconds": 37 } }
```

Failure:

```json
{ "ok": false, "error": { "type": "non_burnable" | "out_of_coverage" | "unavailable", "message": "..." } }
```

- `non_burnable` — `simulateFireSpread` threw `NonBurnableIgnitionError`: the ignition
  cell is water, pavement, bare rock or developed land.
- `out_of_coverage` — LANDFIRE answered 400 or 404 for the requested subset, or the model
  reported an area outside its grid. 400/404 is the signal GeoServer gives for a subset
  outside the published coverage; any other error status is the service failing and is
  reported as `unavailable`, because "the service is down" and "this place has no fuel
  data" are different findings.
- `unavailable` — anything else: a network failure, the `AbortSignal` timeout, a raster
  that would not decode, or an invalid request. The message always says which.

The process **exits 0 whenever it wrote a response**, including a failure response. A
non-zero exit means it crashed before answering, and `NodeFireBridge` treats that, a
truncated or non-JSON stdout, and a subprocess timeout all as `PortUnavailableError`.

## Units at this boundary

The sidecar converts nothing. Everything crossing the pipe is in the model's own units:
ground metres and square metres, elapsed simulation minutes from ignition, miles per hour
for the open 20-foot wind, meteorological degrees for the bearing the wind blows *from*,
and WGS84 decimal degrees in GeoJSON `[longitude, latitude]` order.

The one exception is deliberate: `run.ignition.spread` keeps the Imperial units the
Rothermel equations are published in, including `headRateFeetPerMinute`. Python converts
that to metres per minute exactly once, in `simulation/bridge.py`
(`METERS_PER_FOOT = 0.3048`).

Note that `frames[].perimeters` is an **array** of GeoJSON `Feature` objects — one per
disjoint burned patch — not a `FeatureCollection`. `NodeFireBridge` wraps each array into
a `FeatureCollection` for `SpreadFrame.perimeter`.
