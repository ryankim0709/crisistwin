# 0005: Household evacuation inputs

Date: 2026-10-23. Status: accepted.

Extend the initial persistence schema with RoadNode, RoadSegment, Household,
EvacuationDestination, EvacuationPlan, HouseholdDeparture, and RoadEvent. Keep
this additive: existing fire inputs, fire runs, and frames retain schema 1.
These tables define inputs; they do not implement routing or traffic results.

Roads, households, and destinations belong to a DatasetSnapshot. Import its
records, then call `seal()` to validate and freeze them before a scenario uses
that dataset. A reversible PostgreSQL migration permits one metadata change,
setting `sealed_at`, and prevents later insertion, update, or deletion of graph
records. Parent-row locks serialize imports with sealing. Before sealing,
records are editable but cannot move between datasets. Metadata/content retain
their existing immutability. This extends ADR 0004's snapshot protection to
relational inputs; a new version requires a new dataset and records.

Each scenario can have multiple plans with one departure entry per household.
Plans share its sealed dataset and scenario road events, making their environment
comparable. A scenario's dataset cannot be reassigned through model saves once
plans or events exist. Clone the scenario for environmental counterfactuals.
Plan departures and road events are editable assumptions; a future traffic run
must snapshot them and simulation settings before execution.

Store household occupants, available cars, and total seats independently. A plan
stores participating people, vehicles used, seats in those vehicles, departure
time, and an optional destination. Seats include drivers. Allow insufficient
seats and missing road connections so the model can account for unmet demand.
Do not equate cars arriving with people evacuated. Household counts are explicitly
synthetic or assumed; no resident names, addresses, or personal needs are stored.

Use directed road edges, meters, km/h, vehicles/hour, and seconds since scenario
start. Two-way roads require two edges. Coordinate columns and GeoJSON use WGS84;
GeoJSON is [longitude, latitude]. Shelter capacities in people and vehicles are
separate from exit throughput in vehicles/hour. No PostGIS dependency is needed
for storing this small demo network; spatial queries remain future work.

The in-progress traffic V1 contract uses directed roads, integer seconds, and
vehicle capacities. Its numerical module remains outside this change. Future
adapters can map the common fields, but must explicitly reject or implement
unsupported exit throughput, chosen destinations, and people/seat constraints.
The database does not claim that the vehicle-only model already supports them.
Existing fire SimulationRun records still cannot store traffic runs; integration
requires a separate versioned run/result contract, not relaxing fire validation.

See `app/backend/evacuation-persistence.md` for fields, examples, consistency
rules, import steps, and the traffic integration boundary.
