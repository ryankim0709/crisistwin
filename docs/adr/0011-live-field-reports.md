# 0011: Live field reports and road status

Date: 2026-10-24. Status: accepted; not implemented; amended by [0012](0012-controller-guidance.md).

CrisisTwin so far plans and replays. This decision extends it to live use:
people on the ground report what they see (blocked roads, fire, smoke, downed
lines), the reports become a shared road and hazard status, and a controller
uses that status, together with the simulator, to move people around blockages.
The contract is in [live-reports.md](../live-reports.md).

## Who does what

- **Civilians** (iOS app) report anonymously with a pseudonymous device ID and
  see a public map of **highly confirmed** reports only (see below).
- **Field responders** (same iOS app, joined with a per-incident invite code)
  report, receive check tasks, and see every report with its confidence.
- **Controllers** (web, new Live page) see every report, confirm, dismiss,
  merge or resolve them, assign check tasks, and re-run the simulator on the
  current road status. A controller-confirmed block becomes a `close_road`
  command in the [Plan API](../plan-api.md) job pattern; that result is a
  simulated planning experiment like any other branch.

## What civilians see

A report reaches the public map only when it is corroborated by **independent
parties** and nothing newer and independent contradicts it. Two reports are from
the same party when they share a device or account, share a household group
(once the trusted circle from ADR 0009 exists), or were submitted within
`SAME_PARTY_WINDOW_S` and `SAME_PARTY_RADIUS_M` of each other (people in one car
or group). A public item needs one of:

- `PUBLIC_MIN_CIVILIAN_PARTIES` (3) independent civilian parties,
- one responder and one independent civilian party, or
- a controller confirmation.

Reports fade with age at a rate set per kind (a fire sighting goes stale in
minutes, a tree across the road lasts hours) and drop off the public map when
stale. `help_needed` reports are never public. The public map labels each item
with its kind in words, how many independent parties confirmed it, and when it
was last seen. It never shows "all clear" and says to follow official orders
first. All counting and fading is deterministic code; an LLM may summarize notes
for controllers but never sets status or confidence.

## Location and navigation

This replaces ADR 0009's "no location permission is requested". The meeting
plan still never reads location. The Report and Navigate features ask for
**When In Use** location (or a single read); the app never asks for Always and
never tracks in the background. The device position leaves the phone only
inside a report or a route request; route requests are not stored.

Navigation (P1) routes over the incident's road network and avoids segments
that are publicly confirmed blocked. Routes say "Avoids confirmed reports. Not
an official evacuation route; follow local authorities." Outside a packaged
road network, the app hands off to Apple Maps and warns when the destination
area has confirmed blocks. The route uses observed road status, not a
simulation result, so it is not a simulated recommendation presented as an
instruction.

## Stack

MongoDB through the existing `api/mongodb.py` boundary (ADR 0008); clients poll
with a `since` cursor. No Convex, WebSockets or push in this phase. Endpoints
fail closed: each requires a device, responder or controller token, issued and
checked server-side and stored hashed. (Amended: with `LIVE_CONTROLLER_TOKEN` unset, an
untokened request is the controller, so the drill console needs no token; set it to lock.) Civilian submissions are rate-limited per
device and per IP.

## Phases

- **P0, demo slice:** a live drill on the Camp road network with a simulation
  clock (no real incident is claimed); iOS Report sheet with offline queue; report
  endpoints; web Live page with feed, map and triage; the "re-run impact" button.
- **P1:** responder role and check tasks, "still blocked?" prompts, combined
  road status with fading, the public civilian map, in-app navigation, and the
  "check these first" ranking (project scope §10).
- **P2:** controller-published notices, photos with location metadata removed,
  SMS fallback, AI summaries and contradiction flags.

## Tradeoffs

Independence is a heuristic: anonymous devices can be faked, and two strangers
passing the same block at the same moment count as one party. Both errors keep
items off the public map rather than putting false ones on it. Device
attestation (App Attest) would raise the cost of fake devices later. Polling adds
seconds of delay but needs no new infrastructure. Road networks exist only for
packaged incidents, so navigation elsewhere is Apple Maps with a warning.
Showing crowd reports to civilians is a scope expansion beyond the project
scope's §19 portal; it is limited to observed, corroborated facts.
