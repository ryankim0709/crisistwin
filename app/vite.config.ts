import dns from "node:dns";
import https from "node:https";
import type { LookupFunction } from "node:net";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const LANDFIRE_ORIGIN = "https://edcintl.cr.usgs.gov";
const LANDFIRE_DNS_TTL_MS = 5 * 60_000;
/** Identifies this application to the data service rather than impersonating a browser. */
const LANDFIRE_USER_AGENT = "CrisisTwin/0.1 (hackathon planning prototype)";

const lastGoodAddresses = new Map<string, { entries: dns.LookupAddress[]; resolvedAt: number }>();

// Both the host resolver and Docker's forwarder drop queries intermittently, and one
// failed lookup turns a fuel-raster request into a 500 the page cannot recover from.
// Cache the last address that worked and keep using it while lookups are failing, so a
// DNS blip costs a stale address rather than the whole raster. Only the LANDFIRE host
// goes through here. The hostname is unchanged, so TLS verification and SNI still apply.
const resilientLookup: LookupFunction = (hostname, options, callback) => {
  const respond = (entries: dns.LookupAddress[]) => {
    if (options.all === true) {
      callback(null, entries);
      return;
    }
    callback(null, entries[0].address, entries[0].family);
  };

  const cached = lastGoodAddresses.get(hostname);
  if (cached && Date.now() - cached.resolvedAt < LANDFIRE_DNS_TTL_MS) {
    respond(cached.entries);
    return;
  }

  // LANDFIRE publishes an AAAA record but the Docker bridge network has no IPv6 route,
  // so ask for A records only instead of paying for a AAAA attempt on every connection.
  dns.lookup(hostname, { all: true, family: 4 }, (error, entries) => {
    if (!error && entries.length > 0) {
      lastGoodAddresses.set(hostname, { entries, resolvedAt: Date.now() });
      respond(entries);
      return;
    }
    if (cached) {
      respond(cached.entries);
      return;
    }
    callback(error ?? new Error(`No IPv4 address for ${hostname}`), "", 4);
  });
};

// Keep-alive reuses the upstream connection across the tiles of one simulation run,
// which also means far fewer lookups to fail.
const landfireAgent = new https.Agent({ keepAlive: true, lookup: resilientLookup });

/**
 * Headers the browser attaches that have no business being forwarded to a public data
 * service. Left in place they make a proxied raster request look like cross-site browser
 * traffic: the USGS web application firewall answers those with an HTML block page
 * ("Attack ID 20000051") that arrives as a 500, while the identical request carrying
 * plain client headers succeeds. Strip them and say who we actually are instead.
 */
const BROWSER_ONLY_HEADERS = [
  "origin",
  "referer",
  "cookie",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-fetch-user",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "upgrade-insecure-requests",
  "priority",
];

function presentAsThisApplication(proxyReq: import("node:http").ClientRequest): void {
  for (const header of BROWSER_ONLY_HEADERS) proxyReq.removeHeader(header);
  proxyReq.setHeader("user-agent", LANDFIRE_USER_AGENT);
  proxyReq.setHeader("accept", "image/tiff,application/xml;q=0.9,*/*;q=0.8");
  // Chrome asks for br and zstd; ask for what the service actually returns.
  proxyReq.setHeader("accept-encoding", "gzip");
}

/**
 * The /live controller console needs the controller token on every /api/live/ call. In
 * development this proxy attaches it from the server's environment (never the bundle), so the
 * page needs no token form. Only requests from this machine get it, unless
 * LIVE_CONTROLLER_PROXY=any (Docker, where the published port is bound to 127.0.0.1 and the
 * browser's requests arrive from the bridge network). A request that already carries a token
 * is left alone.
 */
function attachControllerToken(proxyReq: import("node:http").ClientRequest, req: import("node:http").IncomingMessage): void {
  const token = process.env.LIVE_CONTROLLER_TOKEN;
  if (!token || !req.url?.startsWith("/api/live/") || req.headers.authorization) return;
  const remote = req.socket.remoteAddress ?? "";
  const local = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (local || process.env.LIVE_CONTROLLER_PROXY === "any") proxyReq.setHeader("authorization", `Bearer ${token}`);
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // MapLibre loads its tile worker from a URL relative to its own module. Pre-bundling
  // rewrites that URL and the worker fails to load, which silently breaks tile rendering.
  optimizeDeps: { exclude: ["maplibre-gl"] },
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:8000",
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", attachControllerToken);
        },
      },
      // LANDFIRE's GeoServer advertises permissive CORS but a browser request to it
      // still fails, so fuel rasters are fetched same-origin through this proxy.
      "/landfire": {
        target: LANDFIRE_ORIGIN,
        changeOrigin: true,
        agent: landfireAgent,
        rewrite: (path) => path.replace(/^\/landfire/, "/geoserver/landfire"),
        configure: (proxy) => {
          proxy.on("proxyReq", presentAsThisApplication);
        },
      },
    },
  },
  preview: { host: "0.0.0.0", port: 4173, strictPort: true },
});
