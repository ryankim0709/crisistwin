# Replay bundle contract (v1)

A replay bundle is one JSON file. `python3 -m sim ... bundle` generates it from a verified
incident package, and the app's replay view animates it. It is a derived, rebuildable
artifact, not historical evidence. Version: `schema_version: "1.0.0"`. Changes stay
additive within 1.x.

## Conventions

- Coordinates are `[longitude, latitude]` in OGC:CRS84. Times are UTC ISO 8601 with `Z`.
- Units are part of field names: `_m`, `_kph`, `_km2`, `_veh`, `_veh_per_hour`, `_s`.
- Every layer, event and series has an `evidence_class`:
  - `observed`: measured, or an official record.
  - `reported`: a news or official statement.
  - `reconstructed`: an expert or satellite reconstruction, such as FEDS or NIST.
  - `derived`: a deterministic transform of the evidence.
  - `simulated`: CrisisTwin model output.
  - `fixture`: synthetic stand-in data that is not historical.
- The UI must show the class in text or with a pattern, not by color alone, and must
  label fixtures prominently.
- A layer's `evidence_class` may be `"mixed"` only when each of its features carries
  its own `evidence_class`; destinations do this (exits `derived`, NIST refuges and
  shelters `reconstructed`).
- Missing layers are present with `status: "missing"` and a `reason`. They are never
  silently empty.

## Shape

