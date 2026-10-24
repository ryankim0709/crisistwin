/**
 * Contract between the fire spread page (`FireSimulatorPage.tsx`) and the three.js diorama
 * renderer in this folder (see docs/adr/0011-fire-diorama-view.md).
 *
 * The renderer draws the *real* loaded landscape (LANDFIRE fuels, terrain elevation,
 * canopy) as a stylized miniature, and the model's fire arrival field over it. It never
 * changes model inputs or results; stylization (tree placement, house shapes, vertical
 * exaggeration) is presentation only and must not be read as observed detail.
 *
 * Geography: cell (col, row) of a `LandscapeGrid` has its centre at Web Mercator
 * x = originX + col·cellSizeX, y = originY + row·cellSizeY (cellSizeY is negative, so row 0
 * is the north edge). Convert to longitude/latitude with `mercatorToLonLat` from
 * `../landscape`. Scene axes follow three.js: +x east, +z south, +y up.
 */
import type * as THREE from "three";
import type { LandscapeGrid } from "../landscape";
import type { FireRun, GeoPoint } from "../spread";
import type { BoardFrame } from "./board";
import type { LabelLayer } from "./labels";

export type { LandscapeGrid, FireRun, GeoPoint };

/**
 * The part of a run the diorama draws. `FireRun` satisfies it; the Simulation Studio builds
 * one from a `ScheduledFireRun`, whose arrivals are minutes from scenario T+0.
 */
export type DioramaRun = {
  arrivalMinutes: Float32Array;
  scenario: { horizonMinutes: number; stepMinutes: number };
};

/** A labelled ignition pin (Simulation Studio draws several). */
export type DioramaIgnition = { id: string; point: GeoPoint; label: string };

/**
 * Streets to draw on the board: OSM road polylines and synthetic homes along residential
 * streets, as `GET /api/dispatch/area` returns them (a `DispatchArea` satisfies this).
 * Coordinates are WGS84 [longitude, latitude].
 */
export type BoardStreets = {
  edges: readonly { roadClass: string; coords: readonly (readonly [number, number])[] }[];
  homes: readonly { position: readonly [number, number] }[];
};

export type GroundClickMode = "origin" | "wind";

/** CSS px of the scene container covered by floating page UI. */
export type ViewInsets = { top: number; right: number; bottom: number; left: number };

export type FireDioramaOptions = { reducedMotion: boolean };

/**
 * Extra 3D content another page draws on the board (the dispatch page's homes, routes and
 * vehicles). `attach` runs every time the board is rebuilt; the overlay adds its objects
 * under `parent` and must remove and dispose them in `detach`.
 */
export interface BoardOverlay {
  attach(frame: BoardFrame, parent: THREE.Group, labels: LabelLayer): void;
  detach(): void;
  /** Every animation frame: seconds since start (frozen under reduced motion), frame delta, viewport px. */
  tick(time: number, dt: number, reducedMotion: boolean, width: number, height: number): void;
}

/**
 * Public surface of `FireDioramaScene` (implemented in `FireDioramaScene.ts`).
 * All setters are cheap to call repeatedly with the same value.
 */
export interface FireDioramaSceneApi {
  /** Rebuild the board for a newly loaded landscape; `null` shows an empty plinth. */
  setLandscape(grid: LandscapeGrid | null): void;
  /** Arrival field to draw (`run.arrivalMinutes`); `null` clears the fire. */
  setRun(run: DioramaRun | null): void;
  /** Simulation time in minutes since ignition (continuous; the page animates it). */
  setTime(minutes: number): void;
  setIgnition(point: GeoPoint | null): void;
  /** Several labelled pins; replaces `setIgnition`'s single pin. The wind glyph sits by the first. */
  setIgnitions(ignitions: readonly DioramaIgnition[]): void;
  /** Meteorological wind direction (degrees the wind blows FROM) and speed. */
  setWind(fromDegrees: number, speedMph: number): void;
  /** Tint the ground by fuel family (the page's existing fuel legend colours). */
  setFuelOverlay(visible: boolean): void;
  setClickMode(mode: GroundClickMode): void;
  /** Click (not drag) on the board; reports the geographic point under the pointer. */
  onGroundClick(cb: (point: GeoPoint) => void): void;
  setViewInsets(insets: ViewInsets): void;
  /** Animate to a view that frames the board (or the burn, when `focusFire` is true). */
  resetView(focusFire?: boolean): void;
  setReducedMotion(value: boolean): void;
  /** Draw (or clear) another page's content on the board; survives board rebuilds. */
  setOverlay(overlay: BoardOverlay | null): void;
  /**
   * Real roads, with houses along residential streets in place of the fuel-class lattice;
   * `null` goes back to the stylized lattice. Points off the board are dropped.
   */
  setStreets(streets: BoardStreets | null): void;
  /** Show or hide the stylized fuel-class houses (a page drawing its own homes hides them). */
  setCoverHouses(visible: boolean): void;
  /** Animate to a view of the ground within `radiusMeters` of `point`. */
  focusOn(point: GeoPoint, radiusMeters: number): void;
  dispose(): void;
}
