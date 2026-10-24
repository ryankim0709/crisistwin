# Plan API: command a branch of the replay (v1, draft)

The web app's command mode lets a user pause the Camp replay, queue commands, and run
a **simulated branch**. The branch is the historical baseline plus the user's
commands, re-run from the replay start with the same seed, inputs and model
versions, so everything before the first command matches the baseline exactly. A
branch result is a variant document (see "Variants" in
[replay-bundle.md](replay-bundle.md)) and is always `evidence_class: "simulated"`.

Base path: `/api/sim/`. The JSON bodies use UTC ISO 8601 times with `Z`.

## `GET /api/sim/catalog?incident=camp-2018`

Everything the UI needs to offer commands:

```jsonc
{
  "incident": "camp-2018",
  "baseline": "camp-2018.json",          // bundle the branch is compared with
  "clock": { "start": "...Z", "end": "...Z" },
  "cards": [                             // command types, with named limits
    { "type": "order_zone", "label": "Order evacuation", "target": "zone",
      "description": "...", "limit": { "kind": "rate", "per_minutes": 5, "count": 1 } },
    { "type": "contraflow", "label": "Start contraflow", "target": "road",
      "limit": { "kind": "concurrent", "count": 2, "note": "CHP units" } }
  ],
  "zones": [ { "id": "...", "name": "...", "centroid": [lon, lat] } ],
  "roads": [ { "name": "Skyway", "edge_count": 30, "bbox": [w, s, e, n] } ],   // commandable roads
  "refuges": [ { "id": "...", "name": "...", "coord": [lon, lat] } ]
}
```

Command types: `order_zone`, `warn_zone`, `close_road`, `reopen_road`, `contraflow`,
`hold_inbound` and `open_refuge`. The server validates every command against the
catalog and its limits; the UI shows each card's limit but never relies on it.

## `POST /api/sim/plans` returns `202 { "job_id": "..." }`

```jsonc
{ "incident": "camp-2018",
  "commands": [
    { "id": "c1", "type": "order_zone", "at": "2018-11-08T15:20:00Z", "target": { "zone_id": "..." } },
    { "id": "c2", "type": "contraflow", "at": "2018-11-08T16:10:00Z", "target": { "road_name": "Clark Road" } }
  ] }
```

Errors: `400 { "error": "invalid_command", "detail": "...", "command_id": "c2" }`,
`429` when too many jobs are running, `503` when the simulator is unavailable.

## `GET /api/sim/plans/{job_id}`

`{ "status": "queued|running|done|error", "progress": 0.0-1.0, "stage": "...",
"error": null, "result_url": "/api/sim/plans/{job_id}/result" }`

Clients poll about once a second with an `AbortController`; a stale job must never
replace a newer one in the UI.

## `GET /api/sim/plans/{job_id}/result`

A `crisistwin_variant` document with `variant.id = "plan-{job_id}"`, `variant.title =
"Your plan"`, `variant.changes` listing each accepted command in words, the comparison
against the baseline, and a `postmortem` block for the branch (see the Postmortem
section of replay-bundle.md when it lands).

## Invariants

- The same seed, clock, network, demand, destinations and model versions as the
  baseline, asserted per run.
- Commands become `TrafficEvent`s labelled e.g. "Your command (simulated): order Zone
  14". They never change historical events, which stay in the run unchanged.
- Results are planning experiments, not operational instructions.