```jsonc
{
  "kind": "crisistwin_replay_bundle",
  "schema_version": "1.0.0",
  "generated_by": { "sim_version": "0.1.0", "command": "..." },
  "incident": { "id": "camp-2018-paradise-slice", "name": "Camp Fire (2018)",
                "package_version": "a6d2cc03f525ed65", "timezone": "America/Los_Angeles" },
  "mode": "retrospective",            // evidence shown at occurrence time, not when known
  "clock": { "start": "2018-11-08T14:00:00Z", "end": "2018-11-09T08:00:00Z", "step_seconds": 60 },
  "bbox": [-121.9, 39.55, -121.4, 39.95],
  "layer_status": {                   // one entry per layer below
    "roads": { "status": "present|fixture|missing", "evidence_class": "fixture", "reason": null }
  },
  "assumptions": ["..."], "limitations": ["..."],

  "fire": {
    "perimeters": [                   // ascending by at; each applies until the next
      { "snapshot_index": 0, "at": "...Z", "area_km2": 165.7, "evidence_class": "reconstructed",
        "time_precision": "half_day", "geometry": { "type": "MultiPolygon", "coordinates": [] } }
    ]
  },

  "roads": {
    "evidence_class": "fixture",
    "edges": [                        // directed; a two-way road is two edges sharing segment_id
      { "id": "e12", "segment_id": "s6", "from_node": "n3", "to_node": "n4",
        "name": "Corridor W", "highway": "primary", "lanes": 1, "speed_kph": 72,
        "capacity_veh_per_hour": 1800, "length_m": 950.0, "bridge": false,
        "coords": [[-121.6, 39.76], [-121.61, 39.75]] }
    ]
  },
  "zones": { "evidence_class": "fixture",
    "features": [ { "id": "z1", "name": "Zone 1", "households": 1200, "vehicles": 1900,
                    "geometry": { "type": "Polygon", "coordinates": [] } } ] },
  "destinations": { "evidence_class": "fixture",
    "features": [ { "id": "d1", "name": "Exit SW", "kind": "exit|shelter|temporary_refuge",
                    "coord": [-121.75, 39.7], "capacity_veh": null } ] },

  "events": [                         // ascending by at
    { "id": "ev1", "at": "...Z", "type": "evacuation_order", "label": "Evacuation order: Zone 1",
      "evidence_class": "fixture", "time_precision": "minute",
      "target": { "zone_ids": ["z1"], "edge_ids": [], "destination_id": null },
      "source": { "id": "fixture", "locator": null } }
  ],

  "traffic": {
    "evidence_class": "simulated",
    "model": { "id": "...", "version": "...", "params": {}, "seed": 7 },
    "edge_ids": ["e12", "..."],       // frames index into this array
    "frames": [                       // one per clock step; sparse: only edges holding vehicles
      { "at": "...Z",
        "edges": [[0, 42, 18.5]] }    // [edge_index, vehicles_on_edge, mean_speed_kph]
    ],
    "closures": [[3, 12, 40], [7, 15, null]],  // [edge_index, first_closed_frame, reopened_frame | null]
    "metrics": [                      // one per frame, same order
      { "at": "...Z", "not_departed_veh": 0, "en_route_veh": 0, "arrived_veh": 0,
        "blocked_veh": 0, "exposed_veh": 0 }
    ],
    "summary": { "total_veh": 0, "clearance_time_s": null, "max_exposed_veh": 0 }
  },

  "damage": { "evidence_class": "observed", "temporal_role": "postfire_assessment",
              "features": [] },     // GeoJSON Point features; no damage time

  // Optional. Simulated fire front from an assumed ignition, fitted to the first observed perimeter.
  "fire_simulated": {
    "evidence_class": "simulated",
    "model": { "id": "elliptical-mtt-ca", "version": "0.1.0", "params": {} },
    "ignition": { "coord": [-121.434, 39.813], "at": "...Z", "provenance": "assumed: ..." },
    "calibration": { "target_snapshot_at": "...Z", "iou": 0.69, "area_ratio": 1.29 },
    "fronts": [ { "at": "...Z", "area_km2": 12.3, "geometry": { "type": "MultiPolygon" } } ],
    "arrival_grid": {               // for "time until fire reaches this point" lookups
      "origin_lon": 0, "origin_lat": 0, "cell_m": 200, "ncols": 0, "nrows": 0,
      "m_per_deg_lon": 0, "m_per_deg_lat": 0,  // col = floor((lon-origin_lon)*m_per_deg_lon/cell_m), row likewise; row 0 south
      "t0": "...Z", "minutes": [12, null]       // row-major minutes after t0; null = not reached in run
    },
    "assumptions": ["..."]
  },
  // fire_simulated with model "rothermel-mtt" (roads package has NIST fire observations) adds, additively:
  //   ignition.provenance_detail: { evidence_class: "reconstructed", time_source: { event_id, occurred_at, ... },
  //                                 place_source: { observation_id: "nist-fireobs:0001", ... } }
  //   model.params: { wind_from_deg, wind_20ft_m_s, moisture, moisture_fractions, fuel_model: "SH5", waf,
  //                   midflame_wind_m_s, spot_distance_m, spot_probability, seed, spotting, spot_rule, ... }
  //   calibration: {
  //     "method": "...", "params_source": "...", "runtime_s": 1.2,
  //     "headline": "median arrival error 104 min on 189 held-out NIST observations (17:00-20:00Z); ...",
  //     "perimeter": { "snapshot_at": "...Z", "iou": 0.38, "area_ratio": 1.41, "n_cells": 4100, "cell_m": 200,
  //                    "role": "evaluation only" },
  //     "observations": { "source": "...", "cutoff": "...Z", "held_out_until": "...Z", "objective": "...",
  //       "train":    { "n": 169, "median_abs_error_min": 26.2, "mean_abs_error_min": 49.1,
  //                     "median_signed_error_min": 0.0, "within_30_min": 0.55, "hit_rate": 0.53, "unreached": 5 },
  //       "held_out": { "n": 189, ... same keys } }
  //   }
  //   terrain: { source_id, source_resolution, vertical_datum, resampling, missing_cells, missing_treatment, ... }

  // Optional. NIST fire observation points (reconstructed), all timed points up to clock.end, not thinned.
  "fire_observations": {
    "evidence_class": "reconstructed",
    "source": { "id": "nist-fire-observations", "label": "...", "url": "https://data.nist.gov/od/id/mds2-2954",
                "license": "...", "publication": "NIST TN 2135 ..." },
    "temporal_role": "fire present at time (not first arrival)",
    "features": [ { "id": "nist-fireobs:0006", "coord": [-121.449305, 39.803302],
                    "at": "...Z", "from": "...Z", "to": "...Z",          // observed_at, observed_from, observed_to
                    "time_precision": "minute|approximate", "residual_fire": false,
                    "location_source": "AVL", "type_of_fire_code": "V",
                    "source_locator": "Concow!7; TD-029" } ],          // workbook sheet!row(s); source number
    "notes": ["..."]
  },

  // Optional. Derived planning insights for responders and evacuees, all from model output.
  "insights": {
    "evidence_class": "simulated",
    "disclaimer": "Planning insight from a simulation; not operational instructions.",
    "zones": [ { "zone_id": "z1", "order_at": "...Z|null", "fire_arrival_at": "...Z|null",
                 "lead_time_s": 5400,          // fire_arrival - order; negative = fire first; null if either missing
                 "vehicles": 1900, "departed_by_fire_veh": 1500, "arrived_by_fire_veh": 900,
                 "last_arrival_at": "...Z|null",
                 "risk_level": "critical|high|elevated|low", "risk_rule": "..." } ],
    "edge_fire_arrival_s": [3600, null],      // aligned to traffic.edge_ids; seconds after clock.start
    "bottlenecks": [ { "edge_id": "e12", "name": "...", "peak_veh": 120, "peak_at": "...Z",
                       "min_speed_kph": 4.0, "minutes_congested": 95 } ],
    "destinations": [ { "destination_id": "d1", "arrived_veh": 4000, "capacity_veh": null, "full_at": null } ],
    "headline": [ { "label": "Peak vehicles exposed to fire", "value": 120, "unit": "veh", "at": "...Z" } ]
  }
}
```

