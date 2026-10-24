/**
 * Node stand-ins for the browser APIs the live landscape loader uses, so the builder runs
 * the exact page code (app/src/fire/landscape.ts) instead of a copy:
 *
 * - `fetch`: rewrites the page's same-origin `/landfire/...` proxy path to the upstream
 *   USGS GeoServer (what vite.config.ts and Nginx do for the page), identifies as the app,
 *   bounds concurrency per host, retries transient failures a bounded number of times, and
 *   ties every request to one build-wide AbortSignal (SIGINT).
 * - `createImageBitmap` / `OffscreenCanvas`: just enough to read terrarium PNG tiles
 *   (8-bit RGB/RGBA, non-interlaced) via node:zlib.
 */

import { inflateSync } from "node:zlib";

export const LANDFIRE_UPSTREAM = "https://edcintl.cr.usgs.gov/geoserver/landfire";
/** Same identity vite.config.ts presents to the USGS service. */
export const APP_USER_AGENT = "CrisisTwin/0.1 (hackathon planning prototype)";

const MAX_PER_HOST = 4;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 8000;
const REQUEST_TIMEOUT_MS = 90_000;

export interface FetchStats {
  started: number;
  completed: number;
  retried: number;
  failed: number;
  bytes: number;
}

export const fetchStats: FetchStats = { started: 0, completed: 0, retried: 0, failed: 0, bytes: 0 };

class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly limit: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }
  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
}

const hostLimits = new Map<string, Semaphore>();
function semaphoreFor(host: string): Semaphore {
  let semaphore = hostLimits.get(host);
  if (!semaphore) hostLimits.set(host, (semaphore = new Semaphore(MAX_PER_HOST)));
  return semaphore;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function resolveUrl(input: string): string {
  if (input.startsWith("/landfire/")) return LANDFIRE_UPSTREAM + input.slice("/landfire".length);
  if (input.startsWith("/")) throw new Error(`No upstream for same-origin path ${input}.`);
  return input;
}

/** Install the fetch wrapper. Every request also aborts with `buildSignal`. */
export function installFetch(buildSignal: AbortSignal, log: (line: string) => void): void {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = resolveUrl(raw);
    const host = new URL(url).host;
    const headers = new Headers(init.headers);
    headers.set("user-agent", APP_USER_AGENT);
    if (host.endsWith("usgs.gov")) {
      headers.set("accept", "image/tiff,application/xml;q=0.9,*/*;q=0.8");
    }
    const semaphore = semaphoreFor(host);
    fetchStats.started++;
    for (let attempt = 1; ; attempt++) {
      const signals = [buildSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
      if (init.signal) signals.push(init.signal);
      let transient: string;
      await semaphore.acquire();
      try {
        const response = await nativeFetch(url, {
          ...init,
          headers,
          signal: AbortSignal.any(signals),
        });
        if (response.status < 500 && response.status !== 429) {
          // Buffer the body inside the semaphore so the slot covers the whole download.
          const body = await response.arrayBuffer();
          fetchStats.completed++;
          fetchStats.bytes += body.byteLength;
          return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
        transient = `HTTP ${response.status}`;
        await response.body?.cancel();
      } catch (cause) {
        if (buildSignal.aborted || init.signal?.aborted) throw cause;
        transient = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
      } finally {
        semaphore.release();
      }
      if (attempt >= MAX_ATTEMPTS) {
        fetchStats.failed++;
        log(`  giving up on ${url} after ${attempt} attempts (${transient})`);
        // Hand the loader a 503 rather than throwing; it applies its own error handling.
        return new Response(null, { status: 503, statusText: transient });
      }
      fetchStats.retried++;
      const backoff = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
      log(`  retry ${attempt}/${MAX_ATTEMPTS - 1} for ${host} (${transient})`);
      await sleep(backoff * (0.7 + Math.random() * 0.6), buildSignal);
    }
  };
}

// --- PNG decoding for terrarium tiles -------------------------------------------------

interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, like ImageData.data. */
  rgba: Uint8ClampedArray;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function decodePng(bytes: Uint8Array): DecodedImage {
  if (!PNG_SIGNATURE.every((value, i) => bytes[i] === value)) throw new Error("Not a PNG.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let palette: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      width = view.getUint32(16);
      height = view.getUint32(20);
      const bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8 || data[12] !== 0 || ![2, 3, 6].includes(colorType)) {
        throw new Error(`Unsupported PNG (depth ${bitDepth}, colour ${colorType}, interlaced).`);
      }
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 1;
  const stride = width * channels;
  const inflated = inflateSync(Buffer.concat(idat));
  if (inflated.length < (stride + 1) * height) throw new Error("Truncated PNG data.");
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = inflated[y * (stride + 1)];
    const source = inflated.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = y * stride;
    const previous = row - stride;
    for (let x = 0; x < stride; x++) {
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
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          break;
        }
        default:
          throw new Error(`Bad PNG filter ${filter}.`);
      }
      pixels[row + x] = (source[x] + predictor) & 0xff;
    }
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    if (channels === 1) {
      if (!palette) throw new Error("Palette PNG without PLTE.");
      const p = pixels[i] * 3;
      rgba.set([palette[p], palette[p + 1], palette[p + 2], 255], i * 4);
    } else {
      rgba[i * 4] = pixels[i * channels];
      rgba[i * 4 + 1] = pixels[i * channels + 1];
      rgba[i * 4 + 2] = pixels[i * channels + 2];
      rgba[i * 4 + 3] = channels === 4 ? pixels[i * channels + 3] : 255;
    }
  }
  return { width, height, rgba };
}

class NodeImageBitmap {
  constructor(readonly image: DecodedImage) {}
  get width() {
    return this.image.width;
  }
  get height() {
    return this.image.height;
  }
  close() {}
}

class NodeOffscreenCanvas {
  private image: DecodedImage | null = null;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  getContext() {
    return {
      drawImage: (bitmap: NodeImageBitmap, dx: number, dy: number) => {
        if (dx !== 0 || dy !== 0 || bitmap.width !== this.width || bitmap.height !== this.height) {
          throw new Error("Node canvas shim only supports drawing a same-size image at 0,0.");
        }
        this.image = bitmap.image;
      },
      getImageData: (sx: number, sy: number, sw: number, sh: number) => {
        if (!this.image || sx !== 0 || sy !== 0 || sw !== this.width || sh !== this.height) {
          throw new Error("Node canvas shim only supports reading the whole drawn image.");
        }
        return { width: sw, height: sh, data: this.image.rgba };
      },
    };
  }
}

export function installImageShims(): void {
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.createImageBitmap = async (blob: Blob) =>
    new NodeImageBitmap(decodePng(new Uint8Array(await blob.arrayBuffer())));
  scope.OffscreenCanvas = NodeOffscreenCanvas;
}
