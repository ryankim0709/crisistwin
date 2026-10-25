# Shared world

Status: contract for the 2026-10-25 integration round. The four workspace tabs (`/fire`,
`/simulation`, `/dispatch`, `/live`) read and control one **world**: the same ground, date,
conditions, fires and seed. Saved **scenarios** are named snapshots of a world (plus each tab's
extras) that anyone can reload later to replay or debug a run.

Units: metres, minutes, UTC ISO-8601 strings, WGS84 `[lon, lat]`. Moisture fractions are
oven-dry fractions (0.06 = 6 %).

## World (`schema: "crisistwin.world/1"`)

```jsonc
{
  "schema": "crisistwin.world/1",
  "revision": 12,                     // server-assigned, +1 on every write
  "updatedAt": "2026-10-25T01:02:03Z",
  "updatedBy": "fire",                // "fire" | "simulation" | "dispatch" | "live" | "mcp" | "api"
  "region": {
    "kind": "catalogue",              // "catalogue" (app/src/fire/regions.ts) | "custom" | "historical_fire" | "incident"
    "id": "berkeley-hills-tilden",    // catalogue id, fire id ("camp-2018"), incident id, or null for custom
    "name": "Berkeley Hills & Tilden",
    "center": [-122.23, 37.895],
    "radiusMeters": 6000,             // half-width of the square board, ground metres
    "cellMeters": 30                  // ground cell; landscapeCellMetersFor(radius) when the user does not pick one
  },
  "conditions": {
    "startUtc": "2018-11-08T14:00:00Z",  // simulation minute 0: the date / time of year
    "weather": {
      "mode": "historical_replay",       // "historical_replay" | "climatology_percentile" | "forecast" | "assumed"
      "percentile": 95,                  // climatology_percentile only
      "windSpeedMph": 20,                // assumed only (20-ft wind)
      "windFromDegrees": 45              // assumed only
    },
    "moisture": {
      "mode": "derived",                 // "derived" (from the date's weather and season, GET /api/conditions) | "preset"
      "preset": "critical"               // preset only: "critical" | "dry" | "moderate" | "wet"
    }
  },
  "fire": {
    "ignitions": [{ "id": "F1", "at": [-122.24, 37.89], "startMinute": 0 }],
    "stochastic": { "enabled": true, "seed": 1234 }
  },
  "liveIncidentId": "camp-2018-drill",  // the /live drill this world drives, or null
  "seed": 1234                          // master seed; tabs derive sub-seeds from it
}
```

Rules:

- Every tab reads the active world and writes only the fields its user changed (a partial
  `PATCH`). A tab never silently overwrites another tab's newer revision: writes carry the
  revision they were based on and get `409` if it moved.
- `region.kind = "historical_fire"` selects a real fire with observed perimeters (Camp 2018,
  Kincade 2019, Woolsey 2018, Marshall 2021); the observed fire is labelled observed, any
  model run on it simulated.
- Evidence labels stay distinct: observed weather, derived (climatology), assumed (user
  sliders), simulated (model output).

## Validation

The server checks the whole merged world on every write and answers `400 {error: "invalid_world",
detail}` naming the first bad field. Unknown keys are refused.

- Numbers are finite (bodies with `NaN`/`Infinity` are refused). `region.center` and ignition `at`
  are `[lon, lat]` in range. `region.radiusMeters` 1 000–60 000. `region.cellMeters` an integer
  multiple of 30 from 30 to 300. `region.id` is an id (`[A-Za-z0-9][A-Za-z0-9._:-]{0,63}`), null
  only for `kind: "custom"`.
- `conditions.startUtc` is ISO-8601 with a zone (stored normalised to `YYYY-MM-DDTHH:MM:SSZ`),
  1900–2100. `weather.percentile` 0–100 (required for `climatology_percentile`);
  `windSpeedMph` 0–150 and `windFromDegrees` 0–360 (both required for `assumed`); `moisture.preset`
  required for `preset`. Mode-specific fields may stay when the mode changes (switching back
  restores them); `null` clears one.
- `fire.ignitions`: at most 50, unique ids, `startMinute` 0–10 080. Seeds are integers 0–2³²−1.
- `liveIncidentId` is an id or null. `updatedBy` is one of the writers above (default `api`).

