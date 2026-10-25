# Scenario resource snapshots

What each live drill starts with at T+0: households (occupants, vehicles, cars they take, who
needs transport) and fire stations with their engines. One current snapshot per incident, in
MongoDB, built deterministically from the drill and a config file of stated assumptions. The
traffic twin and the simulated responders read it. **Nothing in a snapshot is a real household
or a real engine roster**: households are synthetic points, engine counts and availability are
assumptions; only station locations (OSM, NIST) and the Camp zone totals (ACS) come from public
records. Every value carries its `basis`.

| Part | Where |
| --- | --- |
| Pure builder (stdlib, no Django or network) | `app/backend/livecore/snapshot.py` |
| Assumptions (config) | `tools/snapshot_assumptions.json` |
| Store, API views, twin hook | `app/backend/api/live/snapshots.py` |
| Validators + indexes | `app/backend/api/live/schema.py` (`live_init_db`) |
| Seed command | `python manage.py live_seed_snapshots` |
| Twin demand | `sim/twin.py` `package_inputs(zone_vehicles=)`, `api/live/twin_service.py` |
| Simulated responders | `livecore/apparatus.py` `snapshot_apparatus`, `manage.py live_sim_responders` |

## Setup

```sh
docker exec crisistwin-backend-1 python manage.py live_init_db          # once: collections, validators, indexes
docker exec crisistwin-backend-1 python manage.py live_seed_snapshots   # the 3 live drills
docker exec crisistwin-backend-1 python manage.py live_seed_snapshots --incident studio-f5caaabd2a1e \
    --assumptions /repo/tools/snapshot_assumptions.json                 # one drill, explicit config
```

