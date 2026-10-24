/**
 * Prebuilt landscape packages (docs/adr/0013-prebuilt-socal-landscapes.md): encode a
 * `LandscapeGrid` into the gzip binary stored in MongoDB GridFS, decode it back, and fetch
 * stored regions from the API. Browser and Node 18+ compatible with no dependencies:
 * gzip uses CompressionStream/DecompressionStream and the checksum uses crypto.subtle.
 *
 * Layout before gzip: ASCII magic `CTLS1\n`, little-endian u32 header byte length, UTF-8
 * JSON header, zero padding to an 8-byte boundary (from the start of the file), then the
 * section block. Each section starts on an 8-byte boundary inside the block; `byteOffset`
 * is relative to the block start and `payloadSha256` covers the whole block, padding
 * included. Slope and aspect are not stored: decode recomputes them with the live loader's
 * `slopeAndAspect`, so they cannot drift from it.
 */

import { slopeAndAspect, type LandscapeGrid, type LandscapeResampling } from "./landscape";

export const LANDSCAPE_PACKAGE_FORMAT = "crisistwin-landscape";
export const LANDSCAPE_PACKAGE_VERSION = 1;
const MAGIC = "CTLS1\n";
const ALIGNMENT = 8;
/** Generous ceiling so a corrupt length cannot make the decoder allocate gigabytes. */
const MAX_HEADER_BYTES = 1 << 20;

export type SectionName =
  | "fuelCodes"
  | "elevationMeters"
  | "canopyBaseHeightMeters"
  | "canopyBulkDensityKgPerM3"
  | "canopyCoverFraction"
  | "canopyHeightMeters";
type SectionDtype = "int16" | "float32";

const SECTIONS: readonly { name: SectionName; dtype: SectionDtype }[] = [
  { name: "fuelCodes", dtype: "int16" },
  { name: "elevationMeters", dtype: "float32" },
  { name: "canopyBaseHeightMeters", dtype: "float32" },
  { name: "canopyBulkDensityKgPerM3", dtype: "float32" },
  { name: "canopyCoverFraction", dtype: "float32" },
  { name: "canopyHeightMeters", dtype: "float32" },
];
const RESAMPLINGS: readonly LandscapeResampling[] = ["native", "mode", "nearest"];
const BYTES_PER_ELEMENT: Record<SectionDtype, number> = { int16: 2, float32: 4 };

/** Where the package's data came from; recorded for provenance, never used to fetch. */
export interface LandscapePackageSources {
  /** Upstream LANDFIRE WCS endpoint the fuel and canopy coverages were read from. */
  landfireWcs: string;
  /** LANDFIRE coverage ids (fuel first, then canopy). */
  coverages: string[];
  /** Terrarium terrain tile base URL. */
  terrainTiles: string;
  /** UTC ISO time the upstream data were retrieved. */
  retrievedAt: string;
}

export interface LandscapePackageMeta {
  regionId: string;
  /** UTC ISO build time. */
  builtAt: string;
  /** Cell size the grid was built at, metres; must equal `grid.cellMeters`. */
  cellMeters: number;
  /** How fuel reached the grid; must equal `grid.resampling` (see LandscapeGrid). */
  resampling: LandscapeResampling;
  sources: LandscapePackageSources;
}

export interface LandscapePackageSection {
  name: SectionName;
  dtype: SectionDtype;
  byteOffset: number;
  byteLength: number;
}

export interface LandscapePackageHeader extends LandscapePackageMeta {
  format: typeof LANDSCAPE_PACKAGE_FORMAT;
  version: typeof LANDSCAPE_PACKAGE_VERSION;
  width: number;
  height: number;
  originX: number;
  originY: number;
  cellSizeX: number;
  cellSizeY: number;
  groundCellSizeMeters: number;
  elevationComplete: boolean;
  canopyComplete: boolean;
  attribution: LandscapeGrid["attribution"];
  sections: LandscapePackageSection[];
  payloadSha256: string;
}

export class LandscapePackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LandscapePackageError";
  }
}

const LITTLE_ENDIAN_HOST = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function alignUp(value: number): number {
  return Math.ceil(value / ALIGNMENT) * ALIGNMENT;
}

