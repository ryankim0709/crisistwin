# Simulation state API (evacuation advice per home)

Simulation Studio publishes its evacuation run to MongoDB Atlas, and pushes the state at
each playback tick. The iOS app reads it back as per-home advice: leave now, leave later,
already left, no order, cut off. Decision: [ADR 0029](adr/0029-simulation-state-for-mobile.md).

**Everything here is simulated.** The homes are synthetic: the dispatch area places them along
residential streets (`api/dispatch_area.py`). Their addresses are synthetic too: the nearest
OSM street name plus a made-up house number. The advice comes from the Studio's fixed
evacuation policy (`app/src/studio/evacuation.ts`). This is a planning experiment, not an
order. Every response carries `evidence_class: "simulated"` and a `notice`, and clients must
show that notice.

Base path `/api/`. Times are UTC ISO 8601 with `Z`. Coordinates are WGS84 `[lon, lat]` in
decimal degrees. `minute` means elapsed simulation minutes from the scenario's T+0, never
wall-clock time. Errors are `{ "error": code, "detail": text }`. Every response sends
`Cache-Control: no-store`. These endpoints need no auth (synthetic data only); throttles and
size limits are below.

## Advice values

The Studio computes a zone's advice at a tick. A home's advice is its zone's advice, except
that a home already out of its house is `left`.

| `advice` | Zone condition at `minute` (engine `ZoneState`) |
| --- | --- |
| `leave_now` | `status == "ordered"`. The order is out and households are leaving. |
| `leave_later` | Not ordered yet, but this run orders the zone later: `order_minute > minute` (from the full run), or the zone is staged for a later wave (`stage != null`). |
| `no_order` | Not ordered, and the run never orders it. |
| `cut_off` | The policy found no reachable exit (`EvacuationPolicyRun.cutOff`). The advice is "no way out by road in this simulation". |
| `cleared` | `status == "cleared"`. Every household is out. Homes show `left`. |
| `overrun` | `status == "overrun"`. The fire reached the zone before it cleared. |
| `left` | **Home only:** this household has departed (rank-in-zone < `departed`). |

The dispatch area lists a zone's homes in departure order. A home's `rank` is its index minus
the zone's `firstHome`. At a tick, `departed = zone.homes - zone.atHome`. Homes with
`rank < departed` are `left`. The rest take the zone advice. `cleared` gives `left` for every
home.

Zone ids are the dispatch area's own zone ids (`Zone.id`, for example `Z03`).

## Endpoints

| Method and path | Purpose |
| --- | --- |
| `POST sim-state/runs` | Publish a run: zones and homes. The run becomes the latest. Returns `201 { run_id }`. |
| `POST sim-state/runs/{run_id}/tick` | Push the state at one minute. Returns `200 { run_id, minute, changed_zones }`, where `changed_zones` is a count. |
| `GET sim-state/latest` | Metadata of the latest run, its current minute and the per-zone state (no homes). |
| `GET sim-state/advice?lon=&lat=` | Advice for the home nearest the point (within 300 m) in the latest run. |
| `GET sim-state/advice?home_id=` | Advice for one home of the latest run. |
| `GET sim-state/homes?q=&limit=` | Search the latest run's homes by address substring (case-insensitive, `q` at least 2 chars, `limit` 1-50, default 20). Returns `{ homes: [HomeAdvice] }`. |

### `POST sim-state/runs`

```jsonc
{
  "label": "Studio run · Paradise ridge · order at T+15",  // <= 120 chars
  "area": { "id": "osm-…", "name": "Paradise", "bbox": [-121.7, 39.7, -121.5, 39.8] },
  "horizon_minutes": 360,
  "order_minute": 15,
  "zones": [
    { "zone_id": "Z03", "name": "Zone 3", "centroid": [-121.61, 39.76], "homes": 412 }
  ],
  "homes": [
    // home_id unique in the run; rank is the departure order within the zone, starting at 0
    { "home_id": "h0", "zone_id": "Z03", "rank": 0, "coord": [-121.6102, 39.7611],
      "address": "1482 Pentz Rd" }
  ]
}
```