- `live_init_db` is idempotent. A database user without `collMod` (the team's Atlas user) keeps
  the validators of existing collections and prints `kept validator ...`; new collections get
  theirs at creation, so run `live_init_db` **before** the first seed (an insert creates a
  collection without a validator).
- `live_seed_snapshots` is idempotent and prints, per incident, the totals and six conservation
  checks (`[ok]`/`[FAIL]`; any failure exits non-zero). Default incidents: `camp-2018-drill`,
  `studio-f5caaabd2a1e` (Berkeley Hills), `studio-1dfbd182d416` (Pacific Palisades). On the
  rate-limited Atlas tier writing about 48,000 households takes about 5 minutes.
- Activating a drill (`POST /api/live/active`) builds its snapshot in a background thread when
  it has none. Building a package (`POST /api/live/packages`) does not.
- Config path: `--assumptions PATH`, else `$SCENARIO_SNAPSHOT_ASSUMPTIONS`, else
  `tools/snapshot_assumptions.json`; relative paths are from the repo root (`/repo` in Docker).

Re-seeding is atomic for readers: households and stations are written under a new
`snapshot_id`, then the incident's `scenario_snapshots` document is replaced (the flip), then
the incident's rows of any other `snapshot_id` are deleted. Readers go through the snapshot
document, so they never see a half-written snapshot. A failed run leaves orphan rows that the
next successful run deletes.

**Determinism.** Every draw is seeded by `scenario-snapshot/1|<incident_id>` (plus zone or
station id and purpose), so the same drill and config give the same `household_id`s, counts,
positions, engines and `content_hash` (SHA-256 of households, stations and totals).
`snapshot_id` is `snap_<content_hash[:12]>_<6 random hex>`: the first part repeats across
re-seeds, the suffix is per write.

## Units and conventions

Counts are households, persons (`occupants`) or vehicles; integers, never negative.
Coordinates are WGS84 GeoJSON `[lon, lat]`. Times are UTC ISO 8601 `Z` in the API (BSON dates
in MongoDB). `scenario_time` is the drill's T+0 = where its clock starts by default: Camp
`2018-11-08T15:00:00Z` (`livecore.drill.DEFAULT_REPLAY_START`; the bundle starts at 14:00Z),
a Studio package its `clock.start`.

`basis` on every count: `observed` (public record), `estimated` (derived from a public count),
`synthetic` (a stated assumption), `unknown` (`value: null`; an unknown count is never 0). A
total is `null` when any of its households is unknown; `known_occupants` and
`unknown_occupant_households` then say how much is known. None of the current drills has
unknown values (set `occupants.method` or `vehicles.method` to `"unknown"` to get them).

## MongoDB collections

All three have `$jsonSchema` validators (strict) in `schema.py`.

**`scenario_snapshots`**: one document per incident. Indexes: `incident_id` unique,
`snapshot_id` unique.

| Field | Meaning |
| --- | --- |
| `snapshot_id`, `incident_id`, `version` | `version` is the builder, `scenario-snapshot/1` |
| `scenario_time`, `created_at` | T+0 (drill time) and the write time (wall clock), UTC |
| `content_hash` | determinism check (see above) |
| `label` | drill label + "Resource snapshot: synthetic households and engines; see basis." |
| `sources[]` | `{id, name, url, license}` (url/license may be null) |
| `assumptions` | the effective config for this incident, verbatim (defaults merged with its override) |
| `config` | `{path, sha256}` of the assumptions file used |
| `basis` | `{occupants: [...], vehicles: [...], household_positions, station_locations: [...], engines}` |
| `placement` | zones per position method: `dispatch_area_homes` or `zone_road_nodes` |
| `notes[]` | per-zone fallbacks (e.g. a Camp zone without ACS vehicles) |
| `totals` | see below |
| `zones[]` | per-zone aggregates, see the API |

`totals`: `households`, `occupants` (null if any unknown), `known_occupants`,
`unknown_occupant_households`, `vehicles` (null if any unknown), `unknown_vehicle_households`,
`evacuating_vehicles`, `no_vehicle_households`, `needs_transport_households`,
`needs_transport_occupants`, `stations`, `engines_total`, `engines_available`,
`engines_committed`, `engines_out_of_service`. The builder asserts that each equals the sum of
its parts (households, zones, stations, engines) and that
`engines_total = available + committed + out_of_service`.

**`snapshot_households`**: one document per household. Indexes: `(snapshot_id,
household_id)` unique, `(snapshot_id, zone_id, household_id)`, `(incident_id, snapshot_id)`,
`location` 2dsphere.

```json
{"snapshot_id": "snap_b39858dc0f8c_6f8f05", "incident_id": "studio-f5caaabd2a1e",
 "household_id": "hh_02283b02c5715eff", "zone_id": "Z02",
 "location": {"type": "Point", "coordinates": [-122.291766, 37.898825]},
 "occupants": {"value": 1, "basis": "synthetic"},
 "vehicles": {"value": 0, "basis": "synthetic"},
 "evacuating_vehicles": {"value": 0, "basis": "synthetic"},
 "needs_transport": true}
```

`household_id` = `hh_` + `sha1("<incident>|<zone>|<index>")[:16]`. `evacuating_vehicles <=
vehicles` always. `needs_transport` is `vehicles == 0` (false when vehicles are unknown).

**`snapshot_stations`**: one document per station. Indexes: `(snapshot_id, station_id)`
unique, `(incident_id, snapshot_id)`.

```json
{"snapshot_id": "snap_b39858dc0f8c_6f8f05", "incident_id": "studio-f5caaabd2a1e",
 "station_id": "S01", "name": "Albany Fire Station",
 "location": {"type": "Point", "coordinates": [-122.299049, 37.887533]},
 "basis": "observed", "station_class": "local", "source_id": "osm", "locator": null,
 "engines": [
   {"engine_id": "S01-E1", "kind": "type1_engine", "status_at_start": "available", "basis": "synthetic"},
   {"engine_id": "S01-E2", "kind": "type3_engine", "status_at_start": "committed", "basis": "synthetic"},
   {"engine_id": "S01-E3", "kind": "type3_engine", "status_at_start": "available", "basis": "synthetic"}],
 "engines_total": 3, "engines_available": 2}
```

`kind`: `type1_engine` (structure engine) or `type3_engine` (wildland engine, NWCG typing,
[suppression-data.md](suppression-data.md)). `status_at_start`: `available`, `committed`
(assigned elsewhere at T+0) or `out_of_service`. `basis` of the station is its location's;
engines are always `synthetic`.

## API

Both are live viewer endpoints (any live token, like the other incident GETs; untokened
requests are the controller while `LIVE_CONTROLLER_TOKEN` is unset). The incident must be
served: Camp or the active incident (`404 not_found` otherwise, ADR
[0047-active-incident](adr/0047-active-incident.md)). A served incident without a snapshot is
`404 {"error": "no_snapshot", "detail": "..."}`. `Cache-Control: no-store`.

### `GET /api/live/incidents/<incident_id>/snapshot`

The snapshot document (without `_id`), with `scenario_time` and `created_at` as ISO strings,
plus `stations` (all stations with engines, sorted by `station_id`; no `snapshot_id` or
`incident_id` inside). About 25 kB. Shortened example (Berkeley Hills, values as seeded):

```json
{
  "incident_id": "studio-f5caaabd2a1e",
  "snapshot_id": "snap_b39858dc0f8c_6f8f05",
  "version": "scenario-snapshot/1",
  "scenario_time": "2026-10-24T23:10:00Z",
  "created_at": "2026-10-25T03:03:04Z",
  "content_hash": "b39858dc0f8c…",
  "label": "Drill: simulated Studio fire, Berkeley Hills fire. Not a real incident. Resource snapshot: synthetic households and engines; see basis.",
  "sources": [
    {"id": "osm", "name": "OpenStreetMap fire stations and roads in drill package pkg_f5caaabd2a1e (…)",
     "url": "https://www.openstreetmap.org/copyright", "license": "ODbL 1.0"},
    {"id": "dispatch-area-homes", "name": "Synthetic homes and zones of the dispatch area osm--122.31_37.82_-122.20_37.90 (…)",
     "url": null, "license": null},
    {"id": "snapshot-assumptions", "name": "CrisisTwin snapshot assumptions (tools/snapshot_assumptions.json)",
     "url": null, "license": null}
  ],
  "assumptions": {"occupants": {"method": "distribution", "distribution": {"1": 0.28, "…": 0}, "note": "…"},
                  "vehicles": {"…": 0}, "evacuating_vehicles": {"cap_per_household": 2, "note": "…"},
                  "needs_transport": {"…": 0}, "positions": {"…": 0}, "engines": {"…": 0}, "extra_stations": []},
  "config": {"path": "/repo/tools/snapshot_assumptions.json", "sha256": "…"},
  "basis": {"occupants": ["synthetic"], "vehicles": ["synthetic"], "household_positions": "synthetic",
            "station_locations": ["observed"], "engines": "synthetic"},
  "placement": {"dispatch_area_homes": 56},
  "notes": ["home points: dispatch area dispatch-area/4:-122.31,37.82,-122.20,37.90 homes"],
  "totals": {"households": 19882, "occupants": 49112, "known_occupants": 49112, "unknown_occupant_households": 0,
             "vehicles": 31810, "unknown_vehicle_households": 0, "evacuating_vehicles": 28233,
             "no_vehicle_households": 1586, "needs_transport_households": 1586, "needs_transport_occupants": 3862,
             "stations": 16, "engines_total": 33, "engines_available": 25, "engines_committed": 6,
             "engines_out_of_service": 2},
  "zones": [
    {"zone_id": "Z02", "name": "Z02 · near Thousand Oaks", "households": 218, "occupants": 539,
     "known_occupants": 539, "unknown_households": 0, "vehicles": 349, "evacuating_vehicles": 309,
     "needs_transport_households": 17, "needs_transport_occupants": 40, "drill_vehicles": 349}
  ],
  "stations": [
    {"station_id": "S02", "name": "Berkeley Fire Department James Austin Fire Station Number 6",
     "location": {"type": "Point", "coordinates": [-122.296776, 37.874899]}, "basis": "observed",
     "station_class": "local", "source_id": "osm", "locator": null,
     "engines": [{"engine_id": "S02-E1", "kind": "type1_engine", "status_at_start": "committed", "basis": "synthetic"}],
     "engines_total": 1, "engines_available": 0}
  ]
}
```

`zones[]` (one per drill zone, in drill order): `zone_id`, `name`, `households`, `occupants`
(null if any household's is unknown), `known_occupants`, `unknown_households` (households with
unknown occupants), `vehicles` (null if any unknown), `evacuating_vehicles`,
`needs_transport_households`, `needs_transport_occupants`, `drill_vehicles` (the zone's
`vehicles` in the drill file, for comparison: package homes x 1.6, Camp the bundle's
evacuating vehicles).

### `GET /api/live/incidents/<incident_id>/snapshot/households?zone_id=&limit=&after=`

Raw households for inspection, sorted by `household_id`. `zone_id` optional filter; `limit`
1..2000 (default 500; `400 invalid_request` outside); `after` = the last `household_id` of the
previous page. Response: `{incident_id, snapshot_id, zone_id, households: [household without
snapshot_id/incident_id], next}`; `next` is the cursor for the following page or null.

## Sources: real vs synthetic

| Drill | Real (observed / estimated) | Synthetic |
| --- | --- | --- |
| Camp (`camp-2018-drill`) | zone households, carless households, vehicles available, population per 2018 block group: ACS 2014-2018 5-year (B25044, B01001) via the replay bundle `demand.zones` (estimated per household); two station locations from NIST TN 2252 supplement, Appendix I (Paradise Fire Station 81, TRA-L; Station 82, TRA-O; observed) | household split within a zone, household points, four stations at the approximate Chico points `livecore.responders_sim.DEFAULT_STATIONS` (the CAL FIRE bases file `tools/ca_fire_bases.json` is local-only and absent), all engines |
| Berkeley Hills, Palisades (packages) | station locations: OpenStreetMap fire stations in the package (observed, ODbL) | homes and zones (dispatch area builder: every ~40 m along residential streets, `vehicles = round(homes x 1.6)`), occupants, vehicles per household, all engines |

No identifiable resident data: household points are the dispatch area's synthetic home points
or a seeded road node inside the zone, never addresses or buildings.

## Assumptions and config knobs (`tools/snapshot_assumptions.json`)

`defaults` apply to every incident; `incidents.<id>` overrides key by key (objects merge,
lists and scalars replace). Each block's `note` is stored with the snapshot.

| Knob | Default | Camp override | Effect |
| --- | --- | --- | --- |
| `occupants.method` | `distribution` (synthetic) | `acs_zone_population` (estimated) | `distribution`: persons per household apportioned per zone from `occupants.distribution` by largest remainder, then shuffled. `acs_zone_population`: the same, then adjusted one person at a time (seeded) so the zone sums to the ACS `population_in_extract` (includes group quarters). `unknown`: all null |
| `occupants.distribution` | 1: 0.28, 2: 0.34, 3: 0.15, 4: 0.13, 5: 0.06, 6: 0.04 | (same) | ASSUMPTION: close to the US national shape (about 2.5 persons per household), not sourced in the repo or area-specific |
| `vehicles.method` | `distribution` (synthetic) | `acs_zone` (estimated) | `acs_zone`: carless = ACS `households_no_vehicle_in_extract`; one-vehicle households `n1 = 2(H - carless) - evacuating_vehicles` so that `sum(min(v, 2))` equals the bundle's `evacuating_vehicles` exactly; the rest hold 2 plus extra vehicles up to ACS `vehicles_available_total` scaled to the extract (`x households_in_extract / households`); 8 zones without that total use the pooled Camp ratio (0.577 extra vehicles per 2+ vehicle household). `unknown`: all null |
| `vehicles.distribution` | 0: 0.08, 1: 0.37, 2: 0.39, 3: 0.12, 4: 0.04 | (unused) | ASSUMPTION: share of households by vehicles (mean 1.67) |
| `vehicles.match_zone_vehicles` | true | (unused) | nudge 2+ vehicle households (never who is carless) so each zone sums to the package zone `vehicles` |
| `evacuating_vehicles.cap_per_household` | 2 | (same) | `evacuating = min(vehicles, cap)`; Camp's `vehicles_taken_cap` and [people-data.md](people-data.md) (Wong et al.: 1.52-1.65 used when capped at 2) |
| `needs_transport.rule` | `vehicles == 0` | (same) | documentation of the rule; carless households stay with their occupants (population conserved) and add no vehicle |
| `positions.jitter_m` | 25 | (same) | road-node placement: a seeded road node inside the zone, moved up to this many metres; packages use the dispatch area's home points when MongoDB still caches the exact area build (same builder, bbox and `generatedAt`) and the zone's point count matches |
| `engines.state_name_patterns` | CAL FIRE, CALFIRE, CDF | (same) | an OSM station whose name matches is a state station |
| `engines.state_station` | Type 3, 2-3 engines | (same) | engines at state stations (Camp's synthetic stations are `class: state`) |
| `engines.local_station` | Type 1 then Type 3, 1-3 engines | (same) | first engine a Type 1 structure engine, the rest Type 3 |
| `engines.status_shares` | committed 0.25, out of service 0.08 | (same) | each engine's T+0 status from `sha1(incident|engine)` |
| `engines.guarantee` | 1 zero-available station, 2 multi-engine stations, 1 available engine | (same) | see below |
| `extra_stations[]` | none | ST81, ST82 (NIST, observed), SYN1-SYN4 (synthetic) | stations added to the drill's own; `{id, name, coord [lon, lat], basis, class, source_id?, locator?}` |

**Engine count** per station = `min + (sha1(incident|station|count) mod (max - min + 1))`.
**Guarantees** (with two or more stations): (1) if fewer than
`zero_available_stations` stations start with no available engine, the stations with the
lowest `sha1(incident|station|zero)` get every engine committed; (2) if fewer than
`multi_engine_stations` stations hold two or more engines, the lowest
`sha1(incident|station|multi)` ones (non-zero stations first) get one more engine; (3) at
least `min_available_engines` engines start available. All three drills show both cases (see
Verification).

Population is conserved: every zone's households are all present, occupants of carless
households are counted (`needs_transport_occupants`), and nobody is dropped.

## Consumers

**Traffic twin** (packages): `twin_service.build_package_inputs` passes the snapshot's
`evacuating_vehicles` per zone to `sim.twin.package_inputs(zone_vehicles=)`, which replaces
`homes x 1.6` per zone; vehicles still start at the zone's road nodes, and the twin's
`totals.total_veh` equals the snapshot's `evacuating_vehicles` (Berkeley: 28,233, was 31,810).
It reads the stored snapshot, else builds one in memory with the default config (same
numbers, deterministic), else keeps the package demand. The twin's `limitations` say which.
The twin is built once per process: restart the backend after re-seeding with a different
config. **Camp** keeps its historical inputs (`camp_inputs`); its demand is already the
bundle's `evacuating_vehicles`, which the Camp snapshot reproduces exactly (31,638 =
twin `total_veh`).

**Simulated responders** (`live_sim_responders`): with a snapshot, one unit per engine
`available` at T+0 across all stations, `engine_id` as the unit id, the station point (snapped
to the nearest road node) as its home, nearest the fire first; `type3_engine` drives as
`engine_t3`, `type1_engine` as `engine_t1_t2` (road-access classes,
[suppression-data.md](suppression-data.md)), turnout 120 s (unknown staffing). `--units N`
caps the count; `--no-snapshot` uses the old CAL FIRE-bases or Chico fallback. Committed and
out-of-service engines never join. A unit holds one task at a time (`Fleet` takes a task only
when idle), so an engine is never on two tasks. The server itself does not stop one responder
token from accepting several tasks (real phones can); the in-process batch and scenario
runners (`api/live/batch.py`, `scenario_runner.py`) still use their own fleet table.

**Command board** (Live command's simulated board, `app/src/demo/`;
[command-demo-realism.md](command-demo-realism.md) "Resource snapshot"): `useCommandBoard.ts`
reads `GET .../snapshot` once per incident (and on Reset board) and builds the board only when the
command data and the snapshot answer of the same incident are both in. `model.ts` `createBoard`
takes per zone (by `zone_id`) `households`, `occupants`, `evacuating_vehicles` (households with a
vehicle each take evacuating_vehicles / households with a vehicle), `needs_transport_households`
and `_occupants` (stay home, need transport), and tracks persons as well as households (home, on
the road, out, caught; conserved; unknown occupants stay null). Units: one per engine `available`
at T+0, `engine_id` as the unit id, `type3_engine` as `engine_t3` and `type1_engine` as
`engine_t1`, at its station; every station is on the board with all its engines (committed and
out of service shown, not dispatchable); plus 2 hand crews and a dozer labelled "assumed (not in
the snapshot)". A unit holds one assignment (a second send reassigns it). Without a snapshot (404
`no_snapshot`) the board runs on its old assumed roster and drill-file counts, labelled "No
resource snapshot for this drill — using assumed roster". UI fields: `board.snapshot`
(`snapshot_id`, `scenario_time`, `sources`, `basis`, `totals`, `zones_matched`,
`zones_unmatched`), `board.resources`, `board.stations[].engines`, `stationRecords(board)`,
`zonePeople(zone, minute)`, `totals(board).people`.

