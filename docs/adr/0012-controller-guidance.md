# 0012: Controller guidance in the live drill

Date: 2026-10-24. Status: accepted; not implemented. Amends
[ADR 0011](0011-live-field-reports.md).

ADR 0011 collects field reports and turns them into road and hazard status. This
decision closes the loop: the backend computes guidance for every zone from that
status and the current fire estimate, a human controller approves it, and each
phone shows the one instruction for its zone. The contract is v2 of
[live-reports.md](../live-reports.md).

## Authorization and scope

AGENTS.md forbids turning simulated recommendations into instructions "without an
explicitly authorized workflow". This ADR is that workflow, and it is scoped to the
**labeled drill** that replays the 2018 Camp Fire on the real Camp road network
with a drill clock. The web shows the drill clock and controls; the phone has no drill framing and shows only a small "Exercise" tag when the situation's `incident.mode` is not `live`. Nothing in
it is presented as a real incident, an official order, or authority approval. Using
it for a real incident needs a new decision and an integration with the responsible
authority.

## Agentic controller proposes, a human approves

- A deterministic planner computes, for each zone, a **level**
  (`evacuate_now`, `be_ready`, `none`), a destination and a route from the road
  network, the confirmed road blocks and the current fire estimate. Levels use
  named distance thresholds (`EVACUATE_NOW_KM` = 3, `BE_READY_KM` = 8). Routes come
  from a shortest-travel-time search that never crosses a blocked segment or the
  fire estimate; a zone with no open route is reported as `no_route`, never given
  an invented one.
- An LLM writes only the rationale text shown to the controller. It never chooses a
  level, destination, route, number or confidence. Without an API key the
  rationale is a template; both are labeled (`ai_generated` or `template`).
- The planner's output is a **proposal**: a diff against the published guidance.
  The human controller approves or rejects it on the web Live page.
- **Pre-approved policy:** a pure reroute (same level, new route or destination)
  caused by a confirmed road block or a fire estimate change is published at once
  as `auto_approved`. Level changes, new or cleared zones, and new check tasks wait
  for a controller. Every approval, rejection and auto-approval is logged in
  `live_decisions`.
- Only evidence a person in authority has checked can skip the controller: a road
  block counts as confirmed (cause `road_block`) when a controller confirmed it or a
  responder reported it. A block backed only by civilian reports (`road_report`), a
  full shelter (`shelter_full`), a zone that loses its last open route
  (`route_lost`) and a route the planner marks as exposed to the fire always wait
  for the controller, so the crowd can never publish guidance on its own. This holds
  whatever triggered the plan: a zone whose guidance differs between plans with and
  without the crowd-only blocks waits for the controller, even when the replan was
  caused by a confirmed block elsewhere or a fire update.
- **Partial approval:** the controller can approve some zones of a pending proposal
  (for example every evacuate-now zone first) without waiting to review the rest.
  The approved part becomes its own approved proposal with `parent_id` set; the
  original stays pending with the remaining changes, and its tasks are created when
  the last part is approved. Rejection is whole.

## Per-zone guidance and location

Guidance is published per zone, never per person. A civilian phone downloads the
zone polygons and finds its own zone **on the device** (point in polygon); its
location leaves the phone only inside a report or a `need_help` check-in, as in ADR
0011. Responders may opt in to sharing their live location so the controller can
assign tasks; the server keeps only the latest position, with a short expiry.

## One screen on the phone

The phone app is one screen about the live incident: a full-bleed map (you, the
current fire estimate, confirmed hazards, your route), a status strip (zone and
level) and one bottom sheet with the single instruction ("Leave via Pentz Road to
Chico shelter, 24 min") and "I'm out" / "Need help" check-ins. Responders see their
assigned task in the same sheet. Preparedness (meeting plan, About, My reports,
responder join) moves behind one menu button. The Practice tab and the tab bar are
removed from the phone; practice stays on the web.

## What the phone shows about fire

Only observed or confirmed facts plus the **current best estimate of where the fire
is now**: the newest of the satellite perimeter and the fitted model front at or
before drill time, plus recent fire observations. Never a forecast. It is always
labeled with its method and time ("Model estimate, 16:30 drill time").

## Tradeoffs

Zone-level guidance is coarse: one route per zone starts from one road node near
the zone centroid, and the travel time ignores congestion. Auto-approving reroutes
trades a human check for speed on the one change that keeps people off a confirmed
block. Polling (15-30 s on the phone) delays guidance by seconds. The drill clock
lets one person demo hours of the fire in minutes; reports still carry wall-clock
times and are mapped to drill time on receipt.
