# Live reports API (v2, draft; not implemented)

Field reports, road status and check tasks for live use (see
[ADR 0011](adr/0011-live-field-reports.md)), and, since v2, the drill clock, the
current fire estimate, per-zone controller guidance, check-ins and responder
location (see [ADR 0012](adr/0012-controller-guidance.md)). v2 only adds fields,
values and endpoints; every v1 request and response stays valid. Base path `/api/live/`. Times are
UTC ISO 8601 with `Z`. Coordinates are WGS84 `[lon, lat]` in decimal degrees,
matching the sim and replay bundle. Distances are meters.

## Auth

Every endpoint needs `Authorization: Bearer <token>`. Tokens are stored hashed.

| Role | How the token is issued | Can |
| --- | --- | --- |
| `civilian` | `POST devices` (no input; rate-limited per IP) | submit reports, answer prompts, read own reports, read the public map |
| `responder` | `POST incidents/{id}/join` with an invite code | the above, plus read all reports and own tasks |
| `controller` | provisioned by the team (dev: `LIVE_CONTROLLER_TOKEN`, see [Controller auth](#controller-auth-v2)) | everything, including triage, tasks, proposals and the drill clock |

## Report kinds

`road_blocked`, `road_passable`, `heavy_traffic`, `fire_seen`, `heavy_smoke`,
`hazard_down` (power line or tree), `shelter_full`, `help_needed`. Road kinds
snap to a road segment; `shelter_full` refers to a destination of kind `shelter`
or `temporary_refuge` (`400` for an exit); the rest cluster
by distance. `help_needed` is never public.

`severity`: `full` | `partial` (lane or one direction) | `slow` | `null`.

## Documents (MongoDB)

`live_reports`:

```jsonc
{
  "id": "rpt_01J...",                    // server-assigned
  "client_id": "uuid",                   // set by the device; makes offline retries idempotent; compared case-insensitively
  "incident_id": "camp-2018-drill",
  "reporter": { "role": "civilian", "party_key": "dev_9f2..." },  // pseudonymous
  "kind": "road_blocked",
  "severity": "full",
  "location": { "coord": [-121.6012, 39.7593], "accuracy_m": 12 },
  "heading_deg": 90,                     // optional direction of travel
  "road_ref": { "segment_id": "seg_123", "name": "Skyway", "snap_m": 8 },  // server-filled
  "destination_id": null,
  "task_id": null,                       // set when a responder answers a check task; closes it
  "observed_at": "2026-10-24T18:02:10Z", // device clock, at capture
  "received_at": "2026-10-24T18:05:41Z", // server clock; later when queued offline
  "note": "Tree across both lanes",
  "status": "unverified",                // unverified|corroborated|responder_confirmed|confirmed|dismissed|resolved
  "evidence_class": "field_report",
  "replay_at": "2018-11-08T16:12:00Z"   // v2, server-filled: drill time at received_at; null when no drill runs
}
```

`live_tasks`: `{ id, incident_id, assignee, kind: "verify", target: { segment_id | coord }, report_ids, created_at, status: open|accepted|done|cancelled, answer }`.
`assignee` is a responder `party_key`, or `null` for any responder (v2: the first to
accept becomes the assignee). `accepted` is new in v2.

`live_tasks.note` is optional free text from the controller. Answering a task is
submitting a report with its `task_id`; `POST tasks/{id}` with
`{ "status": "cancelled", "note": "Could not reach it" }` closes it unanswered.

`live_decisions`: an append-only audit log of triage, task, approval, drill and help actions: `{ at, actor, action, report_ids, proposal_id, checkin_id, note }`.

Road status and public items are computed when read from current reports in P0;
store them in their own collection only if reads get slow.

## Endpoints

| Method and path | Role | Purpose |
| --- | --- | --- |
| `POST devices` | none | Issue a civilian token |
| `POST incidents/{id}/join` | none | Exchange an invite code for a responder token |
| `POST incidents/{id}/reports` | any | Submit a report; same `client_id` returns the existing report |
| `GET incidents/{id}/reports?since=<cursor>` | responder, controller | New and changed reports, plus `next_cursor` |
| `GET me/reports` | any | Own reports with status |
| `POST reports/{id}/triage` | controller | `{ "action": "confirm|dismiss|merge|resolve", "into": "rpt_..."?, "note": "" }` |
| `GET incidents/{id}/road-state` | responder, controller | Per-segment status (below) |
| `GET incidents/{id}/public-map` | any | Public items only (rules below) |
| `GET incidents/{id}/prompts?near=lon,lat` | any | Nearby items to answer "still there?" with `road_blocked` / `road_passable` |
| `POST incidents/{id}/tasks`, `GET me/tasks`, `POST tasks/{id}` | controller; responder | Create, list and answer check tasks |
| `POST incidents/{id}/impact` | controller | Impact of one road segment, blocked vs unblocked: affected zones, ETA delta, vehicles at risk (v2, [Impact analysis](#impact-analysis)) |
| `POST incidents/{id}/route` | any | `{ origin, destination }` -> a route avoiding publicly confirmed blocks; not stored (P1) |

`POST devices` and `POST incidents/{id}/join` (body `{ "invite_code": "..." }`) return
`{ "token": "...", "role": "civilian|responder", "party_key": "dev_9f2...", "incident_id": "..."|null }`.
A submitted report needs every field of the stored document except `id`,
`reporter`, `road_ref`, `received_at`, `status` and `evidence_class`, which the server fills.

`public-map` and `prompts` item:

```jsonc
{ "id": "pub_seg_123_road_blocked", "kind": "road_blocked", "severity": "full",
  "coord": [-121.6012, 39.7593], "road_ref": { "segment_id": "seg_123", "name": "Skyway", "snap_m": 8 },
  "line": [[-121.6015, 39.7590], [-121.6009, 39.7596]],   // segment polyline, or null off-road
  "independent_parties": 3, "responder_reports": 1, "controller_confirmed": false,
  "confidence": 0.82, "first_reported_at": "...Z", "last_observed_at": "...Z" }
```

`GET me/tasks` returns `{ "tasks": [CheckTask] }`, `GET me/reports` returns
`{ "reports": [FieldReport] }`, and `public-map` and `prompts` return `{ "items": [...] }`.

`road-state` item:

```jsonc
{ "segment_id": "seg_123", "name": "Skyway", "status": "blocked",   // open|slow|blocked|unknown
  "confidence": 0.82, "independent_parties": 3, "responder_reports": 1,
  "last_observed_at": "...Z", "report_ids": ["rpt_..."], "decided_by": null, "public": true }
```

Errors: `400 { "error": "invalid_report", "detail": "..." }`, `401`, `403`, `404`,
`429` when rate-limited, `503` when MongoDB is unavailable.

## Rules (deterministic; constants named in code)

- **Same party:** same `party_key`, the same household group (later), or
  submitted within `SAME_PARTY_WINDOW_S` = 120 and `SAME_PARTY_RADIUS_M` = 100 of each other.
- **Public** when not dismissed or stale and one of: at least
  `PUBLIC_MIN_CIVILIAN_PARTIES` = 3 independent civilian parties; one responder
  and one independent civilian party; or controller `confirm`. A newer
  contradicting report from an independent party removes it until it is
  corroborated again.
- **Fading:** confidence halves every `HALF_LIFE_S[kind]` since the last
  corroboration (starting values: `fire_seen` 900, `heavy_smoke` 900,
  `heavy_traffic` 900, `road_blocked` 7200, `hazard_down` 14400,
  `shelter_full` 3600). Stale below `STALE_CONFIDENCE` = 0.25.
- **Routing:** only controller-confirmed blocks enter the simulator. Public
  navigation avoids publicly confirmed blocks. Neither route crosses a closed
  edge (the AGENTS.md invariant).
- **Location:** the device sends position only inside a report, a prompt query or
  a route request. Remove photo location metadata on upload (P2).

## Polling

Web Live page: every 5 s with `since`. iOS: every 15-30 s while in the foreground.
Clients abort in-flight requests on navigation and drop responses older than the
latest cursor.

---

# v2: drill, guidance, check-ins (ADR 0012)

Everything below is additive. Pure computations live in `app/backend/livecore/`
(no Django, no PyMongo); the Django package `app/backend/api/live/` stores
documents and serves the endpoints. The web types are `app/src/live/types.ts`; the
iOS types are `mobile/CrisisTwin/Features/Live/LiveModels.swift`.

The P0 incident is `camp-2018-drill`. Its drill data (roads, zones, destinations,
fire perimeters, fitted model fronts, fire observations) is the Camp replay bundle
(`app/public/replays/camp-2018.json`, format in [replay-bundle.md](replay-bundle.md)),
read once per process from the path in `LIVE_DRILL_BUNDLE`.

## Drill clock

`live_drills` holds one document per incident:

```jsonc
{ "incident_id": "camp-2018-drill",
  "replay_start": "2018-11-08T15:00:00Z",  // drill time when the clock (re)started
  "started_at": "2026-10-24T18:00:00Z",    // wall time when it (re)started; null = stopped
  "speed": 1,                              // drill seconds per wall second, 0..60; 0 pauses
  "updated_at": "2026-10-24T18:00:00Z", "updated_by": "controller" }
```

`replay_now = replay_start + (wall_now - started_at) * speed`, clamped to the
bundle `clock.end` (`2018-11-09T08:00:00Z`). With no document, or `started_at:
null`, the clock is stopped and `replay_now = replay_start`. The default
`replay_start` is `DEFAULT_REPLAY_START` = `2018-11-08T15:00:00Z`; the default
speed is 1. The drill clock drives the fire estimate and planning; reports keep
wall-clock `observed_at`/`received_at` and get a server-filled `replay_at`.

Drill object in responses (`DrillState`):

```jsonc
{ "incident_id": "camp-2018-drill",
  "label": "Drill: 2018 Camp Fire replay. Not a real incident.",
  "replay_now": "2018-11-08T16:12:30Z", "replay_start": "2018-11-08T15:00:00Z",
  "started_at": "2026-10-24T18:00:00Z", "speed": 1, "running": true,
  "clock": { "start": "2018-11-08T14:00:00Z", "end": "2018-11-09T08:00:00Z" } }
```

`running` is `started_at != null && speed > 0 && replay_now < clock.end`. The
situation response carries the short form `{ label, replay_now, speed, running }`.

`POST incidents/{id}/drill` (controller), body `{ "action": "start|reset|set_speed", "replay_start"?: "...Z", "speed"?: number }`:

- `start`: `replay_start = body.replay_start ?? DEFAULT_REPLAY_START`, `started_at = now`, `speed = body.speed ?? current ?? 1`.
- `set_speed`: rebase without a jump: `replay_start = replay_now`, `started_at = now`, `speed = body.speed` (required).
- `reset`: `replay_start = DEFAULT_REPLAY_START`, `started_at = null`, `speed = 1`; deletes the incident's
  `live_guidance`, `live_proposals` and `live_checkins`. Reports, tasks and decisions are kept.

`replay_start` must be within the bundle clock; `speed` within 0..60
(`MAX_DRILL_SPEED`). Returns `200 { "drill": DrillState }`; logs a `drill_<action>`
decision. Invalid input: `400 { "error": "invalid_drill", "detail": "..." }`.

## Fire estimate (current best estimate, never a forecast)

```jsonc
{ "as_of": "2018-11-08T16:00:00Z",          // drill time of the source geometry; null when method is none
  "method": "model_nowcast",                 // satellite_perimeter|model_nowcast|none
  "label": "Model estimate, 16:00 drill time",
  "geometry": { "type": "MultiPolygon", "coordinates": [[[[-121.43, 39.81], ...]]] },  // null when none
  "observations": [ { "coord": [-121.434, 39.8146], "at": "2018-11-08T15:55:00Z", "source": "nist_reconstructed" } ],
  "evidence_class": "simulated" }            // reconstructed|simulated|none
```

Rule (`livecore.fire.estimate_fire`): take the newest of the bundle's observed
perimeters (`fire.perimeters`, method `satellite_perimeter`, evidence
`reconstructed`) and simulated fronts (`fire_simulated.fronts`, method
`model_nowcast`, evidence `simulated`) with `at <= replay_now`; on a tie prefer the
perimeter. None yet: method `none`, `geometry: null`. `observations` are the
bundle's `fire_observations` (`source: "nist_reconstructed"`) and confirmed
`fire_seen` reports (`source: "field_report"`, `at` = the report's `replay_at`)
with `replay_now - FIRE_OBSERVATION_WINDOW_MIN (60) <= at <= replay_now`. Labels:
`"Satellite perimeter, HH:MM drill time"`, `"Model estimate, HH:MM drill time"`,
`"No fire estimate yet"` (HH:MM in UTC `as_of`; clients may reformat but must keep method and time).

## Zones and guidance

Zones are the bundle's 43 `zones.features` (`evidence_class: derived`):
`{ "id": "bg:060070009011", "name": "Block Group 1, Census Tract 9.01", "geometry": Polygon|MultiPolygon }`.
`zones_version` is an opaque string that changes when any zone id or geometry changes.
The command response adds `households` and `vehicles`.

Published guidance (`ZoneGuidance`), one current entry per zone that has ever had guidance:

```jsonc
{ "zone_id": "bg:060070009011",
  "level": "evacuate_now",                   // evacuate_now|be_ready|none
  "destination": { "id": "shelter:chico-1", "name": "Chico shelter", "kind": "shelter", "coord": [-121.83, 39.73] },  // null when level none or no_route
  "route": { "line": [[-121.60, 39.76], [-121.61, 39.75]],
             "via": ["Pentz Road", "Highway 99"],   // up to 3 longest-named roads, in route order
             "distance_m": 21450, "eta_min": 24 },   // eta: integer minutes, free-flow, rounded up
  "no_route": false,                         // true: needs to move but no open route; destination and route null
  "reason": "Fire estimate within 3 km",     // short deterministic text
  "reason_code": "fire_within_evacuate_km",  // fire_within_evacuate_km|fire_within_ready_km|no_open_route|clear
  "version": 3,                              // per zone, starts at 1, +1 on each publish
  "published_at": "2026-10-24T18:04:10Z",    // wall time
  "replay_at": "2018-11-08T16:10:00Z",       // drill time the plan was computed for
  "approved_by": "auto_policy",              // auto_policy|controller
  "proposal_id": "prp_01J..." }
```

Additive fields (D1 destination choice, D2 fire caveat); clients must accept their absence:

```jsonc
{ "route": { "...": "as above", "safety": "clear" },          // clear|passes_near_fire|passes_fire
  "caveat": "Every route out passes through the fire",          // string|null; see below
  "alternatives": [                                              // recommended first, then up to 3; [] when no choice
    { "destination": { "id": "exit:south", "name": "Exit south", "kind": "exit", "coord": [-121.59, 39.70] },
      "route": { "line": [[-121.60, 39.76], [-121.59, 39.70]], "via": ["Clark Road"], "distance_m": 9800, "eta_min": 14, "safety": "clear" },
      "safety": "clear",
      "load": 0.42,                                              // 0..1 share of capacity already heading there; null when unknown
      "recommended": true } ] }
```

- `route.safety`: `passes_fire` when any road edge of the route is inside or crosses the
  fire estimate, `passes_near_fire` when it stays outside but within `FIRE_BUFFER_M` (300 m),
  else `clear` (`livecore.planner.route_safety`).
- `caveat` is set only when every option passes the fire, which is exactly when the
  recommended route is not `clear` (a clear route anywhere would have been chosen):
  `"Every route out passes through the fire"` (`THROUGH_FIRE_CAVEAT`) with `passes_fire`,
  `"Every route out passes near the fire"` (`NEAR_FIRE_CAVEAT`) with `passes_near_fire`,
  else `null`. Show it as the headline caveat.
- `alternatives` is `[]` for `level: "none"`, `no_route`, and when the zone has no
  destination besides the recommended one. When non-empty, the first entry is the
  published `destination` (`recommended: true`) and the others are `recommended: false`.
  Alternative `route.line`s are simplified (Douglas-Peucker 30 m, at most 80 points,
  5 decimals); the recommended entry's line is that simplified copy of `route.line`.
- `load`: vehicles heading there / capacity, clamped to 1, 2 decimals. Heading there: the
  vehicles of every `evacuate_now` zone the current plan sends there, plus
  `PREFERENCE_VEH_PER_CHOICE` (1) per live civilian choice (`POST me/destination`).
  Capacity: the destination's `capacity_veh`; for an exit without one, the hourly capacity
  of the road edges entering its node times `LOAD_EXIT_WINDOW_H` (1 h). `null` when unknown
  (every Camp refuge). The twin's simulated vehicles are not used.
- `route.safety`, `caveat` and `alternatives` are derived fields: every replan rewrites them
  in place on the zone's current version **without a version bump**. Clients re-check, on
  every poll, that a chosen destination is still in `alternatives`.

Alternatives (`livecore.planner.with_alternatives`, `livecore.routing.alternative_routes`)
are reachable exits and open refuges for that zone, computed by the same router with the
same closed-edge rules: one forward Dijkstra from the zone's origin, with the edge cost of
the pass that produced the recommended route (open edges only for a clear route, the
near-fire or through-fire cost otherwise), so an alternative is never in a worse safety
class than the recommended route. The destinations are the planner's usable set: never
inside the fire estimate, never full, and a temporary refuge only when it is farther than
`REFUGE_FIRE_BUFFER_M` (1000 m) from the fire estimate. Ranked by safety class, then exits
and shelters before refuges, then search cost x (1 + `LOAD_RANK_WEIGHT` (1) x load). Each
must be at least `ALTERNATIVE_MIN_SEPARATION_M` (1500 m) from the recommended destination and
from those already listed, and spend at most `ALTERNATIVE_MAX_EXTRA_FIRE_S` (60 s) more
inside the fire than the recommended route. Load (and so civilian choices) only reorders
alternatives; it never changes the recommended destination, which the controller approves.
When a change for the zone is pending, the published destination stays first (its safety
re-measured on its line) and the others are the current plan's offers, so a destination
that became unsafe or unreachable drops out at the next replan.

`POST me/destination` (civilian or responder token; no incident in the path, as
`me/location`): `{ "zone_id": "bg:…", "destination_id": "exit:south" }`
-> `200 { "zone_id", "destination_id", "expires_at" }`. Stored in `live_destination_choices`
(one per device and zone, upserted; `expires_at` = now + 2 h, `DESTINATION_CHOICE_TTL_S`;
TTL index); no location. `400 invalid_destination` when a field is missing, the zone is
unknown, or the destination is not currently offered for that zone (in its `alternatives`,
or its `destination` when `alternatives` is empty); `403` for the controller token; `429`
after `DESTINATION_CHOICES_PER_MIN` (10) per device per minute. The controller's command
response adds `destination_preferences: [{ "zone_id", "destination_id", "count" }]`
(unexpired choices, sorted by zone, then count descending); the planner uses the counts as
a soft load input (`PREFERENCE_VEH_PER_CHOICE`, above), read at each replan. A phone whose
chosen destination is no longer offered falls back to the recommended one and says so in
one short line.

A zone with no entry, or with `level: "none"`, has no instruction. Phones compose
the instruction from `level`, `route.via[0]`, `destination.name` and
`route.eta_min` ("Leave via Pentz Road -> Chico shelter, 24 min").

Planner rules (`livecore.planner.plan`, constants named in code):

- Distance from a zone to the fire is the minimum distance between the zone polygon
  and the fire estimate geometry (0 if they overlap), in km. `<= EVACUATE_NOW_KM`
  (3) -> `evacuate_now`; `<= BE_READY_KM` (8) -> `be_ready`; else `none`. No fire
  estimate -> `none` everywhere.
- Routes (`livecore.routing.best_routes`): one origin per zone, the road node
  nearest the zone's centroid; destinations of kind `exit` and `shelter` (falling
  back to `temporary_refuge` when neither is reachable), snapped to their nearest
  road node, excluding destinations inside the fire estimate and shelters with a
  public `shelter_full` item. Multi-source Dijkstra on free-flow travel time
  (`length_m / speed_kph`). Never uses an edge whose `segment_id` is blocked or
  whose midpoint lies inside the fire estimate. Unreachable -> `no_route: true`.
- Blocked segments for guidance are road-state items with `status: "blocked"` and
  `public: true` (this includes controller confirmations). The impact analysis
  (`POST incidents/{id}/impact`) starts from the same blocks and toggles one segment.

## Proposals and the approval policy

The planner never publishes directly. `livecore.policy.diff` compares its output
with the published guidance and yields changes:

| `kind` | when |
| --- | --- |
| `new` | no published entry (or published `none`) and proposed level is not `none` |
| `cleared` | published level is not `none` and proposed level is `none` |
| `level_change` | both not `none` and the levels differ |
| `route_lost` | same level (not `none`), proposed `no_route` and published not |
| `reroute` | same level (not `none`) and `destination_id`, `via` or `no_route` differs (not `route_lost`) |

An ETA change alone is not a change. `live_proposals` document (`Proposal`):

```jsonc
{ "id": "prp_01J...", "incident_id": "camp-2018-drill",
  "created_at": "2026-10-24T18:04:09Z",   // wall
  "replay_at": "2018-11-08T16:10:00Z",    // drill time planned for
  "status": "pending",                    // pending|approved|rejected|auto_approved|superseded
  "policy": "needs_controller",           // auto_reroute|needs_controller
  "causes": ["road_block"],               // road_block|road_report|fire|shelter_full|manual
  "cause_segment_ids": ["osm-way:10287575:0"],  // newly blocked backed segments; on pending, plus crowd-only segments driving its changes
  "inputs": { "fire_as_of": "2018-11-08T16:00:00Z", "fire_method": "model_nowcast",
              "blocked_segment_ids": ["osm-way:10287575:0"], "full_destination_ids": [],
              "planner_version": "planner-v1", "controller": "twin" },
  "controller": { "id": "twin", "version": "twin-controller-v1", "fallback": null },  // see Controllers
  "twin": TwinEvidence | null,            // TwinController only; see Controllers
  "changes": [
    { "zone_id": "bg:060070009011", "kind": "level_change",
      "from": { "level": "be_ready", "destination_id": "shelter:chico-1", "via": ["Skyway"] },
      "to": { "level": "evacuate_now", "destination": { "id": "shelter:chico-1", "name": "Chico shelter", "kind": "shelter", "coord": [-121.83, 39.73] },
              "route": { "line": [[-121.60, 39.76], [-121.61, 39.75]], "via": ["Pentz Road"], "distance_m": 21450, "eta_min": 24 },
              "no_route": false, "reason": "Fire estimate within 3 km", "reason_code": "fire_within_evacuate_km" } } ],
  "tasks": [
    { "target": { "segment_id": "osm-way:10287575:0", "coord": [-121.6012, 39.7593] },
      "reason": "One unverified road_blocked report on Pentz Road", "report_ids": ["rpt_01J..."],
      "assignee": "rsp_7c1..." } ],       // nearest responder with a fresh location, or null (any responder)
  "rationale": { "text": "Pentz Road is confirmed blocked ...", "generated_by": "llm:claude-opus-5-5",
                 "evidence_class": "ai_generated" },   // or generated_by "template", evidence_class "template"
  "decided_at": null,                     // wall
  "decided_replay_at": null,              // drill time of the decision (null outside a drill)
  "decided_by": null, "note": null,
  "parent_id": null }                     // set on the approved part of a partial approval
```

`from` is `null` for `new`; `to.level` is `"none"` with null destination and route
for `cleared`. Proposed `tasks` are verify tasks for unverified road reports that
would change a route if confirmed.

Policy (`livecore.policy`): a change is auto-approvable when its `kind` is
`reroute`, its proposed route is not marked `exposed` by the planner, and every cause
is `road_block` or `fire`. `route_lost`, exposed routes, level changes, new and
cleared zones always wait for the controller, as does every change of a plan whose
causes include `road_report`, `shelter_full` or `manual`. Whatever triggered the
plan, a change driven by a block backed only by civilian reports waits too: the
server plans with and without those crowd-only blocked segments, and every zone
whose planned guidance differs is held for the controller, with `road_report` added
to the pending part's causes (it replaces a `road_block` trigger that drives none of
the held changes). So confirming one block, or a fire update, never publishes a
reroute around another, unconfirmed one. When the server plans, it
splits the changes: the auto-approvable ones become an `auto_approved` proposal
(`policy: "auto_reroute"`, `decided_by: "auto_policy"`) and are published at once;
the rest, plus all tasks, become one `pending` proposal (`policy:
"needs_controller"`) diffed against guidance after the auto part is applied. A
new pending proposal marks older pending ones `superseded`. Manual replans
(`causes: ["manual"]`) are always pending.

The server plans when the controller calls `replan`, after a controller `confirm`
of a `road_blocked` or `fire_seen` report (cause `road_block` / `fire`), and lazily
on a `situation` or `command` read when the fire estimate, the set of blocked
segments or the set of full destinations differs from the latest plan's `inputs`, at
most once per `AUTO_REPLAN_MIN_INTERVAL_S` (30) wall seconds per incident. Causes of
that lazy replan: `fire` for a new fire estimate; `road_block` when every segment
that entered or left the blocked set is controller confirmed (`decided_by:
"controller"`) or has at least one responder report, otherwise `road_report` (a
crowd-only block, never auto-approved); `shelter_full` when `full_destination_ids`
changed.

A new pending proposal replaces (supersedes) the current one unless it has the same
changes (zone, kind, level, destination, `via`, `no_route`), the same tasks and the
same `controller.id` and `controller.fallback`; so a twin-scored plan supersedes a
`twin_warming` rule fallback even when the changes match. Otherwise the current
pending proposal is kept and `replan` returns its id again.

An automatic replan triggered by a `situation` or `command` read runs in a background
thread, so the read never waits for it; its proposals appear in the next `command` poll.

## Controllers

The controller is a plug-in (`app/backend/api/live/controllers.py`): it observes the
situation snapshot and returns guidance for every zone; the proposal flow above diffs,
splits and publishes it. `LIVE_CONTROLLER` selects it:

| Value | Controller |
| --- | --- |
| `rule` | `RuleController`: the livecore planner (levels by fire distance, nearest usable destination by free-flow time) |
| `twin` | `TwinController`: below |
| unset (default) | `twin` while the traffic twin can be built, else `rule` (logged) |

`TwinController` keeps every level from the planner. For zones whose guidance changes and
that must move, it builds candidate destination sets: the planner's routes; "Keep current
destinations" where a zone's published destination is still usable; the second-nearest
usable destination for each of the 4 zones with the most vehicles; and all of them at
their second choice. Each set becomes twin actions (`order_zone` for `evacuate_now` zones
the twin has not ordered yet, `reroute_zone` per destination), and one twin what-if
(60 min, `fire_ahead: "frozen"`) scores them. The cost and the margin a set must beat
are in [twin-api.md](twin-api.md#controller-objective-twincontroller). The reference set
("Keep current destinations" when present, else the planner's) wins unless another set
is cheaper by the margin. Routes shown to people are the free-flow routes to the chosen
destination; the twin routes its simulated vehicles with its own queue-aware routing.

When the twin is still loading, fails, or rejects the planner's set, the proposal uses the
planner and says why in `controller`: `{ "id": "rule", "fallback": "twin_warming" }`
(also `twin_failed`, `twin_busy`, `twin_finished`, `twin_error:<code>`,
`twin_planner_set_invalid`). A twin-scored replan takes about 5–7 s at 16:00Z (6 sets plus
the baseline); a controller `confirm` waits for it.

`TwinEvidence` (all values simulated):

```jsonc
{ "evidence_class": "simulated",
  "from": "2018-11-08T16:01:50Z", "until": "2018-11-08T17:01:50Z", "horizon_min": 60,
  "fire_ahead": "frozen", "seed": 7, "inputs_fingerprint": "dbe294975d1426a3", "action_log_hash": "826d386c86a663a3",
  "objective": { "name": "controller_cost_veh_min", "sense": "minimize",
                 "formula": "1*total_exposed_veh_min + 15*blocked_at_horizon_veh + 60*trapped_by_fire_at_horizon_veh + 1*remaining_at_horizon_veh",
                 "weights": { "total_exposed_veh_min": 1.0, "blocked_at_horizon_veh": 15.0,
                              "trapped_by_fire_at_horizon_veh": 60.0, "remaining_at_horizon_veh": 1.0 },
                 "min_gain_veh_min": 250.0 },
  "baseline": { "label": "No new actions", "cost": 84949.0, "metrics": Metrics },
  "candidates": [ { "label": "Planner routes", "destinations": { "bg:060070018001": "exit:osm-node:86546172" },
                    "valid": true, "cost": 82444.0, "metrics": Metrics, "errors": [] } ],
  "chosen": 0,          // index into candidates
  "reference": 0,       // the set that wins ties
  "orders": ["bg:060070017021"],          // zones the sets order (not yet ordered in the twin)
  "runtime_ms": 5713,
  "limitations": ["Single seed; small differences are not significant.", "..."] }
```

`Metrics` is `{ arrived_in_window_veh, total_exposed_veh_min, blocked_at_horizon_veh,
trapped_by_fire_at_horizon_veh, remaining_at_horizon_veh }` from the what-if. The template
rationale adds one sentence with the chosen set's cost and the no-new-actions cost; the
LLM rationale receives the same numbers as `facts.twin` and may only explain them.

The rationale is written after the numbers are fixed: the LLM receives the changes
and inputs and returns text only; on a missing key, timeout (10 s) or refusal the
server uses a template. Model: `LIVE_RATIONALE_MODEL` (default `claude-opus-5-5`),
key `ANTHROPIC_API_KEY`.

## Check-ins

`POST incidents/{id}/checkins` (any role), body:

```jsonc
{ "status": "need_help", "zone_id": "bg:060070009011", "coord": [-121.6012, 39.7593] }
```

`status`: `out` (left the area) | `need_help` | `staying`. `zone_id` is optional
(the phone's on-device zone). `coord` is allowed **only** with `need_help`
(otherwise `400 invalid_checkin`). The server keeps the latest check-in per
party (upsert on `incident_id` + `party_key`) and drops a stored `coord` when the
status changes away from `need_help`. Returns `200 { "checkin": CheckIn }`:

```jsonc
{ "id": "chk_01J...", "status": "need_help", "zone_id": "bg:060070009011",
  "coord": [-121.6012, 39.7593], "at": "2026-10-24T18:06:00Z", "replay_at": "2018-11-08T16:16:00Z",
  "help": { "status": "open", "assignee": null, "task_id": null, "updated_at": "2026-10-24T18:06:00Z" } }
```

### Help requests

`help` is `null` unless `status` is `need_help`. Its `status` is `open` (new) |
`acknowledged` | `assigned` (an `assist` task exists) | `resolved`. A repeated
`need_help` keeps an active `help`; one after `resolved` opens a new request. Checking in
`out` or `staying` resolves an active request and cancels its open `assist` task. The
phone reads its own `help` from `situation.my_checkin` and shows "Request seen" /
"Responder assigned".

`POST checkins/{id}/help` (controller): `{ "action": "acknowledge" | "assign" | "resolve",
"assignee"?: "rsp_..." | null, "note"?: "" }` -> `200 { "checkin": CheckIn }`. `assign`
needs a shared `coord` (else `400`) and creates a task `{ "kind": "assist", "checkin_id",
"target": { "coord" } }`, cancelling a previous one. `resolve` marks an open assist task
`done`. `409` when the request is resolved or the check-in is no longer `need_help`. Each
action is logged in `live_decisions` as `help_<action>` with `checkin_id`.

## Responder location (opt-in)

`POST me/location` (responder only): `{ "coord": [-121.6, 39.76], "accuracy_m": 15, "at": "2026-10-24T18:06:00Z" }`
-> `204`. Upserts the one latest position per responder, expiring after
`RESPONDER_LOCATION_TTL_S` (900) s. `DELETE me/location` -> `204` removes it at once
(the phone calls it when sharing is turned off). Phones send at most one update per
`RESPONDER_LOCATION_MIN_INTERVAL_S` (30) s, foreground only. Civilian tokens get `403`.

## Tasks (v2 additions)

`POST tasks/{id}` also accepts `{ "status": "accepted" }` from a responder: allowed
when the task is `open` and unassigned or assigned to the caller; sets `assignee` to
the caller. Returns `200 { "task": CheckTask }`; `409` if already accepted by
someone else or closed. `GET me/tasks` returns tasks assigned to the caller plus
open unassigned ones. `CheckTask` gains `assignee` (`party_key` or `null`).
`POST incidents/{id}/tasks` (controller) takes
`{ "assignee": "rsp_..."|null, "target": { "segment_id"?: "...", "coord"?: [lon, lat] }, "report_ids": [], "note"?: "" }`
and returns `201 { "task": CheckTask }`.

`CheckTask.kind` is `verify` or `assist` (go to a resident who asked for help; it carries
`checkin_id`). An assist task has no report to answer it: the responder closes it with
`POST tasks/{id}` `{ "status": "done" }`, which resolves the help request.

## Situation (the phone's one poll)

`GET incidents/{id}/situation[?zones=0]` (any role). Polled every 15-30 s in the
foreground. `zones=0` omits geometry (`zones: null`) once the phone has cached the
zones; if the returned `zones_version` differs from the cached one, the phone
fetches again without `zones=0`.

```jsonc
{ "incident_id": "camp-2018-drill",
  "generated_at": "2026-10-24T18:06:05Z",
  "incident": { "id": "camp-2018-drill", "name": "Camp Fire 2018 exercise", "mode": "exercise" },
  "drill": { "replay_now": "2018-11-08T16:16:05Z", "speed": 1, "running": true },  // web only; the phone ignores it
  // The phone shows an "Exercise" tag only when incident.mode != "live". A replay drill is
  // always "exercise" (livecore.drill.REPLAY_INCIDENT_MODE); "live" is reserved for a real feed.
  "zones_version": "zones-3f2a9c1d",
  "zones": [ { "id": "bg:060070009011", "name": "Block Group 1, Census Tract 9.01",
               "geometry": { "type": "MultiPolygon", "coordinates": [[[[-121.61, 39.86], ...]]] } } ],
  "guidance": [ ZoneGuidance ],
  "fire": FireEstimate,
  "hazards": [ PublicMapItem ],             // exactly the public-map items
  "tasks": [ CheckTask ],                   // responders: same as GET me/tasks (open + accepted); civilians: []
  "my_checkin": CheckIn | null }
```

## Command (the web controller's one poll)

`GET incidents/{id}/command` (controller). Polled every 5 s.

```jsonc
{ "incident_id": "camp-2018-drill",
  "generated_at": "...Z",
  "incident": { "id": "camp-2018-drill", "name": "Camp Fire 2018 exercise", "mode": "exercise" },
  "drill": DrillState,
  "fire": FireEstimate,
  "zones_version": "zones-3f2a9c1d",
  "zones": [ { "id": "...", "name": "...", "households": 1010, "vehicles": 1729, "geometry": {...} } ],
  "destinations": [ { "id": "exit:osm-node:86371270", "name": "Exit south via Table Mountain Boulevard",
                      "kind": "exit", "coord": [-121.569105, 39.531675], "capacity_veh": null } ],
  "guidance": [ ZoneGuidance ],            // published, current version per zone
  "proposals": [ Proposal ],                // all pending, plus the latest 20 decided; newest first
  "reports": [ FieldReport ],               // newest 500
  "road_state": [ RoadStateItem ],
  "public_items": [ PublicMapItem ],        // what civilians see
  "checkins": {
    "by_zone": [ { "zone_id": "bg:060070009011", "out": 12, "need_help": 1, "staying": 3 } ],
    "need_help": [ { "id": "chk_01J...", "zone_id": "bg:060070009011", "coord": [-121.6012, 39.7593], "at": "...Z",
                     "help": { "status": "open", "assignee": null, "task_id": null, "updated_at": "...Z" } } ] },
                                            // need_help counts and list exclude resolved requests
  "destination_preferences": [ { "zone_id": "bg:060070009011", "destination_id": "exit:osm-node:86546172", "count": 4 } ],
  "responders": [ { "party_key": "rsp_7c1...", "coord": [-121.6, 39.76], "accuracy_m": 15, "at": "...Z" } ],
  "tasks": [ CheckTask ],                   // all not cancelled
  "decisions": [ { "at": "...Z", "actor": "controller", "action": "confirm", "report_ids": ["rpt_..."],
                   "proposal_id": null, "checkin_id": null, "note": null } ],  // newest 50, for the activity log
  "response_record": [ { "id": "nist-tn2252:t11:concow:warning-request:bg", "at": "2018-11-08T15:22:00Z",
                         "type": "evacuation_warning", "label": "...", "evidence_class": "reconstructed",
                         "source_id": "nist-tn2252", "source_url": "https://...#page=94",
                         "time_precision": "minute", "zone_ids": ["bg:060070024001"],
                         "segment_ids": [] } ] }
```

`response_record` is the historical 2018 Camp Fire response record, not drill actions: the bundle `events`
whose `evidence_class` is not `simulated` (reconstructed, reported or derived; orders, warnings, CodeRED alerts,
contraflow, closures, shelters, burnover, fire arrival). Only events with `at` <= the drill's `replay_now`,
newest first, at most 100. `segment_ids` are the road segments of the event's `target.edge_ids` (at most 50).

## Controller actions

| Method and path | Body | Returns |
| --- | --- | --- |
| `POST incidents/{id}/replan` | `{}` | `201 { "proposal": Proposal, "auto_approved": Proposal \| null }` or `200 { "proposal": null, "auto_approved": null, "detail": "no_changes" }` |
| `POST proposals/{id}/approve` | `{ "note"?: "", "zone_ids"?: ["bg:..."] }` | `200 { "proposal": Proposal, "guidance": [ZoneGuidance], "tasks": [CheckTask] }`: publishes each change as a new guidance version (`approved_by: "controller"`) and creates the tasks; `409` unless pending. With `zone_ids`, see [Partial approval](#partial-approval) |
| `POST proposals/{id}/reject` | `{ "note"?: "" }` | `200 { "proposal": Proposal }`; `409` unless pending |
| `POST incidents/{id}/drill` | see [Drill clock](#drill-clock) | `200 { "drill": DrillState }` |

### Partial approval

`zone_ids` approves only those changes. It must be a non-empty subset of the
pending proposal's change zone ids (`400 invalid_request` otherwise, also for a zone
already approved). The server moves those changes atomically (guarded by `status:
"pending"`) into a new proposal with `status: "approved"`, `parent_id` = the
original and `tasks: []`, publishes it and returns it as `proposal`. The original
stays `pending` with the remaining changes and keeps its `created_at`. When no
change remains (or `zone_ids` covers all of them) the original becomes `approved`
and its tasks are created then. A later replan may supersede the remainder as
usual. Reject is always whole.

A manual `replan` returns the auto-approved part too only when there is one (manual
causes never auto-approve, so it is normally `null`). Errors use the v1 shape;
`409 { "error": "conflict", "detail": "..." }` is new.

## Impact analysis

`POST incidents/{id}/impact` (controller) answers "what does this road being blocked cost?"
for one segment, at the current drill time. Nothing is stored or published.

```jsonc
{ "segment_id": "osm-way:10288574:0" }      // or { "report_id": "rpt_..." }: the report's road
{ "report_id": "rpt_...", "horizon_min": 60 } // horizon_min: twin what-if minutes, (0, 120], default 60
```

`400 invalid_impact` when neither is given, the segment or report is unknown, the report
is not on a road, or both are given and disagree. Two parts, computed separately:

- **Planner (computed, free-flow):** `livecore.planner.plan` runs twice with the blocks
  guidance already avoids (`Snapshot.blocked`), once with the segment added and once with
  it removed. The side that holds now is the route people follow: for an open segment the
  published route is the `unblocked` side; for a closed one it is the `blocked` side, unless
  it still crosses the segment (a reroute waiting for approval), when it is what reopening
  restores and so the `unblocked` side. The other side is the planner's route for that
  state. A zone is affected when its level is not `none` and its `unblocked` route uses the
  segment (planner routes by segment id; published routes when two of the segment's
  quarter points lie within 30 m of the route line), or the two sides differ.
  `eta_delta_min` = blocked minus unblocked route ETA (free-flow minutes), `null` when
  either side has no route. It can be negative: a published route chosen by the twin
  controller for traffic is not always the free-flow fastest, so the planner's detour can be
  quicker on paper. `change` is `slower` only when the ETA rises on the same destination
  and via; another path is `rerouted`.
- **Twin (simulated):** one what-if on the synced traffic twin (`fire_ahead: "frozen"`,
  seed 7). The twin closes the same blocks guidance avoids, so an open segment gets a
  `close_road` (`mode: hard`) and a closed one a `reopen_road`; the other side is the
  no-new-actions baseline. `vehicles_remaining` per zone is the twin's not-yet-arrived
  vehicles at the fork.

`200`:

```jsonc
{ "incident_id": "camp-2018-drill", "generated_at": "...Z", "replay_at": "2018-11-08T16:34:00Z",
  "target": { "segment_id": "osm-way:10288574:0", "name": "Doe Mill Road",
              "line": [[-121.59, 39.86], ...], "coord": [-121.59, 39.86],
              "state": "blocked",            // closed now (in guidance and the twin) | "open"
              "report_ids": ["rpt_..."] },    // the request's report, else open reports on the segment
  "planner_version": "planner-v2",
  "summary": { "affected_zones": 23, "eta_delta_min": 2,   // max over affected zones; null if none
               "zones_losing_route": 0, "zones_exposed": 0,
               "vehicles_at_risk": 17202,
               "vehicles_at_risk_source": "twin" },        // twin: sum of vehicles_remaining (simulated);
                                                           // bundle: sum of zone vehicles (no twin)
  "zones": [ { "zone_id": "bg:060070019002", "name": "Block Group 2, Census Tract 19",
               "level": "evacuate_now", "households": 410, "vehicles": 702,
               "vehicles_remaining": 687,                  // null without the twin
               "change": "rerouted",                       // slower | rerouted | route_lost | exposed | unchanged
               "eta_delta_min": 2,
               "unblocked": { "destination": GuidanceDestination, "route": GuidanceRoute, "exposed": false } | null,
               "blocked":   { ... } | null } ],            // null: no route on that side
  "twin": { "evidence_class": "simulated", "from": "...Z", "until": "...Z", "horizon_min": 60,
            "fire_ahead": "frozen", "seed": 7,
            "blocked": Metrics, "unblocked": Metrics, "delta": Metrics,   // delta = blocked - unblocked
            "limitations": ["Single seed; small differences are not significant.", "..."] } | null,
  "twin_fallback": null,   // when twin is null: twin_warming | twin_busy | twin_finished | twin_no_edges | twin_failed | twin_error:<code>
  "runtime_ms": 3100 }
```

`Metrics` is the [Controllers](#controllers) summary. Zones are ordered: lost routes first,
then by ETA delta and vehicles. The /live workspace runs it from a selected road item and
draws the current routes solid, the other state's routes dashed, and the affected zones.

## Controller auth (v2)

Dev and drill only: a controller sends `Authorization: Bearer <LIVE_CONTROLLER_TOKEN>`;
the server compares it in constant time with the env value and never stores it.
Unset -> controller endpoints return `403`. Responders join with
`POST incidents/{id}/join { "invite_code": ... }` checked against `LIVE_INVITE_CODE`
(unset -> join returns `403`). Both are placeholders in `app/.env.example`; real
values stay in the shell or an ignored `.env`. A real deployment needs per-person
controller accounts (not in scope).

## Endpoint summary (v2 additions)

| Method and path | Role |
| --- | --- |
| `GET incidents/{id}/situation[?zones=0]` | any |
| `POST incidents/{id}/checkins` | any |
| `POST me/location`, `DELETE me/location` | responder |
| `POST me/destination` | civilian, responder |
| `POST tasks/{id}` with `accepted` | responder |
| `POST tasks/{id}` with `done` (assist tasks) | responder, controller |
| `POST checkins/{id}/help` | controller |
| `GET incidents/{id}/command` | controller |
| `POST incidents/{id}/replan` | controller |
| `POST proposals/{id}/approve`, `POST proposals/{id}/reject` | controller |
| `POST incidents/{id}/drill` | controller |
| `GET incidents/{id}/twin` | controller ([twin-api.md](twin-api.md#http-adapter-live-drill-appbackendapilivetwin_servicepy)) |
| `POST incidents/{id}/twin/whatif` | controller |
| `POST incidents/{id}/impact` | controller ([Impact analysis](#impact-analysis)) |

## Location (v2)

Unchanged for civilians: the zone is found on the device; position leaves the
phone only inside a report, a prompts query, a route request, or a `need_help`
check-in. Responders who turn on sharing send their latest position while the app
is in the foreground; the server keeps only that one position, for 15 minutes.

## MongoDB plan

All live data goes through `api/mongodb.py` `get_database()` (ADR 0008). Documents
store times as BSON dates (UTC) and coordinates as `[lon, lat]`; the API renders
ISO 8601 `Z`. Ids are prefixed strings (`rpt_`, `tsk_`, `prp_`, `chk_`, `dev_`,
`rsp_`) generated by the server; `_id` is never exposed.

| Collection | One document per | Key fields | Indexes |
| --- | --- | --- | --- |
| `live_devices` | issued token (civilian or responder) | `token_hash` (SHA-256), `role`, `party_key`, `incident_id`, `created_at`, `last_seen_at`, `expires_at` | `token_hash` unique; `party_key`; TTL on `expires_at` (`expireAfterSeconds: 0`; civilian 30 days after last seen, responder 24 h) |
| `live_reports` | report | v1 document + `replay_at`, server-maintained `updated_at` (cursor) | `{incident_id, client_id}` unique (client_id stored lowercased); `{incident_id, received_at}`; `{incident_id, updated_at}` (the `since` cursor); `{reporter.party_key, received_at}`; `id` unique; 2dsphere on `location.coord` (optional; P0 filters in Python) |
| `live_tasks` | task | v1 + `assignee`, `accepted_at` | `id` unique; `{incident_id, status}`; `{assignee, status}` |
| `live_decisions` | audit entry (append only) | `incident_id`, `at`, `actor`, `action`, `report_ids`, `proposal_id`, `note` | `{incident_id, at}` |
| `live_drills` | incident | see [Drill clock](#drill-clock) | `incident_id` unique |
| `live_guidance` | zone guidance version (append only; only the derived `route.safety`, `caveat`, `alternatives` of the current version are rewritten by a replan) | `ZoneGuidance` + `incident_id` | `{incident_id, zone_id, version}` unique; `{incident_id, published_at}` |
| `live_proposals` | proposal | `Proposal` | `id` unique; `{incident_id, status, created_at}` |
| `live_checkins` | party per incident (latest only) | `CheckIn` + `incident_id`, `party_key` | `{incident_id, party_key}` unique; `{incident_id, zone_id, status}` |
| `live_destination_choices` | device per incident and zone (latest only) | `incident_id`, `party_key`, `zone_id`, `destination_id`, `guidance_version`, `at`, `expires_at`; no location | `{incident_id, party_key, zone_id}` unique; `{incident_id, zone_id, destination_id}`; TTL on `expires_at` (`at + 2 h`) |
| `live_responder_locations` | responder (latest only) | `incident_id`, `party_key`, `coord`, `accuracy_m`, `at`, `expires_at` | `{incident_id, party_key}` unique; TTL on `expires_at` (`at + 900 s`) |

Current guidance per zone is the max `version` for `{incident_id, zone_id}` (an
aggregation with `$sort` + `$group`, or a cached `current: true` flag flipped in
the same write if reads get slow). Publishing writes the next version with an
insert that fails on the unique index if another writer won, then retries once.

**Validators.** Each collection gets a `$jsonSchema` validator with
`validationAction: "error"` covering required fields, enums (`kind`, `status`,
`level`, `role`, `method`), `coord` as an array of two doubles, and numeric
ranges (`speed` 0..60, `accuracy_m >= 0`, `version >= 1`, counts >= 0). The
validators mirror the shapes above; the API still validates input first and
returns `400`, so a validator failure is a server bug (`500`, logged).

**Retention and privacy.** Civilian location is stored only inside reports and
`need_help` check-ins; never in devices, guidance, proposals or logs. Responder
location is latest-only and expires in 15 minutes (TTL), and is deleted at once on
`DELETE me/location`. Destination choices hold no location and expire in 2 hours (TTL).
Tokens are stored as hashes only. Drill data (`reset`)
removes guidance, proposals, check-ins and destination choices; reports and decisions are kept until
the drill database is dropped. No real resident data is collected in the drill.

**Index and validator creation.** A management command
`python manage.py live_init_db [--drop-drill-data]` creates or updates the indexes
and validators idempotently (`create_index`, `collMod` / `create_collection`
with `validator`). Run it once per database before first use and after any schema
change; the API never creates indexes on request paths.

**Local dev to Atlas.**

1. Local: Docker MongoDB at `mongodb://127.0.0.1:27017`, database
   `crisistwin_live_dev` (`MONGODB_URI`, `MONGODB_DATABASE`), then `live_init_db`.
2. Team Atlas: use a dedicated database `crisistwin_live` on the existing cluster
   (preferred: easy to drop after a drill, no collision with incident artifacts in
   `crisistwin`). If a separate database is not allowed, the `live_` prefix already
   keeps the collections apart inside `crisistwin`.
3. Switch by environment only: `MONGODB_URI` to the Atlas SRV string and
   `MONGODB_DATABASE=crisistwin_live`, set `LIVE_CONTROLLER_TOKEN` and
   `LIVE_INVITE_CODE`, run `live_init_db` once. No code change.
4. No data migration: drill data is disposable; start a fresh drill on Atlas.
   Moving real (non-drill) data later would need its own plan.
5. Atlas user: read/write on that one database only; network access as the team
   already configured.
