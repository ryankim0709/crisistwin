# ADR 0005: Versioned historical incident packages

Status: Proposed (2026-10-23)

The initial Camp Fire pilot uses GeoJSON for 290 CAL FIRE points and 45 NASA VEDA
perimeters while proving source retention, offline verification, and retrospective
snapshot selection. The wider GeoParquet contract remains proposed.

## Context

Historical wildfire sources mix geospatial snapshots, interval traffic measurements,
post-fire assessments and narrative reports. CrisisTwin needs repeatable demos and
simulation evaluation without turning missing observations into invented history.

## Proposed decision

Use immutable incident packages containing original source artifacts, a JSON
manifest with hashes/provenance, GeoParquet vector tables, Parquet measurement
tables, and JSONL evidence/events. Keep raster inputs in GeoTIFF when present.
Generate browser GeoJSON and replay timelines as derived artifacts. Separate
occurrence/observation time from documented information availability; store
counterfactual runs separately with pinned inputs and model configuration.

The proposed contract and acquisition plan are in
[historical-replay.md](../historical-replay.md). This ADR does not select the
application stack, install dependencies, or imply a collector exists.

## Tradeoffs

- Several file formats require small source-specific adapters, but retain typed
  measurements, detailed geometry and source evidence without a database service.
- A GeoJSON-only archive would be easy to inspect but cumbersome for large repeated
  geometry and typed measurement tables; GeoJSON remains useful for delivery.
- GeoPackage is a viable GIS interchange/export alternative. GeoParquet is proposed
  for the analysis archive so spatial and nonspatial tables share Parquet tooling.
- Snapshots and rendered animations are rebuildable caches, not historical truth.
- More temporal metadata and review effort are needed, especially for reports;
  this supports reproducibility and avoids future-information leakage in testing.

## Adoption criterion

Inspect a real incident slice and validate coverage, conversion and replay semantics
before accepting this proposal as the implemented contract. Missing fine-grained
observations cannot be fixed by choosing a storage format.
