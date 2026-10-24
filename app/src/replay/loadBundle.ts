import type { ReplayModel } from "./types";
import { parseBundle } from "./validate";

export const REPLAY_BUNDLE_URL = "/replays/camp-2018.json";
export const BUNDLE_GENERATE_HINT =
  "python3 -m sim ... bundle --output app/public/replays/camp-2018.json";

export class BundleMissingError extends Error {
  constructor(url: string, detail: string) {
    super(`No replay bundle at ${url} (${detail}).`);
    this.name = "BundleMissingError";
  }
}

export async function fetchReplayBundle(signal: AbortSignal, url = REPLAY_BUNDLE_URL): Promise<ReplayModel> {
  const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (response.status === 404) throw new BundleMissingError(url, "HTTP 404");
  if (!response.ok) throw new Error(`Replay bundle request returned HTTP ${response.status}.`);

  // The Vite dev server answers unknown paths with index.html, so a missing file looks like HTML.
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) throw new BundleMissingError(url, "server returned HTML");

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error("The replay bundle is not valid JSON.");
  }
  return parseBundle(data);
}