## Semantics

- **Perimeters:** a perimeter applies from its `at` until the next snapshot. The UI
  may fade the age visually but must not draw interpolated shapes as evidence.
- **Events:** each event is shown at `at`. `available_at` (when known) is not used in
  `retrospective` mode.
- **Closures:** `traffic.closures` holds one interval per closure, whether from an
  event or from modelled fire hazard. An edge is closed at frame `k` when
  `first_closed_frame <= k < reopened_frame`, where `null` means it never reopens. Fire-driven closure events carry `evidence_class: "simulated"`.
- **`exposed_veh`:** vehicles on edges whose midpoint lies inside the fire area in
  effect at that time.
- **`blocked_veh`:** vehicles that cannot move because their edge or every route onward
  is closed.
- **`clearance_time_s`:** time from the first evacuation order until the last vehicle
  arrives. It is `null` if some vehicles never arrive.
- **Vehicle particles:** the UI may animate particles along an edge in proportion to
  `vehicles_on_edge`, moving at `mean_speed_kph`. They illustrate modelled counts and
  are not tracked vehicles.
- **`fire_simulated`:** a model run shown as a separate, toggleable layer. It is never
  styled like observed perimeters. When present, the traffic hazard (closures and
  exposure) uses the simulated front until the first observed perimeter, then the
  observed one. `layer_status.fire_simulated` records this.
- **`fire_simulated.calibration` (rothermel-mtt):** params are chosen only by arrival error at
  NIST observations before `observations.cutoff`; `held_out` (cutoff to the first perimeter) and
  `perimeter` IoU are evaluation, not fit. Error is 0 when the modelled arrival lies in
  `[from, to]`, else minutes to the nearer edge; `hit_rate` is the share where modelled fire had
  arrived by `to`. Show the held-out error and IoU next to the front, not only the train error.
