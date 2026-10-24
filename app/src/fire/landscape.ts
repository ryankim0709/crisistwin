/**
 * Landscape inputs for the spread model: a fuel model raster from LANDFIRE and an
 * elevation raster from the open terrain tile set, resampled onto one grid.
 *
 * Both sources are published in EPSG:3857, the projection MapLibre renders in, so the
 * grid needs no reprojection. Mercator distances are NOT ground distances: one Mercator
 * metre is cos(latitude) ground metres. Slope and spread distance use ground metres;
 * only cell addressing uses Mercator metres.
 */

import { FUEL_NO_DATA } from "./fuelModels";

export interface MercatorBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface LandscapeGrid {
  width: number;
  height: number;
  /** Mercator coordinate of the centre of cell (0, 0). */
  originX: number;
  originY: number;
  /** Signed Mercator metres per cell; y decreases down the grid. */
  cellSizeX: number;
  cellSizeY: number;
  /** Ground metres per cell, after the Mercator scale correction. */
  groundCellSizeMeters: number;
  /** False when a terrain tile was unavailable, so slope is understated in places. */
  elevationComplete: boolean;
  /** LANDFIRE FBFM40 code per cell. */
  fuelCodes: Int16Array;
  /** Metres above sea level per cell. */
  elevationMeters: Float32Array;
  /** Rise over run per cell. */
  slopeTangent: Float32Array;
  /** Compass bearing of the upslope direction per cell, degrees from true north. */
  upslopeDegrees: Float32Array;
  /** Canopy base height in metres; 0 where there is no canopy. */
  canopyBaseHeightMeters: Float32Array;
  /** Canopy bulk density in kg per cubic metre; 0 where there is no canopy. */
  canopyBulkDensityKgPerM3: Float32Array;
  /** Canopy cover as a fraction from 0 to 1. */
  canopyCoverFraction: Float32Array;
  /** Canopy height in metres; 0 where there is no canopy. */
  canopyHeightMeters: Float32Array;
  /** False when any canopy raster could not be loaded, so crown fire is not modelled. */
  canopyComplete: boolean;
  attribution: { fuel: string; terrain: string; canopy: string };
}

export const EARTH_CIRCUMFERENCE_METERS = 40075016.68557849;
const MERCATOR_ORIGIN_SHIFT = EARTH_CIRCUMFERENCE_METERS / 2;
const RADIANS_PER_DEGREE = Math.PI / 180;

/**
 * Same-origin path, proxied to https://edcintl.cr.usgs.gov/geoserver/landfire by the Vite
 * dev server and by Nginx in the built image. The upstream advertises permissive CORS but
 * browser requests to it still fail, so the proxy is required, not a convenience.
 */
export const LANDFIRE_WCS_URL = "/landfire/wcs";
export const LANDFIRE_COVERAGE = "landfire__LF2025_FBFM40_CONUS";
export const LANDFIRE_ATTRIBUTION =
  "LANDFIRE 2025 (LF2025) 40 Scott and Burgan fire behavior fuel models, USGS/USDA";
/**
 * Canopy coverages for the crown fire model. Same WCS service, same LF2025 vintage and the
 * same 30 m EPSG:3857 lattice as the fuel layer, so every cell lines up with `fuelCodes`.
 */
export const LANDFIRE_CANOPY_COVERAGES = {
  canopyBaseHeight: "landfire__LF2025_CBH_CONUS",
  canopyBulkDensity: "landfire__LF2025_CBD_CONUS",
  canopyCover: "landfire__LF2025_CC_CONUS",
  canopyHeight: "landfire__LF2025_CH_CONUS",
} as const;
export const LANDFIRE_CANOPY_ATTRIBUTION =
  "LANDFIRE 2025 (LF2025) forest canopy base height, bulk density, cover and height, USGS/USDA";
export const TERRAIN_TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
export const TERRAIN_ATTRIBUTION =
  "Terrain tiles hosted by AWS Open Data, derived from USGS 3DEP and other public sources";
/** Terrarium zoom level whose pixels are near the 30 m LANDFIRE cell size. */
const TERRAIN_ZOOM = 13;
const TILE_SIZE = 256;

export function lonLatToMercator(longitude: number, latitude: number): [number, number] {
  const x = (longitude / 180) * MERCATOR_ORIGIN_SHIFT;
  const clamped = Math.max(Math.min(latitude, 85.05112878), -85.05112878);
  const y =
    (Math.log(Math.tan((90 + clamped) * (Math.PI / 360))) / Math.PI) * MERCATOR_ORIGIN_SHIFT;
  return [x, y];
}

