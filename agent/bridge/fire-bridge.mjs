#!/usr/bin/env node
/**
 * One-shot stdio sidecar that runs the app's TypeScript fire model for the Python agent.
 *
 * It reads ONE JSON request from stdin, runs `loadLandscape` + `simulateFireSpread` from
 * `app/src/fire/`, writes ONE JSON response to stdout, and exits. No physics lives here:
 * this file only supplies the three things the browser gives those modules and Node does
 * not, then marshals the result.
 *
 *   1. TypeScript execution. Node 26 can only strip types, and `spread.ts` uses a
 *      constructor parameter property, which strip-only mode rejects. A `module`
 *      hook transpiles `.ts` through the repo's own TypeScript compiler and resolves
 *      the extensionless relative specifiers the app's bundler resolves.
 *   2. The `/landfire` proxy. `landscape.ts` fetches the relative path `/landfire/wcs`,
 *      which only resolves behind the Vite dev proxy. A global `fetch` wrapper applies
 *      the same rewrite the proxy does (see `app/vite.config.ts`).
 *   3. `createImageBitmap` / `OffscreenCanvas`. `landscape.ts` decodes terrarium
 *      elevation PNGs through a canvas. Node has neither, so both are polyfilled over a
 *      minimal PNG reader. The terrain decode is NOT skipped: a run with every tile
 *      missing would silently report flat ground, which would be a fabricated result.
 *
 * Units cross this boundary unchanged. The request and the response are exactly the
 * model's own units: ground metres, elapsed simulation minutes from ignition, miles per
 * hour for open 20-foot wind, meteorological degrees for wind direction, and the Imperial
 * values the Rothermel equations publish inside `run.ignition.spread`. Nothing is
 * converted here; the Python adapter converts once, at its own boundary.
 *
 * Protocol
 *   stdin  {origin:{latitude,longitude}, windSpeedMph, windFromDegrees, moisturePresetId,
 *           midflameAdjustment, stepMinutes, horizonMinutes, groundRadiusMeters}
 *   stdout {"ok":true,"run":{...FireRun, frames included...}}
 *       or {"ok":false,"error":{"type":"non_burnable"|"out_of_coverage"|"unavailable",
 *                               "message":"..."}}
 *
 * stdout carries nothing but that single JSON line. Every log, warning and progress note
 * goes to stderr. The process exits 0 whenever it wrote a well-formed response, including
 * a failure response; a non-zero exit means it crashed before answering.
 */

import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

import ts from "typescript";

const LOG_PREFIX = "[fire-bridge]";
const log = (...parts) => console.error(LOG_PREFIX, ...parts);

/** Mirrors the `/landfire` proxy rule in `app/vite.config.ts`. */
const LANDFIRE_PROXY_PREFIX = "/landfire";
const LANDFIRE_ORIGIN = "https://edcintl.cr.usgs.gov";
const LANDFIRE_UPSTREAM_PREFIX = "/geoserver/landfire";

const USER_AGENT = "CrisisTwin/0.1 fire-watch agent (hackathon planning prototype)";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_GROUND_RADIUS_METERS = 20_000;
const MAX_HORIZON_MINUTES = 1_440;
const TERRAIN_TILE_PIXELS = 256;

/** Where the real model lives, relative to this file; overridable for an unusual checkout. */
const FIRE_MODULE_DIR = process.env.CRISISTWIN_FIRE_MODULE_DIR
  ? new URL(`file://${process.env.CRISISTWIN_FIRE_MODULE_DIR}/`)
  : new URL("../../app/src/fire/", import.meta.url);

// ---------------------------------------------------------------------------
// 1. TypeScript execution
// ---------------------------------------------------------------------------

/** Matches `app/tsconfig.app.json`, so the bridge compiles these files as the app does. */
const COMPILER_OPTIONS = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  verbatimModuleSyntax: true,
  isolatedModules: true,
  useDefineForClassFields: true,
};

const RELATIVE_SPECIFIER = /^\.{1,2}\//;

