/** Whether the dev proxy may sign a /api/live/ request as the controller. See vite.config.ts. */
const FORWARDING_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "forwarded",
  "cf-connecting-ip",
  "x-real-ip",
];

export function shouldSignController(
  mode: string | undefined,
  remoteAddress: string,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  if (mode === "any") return true;
  if (mode === "host") {
    if (FORWARDING_HEADERS.some((name) => headers[name] !== undefined)) return false;
    const hostname = String(headers.host ?? "")
      .replace(/:\d+$/, "")
      .replace(/^\[|\]$/g, "")
      .toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  }
  return (
    remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1"
  );
}