export function mercatorToLonLat(x: number, y: number): [number, number] {
  const longitude = (x / MERCATOR_ORIGIN_SHIFT) * 180;
  const latitude =
    (Math.atan(Math.exp((y / MERCATOR_ORIGIN_SHIFT) * Math.PI)) * 360) / Math.PI - 90;
  return [longitude, latitude];
}

export function boxAround(
  longitude: number,
  latitude: number,
  groundRadiusMeters: number,
): MercatorBox {
  // Grow the Mercator radius so the box covers the requested ground distance.
  const mercatorRadius = groundRadiusMeters / Math.cos(latitude * RADIANS_PER_DEGREE);
  const [x, y] = lonLatToMercator(longitude, latitude);
  return {
    minX: x - mercatorRadius,
    minY: y - mercatorRadius,
    maxX: x + mercatorRadius,
    maxY: y + mercatorRadius,
  };
}

interface DecodedRaster {
  width: number;
  height: number;
  values: Int16Array;
  transform: { originX: number; originY: number; scaleX: number; scaleY: number };
}

/**
 * Minimal reader for the uncompressed single-band GeoTIFFs this GeoServer returns.
 * Supports stripped and tiled layouts and 16-bit samples; anything else is rejected
 * rather than silently misread.
 */
export function decodeGeoTiff(buffer: ArrayBuffer): DecodedRaster {
  const view = new DataView(buffer);
  const marker = String.fromCharCode(view.getUint8(0), view.getUint8(1));
  if (marker !== "MM" && marker !== "II") throw new Error("Fuel data is not a TIFF.");
  const littleEndian = marker === "II";
  const ifdOffset = view.getUint32(4, littleEndian);
  const entryCount = view.getUint16(ifdOffset, littleEndian);

  const tags = new Map<number, { type: number; count: number; offset: number }>();
  for (let i = 0; i < entryCount; i++) {
    const entry = ifdOffset + 2 + i * 12;
    tags.set(view.getUint16(entry, littleEndian), {
      type: view.getUint16(entry + 2, littleEndian),
      count: view.getUint32(entry + 4, littleEndian),
      offset: entry + 8,
    });
  }
  const scalar = (tag: number, fallback?: number): number => {
    const entry = tags.get(tag);
    if (!entry) {
      if (fallback === undefined) throw new Error(`Fuel data is missing TIFF tag ${tag}.`);
      return fallback;
    }
    return entry.type === 3
      ? view.getUint16(entry.offset, littleEndian)
      : view.getUint32(entry.offset, littleEndian);
  };
  const offsets = (tag: number): number[] => {
    const entry = tags.get(tag);
    if (!entry) return [];
    if (entry.count === 1) return [scalar(tag)];
    const base = view.getUint32(entry.offset, littleEndian);
    const stride = entry.type === 3 ? 2 : 4;
    return Array.from({ length: entry.count }, (_, i) =>
      entry.type === 3
        ? view.getUint16(base + i * stride, littleEndian)
        : view.getUint32(base + i * stride, littleEndian),
    );
  };

  const width = scalar(256);
  const height = scalar(257);
  if (scalar(258, 16) !== 16) throw new Error("Fuel data is not 16-bit.");
  if (scalar(259, 1) !== 1) throw new Error("Fuel data is compressed; expected raw samples.");
  const signed = scalar(339, 1) === 2;

  const values = new Int16Array(width * height);
  const tileWidth = tags.has(322) ? scalar(322) : 0;
  const read = (byteOffset: number) =>
    signed ? view.getInt16(byteOffset, littleEndian) : view.getUint16(byteOffset, littleEndian);

  if (tileWidth > 0) {
    const tileHeight = scalar(323);
    const tileOffsets = offsets(324);
    const tilesAcross = Math.ceil(width / tileWidth);
    for (let t = 0; t < tileOffsets.length; t++) {
      const tileX = (t % tilesAcross) * tileWidth;
      const tileY = Math.floor(t / tilesAcross) * tileHeight;
      for (let row = 0; row < tileHeight; row++) {
        const y = tileY + row;
        if (y >= height) break;
        for (let column = 0; column < tileWidth; column++) {
          const x = tileX + column;
          if (x >= width) continue;
          values[y * width + x] = read(tileOffsets[t] + (row * tileWidth + column) * 2);
        }
      }
    }
  } else {
    const rowsPerStrip = scalar(278, height);
    const stripOffsets = offsets(273);
    for (let s = 0; s < stripOffsets.length; s++) {
      for (let row = 0; row < rowsPerStrip; row++) {
        const y = s * rowsPerStrip + row;
        if (y >= height) break;
        for (let x = 0; x < width; x++) {
          values[y * width + x] = read(stripOffsets[s] + (row * width + x) * 2);
        }
      }
    }
  }

  // ModelTransformation (34264) or ModelTiepoint (33922) + ModelPixelScale (33550).
  const double = (byteOffset: number) => view.getFloat64(byteOffset, littleEndian);
  let originX: number;
  let originY: number;
  let scaleX: number;
  let scaleY: number;
  const transformTag = tags.get(34264);
  const tiepointTag = tags.get(33922);
  const scaleTag = tags.get(33550);
  if (transformTag) {
    const base = view.getUint32(transformTag.offset, littleEndian);
    scaleX = double(base);
    scaleY = double(base + 5 * 8);
    originX = double(base + 3 * 8);
    originY = double(base + 7 * 8);
  } else if (tiepointTag && scaleTag) {
    const tieBase = view.getUint32(tiepointTag.offset, littleEndian);
    const scaleBase = view.getUint32(scaleTag.offset, littleEndian);
    originX = double(tieBase + 3 * 8);
    originY = double(tieBase + 4 * 8);
    scaleX = double(scaleBase);
    scaleY = -double(scaleBase + 8);
  } else {
    throw new Error("Fuel data has no georeferencing.");
  }
  return { width, height, values, transform: { originX, originY, scaleX, scaleY } };
}

