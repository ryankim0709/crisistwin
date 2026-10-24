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
  /**
   * Nominal cell size the grid was built at, metres. 30 means LANDFIRE's own lattice (30
   * Mercator metres, so `groundCellSizeMeters` is 30 x cos(latitude), 23.7 m at Berkeley).
   * Anything larger is a coarser lattice whose ground cell is exactly this many metres
   * (`groundCellSizeMeters` equals it up to rounding) and whose inputs were resampled.
   */
  cellMeters: number;
  /**
   * How fuel codes reached the grid. "native": LANDFIRE cells as published. "mode": each
   * coarse cell takes the most frequent fuel code among a regular grid of native-raster
   * samples inside it (about 3 x 3, never sparser than one per 57 Mercator metres); canopy
   * is the mean over the samples carrying that fuel code, terrain the mean of the terrain
   * pixels inside the cell. "nearest" (one sample per cell) is reserved for other
   * producers; `loadLandscape` does not emit it. See docs/adr/0012-fire-large-areas.md.
   */
  resampling: LandscapeResampling;
  attribution: { fuel: string; terrain: string; canopy: string };
}

export type LandscapeResampling = "native" | "mode" | "nearest";

export const EARTH_CIRCUMFERENCE_METERS = 40075016.68557849;
const MERCATOR_ORIGIN_SHIFT = EARTH_CIRCUMFERENCE_METERS / 2;
const RADIANS_PER_DEGREE = Math.PI / 180;

/**
 * Same-origin path, proxied to https://edcintl.cr.usgs.gov/geoserver/landfire by the Vite
 * dev server and by Nginx in the built image. The upstream advertises permissive CORS but
 * browser requests to it still fail, so the proxy is required, not a convenience.
 */
export const LANDFIRE_WCS_URL = "/landfire/wcs";
/** The service the proxy forwards to, for callers outside the browser (Node build tools). */
export const LANDFIRE_UPSTREAM_WCS_URL = "https://edcintl.cr.usgs.gov/geoserver/landfire/wcs";
/**
 * Identifies this application to the data services. The USGS web application firewall
 * blocks requests that look like cross-site browser traffic, so a Node caller going to
 * `LANDFIRE_UPSTREAM_WCS_URL` directly should send this and no browser headers; the Vite
 * proxy sets the same value (app/vite.config.ts).
 */
export const LANDFIRE_USER_AGENT = "CrisisTwin/0.1 (hackathon planning prototype)";
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

/**
 * Where the loader fetches from. Every field is optional and the defaults are the browser
 * path: the same-origin LANDFIRE proxy, the public terrain bucket, `globalThis.fetch`, and
 * no extra headers. A Node caller (no Vite proxy) passes `LANDFIRE_UPSTREAM_WCS_URL` and
 * `LANDFIRE_USER_AGENT`.
 */
export interface LandscapeEndpoints {
  /** LANDFIRE GeoServer WCS endpoint. Default `LANDFIRE_WCS_URL` ("/landfire/wcs"). */
  landfireWcsUrl?: string;
  /** Terrarium tile root, `{root}/{z}/{x}/{y}.png`. Default `TERRAIN_TILE_URL`. */
  terrainTileUrl?: string;
  /** Fetch implementation. Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Sent as the User-Agent header on every request when set. Browsers may ignore it. */
  userAgent?: string;
}

interface DataSource {
  wcsUrl: string;
  terrainUrl: string;
  fetch: typeof fetch;
  headers: Record<string, string>;
}

function resolveSource(endpoints: LandscapeEndpoints = {}): DataSource {
  const custom = endpoints.fetch;
  return {
    wcsUrl: endpoints.landfireWcsUrl ?? LANDFIRE_WCS_URL,
    terrainUrl: endpoints.terrainTileUrl ?? TERRAIN_TILE_URL,
    // Called unbound, so wrap the global rather than storing it (browsers throw "Illegal
    // invocation" for a detached `fetch`).
    fetch: custom ?? ((input, init) => globalThis.fetch(input, init)),
    headers: endpoints.userAgent ? { "User-Agent": endpoints.userAgent } : {},
  };
}

