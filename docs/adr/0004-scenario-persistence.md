# 0004: Initial scenario and fire-run persistence

Date: 2026-10-23. Status: accepted.

Use the existing Django ORM and PostgreSQL database for four records:
`DatasetSnapshot`, `Scenario`, `SimulationRun`, and `RunFrame`. Keep them in
the installed `api` app; numerical calculations remain independent of Django.
Use Django's configured user model for scenario ownership and UUID primary keys
for domain records. No new dependencies or external services are needed.

Relational columns hold ownership, references, lifecycle status, timestamps,
and simulation frame time. Versioned JSON holds fire inputs, model parameters,
and GeoJSON perimeters. Schema 1 explicitly matches the illustrative frontend
model in ADR 0003, including its 15-minute step and 120-minute horizon. A new
engine requires a new validated contract and migration, rather than silently
accepting incompatible payloads. No evacuation metrics are defined yet.

Scenarios are editable assumptions. Runs copy their inputs and assumptions,
pin a dataset reference if applicable, and record the exact model parameters.
PostgreSQL triggers make dataset snapshots and run inputs immutable, including
bulk updates that bypass Django validation. Runs protect their parent scenario
and dataset from deletion. A run's status and frames can still be written.
The current deterministic model has no seed and consumes no external dataset;
its dataset reference is constrained to null. Historical imagery is
background context, not an observed fire-model input.

Dataset content is a reserved JSON object with explicit source provenance; no
road, population, shelter, or terrain interpretation is implemented. Introduce
typed dataset contracts when their consumers are implemented. Observed sources
require a URL and retrieval time; unknown source timestamps remain null.

Model saves validate the current JSON contracts. SQL constraints cover supported
versions, source kinds, statuses, failure messages, and unique supported frame
times. JSON validation and cross-record ownership checks are application-level;
future ingestion code must not bypass them with bulk writes. Future endpoints
must authenticate callers and scope every scenario/run/frame lookup to its
owner. UUIDs alone do not provide authorization.

This adds the storage foundation only. Save/replay endpoints, frontend wiring,
job execution, lifecycle transitions, completion checks, traffic entities,
incident ingestion, and collaborative access remain separate work. The tradeoff
is a small PostgreSQL-specific migration and a deliberately narrow JSON contract,
instead of prematurely selecting traffic/geospatial schemas or PostGIS.

See `app/backend/persistence.md` for fields, payload examples, and integration rules.