/** Smallest plausible coverage response; anything shorter is a truncated or empty reply. */
const MIN_COVERAGE_BYTES = 1024;
const MAX_FUEL_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 4000;

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/** Reject as soon as `signal` aborts, without cancelling the shared work behind `promise`. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

/**
 * The LANDFIRE service returns an occasional empty 500 for a request that succeeds on
 * the next attempt, so retry transient failures a bounded number of times.
 */
async function fetchCoverageWithRetry(url: string, subject: string): Promise<ArrayBuffer> {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= MAX_FUEL_ATTEMPTS; attempt++) {
    let retryAfterMs: number | null = null;
    try {
      const response = await fetch(url);
      lastStatus = response.status;
      if (response.ok) {
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength >= MIN_COVERAGE_BYTES) return buffer;
        // A short 200 is an empty or truncated coverage; worth one more attempt.
      } else if (response.status === 404) {
        throw new UpstreamError(
          `LANDFIRE has no ${subject} data for this area. Coverage is limited to the contiguous United States.`,
          404,
        );
      } else if (response.status < 500 && response.status !== 429) {
        throw new UpstreamError(
          `LANDFIRE rejected the ${subject} data request (${response.status}).`,
          response.status,
        );
      } else if (response.status === 429) {
        const header = Number(response.headers.get("Retry-After"));
        if (Number.isFinite(header) && header > 0) {
          retryAfterMs = Math.min(header * 1000, MAX_RETRY_DELAY_MS);
        }
      }
    } catch (cause) {
      if (cause instanceof UpstreamError) throw cause;
      // Anything else is a network-level failure; fall through and retry.
      lastStatus = 0;
    }
    if (attempt < MAX_FUEL_ATTEMPTS) {
      const backoff = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
      await delay(retryAfterMs ?? backoff * (0.7 + Math.random() * 0.6));
    }
  }
  throw new UpstreamError(
    lastStatus === 0
      ? `Could not reach the LANDFIRE ${subject} service. Check the network connection and try again.`
      : `The LANDFIRE ${subject} service is failing (${lastStatus}) after ${MAX_FUEL_ATTEMPTS} attempts. Try again in a moment.`,
    lastStatus,
  );
}

/**
 * One upstream request per distinct URL. React runs effects twice in development, and a
 * shared entry keeps that from issuing two large duplicate downloads. The underlying
 * request is deliberately not cancellable: callers drop out through `abortable`, and
 * letting the download finish means a re-mount is served from the settled promise.
 */
const inFlightCoverage = new Map<string, Promise<ArrayBuffer>>();

function sharedCoverage(url: string, subject: string): Promise<ArrayBuffer> {
  const existing = inFlightCoverage.get(url);
  if (existing) return existing;
  const request = fetchCoverageWithRetry(url, subject).finally(() => inFlightCoverage.delete(url));
  inFlightCoverage.set(url, request);
  return request;
}

/**
 * Largest sub-request side, in cells. The service snaps a large GetCoverage up to its own
 * 1024-cell tile and truncates the body at 2 MiB; the proxy then sees the connection die
 * and reports a 500. Staying well under that returns whole, correct responses.
 */
const MAX_REQUEST_CELLS = 320;
const FUEL_CELL_METERS = 30;
/** Concurrent sub-requests; enough to be quick without hammering the service. */
const MAX_PARALLEL_REQUESTS = 4;

