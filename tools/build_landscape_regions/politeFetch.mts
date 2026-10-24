/**
 * The fetch the builder hands the landscape loader (`LandscapeEndpoints.fetch`). The loader
 * already sends the app User-Agent and retries LANDFIRE errors; this adds what a long
 * offline build needs on top: at most `MAX_PER_HOST` requests in flight per host across
 * every region being built, bounded retries with backoff for network errors, 5xx and 429
 * on every host (terrain tiles included), a per-request timeout, and one build-wide
 * AbortSignal (SIGINT) attached to every request.
 */

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

export function politeFetch(
  buildSignal: AbortSignal,
  log: (line: string) => void,
): { fetch: typeof fetch; stats: FetchStats } {
  const stats: FetchStats = { started: 0, completed: 0, retried: 0, failed: 0, bytes: 0 };
  const hosts = new Map<string, Semaphore>();
  const politely = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(url).host;
    let semaphore = hosts.get(host);
    if (!semaphore) hosts.set(host, (semaphore = new Semaphore(MAX_PER_HOST)));
    stats.started++;
    for (let attempt = 1; ; attempt++) {
      const signals = [buildSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
      if (init.signal) signals.push(init.signal);
      let transient: string;
      await semaphore.acquire();
      try {
        const response = await fetch(url, { ...init, signal: AbortSignal.any(signals) });
        if (response.status < 500 && response.status !== 429) {
          // Buffer the body inside the slot so the limit covers the whole download.
          const body = await response.arrayBuffer();
          stats.completed++;
          stats.bytes += body.byteLength;
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
        stats.failed++;
        log(`  giving up on ${host} request after ${attempt} attempts (${transient})`);
        // A 503 lets the loader apply its own handling (missing tile, LANDFIRE error).
        return new Response(null, { status: 503, statusText: transient });
      }
      stats.retried++;
      log(`  retry ${attempt}/${MAX_ATTEMPTS - 1} for ${host} (${transient})`);
      const backoff = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
      await sleep(backoff * (0.7 + Math.random() * 0.6), buildSignal);
    }
  };
  return { fetch: politely as typeof fetch, stats };
}
