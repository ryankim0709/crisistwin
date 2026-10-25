/**
 * Static historical-fire files under `app/public/historical-fires/`, written by
 * `tools/build_historical_fires.py` (docs/historical-data.md). Field names match the JSON.
 *
 * Units: coordinates WGS84 [longitude, latitude]; times UTC ISO-8601; `minute` = minutes after
 * the fire's `t0` (its earliest ignition); areas km2; board radius and cell in ground metres.
 * Perimeters are observed; the `.simulated.json` file is model output.
 */

import type { PerimeterGeometry } from "./arrivalFromPerimeters";

export interface HistoricalBoard {
  center: [number, number];
  /** Half-width of the square board, ground metres. */
  radius_m: number;
  /** Ground cell, metres (landscapeCellMetersFor(radius_m)). */
  cell_m: number;
}

export interface HistoricalFireSummary {
  /** Also the shared-world `region.id` for `region.kind = "historical_fire"`. */
  id: string;
  name: string;
  place: string;
  file: string;
  t0: string;
  last_snapshot_at: string;
  final_area_km2: number;
  bbox: [number, number, number, number];
  board: HistoricalBoard;
  has_simulated: boolean;
}

export interface HistoricalFireIndex {
  schema: "crisistwin.historical_fires/1";
  fires: HistoricalFireSummary[];
}

export interface HistoricalIgnition {
  id: string;
  name: string;
  coord: [number, number];
  at: string;
  minute: number;
  evidence_class: string;
  provenance: string;
  source: string;
}

export interface HistoricalSnapshot {
  at: string;
  minute: number;
  area_km2: number;
  /** `null` = unchanged from the previous snapshot (the time still bounds later growth). */
  geometry: PerimeterGeometry | null;
}

export interface HistoricalSource {
  id: string;
  provider: string;
  url: string;
  documentation?: string;
  license: string;
}

export interface HistoricalFire {
  schema: "crisistwin.historical_fire/1";
  id: string;
  name: string;
  place: string;
  /** IANA zone for local-time display. */
  timezone: string;
  t0: string;
  ignitions: HistoricalIgnition[];
  perimeters: {
    evidence_class: "observed";
    /** The incident package's own label for the layer (e.g. "derived", "reconstructed"). */
    source_evidence_class: string[];
    method: string;
    time_precision: "half_day";
    time_note: string;
    simplified_tolerance_m: number;
    feds_fire_id: string;
    snapshots: HistoricalSnapshot[];
  };
  final_area_km2: number;
  bbox: [number, number, number, number];
  board: HistoricalBoard;
  simulated_file: string | null;
  package: { path: string; package_version: string | null; perimeter_file: string };
  sources: HistoricalSource[];
}

export interface SimulatedArrivalGrid {
  origin_lon: number;
  origin_lat: number;
  cell_m: number;
  ncols: number;
  nrows: number;
  m_per_deg_lon: number;
  m_per_deg_lat: number;
  order: "row_major_south_first";
  t0: string;
  /** Added to `minutes` to express them after the fire's t0. */
  minute_offset: number;
  minutes: (number | null)[];
}

export interface HistoricalFireSimulated {
  schema: "crisistwin.historical_fire_simulated/1";
  id: string;
  evidence_class: "simulated";
  model: { id: string | null; version: string | null };
  calibration_headline: string | null;
  ignition_provenance: string | null;
  arrival_grid: SimulatedArrivalGrid;
  source: string;
}
