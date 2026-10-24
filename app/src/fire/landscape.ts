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
  attribution: { fuel: string; terrain: string };
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
async function fetchCoverageWithRetry(url: string): Promise<ArrayBuffer> {
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
          "LANDFIRE has no fuel data for this area. Coverage is limited to the contiguous United States.",
          404,
        );
      } else if (response.status < 500 && response.status !== 429) {
        throw new UpstreamError(
          `LANDFIRE rejected the fuel data request (${response.status}).`,
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
      ? "Could not reach the LANDFIRE fuel service. Check the network connection and try again."
      : `The LANDFIRE fuel service is failing (${lastStatus}) after ${MAX_FUEL_ATTEMPTS} attempts. Try again in a moment.`,
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

function sharedCoverage(url: string): Promise<ArrayBuffer> {
  const existing = inFlightCoverage.get(url);
  if (existing) return existing;
  const request = fetchCoverageWithRetry(url).finally(() => inFlightCoverage.delete(url));
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

function coverageUrl(box: MercatorBox): string {
  return (
    `${LANDFIRE_WCS_URL}?service=WCS&version=2.0.1&request=GetCoverage` +
    `&coverageId=${LANDFIRE_COVERAGE}` +
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

/**
 * Fetch the fuel grid as a mosaic of bounded sub-requests and stitch them into one
 * raster. All pieces sit on the same 30 m Mercator lattice, so offsets are whole cells.
 */
export async function fetchFuelRaster(
  box: MercatorBox,
  signal: AbortSignal,
): Promise<DecodedRaster> {
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

  const pieces = await mapWithLimit(boxes, MAX_PARALLEL_REQUESTS, async (piece) =>
    decodeGeoTiff(await abortable(sharedCoverage(coverageUrl(piece)), signal)),
  );
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
  if (width <= 0 || height <= 0) throw new Error("Fuel data pieces did not form a grid.");

  const values = new Int16Array(width * height).fill(FUEL_NO_DATA);
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

export async function loadLandscape(
  longitude: number,
  latitude: number,
  groundRadiusMeters: number,
  signal: AbortSignal,
): Promise<LandscapeGrid> {
  const box = boxAround(longitude, latitude, groundRadiusMeters);
  const raster = await fetchFuelRaster(box, signal);
  const { elevation: elevationMeters, complete: elevationComplete } = await sampleElevation(
    raster,
    signal,
  );
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
    attribution: { fuel: LANDFIRE_ATTRIBUTION, terrain: TERRAIN_ATTRIBUTION },
  };
}