Limits: at most 500 zones and 25,000 homes, and a body of at most 8 MB. Every home's `zone_id`
must be a listed zone, and `address` must be a non-empty string of at most 120 characters. Each zone's ranks must be `0..homes-1`. Coordinates must be finite and
in range. A failed check returns `400 invalid_run`. The server keeps the 3 most recent runs and
deletes older runs and their homes.

### `POST sim-state/runs/{run_id}/tick`

```jsonc
{
  "minute": 47,                       // integer 0..horizon_minutes
  "zones": [                          // every zone, or only those changed since the last tick
    { "zone_id": "Z03", "advice": "leave_now", "order_minute": 15, "departed": 120,
      "at_home": 292, "exit_id": "exit-skyway" }   // order_minute and exit_id may be null
  ]
}
```

`zones` may be empty: the tick then only moves `minute` and `updated_at`. Every `zone_id` must
be a zone of the run. The server stores the tick in the run's state. It updates `sim_homes` only for zones whose
`(advice, order_minute, departed)` changed. The playback can move backward, so `minute` may go
down: the state always reflects the latest tick received. An unknown run returns
`404 unknown_run`. A bad body returns `400 invalid_tick`. Clients send at most about one tick per
second (throttle 120/min per IP).

### `GET sim-state/latest`

```jsonc
{
  "evidence_class": "simulated",
  "notice": "Simulated evacuation (planning exercise). Homes and addresses are synthetic. This is not an evacuation order.",
  "run": { "run_id": "…", "label": "…", "area": { … }, "published_at": "…Z",
           "horizon_minutes": 360, "order_minute": 15, "zone_count": 41, "home_count": 9876 },
  "minute": 47,                 // null before the first tick
  "updated_at": "…Z",           // server time of the last tick
  "zones": [ { "zone_id": "Z03", "name": "Zone 3", "centroid": [..], "homes": 412,
               "advice": "leave_now", "order_minute": 15, "departed": 120, "at_home": 292,
               "exit_id": "exit-skyway" } ]
}
```

With no published run, the response is `404 no_simulation`.

### `GET sim-state/advice`

```jsonc
{
  "evidence_class": "simulated",
  "notice": "…same as above…",
  "run": { "run_id": "…", "label": "…", "published_at": "…Z", "horizon_minutes": 360 },
  "minute": 47,
  "updated_at": "…Z",
  "home": { "home_id": "h0", "address": "1482 Pentz Rd", "coord": [-121.6102, 39.7611],
            "zone_id": "Z03", "zone_name": "Zone 3",
            "distance_m": 38.2 },          // only for lon/lat queries
  "advice": "leave_now",                   // see table; "unknown" before the first tick
  "order_minute": 15,                      // null when the run never orders the zone
  "minutes_until_order": null,             // order_minute - minute when > 0, else null
  "exit_id": "exit-skyway"
}
```

`HomeAdvice` in `homes` search results is the `home` object plus `advice`, `order_minute` and
`exit_id`.

Errors: `400 invalid_query`, `404 no_simulation`, `404 no_home_nearby` (nothing within 300 m),
`404 unknown_home`, `503 database_unavailable`.

## Documents (MongoDB, database `MONGODB_DATABASE`)

- `sim_runs`: `{ run_id, label, area, horizon_minutes, order_minute, zones: [ {zone_id, name,
  centroid, homes} ], home_count, published_at, state: { minute, updated_at, zones: { <zone_id>:
  {advice, order_minute, departed, at_home, exit_id} } }, evidence_class: "simulated" }`.
  Index `published_at` desc. The latest run is the one with the newest `published_at`.
- `sim_homes`: `{ run_id, home_id, zone_id, rank, address, address_lc, location: { type: "Point",
  coordinates: [lon, lat] }, advice, order_minute, exit_id }`. Indexes: unique
  `(run_id, home_id)`, `(run_id, zone_id, rank)`, 2dsphere `location`, `(run_id, address_lc)`.
