# 0034: Multi-phone hosting

Date: 2026-10-24. Status: accepted.

Builds on [0012-controller-guidance](0012-controller-guidance.md) and
[0030-scenario-engine](0030-scenario-engine.md) (one active wildfire per hosted instance).

## Context

Several real phones should join one drill against one backend and one console. Where that
runs is undecided: the Mac on shared Wi-Fi, an HTTPS tunnel the user starts, or a cloud host
later. The iOS build embeds `API_BASE_URL` at compile time, so one build per host does not work.

## Decision

- **Phones learn the server at run time.** The compile-time `API_BASE_URL` stays the default.
  A join link `crisistwin://join?server=<origin>&code=<invite>` (custom URL scheme, no
  universal links) or a QR code of it (VisionKit `DataScannerViewController`) stores an
  override in UserDefaults. It is validated by the same rules as the build value: HTTPS
  anywhere, HTTP only for `.local` and `localhost` (Release builds: HTTPS only). Plan > About
  shows the server and has "Reset to default". The invite code is used once and not stored.
- **Phones never pick an incident.** `GET /api/live/active` (unauthenticated) returns
  `{incident_id, name, mode, label, join: {invite_required}}` for the instance's one incident,
  today the configured drill (`LIVE_ACTIVE_*` settings, defaulting to `camp-2018-drill`). The
  app fetches it before saving the override, so an unreachable address changes nothing. It
  carries no secret; `invite_required` is true when an invite code is configured.
- **Compose is loopback by default.** Ports bind to `${CT_BIND_ADDR:-127.0.0.1}`. Opening them
  to the LAN is an explicit user step. `DJANGO_ALLOWED_HOSTS`, `VITE_ALLOWED_HOSTS` and
  `DJANGO_CSRF_TRUSTED_ORIGINS` name the `.local` and tunnel hosts (`.local` is always accepted by Vite).
- **Controller rights stay local.** The Vite dev proxy signs `/api/live/` calls with
  `LIVE_CONTROLLER_TOKEN` only for local requests. Docker hides the real peer, so Compose now
  uses `LIVE_CONTROLLER_PROXY=host` (replacing `any`): sign only when the browser addressed the
  proxy as `localhost`/`127.0.0.1` and no forwarding header (tunnels add one) is present. A
  phone, or a console opened over `.local` or a tunnel, gets the token form. A host-header check
  can be forged by a hostile LAN client, so a shared network also needs `LIVE_CONTROLLER_TOKEN`
  set: when it is unset, untokened requests are the controller (ADR 0012).
- **The console makes the invitation.** /live's "..." menu has "Invite phones": server origin
  (default `window.location.origin`, editable), a typed invite code, the link and its QR code.
  Nothing secret is fetched; a QR code containing a code is labelled as such.

## QR library

`qrcode-generator` 1.4.4, pinned exactly: MIT, about 20 KB, no dependencies, ships its own
types, renders SVG. Writing a QR encoder (Reed-Solomon, mask selection) ourselves is not
worth the risk. Used only in the dialog; the link carries no more than an origin and a code.

## Consequences

- One iOS build works on Wi-Fi, through a tunnel and on a cloud host; switching is a scan.
- Tunnel quick-start hostnames change per run, so the link and QR must be regenerated.
- iOS asks for local-network and camera permission; plain HTTP works only for `.local` names.
- Switching servers drops this phone's device and responder credentials (they belong to one server).
- The console can now change the active incident ([0047-active-incident](0047-active-incident.md));
  `LIVE_ACTIVE_*` is only the default before a switch, and phones follow the endpoint.