registerHooks({
  resolve(specifier, context, nextResolve) {
    // The app's modules import `./fuelModels`, which only a bundler resolves. Node needs
    // the extension, so try the TypeScript file first and fall back to normal resolution.
    if (RELATIVE_SPECIFIER.test(specifier) && extname(specifier) === "") {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        // Not a TypeScript sibling; let Node resolve the specifier as written.
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !url.endsWith(".ts")) return nextLoad(url, context);
    const fileName = fileURLToPath(url);
    const { outputText, diagnostics } = ts.transpileModule(readFileSync(fileName, "utf8"), {
      fileName,
      compilerOptions: COMPILER_OPTIONS,
      reportDiagnostics: true,
    });
    for (const diagnostic of diagnostics ?? []) {
      log("typescript:", ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
    }
    return { format: "module", shortCircuit: true, source: outputText };
  },
});

// ---------------------------------------------------------------------------
// 2. The /landfire proxy
// ---------------------------------------------------------------------------

/** Status of the most recent LANDFIRE response, used to tell "no coverage" from "down". */
let lastLandfireStatus = null;

const nativeFetch = globalThis.fetch;

function requestedUrlOf(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input.url === "string") return input.url;
  return "";
}

globalThis.fetch = async function bridgeFetch(input, init) {
  const requested = requestedUrlOf(input);
  if (!requested.startsWith(LANDFIRE_PROXY_PREFIX)) {
    return nativeFetch(input, withUserAgent(init));
  }
  const absolute =
    LANDFIRE_ORIGIN + requested.replace(LANDFIRE_PROXY_PREFIX, LANDFIRE_UPSTREAM_PREFIX);
  log("LANDFIRE ->", absolute);
  const response = await nativeFetch(absolute, withUserAgent(init));
  lastLandfireStatus = response.status;
  log("LANDFIRE <-", response.status, response.headers.get("content-type") ?? "");
  return response;
};

function withUserAgent(init) {
  const headers = new Headers(init?.headers ?? undefined);
  if (!headers.has("user-agent")) headers.set("user-agent", USER_AGENT);
  return { ...init, headers };
}

// ---------------------------------------------------------------------------
// 3. createImageBitmap / OffscreenCanvas over a minimal PNG reader
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/**
 * Decode the 8-bit, non-interlaced RGB/RGBA PNGs the terrarium tile set publishes to
 * straight RGBA bytes. Anything else is rejected rather than silently misread, the same
 * stance `decodeGeoTiff` takes in `landscape.ts`.
 */
function decodePng(bytes) {
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error("Terrain tile is not a PNG.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const pieces = [];

  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const start = offset + 8;
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    if (type === "IHDR") {
      width = view.getUint32(start);
      height = view.getUint32(start + 4);
      bitDepth = bytes[start + 8];
      colorType = bytes[start + 9];
      interlace = bytes[start + 12];
    } else if (type === "IDAT") {
      pieces.push(bytes.subarray(start, start + length));
    } else if (type === "IEND") {
      break;
    }
    offset = start + length + 4;
  }

  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error(
      `Terrain tile uses an unsupported PNG layout (bit depth ${bitDepth}, colour type ${colorType}, ` +
        `interlace ${interlace}); only 8-bit non-interlaced RGB or RGBA is read.`,
    );
  }

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(pieces));
  if (raw.length < height * (stride + 1)) throw new Error("Terrain tile is truncated.");

  const rgba = new Uint8ClampedArray(width * height * 4);
  let previous = new Uint8Array(stride);
  let current = new Uint8Array(stride);
  let cursor = 0;
  for (let row = 0; row < height; row++) {
    const filter = raw[cursor++];
    for (let i = 0; i < stride; i++) {
      const value = raw[cursor + i];
      const left = i >= channels ? current[i - channels] : 0;
      const up = previous[i];
      const upLeft = i >= channels ? previous[i - channels] : 0;
      let restored;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + up;
          break;
        case 3:
          restored = value + ((left + up) >> 1);
          break;
        case 4: {
          const estimate = left + up - upLeft;
          const dLeft = Math.abs(estimate - left);
          const dUp = Math.abs(estimate - up);
          const dUpLeft = Math.abs(estimate - upLeft);
          restored = value + (dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft);
          break;
        }
        default:
          throw new Error(`Terrain tile uses unsupported PNG filter ${filter}.`);
      }
      current[i] = restored & 0xff;
    }
    cursor += stride;
    const target = row * width * 4;
    for (let x = 0; x < width; x++) {
      rgba[target + x * 4] = current[x * channels];
      rgba[target + x * 4 + 1] = current[x * channels + 1];
      rgba[target + x * 4 + 2] = current[x * channels + 2];
      rgba[target + x * 4 + 3] = channels === 4 ? current[x * channels + 3] : 255;
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return { width, height, data: rgba };
}

class BridgeImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
    this.colorSpace = "srgb";
  }
}

