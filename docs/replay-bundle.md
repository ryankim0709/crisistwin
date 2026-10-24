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
- **`insights`:** computed from the simulation only. `risk_level` comes from
  `lead_time_s` and the share of a zone's vehicles that cleared before modelled fire
  arrival, using the rule in `risk_rule`. The UI shows the disclaimer next to
  insights and never phrases them as directives such as "evacuate now via X".
- **Population conservation:** at every frame,
  `not_departed + en_route + arrived == total_veh`. Blocked and exposed vehicles are
  subsets of en-route vehicles.