function coverageUrl(coverageId: string, box: MercatorBox): string {
  return (
    `${LANDFIRE_WCS_URL}?service=WCS&version=2.0.1&request=GetCoverage` +
    `&coverageId=${coverageId}` +
    `&subset=X(${box.minX.toFixed(2)},${box.maxX.toFixed(2)})` +
    `&subset=Y(${box.minY.toFixed(2)},${box.maxY.toFixed(2)})` +
    `&format=image/tiff`
  );
}

async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let index = next++; index < items.length; index = next++) {
        results[index] = await run(items[index]);
      }
    }),
  );
  return results;
}

/** Split the requested box into sub-requests the service will answer without truncating. */
function chunkBoxes(box: MercatorBox): MercatorBox[] {
  const span = MAX_REQUEST_CELLS * FUEL_CELL_METERS;
  const columns = Math.max(1, Math.ceil((box.maxX - box.minX) / span));
  const rows = Math.max(1, Math.ceil((box.maxY - box.minY) / span));
  const chunkWidth = (box.maxX - box.minX) / columns;
  const chunkHeight = (box.maxY - box.minY) / rows;

  const boxes: MercatorBox[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      boxes.push({
        minX: box.minX + column * chunkWidth,
        maxX: box.minX + (column + 1) * chunkWidth,
        minY: box.minY + row * chunkHeight,
        maxY: box.minY + (row + 1) * chunkHeight,
      });
    }
  }
  return boxes;
}

/**
 * Stitch sub-request pieces into one raster. All pieces sit on the same 30 m Mercator
 * lattice, so offsets are whole cells. Gaps keep `fillValue`, which must be the
 * coverage's own no-data sentinel rather than a plausible measurement.
 */
function stitchPieces(pieces: DecodedRaster[], fillValue: number, label: string): DecodedRaster {
  if (pieces.length === 1) return pieces[0];

  // Union extent on the shared lattice. scaleY is negative, so originY is the north edge.
  const scaleX = pieces[0].transform.scaleX;
  const scaleY = pieces[0].transform.scaleY;
  const westEdge = Math.min(...pieces.map((piece) => piece.transform.originX));
  const northEdge = Math.max(...pieces.map((piece) => piece.transform.originY));
  const eastEdge = Math.max(
    ...pieces.map((piece) => piece.transform.originX + piece.width * scaleX),
  );
  const southEdge = Math.min(
    ...pieces.map((piece) => piece.transform.originY + piece.height * scaleY),
  );
  const width = Math.round((eastEdge - westEdge) / scaleX);
  const height = Math.round((southEdge - northEdge) / scaleY);
  if (width <= 0 || height <= 0) throw new Error(`${label} pieces did not form a grid.`);

  const values = new Int16Array(width * height).fill(fillValue);
  for (const piece of pieces) {
    const offsetX = Math.round((piece.transform.originX - westEdge) / scaleX);
    const offsetY = Math.round((piece.transform.originY - northEdge) / scaleY);
    for (let row = 0; row < piece.height; row++) {
      const targetRow = offsetY + row;
      if (targetRow < 0 || targetRow >= height) continue;
      for (let column = 0; column < piece.width; column++) {
        const targetColumn = offsetX + column;
        if (targetColumn < 0 || targetColumn >= width) continue;
        values[targetRow * width + targetColumn] = piece.values[row * piece.width + column];
      }
    }
  }
  return {
    width,
    height,
    values,
    transform: { originX: westEdge, originY: northEdge, scaleX, scaleY },
  };
}

/**
 * Fetch the fuel grid as a mosaic of bounded sub-requests and stitch them into one
 * raster.
 */
export async function fetchFuelRaster(
  box: MercatorBox,
  signal: AbortSignal,
): Promise<DecodedRaster> {
  const boxes = chunkBoxes(box);
  const pieces = await mapWithLimit(boxes, MAX_PARALLEL_REQUESTS, async (piece) =>
    decodeGeoTiff(
      await abortable(sharedCoverage(coverageUrl(LANDFIRE_COVERAGE, piece), "fuel"), signal),
    ),
  );
  return stitchPieces(pieces, FUEL_NO_DATA, "Fuel data");
}

