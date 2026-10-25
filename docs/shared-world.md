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

## API

| Method | Path | Body / answer |
| --- | --- | --- |
| `GET` | `/api/world/active` | the active world (a default world until one is written) |
| `PATCH` | `/api/world/active` | `{baseRevision, updatedBy, changes: <partial world>}` → the new world; `409 {world}` when `baseRevision` is stale |
| `GET` | `/api/world/scenarios` | `{scenarios: [{id, name, notes, createdAt, updatedBy, region, startUtc, tags}]}` newest first |
| `POST` | `/api/world/scenarios` | `{name, notes?, tags?, world, extras?}` → `{id, ...}`; `extras` is per tab: `{fire?, simulation?, dispatch?, live?}` (e.g. the Studio `StudioScenario`, dispatch orders, the board seed and speed), opaque JSON ≤ 2 MB |
| `GET` | `/api/world/scenarios/<id>` | the full saved scenario |
| `POST` | `/api/world/scenarios/<id>/load` | makes its world the active world (new revision) and returns it |
| `DELETE` | `/api/world/scenarios/<id>` | removes a saved scenario |

When `LIVE_CONTROLLER_TOKEN` is set, writes need the controller token (as `/api/live/active`).
Stored in MongoDB: `world_active` (one document) and `world_scenarios`.

## Frontend

`app/src/world/`: `contracts.ts` (these types), `api.ts` (fetch helpers), `useWorld()` (polls
`GET /api/world/active` every 2 s and listens on a `BroadcastChannel("crisistwin-world")` so
tabs in the same browser update at once; returns `{world, update(changes), status}`).
