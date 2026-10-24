# 0007: Mobile scenarios reuse the web map

Date: 2026-10-23. Status: accepted for the MVP demonstration.

ADR 0004 left open how the iOS app shows maps and simulation without a second,
divergent numerical model. The Scenarios tab embeds the existing web `/maps` page
in a `WKWebView`. The MapLibre map, its controls, and the illustrative fire model
in `app/src/simulation/fire.ts` (ADR 0003) run unchanged, so iOS and web results
are identical by construction. No backend, web, or model contracts change.

`WEB_BASE_URL` is a validated origin set in the xcconfig files, like
`API_BASE_URL`: Debug uses the Vite server at `http://localhost:5173`, and Release
is empty until an HTTPS web origin exists. The web view uses a nonpersistent
data store, a 10-second load timeout, and manual retry; non-200 responses and
unreachable servers show an error state rather than a blank page.

Tradeoffs: the tab needs the web frontend running, does not work offline, and
looks like a web page rather than native iOS UI. A native MapKit map or a shared
model (bundled TypeScript or a server engine) can replace it later if the demo
needs them. That later change needs its own ADR.