- **`fire_observations`:** each point means fire was seen there during `[from, to]` (UI: "fire
  observed here at 08:05 (NIST)"); it is not a first-arrival time and never drawn as a perimeter.
  `layer_status.fire_observations` is `missing` when the roads package lacks the layer.
- **`insights`:** computed from the simulation only. `risk_level` comes from
  `lead_time_s` and the share of a zone's vehicles that cleared before modelled fire
  arrival, using the rule in `risk_rule`. The UI shows the disclaimer next to
  insights and never phrases them as directives such as "evacuate now via X".
- **Population conservation:** at every frame,
  `not_departed + en_route + arrived == total_veh`. Blocked and exposed vehicles are
  subsets of en-route vehicles.

## Multiple incidents (`--incident`)

`python3 -m sim --incident <id> bundle` builds `app/public/replays/<id>.json` for an id in
`sim/incidents.py` (`camp-2018`, `marshall-2021`, `kincade-2019`), and writes or updates
`app/public/replays/index.json`. These fields are additive:

- `incident.registry_id`, `incident.place`: from the registry. `incident.timezone` is the
  package manifest's `time_zone` (IANA) when it has one, otherwise `America/Los_Angeles`.
- `generated_by.verification` (non-Camp packages only): how the package was verified on this run.
  The builder's offline rebuild runs once per manifest, and its result is cached by manifest
  SHA-256. Every run re-checks all artifact hashes.
- `demand` (non-Camp packages): `totals` (`zones`, `population`, `households`,
  `households_no_vehicle`, `evacuating_vehicles`, `orders_mapped`, `warnings_mapped`, ...),
  `unmapped_zones` (`zone_id`, `reason`), `crosswalk_derived_here` (zones whose block-group
  shares sim derived by raster overlap), `orders_without_zone_ids` (timeline only), `notices` (`event_id`, `zone_ids`,
  `unmapped_zone_ids`), and per-zone `zones`. Demand zones are the package's evacuation zones,
  and order and warning events target them by their own zone IDs. `totals.block_groups` counts the
  ACS block groups that contribute; `population_source` names the ACS vintage. With a registry
  evidence file (`sim/evidence/<id>.json`), `orders_from_evidence` lists cited orders added to the
  package's (`event_id` prefix `evidence:`, with `evidence_class`, `source_id`, `zone_mapping`), and
  `zone_splits` lists zones split at a Census place boundary (`zone_id`, `derived_from`, `place`,
  `inside`). Notices naming a split zone then name all of its parts.
- `validation` (non-Camp packages): one row per `calibration_targets.json` target, with
  `comparability: "not_computed"` and the reason; `next_work` lists the missing comparisons.
- `fire_simulated` for non-Camp packages is `elliptical-mtt-ca`. It starts from the package
  ignition (`ignition.provenance` gives the source), is fitted by IoU to the first perimeter
  only, and is clipped to it (`constraint`). `calibration.headline` states its limits.
- `fire_simulated` with a registry evidence file holding timed fire reports (Marshall) is fitted to
  them instead: `ignition.provenance_detail` lists the documented ignitions; `calibration.observations`
  has `fit` (window errors at reported first arrivals, same keys as Camp's `train`), `vs_reported_time`,
  `leave_one_out`, `bounds` ("fire present by" sightings and FIRMS passes, evaluation only),
  `as_replayed` (scores of the clipped front) and per-place `points` (`reported_at`, `window_utc`,
  `model_at`, `model_at_as_replayed`, `error_vs_reported_min`, `source_id`, `source_locator`).
  `calibration.iou` is the shape IoU with the final perimeter (model burned area when it first equals
  the perimeter's area); `calibration.perimeter` also gives the unclipped IoU at the reported end of
  spread. The front is clipped to the final perimeter (`constraint.kind`
  `clipped_to_final_satellite_perimeter`). `hazard_until` (UTC) is when the observed perimeters take
  over from the simulated front as the traffic hazard; without it they take over at the first
  perimeter time.

### `index.json`

```json
{
  "kind": "crisistwin_replay_index", "schema_version": "1.0.0",
  "incidents": [
    { "id": "marshall-2021", "name": "Marshall Fire (2021)", "place": "Superior and Louisville, ...",
      "date": "2021-12-30", "timezone": "America/Denver", "bundle": "marshall-2021.json",
      "package_version": "415166c55516b100",
      "clock": { "start": "...Z", "end": "...Z", "step_seconds": 60 },
      "layer_status": { "fire_perimeters": "present", "damage": "missing", "...": "..." } }
  ]
}
```

`date` is the local date (in `timezone`) of the clock start. `bundle` is relative to the
index. Entries are kept per `id` across builds, in registry order.

## Variants

Precomputed what-if (counterfactual) runs of the baseline bundle. Generator:
`python3 -m sim.variants` (see `sim/variants.py` for the full command). Each variant is a
pure transformation of the baseline inputs and runs through the same `build_bundle` path.
Seed, clock, network, demand, destinations, fire ignition and model versions are asserted
equal to the baseline (`basis`). The only differences are listed in `variant.changes`. All
variant output is `simulated`. Variants are counterfactual planning experiments and must
be labelled as such, never as history.

Files sit next to the baseline: `<baseline stem>.variants/index.json` and
`<baseline stem>.variants/<id>.json`, for example `camp-2018.variants/all-at-once.json`. A
variant does not repeat roads, zones, destinations, perimeters or damage: the UI takes
them from the bundle named in `baseline`, and `traffic.edge_ids` uses the same order as
the baseline `traffic.edge_ids`.

### Index

```jsonc
{
  "kind": "crisistwin_variant_index", "schema_version": "1.0.0", "baseline": "camp-2018.json",
  "generated_by": { "sim_version": "0.1.0", "command": "..." },
  "basis": { "seed": 7, "clock": { "start": "...Z", "end": "...Z", "step_s": 10, "record_every_s": 60 },
             "network": { "edges": 0, "nodes": 0, "sha": "..." }, "demand": { "zones": 51, "total_veh": 15000, "sha": "..." },
             "destinations_sha": "...", "models": { "sim": "0.1.0", "traffic": "meso-link-queue@0.1.0",
             "fire": "elliptical-mtt-ca@0.1.0" }, "fire_ignition": { } },
  "baseline_metrics": { /* same keys as comparison.metrics, baseline values only */ },
  "variants": [
    { "id": "all-at-once", "title": "...", "question": "...", "evidence_class": "simulated",
      "file": "all-at-once.json", "changes": ["..."], "runtime_s": 6.7, "bytes": 3861532,
      "headline": { "arrived_by_1800z_veh": { "baseline": 5527, "variant": 12363, "delta": 6836 },
                    "peak_exposed_veh": {}, "total_exposed_veh_min": {}, "peak_blocked_veh": {}, "clearance_time_s": {} },
      "zone_risk_changed": 23, "fire_changed": false }
  ],
  "skipped": [ { "id": "no-contraflow", "title": "...", "question": "...", "reason": "..." } ],
  "limitations": ["..."]
}
```

### Variant file

```jsonc
{
  "kind": "crisistwin_variant", "schema_version": "1.0.0", "baseline": "camp-2018.json",
  "generated_by": { "sim_version": "0.1.0", "command": "..." },
  "variant": { "id": "skyway-closed-0800", "title": "...", "question": "...", "changes": ["..."],
               "evidence_class": "simulated",
               "details": { } },          // variant-specific record, e.g. selected edge ids, optimizer report
  "basis": { },                         // identical to index.basis
  "clock": { },                         // identical to the baseline clock
  "traffic": { },                       // same shape as bundle.traffic, including closures
  "events": [ ],                        // full event list for this run, same shape as bundle.events
  "insights": { },                      // same shape as bundle.insights
  "fire_simulated": { },                // only when the variant changes the simulated front; else use the baseline's
  "comparison": {
    "evidence_class": "simulated",
    "metrics": {                        // each { "baseline": n|null, "variant": n|null, "delta": variant-baseline|null }
      "arrived_by_1700z_veh": {}, "arrived_by_1800z_veh": {}, "arrived_by_2000z_veh": {},
      "arrived_at_end_veh": {}, "peak_en_route_veh": {}, "peak_blocked_veh": {}, "peak_exposed_veh": {},
      "exposed_veh_min": {}, "peak_exposed_at_origin_veh": {}, "exposed_at_origin_veh_min": {},
      "total_exposed_veh_min": {}, "blocked_at_end_veh": {}, "clearance_time_s": {}
    },
    "clearance_note": "...", "exposed_veh_min_rule": "...",
    "zone_risk_changed": [ { "zone_id": "fz3", "baseline": "high", "variant": "low" } ],
    "zone_risk_counts": { "baseline": { "critical": 0, "high": 0, "elevated": 0, "low": 0 }, "variant": {} }
  },
  "checks": { "population_conserved": true, "frames_checked": 1081, "total_veh": 15000 },
  "limitations": ["..."]
}
```

### Semantics

- **Metrics:** `arrived_by_HHMMz_veh` is `arrived_veh` in the metrics frame at that UTC
  time. `exposed_veh_min` is the sum of `exposed_veh` over frames multiplied by the frame
  interval in minutes (vehicles on roads). `exposed_at_origin_veh_min` does the same for
  `exposed_at_origin_veh` (vehicles not yet departed whose origin is inside the fire area).
  `total_exposed_veh_min` is their sum and is the headline exposure figure: a variant
  that delays departures moves exposure from roads to homes, so comparing
  `exposed_veh_min` on its own is misleading. `clearance_time_s` is `null` when some vehicles never arrive, and
  `delta` is then `null`. Lower is better for exposure, blocked counts and clearance;
  higher is better for arrivals. The UI shows the sign and the unit in text.
- **Precision:** there is one seed and fixture demand. Show deltas as whole vehicles or
  minutes, and do not present small deltas as significant.
- **Changed orders:** in `optimized`, the fixture `evacuation_order` events are replaced
  by `optimized-order-<zone>` events with `evidence_class: "simulated"` (a plan, not a
  record). The UI must show `variant.changes`, which include the optimizer's hindsight
  limitation and verdict, wherever it shows this variant.
- **Added events:** counterfactual events such as `variant-skyway-closed` carry
  `evidence_class: "simulated"` and `source.id: "variant:<id>"`.
- **Fire:** when `fire_simulated` is absent, the variant used the baseline front. When it
  is present (`wind-shift`), it is a fixed-parameter front. Its `calibration.iou` reports
  its fit to the first perimeter, with `fixed_params: true`. After the first observed
  perimeter, both runs use the same observed perimeters.
- **Skipped variants** are listed in `index.skipped` with a reason. They are never
  silently absent.
- **Reported closures:** `reported-closures` needs `--intel-events <events.jsonl>`, the output
  of `python3 -m sim.intel export` (planner-confirmed `reported` candidates only; see
  [incident-intel.md](incident-intel.md), section (d)). It snaps `road_closed`, `road_blocked`,
  `road_access_restricted` and `road_reopened` rows with the baseline's road-event rules
  (`sim.events.resolve_road_rows`) and applies them at `occurred_at`. Rows that do not snap,
  or whose edges a baseline closure already closes within 30 min, are listed in
  `details.intel_events` with `status` `unresolved` or `duplicate` and are not applied. The
  added events keep `evidence_class: "reported"`; the variant itself is `simulated`. It is
  skipped when the file is absent or nothing snaps.