/** Only what `fetchTerrainTile` in `landscape.ts` calls: drawImage then getImageData. */
class BridgeCanvasContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.pixels = new Uint8ClampedArray(canvas.width * canvas.height * 4);
  }

  drawImage(bitmap, destinationX = 0, destinationY = 0) {
    const { width: canvasWidth, height: canvasHeight } = this.canvas;
    for (let y = 0; y < bitmap.height; y++) {
      const targetY = destinationY + y;
      if (targetY < 0 || targetY >= canvasHeight) continue;
      for (let x = 0; x < bitmap.width; x++) {
        const targetX = destinationX + x;
        if (targetX < 0 || targetX >= canvasWidth) continue;
        const from = (y * bitmap.width + x) * 4;
        const to = (targetY * canvasWidth + targetX) * 4;
        this.pixels[to] = bitmap.data[from];
        this.pixels[to + 1] = bitmap.data[from + 1];
        this.pixels[to + 2] = bitmap.data[from + 2];
        this.pixels[to + 3] = bitmap.data[from + 3];
      }
    }
  }

  getImageData(x, y, width, height) {
    const out = new Uint8ClampedArray(width * height * 4);
    const canvasWidth = this.canvas.width;
    for (let row = 0; row < height; row++) {
      const source = ((y + row) * canvasWidth + x) * 4;
      out.set(this.pixels.subarray(source, source + width * 4), row * width * 4);
    }
    return new BridgeImageData(out, width, height);
  }
}

class BridgeOffscreenCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.context = null;
  }

  getContext(type) {
    if (type !== "2d") return null;
    if (!this.context) this.context = new BridgeCanvasContext(this);
    return this.context;
  }
}

globalThis.createImageBitmap = async (source) => {
  const buffer = typeof source?.arrayBuffer === "function" ? await source.arrayBuffer() : source;
  const image = decodePng(new Uint8Array(buffer));
  if (image.width !== TERRAIN_TILE_PIXELS || image.height !== TERRAIN_TILE_PIXELS) {
    log(`terrain tile is ${image.width}x${image.height}, expected ${TERRAIN_TILE_PIXELS} square`);
  }
  return { ...image, close() {} };
};
globalThis.OffscreenCanvas = BridgeOffscreenCanvas;
globalThis.ImageData = BridgeImageData;

// ---------------------------------------------------------------------------
// The real model
// ---------------------------------------------------------------------------

const { loadLandscape } = await import(new URL("landscape.ts", FIRE_MODULE_DIR).href);
const {
  simulateFireSpread,
  MOISTURE_PRESETS,
  FIRE_STEP_MINUTES,
  FIRE_HORIZON_MINUTES,
  DEFAULT_MIDFLAME_ADJUSTMENT,
  NonBurnableIgnitionError,
} = await import(new URL("spread.ts", FIRE_MODULE_DIR).href);

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

class InvalidRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidRequestError";
  }
}

function requireNumber(value, name, { min, max, fallback } = {}) {
  const raw = value === undefined || value === null ? fallback : value;
  if (raw === undefined) throw new InvalidRequestError(`${name} is required`);
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new InvalidRequestError(`${name} must be a finite number, got ${JSON.stringify(value)}`);
  }
  if (min !== undefined && raw < min) throw new InvalidRequestError(`${name} must be at least ${min}`);
  if (max !== undefined && raw > max) throw new InvalidRequestError(`${name} must be at most ${max}`);
  return raw;
}

function parseRequest(text) {
  if (!text.trim()) throw new InvalidRequestError("no request on stdin");
  let request;
  try {
    request = JSON.parse(text);
  } catch (error) {
    throw new InvalidRequestError(`request is not valid JSON: ${error.message}`);
  }
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    throw new InvalidRequestError("request must be a JSON object");
  }

  const origin = request.origin;
  if (typeof origin !== "object" || origin === null) {
    throw new InvalidRequestError("origin must be an object with latitude and longitude");
  }

  const presetId = request.moisturePresetId;
  const preset = MOISTURE_PRESETS.find((candidate) => candidate.id === presetId);
  if (!preset) {
    const known = MOISTURE_PRESETS.map((candidate) => candidate.id).join(", ");
    throw new InvalidRequestError(`unknown moisturePresetId ${JSON.stringify(presetId)}; expected one of ${known}`);
  }

  return {
    scenario: {
      origin: {
        latitude: requireNumber(origin.latitude, "origin.latitude", { min: -90, max: 90 }),
        longitude: requireNumber(origin.longitude, "origin.longitude", { min: -180, max: 180 }),
      },
      windSpeedMph: requireNumber(request.windSpeedMph, "windSpeedMph", { min: 0, max: 200 }),
      windFromDegrees: requireNumber(request.windFromDegrees, "windFromDegrees", { min: -360, max: 360 }),
      moisture: preset.moisture,
      midflameAdjustment: requireNumber(request.midflameAdjustment, "midflameAdjustment", {
        min: 0,
        max: 1,
        fallback: DEFAULT_MIDFLAME_ADJUSTMENT,
      }),
      stepMinutes: requireNumber(request.stepMinutes, "stepMinutes", {
        min: 1,
        max: MAX_HORIZON_MINUTES,
        fallback: FIRE_STEP_MINUTES,
      }),
      horizonMinutes: requireNumber(request.horizonMinutes, "horizonMinutes", {
        min: 1,
        max: MAX_HORIZON_MINUTES,
        fallback: FIRE_HORIZON_MINUTES,
      }),
    },
    groundRadiusMeters: requireNumber(request.groundRadiusMeters, "groundRadiusMeters", {
      min: 100,
      max: MAX_GROUND_RADIUS_METERS,
    }),
    moisturePresetId: preset.id,
  };
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/** Coverage messages raised by `landscape.ts` and `spread.ts`, matched verbatim. */
const OUT_OF_COVERAGE_PATTERNS = [
  /outside the contiguous United States/i,
  /returned no fuel data for this area/i,
  /outside the modelled area/i,
];

