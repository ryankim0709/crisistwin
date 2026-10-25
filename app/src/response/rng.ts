/**
 * Seeded randomness for the response model (docs/response-model.md). A separate stream from the
 * board's ignition stream, so adding a response draw does not move the next ignition. Pure.
 *
 * mulberry32 (the same generator demo/model.ts uses), plus Box-Muller normals and lognormal
 * multipliers. A stream is a plain `{ state }` object so it serialises with the board.
 */

export interface RngStream {
  state: number;
}

/** A stream derived from the board seed and a salt (FNV-1a over the salt, xor the seed). */
export function deriveStream(seed: number, salt: string): RngStream {
  let h = 0x811c9dc5;
  for (let i = 0; i < salt.length; i += 1) {
    h ^= salt.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return { state: (h ^ (seed >>> 0)) >>> 0 };
}

/** Uniform in [0, 1). */
export function uniform(rng: RngStream): number {
  let t = (rng.state = (rng.state + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Standard normal (Box-Muller; uses two uniforms). */
export function standardNormal(rng: RngStream): number {
  const u1 = Math.max(1e-12, uniform(rng));
  const u2 = uniform(rng);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * A multiplier with median 1 whose natural log is normal with standard deviation `logSd`,
 * truncated to [exp(-3 logSd), exp(3 logSd)] so a single draw cannot dominate a run.
 */
export function lognormalFactor(rng: RngStream, logSd: number): number {
  if (logSd <= 0) return 1;
  const z = Math.max(-3, Math.min(3, standardNormal(rng)));
  return Math.exp(logSd * z);
}

export function chance(rng: RngStream, probability: number): boolean {
  return uniform(rng) < probability;
}