const DEFAULT_SOURCE = resolveSource();

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
async function fetchCoverageWithRetry(
  url: string,
  subject: string,
  source: DataSource,
): Promise<ArrayBuffer> {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= MAX_FUEL_ATTEMPTS; attempt++) {
    let retryAfterMs: number | null = null;
    try {
      const response = await source.fetch(url, { headers: source.headers });
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

function sharedCoverage(url: string, subject: string, source: DataSource): Promise<ArrayBuffer> {
  const existing = inFlightCoverage.get(url);
  if (existing) return existing;
  const request = fetchCoverageWithRetry(url, subject, source).finally(() =>
    inFlightCoverage.delete(url),
  );
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
/**
 * Overlap between neighbouring sub-requests, Mercator metres. Measured: the LF2025 WCS
 * rounds each request's edges onto its 30 m lattice independently, so abutting requests can
 * come back one cell apart (a full row or column of no-data, which the solver treats as a
 * firebreak). Two cells of overlap covers that one-cell rounding with margin.
 */
const CHUNK_OVERLAP_METERS = 2 * FUEL_CELL_METERS;

/**
 * GetCoverage URL for one box. With `scaleSize` the service resamples to exactly that many
 * columns and rows itself (WCS 2.0 scaling extension), nearest neighbour, which is the only
 * interpolation that keeps a categorical fuel code a real fuel code.
 */
function coverageUrl(
  coverageId: string,
  box: MercatorBox,
  source: DataSource,
  scaleSize?: { columns: number; rows: number },
): string {
  const scaling = scaleSize
    ? `&scalesize=i(${scaleSize.columns}),j(${scaleSize.rows})` +
      `&interpolation=http://www.opengis.net/def/interpolation/OGC/1/nearest-neighbor`
    : "";
  return (
    `${source.wcsUrl}?service=WCS&version=2.0.1&request=GetCoverage` +
    `&coverageId=${coverageId}` +
    `&subset=X(${box.minX.toFixed(2)},${box.maxX.toFixed(2)})` +
    `&subset=Y(${box.minY.toFixed(2)},${box.maxY.toFixed(2)})` +
    scaling +
    `&format=image/tiff`
  );
}

/**
 * Run `run` over `items` with at most `limit` in flight. Stops launching new work once
 * `signal` aborts, so a withdrawn load does not keep issuing requests from its queue.
 */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let index = next++; index < items.length; index = next++) {
        if (signal?.aborted) throw abortError(signal);
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
      // Interior edges overlap so the server's per-request edge rounding cannot leave a
      // one-cell seam of no-data between neighbours; outer edges stay where requested.
      boxes.push({
        minX: box.minX + column * chunkWidth - (column > 0 ? CHUNK_OVERLAP_METERS : 0),
        maxX:
          box.minX + (column + 1) * chunkWidth + (column < columns - 1 ? CHUNK_OVERLAP_METERS : 0),
        minY: box.minY + row * chunkHeight - (row > 0 ? CHUNK_OVERLAP_METERS : 0),
        maxY:
          box.minY + (row + 1) * chunkHeight + (row < rows - 1 ? CHUNK_OVERLAP_METERS : 0),
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
  source: DataSource = DEFAULT_SOURCE,
): Promise<DecodedRaster> {
  const boxes = chunkBoxes(box);
  const pieces = await mapWithLimit(
    boxes,
    MAX_PARALLEL_REQUESTS,
    async (piece) =>
      decodeGeoTiff(
        await abortable(
          sharedCoverage(coverageUrl(LANDFIRE_COVERAGE, piece, source), "fuel", source),
          signal,
        ),
      ),
    signal,
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
  // NaN is how a resampled layer marks a coarse cell with no usable canopy sample.
  return raw < 0 || raw === CANOPY_ALTERNATE_NO_DATA || Number.isNaN(raw);
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
  raw: ArrayLike<number>,
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
  source: DataSource,
): Promise<Record<CanopyLayer, DecodedRaster>> {
  const boxes = chunkBoxes(box);
  const jobs = CANOPY_LAYERS.flatMap((layer) =>
    boxes.map((piece) => ({ layer, piece }) as const),
  );
  const decoded = await mapWithLimit(
    jobs,
    MAX_PARALLEL_REQUESTS,
    async ({ layer, piece }) =>
      decodeGeoTiff(
        await abortable(
          sharedCoverage(
            coverageUrl(LANDFIRE_CANOPY_COVERAGES[layer], piece, source),
            "canopy",
            source,
          ),
          signal,
        ),
      ),
    signal,
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
  source: DataSource,
): Promise<CanopyGrids> {
  const cellCount = fuel.width * fuel.height;
  let rasters: Record<CanopyLayer, DecodedRaster>;
  try {
    rasters = await fetchCanopyRasters(box, signal, source);
  } catch (cause) {
    // An abort is the caller withdrawing, not a data problem, so it still propagates.
    if (signal.aborted) throw cause;
    console.warn("LANDFIRE canopy layers are unavailable; crown fire is not modelled.", cause);
    return emptyCanopy(cellCount);
  }
  const aligned = {} as Record<CanopyLayer, ArrayLike<number>>;
  for (const layer of CANOPY_LAYERS) {
    aligned[layer] = alignToFuelGrid(rasters[layer], fuel, LANDFIRE_CANOPY_COVERAGES[layer]);
  }
  return finishCanopy(aligned, fuel.values);
}

/**
 * Scale aligned raw canopy layers to SI and decide whether the set is usable. Shared by
 * the native and the resampled paths so both apply the same plausibility and coverage
 * tests.
 */
function finishCanopy(
  aligned: Record<CanopyLayer, ArrayLike<number>>,
  fuelCodes: Int16Array,
): CanopyGrids {
  const cellCount = fuelCodes.length;
  const scaled = {} as Record<CanopyLayer, ReturnType<typeof scaleCanopyLayer>>;
  let complete = true;
  for (const layer of CANOPY_LAYERS) {
    const result = scaleCanopyLayer(aligned[layer], fuelCodes, layer);
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

/**
 * Inflate a zlib stream with the platform's `DecompressionStream` ("deflate" is the zlib
 * wrapper), available in every current browser and in Node 18+, so terrain decoding needs
 * neither a canvas nor a dependency.
 */
async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/**
 * Minimal PNG reader for terrarium tiles: 8-bit greyscale-free colour types 2 (RGB),
 * 6 (RGBA) and 3 (palette), non-interlaced. Returns RGB triplets per pixel. Anything
 * else is rejected rather than misread, because a misread tile is a wrong elevation, not
 * a missing one.
 */
export async function decodePngRgb(
  buffer: ArrayBuffer,
): Promise<{ width: number; height: number; rgb: Uint8Array }> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length < 8 || PNG_SIGNATURE.some((value, i) => bytes[i] !== value)) {
    throw new Error("Terrain tile is not a PNG.");
  }
  let width = 0;
  let height = 0;
  let colourType = -1;
  let palette: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  for (let offset = 8; offset + 8 <= bytes.length; ) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      const bitDepth = body[8];
      colourType = body[9];
      const interlace = body[12];
      if (bitDepth !== 8 || interlace !== 0 || ![2, 3, 6].includes(colourType)) {
        throw new Error(
          `Unsupported terrain PNG (bit depth ${bitDepth}, colour type ${colourType}, interlace ${interlace}).`,
        );
      }
    } else if (type === "PLTE") {
      palette = body.slice();
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (width === 0 || height === 0 || idat.length === 0) throw new Error("Terrain PNG is empty.");
  if (colourType === 3 && !palette) throw new Error("Terrain PNG has no palette.");

  const compressed = new Uint8Array(idat.reduce((total, chunk) => total + chunk.length, 0));
  let cursor = 0;
  for (const chunk of idat) {
    compressed.set(chunk, cursor);
    cursor += chunk.length;
  }
  const raw = await inflateZlib(compressed);
  const channels = colourType === 2 ? 3 : colourType === 6 ? 4 : 1;
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error("Terrain PNG is truncated.");

  // Undo the per-row filters (PNG spec section 9) in place into `pixels`.
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const source = y * (stride + 1) + 1;
    const row = y * stride;
    const previous = row - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[source + x];
      const left = x >= channels ? pixels[row + x - channels] : 0;
      const up = y > 0 ? pixels[previous + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[previous + x - channels] : 0;
      let predictor: number;
      switch (filter) {
        case 0:
          predictor = 0;
          break;
        case 1:
          predictor = left;
          break;
        case 2:
          predictor = up;
          break;
        case 3:
          predictor = (left + up) >> 1;
          break;
        case 4: {
          const estimate = left + up - upLeft;
          const toLeft = Math.abs(estimate - left);
          const toUp = Math.abs(estimate - up);
          const toUpLeft = Math.abs(estimate - upLeft);
          predictor =
            toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
          break;
        }
        default:
          throw new Error(`Terrain PNG uses unknown row filter ${filter}.`);
      }
      pixels[row + x] = (value + predictor) & 0xff;
    }
  }

  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    if (colourType === 3) {
      const entry = pixels[i] * 3;
      rgb[i * 3] = palette![entry];
      rgb[i * 3 + 1] = palette![entry + 1];
      rgb[i * 3 + 2] = palette![entry + 2];
    } else {
      rgb[i * 3] = pixels[i * channels];
      rgb[i * 3 + 1] = pixels[i * channels + 1];
      rgb[i * 3 + 2] = pixels[i * channels + 2];
    }
  }
  return { width, height, rgb };
}

/** Decode one terrarium tile to metres: elevation = R * 256 + G + B / 256 - 32768. */
async function fetchTerrainTile(
  zoom: number,
  x: number,
  y: number,
  signal: AbortSignal,
  source: DataSource,
): Promise<Float32Array | null> {
  const response = await source.fetch(`${source.terrainUrl}/${zoom}/${x}/${y}.png`, {
    signal,
    headers: source.headers,
  });
  if (!response.ok) return null;
  const { width, height, rgb } = await decodePngRgb(await response.arrayBuffer());
  if (width !== TILE_SIZE || height !== TILE_SIZE) {
    throw new Error(`Terrain tile ${zoom}/${x}/${y} is ${width}x${height}, expected ${TILE_SIZE}.`);
  }
  const elevations = new Float32Array(TILE_SIZE * TILE_SIZE);
  for (let i = 0; i < elevations.length; i++) {
    elevations[i] = rgb[i * 3] * 256 + rgb[i * 3 + 1] + rgb[i * 3 + 2] / 256 - 32768;
  }
  return elevations;
}

/** Concurrent terrain tile downloads; a different host from LANDFIRE. */
const MAX_PARALLEL_TILE_REQUESTS = 6;
/** Refuse a lattice that would need more terrain tiles than this, rather than download them. */
const MAX_TERRAIN_TILES = 256;

/** A grid's cells as Mercator edges and signed cell sizes; y decreases down the grid. */
interface Lattice {
  width: number;
  height: number;
  /** West edge of column 0 and north edge of row 0, Mercator metres. */
  westX: number;
  northY: number;
  cellX: number;
  /** Negative. */
  cellY: number;
}

function latticeOfRaster(raster: DecodedRaster): Lattice {
  return {
    width: raster.width,
    height: raster.height,
    westX: raster.transform.originX,
    northY: raster.transform.originY,
    cellX: raster.transform.scaleX,
    cellY: raster.transform.scaleY,
  };
}

/** Terrarium zoom whose pixels are no larger than the lattice cell, capped at the native 13. */
function terrainZoomFor(mercatorCellMeters: number): number {
  const zoom = Math.ceil(Math.log2(EARTH_CIRCUMFERENCE_METERS / (TILE_SIZE * mercatorCellMeters)));
  return Math.min(Math.max(zoom, 0), TERRAIN_ZOOM);
}

/**
 * Elevation per lattice cell. `average` false samples the pixel under each cell centre
 * (the native path, where a z13 pixel is smaller than a cell anyway). `average` true takes
 * the mean of every terrain pixel whose centre falls inside the cell, so a coarse cell's
 * elevation represents the cell rather than one point in it; a cell no pixel centre lands
 * in falls back to the pixel under its centre.
 */
async function sampleElevation(
  lattice: Lattice,
  zoom: number,
  average: boolean,
  signal: AbortSignal,
  source: DataSource,
): Promise<{ elevation: Float32Array; complete: boolean; tileCount: number }> {
  const { width, height, westX, northY, cellX, cellY } = lattice;
  const tileSpan = EARTH_CIRCUMFERENCE_METERS / 2 ** zoom;
  const pixelSpan = tileSpan / TILE_SIZE;
  const eastX = westX + width * cellX;
  const southY = northY + height * cellY;
  const minTx = Math.floor((westX + MERCATOR_ORIGIN_SHIFT) / tileSpan);
  const maxTx = Math.floor((eastX + MERCATOR_ORIGIN_SHIFT) / tileSpan);
  const minTy = Math.floor((MERCATOR_ORIGIN_SHIFT - northY) / tileSpan);
  const maxTy = Math.floor((MERCATOR_ORIGIN_SHIFT - southY) / tileSpan);
  const tileCount = (maxTx - minTx + 1) * (maxTy - minTy + 1);
  if (tileCount > MAX_TERRAIN_TILES) {
    throw new Error(`The area needs ${tileCount} terrain tiles at zoom ${zoom}; refusing.`);
  }

  const keys: [number, number][] = [];
  for (let tx = minTx; tx <= maxTx; tx++) {
    for (let ty = minTy; ty <= maxTy; ty++) keys.push([tx, ty]);
  }
  const loaded = await mapWithLimit(
    keys,
    MAX_PARALLEL_TILE_REQUESTS,
    ([tx, ty]) => fetchTerrainTile(zoom, tx, ty, signal, source),
    signal,
  );
  const tiles = new Map<string, Float32Array | null>();
  keys.forEach(([tx, ty], i) => tiles.set(`${tx}/${ty}`, loaded[i]));

  const pointSample = (mercatorX: number, mercatorY: number): number => {
    const globalX = (mercatorX + MERCATOR_ORIGIN_SHIFT) / tileSpan;
    const globalY = (MERCATOR_ORIGIN_SHIFT - mercatorY) / tileSpan;
    const tx = Math.floor(globalX);
    const ty = Math.floor(globalY);
    const pixelX = Math.min(Math.floor((globalX - tx) * TILE_SIZE), TILE_SIZE - 1);
    const pixelY = Math.min(Math.floor((globalY - ty) * TILE_SIZE), TILE_SIZE - 1);
    const tile = tiles.get(`${tx}/${ty}`);
    const value = tile ? tile[pixelY * TILE_SIZE + pixelX] : Number.NaN;
    return isPlausibleTerrainSample(value) ? value : Number.NaN;
  };

  const elevation = new Float32Array(width * height);
  if (average) {
    const sums = new Float64Array(width * height);
    const counts = new Uint32Array(width * height);
    for (const [tx, ty] of keys) {
      const tile = tiles.get(`${tx}/${ty}`);
      if (!tile) continue;
      for (let py = 0; py < TILE_SIZE; py++) {
        const mercatorY = MERCATOR_ORIGIN_SHIFT - (ty * TILE_SIZE + py + 0.5) * pixelSpan;
        const row = Math.floor((mercatorY - northY) / cellY);
        if (row < 0 || row >= height) continue;
        for (let px = 0; px < TILE_SIZE; px++) {
          const mercatorX = (tx * TILE_SIZE + px + 0.5) * pixelSpan - MERCATOR_ORIGIN_SHIFT;
          const column = Math.floor((mercatorX - westX) / cellX);
          if (column < 0 || column >= width) continue;
          const value = tile[py * TILE_SIZE + px];
          if (!isPlausibleTerrainSample(value)) continue;
          sums[row * width + column] += value;
          counts[row * width + column]++;
        }
      }
    }
    for (let row = 0; row < height; row++) {
      for (let column = 0; column < width; column++) {
        const index = row * width + column;
        elevation[index] =
          counts[index] > 0
            ? sums[index] / counts[index]
            : pointSample(westX + (column + 0.5) * cellX, northY + (row + 0.5) * cellY);
      }
    }
  } else {
    for (let row = 0; row < height; row++) {
      const mercatorY = northY + (row + 0.5) * cellY;
      for (let column = 0; column < width; column++) {
        elevation[row * width + column] = pointSample(westX + (column + 0.5) * cellX, mercatorY);
      }
    }
  }
  // Cells left NaN (missing tile, or only implausible samples) are filled by
  // `repairElevation` once the fuel codes are known. A missing tile still marks the
  // elevation incomplete, because the fill only interpolates over it.
  const complete = [...tiles.values()].every((tile) => tile !== null);
  return { elevation, complete, tileCount };
}

/**
 * Terrarium tiles carry artefacts at some coastlines: values down to -13,500 m near Point
 * Mugu and -12,700 m near Carpinteria, deeper than any ocean, which turned neighbouring
 * land cells into slope tangents near 70. Samples outside this range are treated as
 * missing before any averaging. The floor sits below any real bathymetry the board could
 * show near the coast, the ceiling above every summit.
 */
const MIN_PLAUSIBLE_TERRAIN_METERS = -500;
const MAX_PLAUSIBLE_TERRAIN_METERS = 9000;
/**
 * Lowest elevation accepted on land. Death Valley (-86 m) and the Salton Sea basin
 * (-70 m) are the lowest ground in the coverage; anything lower on a land cell is a
 * coastal artefact or bathymetry bleeding inland, and is refilled from its neighbours.
 */
const MIN_LAND_ELEVATION_METERS = -100;
/** FBFM40 open water; mirrors `NON_BURNABLE_CODES` in fuelModels.ts. */
const WATER_FUEL_CODE = 98;
/**
 * Share of land cells that may be filled from neighbours before the elevation is reported
 * incomplete. Up to 1 percent is a thin coastal fringe or a few artefact cells; more than
 * that means slope is interpolated over a meaningful part of the board.
 */
const MAX_FILLED_LAND_FRACTION = 0.01;
/** Neighbour-fill passes; each grows the filled area by one cell. */
const MAX_ELEVATION_FILL_PASSES = 64;

/** Repair in place; false when more than `MAX_FILLED_LAND_FRACTION` of land was filled. */
function repairedElevationComplete(
  elevation: Float32Array,
  fuelCodes: Int16Array,
  width: number,
  height: number,
): boolean {
  const { filledLandCells, landCells } = repairElevation(elevation, fuelCodes, width, height);
  if (filledLandCells > 0) {
    console.warn(
      `Terrain: filled ${filledLandCells} of ${landCells} land cells from neighbours ` +
        "(missing or implausible terrarium samples).",
    );
  }
  return filledLandCells <= landCells * MAX_FILLED_LAND_FRACTION;
}

function isPlausibleTerrainSample(value: number): boolean {
  return value >= MIN_PLAUSIBLE_TERRAIN_METERS && value <= MAX_PLAUSIBLE_TERRAIN_METERS;
}

/**
 * Make the elevation usable for slope, in place, given the fuel codes on the same cells.
 *
 * - Open water (98) is set to sea level when it is missing or below 0 m: the board and
 *   the slope model want the water surface, not bathymetry. Inland lakes above sea level
 *   keep their surface elevation.
 * - Unmapped cells (offshore, outside CONUS) are set to sea level when below 0 m.
 * - Land below `MIN_LAND_ELEVATION_METERS`, and any other missing cell, is filled with the
 *   mean of its valid 8-neighbours, repeated outward until every cell has a value
 *   (anything still missing after `MAX_ELEVATION_FILL_PASSES` becomes 0 m).
 *
 * Returns how many land cells (mapped, not water) had to be filled, out of how many.
 */
export function repairElevation(
  elevation: Float32Array,
  fuelCodes: Int16Array,
  width: number,
  height: number,
): { filledLandCells: number; landCells: number } {
  let landCells = 0;
  let filledLandCells = 0;
  for (let i = 0; i < elevation.length; i++) {
    const value = elevation[i];
    if (fuelCodes[i] === WATER_FUEL_CODE) {
      if (!(value >= 0)) elevation[i] = 0;
    } else if (fuelCodes[i] === FUEL_NO_DATA) {
      if (value < 0) elevation[i] = 0;
    } else {
      landCells++;
      // NaN (no plausible sample) fails this test too, so it is counted as filled.
      if (!(value >= MIN_LAND_ELEVATION_METERS)) {
        elevation[i] = Number.NaN;
        filledLandCells++;
      }
    }
  }

  let missing: number[] = [];
  for (let i = 0; i < elevation.length; i++) if (Number.isNaN(elevation[i])) missing.push(i);
  for (let pass = 0; pass < MAX_ELEVATION_FILL_PASSES && missing.length > 0; pass++) {
    // Values are computed from the state at the start of the pass, then written, so the
    // fill does not depend on scan order.
    const updates: [number, number][] = [];
    const still: number[] = [];
    for (const i of missing) {
      const x = i % width;
      const y = (i - x) / width;
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if ((dx === 0 && dy === 0) || nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const neighbour = elevation[ny * width + nx];
          if (Number.isNaN(neighbour)) continue;
          sum += neighbour;
          count++;
        }
      }
      if (count > 0) updates.push([i, sum / count]);
      else still.push(i);
    }
    for (const [i, value] of updates) elevation[i] = value;
    missing = still;
  }
  for (const i of missing) elevation[i] = 0;
  return { filledLandCells, landCells };
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
   * Requested ground cell size in metres. Omitted or at most 30 loads LANDFIRE's native
   * 30 m Mercator lattice unchanged. Anything larger builds a coarser lattice whose ground
   * cell is exactly this size (use `landscapeCellMetersFor`), resampling fuel by mode,
   * canopy by mean and terrain by mean (docs/adr/0012-fire-large-areas.md). The result's
   * `cellMeters` and `resampling` say which happened; callers must disclose it.
   */
  cellMeters?: number;
  /** Data endpoints; omit in the browser. See `LandscapeEndpoints`. */
  endpoints?: LandscapeEndpoints;
}

/** Largest grid side (cells) the page and solver are expected to handle interactively. */
export const MAX_GRID_CELLS_PER_SIDE = 900;

/**
 * Coarsest-needed cell size for a square of the given ground radius: native 30 m when it
 * fits within `MAX_GRID_CELLS_PER_SIDE`, otherwise the next multiple of 30 m that does.
 *
 * "Fits" is judged at a 30 m ground cell. The native lattice is 30 Mercator metres, which
 * is 30 x cos(latitude) on the ground, so a native grid near the bound comes out up to
 * 1/cos(latitude) wider (about 1013 cells for a 12 km radius at 38 degrees north).
 */
export function landscapeCellMetersFor(groundRadiusMeters: number): number {
  const needed = (2 * groundRadiusMeters) / MAX_GRID_CELLS_PER_SIDE;
  return Math.max(30, Math.ceil(needed / 30) * 30);
}

/**
 * Target samples per axis inside each coarse cell for the fuel mode: 3 x 3 = 9 votes, a
 * clear majority between two or three fuel types at 9 times the bytes of one nearest
 * sample. Finer than this buys little; the bound below can force more for very coarse
 * cells.
 */
const MODE_SAMPLES_PER_AXIS = 3;
/**
 * Widest sample spacing requested from the service, Mercator metres. Measured: once a
 * scaled request asks for more than twice the native 30 m spacing, this GeoServer reads
 * from its reduced-resolution overview instead of the 30 m raster, and the values it
 * returns no longer sit where the response's georeferencing says (a 4x request matched
 * the native raster at its own pixel centres on 45 percent of samples). Below 2x every
 * sample matched the native cell under its centre. 57 m keeps a margin under that switch.
 */
const MAX_SAMPLE_SPAN_METERS = 1.9 * FUEL_CELL_METERS;
/**
 * Output side of one scaled sub-request, samples. The service pads its TIFF to internal
 * tiles and cuts the body at 2 MiB; 512 x 512 came back as a compact 0.5 MB body when
 * measured, while 600 x 600 reached the 2 MiB cut.
 */
const SCALED_REQUEST_SAMPLES = 512;
/**
 * A corner of a native LANDFIRE FBFM40 cell in EPSG:3857, read from a GetCoverage
 * response. Every LF2025 layer used here shares this lattice; requests whose edges sit on
 * it are not snapped by the service, so the response grid is exactly the requested one.
 */
const LANDFIRE_LATTICE_CORNER = { x: -13605009.02476366, y: 4564600.4313384155 } as const;
/** Allowed drift between a scaled response's georeferencing and the request. */
const SCALED_TRANSFORM_TOLERANCE_METERS = 1;

/**
 * The coarse lattice, plus a regular sample grid aligned to the native lattice that
 * covers it, and which sample rows and columns fall inside each coarse cell (by sample
 * centre). Every layer is fetched on the same sample grid, so sample `k` of the canopy is
 * the same ground as sample `k` of the fuel.
 */
interface ResamplePlan {
  lattice: Lattice;
  sampleWestX: number;
  sampleNorthY: number;
  sampleSpan: number;
  sampleWidth: number;
  sampleHeight: number;
  pieces: { column: number; row: number; box: MercatorBox }[];
  /** Coarse column c owns sample columns [columnStart[c], columnStart[c + 1]). */
  columnStart: Int32Array;
  rowStart: Int32Array;
  /** Sample nearest each coarse cell's centre, the tie-breaker for the mode. */
  centreColumn: Int32Array;
  centreRow: Int32Array;
}

function planResample(
  longitude: number,
  latitude: number,
  groundRadiusMeters: number,
  cellMeters: number,
): ResamplePlan {
  const cosine = Math.cos(latitude * RADIANS_PER_DEGREE);
  const mercatorCell = cellMeters / cosine;
  const side = Math.max(1, Math.round((2 * groundRadiusMeters) / cellMeters));
  if (side > MAX_GRID_CELLS_PER_SIDE) {
    throw new Error(
      `A ${groundRadiusMeters} m radius at ${cellMeters} m cells is ${side} cells across, ` +
        `over the ${MAX_GRID_CELLS_PER_SIDE}-cell limit; use landscapeCellMetersFor.`,
    );
  }
  const [centerX, centerY] = lonLatToMercator(longitude, latitude);
  const lattice: Lattice = {
    width: side,
    height: side,
    westX: centerX - (side * mercatorCell) / 2,
    northY: centerY + (side * mercatorCell) / 2,
    cellX: mercatorCell,
    cellY: -mercatorCell,
  };

  // Native cells per piece side, so that the piece's 512 samples are spaced at about the
  // target span and the piece's edges fall on native cell boundaries.
  const targetSpan = Math.min(mercatorCell / MODE_SAMPLES_PER_AXIS, MAX_SAMPLE_SPAN_METERS);
  const nativePerPiece = Math.max(
    1,
    Math.floor((SCALED_REQUEST_SAMPLES * targetSpan) / FUEL_CELL_METERS),
  );
  const pieceSpan = nativePerPiece * FUEL_CELL_METERS;
  const sampleSpan = pieceSpan / SCALED_REQUEST_SAMPLES;
  const { x: cornerX, y: cornerY } = LANDFIRE_LATTICE_CORNER;
  const sampleWestX =
    cornerX + Math.floor((lattice.westX - cornerX) / FUEL_CELL_METERS) * FUEL_CELL_METERS;
  const sampleNorthY =
    cornerY + Math.ceil((lattice.northY - cornerY) / FUEL_CELL_METERS) * FUEL_CELL_METERS;
  const eastX = lattice.westX + side * mercatorCell;
  const southY = lattice.northY - side * mercatorCell;
  const piecesAcross = Math.ceil((eastX - sampleWestX) / pieceSpan);
  const piecesDown = Math.ceil((sampleNorthY - southY) / pieceSpan);
  // Pieces abut exactly and need no `CHUNK_OVERLAP_METERS`: every edge is on the native
  // lattice, so the service has nothing to round, and `fetchSampledCoverage` refuses any
  // response whose size, origin or spacing is not the requested one, so a seam cannot pass
  // silently. Overlapping them would also break the fixed piece-to-sample-grid offsets.
  const pieces: ResamplePlan["pieces"] = [];
  for (let row = 0; row < piecesDown; row++) {
    for (let column = 0; column < piecesAcross; column++) {
      const minX = sampleWestX + column * pieceSpan;
      const maxY = sampleNorthY - row * pieceSpan;
      pieces.push({
        column: column * SCALED_REQUEST_SAMPLES,
        row: row * SCALED_REQUEST_SAMPLES,
        box: { minX, maxX: minX + pieceSpan, minY: maxY - pieceSpan, maxY },
      });
    }
  }

  // Sample i's centre is at sampleWestX + (i + 0.5) * span; it belongs to the coarse cell
  // whose west edge it is at or past. Same along rows, measured southward.
  const start = (edgeOffset: number) => Math.ceil(edgeOffset / sampleSpan - 0.5);
  const columnStart = new Int32Array(side + 1);
  const rowStart = new Int32Array(side + 1);
  const centreColumn = new Int32Array(side);
  const centreRow = new Int32Array(side);
  for (let c = 0; c <= side; c++) {
    columnStart[c] = start(lattice.westX + c * mercatorCell - sampleWestX);
    rowStart[c] = start(sampleNorthY - (lattice.northY - c * mercatorCell));
  }
  for (let c = 0; c < side; c++) {
    centreColumn[c] = Math.floor((lattice.westX + (c + 0.5) * mercatorCell - sampleWestX) / sampleSpan);
    centreRow[c] = Math.floor((sampleNorthY - (lattice.northY - (c + 0.5) * mercatorCell)) / sampleSpan);
  }
  return {
    lattice,
    sampleWestX,
    sampleNorthY,
    sampleSpan,
    sampleWidth: piecesAcross * SCALED_REQUEST_SAMPLES,
    sampleHeight: piecesDown * SCALED_REQUEST_SAMPLES,
    pieces,
    columnStart,
    rowStart,
    centreColumn,
    centreRow,
  };
}

/** One coverage on the plan's sample grid, `fillValue` wherever nothing arrived. */
async function fetchSampledCoverage(
  coverageId: string,
  subject: string,
  plan: ResamplePlan,
  fillValue: number,
  signal: AbortSignal,
  source: DataSource,
): Promise<Int16Array> {
  const values = new Int16Array(plan.sampleWidth * plan.sampleHeight).fill(fillValue);
  const size = SCALED_REQUEST_SAMPLES;
  await mapWithLimit(
    plan.pieces,
    MAX_PARALLEL_REQUESTS,
    async (piece) => {
      const url = coverageUrl(coverageId, piece.box, source, { columns: size, rows: size });
      const raster = decodeGeoTiff(await abortable(sharedCoverage(url, subject, source), signal));
      const { originX, originY, scaleX, scaleY } = raster.transform;
      // Refuse anything but the grid we asked for: a shifted or rescaled response would
      // put every fuel code on the wrong ground without any visible sign of it.
      if (
        raster.width !== size ||
        raster.height !== size ||
        Math.abs(originX - piece.box.minX) > SCALED_TRANSFORM_TOLERANCE_METERS ||
        Math.abs(originY - piece.box.maxY) > SCALED_TRANSFORM_TOLERANCE_METERS ||
        Math.abs(scaleX - plan.sampleSpan) * size > SCALED_TRANSFORM_TOLERANCE_METERS ||
        Math.abs(-scaleY - plan.sampleSpan) * size > SCALED_TRANSFORM_TOLERANCE_METERS
      ) {
        throw new Error(
          `LANDFIRE returned ${subject} on a different grid than requested ` +
            `(${raster.width}x${raster.height} at ${scaleX.toFixed(3)} m from ` +
            `${originX.toFixed(1)}, ${originY.toFixed(1)}).`,
        );
      }
      for (let r = 0; r < size; r++) {
        const offset = (piece.row + r) * plan.sampleWidth + piece.column;
        values.set(raster.values.subarray(r * size, (r + 1) * size), offset);
      }
    },
    signal,
  );
  return values;
}

/**
 * Most frequent fuel code among the samples inside each coarse cell. Ties go to the code
 * of the sample nearest the cell centre when it is among the tied codes, otherwise to the
 * tied code seen first in row-major order, so the result is deterministic. No-data samples
 * vote like any other code: a cell mostly outside LANDFIRE coverage stays unmapped.
 */
function modeFuel(samples: Int16Array, plan: ResamplePlan): Int16Array {
  const { width, height } = plan.lattice;
  const out = new Int16Array(width * height);
  const votes: number[] = [];
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      votes.length = 0;
      for (let j = plan.rowStart[row]; j < plan.rowStart[row + 1]; j++) {
        const base = j * plan.sampleWidth;
        for (let i = plan.columnStart[column]; i < plan.columnStart[column + 1]; i++) {
          votes.push(samples[base + i]);
        }
      }
      const centre = samples[plan.centreRow[row] * plan.sampleWidth + plan.centreColumn[column]];
      let best = centre;
      let bestCount = 0;
      for (let k = 0; k < votes.length; k++) {
        let count = 0;
        for (let m = 0; m < votes.length; m++) if (votes[m] === votes[k]) count++;
        if (count > bestCount || (count === bestCount && votes[k] === centre && best !== centre)) {
          best = votes[k];
          bestCount = count;
        }
      }
      out[row * width + column] = best;
    }
  }
  return out;
}

/**
 * Mean raw canopy value over the samples in each coarse cell that carry the cell's chosen
 * fuel code. Averaging only over those samples keeps canopy consistent with the fuel bed
 * it sits over: a cell that came out as grass does not inherit the cover of the timber
 * samples it out-voted. NaN where no such sample has canopy data.
 */
function meanCanopyOverModeFuel(
  raw: Int16Array,
  sampleFuel: Int16Array,
  cellFuel: Int16Array,
  plan: ResamplePlan,
): Float32Array {
  const { width, height } = plan.lattice;
  const out = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const fuel = cellFuel[row * width + column];
      let sum = 0;
      let count = 0;
      for (let j = plan.rowStart[row]; j < plan.rowStart[row + 1]; j++) {
        const base = j * plan.sampleWidth;
        for (let i = plan.columnStart[column]; i < plan.columnStart[column + 1]; i++) {
          const value = raw[base + i];
          if (sampleFuel[base + i] !== fuel || isCanopyNoData(value)) continue;
          sum += value;
          count++;
        }
      }
      out[row * width + column] = count > 0 ? sum / count : Number.NaN;
    }
  }
  return out;
}

