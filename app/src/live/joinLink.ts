/** The phone join link of ADR 0034: `crisistwin://join?server=<origin>&code=<invite>`. */

export type ServerCheck = { ok: true; origin: string } | { ok: false; reason: string };

/**
 * Normalizes a server address to an origin the iOS app accepts (same rules as its
 * AppConfiguration): HTTPS anywhere, plain HTTP only for `localhost` and `.local` names.
 */
export function checkServerOrigin(raw: string): ServerCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "Enter a full address, such as https://example.trycloudflare.com." };
  }
  const local = url.hostname === "localhost" || url.hostname.endsWith(".local");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    return { ok: false, reason: "Phones need https://, or http:// only for localhost and .local names." };
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    return { ok: false, reason: "Use the bare address, with no path, query or login." };
  }
  if (url.hostname === "localhost") {
    return { ok: false, reason: "A phone cannot reach localhost on this computer. Use the .local name or a tunnel." };
  }
  return { ok: true, origin: url.origin };
}

export function buildJoinLink(origin: string, code: string): string {
  const query = new URLSearchParams({ server: origin });
  if (code.trim()) query.set("code", code.trim());
  return `crisistwin://join?${query.toString()}`;
}