## Verification (2026-10-25, Docker against Atlas)

| Drill | Households | Occupants | Vehicles | Evacuating | Carless (people) | Stations | Engines (available) | Zero-available stations |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Camp | 19,913 | 48,088 (estimated) | 39,080 | 31,638 | 1,172 (2,833) | 6 | 17 (8) | SYN1 |
| Berkeley Hills | 19,882 | 49,112 (synthetic) | 31,810 | 28,233 | 1,586 (3,862) | 16 | 33 (25) | S02 |
| Palisades | 8,424 | 20,800 (synthetic) | 13,481 | 11,959 | 672 (1,666) | 10 | 22 (12) | S02, S08 |

Stored rows were read back: sums over households equal the totals, `evacuating <= vehicles`
for every household, `needs_transport` count = carless count, and stations with two or more
engines: Camp 6, Berkeley 12, Palisades 8. Re-seeding Palisades gave the same
`content_hash` and the same household and station rows.

## Limitations

- Engine rosters and availability are invented (no staffing data); the Camp stations are two
  NIST-recorded locations plus four approximate points, not the 2018 response.
- Package occupants and vehicles are national-shape assumptions on synthetic homes; Camp's
  per-household split is synthetic within ACS zone totals (2018 block groups, MOE not used).
- Camp household points are seeded road nodes inside each block group, so rural block groups
  cluster on their few roads.
- Package household points depend on the cached dispatch area still being in MongoDB; without
  it they fall back to road nodes (counts unchanged, `content_hash` changes).
- A snapshot is served only for Camp and the active incident (the live API's incident rule).