async function sampleCanopyResampled(
  sampleFuel: Int16Array,
  cellFuel: Int16Array,
  plan: ResamplePlan,
  signal: AbortSignal,
  source: DataSource,
): Promise<CanopyGrids> {
  const aligned = {} as Record<CanopyLayer, ArrayLike<number>>;
  try {
    // Sequential per layer; each layer's pieces already fill the shared request budget.
    for (const layer of CANOPY_LAYERS) {
      const raw = await fetchSampledCoverage(
        LANDFIRE_CANOPY_COVERAGES[layer],
        "canopy",
        plan,
        CANOPY_NO_DATA,
        signal,
        source,
      );
      aligned[layer] = meanCanopyOverModeFuel(raw, sampleFuel, cellFuel, plan);
    }
  } catch (cause) {
    if (signal.aborted) throw cause;
    console.warn("LANDFIRE canopy layers are unavailable; crown fire is not modelled.", cause);
    return emptyCanopy(cellFuel.length);
  }
  return finishCanopy(aligned, cellFuel);
}

function attribution(): LandscapeGrid["attribution"] {
  return {
    fuel: LANDFIRE_ATTRIBUTION,
    terrain: TERRAIN_ATTRIBUTION,
    canopy: LANDFIRE_CANOPY_ATTRIBUTION,
  };
}