async function pipeThrough(
  bytes: Uint8Array,
  transform: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function sectionBytes(array: Int16Array | Float32Array): Uint8Array {
  if (LITTLE_ENDIAN_HOST) return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  const out = new Uint8Array(array.byteLength);
  const view = new DataView(out.buffer);
  for (let i = 0; i < array.length; i++) {
    if (array instanceof Int16Array) view.setInt16(i * 2, array[i], true);
    else view.setFloat32(i * 4, array[i], true);
  }
  return out;
}

/** Encode a grid to the gzip package bytes; the GridFS filename is sha256 of the result. */
export async function encodeLandscapePackage(
  grid: LandscapeGrid,
  meta: LandscapePackageMeta,
): Promise<Uint8Array> {
  if (meta.cellMeters !== grid.cellMeters || meta.resampling !== grid.resampling) {
    throw new LandscapePackageError(
      `Package metadata says ${meta.cellMeters} m/${meta.resampling} but the grid is ` +
        `${grid.cellMeters} m/${grid.resampling}.`,
    );
  }
  const cells = grid.width * grid.height;
  const sections: LandscapePackageSection[] = [];
  let blockLength = 0;
  for (const { name, dtype } of SECTIONS) {
    const array = grid[name];
    if (array.length !== cells) {
      throw new LandscapePackageError(`${name} has ${array.length} cells, expected ${cells}.`);
    }
    const byteLength = cells * BYTES_PER_ELEMENT[dtype];
    sections.push({ name, dtype, byteOffset: blockLength, byteLength });
    blockLength = alignUp(blockLength + byteLength);
  }
  const block = new Uint8Array(blockLength);
  for (const section of sections) {
    block.set(sectionBytes(grid[section.name]), section.byteOffset);
  }

  const header: LandscapePackageHeader = {
    format: LANDSCAPE_PACKAGE_FORMAT,
    version: LANDSCAPE_PACKAGE_VERSION,
    regionId: meta.regionId,
    builtAt: meta.builtAt,
    width: grid.width,
    height: grid.height,
    originX: grid.originX,
    originY: grid.originY,
    cellSizeX: grid.cellSizeX,
    cellSizeY: grid.cellSizeY,
    groundCellSizeMeters: grid.groundCellSizeMeters,
    cellMeters: meta.cellMeters,
    resampling: meta.resampling,
    elevationComplete: grid.elevationComplete,
    canopyComplete: grid.canopyComplete,
    attribution: { ...grid.attribution },
    sources: meta.sources,
    sections,
    payloadSha256: await sha256Hex(block),
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const prefixLength = MAGIC.length + 4;
  const blockStart = alignUp(prefixLength + headerBytes.length);

  const raw = new Uint8Array(blockStart + block.length);
  raw.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(raw.buffer).setUint32(MAGIC.length, headerBytes.length, true);
  raw.set(headerBytes, prefixLength);
  raw.set(block, blockStart);
  return pipeThrough(raw, new CompressionStream("gzip"));
}

function fail(message: string): never {
  throw new LandscapePackageError(`Landscape package is invalid: ${message}`);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateHeader(value: unknown): LandscapePackageHeader {
  if (typeof value !== "object" || value === null) fail("header is not an object.");
  const header = value as Record<string, unknown>;
  if (header.format !== LANDSCAPE_PACKAGE_FORMAT) fail(`unknown format ${String(header.format)}.`);
  if (header.version !== LANDSCAPE_PACKAGE_VERSION) {
    fail(`unsupported version ${String(header.version)}.`);
  }
  for (const key of ["width", "height"]) {
    const n = header[key];
    if (!Number.isInteger(n) || (n as number) <= 0) fail(`${key} is not a positive integer.`);
  }
  for (const key of [
    "originX",
    "originY",
    "cellSizeX",
    "cellSizeY",
    "groundCellSizeMeters",
    "cellMeters",
  ]) {
    if (!isFiniteNumber(header[key])) fail(`${key} is not a finite number.`);
  }
  if ((header.groundCellSizeMeters as number) <= 0) fail("groundCellSizeMeters must be > 0.");
  for (const key of ["regionId", "builtAt", "payloadSha256"]) {
    if (typeof header[key] !== "string") fail(`${key} is not a string.`);
  }
  if (!RESAMPLINGS.includes(header.resampling as LandscapeResampling)) {
    fail(`unknown resampling ${String(header.resampling)}.`);
  }
  for (const key of ["elevationComplete", "canopyComplete"]) {
    if (typeof header[key] !== "boolean") fail(`${key} is not a boolean.`);
  }
  const attribution = header.attribution as Record<string, unknown> | null;
  if (
    typeof attribution !== "object" ||
    attribution === null ||
    !["fuel", "terrain", "canopy"].every((key) => typeof attribution[key] === "string")
  ) {
    fail("attribution is incomplete.");
  }
  if (!Array.isArray(header.sections)) fail("sections is not a list.");
  return header as unknown as LandscapePackageHeader;
}

function readSection(
  block: Uint8Array,
  section: LandscapePackageSection,
): Int16Array | Float32Array {
  const bytes = block.slice(section.byteOffset, section.byteOffset + section.byteLength);
  const count = section.byteLength / BYTES_PER_ELEMENT[section.dtype];
  if (LITTLE_ENDIAN_HOST) {
    return section.dtype === "int16" ? new Int16Array(bytes.buffer) : new Float32Array(bytes.buffer);
  }
  const view = new DataView(bytes.buffer);
  if (section.dtype === "int16") {
    return Int16Array.from({ length: count }, (_, i) => view.getInt16(i * 2, true));
  }
  return Float32Array.from({ length: count }, (_, i) => view.getFloat32(i * 4, true));
}

/**
 * Decode and verify package bytes (gzip, or already-decompressed if an intermediary
 * removed the gzip layer). Rejects unknown versions, size mismatches and checksum
 * failures with `LandscapePackageError`.
 */
export async function decodeLandscapePackage(
  bytes: ArrayBuffer | Uint8Array,
): Promise<{ grid: LandscapeGrid; header: LandscapePackageHeader }> {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let raw: Uint8Array;
  if (input[0] === 0x1f && input[1] === 0x8b) {
    try {
      raw = await pipeThrough(input, new DecompressionStream("gzip"));
    } catch {
      fail("gzip data are corrupt.");
    }
  } else {
    raw = input;
  }

  const prefixLength = MAGIC.length + 4;
  if (raw.length < prefixLength) fail("too short.");
  if (new TextDecoder().decode(raw.subarray(0, MAGIC.length)) !== MAGIC) fail("bad magic.");
  const headerLength = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(
    MAGIC.length,
    true,
  );
  if (headerLength > MAX_HEADER_BYTES || prefixLength + headerLength > raw.length) {
    fail("header length is out of range.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        raw.subarray(prefixLength, prefixLength + headerLength),
      ),
    );
  } catch {
    fail("header is not valid JSON.");
  }
  const header = validateHeader(parsed);

  const block = raw.subarray(alignUp(prefixLength + headerLength));
  const cells = header.width * header.height;
  const byName = new Map(header.sections.map((section) => [section.name, section]));
  if (byName.size !== header.sections.length) fail("duplicate section names.");
  for (const expected of SECTIONS) {
    const section = byName.get(expected.name);
    if (!section) fail(`missing section ${expected.name}.`);
    if (section.dtype !== expected.dtype) fail(`${expected.name} is not ${expected.dtype}.`);
    if (section.byteLength !== cells * BYTES_PER_ELEMENT[expected.dtype]) {
      fail(`${expected.name} is ${section.byteLength} bytes, expected ${cells} cells.`);
    }
    if (
      !Number.isInteger(section.byteOffset) ||
      section.byteOffset < 0 ||
      section.byteOffset % ALIGNMENT !== 0 ||
      section.byteOffset + section.byteLength > block.length
    ) {
      fail(`${expected.name} lies outside the section block.`);
    }
  }
  if ((await sha256Hex(block)) !== header.payloadSha256) fail("payload checksum mismatch.");

  const read = (name: SectionName) => readSection(block, byName.get(name)!);
  const elevationMeters = read("elevationMeters") as Float32Array;
  const { slopeTangent, upslopeDegrees } = slopeAndAspect(
    elevationMeters,
    header.width,
    header.height,
    header.groundCellSizeMeters,
  );
  const grid: LandscapeGrid = {
    width: header.width,
    height: header.height,
    originX: header.originX,
    originY: header.originY,
    cellSizeX: header.cellSizeX,
    cellSizeY: header.cellSizeY,
    groundCellSizeMeters: header.groundCellSizeMeters,
    elevationComplete: header.elevationComplete,
    fuelCodes: read("fuelCodes") as Int16Array,
    elevationMeters,
    slopeTangent,
    upslopeDegrees,
    canopyBaseHeightMeters: read("canopyBaseHeightMeters") as Float32Array,
    canopyBulkDensityKgPerM3: read("canopyBulkDensityKgPerM3") as Float32Array,
    canopyCoverFraction: read("canopyCoverFraction") as Float32Array,
    canopyHeightMeters: read("canopyHeightMeters") as Float32Array,
    canopyComplete: header.canopyComplete,
    cellMeters: header.cellMeters,
    resampling: header.resampling,
    attribution: { ...header.attribution },
  };
  return { grid, header };
}

/** One stored region, as listed by `GET /api/landscapes`. */
export interface RegionSummary {
  id: string;
  name: string;
  counties: string[];
  summary: string;
  center: { latitude: number; longitude: number };
  radiusMeters: number;
  cellMeters: number;
  width: number;
  height: number;
  builtAt: string;
  bytes: number;
  sha256: string;
}

/**
 * The stored region cannot be served (not built, unknown id, database or API down). The
 * page should fall back to live loading rather than show this as a data error.
 * `status` is the HTTP status, or 0 when the API could not be reached.
 */
export class RegionUnavailableError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RegionUnavailableError";
  }
}