/**
 * LANDFIRE publishes the canopy layers as scaled 16-bit integers, not SI floats. The scale
 * factors below were measured against the live LF2025 service rather than assumed:
 *
 *   Santa Cruz Mountains redwood/Douglas-fir (37.441, -122.317), 1.5 km box, 15876 cells:
 *     CBH raw 0..100  (modes 32, 33, 39, 41, 47)  -> /10  = 0.0..10.0 m base height
 *     CBD raw 0..34   (modes 22, 16, 11, 12)      -> /100 = 0.00..0.34 kg/m3
 *     CC  raw 0..85   (modes 75, 65, 55, 45)      -> /100 = 0..0.85 cover fraction
 *     CH  raw 0..430  (modes 230, 190, 270, 310)  -> /10  = 0.0..43.0 m stand height
 *   Carrizo Plain grassland (35.19, -119.80), 1.5 km box, 15129 cells:
 *     every canopy layer is exactly 0 while FBFM40 reads 99/121/122 grass and bare ground.
 *
 * Raw CBH/CH an order of magnitude above a real canopy and raw CBD two orders above a real
 * bulk density is the signature of decimetres and kg/m3 x 100; after scaling, a 43 m
 * redwood stand with a 3-5 m crown base and 0.16-0.22 kg/m3 bulk density is the right shape
 * for the stand type. Canopy cover is already a percentage.
 */
const CANOPY_DECIMETERS_PER_METER = 10;
const CANOPY_BULK_DENSITY_SCALE = 100;
const PERCENT_PER_UNIT_FRACTION = 100;

/**
 * LANDFIRE fill values. -9999 covers ocean and everything outside CONUS; 32767 has been
 * observed from this service as well, and both must read as missing rather than as zero
 * canopy. Any negative value is treated the same way: the canopy layers are nonnegative.
 */
const CANOPY_NO_DATA = -9999;
const CANOPY_ALTERNATE_NO_DATA = 32767;

function isCanopyNoData(raw: number): boolean {
  return raw < 0 || raw === CANOPY_ALTERNATE_NO_DATA;
}

/**
 * Physical ceilings used to catch a vintage published at a different scale. A genuine
 * reading never approaches these, so a raster that puts a meaningful share of cells above
 * one is rejected outright instead of feeding the crown model numbers off by 10x.
 */
const CANOPY_LIMITS = {
  canopyBaseHeight: 30,
  canopyBulkDensity: 1,
  canopyCover: 1,
  canopyHeight: 120,
} as const;
const MAX_IMPLAUSIBLE_FRACTION = 0.005;
/** Above this share of fuel-mapped cells without canopy data, crown fire is not modelled. */
const MAX_MISSING_CANOPY_FRACTION = 0.01;
/** Mercator metres of origin drift still counted as the same lattice. */
const GRID_ALIGNMENT_TOLERANCE_METERS = 1;

type CanopyLayer = keyof typeof LANDFIRE_CANOPY_COVERAGES;
const CANOPY_LAYERS = Object.keys(LANDFIRE_CANOPY_COVERAGES) as CanopyLayer[];
const CANOPY_SCALES: Record<CanopyLayer, number> = {
  canopyBaseHeight: CANOPY_DECIMETERS_PER_METER,
  canopyBulkDensity: CANOPY_BULK_DENSITY_SCALE,
  canopyCover: PERCENT_PER_UNIT_FRACTION,
  canopyHeight: CANOPY_DECIMETERS_PER_METER,
};

export interface CanopyGrids {
  canopyBaseHeightMeters: Float32Array;
  canopyBulkDensityKgPerM3: Float32Array;
  canopyCoverFraction: Float32Array;
  canopyHeightMeters: Float32Array;
  canopyComplete: boolean;
}

function emptyCanopy(cellCount: number): CanopyGrids {
  return {
    canopyBaseHeightMeters: new Float32Array(cellCount),
    canopyBulkDensityKgPerM3: new Float32Array(cellCount),
    canopyCoverFraction: new Float32Array(cellCount),
    canopyHeightMeters: new Float32Array(cellCount),
    canopyComplete: false,
  };
}

/**
 * Put a canopy raster on the fuel raster's exact cell addressing. The service returns the
 * same lattice for the same bounding box, which is the fast path; if it ever does not, the
 * cells are resampled nearest-neighbour by Mercator position so index `i` still means the
 * same ground as `fuelCodes[i]`, instead of silently shifting the whole layer.
 */
