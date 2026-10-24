# Persistence contract

The `api` app's initial four domain models are created by `0001_initial`;
`0002_snapshot_immutability` adds reversible PostgreSQL triggers. Migrations
`0003_evacuation_inputs` and `0004_seal_evacuation_datasets` add seven evacuation
input models and dataset sealing. See the [evacuation input contract](evacuation-persistence.md).
Django's auth migrations provide users. No API endpoints, automatic save/replay,
data imports, or seed users are added.

## Records

- `DatasetSnapshot`: UUID, name, version label, `source_kind` (`synthetic` or
  `observed`), optional source URL/time and retrieval time, schema version,
  JSON object `content`, and creation time. Observed sources require a URL and
  retrieval time; a null source timestamp means unknown, not fresh. Content is
  source metadata rather than a second copy of the relational road/household data.
  Metadata cannot be updated apart from setting `sealed_at` once via `seal()`;
  sealed relational inputs cannot be changed. Create a new record for a changed source.
- `Scenario`: UUID, required Django user `owner`, name, optional region label,
  optional parent scenario and dataset, schema version, JSON `inputs`, free-text
  `assumptions`, creation/update times. Parent scenarios must have the same owner.
  Region is a display label, not a geometry or dataset identifier. The optional
  dataset must be sealed. Evacuation timing fields and related plans/events are
  defined in the evacuation contract; `inputs` retains the fire-only shape below.
- `SimulationRun`: UUID, required scenario, optional pinned dataset, schema
  version, JSON `input_snapshot`, `assumptions_snapshot`, nullable `random_seed`,
  status, error message, creation/start/finish times. Inputs, assumptions, source
  reference, scenario reference, seed, schema version, and creation time are
  immutable at the database level. Status is `pending`, `running`, `succeeded`,
  `failed`, or `cancelled`; only failed runs have a nonempty error message.
  Seed and dataset must be null for deterministic schema 1.
- `RunFrame`: UUID, required run, integer `elapsed_minutes`, GeoJSON `perimeter`.
  Times are unique per run and restricted to 0, 15, ..., 120. The default query
  ordering is simulation time; the unique constraint also indexes replay queries.

Deleting a referenced user, dataset, or scenario through the ORM is protected.
Deleting an unused parent scenario clears its children's parent references.
Deleting a run deletes its frames. PostgreSQL foreign keys also prevent dangling
references from raw SQL; Django implements the documented cascade/null behavior.

## Schema 1 payloads and units

Scenario `inputs` contains exactly:

```json
{
  "origin": {"latitude": 37.7749, "longitude": -122.4194},
  "windSpeedMph": 10,
  "windFromDegrees": 270
}
```

These are user assumptions. Origin is WGS84 decimal degrees: latitude [-80, 80],
longitude [-180, 180]. Wind speed is [0, 40] mph; direction is meteorological
**from**, clockwise degrees from north in [0, 360). Reject nonfinite numbers,
booleans, missing fields, and unknown fields. The simulation converts mph to m/s;
persistence preserves the existing frontend boundary units.

Run `input_snapshot` contains the frontend `FireRun` fields except `frames`:

```json
{
  "inputs": {
    "origin": {"latitude": 37.7749, "longitude": -122.4194},
    "windSpeedMph": 10,
    "windFromDegrees": 270
  },
  "model": {
    "id": "uniform-fuel-ellipse",
    "version": "1.0.0",
    "baseSpreadMetersPerSecond": 0.1,
    "headWindGainPerMeterPerSecond": 0.35,
    "backingWindReductionPerMeterPerSecond": 0.15
  },
  "stepMinutes": 15,
  "horizonMinutes": 120
}
```

The model metadata and step/horizon must match these exact values. Reproducibility
requires retaining that model implementation, not just its name. Schema 1 uses
`dataset=null` and `random_seed=null`: neither source data nor randomness enters
the current fire calculation. Dataset provenance is retained by its immutable
record when later model contracts introduce external inputs.

Each frontend `{elapsedMinutes, perimeter}` maps to a `RunFrame` row, with
`elapsedMinutes` renamed to `elapsed_minutes`. Frame zero stores
`{"type":"FeatureCollection","features":[]}`. Later frames contain one Polygon
feature with `properties.elapsedMinutes` equal to the row time, one 72-segment
exterior ring, and a closing coordinate (73 coordinate pairs total). Coordinates
are `[longitude, latitude]`; continuous longitude across the date line is allowed
within [-540, 540]. Validation checks structure and finite ranges, not physical
plausibility, polygon topology, or whether a trusted simulator produced it.

Wall-clock timestamps are timezone-aware and stored in UTC. `elapsed_minutes`
is simulation time since ignition, never wall-clock time. Unknown start/finish
times are null. No derived evacuation metrics, confidence scores, or AI text are
stored as computed fire results.

## Rules for the next integration

Normal `save()` and `objects.create()` call `full_clean()`. `bulk_create()`,
`bulk_update()`, `QuerySet.update()`, and raw SQL bypass JSON and ownership
validation: do not use them for ingestion. SQL constraints and immutability
triggers still apply. Keep versioned validator functions available for historical
migrations; add new versions instead of changing the meaning of version 1.

An authenticated save endpoint should validate and bound the request, then use
one `transaction.atomic()` block to select the caller's scenario with
`select_for_update()`, copy inputs/assumptions, create the run, and save all nine
validated frames. Only mark it succeeded after verifying the complete timeline.
For a browser-computed run, verify the submitted input snapshot against the
scenario revision being saved; a stale result must not be relabeled with newly
edited inputs. The schema does not implement that endpoint or a job state machine.

Replay should reconstruct `FireRun` from the run's snapshot plus its ordered
frames, never from the scenario's current inputs. Return run/scenario IDs so the
frontend can discard stale responses. Scope every run and frame lookup through
`scenario__owner=request.user`; do not expose globally addressable UUID records.

## Migration commands

From `app/`, with the backend already running:

```sh
docker compose exec backend python manage.py migrate
```

The existing Docker startup entrypoint also applies migrations. On the host,
after the documented environment/database setup, from the repository root:

```sh
app/backend/.venv/bin/python app/backend/manage.py migrate
```

For future model changes, generate and review migrations from `app/backend/`:

```sh
.venv/bin/python manage.py makemigrations api --skip-checks
```

Generation writes migration files; it does not apply them. Database execution
and verification are separate. Reversing `0002` removes immutability protections;
reversing `0001` drops all four tables and their data. Do not roll back populated
tables merely to revise a schema; use an additive migration.
