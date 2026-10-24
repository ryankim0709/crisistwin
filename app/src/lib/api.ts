export interface HealthResponse {
  status: "ok";
  service: "crisistwin-api";
  version: string;
}

export async function fetchHealth(signal: AbortSignal): Promise<HealthResponse> {
  const response = await fetch("/api/health", { signal, headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`API returned HTTP ${response.status}.`);
  }

  const data: unknown = await response.json();
  if (
    typeof data !== "object" ||
    data === null ||
    !("status" in data) ||
    data.status !== "ok" ||
    !("service" in data) ||
    data.service !== "crisistwin-api" ||
    !("version" in data) ||
    typeof data.version !== "string" ||
    data.version.length === 0
  ) {
    throw new Error("The API returned an unexpected response.");
  }

  return { status: data.status, service: data.service, version: data.version };
}
