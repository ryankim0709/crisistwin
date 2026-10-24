# 0040: Realistic suppression resource data

Date: 2026-10-24. Status: accepted as data and loader; not yet wired into the simulator.
Builds on [0020-studio-firefighting](0020-studio-firefighting.md),
[0023-studio-crew-dispatch](0023-studio-crew-dispatch.md) and
[0025-dispatch-fire-tactics](0025-dispatch-fire-tactics.md).

## Context

The suppression model uses three resource kinds with one assumed production rate each (hand
crew 400 m/h, engine 600 m/h, dozer 1,200 m/h in grass), treats every resource as housed at an
OSM fire station, and drives them at free-flow road speed (ADR 0023). ADR 0020 says the rates
are "of the order of" published values, not taken from a table. There are no water tenders,
aircraft, road-class limits or real base locations, so the model cannot say whether an engine
can reach a ridge track or whether an airtanker can fly at 20:00.

`AGENTS.md` requires every number to come from a source or be labelled an assumption.

## Decision

Add a sourced dataset and a small loader; do not change the simulator yet.

- `tools/suppression_resources.json`: resource typing (NWCG PMS 200, Water Handling Equipment
  Guide), production rates (PMS 465 dozer and engine tables, Broyles 2011 crew rates),
  aircraft (PMS 200, Interagency Aerial Supervision Guide, PMS 508), constraints (14 CCR 1273
  road design standards, OSM tag semantics, flight rules) and response times. Each value is a
  leaf with a unit and either `source_id` + `page` or `assumption: true` + `reason`. 197 of 250
  leaves are sourced from fetched documents, 8 more from sources that could not be verified
  (flagged), and 45 are assumptions.
- `tools/ca_fire_bases.json`: 1,046 active stations, camps, helitack bases, air attack bases
  and dispatch centers from the CAL FIRE facilities layer, with the raw download's size and
  SHA-256, and the licence recorded as "none stated, disclaimer only". It is small enough (309
  KB) to commit; `--refresh-bases` rebuilds it.
- `tools/suppression_data.py`: loads and validates both files, prints a coverage summary,
  converts units, and implements `road_access(tags, grade, vehicle)` as the decision table in
  [suppression-data.md](../suppression-data.md). The thresholds are mostly assumptions and are
  read from the JSON, so calibration changes data, not code.
- `tests/test_suppression_data.py` enforces that every number is sourced or flagged, checks
  units, table shapes, monotonicity and the road rules.

Sources that blocked automated download (fire.ca.gov, 403) or need an account (PMS 507,
NFPA 1710) are recorded as unavailable or unverified rather than filled from memory;
anything seen only through a search summary carries `verified: false`.

## Consequences

- The model can be moved to table-driven production (by crew type, fuel model, dozer size and
  slope), real apparatus classes and base locations in a later change. Against the data, the
  current hand-crew rate is about 2x a Type 2 crew's observed direct rate in grass, the engine
  rate is mid-range and the dozer rate is conservative.
- Road access gets an explicit, testable rule set tied to OSM tags and an elevation-derived
  grade. Most grade, surface and speed limits are assumptions; a CAL FIRE or USFS unit should
  confirm them before results are shown as more than planning experiments.
- Gaps remain and are listed in the docs: no federal (USFS, BLM) or per-station apparatus
  data, no public dispatch matrix, dated 2019 fleet counts, and no source for engine off-road
  capability, aircraft ground times or most speeds.
- The facilities layer has no stated open licence. The file credits CAL FIRE and records the
  terms as unstated; replace it with a licensed source if redistribution becomes an issue.
- Counts and bases will drift. `--refresh-bases` and the dated `retrieved` field make the
  age visible.