/**
 * Load the fuel, canopy and terrain grid for a square of ground around a point.
 * `groundRadiusMeters` is the half-width of the square in ground metres. Coordinates are
 * WGS84 longitude then latitude.
 */
export async function loadLandscape(
  longitude: number,
  latitude: number,
  groundRadiusMeters: number,
  signal: AbortSignal,
  options: LandscapeLoadOptions = {},
): Promise<LandscapeGrid> {
  if (!(groundRadiusMeters > 0)) throw new Error("The landscape radius must be positive.");
  const requested = options.cellMeters;
  if (requested !== undefined && !(Number.isFinite(requested) && requested > 0)) {
    throw new Error(`Invalid landscape cell size ${requested} m.`);
  }
  const source = resolveSource(options.endpoints);
  if (requested === undefined || requested <= FUEL_CELL_METERS) {
    return loadNativeLandscape(
      boxAround(longitude, latitude, groundRadiusMeters),
      latitude,
      signal,
      source,
    );
  }

  const plan = planResample(longitude, latitude, groundRadiusMeters, requested);
  const { lattice } = plan;
  // Terrain is a different host, so it runs alongside the LANDFIRE requests.
  const terrain = sampleElevation(
    lattice,
    terrainZoomFor(lattice.cellX),
    true,
    signal,
    source,
  );
  // Keep a rejection from surfacing as unhandled while the fuel request is still running.
  terrain.catch(() => undefined);
  const sampleFuel = await fetchSampledCoverage(
    LANDFIRE_COVERAGE,
    "fuel",
    plan,
    FUEL_NO_DATA,
    signal,
    source,
  );
  const fuelCodes = modeFuel(sampleFuel, plan);
  const [{ elevation: elevationMeters, complete: tilesComplete }, canopy] = await Promise.all([
    terrain,
    sampleCanopyResampled(sampleFuel, fuelCodes, plan, signal, source),
  ]);
  const elevationComplete =
    repairedElevationComplete(elevationMeters, fuelCodes, lattice.width, lattice.height) &&
    tilesComplete;
  const groundCellSizeMeters = lattice.cellX * Math.cos(latitude * RADIANS_PER_DEGREE);
  const { slopeTangent, upslopeDegrees } = slopeAndAspect(
    elevationMeters,
    lattice.width,
    lattice.height,
    groundCellSizeMeters,
  );
  return {
    width: lattice.width,
    height: lattice.height,
    originX: lattice.westX + lattice.cellX / 2,
    originY: lattice.northY + lattice.cellY / 2,
    cellSizeX: lattice.cellX,
    cellSizeY: lattice.cellY,
    groundCellSizeMeters,
    elevationComplete,
    fuelCodes,
    elevationMeters,
    slopeTangent,
    upslopeDegrees,
    canopyBaseHeightMeters: canopy.canopyBaseHeightMeters,
    canopyBulkDensityKgPerM3: canopy.canopyBulkDensityKgPerM3,
    canopyCoverFraction: canopy.canopyCoverFraction,
    canopyHeightMeters: canopy.canopyHeightMeters,
    canopyComplete: canopy.canopyComplete,
    cellMeters: requested,
    resampling: "mode",
    attribution: attribution(),
  };
}

