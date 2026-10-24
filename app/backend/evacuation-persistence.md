# Evacuation input contract

Migration `0003_evacuation_inputs` adds seven models, dataset sealing time, and
scenario evacuation timing settings. `0004_seal_evacuation_datasets` freezes
relational dataset records once imported. Apply these with the existing
`python manage.py migrate` workflow. No fixture import, HTTP endpoints, simulator
adapter, or traffic results are added by these migrations.

## Dataset records

All four dataset record types have a UUID, dataset FK, a `key` unique within
that dataset and record type, and an optional label. Use stable, nonpersonal keys
such as `house-001` or `bridge-eastbound`. Locations are named latitude/longitude
columns, WGS84 decimal degrees, with seven decimal places. Counts and capacities
are nonnegative integers; zero does not mean unknown or unlimited.

- **RoadNode**: latitude, longitude. Represents intersections, household road
  connectors, or destination connectors. Disconnected nodes are permitted.
- **RoadSegment**: source/target node FKs, GeoJSON LineString geometry, `length_m`,
  `free_flow_speed_kph`, and `capacity_vehicles_per_hour`. Length/speed/capacity
  are positive. Geometry runs from source to target and its endpoints must match
  the node coordinates within 0.0000001 degrees. A two-way road has two rows with
  opposite directions and reversed geometry; parallel edges are permitted.
  Travel speed and discharge capacity are model assumptions, not observations
  inferred from map imagery. Bounds are 1,000 km per edge, 300 km/h, and 100,000
  vehicles/hour. Geometry has 2–10,000 coordinate pairs.
- **Household**: latitude, longitude, nullable origin-node FK, `occupants`,
  `cars_available`, `seats_available`, and `counts_kind` (`synthetic` by default
  or `assumed`). Seats include drivers. Zero cars implies zero seats; otherwise
  total seats must be at least the car count. An empty household may own cars.
  A null origin explicitly means unconnected; never silently discard that demand.
- **EvacuationDestination**: latitude, longitude, node FK, and `kind`.
  A `shelter` requires `capacity_people` and `capacity_vehicles` (parking spaces),
  and has null throughput. An `exit` requires positive
  `throughput_vehicles_per_hour` and has null people/vehicle capacities: it is a
  flow out of the modeled area, not a shelter with unlimited parking. The location
  may differ from its road connector; connector traversal is not modeled yet.

Road endpoints, household origins, and destination nodes must belong to the same
dataset as their referencing record. `content` on DatasetSnapshot remains source
metadata, not a second copy of the graph. Source kind/timestamps describe the
source dataset; `Household.counts_kind` explicitly labels counts even when the
underlying map is observed. Put capacity/speed assumptions and public-data
licensing/provenance in the dataset content. No household counts are inferred
from imagery or represented as verified live resident data.

## Import and seal

Create the dataset metadata once, then its nodes, roads, households, and
locations. Use normal ORM `create()`/`save()` so field and relationship validators
run. Finally call `dataset.seal()`. This locks the dataset row, revalidates all
four record types (including geometry after any node edits), and records a UTC
sealing time in one transaction. Repeated sealing is a no-op.

A scenario with a dataset reference must use a sealed dataset. PostgreSQL triggers
prevent changes or additions to sealed graph records, even through bulk writes.
Before sealing, records can be edited/deleted, but never moved to another
dataset. Dataset metadata remains immutable apart from initial sealing. To
change input data, import and seal a new snapshot, then create a new scenario.
Existing snapshots from the earlier migrations have null `sealed_at`; seal them
before using them in a new plan. `seal()` validates provided records but does
not require a runnable connected network, complete population data, or a shelter.

Do not set `sealed_at` directly or seal using raw SQL: those bypass application
validation of graph contents. Use the ORM contract above. Importers should bound
record counts to their target engine's limits before writing.

## Scenarios, plans, and departures

Scenario evacuation timing uses **integer seconds from scenario start**, with
`evacuation_horizon_s` defaulting to 7,200 and
`evacuation_snapshot_interval_s` to 30. Horizon is 1–86,400 seconds; the interval
must be positive and no greater than the horizon. These settings are independent
of the existing fire model's fixed 15-minute frames; a coupled adapter must
explicitly convert fire elapsed minutes to seconds.