function alignToFuelGrid(source: DecodedRaster, fuel: DecodedRaster, label: string): Int16Array {
  const sameLattice =
    source.width === fuel.width &&
    source.height === fuel.height &&
    source.transform.scaleX === fuel.transform.scaleX &&
    source.transform.scaleY === fuel.transform.scaleY &&
    Math.abs(source.transform.originX - fuel.transform.originX) <=
      GRID_ALIGNMENT_TOLERANCE_METERS &&
    Math.abs(source.transform.originY - fuel.transform.originY) <=
      GRID_ALIGNMENT_TOLERANCE_METERS;
  if (sameLattice) return source.values;

  console.warn(
    `LANDFIRE returned ${label} on a ${source.width}x${source.height} grid for a ` +
      `${fuel.width}x${fuel.height} fuel grid; resampling onto the fuel cells.`,
  );
  const aligned = new Int16Array(fuel.width * fuel.height).fill(CANOPY_NO_DATA);
  for (let row = 0; row < fuel.height; row++) {
    const mercatorY = fuel.transform.originY + (row + 0.5) * fuel.transform.scaleY;
    const sourceRow = Math.floor((mercatorY - source.transform.originY) / source.transform.scaleY);
    if (sourceRow < 0 || sourceRow >= source.height) continue;
    for (let column = 0; column < fuel.width; column++) {
      const mercatorX = fuel.transform.originX + (column + 0.5) * fuel.transform.scaleX;
      const sourceColumn = Math.floor(
        (mercatorX - source.transform.originX) / source.transform.scaleX,
      );
      if (sourceColumn < 0 || sourceColumn >= source.width) continue;
      aligned[row * fuel.width + column] = source.values[sourceRow * source.width + sourceColumn];
    }
  }
  return aligned;
}

/**
 * Convert one aligned raster to SI, counting the cells that carry no canopy reading where
 * the fuel layer does have data. No-data cells are left at 0 here; the caller decides
 * whether enough of them are missing to disqualify the whole canopy set.
 */
function scaleCanopyLayer(
  raw: Int16Array,
  fuelCodes: Int16Array,
  layer: CanopyLayer,
): { values: Float32Array; missing: number; mapped: number; implausible: number } {
  const scale = CANOPY_SCALES[layer];
  const limit = CANOPY_LIMITS[layer];
  const values = new Float32Array(raw.length);
  let missing = 0;
  let mapped = 0;
  let implausible = 0;
  for (let i = 0; i < raw.length; i++) {
    const fuelMapped = fuelCodes[i] !== FUEL_NO_DATA;
    if (fuelMapped) mapped++;
    if (isCanopyNoData(raw[i])) {
      if (fuelMapped) missing++;
      continue;
    }
    const scaled = raw[i] / scale;
    if (scaled > limit) {
      implausible++;
      values[i] = limit;
      continue;
    }
    values[i] = scaled;
  }
  return { values, missing, mapped, implausible };
}

/**
 * Fetch all four canopy coverages for the fuel raster's box. Every sub-request of every
 * coverage goes through the same chunking, bounded retry and in-flight de-duplication as
 * the fuel raster, and they share one concurrency budget so four layers do not multiply
 * the load on the service.
 */
async function fetchCanopyRasters(
  box: MercatorBox,
  signal: AbortSignal,
): Promise<Record<CanopyLayer, DecodedRaster>> {
  const boxes = chunkBoxes(box);
  const jobs = CANOPY_LAYERS.flatMap((layer) =>
    boxes.map((piece) => ({ layer, piece }) as const),
  );
  const decoded = await mapWithLimit(jobs, MAX_PARALLEL_REQUESTS, async ({ layer, piece }) =>
    decodeGeoTiff(
      await abortable(
        sharedCoverage(coverageUrl(LANDFIRE_CANOPY_COVERAGES[layer], piece), "canopy"),
        signal,
      ),
    ),
  );

  const rasters = {} as Record<CanopyLayer, DecodedRaster>;
  for (let i = 0; i < CANOPY_LAYERS.length; i++) {
    const layer = CANOPY_LAYERS[i];
    const pieces = decoded.slice(i * boxes.length, (i + 1) * boxes.length);
    rasters[layer] = stitchPieces(pieces, CANOPY_NO_DATA, `Canopy ${layer}`);
  }
  return rasters;
}

/**
 * Canopy inputs aligned cell for cell with `fuel`. A canopy failure degrades the run to
 * surface fire rather than ending it: the arrays come back zeroed with `canopyComplete`
 * false, which the caller must treat as "unknown canopy", not as treeless ground.
 */