/**
 * LANDFIRE's native 30 m lattice over `box` (Mercator metres). `latitude` sets the
 * cos(latitude) ground correction: the requested point for `loadLandscape`, the box centre
 * for `loadLandscapeForBox`.
 */
async function loadNativeLandscape(
  box: MercatorBox,
  latitude: number,
  signal: AbortSignal,
  source: DataSource,
): Promise<LandscapeGrid> {
  const raster = await fetchFuelRaster(box, signal, source);
  // Different hosts, so the terrain tiles and the canopy coverages overlap in time.
  const [{ elevation: elevationMeters, complete: tilesComplete }, canopy] = await Promise.all([
    sampleElevation(latticeOfRaster(raster), TERRAIN_ZOOM, false, signal, source),
    sampleCanopy(raster, box, signal, source),
  ]);
  const elevationComplete =
    repairedElevationComplete(elevationMeters, raster.values, raster.width, raster.height) &&
    tilesComplete;
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
    cellMeters: FUEL_CELL_METERS,
    resampling: "native",
    attribution: attribution(),
  };
}

/**
 * Loads fuel, canopy and terrain for an arbitrary box on LANDFIRE's native 30 m lattice
 * (used by Simulation Studio). The box is in Mercator metres (EPSG:3857, the grid's own
 * coordinates); the returned grid has Mercator cell addressing and `groundCellSizeMeters`
 * corrected with cos(latitude) at the box centre. Only `endpoints` applies: a coarse
 * lattice is planned from a centre and radius, so use `loadLandscape` with `cellMeters`.
 */
export async function loadLandscapeForBox(
  box: MercatorBox,
  signal: AbortSignal,
  options: Pick<LandscapeLoadOptions, "endpoints"> = {},
): Promise<LandscapeGrid> {
  if (!(box.maxX > box.minX && box.maxY > box.minY)) {
    throw new Error("The landscape box must have a positive extent.");
  }
  const [, latitude] = mercatorToLonLat((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2);
  return loadNativeLandscape(box, latitude, signal, resolveSource(options.endpoints));
}