**EvacuationPlan** has a UUID, scenario FK, name, assumptions, and UTC
creation/update timestamps. It inherits ownership through the scenario and
requires a sealed scenario dataset. A plan cannot be moved to another scenario
through model saves. Several plans on one scenario share the input graph, timing
settings, and closure events. To compare scenarios with different conditions,
label the differences explicitly.

**HouseholdDeparture** has a UUID, plan FK, household FK, `departure_time_s`,
`participating_people`, `vehicles_used`, `seats_used`, and optional destination FK.
There is at most one row per household/plan. People cannot exceed occupants;
selected vehicles/seats cannot exceed household availability. Each selected car
requires a participating driver and at least one seat. Zero vehicles implies
zero selected seats. Seats are an explicit assumption for the selected fleet,
not proportional allocation from all owned cars. Vehicle-by-vehicle occupancy,
driver eligibility, repeat trips, and carpooling are not modeled by these tables.

A null destination requests routing to a suitable available destination; a
non-null destination requests that particular one. Both household and destination
must belong to the plan's scenario dataset. A departure can occur after the
scenario horizon (up to 86,400 seconds); its demand then remains not departed.
The road-network origin is part of the sealed household record, not the plan.

Example proposed household and plan values (UUID references omitted):

```json
{
  "household": {
    "key": "house-001",
    "latitude": 37.7749,
    "longitude": -122.4194,
    "occupants": 6,
    "cars_available": 2,
    "seats_available": 10,
    "counts_kind": "synthetic"
  },
  "departure": {
    "departure_time_s": 300,
    "participating_people": 6,
    "vehicles_used": 1,
    "seats_used": 5,
    "destination": null
  }
}
```

This deliberately leaves one participating person without a selected seat.
Keep that person in unmet transport demand. `occupants - participating_people`
are nonparticipants; `max(participating_people - seats_used, 0)` is the initial
seat shortfall. Neither quantity is a computed evacuation result. A runnable
plan must explicitly cover every dataset household, including zero participation
and zero-car entries; the future execution service must reject incomplete plans
rather than default missing households to zero. Full destinations and unreachable
routes must leave demand accounted for, not mark it evacuated.

## Road events

**RoadEvent** has a UUID, scenario FK, road FK, `time_s`, and Boolean `closed`.
There is only one event per scenario/road/time. Events are ordered by time then
road UUID; time must be within the scenario's evacuation horizon. A road must
come from that scenario's sealed dataset. The baseline network is open; use a
closure at time zero for an initially closed road. Close both directional edges
when closing a two-way road. Events change the scenario, not the shared road row.

Closure means no new vehicle entry at or after its time; vehicles already on the
edge clear normally. Reopening permits new entry. A destructive hazard that
traps cars requires another explicit model rule. Future adapters should apply
events before routing departures at the same time.

## Consistency and integration boundary

Normal ORM saves validate cross-dataset links, household limits, event horizons,
and plan/scenario references. These cross-row checks are not SQL constraints;
bulk writes/raw SQL bypass them. The database enforces nonnegative integer
counts, coordinate and road ranges, seat/driver relationships within a row,
destination-kind capacities, and unique keys/departures/events. Freezing datasets
is enforced by SQL triggers. Future authenticated write services must lock the
scenario while changing its dataset, timing, plans, or events, and snapshot all
inputs atomically before execution. Scope plan/departure/event access through
the scenario owner; shared datasets contain public or synthetic inputs only.

For the in-progress vehicle-only traffic V1 interface, node/road/household keys
can be used as engine IDs; map selected `vehicles_used` to `cars`, not
`cars_available`. Derive integer free-flow `travel_time_s` by rounding
`length_m * 3.6 / free_flow_speed_kph` up to the next second. Carry departure
seconds, road capacity, and road events directly. Map a shelter's
`capacity_vehicles` to the vehicle-capacity field, never its people capacity.
Validate the exported payload against the engine's bounds before execution.

That V1 engine does not enforce people capacity, seat occupancy, chosen
destinations, or exit throughput. A future adapter must explicitly reject
unsupported settings or label a vehicle-only experiment and keep unmet person
demand visible; it must not silently drop these constraints. Missing road
connections must be reported before calling its required-origin contract.

Existing SimulationRun and RunFrame still store fire-only schema 1. No traffic
run/result storage or adapter is claimed here. A future traffic run must capture
the sealed dataset ID, complete plan/event/timing inputs, engine version, and
computed results in a new validated contract. Do not attach traffic output to a
fire run or reread a mutable plan to explain an older result.