/**
 * Statuses that mean "no stored copy right now" rather than a broken package: 404, and any
 * 5xx (the Vite dev proxy answers 500 when the backend is not running at all).
 */
function isUnavailableStatus(status: number): boolean {
  return status === 404 || status >= 500;
}

async function getOrUnavailable(url: string, signal: AbortSignal): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw new RegionUnavailableError(`Could not reach ${url}.`, 0);
  }
  if (isUnavailableStatus(response.status)) {
    throw new RegionUnavailableError(`${url} is unavailable (${response.status}).`, response.status);
  }
  if (!response.ok) throw new Error(`${url} failed (${response.status}).`);
  return response;
}

/** Fetch and decode a stored region package. Throws `RegionUnavailableError` to fall back. */
export async function fetchRegionLandscape(
  regionId: string,
  signal: AbortSignal,
): Promise<{ grid: LandscapeGrid; header: LandscapePackageHeader }> {
  const response = await getOrUnavailable(
    `/api/landscapes/${encodeURIComponent(regionId)}`,
    signal,
  );
  const decoded = await decodeLandscapePackage(await response.arrayBuffer());
  if (decoded.header.regionId !== regionId) {
    throw new LandscapePackageError(
      `Asked for region ${regionId} but the package is ${decoded.header.regionId}.`,
    );
  }
  return decoded;
}

function isRegionSummary(value: unknown): value is RegionSummary {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  const center = r.center as Record<string, unknown> | null;
  return (
    typeof r.id === "string" &&
    typeof r.name === "string" &&
    Array.isArray(r.counties) &&
    r.counties.every((county) => typeof county === "string") &&
    typeof r.summary === "string" &&
    typeof center === "object" &&
    center !== null &&
    isFiniteNumber(center.latitude) &&
    isFiniteNumber(center.longitude) &&
    ["radiusMeters", "cellMeters", "width", "height", "bytes"].every((key) =>
      isFiniteNumber(r[key]),
    ) &&
    typeof r.builtAt === "string" &&
    typeof r.sha256 === "string"
  );
}

/** List the stored regions. Throws `RegionUnavailableError` when the API is down. */
export async function fetchRegionCatalog(signal: AbortSignal): Promise<RegionSummary[]> {
  const response = await getOrUnavailable("/api/landscapes", signal);
  const body: unknown = await response.json();
  const regions = (body as { regions?: unknown } | null)?.regions;
  if (!Array.isArray(regions) || !regions.every(isRegionSummary)) {
    throw new Error("GET /api/landscapes returned an unexpected shape.");
  }
  return regions;
}