async function sampleCanopy(
  fuel: DecodedRaster,
  box: MercatorBox,
  signal: AbortSignal,
): Promise<CanopyGrids> {
  const cellCount = fuel.width * fuel.height;
  let rasters: Record<CanopyLayer, DecodedRaster>;
  try {
    rasters = await fetchCanopyRasters(box, signal);
  } catch (cause) {
    // An abort is the caller withdrawing, not a data problem, so it still propagates.
    if (signal.aborted) throw cause;
    console.warn("LANDFIRE canopy layers are unavailable; crown fire is not modelled.", cause);
    return emptyCanopy(cellCount);
  }

  const scaled = {} as Record<CanopyLayer, ReturnType<typeof scaleCanopyLayer>>;
  let complete = true;
  for (const layer of CANOPY_LAYERS) {
    const aligned = alignToFuelGrid(rasters[layer], fuel, LANDFIRE_CANOPY_COVERAGES[layer]);
    const result = scaleCanopyLayer(aligned, fuel.values, layer);
    scaled[layer] = result;
    if (result.implausible > result.values.length * MAX_IMPLAUSIBLE_FRACTION) {
      console.warn(
        `${LANDFIRE_CANOPY_COVERAGES[layer]} returned ${result.implausible} cells above ` +
          `${CANOPY_LIMITS[layer]} after scaling by ${CANOPY_SCALES[layer]}; the published ` +
          "scale factor has changed, so crown fire is not modelled.",
      );
      complete = false;
    }
    if (result.mapped > 0 && result.missing > result.mapped * MAX_MISSING_CANOPY_FRACTION) {
      console.warn(
        `${LANDFIRE_CANOPY_COVERAGES[layer]} has no data for ${result.missing} of ` +
          `${result.mapped} fuel-mapped cells; crown fire is not modelled.`,
      );
      complete = false;
    }
  }
  if (!complete) return emptyCanopy(cellCount);

  return {
    canopyBaseHeightMeters: scaled.canopyBaseHeight.values,
    canopyBulkDensityKgPerM3: scaled.canopyBulkDensity.values,
    canopyCoverFraction: scaled.canopyCover.values,
    canopyHeightMeters: scaled.canopyHeight.values,
    canopyComplete: true,
  };
}

/** Decode one terrarium tile to metres: elevation = R * 256 + G + B / 256 - 32768. */
async function fetchTerrainTile(
  x: number,
  y: number,
  signal: AbortSignal,
): Promise<Float32Array | null> {
  const response = await fetch(`${TERRAIN_TILE_URL}/${TERRAIN_ZOOM}/${x}/${y}.png`, { signal });
  if (!response.ok) return null;
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Cannot read terrain tiles without a 2D canvas context.");
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data } = context.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
  const elevations = new Float32Array(TILE_SIZE * TILE_SIZE);
  for (let i = 0; i < elevations.length; i++) {
    elevations[i] = data[i * 4] * 256 + data[i * 4 + 1] + data[i * 4 + 2] / 256 - 32768;
  }
  return elevations;
}

async function sampleElevation(
  raster: DecodedRaster,
  signal: AbortSignal,
): Promise<{ elevation: Float32Array; complete: boolean }> {
  const { width, height, transform } = raster;
  const tileSpan = EARTH_CIRCUMFERENCE_METERS / 2 ** TERRAIN_ZOOM;
  const tileIndex = (mercator: number, flip: boolean) =>
    Math.floor(
      (flip ? MERCATOR_ORIGIN_SHIFT - mercator : mercator + MERCATOR_ORIGIN_SHIFT) / tileSpan,
    );

  const needed = new Map<string, Promise<Float32Array | null>>();
  const tileKey = (tx: number, ty: number) => `${tx}/${ty}`;
  const corners: [number, number][] = [
    [transform.originX, transform.originY],
    [transform.originX + width * transform.scaleX, transform.originY + height * transform.scaleY],
  ];
  const txs = corners.map(([x]) => tileIndex(x, false));
  const tys = corners.map(([, y]) => tileIndex(y, true));
  for (let tx = Math.min(...txs); tx <= Math.max(...txs); tx++) {
    for (let ty = Math.min(...tys); ty <= Math.max(...tys); ty++) {
      needed.set(tileKey(tx, ty), fetchTerrainTile(tx, ty, signal));
    }
  }
  const tiles = new Map<string, Float32Array | null>();
  await Promise.all(
    [...needed].map(async ([key, promise]) => {
      tiles.set(key, await promise);
    }),
  );

  const elevation = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    const mercatorY = transform.originY + (row + 0.5) * transform.scaleY;
    const globalY = (MERCATOR_ORIGIN_SHIFT - mercatorY) / tileSpan;
    const ty = Math.floor(globalY);
    const pixelY = Math.min(Math.floor((globalY - ty) * TILE_SIZE), TILE_SIZE - 1);
    for (let column = 0; column < width; column++) {
      const mercatorX = transform.originX + (column + 0.5) * transform.scaleX;
      const globalX = (mercatorX + MERCATOR_ORIGIN_SHIFT) / tileSpan;
      const tx = Math.floor(globalX);
      const pixelX = Math.min(Math.floor((globalX - tx) * TILE_SIZE), TILE_SIZE - 1);
      const tile = tiles.get(tileKey(tx, ty));
      elevation[row * width + column] = tile ? tile[pixelY * TILE_SIZE + pixelX] : 0;
    }
  }
  // A missing tile would otherwise read as sea level, which silently flattens the slope.
  const complete = [...tiles.values()].every((tile) => tile !== null);
  return { elevation, complete };
}