function classifyFailure(error, timeoutMs) {
  if (error instanceof NonBurnableIgnitionError || error?.name === "NonBurnableIgnitionError") {
    return { type: "non_burnable", message: error.message };
  }
  if (error?.name === "TimeoutError") {
    return {
      type: "unavailable",
      message: `the LANDFIRE or terrain fetch did not finish within ${timeoutMs} ms`,
    };
  }
  if (error?.name === "AbortError") {
    return { type: "unavailable", message: "the landscape fetch was aborted before it finished" };
  }
  const message = String(error?.message ?? error);
  // GeoServer answers a subset outside the published coverage with 400 or 404; any other
  // error status is the service failing, which is a different thing and must not be
  // reported as "this place has no fuel data".
  if (lastLandfireStatus === 400 || lastLandfireStatus === 404) {
    return {
      type: "out_of_coverage",
      message: `LANDFIRE has no FBFM40 coverage for this area (HTTP ${lastLandfireStatus}). ${message}`,
    };
  }
  if (OUT_OF_COVERAGE_PATTERNS.some((pattern) => pattern.test(message))) {
    return { type: "out_of_coverage", message };
  }
  return { type: "unavailable", message };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function writeResponse(response) {
  return new Promise((resolve) => {
    process.stdout.write(`${JSON.stringify(response)}\n`, () => resolve());
  });
}

async function main() {
  const timeoutMs = Number(process.env.CRISISTWIN_FIRE_BRIDGE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  let parsed;
  try {
    parsed = parseRequest(await readStdin());
  } catch (error) {
    // An invalid request is reported with the "unavailable" type: the sidecar could not
    // answer. The message says why, and the three response types stay as documented.
    log("invalid request:", error.message);
    await writeResponse({ ok: false, error: { type: "unavailable", message: `invalid request: ${error.message}` } });
    return;
  }

  const { scenario, groundRadiusMeters, moisturePresetId } = parsed;
  log(
    `origin ${scenario.origin.latitude},${scenario.origin.longitude} radius ${groundRadiusMeters} m ` +
      `wind ${scenario.windSpeedMph} mph from ${scenario.windFromDegrees} deg moisture ${moisturePresetId} ` +
      `horizon ${scenario.horizonMinutes} min step ${scenario.stepMinutes} min`,
  );

  try {
    const signal = AbortSignal.timeout(effectiveTimeoutMs);
    const landscape = await loadLandscape(
      scenario.origin.longitude,
      scenario.origin.latitude,
      groundRadiusMeters,
      signal,
    );
    log(`landscape ${landscape.width}x${landscape.height} cells at ${landscape.groundCellSizeMeters.toFixed(2)} m`);
    const run = simulateFireSpread(landscape, scenario);
    log(
      `run solved in ${run.computeMilliseconds.toFixed(0)} ms, ${run.frames.length} frames, ` +
        `burnable fraction ${run.burnableFraction.toFixed(3)}, reached edge ${run.reachedEdge}`,
    );
    await writeResponse({ ok: true, run });
  } catch (error) {
    const failure = classifyFailure(error, effectiveTimeoutMs);
    log(`failed (${failure.type}):`, failure.message);
    if (error?.stack) log(error.stack);
    await writeResponse({ ok: false, error: failure });
  }
}

await main();
process.exit(0);