Default world (revision 0, `updatedAt`/`updatedBy` null, never stored): the catalogue region
`berkeley-hills-tilden` (centre `[-122.23, 37.895]`, radius 6 000 m, 30 m cells), `startUtc`
`2025-08-15T20:00:00Z`, `historical_replay` weather, `derived` moisture, no ignitions,
`stochastic {enabled: false, seed: 1}`, `liveIncidentId` null, `seed` 1.

## API

| Method | Path | Body / answer |
| --- | --- | --- |
| `GET` | `/api/world/active` | the active world (a default world until one is written) |
| `PATCH` | `/api/world/active` | `{baseRevision, updatedBy, changes: <partial world>}` → the new world; nested objects merge, arrays (`fire.ignitions`, coordinates) and scalars replace, server fields in `changes` are ignored; `409 {error: "revision_conflict", detail, world}` when `baseRevision` is stale (the default world is revision 0) |
| `GET` | `/api/world/scenarios` | `{scenarios: [{id, name, notes, tags, createdAt, updatedBy, region, startUtc, extrasKeys}]}` newest first, at most 200 |
| `POST` | `/api/world/scenarios` | `{name, notes?, tags?, updatedBy?, world, extras?}` → `201` the full scenario; `name` ≤ 120 chars, `notes` ≤ 4 000, `tags` ≤ 20 × 40 chars; `world` is a complete world (validated as above); `extras` is per tab: `{fire?, simulation?, dispatch?, live?}` (e.g. the Studio `StudioScenario`, dispatch orders, the board seed and speed), opaque JSON ≤ 2 MB (`413` above) |
| `GET` | `/api/world/scenarios/<id>` | the full saved scenario: the summary fields plus `world` and `extras` |
| `POST` | `/api/world/scenarios/<id>/load` | `{updatedBy?, baseRevision?}` → `{world, scenario}`: its world becomes the active world as a new revision; with `baseRevision` a stale revision is a `409` as for `PATCH`, without it the load replaces whatever is active |
| `DELETE` | `/api/world/scenarios/<id>` | `{deleted: id}`; `404` when unknown |

Scenario ids look like `scn_<22 hex>`. Errors are `{error, detail}`.

Reads are open. When `LIVE_CONTROLLER_TOKEN` is set, writes need the controller token (as
`/api/live/active`; the Vite dev proxy signs local `/api/world/` calls like `/api/live/`).
Stored in MongoDB: `world_active` (one document, `_id: "active"`) and `world_scenarios` (extras
kept as a JSON string, `extrasJson`). Implementation: `app/backend/api/world.py`.

## Frontend

`app/src/world/`:

- `contracts.ts`: these types (`World`, `WorldChanges`, `Scenario`, …) and `DEFAULT_WORLD`.
- `api.ts`: fetch helpers (`fetchWorld`, `patchWorld`, `listScenarios`, `fetchScenario`,
  `createScenario`, `loadScenario`, `deleteScenario`); errors are `WorldApiError` (`.conflict`,
  `.world` on a 409). Writes send the `/live` console's controller token when one is stored.
- `useWorld()`: one store per browser tab shared by every caller. Polls `GET /api/world/active`
  every 2 s while mounted (paused when the page is hidden) and listens on
  `BroadcastChannel("crisistwin-world")` so tabs in the same browser update at once. Returns
  `{world, loaded, status, error, update(changes, updatedBy), refresh()}`; `status` is
  `loading | ready | saving | error`. `update` applies the change locally at once, then PATCHes
  it; writes are serialised. On a 409 the change is re-applied to the newer world only if that
  revision left the same fields unchanged; otherwise the newer world wins, the change is
  dropped and `error` says so.
- `useScenarios(updatedBy)`: `{scenarios, status, error, refresh, save, load, get, remove}`;
  `load` makes the scenario active, pushes the new world into `useWorld` and resolves to the
  full scenario (with extras).
- `<ScenarioMenu tab getExtras? onLoaded? align? />`: header button with a popover to save the
  current world (name, notes, plus `getExtras()` under the tab's key) and to list, load or
  delete scenarios.