/** Horn's method: slope and aspect from the 8 neighbours of each cell. */
export function slopeAndAspect(
  elevation: Float32Array,
  width: number,
  height: number,
  groundCellSizeMeters: number,
): { slopeTangent: Float32Array; upslopeDegrees: Float32Array } {
  const slopeTangent = new Float32Array(width * height);
  const upslopeDegrees = new Float32Array(width * height);
  const at = (x: number, y: number) =>
    elevation[Math.min(Math.max(y, 0), height - 1) * width + Math.min(Math.max(x, 0), width - 1)];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = at(x - 1, y - 1),
        b = at(x, y - 1),
        c = at(x + 1, y - 1);
      const d = at(x - 1, y),
        f = at(x + 1, y);
      const g = at(x - 1, y + 1),
        h = at(x, y + 1),
        i = at(x + 1, y + 1);
      // Grid rows run north to south, so dz/dy is negated to point north.
      const dzdx = (c + 2 * f + i - (a + 2 * d + g)) / (8 * groundCellSizeMeters);
      const dzdy = (a + 2 * b + c - (g + 2 * h + i)) / (8 * groundCellSizeMeters);
      const index = y * width + x;
      slopeTangent[index] = Math.hypot(dzdx, dzdy);
      // Uphill points opposite the gradient descent direction.
      upslopeDegrees[index] = ((Math.atan2(dzdx, dzdy) * 180) / Math.PI + 360) % 360;
    }
  }
  return { slopeTangent, upslopeDegrees };
}

/** Options for `loadLandscape`. */
export interface LandscapeLoadOptions {
  /**
   * Requested ground cell size in metres: 30 (LANDFIRE native) or a coarser multiple used
   * for large areas so the grid stays browser-sized. Coarser cells resample fuel codes by
   * nearest neighbour and lose detail; callers must disclose the resolution.
   */
  cellMeters?: number;
}

/** Largest grid side (cells) the page and solver are expected to handle interactively. */
export const MAX_GRID_CELLS_PER_SIDE = 900;

/**
 * Coarsest-needed cell size for a square of the given ground radius: native 30 m when it
 * fits within `MAX_GRID_CELLS_PER_SIDE`, otherwise the next multiple of 30 m that does.
 */
export function landscapeCellMetersFor(groundRadiusMeters: number): number {
  const needed = (2 * groundRadiusMeters) / MAX_GRID_CELLS_PER_SIDE;
  return Math.max(30, Math.ceil(needed / 30) * 30);
}

export async function loadLandscape(
  longitude: number,
  latitude: number,
  groundRadiusMeters: number,
  signal: AbortSignal,
  // Accepted now so callers can pass it; coarse resampling is implemented separately.
  _options: LandscapeLoadOptions = {},
): Promise<LandscapeGrid> {
  const box = boxAround(longitude, latitude, groundRadiusMeters);
  const raster = await fetchFuelRaster(box, signal);
  // Different hosts, so the terrain tiles and the canopy coverages overlap in time.
  const [{ elevation: elevationMeters, complete: elevationComplete }, canopy] = await Promise.all([
    sampleElevation(raster, signal),
    sampleCanopy(raster, box, signal),
  ]);
  const mercatorCell = Math.abs(raster.transform.scaleX);
  const groundCellSizeMeters = mercatorCell * Math.cos(latitude * RADIANS_PER_DEGREE);
  const { slopeTangent, upslopeDegrees } = slopeAndAspect(
    elevationMeters,
    raster.width,
    raster.height,
    groundCellSizeMeters,
  );
  return {
    width: raster.width,
    height: raster.height,
    originX: raster.transform.originX + raster.transform.scaleX / 2,
    originY: raster.transform.originY + raster.transform.scaleY / 2,
    cellSizeX: raster.transform.scaleX,
    cellSizeY: raster.transform.scaleY,
    groundCellSizeMeters,
    elevationComplete,
    fuelCodes: raster.values,
    elevationMeters,
    slopeTangent,
    upslopeDegrees,
    canopyBaseHeightMeters: canopy.canopyBaseHeightMeters,
    canopyBulkDensityKgPerM3: canopy.canopyBulkDensityKgPerM3,
    canopyCoverFraction: canopy.canopyCoverFraction,
    canopyHeightMeters: canopy.canopyHeightMeters,
    canopyComplete: canopy.canopyComplete,
    attribution: {
      fuel: LANDFIRE_ATTRIBUTION,
      terrain: TERRAIN_ATTRIBUTION,
      canopy: LANDFIRE_CANOPY_ATTRIBUTION,
    },
  };
}
