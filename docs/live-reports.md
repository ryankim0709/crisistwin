# Live reports API (v2, draft; not implemented)

Field reports, road status and check tasks for live use (see
[ADR 0011](adr/0011-live-field-reports.md)), and, since v2, the drill clock, the
current fire estimate, per-zone controller guidance, check-ins and responder
location (see [ADR 0012](adr/0012-controller-guidance.md)). v2 only adds fields,
values and endpoints; every v1 request and response stays valid. Base path `/api/live/`. Times are
UTC ISO 8601 with `Z`. Coordinates are WGS84 `[lon, lat]` in decimal degrees,
matching the sim and replay bundle. Distances are meters.

## Auth

Every endpoint needs `Authorization: Bearer <token>`, except that a request with no token is the
controller while `LIVE_CONTROLLER_TOKEN` is unset (see [Controller auth](#controller-auth-v2)).
Tokens are stored hashed.

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
  "status": "unverified",                // unverified|corroborated|responder_confirmed|confirmed|dismissed|resolved|withdrawn
  "evidence_class": "field_report",       // field_report | simulated (generated, ADR 0042) | historical_record | drill_fixture
  "replay_at": "2018-11-08T16:12:00Z",  // v2, server-filled: drill time at received_at; null when no drill runs
  "edited_at": null,                     // set when the reporter edits; null if never edited
  "withdrawn_at": null,                  // set when the reporter withdraws; null otherwise
  "revisions": []                        // prior values after each edit, newest last, at most 10 (below)
}
```

`withdrawn` is set only by the reporter (see [Edit or withdraw your own report](#edit-or-withdraw-your-own-report)).
Every consumer treats it like `dismissed`: closed, and out of
corroboration, the public map, road state, prompts, the planner, shelter-full signals and the open queues.
`edited_at`, `withdrawn_at` and `revisions` are always present in every report the API returns.

`live_tasks`: `{ id, incident_id, assignee, kind: "verify", target: { segment_id | coord }, report_ids, created_at, status: open|accepted|done|cancelled, answer }`.
`assignee` is a responder `party_key`, or `null` for any responder (v2: the first to
accept becomes the assignee). `accepted` is new in v2.

`live_tasks.note` is optional free text from the controller. Answering a task is
submitting a report with its `task_id`; `POST tasks/{id}` with
`{ "status": "cancelled", "note": "Could not reach it" }` closes it unanswered.

`live_injects`: drill injects, see [Injects](#injects).

`live_decisions`: an append-only audit log of triage, task, approval, drill and help actions: `{ at, actor, action, report_ids, proposal_id, checkin_id, note }` `actor` is `controller`, `auto_policy`, a responder `party_key`, or `agent:<name>` (see [Actor attribution](#actor-attribution)).

Road status and public items are computed when read from current reports in P0;
store them in their own collection only if reads get slow.

## Endpoints

| Method and path | Role | Purpose |
| --- | --- | --- |
| `POST devices` | none | Issue a civilian token |
| `POST incidents/{id}/join` | none | Exchange an invite code for a responder token |
| `POST incidents/{id}/reports` | any | Submit a report; same `client_id` returns the existing report |
| `GET incidents/{id}/reports?since=<cursor>` | responder, controller | New and changed reports (withdrawn ones included), plus `next_cursor` |
| `GET me/reports` | any | Own reports with status; withdrawn reports are left out |
| `PATCH me/reports/{id}` | any (owner) | Edit your own report while it is `unverified` or `corroborated` ([below](#edit-or-withdraw-your-own-report)) |
| `DELETE me/reports/{id}` | any (owner) | Withdraw your own report (soft delete) while it is `unverified` or `corroborated` |
| `POST reports/{id}/triage` | controller | `{ "action": "confirm|dismiss|merge|resolve", "into": "rpt_..."?, "note": "" }`; `409 report_withdrawn` if the reporter withdrew it |
| `GET incidents/{id}/road-state` | responder, controller | Per-segment status (below) |
| `GET incidents/{id}/public-map` | any | Public items only (rules below) |
| `GET incidents/{id}/prompts?near=lon,lat` | any | Nearby items to answer "still there?" with `road_blocked` / `road_passable` |
| `POST incidents/{id}/tasks`, `GET me/tasks`, `POST tasks/{id}` | controller; responder | Create, list and answer check tasks |
| `POST incidents/{id}/impact` | controller | Impact of one road segment, blocked vs unblocked: affected zones, ETA delta, vehicles at risk (v2, [Impact analysis](#impact-analysis)) |
| `POST incidents/{id}/route` | any | `{ origin, destination }` -> a route avoiding publicly confirmed blocks; not stored (P1) |

`POST devices` and `POST incidents/{id}/join` (body `{ "invite_code": "..." }`) return
`{ "token": "...", "role": "civilian|responder", "party_key": "dev_9f2...", "incident_id": "..."|null }`.
`join` also takes an optional `"simulated": true` (a boolean, else `400`) for simulated responders
([ADR 0038](adr/0038-simulated-responders.md)): the device stores it, the join response echoes
`"simulated": true`, and each `command.responders[]` item carries `simulated` (`false` for real
phones). The console tags those units "sim".

The driver, `manage.py live_sim_responders --units N` (`livecore.responders_sim`), starts its
units at the real CAL FIRE-layer stations nearest the fire estimate at the drill's current time
that sit within `INBOUND_SNAP_MAX_M` of the drill roads (`tools/ca_fire_bases.json`, local-only,
read by `api.suppression_bases.load_bases`). Each unit is an engine: a CAL FIRE Type 3 at a
state-owned station (the data's default state engine), 1.6 engines per CAL FIRE-owned station
on average (`deployment.engines_per_station_estimate`, ASSUMPTION; the k-th such station holds
floor(1.6k) - floor(1.6(k-1))), and one Type 1 structure engine at any other station
(ASSUMPTION: no apparatus data for local stations). Turnout is 80 s at paid stations
(`response_times.turnout_s`, NFPA 1710, unverified) and 120 s otherwise
(`wildland_turnout_s`, ASSUMPTION), waited when a unit leaves its station. Units route with
`inbound_route(access=...)` for their class (see [Responder route to a task](#responder-route-to-a-task))
and drive at the class's speed. A task only the class rules keep a unit from is cancelled at
once with the rule in the note (`Simulated responder sim-2 (Type 1 structure engine, Concow
Vol.): no road open to a Type 1/2 structure engine: R05 ...`); a task cut off by fire or
closures waits `UNREACHABLE_GIVEUP_S` (600 s) as before. The command prints the stations,
types, turnout and their basis. Without the bases file (or with `--no-bases`) units fall back to
the assumed Chico points with the engine/patrol/ambulance table, labelled `FALLBACK` in its
output.

A submitted report needs every field of the stored document except `id`,
`reporter`, `road_ref`, `received_at`, `status` and `evidence_class`, which the server fills. ADR 0041 adds optional `method` (`explicit` default |
`passive`) and, for passive reports only, `segment_id` and `speed_class`; see
[Passive observations](#passive-observations-method-passive). Stored reports carry `method` and
`speed_class` (null for explicit).

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

### Edit or withdraw your own report

A reporter can correct or retract a report they sent, with any token (civilian, responder). The
owner is the caller whose `party_key` equals `reporter.party_key`, the key `GET me/reports` uses.
A report that is someone else's, an unknown id, and any id sent by the controller all answer
`404 { "error": "not_found" }`, so ids cannot be probed. Both calls are allowed only while `status`
is `unverified` or `corroborated`. Once a responder or controller has acted, or after a withdrawal
(`PATCH` only; `DELETE` of a withdrawn report is idempotent, below), the answer is:

```json
409 { "error": "report_locked", "detail": "A responder or controller has already acted on this report." }
```

Both calls share one rate limit of 20 edits plus withdrawals per minute per party
(`rpt-edit:{party_key}`), answered `429 { "error": "rate_limited" }`. They are not refused with
`503 no_signal` during a `comms_outage` inject (that applies to submitting only; see
[Injects](#injects)).

`PATCH me/reports/{id}` takes any non-empty subset of `kind`, `severity`, `location`, `note` and
`destination_id`. `note: null` or `""` clears the note. Any other key (`client_id`, `observed_at`,
`task_id`, `incident_id`, `heading_deg`, `status`, ...) or an empty body is
`400 { "error": "invalid_report", "detail": "..." }`.

```jsonc
// PATCH me/reports/rpt_01J...
{ "kind": "hazard_down", "severity": null, "note": "Power line across the road" }
```

The server merges the patch onto the stored values and runs the same validation as submit, so every
submit rule still holds (for example, a `shelter_full` report needs a shelter or temporary refuge).
One rule is edit-only: when a patch touches `kind` or `severity` and the resulting kind is not
`road_blocked` or `heavy_traffic`, severity is stored as `null` (dropped, not rejected).
It then re-snaps `road_ref` if the kind or location changed (road kinds only, else `null`),
appends the previous values to `revisions`, sets `edited_at` and `updated_at`, and recomputes
corroboration, so `status` can move between `corroborated` and `unverified`. A patch equal to the
stored values returns the report unchanged and adds no revision. Returns `200 { "report": FieldReport }`:

```jsonc
{ "report": { "id": "rpt_01J...", "kind": "hazard_down", "severity": null, "note": "Power line across the road",
              "status": "unverified", "edited_at": "2026-10-24T18:09:02Z", "withdrawn_at": null,
              "revisions": [ { "at": "2026-10-24T18:09:02Z", "kind": "road_blocked", "severity": "full",
                               "location": { "coord": [-121.6012, 39.7593], "accuracy_m": 12 },
                               "note": "Tree across both lanes", "destination_id": null } ],
              /* ...the other FieldReport fields */ } }
```

Each revision holds the values the edit replaced, with `at` the time of that edit. `revisions` is
newest last and keeps the 10 most recent. The web console shows it to controllers; the phone ignores it.

A passive report (`method: "passive"`) has no location or note to change: `PATCH` answers
`400 invalid_report`, and it can still be withdrawn.

`DELETE me/reports/{id}` takes no body. It withdraws the report: `status` becomes `withdrawn`,
`withdrawn_at` and `updated_at` are set, and corroboration is recomputed (skipped for
`help_needed`, as on submit). The document is kept, not deleted, so triage, corroboration counts,
the events feed and the after-action report still have it. Withdrawing a withdrawn report is
idempotent and returns the stored report. Returns `200 { "report": FieldReport }` with
`"status": "withdrawn"`.

Listing. `GET me/reports` leaves withdrawn reports out. `GET incidents/{id}/reports` and
`GET incidents/{id}/command` (`reports`) include them, so polling clients see the status change
and close the item; edits and withdrawals move `updated_at`, so the `since` cursor and the
[event stream](#event-stream) (`change: updated`) report them. Controllers cannot set
`withdrawn`: `POST reports/{id}/triage` on a withdrawn report is
`409 { "error": "report_withdrawn" }`.

## Rules (deterministic; constants named in code)

- **Same party:** same `party_key`, the same household group (later), or
  submitted within `SAME_PARTY_WINDOW_S` = 120 and `SAME_PARTY_RADIUS_M` = 100 of each other.
  Optional source-diversity check (`LIVE_SOURCE_DIVERSITY=true`, default false; ADR 0042): parties
  whose first reports in a group arrive within `SOURCE_BURST_WINDOW_S` = 600 and
  `SOURCE_BURST_RADIUS_M` = 1000 of a counted party also count as that one party. It folds true
  crowds as well as rumours; see the ADR before turning it on.
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

The default incident is `camp-2018-drill`. Its drill data (roads, zones, destinations,
fire perimeters, fitted model fronts, fire observations) is the Camp replay bundle
(`app/public/replays/camp-2018.json`, format in [replay-bundle.md](replay-bundle.md)),
read once per process from the path in `LIVE_DRILL_BUNDLE`.

## Active incident (ADR 0047)

The hosted instance runs **one active wildfire** at a time
([0047-active-incident](adr/0047-active-incident.md)). Every endpoint below is keyed by
the `incident_id` in its path; routes without one (`me/...`) use the active incident. The
API serves `camp-2018-drill` (always) and the active incident; any other id is
`404 not_found`, so a phone that gets 404 re-reads the active incident.

`GET /api/live/active` (no auth, `Cache-Control: no-store`):

```jsonc
{ "incident_id": "studio-1a2b3c4d5e6f",       // or "camp-2018-drill" (the default)
  "name": "Ridge fire (Studio scenario)",
  "mode": "drill",
  "label": "Drill: simulated Studio fire, Ridge fire. Not a real incident.",
  "source": "package",                        // "bundle" (Camp) | "package" (Studio drill package)
  "package_id": "pkg_1a2b3c4d5e6f",           // null for Camp
  "activated_at": "2026-10-24T20:01:00Z",     // null until a controller switches
  "region_id": "berkeley-hills-tilden@10km",   // Studio board of the package (summary.region_id): region id, plus "@<N>km" for a chosen half-width; null for Camp
  "join": { "invite_required": true } }
```

`POST /api/live/active` (controller) with `{"package_id": "pkg_..."}` or
`{"incident_id": "camp-2018-drill"}` loads the drill (it must load first: `503
drill_unavailable` otherwise), stores the switch in `live_active` (one document:
`incident_id, source, package_id, bundle, name, label, activated_at, actor`), logs
`incident_activated` in `live_decisions`, starts warming its twin and returns
`200 {"active": <as GET>, "changed": bool}`. Errors: `400 invalid_request` (neither or
both keys), `401`/`403` (not the controller), `404 not_found` (unknown package or
incident). Data of the previous incident stays in MongoDB under its id; switching back
resumes it. Other processes see a switch within 2 s (`ACTIVE_CACHE_S`).

A Studio package incident differs from Camp: the drill clock starts at the package's
T+0 (`clock.start`) instead of 15:00Z, there is no 2018 response or ground record, and
its traffic twin is built from the package (`sim.twin.package_inputs`): OSM roads,
synthetic zones (homes per km of residential street times vehicles per home, all of
which evacuate once ordered), exits and the simulated fronts. It has no historical orders,
so zones depart only when guidance orders them. Those assumptions are listed in the
twin's `limitations`.

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

### Guidance from the Live board's orders

Resident guidance now comes from the evacuation orders on the /live simulated command board: what
the AI agent (or the controller) orders there is what the phones are told. Each run-state PUT
([Run state](#run-state)) that holds the single-writer lease publishes it
(`api/live/board_guidance.py`), so one console publishes and a refused (`409 run_state_owned`)
console publishes nothing. Per zone, from the PUT's `order` block:

| `order.status` | Published guidance |
|---|---|
| `leaving`, `done` | `evacuate_now` to `destination_id` on `order.route` (the board's route option); `reason` "Evacuation ordered by the AI agent on the simulated board", `reason_code: "board_order"`. `done` keeps the order in force (no new version) |
| `scheduled` | `be_ready` on the same route; `reason` "Leave at T+01:30 on the simulated board clock (scheduled by ...)" (board minutes, not wall or drill time), `reason_code: "board_scheduled"`, `board_start_minute` |
| `warning` | an evacuation warning (`warn_evacuation`, `app/src/demo/evacWarning.ts`): `be_ready` on the route to be ready for (`order.route`), no start (`board_start_minute` null), `reason` "Evacuation warning from the AI agent on the simulated board: be ready to leave; no evacuation order yet", `reason_code: "board_warning"`; feed line "Residents of Z09 told: Be ready to leave (evacuation warning, no order yet) via ... to ..."; `start_minute` is the board minute it was issued. Nobody leaves on the board |
| `none` | withdraws what the zone was last told (`level: "none"`, `reason_code: "board_no_order"`): a cancelled schedule, a withdrawn warning ("Evacuation warning withdrawn by ..."), a new board run, or guidance left from the former proposal flow. Nothing is written for a zone never told anything |
| `lifted` | the order was lifted (fire contained): `level: "none"`, `reason_code: "board_all_clear"`, `reason` "All clear: the evacuation order for your zone has been lifted by the AI agent on the simulated board. You may return home; drive carefully." The phone view shows screen `no_order` with headline "All clear for <zone>" and the reason as a line; the feed line is "Residents of Z23 told: All clear, you may return". Only for a zone that had an order or guidance; `start_minute` is the board minute it was lifted |
| `overrun` | `evacuate_now` with `no_route: true` ("Fire reached this zone on the simulated board"; the phone shows "No open route. Shelter in place and tap Need help."), `reason_code: "board_overrun"`; only for a zone that had an order or guidance |

- **Versions.** A new version only when the level, destination, the road to leave by (`via[0]`),
  the scheduled start or the source changes. A refreshed route line, ETA, safety or wording for
  the same destination and road updates the current version in place. A PUT whose orders did not
  change writes nothing.
- **Labels.** Board documents add `source: "board"`, `issued_by` (`ai_agent` or `controller`: the
  actor of the zone's latest board order; null when unknown), `board_run_id`, `board_minute` and
  `evidence_class: "simulated"`. `approved_by` stays `"controller"` and `proposal_id` is
  `"board:<run_id>"` (the collection validator and the iOS decoder accept only those shapes, so
  the iOS app still words the source "Approved by incident command"). `replay_at` is the drill
  time when a drill is running, else absent. `alternatives` is `[]`; `caveat` follows
  `route.safety` as above.
- **Activity feed.** Each published change logs one `live_decisions` entry,
  `{action: "board_guidance", actor: "ai_agent"|"controller"|"board", note}`, whose note is the
  feed line, e.g. "Residents of Z35 told: Leave now via Sports Lane to CA 13 (south)". Three or more
  withdrawals of non-board guidance in one PUT share one line.
- No route or level is computed here: destination, road, ETA and line are the board's route option
  (`POST /api/demo/routes`). A moving order whose PUT has no `order.route`, or whose destination
  the drill does not know, changes nothing.

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
  (`length_m / speed_kph`), times the simulated congestion factor of each directed
  edge when the twin is ready (see "Congestion-aware planning" below). Never uses an
  edge whose `segment_id` is blocked or whose midpoint lies inside the fire estimate.
  Unreachable -> `no_route: true`. `eta_min` stays free-flow.
- Blocked segments for guidance are road-state items with `status: "blocked"` and
  `public: true` (this includes controller confirmations). The impact analysis
  (`POST incidents/{id}/impact`) starts from the same blocks and toggles one segment.

## Proposals and the approval policy

**Off by default (`LIVE_PROPOSALS=false`).** `/live` follows the AI agent on the simulated
board (Claude orders evacuations and dispatch there), so the twin-controller proposal flow
below does not run: no automatic replan on `situation`/`command` reads, no replan after a
`confirm`, `command.proposals` is `[]`, and `POST incidents/{id}/replan` and
`POST proposals/{id}/approve` answer `410 { "error": "proposals_off" }`. Reject still works.
The planner modules stay; `LIVE_PROPOSALS=true` turns the flow back on (`live_smoke` and
`live_loadtest` need it). Earlier planner decisions stay in `live_decisions` and show in the
full audit log as "(old planner)"; the activity feed leaves them out.

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
              "planner_version": "planner-v4", "controller": "twin",
              "congestion": "twin@2018-11-08T16:10:00Z",   // or "unavailable" (free-flow); simulated input
              "congestion_evidence_class": "simulated",     // null when unavailable
              "congested_edges": 214,                       // edges with a factor > 1 in that twin read
              "incumbents": 31, "incumbents_with_edges": 31, // published routes held by hysteresis
              "hysteresis": { "min_gain_s": 120.0, "min_gain_fraction": 0.15, "min_dwell_s": 900.0 } },
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

### Congestion-aware planning (planner-v4, ADR 0031-congestion-aware-planner)

Every replan reads the traffic twin's current per-edge state once (simulated; `inputs.congestion
= "twin@<twin clock>"`) and multiplies each directed edge's search cost by the same factor as
responder routes: `factor = clamp(free_flow_kph / speed_kph, 1, 10)` on edges with at least
`CONGESTION_MIN_VEH` (3) simulated vehicles (speed 0 gives 10), 1 elsewhere. So the edge cost is

    cost_s = length_m / (speed_kph / 3.6) x fire_weight x factor

with `fire_weight` 1, `EXPOSED_COST_BUFFER` (5) or `EXPOSED_COST_INSIDE` (20) by pass, as before.
Route selection, destination choice and alternatives use it; `eta_min` and `distance_m` do not
(they stay free-flow). While the twin is warming, busy or failed, or with `LIVE_CONTROLLER=rule`
before the twin was built, the plan is free-flow and `inputs.congestion` is `"unavailable"`.
Congestion is read only when a replan happens for another reason (fire, block, shelter, manual);
it never triggers a replan by itself. The impact analysis stays free-flow.

Hysteresis, so zones do not swap exits as queues move. Each zone's published route is its
incumbent: its edges come from `live_plan_routes` (the edges of every proposed route, keyed by
zone, destination and `via`; never served), or, when unknown, the cheapest route to the same
destination now. Within each routing pass, the zone keeps the incumbent unless

    new_cost_s <= incumbent_cost_s - max(SWITCH_MIN_GAIN_S, SWITCH_MIN_GAIN_FRACTION x incumbent_cost_s)

(120 s, 0.15), both costs measured now with the same edge costs, and in any case keeps it for
`SWITCH_MIN_DWELL_S` (900 drill seconds) after the zone's guidance was published. Safety rules
come first: an incumbent over a blocked segment, into a fire class the pass does not allow, or to
a destination that is no longer usable (full, inside the fire, a refuge near it) is never kept.
`crowd_influence` plans with and without crowd-only blocks under the same congestion and
incumbents, so only the blocks differ. The planner is deterministic for given inputs.

### Record comparison harness (`live_compare_record`)

A headless, simulated planning experiment (not a claim about 2018):

    python manage.py live_compare_record --confirm-delay-min 5 --out /tmp/record-compare

runs the live twin inputs (seed `--seed`, default 7) and the planner on one simulation clock over
a drill window (default 14:30Z-18:00Z = 06:30-10:00 PST, 2018-11-08), three ways, each a fresh twin:
`A` the bundle's historical actions only; `B` a controller who confirms each 2018 record entry
that enters the queue as `road_blocked` or `fire_seen` (`groundrecord.REPORT_KIND`, entries with
a point) at its time + N minutes (entries queued before the start are confirmed at the start),
approves every resulting change, and between confirms lets the auto policy publish pure
unexposed reroutes on a new fire estimate; `B_free` as B with the previous planner (free-flow,
no hysteresis). Guidance reaches the twin as `twin_service` syncs it (`close_road` hard,
`order_zone`, `reroute_zone`). It writes `<out>.json` (`kind: crisistwin_record_comparison`,
`evidence_class: simulated`) and `<out>.md`: per zone and in total, the twin order time and the
drill's first `evacuate_now`, arrivals by checkpoint (default 15:30, 16:30, 17:30, 18:00Z),
exposure (vehicles on fire-exposed edges or waiting at an origin in the fire area, sampled every
`--sample-s` 60 s, in veh-min), trapped-by-fire (twin total), destination and route changes, and
each zone's published history. No database writes; about 1-2 min.

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

## Phone location, name and kind (opt-in)

`POST me/location` (civilian or responder): `{ "coord": [-121.6, 39.76], "accuracy_m": 15, "at": "2026-10-24T18:06:00Z" }`
(`{ "lon", "lat" }` is accepted in place of `coord`) -> `204`. Stores the one latest position on the
device document (`location`, with `last_seen_at`); a responder's also upserts `live_responder_locations`
for task routing, expiring after `RESPONDER_LOCATION_TTL_S` (900) s. `DELETE me/location` -> `204`
removes both at once (the phone calls it when sharing is turned off). The phone shares only while its
"Share my location" setting is on (default) and location is allowed, foreground only: one post per 45 s,
sooner after moving 150 m (never under 10 s apart); offline posts are dropped, not queued.

`POST me/profile` (civilian or responder): `{ "name": "Ana", "kind": "resident" }` -> `204`. `name` is an
optional nickname of at most 24 characters (`""` or null clears it); `kind` is `resident`, `firefighter`
or `observer` (default resident, firefighter for a responder token). Both keys are optional.

`GET participants` (controller): `{ "participants": [{ party_key, role, kind, name, incident_id,
simulated, last_seen_at, location: { coord, accuracy_m, at, stale } | null }], "as_of" }` for every
device seen in the last hour; `location.stale` is true after 900 s. Civilian devices carry
`incident_id: null` (they follow the active incident).

## Tasks (v2 additions)

`POST tasks/{id}` also accepts `{ "status": "accepted" }` from a responder: allowed
when the task is `open` and unassigned or assigned to the caller; sets `assignee` to
the caller. Returns `200 { "task": CheckTask }`; `409` if already accepted by
someone else or closed, and `409 responder_busy` (`detail` names the current task id) if the
caller already holds another `accepted` task; done, cancelled or declined frees them. `GET me/tasks` returns tasks assigned to the caller plus
open unassigned ones. `CheckTask` gains `assignee` (`party_key` or `null`).
`POST incidents/{id}/tasks` (controller) takes
`{ "assignee": "rsp_..."|null, "target": { "segment_id"?: "...", "coord"?: [lon, lat] }, "report_ids": [], "note"?: "" }`
and returns `201 { "task": CheckTask }`.

`CheckTask.kind` is `verify` or `assist` (go to a resident who asked for help; it carries
`checkin_id`). An assist task has no report to answer it: the responder closes it with
`POST tasks/{id}` `{ "status": "done" }`, which resolves the help request.

### Responder route to a task

`GET tasks/{id}/route[?from=lon,lat][&class=engine_t3]` (responder: own or unassigned tasks, else `404`;
controller: any task). The task must be `open` or `accepted` (`409 task_closed`). The
origin is the caller's latest unexpired `me/location`; for a controller, `?from=lon,lat`
(WGS84 degrees) or else the assignee's. No origin returns `409` with
`reason: "no_origin"` and the same body shape. The phone refetches it with its poll,
at most every 15 s per task.

`class` is the apparatus road-access class of [suppression-data.md](suppression-data.md)
(`engine_t1_t2`, `engine_t3`, `engine_t4_t7`, `tender_support`, `tender_tactical`; default
`engine_t3`, a CAL FIRE Type 3 engine). Any other value is `400 invalid_request`.

```jsonc
{ "task_id": "tsk_01J...",
  "route": {                                  // null when reason is set
    "line": [[-121.7598, 39.73782], ...],     // [lon, lat], simplified (5 m, <= 300 points)
    "via": ["Deer Creek Highway", "CA 99", "Neal Road"],
    "distance_m": 27330,                      // rounded to 10 m
    "eta_min": 21,                            // drive time, minutes, rounded up (see below)
    "exposure": "clear",                      // clear | near_fire (never through_fire)
    "congestion": "twin",                     // twin | unavailable (free-flow)
    "congested_edges": 0 },                   // edges on the route slowed by the twin
  "reason": null,                             // null | "unreachable" | "no_access" | "no_origin"
  "detail": null,                             // why, for unreachable / no_access / no_origin
  "rule": null,                               // no_access only: blocking rule, "R01".."R10"
  "apparatus": {                              // the class the route was computed for
    "class": "engine_t3",
    "label": "Type 3 engine (CAL FIRE Model 14/24/34 class, 4x4)",   // null without the data
    "basis": "road access: highway class only (...), grade 0% assumed, dead-end rule R10 not applied" },
  "evidence_class": "simulated",
  "as_of": "2018-11-08T16:21:10Z" }           // drill time of the fire estimate and twin state
```

Computed by `livecore.inbound.inbound_route` (forward Dijkstra on the drill road network):

- Both ends snap to the nearest node of the main road component (origin: a node with an
  out-edge; target: one with an in-edge). More than `INBOUND_SNAP_MAX_M` (1000 m) away is
  `unreachable` (off the network).
- Never over a segment the twin closes: every public block guidance avoids plus every
  controller-confirmed block (`twin_service.twin_closed_segments`).
- Never over an edge inside or crossing the fire estimate. An edge within `FIRE_BUFFER_M`
  (300 m) of it costs `EXPOSED_COST_BUFFER` (5) times its travel time, as in the
  planner's near-fire pass. An origin or target whose edges are all inside the fire is
  `unreachable`.
- Congestion (simulated): when the traffic twin is ready, each directed edge with at
  least 3 simulated vehicles gets `factor = clamp(free_flow_kph / speed_kph, 1, 10)`
  (speed 0 gives 10), and its cost is multiplied by it. Direction matters: outbound
  evacuation traffic does not slow the inbound lane. Twin speeds are cached for 10 s.
  If the twin is warming, busy or failed, the route is free-flow and `congestion` is
  `unavailable`.
- Apparatus class (`livecore.apparatus`): only edges open to the class under rules
  R01-R12 (`tools/suppression_data.road_access`) are used, each at the class's speed
  (heavy-apparatus cap by highway class, capped by the edge's own speed as `maxspeed`).
  The drill bundle's edges carry only `highway`, `bridge` and speed, no surface, track
  grade, width, weight or height tags, so the rules see the highway class with the
  documented defaults (paved, default width by class); grade is 0% (ASSUMPTION: no
  elevation per edge) and R10 is not applied (no turning-circle data). In camp-2018 every
  public road is then open to every class (rule R11) and the class changes the speed, not
  the route's reach. A bundle whose edges carry `tags` gets the full rules. Without
  `tools/` (the backend image alone) every edge keeps its own speed and
  `apparatus.label` is null.
- `eta_min` = ceil(sum over edges of `length_m / (class speed_kph / 3.6)` x congestion
  factor / 60). The fire weighting changes the choice of route, not the ETA.
- No path gives `reason: "unreachable"` with a `detail`, never a route over a closed edge.
  When an unrestricted vehicle would get through and only the class rules stop this one,
  the reason is `no_access`, `rule` is the rule of the first closed edge on that vehicle's
  route and `detail` says why and on which road.

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

`GET incidents/{id}/command` (controller). Polled every 3 s. Every open /live tab polls it, so one
computation per incident serves all of them for `LIVE_POLL_CACHE_TTL_S` (default 1.5 s; 0 turns it
off), and requests that arrive while it runs wait for it (`api/live/pollcache.py`; `GET
incidents/{id}/twin` too). A write through the live API (any successful non-GET) drops the cached
body, so the poll after a console action shows it. `generated_at` is when the body was computed.

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
  "proposals": [ Proposal ],                // all pending, plus the latest 5 decided; newest first;
                                            // changes[].to omits route.line and alternatives
  "reports": [ FieldReport ],               // newest 500
  "road_state": [ RoadStateItem ],
  "public_items": [ PublicMapItem ],        // what civilians see
  "checkins": {
    "by_zone": [ { "zone_id": "bg:060070009011", "out": 12, "need_help": 1, "staying": 3 } ],
    "need_help": [ { "id": "chk_01J...", "zone_id": "bg:060070009011", "coord": [-121.6012, 39.7593], "at": "...Z",
                     "help": { "status": "open", "assignee": null, "task_id": null, "updated_at": "...Z" },
                     "simulated": false } ] },  // true: a simulated resident (live_run_scenario, virtual people)
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

`ground_record` is the 2018 911, radio and rescue record (`tools/camp_ground_record.json`, path override
`LIVE_GROUND_RECORD`), de-identified from NIST TN 2252: template summaries only, placed by zone; the API never
returns a point. Historical and `reported`/`reconstructed`, never drill reports.

**Into the review queue.** When the drill clock passes a record item whose category is `road_blocked`,
`heavy_traffic`, `fire_seen`, `trapped` or `help_needed` (the last two become `help_needed`), the server upserts it
once into `live_reports` (`client_id: "record:<id>"`, `evidence_class: "historical_record"`, `status: unverified`,
the ~100 m point as `location`, `note: "2018 record: <summary>"`, `record: {id, channel, source_locator}`). Until a
controller confirms it, it counts for nothing: no corroboration, public map, road state or fire input. Confirming
works like any report (a confirmed block triggers the replan). Only the controller sees these reports;
`GET incidents/{id}/reports` omits them for responders. A drill `reset` deletes them; they re-enter as the clock
passes them again. `POST incidents/{id}/tasks` takes `"kind": "assist"` to send a responder to a help report; the
responder's `done` resolves its `help_needed` reports.

```jsonc
"ground_record": {
  "available": true,                       // false (and empty) until the record file is built
  "label": "2018 record, de-identified from NIST TN 2252. Not drill reports.",
  "window_min": 30, "until": "2018-11-08T16:00:00Z",
  "totals": { "911": 12, "radio": 40, "rescue": 5, "notification": 3, "evacuation": 2 },  // up to `until`
  "window": { "911": 4, "radio": 9, "rescue": 1, "notification": 0, "evacuation": 0 },    // last window_min
  "zones": [ { "zone_id": "bg:060070018001", "items": 6, "help": 2, "fire": 1 } ],         // last window_min
  "items": [ { "id": "nist-a2-812", "at": "2018-11-08T15:58:00Z", "time_precision": "minute", "channel": "911",
               "category": "trapped", "road_name": "Pentz Road", "summary": "911 call: trapped by fire, Pentz Road",
               "evidence_class": "reported", "source_locator": "https://…/NIST.TN.2252sup.pdf#page=41; Table A-2; …",
               "zone_id": "bg:060070018001" } ] }   // newest first, at most 100
```

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

## Event stream

`GET incidents/{id}/events?since=<cursor>&limit=<n>` (controller; `api/live/events.py`) lists what
changed since a cursor, in time order, so an agent driving the controller API (ADR 0030 "Controller
surface for the orchestrator") need not diff `command` polls. Read only; no new collection.

- `since`: omitted = from the beginning of the incident's data; `now` = no events, just a cursor at
  the server clock (minus the settle window); otherwise a `next_cursor` from an earlier response
  (`<ms>:<type>:<id>`, opaque). Anything else is `400 invalid_request`.
- `limit`: 1..500, default 200. `more: true` means the page was full: call again at once.

```jsonc
{ "incident_id": "camp-2018-drill", "generated_at": "...Z",
  "events": [
    { "key": "1792860312307:report:rpt_01J...",   // stable: dedupe on it
      "at": "2026-10-24T16:45:12Z",               // wall UTC of this change (sort key)
      "replay_at": "2018-11-08T16:20:01Z",        // drill UTC (see below); null outside a drill
      "type": "report", "id": "rpt_01J...",
      /* summary fields by type, below */ } ],
  "next_cursor": "1792860312307:report:rpt_01J...", "more": false }
```

| `type` | `at` | `id` | Summary fields |
| --- | --- | --- | --- |
| `report` | `updated_at` | report id | `change` (`new` when `updated_at` = `received_at`, else `updated`), `kind`, `status`, `severity`, `evidence_class`, `reporter_role`, `segment_id`, `road_name`, `destination_id`, `coord`, `task_id`, `note` (first 160 chars) |
| `decision` | `at` | `dec_<object id>` | `actor`, `action`, `report_ids`, `proposal_id`, `checkin_id`, `note` |
| `proposal` | `created_at` (`change: created`) or `decided_at` (`change: decided`) | proposal id | `status`, `policy`, `parent_id`; created: `causes`, `controller`, `controller_fallback`, `n_changes`, `changes` (first 12: `zone_id`, `kind`, `from_level`, `to_level`, `to_destination_id`, `to_via`, `to_eta_min`, `no_route`), `n_tasks`; decided: `decided_by`, `note`. An auto-approved part is one `created` event |
| `guidance` | `published_at` | `<zone_id>@v<version>` | `zone_id`, `version`, `level`, `destination_id`, `via`, `eta_min`, `no_route`, `reason_code`, `approved_by`, `proposal_id` |
| `checkin` | `at` | check-in id | `status`, `zone_id`, `role`, `coord` (need_help only), `help_status` |
| `help` | `help.updated_at` (when it differs from the check-in's `at`) | check-in id | `status`, `assignee`, `task_id`, `zone_id` |
| `task` | `created_at`, `accepted_at`, `closed_at` (`change`: `created`, `accepted`, `closed`) | task id | `kind`, `status`, `assignee`, `segment_id`, `coord`, `report_ids`, `checkin_id`, `note` |

Rules:

- Reports, check-ins and tasks are updated in place, so an event carries the document's state
  **now** and the `change` that happened at `at`; two changes to one report between polls show as
  one event at the later time.
- `replay_at` is the document's stored drill time where it has one (reports, guidance, check-ins,
  proposal `replay_at` / `decided_replay_at`); for decisions, help changes and task transitions it is
  estimated from the current drill clock (wrong if the speed changed or the drill was reset since).
- Delivery is at least once. A write can carry a timestamp taken seconds before it lands (a
  twin-scored replan takes ~5-7 s), so `next_cursor` never moves past `now - EVENT_SETTLE_MS`
  (10 s) unless the page is full; events in that window come again on the next poll with the same
  `key`. Order is (`at`, `type:id`).
- A drill `reset` deletes guidance, proposals and check-ins, so their events disappear; reports,
  tasks and decisions stay.

## Actor attribution

A controller request may carry `X-CrisisTwin-Actor: agent:<name>` (`<name>` matches
`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`). The server then records `agent:<name>` instead of
`controller` as the `actor` of every `live_decisions` entry the request writes (triage, tasks,
help, replan, approve, reject, drill). The header is ignored on non-controller requests and when
malformed. Background work (automatic replans, `auto_policy`) is unaffected, and proposals keep
`decided_by: "controller"`. The controller MCP server (`orchestrator_mcp/`, ADR 0033) sends it on
every write.

## Controller auth (v2)

Dev and drill only. With `LIVE_CONTROLLER_TOKEN` unset (the default), a request without an
`Authorization` header is the controller, so the /live console needs no token. With it set, a
controller sends `Authorization: Bearer <LIVE_CONTROLLER_TOKEN>`; the server compares it in
constant time with the env value and never stores it, and an untokened request gets `401`. Set
it on anything reachable by others. Responders join with
`POST incidents/{id}/join { "invite_code": ... }` checked against `LIVE_INVITE_CODE`
(unset -> join returns `403`). Both are placeholders in `app/.env.example`; real
values stay in the shell or an ignored `.env`. A real deployment needs per-person
controller accounts (not in scope).

## After-action report

`GET incidents/{id}/aar` (controller; `api/live/aar.py`) reads the drill's audit data and the
twin and returns a report and a drill score. It never writes and uses no LLM. The web page is
`/live/report` (Export JSON saves this response). Evidence classes: `observed` = what drill
participants did, `simulated` = from the twin at its current clock, `historical` = the 2018
evacuation orders in the bundle (`command.response_record`, type `evacuation_order`; the
earliest order that lists the zone).

```jsonc
{
  "kind": "crisistwin_live_aar", "incident_id": "camp-2018-drill", "generated_at": "...Z",
  "drill": { "replay_start": "...Z", "replay_now": "...Z", "started_at": "...Z", "speed": 1, "running": true },
  "score": { "value": 61.2, "max": 100, "coverage": 1.0, "formula": "...", "evidence_class": "simulated",
    "components": [ { "id": "arrived_share", "label": "...", "evidence_class": "simulated",
      "raw": 0.75, "unit": "share of vehicles", "score": 0.75,   // component score in [0, 1], null = no data
      "weight": 0.35, "effective_weight": 0.35, "points": 26.3, "rule": "..." } ] },
  "twin": { "status": "ok",   // or warming | failed | finished | busy, then totals is null
    "evidence_class": "simulated", "clock": "...Z",
    "totals": { "total_veh": 0, "arrived_veh": 0, "exposed_veh": 0, "trapped_by_fire_veh": 0,
                "trapped_by_closure_veh": 0, "exposed_veh_min_so_far": 0.0 } },
  "zones": [ { "zone_id": "bg:...", "name": "...", "vehicles": 610,
    "first_leave_now_at": "...Z",          // drill time of the first evacuate_now guidance, null if none
    "historical_order_at": "...Z",         // 2018, null if the bundle has none for the zone
    "leave_now_vs_2018_min": -15.0,        // drill minus 2018; negative = earlier
    "leave_now_status": "earlier",         // none | earlier | later | same | missed
    "guidance_changes": 2,                 // published guidance versions
    "reports": 2, "triage_median_min": 3.0,          // received -> triage decision, wall minutes
    "help_requests": 1, "help_to_assign_median_min": 4.0,
    "arrived_veh": 120, "exposed_veh": 4 } ],         // simulated, per zone
  "triage": { "reports": 2, "triaged": 2, "median_min": 3.0 },
  "help": { "requests": 1, "to_assign_median_min": 4.0, "to_resolve_median_min": 20.0,
            "task_to_accept_median_min": 3.0, "task_accept_to_close_median_min": 12.0,
            "items": [ { "checkin_id": "chk_...", "to_assign_min": 4.0, "to_resolve_min": 20.0 } ] },
  "timeline": [ { "at": "...Z", "drill_at": "...Z", "actor": "controller", "action": "confirm",
                  "report_ids": [], "proposal_id": null, "checkin_id": null, "note": null } ],
  "limitations": [ "..." ]
}
```

Timeline `at` is wall time; `drill_at` is the proposal's decided drill time for approve and
reject, else estimated from the current drill clock (wrong if the speed changed since).
`historical_record` reports (the 2018 queue entries) are not field reports and are not counted in
triage times. Help minutes are wall minutes from the check-in time; a request the resident later
closed by checking in again has no start time and no minutes. The response carries
`time_basis: "wall"`. The same computation is `aar.compute_aar(context, data, time_basis)`, pure
over explicit documents; the headless batch runner calls it with `time_basis: "drill"` (minutes
between the documents' drill times, help unit `drill minutes`; [batch-runner.md](batch-runner.md)).

**Drill score** (0 to 100): `100 x sum(effective_weight x component score)`. Constants are at the
top of `aar.py`.

| Component | Evidence | Raw value | Component score (clamped to 0..1) | Weight |
| --- | --- | --- | --- | --- |
| Vehicles arrived | simulated | arrived / total vehicles | the share | 0.35 |
| Exposed or trapped vehicle-minutes | simulated | (`exposed_veh_min_so_far` + 60 x trapped-by-fire vehicles) / total vehicles | `1 - raw / 5` | 0.30 |
| Median help to responder assigned | observed | median wall minutes over assigned requests | `1 - minutes / 30`; 0 if requests exist and none was assigned | 0.15 |
| Leave-now vs 2018 | historical | median minutes vs 2018 over zones with both | mean over zones of `0.5 - minutes / 60` (30 min earlier = 1, on time = 0.5, 30 min later = 0); a zone whose 2018 order time has passed on the drill clock with no leave-now scores 0 | 0.20 |

A component with no data (no help requests, twin warming, no zone ordered yet) has
`score: null` and is left out; the remaining weights are renormalised (`effective_weight`) and
`coverage` is the weight share that counted. The score is a planning-experiment number from an
uncalibrated model, not an evaluation of the controllers.

### Triage quality against the truth log (post-drill, ADR 0042)

`GET incidents/{id}/aar?truth=1` adds `triage_quality`, scored by `sim/triage_quality.py`
against the hidden ground-truth log `sim_truth` of generated reports
([ADR 0042](adr/0042-adversarial-ground-data.md), `sim/gen_noise.py`). It is refused with `403
truth_scoring_disabled` unless the server sets `LIVE_TRUTH_SCORING=true` (default false), and with
`409 drill_running` while the drill clock runs; stop or pause the drill (speed 0) first. Without
`?truth=1` the section is absent. Headless runs call `aar.build_aar(snapshot, truth_scoring=True)`.
No other endpoint, console view, phone view or MCP tool reads `sim_truth`
(`api/live/tests/test_sim_truth.py`). Only reports with a truth entry (generated, `simulated`) are
scored; real participants' reports and the 2018 record are not.

```jsonc
"triage_quality": { "status": "ok",          // or no_truth | no_drill
  "evidence_class": "simulated", "basis": "drill minutes; ...", "horizon": "...Z",  // horizon = drill now
  "reports_scored": 7, "reports_false": 5, "false_auto_corroborated": 0,          // false reports the 3-party rule made public
  "confirm": { "n": 2, "true": 1, "precision": 0.5, "recall_pool": 2, "recall": 0.5 },
  "dismiss": { "n": 4, "false": 3, "precision": 0.75, "recall_pool": 5, "recall": 0.6 },
  "truth_changes": { "n": 1, "undetected": 0, "median_min": 40.0,
    "items": [ { "id": "truth_change:C", "at": "...Z", "before": "road_passable", "after": "road_blocked",
                 "detected": true, "minutes": 40.0 } ] },   // undetected: censored at the horizon
  "decisions_on_false": { "guidance_changes": 1, "dispatches_assist": 1, "verify_tasks": 0, "total": 2,
                          "of": { "guidance_change": 1, "dispatch_assist": 1, "dispatch_verify": 0 }, "items": [] },
  "rumours": { "n": 1, "contained": 1, "median_min": 30.0,
    "items": [ { "rumour_id": "...", "onset_at": "...Z", "members_received": 3, "members_dismissed": 3,
                 "members_corroborated": 0, "members_confirmed": 0, "contained": true, "minutes": 30.0 } ] },
  "metrics": { "triage.confirm_precision": 0.5, "...": null },   // sim/evaluation.py TRIAGE_METRICS keys
  "constants": { "TRIAGE_GRACE_MIN": 10.0, "CHANGE_MATCH_RADIUS_M": 200.0, "CONFIRM_RECALL_EXCLUDED_KINDS": ["help_needed"] } }
```

All minutes are drill minutes. Report times are `replay_at`; decision and task times are their
stored `replay_at` (new: `live_decisions` and `live_tasks` now record the drill time), else estimated
from the drill clock. Definitions are in the `sim/triage_quality.py` docstring and
[strategy-evaluation.md](strategy-evaluation.md) §3. A guidance change cites the `road_blocked`
reports on its proposal's `cause_segment_ids` received by then, plus a report whose controller
confirm triggered the replan (within `GUIDANCE_CONFIRM_LINK_S`, 5 s); it counts as on false
information when every cited report has a truth entry and was false at that drill time. Verify
tasks on false reports are listed but not penalised.

**Injecting generated data.** `python manage.py live_inject_noise --events <json> --profile
typical|hostile|clean --seed N [--changes <json>] [--until <drill time>]` applies the noise layer,
writes the truth map to `sim_truth`, and inserts the due phone and responder reports into
`live_reports` with `evidence_class: "simulated"` (same validation, road snapping, `client_id`
idempotency and civilian rate limits as `POST reports`; `replay_at` is the event's upload drill
time). Re-run it as the drill clock advances. Nothing about truth or noise is stored on a report.

## Injects

Scripted or instructor-triggered events that stress a plan ([ADR 0039](adr/0039-drill-injects.md)). Every
inject is **simulated** and labeled (`evidence_class: "simulated"`, label `Injected (simulated): ...`); nothing is
sent to real people, and no report is created for it. `live_injects` document (controller only):

```jsonc
{ "id": "inj_...", "type": "comms_outage", "params": { "zone_ids": ["bg:060070016002"], "until": "2018-11-08T16:30:00Z" },
  "at": "2018-11-08T15:40:00Z",         // drill time (UTC); omit on POST for "now" (the drill clock)
  "status": "scheduled|active|ended",   // follows the drill clock
  "actor": "controller",                // POST may set "script:<name>" (at most 40 characters)
  "label": "Injected (simulated): no phone signal in ...", "evidence_class": "simulated",
  "coord": null, "zone_ids": ["bg:060070016002"] }   // coord: map mark of point injects
```

| type | `params` | Effect (from `at`) |
| --- | --- | --- |
| `psap_reroute` | `zone_ids`, optional `until`, optional `to` (label) | The zones' 911 stream is dropped (as Paradise to Chico at 08:20 PST, 2018): their 2018 `911` record items no longer enter the review queue (`groundrecord.materialize_due`) or the `ground_record` panel from `at` (to `until`). Radio and rescue entries stay. Generated comms (`sim/gen_comms.py`) read the same windows: `zone_ids` x `[at, until or end)` |
| `comms_outage` | `zone_ids`, `until` | Civilian reports whose location lies in a zone, and check-ins declaring one, get `503 { "error": "no_signal" }` with `Retry-After: 60` between `at` and `until` (the phone's offline outbox keeps and retries them). Responders are exempt (radio). The command poll lists `no_signal_zone_ids`; the console hatches those zones grey |
| `silent_closure` | `segment_id` | The segment closes in the twin (`close_road`, `mode: hard`, operator actor `inject:<id>`, rationale `Injected (simulated): ...`). No report exists, so guidance and the public map do not know until a report or a responder check says so. Deleting it reopens the road |
| `shelter_full` | `destination_id` (a shelter or refuge) | The destination is full in the twin (`fill_destination`, [twin-api.md](twin-api.md#catalog)); guidance still offers it until a `shelter_full` report arrives. Not undoable until the drill restarts |
| `fire_jump` | `coord` `[lon, lat]`, optional `radius_m` (10..1000, default 150) | A small circle is added to the snapshot's fire estimate (`livecore.fire.estimate_fire(spots=...)`): `fire.label` ends `+ injected spot fire (simulated)`, `evidence_class` is `simulated`. Planner route safety sees it. The twin's own fire timeline is not changed |

Endpoints (controller token):

- `GET incidents/{id}/injects` -> `{ "injects": [DrillInject], "replay_now", "choices": { "segments": [{ "id", "name", "length_m" }] } }`
  (`choices` feeds the console's road picker). Reading moves each inject's status to the drill clock's.
- `POST incidents/{id}/injects` `{ "type", "params", "at"?, "actor"? }` -> `201 { "inject": DrillInject }`.
  `400 invalid_inject` for a bad type, params or an `at` outside the drill clock; `409` past 60 injects.
- `DELETE incidents/{id}/injects/{inject_id}` (or `DELETE incidents/{id}/injects?id=...`) -> `{ "deleted": id }`; `404` if unknown.

Applied by the drill clock, idempotently, where the snapshot is loaded (`state.load_snapshot` -> `injects.apply_due`):
the stored `status` moves with the clock (a drill reset puts every inject back to `scheduled`), and each change is
logged once in `live_decisions` as `inject_created`, `inject_started`, `inject_ended` or `inject_deleted` (note:
the label). `command` adds `injects` and `no_signal_zone_ids`. Index `{incident_id, at}`; `live_init_db
--drop-drill-data` drops the collection.

## Task board, passive observations and information priority (ADR 0041)

See [ADR 0041](adr/0041-crowdsourced-task-board.md). The model ranks which places most need a fresh
observation; the top ones become open questions on a public board; phones pick, on the device,
the questions on their own route or near them, and (opt-in) answer road questions passively while
navigating. Pure maths: `livecore/priority.py`; storage and endpoints: `api/live/board.py`.

### Information priority

For every candidate place, `priority = impact × p_change × staleness`, each in 0..1:

- **impact** = `1 - exp(-v / IMPACT_SCALE_VEH)` (`IMPACT_SCALE_VEH` = 5000; a Camp zone has about 1700 vehicles), where `v` is
  vehicle-equivalents at stake (computed from the models, never an LLM):
  - **segment** (road segments on published routes): the vehicles of every zone (level not `none`)
    whose published route crosses the segment, a zone counting `LOSE_ROUTE_WEIGHT` (2) times when
    none of its published alternatives avoids the segment (closing it would lose or force a long
    detour), else once (it would lengthen). This is the cheap approximation from published route
    edges, not the two planner runs of `POST impact`: the route's segments come from the planner's
    remembered edge ids (`live_plan_routes`) for the published (zone, destination, via), and an
    alternative avoids the segment when fewer than two of the segment's quarter points lie within
    `ON_ROUTE_M` (30 m) of its line (the impact analysis test). Segments shorter than
    `MIN_SEGMENT_LENGTH_M` (150 m) are not candidates, and only the `SEGMENT_REFINE_MAX` (150)
    segments with the most vehicles are scored (cost bound; about 1 s per refresh on Camp).
  - **destination**: `heading × load`, with `heading` = vehicles arriving per capacity window and
    `load = min(1, heading / capacity)`. Capacity as in the planner's `load` (`capacity_veh`, or for
    an exit the hourly capacity of its entering edges). Arrivals come from the traffic twin when it
    is ready (`arrived_veh` for a destination with `capacity_veh`, else `arrived_last_10_min_veh × 6`
    per hour; simulated), else from the vehicles of the `evacuate_now` zones the published plan
    sends there. Destinations with unknown capacity are not candidates.
  - **gateway** (fire-growth gateways): zones with households that the drill's simulated fire
    model (`fire_simulated.fronts`, never future observed perimeters) reaches within
    `GATEWAY_HORIZON_MIN` (30) drill minutes but the current estimate does not yet touch.
    `v` = the zone's vehicles × `spread_ratio`, where `spread_ratio` = clamp(modelled area growth in
    the next 30 min / growth in the last 30 min, 1, `GATEWAY_MAX_SPREAD_RATIO` (3)): accelerating
    spread raises the priority. The place is the zone's boundary vertex nearest the current fire.
    Gateways are console-only suggestions (responder tasks are never auto-dispatched).
- **p_change** = `1 - (1 - p_base) × (1 - p_fire)`: `p_base = 1 - 0.5 ** (PRIORITY_HORIZON_S / half_life)`
  (`PRIORITY_HORIZON_S` = 1800) with `half_life` = `HALF_LIFE_S["road_blocked"]` (7200 s) for a
  segment, `["shelter_full"]` (3600 s) for a destination, `["fire_seen"]` (900 s) for a gateway; and
  `p_fire = exp(-d / FIRE_DECAY_M)` with `d` the distance in meters from the place to the fire
  estimate (`FIRE_DECAY_M` = 2000; 0 when there is no estimate or beyond `FIRE_DISTANCE_MAX_M`,
  10 km). For ranking, `d` is measured from the place's ends and quarter points to the nearest fire
  boundary vertex (an overestimate by at most half the vertex spacing); the board's fire exclusion
  below uses the exact line-to-area distance.
- **staleness** = `1 - 0.5 ** (age_s / half_life)`, `age_s` = wall seconds since the newest
  independent observation of the place (any non-dismissed report: road kinds on the segment,
  `shelter_full` for the destination, `fire_seen`/`heavy_smoke` within `GATEWAY_OBSERVATION_M`
  (1000 m) for a gateway; passive reports count). Never observed: 1.

### Board refresh (auto-created questions)

On a `command` or `board` read, at most once per `BOARD_REFRESH_S` (60 s wall) per incident (an
atomic claim on the drill document; computed in the request, with the twin's arrivals read in a
background thread and cached for `TWIN_ARRIVALS_MAX_AGE_S`, 120 s): priorities are
recomputed and stored (`live_board`, one document per incident); expired board tasks close (`done`
with answers, else `cancelled` with note `"Expired"`); then the top-ranked **segment and destination**
places become open `verify` tasks with `created_by: "priority"`, until `BOARD_MAX_OPEN` (8) board
tasks are open: one open task per place (deduplicated), at most `BOARD_CREATE_PER_REFRESH` (3) new
per refresh, not within `BOARD_PLACE_COOLDOWN_S` (600 s) of the last board task on that place, only
with `priority >= BOARD_MIN_PRIORITY` (0.05), at least `BOARD_MIN_SPACING_M` (1500 m) from every
other open question (so one long road does not fill the board; the stored console list is spaced the
same way), and never for a place within `BOARD_FIRE_EXCLUSION_M` (1000 m) of the fire estimate. Only
while a drill has been started. Each refresh that creates questions logs one `board_tasks` decision
(actor `auto_policy`). A drill `reset` cancels open board questions and clears `live_board`.

Board task (`CheckTask` additions; older tasks have no `created_by`, which means `controller`):

```jsonc
{ "id": "tsk_01J...", "kind": "verify", "assignee": null, "status": "open",
  "created_by": "priority",                       // controller | proposal | priority
  "question": "road_status",                      // road_status | shelter_full
  "target": { "segment_id": "osm-way:10288574:0", "coord": [-121.6012, 39.7593], "destination_id": null },
  "place": { "kind": "segment", "name": "Pentz Road" },  // segment | destination
  "expires_at": "2026-10-24T18:35:00Z",           // created_at + PASSIVE_TTL_S (1800)
  "priority": { "priority": 0.42, "impact": 0.81, "p_change": 0.55, "staleness": 0.94 },  // at creation
  "report_ids": [], "note": null, "created_at": "...Z" }
```

Board tasks never appear in a responder's `me/tasks` or `situation.tasks`. Anyone (civilian,
responder, controller) answers one with a report carrying its `task_id`: `road_status` takes
`road_blocked`, `road_passable` or `heavy_traffic`, and the report's `road_ref` is set to the
question's segment (not snapped; phones send the question's `place.coord`, never their own
position); `shelter_full` takes `shelter_full` with the question's `destination_id`. Other kinds are
`400`; an expired or closed question is `409`. Answers do not close a board task; it closes at
`expires_at`. A civilian answering a non-board task still gets `403`.

### `GET incidents/{id}/board` (any role)

Questions only: no reports, no help requests, no responder assignments, no locations of people,
no priority numbers. Open board tasks that have not expired and are not within
`BOARD_FIRE_EXCLUSION_M` of the current fire estimate, best first.

```jsonc
{ "incident_id": "camp-2018-drill", "generated_at": "...Z",
  "limits": { "radius_m": 1500, "max_questions": 3, "stall_s": 120, "slow_ratio": 0.5 },  // PASSIVE_RADIUS_M, MAX_PASSIVE_QUESTIONS, STALL_S, SLOW_RATIO
  "items": [
    { "task_id": "tsk_01J...", "rank": 1, "question": "road_status",
      "place": { "kind": "segment", "segment_id": "osm-way:10288574:0", "destination_id": null,
                 "name": "Pentz Road", "coord": [-121.6012, 39.7593],
                 "line": [[-121.6015, 39.7590], [-121.6009, 39.7596]],   // null for a destination
                 "free_flow_kph": 56 },                                  // null for a destination
      "expires_at": "2026-10-24T18:35:00Z" } ] }
```

The phone selects, on the device, items whose segment lies on its own published route (two of the
segment's quarter points within 30 m of the route line) or whose `coord` is within `radius_m` of
the device; drops any item within 1000 m of the fire estimate it already has (and any route
segment the planner marks near the fire); and shows at most `max_questions`. The device position
never leaves the phone for this.

### Passive observations (`method: "passive"`)

Reports gain `method`: `explicit` (default; stored on every new report) or `passive`, and
`speed_class`: `free` | `slow` | `null`. A passive report is a phone's automatic note that it drove
through a board segment (opt-in "Share road observations" setting, off by default):

```jsonc
{ "client_id": "uuid", "kind": "road_passable",   // or heavy_traffic (requires speed_class slow)
  "method": "passive", "segment_id": "osm-way:10288574:0", "task_id": "tsk_01J..." /* optional */,
  "observed_at": "2026-10-24T18:07:00Z", "speed_class": "free" }
```

It must not carry `location`, `heading_deg`, `note` or `destination_id` (`400`): the server sets
`location` to the segment's midpoint (`accuracy_m: null`) and `road_ref` from `segment_id` (`snap_m: 0`),
so no device position is stored. Kinds other than `road_passable` and `heavy_traffic` are `400`.

Evidence weighting (`livecore.public`): a party whose reports on an item are all passive counts
`PASSIVE_PARTY_WEIGHT` (0.5) of an explicit party toward `PUBLIC_MIN_CIVILIAN_PARTIES` and the
responder + civilian rule; a passive-only group never overrides (opens) a block or another
contradicting state; passive reports never confirm a block (they cannot be `road_blocked`). They do
corroborate `road_passable` and `slow` states. Public items and road state add `passive_parties`
(parties whose reports there are all passive; included in `independent_parties`).

### Command additions

`command` adds `stale_critical` (the top `STALE_CRITICAL_LIMIT` (10) priority items, any kind) and
`board_computed_at`; each task gains `answers`:

```jsonc
"stale_critical": [
  { "id": "seg:osm-way:10288574:0", "kind": "segment",   // segment | destination | gateway
    "name": "Pentz Road", "coord": [-121.6012, 39.7593], "line": [[...]],   // line null unless segment
    "segment_id": "osm-way:10288574:0", "destination_id": null, "zone_id": null,
    "priority": 0.42, "impact": 0.81, "p_change": 0.55, "staleness": 0.94,
    "vehicles": 1240, "zones": 3, "zones_losing_route": 1,   // segment; else null
    "load": null,                                             // destination: 0..1
    "households": null, "spread_ratio": null,                 // gateway
    "fire_distance_m": 2400, "half_life_s": 7200, "last_observed_at": null,
    "reason": "1240 vehicles on 3 routes", "task_id": "tsk_01J..." } ],
"tasks": [ { "...": "CheckTask",
  "answers": { "road_passable": 3, "road_blocked": 1, "heavy_traffic": 0, "shelter_full": 0,
               "passive": 2, "total": 4, "last_at": "2026-10-24T18:07:00Z" } } ]
```

## Voice mode

`POST incidents/{id}/voice` is one turn of the phone's voice mode: the person speaks (or the phone
sends typed `text`), the server transcribes it, a short spoken reply and at most one phone action
are chosen, and the server speaks the reply back. Jev (TypeSafe) decides first when it is
configured and sure; Claude writes the reply and picks the action otherwise ([Decisions
(Jev)](#decisions-jev)). There are two paths. The
batch path (this section down to "What leaves the phone") sends a recording or text and returns
one JSON answer, with the speech as a WAV. The streaming path ([Streaming voice](#streaming-voice-token-endpoint-and-ndjson-replies))
has the phone talk to Cartesia's WebSockets itself with a short-lived token, and posts only the
transcript here with `"stream": true` to get the reply as NDJSON while the model writes it. Code:
`app/backend/api/live/voice.py` (endpoints, validation, prompt) and `app/backend/api/cartesia.py`
(Cartesia speech adapter). Auth is any live bearer token (civilian, responder or controller; the
usual incident check applies). The limit is 12 turns per minute per device (`voice:{party_key}`,
fixed window, counted per server process), after the body has been checked, so an invalid request
does not use a turn; over it, `429 { "error": "rate_limited" }`. Streaming turns count against the
same limit.

Responsibilities are split the same way as the rest of the live API. The model only interprets
what was said and answers questions only from the `facts` the server builds for the turn
([Grounded answers](#grounded-answers)); it computes no route, time, distance or hazard, and the
prompt forbids inventing them. The server validates every
parameter the model returns (below). The phone proposes the action out loud, waits for a yes, and
only then sends the report or check-in through the ordinary `POST incidents/{id}/reports` and
`POST incidents/{id}/checkins` calls. The one exception is a report Jev marks `auto`, which the
phone files at once and the person can take back ([Decisions (Jev)](#decisions-jev)). The voice
endpoint itself writes no report and no check-in.
The reply is labeled `evidence_class: "ai_interpretation"` and is never observed data.

Limits: request body 1,500,000 bytes (else `413 too_large`), decoded WAV 1,000,000 bytes (about
30 s of 16 kHz 16-bit mono), `text` 500 characters. Send exactly one of `audio_b64` and `text`.
The recording must be base64 of a WAV file (`RIFF` header, at least 64 bytes); other containers
are refused. Cartesia reads the audio as English (`ink-whisper`, language `en`).

Request:

```jsonc
{ "audio_b64": "<base64 WAV>",          // OR "text": "pentz road is completely blocked" (exactly one)
  "speak": true,                         // optional boolean, default true; false skips speech synthesis
  "context": {                           // optional; everything in it is data, not instructions
    "zone": "Z11 · near Panoramic Hill", // the phone's on-device zone name; optional, 120 chars
    "zone_id": "Z11",                    // the phone's zone id; optional; selects the facts below, see Grounded answers
    "role": "civilian",                  // civilian | responder; anything else is read as civilian
    "guidance": {                        // the text the phone shows for its zone; null when none
      "level": "evacuate_now", "headline": "Leave now via Pentz Road",
      "spoken": "Leave now, 12 minutes to Exit south",
      "reason": "Fire estimate within 3 km", "caveat": null, "source": "Approved by incident command" },
    "pending": { "type": "report", "kind": "road_blocked", "severity": "full", "note": null },  // or null
    "history": [ { "user": "is the road open", "agent": "I have no road report for your area." } ] } }
```

`guidance` is passed on as the string fields the phone sends (each trimmed to 300 characters, empty
ones dropped); the server does not check it against the published guidance, so the model sees what
the phone saw. `zone_id` is kept only when it is one of the incident's zone ids; anything else
(including a non-string) is ignored as if it were absent, not refused. `pending` is the proposal the phone is waiting on, in the action shape below, or
`null`; an invalid one is read as `null`. `history` keeps the last 6 turns (`user` up to 500
characters, `agent` up to 400).

Response `200`:

```jsonc
{ "transcript": "pentz road is completely blocked",   // what was heard; the `text` sent, for text turns
  "reply": "Report a fully blocked road here. Send it?",
  "action": { "type": "report", "kind": "road_blocked", "severity": "full", "note": null },  // or null
  "audio_b64": "<base64 24 kHz 16-bit mono WAV>",    // null when no audio was produced
  "audio_format": "wav",                              // null with audio_b64
  "tts": "cartesia",                                  // cartesia | failed | skipped
  "model": "claude-opus-5-5",                         // null when nothing was heard; Jev's model id when Jev decided
  "sources": [],                                      // the facts sections the reply used; see Grounded answers
  "decided_by": "claude",                             // jev | claude | null (null when nothing was heard)
  "auto": false,                                      // true only for a report the phone may file without asking
  "confidence": null,                                 // Jev's probability (0-1, 3 decimals) when decided_by is jev; else null
  "evidence_class": "ai_interpretation" }
```

`action` is `null` or one of the following; `severity` is set only for `road_blocked` and
`heavy_traffic`, `note` is at most 280 characters:

| `type` | Fields | Phone behaviour |
| --- | --- | --- |
| `report` | `kind` (a [report kind](#report-kinds)), `severity` (`full`, `partial`, `slow` or `null`), `note` (string or `null`) | Asks, then submits a report with the phone's own location attached |
| `check_in` | `status`: `out`, `need_help` or `staying` | Asks, then calls `POST incidents/{id}/checkins` |
| `open` | `screen`: `home`, `map`, `route` (starts directions on the published route), `reports` or `plan` | Shows that screen |
| `confirm`, `cancel` | none | Answers the `pending` proposal; the server returns them only when `pending` was sent |
| `undo` | none | Take back the report the phone just sent. The server does not check that there is one; the phone does ([Decisions (Jev)](#decisions-jev)) |

`report` and `check_in` are proposals. Nothing is sent until the person says yes, so the phone
holds the proposal as `pending` and sends it back on the next turn; "yes" then comes back as
`confirm`. A correction comes back as a new proposal. A model answer that does not validate
becomes `action: null` and its spoken reply is kept. If the person says nothing audible, the reply
is "Sorry, I didn't catch that. Try again.", `action` is `null` and `model` is `null`. A refusal by
the model returns a fixed apology that includes the 911 line, with `action: null`.

Help actions. When the action is a `help_needed` report or a `need_help` check-in, or a `confirm`
of one, the server appends "If you are in danger, call 911." to the reply unless it already says
911. This is a drill and the voice reply never says that anyone has been alerted. The rule applies
the same way to a Jev decision, whose fixed templates do not contain "911".

Speech. The reply is spoken by Cartesia `sonic-3.6` (the first 600 characters), as a 24 kHz WAV.
`tts` is `skipped` when `speak` is false or `CARTESIA_API_KEY` is unset, and `failed` when Cartesia
errored; both still return `200` with the text, and the phone then speaks the reply on the device.

Errors, always `{ "error": code, "detail": "..." }`:

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_voice` | Not JSON, both or neither of `audio_b64` and `text`, bad base64, not a WAV, a recording or `text` over its limit, or a malformed `context`/`speak` |
| 401 | `unauthorized` | Missing or invalid bearer token |
| 403 | `forbidden` | A responder token for another incident |
| 404 | `not_found` | Unknown incident |
| 413 | `too_large` | Body over 1,500,000 bytes |
| 429 | `rate_limited` | More than 12 turns in a minute |
| 429 | `upstream_rate_limited` | Anthropic is rate limiting |
| 502 | `stt_failed` | Cartesia transcription failed (rejected, unreachable or a bad answer) |
| 502 | `upstream_error`, `upstream_unreachable` | Anthropic returned an error status, or could not be reached |
| 503 | `voice_unavailable` | `ANTHROPIC_API_KEY` is unset, or `CARTESIA_API_KEY` is unset for an audio turn, or a provider rejected its key |
| 504 | `upstream_timeout` | Anthropic did not answer in 30 s (one retry) |

What leaves the phone on the batch path. For a spoken turn, the recording goes through this server
to Cartesia for transcription. The transcript and the context (zone name, the guidance text above, the pending
proposal, the last 6 turns) go to Anthropic, together with the server-built `facts`
([Grounded answers](#grounded-answers)), and the reply text goes to Cartesia for speech. The one
field added for the facts is `context.zone_id`, a zone id with no position.
Coordinates are not part of the request: the location of a report is attached on the phone when
the report is sent, after the person agrees, and a `need_help` check-in carries its coordinates as
described under [Check-ins](#check-ins). The server stores no audio, transcript, reply or context
from a turn and logs only provider error codes, how long the facts took to build and, when they
fail, the exception (the log lines carry the incident and zone ids, not the transcript). When `TYPESAFE_API_KEY` is set, a smaller state also
goes to TypeSafe on every turn (see [Decisions (Jev)](#decisions-jev)). This document does not state
how long Cartesia, Anthropic or TypeSafe keep what they receive; that was not checked.

Configuration (server environment, never `VITE_*`): `ANTHROPIC_API_KEY` and `CARTESIA_API_KEY`
(both paid), optional `CARTESIA_VOICE_ID`, `CARTESIA_TTS_MODEL` (default `sonic-3.6`) and
`VOICE_MODEL` (default `claude-opus-5-5`), and optional `TYPESAFE_API_KEY` (paid) with `JEV_MODEL`
(default `jev-latest`). See [`app/backend/README.md`](../app/backend/README.md).

### Grounded answers

Questions such as "Is Pentz Road blocked?", "Where is the nearest shelter, is it full?", "How close
is the fire?", "Which way, and how long?" and "Has my order changed?" are answered only from
`facts`, a compact object the server builds for the turn and puts in the model's user message in a
`<facts>` block, next to the phone's `<context>`. Code: `app/backend/api/live/voice_facts.py`
(building the facts) and `voice.py` (the request field, the prompt and the `sources` check). The
facts are copies and direct measures of data the server already holds: the same snapshot as
`situation` (public items, fire estimate, drill clock), the zone's guidance as the phone receives
it, the guidance version history, and the drill's zones and destinations. No model estimates
anything in them.

It is a single model call. There is no tool loop in which the model could look something up, so
everything it may state is in `facts`, and a question the facts do not cover is answered with "I
don't have that information". That keeps latency to one call; it was chosen over a tool loop, and the
extra time the facts add to a turn was not measured for this document (the server logs the build time
of each as `voice: facts for ... in N ms`).

**When facts are built.** Only for a turn that goes to Claude: a turn with a transcript that Jev
did not decide ([Decisions (Jev)](#decisions-jev)). Jev's fixed replies, a turn with nothing
heard and a refusal carry no facts and `sources: []`. Batch and streaming turns are the same.

**The request field.** `context.zone_id` is the zone id the phone already knows (the one it sends
with check-ins). The server keeps it only if it is one of the incident's zones (the drill index);
an unknown or non-string value is ignored and the turn is built as if no zone had been sent. No
coordinates are added.

**The `facts` object.** Illustrative values; the shape is what the code builds:

```jsonc
{ "as_of": "2018-11-08T16:05:00Z",        // drill clock (replay time); null if the drill has none
  "drill": "Camp Fire drill, 2018-11-08", // the drill's label, 200 chars
  "zone": { "id": "bg:060070009011", "name": "Block Group 1, Census Tract 9" },   // null without a valid zone_id
  "guidance": {                           // the zone's published guidance; null with no zone or none published
    "level": "evacuate_now",              // evacuate_now | be_ready | none
    "headline": "Leave now via Skyway",   // as the phone titles it
    "destination": "Exit south", "route_via": ["Skyway", "Clark Road"],   // up to 4 road names
    "eta_min": 26, "route_km": 14.2,      // drive time and length of the published route
    "no_route": false,
    "reason": "Fire estimate within 3 km", "caveat": null,   // 200 chars each
    "options": [ { "destination": "Exit south", "via": ["Skyway"], "eta_min": 26, "recommended": true } ],   // up to 3
    "source": "Approved by incident command",   // or "Official order" or "Model estimate"
    "version": 3, "as_of": "2018-11-08T16:00:00Z" },
  "guidance_history": [ { "version": 2, "level": "be_ready", "headline": "Be ready to leave",
                          "reason": "Fire estimate within 8 km", "as_of": "2018-11-08T15:40:00Z" } ],   // up to 3 earlier versions, newest first; [] without any
  "hazards": [ { "kind": "road_blocked", "severity": "full", "road": "Pentz Road", "place": null,
                 "status": "confirmed",   // confirmed | responder_corroborated | corroborated
                 "reports": 3, "people": 3,
                 "first_reported_at": "2026-10-24T17:40:12Z", "last_reported_at": "2026-10-24T17:52:40Z",
                 "minutes_ago": 14, "km_from_zone": 1.2 } ],      // up to 8
  "hazards_total": 5,                     // how many public items there are in all
  "shelters": [ { "name": "Paradise Alliance Church", "kind": "shelter", "km_from_zone": 4.1,
                  "reported_full": false, "full_reported_at": null, "full_minutes_ago": null } ],   // up to 5
  "fire": { "method": "model_nowcast", "label": "Model estimate, 16:00 drill time",
            "evidence_class": "simulated", "as_of": "2018-11-08T16:00:00Z", "age_min": 5,
            "km_from_zone": 2.3, "zone_inside": false } }          // null with no fire estimate yet
```

Lists can be empty and are never padded. `truncated: true` appears only when the facts were cut to
fit (below).

- Guidance. `guidance` is the zone's published guidance as the phone gets it, with `source` worded as
  the phone words it. `guidance_history` reads the zone's earlier versions from `live_guidance`,
  which is append-only until a drill reset, so it holds what was published before, not a log of why
  it changed. The phone's own `context.guidance` is still sent and still not checked against the
  server's.
- Hazards. These are the incident's public items of any kind, by the publication rule in
  [Rules](#rules-deterministic-constants-named-in-code): not stale or contradicted, and three
  independent civilians, or a responder and a civilian, or confirmation by incident command
  (`help_needed` is never public). `status` says
  which: `confirmed`, `responder_corroborated` or `corroborated`. Order: items on a road the person
  named come first (the road's full name or its name without "Road", "Drive" and similar, at least
  4 letters, as whole words in the transcript), then nearest, then newest. The model is told to say
  "no public reports" for a road with no entry, never "clear".
- Shelters. The nearest 5 destinations of kind `shelter` or `temporary_refuge`. `reported_full` is
  true only when a public `shelter_full` item names the destination (`full_reported_at` is its
  first report). False means no public report, not that there is room.
- Fire. The current fire estimate with its own `method`, `label` and drill time, as in
  [Fire estimate](#fire-estimate-current-best-estimate-never-a-forecast). It is an estimate, not a
  forecast and not an observation of the fire's edge. `zone_inside` is true when the estimate
  overlaps or touches the zone.

**Distances.** `km_from_zone` is kilometres to one decimal, from the nearest edge of the person's
zone polygon to the hazard's or shelter's point, `0.0` when the point is inside the zone. For the
fire it is the gap between the zone and the estimate's polygon, `0.0` when they overlap or touch.
The method is the planar one used elsewhere for areas (`livecore.geo`: an equirectangular projection
at the zone's latitude), not haversine and not driving distance, and it is measured from the zone's
edge, not from the person. The module's comment says the result differs from great-circle distance by
well under 1 percent over an incident; that was not measured here. Coordinates are `[lon, lat]`
internally and none are sent. Without a valid `zone_id` every `km_from_zone` is `null`, and the
prompt tells the model that nothing is then "nearest" or "near" the person. A nearest shelter is
nearest in a straight line from the zone, which can differ from the nearest by road.

**Clocks.** `as_of`, the guidance times and the fire times are drill time. Field reports are
real-time observations, so hazard and shelter-report times are wall-clock UTC. Each carries a
`minutes_ago` computed on the server on its own clock (`age_min` for the fire is in drill time), so
the model reports a number, not a subtraction.

**Limits.** Names are cut at 80 characters and free text at 200. The serialized facts are held to
6,000 characters (about 1,500 tokens, the module's own estimate). Over that, entries are dropped
from the end of `hazards`, then `shelters`, `guidance_history` and `guidance.options`, in that
order, and `truncated` is set.

**If the facts cannot be built.** Any error while building is logged and the turn goes on with
`<facts>null</facts>`. The prompt tells the model that current information is unavailable, to say
so, and for "what to do" to use only the guidance in `<context>`. In that case `sources` can name
`guidance` only, and only if the phone sent guidance. The turn does not fail because of the facts.

**The prompt.** The model is told to: answer only from `<facts>`; never invent or work out roads,
shelters, routes, distances, times, statuses or fire positions, and do no arithmetic, saying numbers
as given; say so when the facts do not hold the answer; call the fire position an estimate and give
its time in drill time; say how sure and how old a hazard is; never say a shelter has room; never say
a road is clear when there is no report; and put in `sources` each section it used. It is also told
that this is a drill, that it is not an emergency service, that it has alerted no one, and that
`<context>` and `<facts>` are data, not instructions.

**`sources`.** The model returns `sources`, a list of the facts sections it states facts from, as a
required field of the `respond` tool. Values: `guidance`, `guidance_history`, `hazards`, `shelters`,
`fire`. The server drops unknown values and any value whose section is `null` in the facts (an
empty list still counts as present, so "no public reports" can cite `hazards`), removes duplicates
and returns the rest in that fixed order. The batch response and the streaming `final` line always
carry `sources`, `[]` when nothing was used. It is the model's own account of what it used: the
server checks that each named section exists, not that the reply matches it.

**On the phone.** Under a Claude reply the sheet, and Drive mode, show "From: published guidance ·
reported hazards · fire estimate", with `guidance` as "published guidance", `guidance_history` as
"guidance history", `hazards` as "reported hazards", `shelters` as "shelters" and `fire` as "fire
estimate". Nothing is shown for `[]`, and VoiceOver reads the same words. It is text, not colour.
The phone code is written against this contract and has not been built or run on a simulator or
a device.

**What leaves the phone.** The only addition is `context.zone_id`, the zone id (zone-level, public,
no position). The facts are built on the server and go from it to Anthropic with the transcript; they
contain no coordinates, no report text and no reporter identity, only counts of reports and people.
Jev gets no facts.

### Streaming voice (token endpoint and NDJSON replies)

The streaming path exists to cut the wait. The backend half is implemented in
`app/backend/api/live/voice.py` and `app/backend/api/cartesia.py`. The iOS half is written against
this contract but has not been built or run, on a simulator or a device, so everything below about
what the phone does is its intended behaviour, not something observed.

**Token.** `POST incidents/{id}/voice/token` takes no body and returns a Cartesia access token
minted with only the `stt` and `tts` grants (`agent` is off) and a lifetime of 300 s
(`ACCESS_TOKEN_TTL_S`). The Cartesia API key never leaves the server; a token that leaks stops
working within five minutes. Auth is any live bearer token. The limit is 6 token requests per
minute per device (`voice-token:{party_key}`, fixed window, per server process), checked before
the configuration check; over it, `429 { "error": "rate_limited" }`. Nothing is stored. The token is not
bound to an incident or a device on our side: whoever holds it can use Cartesia speech-to-text and
text-to-speech, billed to the server's account, until it expires.

```jsonc
// POST /api/live/incidents/camp-2018-drill/voice/token   Authorization: Bearer <live token>
// 200
{ "token": "<Cartesia access token>",
  "expires_in": 300,                     // seconds
  "version": "2026-08-14",               // Cartesia API version header value
  "stt": { "url": "wss://api.cartesia.ai/stt/websocket", "model": "ink-2", "language": "en",
           "encoding": "pcm_s16le", "sample_rate": 16000,
           "keyterms": ["CA 99", "Skyway Road", "Pentz Road", "..."] },   // up to 30 place names
  "tts": { "url": "wss://api.cartesia.ai/tts/websocket", "model": "sonic-3.6",   // CARTESIA_TTS_MODEL
           "voice_id": "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",                   // CARTESIA_VOICE_ID
           "language": "en", "encoding": "pcm_f32le", "sample_rate": 24000 } }
```

| Status | `error` | When |
| --- | --- | --- |
| 401, 403, 404 | `unauthorized`, `forbidden`, `not_found` | As for every live endpoint |
| 429 | `rate_limited` | More than 6 token requests in a minute |
| 502 | `token_failed` | Cartesia could not mint the token (unreachable, or an error or unreadable answer) |
| 503 | `voice_unavailable` | `CARTESIA_API_KEY` or `ANTHROPIC_API_KEY` is unset, or Cartesia rejected the key |

A 503 tells the phone to fall back to typed input, on-device speech and the batch `text` path.

**Key terms.** Streaming STT uses `ink-2` because it accepts `keyterm` boosts. `keyterms` lists the
incident's 40 busiest named roads (by segment count), then its exit and shelter names (prefixes such
as `TRA-B:` and quoted notes removed), then other roads, capped at 30 names and 600 characters. The
phone sends at most 10 as `keyterm` query parameters, in this order: the roads on its zone's
published route, its destination, the places in its on-device board questions, then the server's
list. More boosts dilute each other: measured on the Camp drill with a synthesized "There's a tree
down across Pentz Road", `ink-whisper` and unboosted `ink-2` heard "Pence Road", `ink-2` with 3 or 10
terms heard "Pentz Road", and with 20 or more it heard "Pence Road" again. None of the terms is the
person's position; they are public map names.

**Streaming request.** `POST incidents/{id}/voice` with `"stream": true` and `text` (a transcript
of at most 500 characters). The rest of the body is the same as above. `audio_b64` with `stream`
is `400 invalid_voice`, because the phone transcribes over Cartesia's WebSocket; `stream` must be a
boolean. `speak` is accepted and ignored, since this server does no synthesis on this path. The
path needs `ANTHROPIC_API_KEY` but not `CARTESIA_API_KEY`. Everything that can fail before the
model is called (invalid body, auth, `413`, the 12-per-minute `429`, a missing Anthropic key) is
answered with the ordinary JSON error from the table above and no stream. After that the answer is
`200` with `Content-Type: application/x-ndjson`, `Cache-Control: no-store` and
`X-Accel-Buffering: no`: one JSON object per line.

| `type` | Fields | Meaning |
| --- | --- | --- |
| `reply_delta` | `text` | The next piece of the spoken reply. Concatenate in order, exactly, with no trimming: pieces carry their own spaces. Tabs and line breaks in the model's text arrive as spaces |
| `reply_end` | none | The reply text is complete. It can arrive before `final`, because the model is still finishing its call |
| `final` | as the batch answer (including `sources`), plus `streamed` and `spoken_extra` | Always the last line of a successful stream |
| `error` | `error`, `detail` | The stream failed after it started; no `final` follows. Codes: `upstream_timeout` (30 s), `upstream_rate_limited`, `upstream_error` |

```ndjson
{"type": "reply_delta", "text": "Report a fully"}
{"type": "reply_delta", "text": " blocked road here."}
{"type": "reply_delta", "text": " Send it?"}
{"type": "reply_end"}
{"type": "final", "transcript": "pentz road is completely blocked", "reply": "Report a fully blocked road here. Send it?", "streamed": true, "spoken_extra": null, "action": {"type": "report", "kind": "road_blocked", "severity": "full", "note": null}, "audio_b64": null, "audio_format": null, "tts": "client", "model": "claude-opus-5-5", "sources": [], "decided_by": "claude", "auto": false, "confidence": null, "evidence_class": "ai_interpretation"}
```

How the piece boundaries fall depends on the model's output, so the example is illustrative. In
`final`, `audio_b64` and `audio_format` are always `null` and `tts` is `"client"`: the phone
speaks. `streamed` is `true` when `reply_delta` lines were sent; `reply` is then the spoken text
(whitespace collapsed, cut at 400 characters), so the transcript on screen matches the audio. When
`streamed` is `false` nothing usable was streamed (a refusal, or an empty reply) and the phone
speaks `reply` whole. `spoken_extra` is `"If you are in danger, call 911."` under the same rule
as the help-action rule above and `null` otherwise. It is appended to `reply` and is not among the
`reply_delta` lines, so the phone speaks it after the streamed reply. `action` is validated as on
the batch path and is only sent in `final`, so the phone does not act on it until `final` has arrived.

How it works. The request to Claude declares the `respond` tool with eager input streaming, and the
server reads the `reply` string out of the partial tool-input JSON as it arrives (`ReplyScanner`).
The streaming request therefore does not set `strict` on the tool; the server's own checks of
`action` (`_clean_action`) still apply and are the only validation on this path. Fixed `reply` text
such as the refusal apology is sent whole in `final`.

Latency, measured on the local Docker stack: the first `reply_delta` arrives about 3.2 s after the
request is posted and the whole reply about 3.7 s. The batch path on the same stack took about
6.8 s. These figures cover the model call only. They do not include speech-to-text, speech
synthesis or the network from a phone, the number of runs is not recorded here, and nothing has
been timed end to end on a phone.

**What the phone does (intended, not yet run).** The phone requests a token before it listens and
asks for a new one when it expires. It then talks to Cartesia directly:

- Speech-to-text. While the person is speaking the phone sends microphone audio as 16 kHz mono
  signed 16-bit PCM over the `stt` WebSocket, with the token as the `access_token` query
  parameter, and shows the interim and final transcripts as live captions. When the person stops,
  the phone asks Cartesia to finalize and takes the concatenated final text as the transcript.
- Server turn. The phone posts that transcript to `voice` with `"stream": true`.
- Text-to-speech. It forwards `reply_delta` text to the `tts` WebSocket as the pieces arrive (one
  context per utterance, the last piece marked as final), and plays the returned 24 kHz float PCM
  chunks as they come in, so speech starts before the reply is complete. Replies use normal
  speed and a neutral emotion.
- Barge-in. If the person speaks or taps while the reply is playing, the phone cancels the
  Cartesia context, stops playback and starts listening. On a speakerphone this relies on Apple's
  echo cancellation (voice processing) to tell the person from the phone's own speaker; that is an
  assumption, not something tested.
- Fallback. When the token endpoint answers 503, or Cartesia cannot be reached before any audio has
  played, the phone uses typed input and the on-device speech synthesizer, and for transcripts the
  batch `text` path.

What goes where, on this path:

| Destination | What it receives |
| --- | --- |
| Cartesia, directly from the phone | Microphone audio while the phone is listening; the reply text, and any announcement text, to be spoken; the access token. Cartesia sees the phone's network address |
| This server (and from it, Anthropic) | The transcript, the zone name and id, the guidance text, the pending proposal and the last 6 turns, as in `context` above. The server adds `facts` (public data, no coordinates) before the model call |
| TypeSafe, from this server, when `TYPESAFE_API_KEY` is set | The transcript, the pending proposal, the last reply and the guidance headline ([Decisions (Jev)](#decisions-jev)) |
| Not sent anywhere | Coordinates, as before. Microphone audio does not reach this server on the streaming path |

**Drive mode.** The phone's Drive mode is a voice-first full screen that reads guidance changes
aloud. The announcements are built on the phone, from the guidance the phone has already fetched
(the published title, spoken sentence, reason and caveat, and what changed), with fixed wording.
There is no LLM and no call to `voice` in that path, so an announcement can never say anything
the published guidance does not. Only the resulting sentence goes to Cartesia for speech, in a calm
voice at a slightly reduced speed, or to the on-device synthesizer when Cartesia is unavailable. It
is stated as a drill when Drive mode starts. Questions asked in Drive mode go through the ordinary
voice turn above.

Known limits of the whole voice mode: English only (`language` is `en` in the token response and
Cartesia is asked for English); the report's location is the phone's position when the report is
sent, even if the person names another place; speech-to-text and text-to-speech need a network
connection; the iOS half has not been run on a physical device.

### Decisions (Jev)

Most voice turns are small decisions: is this a report, which kind, is it a yes. Jev is TypeSafe
AI's "System One" model, which answers bounded questions (a choice among options, a score, or the
probability of a yes, called `noul`) with typed, calibrated probabilities instead of prose. The
vendor reports 70 to 500 ms per call and early access from September 2026; those are the vendor's
claims, not measured here. The backend half is implemented in `app/backend/api/jev.py` (the
adapter) and `app/backend/api/live/voice_decide.py` (questions and policy), wired in
`app/backend/api/live/voice.py`. The iOS half is written against this contract and has not been
built or run on a simulator or a device.

**Flow.** On every turn with a transcript, on both the batch and the streaming path, the server
asks Jev first. If Jev's answers clear the thresholds below, the server returns Jev's action and a
fixed reply (`decided_by: "jev"`) and Claude is not called. Otherwise Claude handles the turn as
described above (`decided_by: "claude"`). Claude handles questions ("where do I go"), turns with an
intent Jev rates `other`, and any turn where Jev is unsure. It also handles the turn when
`TYPESAFE_API_KEY` is unset and when the Jev call fails (key rejected, request refused, an error
status, an unreadable answer, or a request that exceeds the 4 second HTTP timeout); the log records
only the error code. A slow Jev call therefore delays the Claude answer by about 4 seconds, at most
(the timeout is per socket operation, not a cap on total time). A turn with no audible speech skips
Jev and gets the "didn't catch that" reply. `ANTHROPIC_API_KEY` is still required for every voice
turn, because that check runs before Jev is asked, and the 12-turns-per-minute limit counts Jev
turns too. On the streaming path a Jev decision arrives in the same NDJSON shape: one `reply_delta`
with the whole reply, `reply_end`, then `final`.

**Questions.** One call carries all of these, each reading the same state:

| Question | Answers |
| --- | --- |
| `intent` | `report`, `check_in`, `question`, `open`, `undo`, `other` |
| `kind` | the eight [report kinds](#report-kinds), or `none` |
| `severity` | `full`, `partial`, `slow`, `unknown` (used only for `road_blocked` and `heavy_traffic`) |
| `status` | `out`, `staying`, `need_help` |
| `screen` | `home`, `map`, `route`, `reports`, `plan`, `none` |
| `firsthand` | `noul`: the probability that the person is describing something happening now, first-hand, not asking, speculating or repeating hearsay |
| `here` | `noul`: the probability that what they describe is on the road they are on or within sight; a place clearly away from them, or one they heard about, counts as no |
| `pending_reply` | `yes`, `no`, `change`, `other`; asked only when the phone sent a `pending` proposal. A confident `change` to a proposed report keeps its kind (unless `kind` reaches 0.85), takes a confident new severity, appends the words to the note, and asks again; it is never filed automatically |

The state Jev sees has four fields: the transcript (`said`), the pending proposal, the last reply
(`last_reply`, the `agent` text of the newest history turn) and the guidance headline. It holds no
position, no zone name and no other guidance text. The pending proposal can carry the `note`,
which is the person's own words.

**Thresholds.** Constants in `voice_decide.py`. A choice's `confidence` is the value Jev returns
with the answer it picked. The `confidence` returned to the phone is the smallest one the action rests on
(for a report, the lower of `intent` and `kind`; for `open` and `check_in`, `intent` and `screen`
or `status`; for `confirm`, `cancel` and `undo`, the single answer).

| Constant | Value | Applies to |
| --- | --- | --- |
| `AUTO_CONFIDENCE` | 0.85 | `intent` and `kind` must both reach it for a report to be filed without asking |
| `AUTO_FIRSTHAND` | 0.8 | `firsthand` probability, also required for an automatic filing |
| `AUTO_HERE` | 0.6 | `here` probability, also required for an automatic filing |
| `PROPOSE_CONFIDENCE` | 0.6 | `intent`, and the `kind`, `status` or `screen` that follows it; below it Claude takes the turn |
| `ANSWER_CONFIDENCE` | 0.8 | a `yes` or `no` to a pending proposal, and an `undo` intent |
| `SEVERITY_CONFIDENCE` | 0.6 | `severity`; below it the report carries `severity: null` and the turn stays with Jev |

These values are starting points. They have not been calibrated on labelled utterances, so the
rates at which Jev files wrongly, asks needlessly or hands over to Claude are unknown.

**What Jev may decide.**

- With a proposal pending, a confident `yes` returns `confirm` ("Sending it now.") and a confident
  `no` returns `cancel` ("Okay, I won't send it."). A `change`, `other` or unsure answer falls
  through to the rest, so a correction becomes a new proposal.
- `open` returns the screen with a fixed reply such as "Opening the map."
- `undo` returns `undo` ("Okay, taking back your last report.").
- `check_in` returns a proposal ("Check you in as staying where you are? Say yes to send it.") that
  the person confirms. A `need_help` check-in says that it shares the location with responders, and
  the 911 line is appended.
- `report` returns a proposal ("Report a fully blocked road at your location? Say yes to send it.")
  with `auto: false`, or, when every condition below holds, the same report with `auto: true` and
  the reply "Reported a fully blocked road at your location. Say undo to take it back."

A report is `auto` only when its kind is one of `road_blocked`, `road_passable`, `heavy_traffic`,
`fire_seen`, `heavy_smoke`, `hazard_down` or `shelter_full`; `intent` and `kind` are at least 0.85;
`firsthand` is at least 0.8; and `here` is at least 0.6. `help_needed` is never automatic: it is
about another person and always confirmed, with the 911 line. Check-ins are never automatic: a
`need_help` check-in shares the person's position with responders, and a check-in cannot be taken
back. `here` matters because the phone pins the report at its own position, so "the gym is full",
said elsewhere, is proposed and not filed. The `note` of a report is the person's own transcript
with whitespace collapsed, cut at 280 characters; no model writes or rewrites it. Every reply on
this path is a fixed template in `voice_decide.py`, so no model writes what the phone says, and the
reply names only the kind and severity, not a place.

**Response fields.** `decided_by` is `jev`, `claude` or `null` (nothing was heard). `auto` is
`true` only for a Jev report that may be filed without asking; it is `false` for everything else,
including every Claude answer. `confidence` is the figure described above, rounded to three decimals, or
`null` when Claude decided. `model` is the model id TypeSafe returned (the `JEV_MODEL` value if it
returned none) for a Jev decision.

```jsonc
// "Pentz Road is completely blocked", said at the person's own position
{ "transcript": "Pentz Road is completely blocked",
  "reply": "Reported a fully blocked road at your location. Say undo to take it back.",
  "action": { "type": "report", "kind": "road_blocked", "severity": "full",
              "note": "Pentz Road is completely blocked" },
  "audio_b64": null, "audio_format": null, "tts": "client",
  "model": "jev-latest", "decided_by": "jev", "auto": true, "confidence": 0.94,
  "evidence_class": "ai_interpretation" }

// "undo that"
{ "transcript": "undo that",
  "reply": "Okay, taking back your last report.",
  "action": { "type": "undo" },
  "audio_b64": null, "audio_format": null, "tts": "client",
  "model": "jev-latest", "decided_by": "jev", "auto": false, "confidence": 0.97,
  "evidence_class": "ai_interpretation" }
```

The values are illustrative, not captured output. `undo` is also in the Claude `respond` tool's
action list, so Claude can return it with `decided_by: "claude"`.

**What the phone does (intended, not yet run).** On `auto: true` the phone files the report at once
and does not ask. It checks the action again on the device and
does not file `help_needed` or a check-in automatically, whatever the server sent. For 5 minutes
after a report it filed, "undo" by voice or an Undo button takes it back: an unsent draft is
deleted, and a report already sent is withdrawn, unless a responder has already acted on it. The server
allows a withdrawal only while the report is `unverified` or `corroborated` ([Edit or withdraw your
own report](#edit-or-withdraw-your-own-report)). Under a reply the sheet shows "Jev · 94% · filed
automatically" for an automatic report, and "Claude" for a Claude answer. The server returns `undo` without knowing whether there is
anything to take back and keeps no record of the report. None of this has been run on a device.

**Measured (2026-10-24, `jev-1.14.0`, 19 hand-written phrases, one run each).** Jev answered in
0.11-0.26 s per call, and a streamed Jev turn reached its first reply text 0.22 s after posting
(a Claude turn on the same stack: 1.6-3.0 s). Intent was right on all 19: reports, check-ins,
questions (to Claude), screens, `undo`, and yes / no / a correction to a pending proposal. Filed
automatically: "I can see flames on the ridge to my left", "traffic's at a total standstill here on
Skyway", "the smoke is so thick I can barely see". Proposed instead: "Pentz Road is completely
blocked by a fallen tree" and "Clark Road is open" (`here` about 0.5: naming a road does not say the
person is on it), "there's a tree down across the road" (`kind` 0.7, blocked road or tree down),
hearsay ("my neighbor said the gym shelter is full", `firsthand` 0.05), help and check-ins. The
first wording of `here` ("at or right next to where the person is") scored "flames on the ridge to
my left" 0.35; the current wording files it. This is a smoke test, not a calibration.

**Limits and assumptions.** The thresholds are uncalibrated (above). An automatic report is pinned
at the phone's own position, so a place the person names is not located (`here` lowers the chance,
and does not remove it). A report is filed on the strength of a speech-to-text transcript, which can
mishear. The Jev questions and the 4-second timeout are set in code and not configurable except for
the model id. TypeSafe's accuracy, latency and retention of what it receives have not been checked
here.

## Studio fires

Simulation Studio publishes the fire it just ran so the Live command page can start the same
fires. Everything is simulated (`evidence_class: "simulated"`). Code: `api/live/studio_fires.py`.

`POST /api/live/studio-fires` (controller) with:

```json
{ "scenario_id": "berkeley-hills", "name": "Berkeley Hills, NE wind", "region_id": "berkeley",
  "ignitions": [{ "id": "F1", "name": "F1", "lon": -122.24, "lat": 37.88, "start_minute": 0,
                  "report_minute": 12 }],
  "wind": { "speed_mph": 25, "from_deg": 45, "source": "assumed", "label": "Assumed 25 mph NE" },
  "moisture": { "preset": "dry", "label": "Dry fuels",
    "values": { "dead1h": 0.03, "dead10h": 0.04, "dead100h": 0.05, "liveHerb": 0.3, "liveWoody": 0.6 } },
  "horizon_minutes": 360,
  "weather_series": { "source": "historical_replay ONOC1", "evidence": "observed",
    "samples": [{ "minute": 0, "wind_speed_mph": 8, "wind_from_deg": 22, "moisture": null },
                { "minute": 60, "wind_speed_mph": 11, "wind_from_deg": 30, "moisture": null }] } }
```

Limits: 1 to 5 ignitions with unique ids, finite WGS84 `lon`/`lat`, integer `start_minute` 0 to
`horizon_minutes`, optional `report_minute` (the minute on the same Studio clock the fire is
reported to dispatch, set by the Studio user: an integer from `start_minute` to 1440, or `null`
/ absent when not set, so Live models its own report delay), horizon 1 to 1440, wind speed 0 to 60 mph, `from_deg` 0 to 360, moisture values
finite 0.01 to 3, strings capped (`name` 80). `weather_series` is optional (`null` / absent: the
run had one constant wind): 1 to 433 samples in strictly ascending `minute` (Studio clock, -4320 to
4320, may be fractional), wind 0 to 120 mph, `from_deg` 0 to 360, `moisture` `null` (the publish's
`moisture` applies) or the five values as above. Errors are `400 {error: "invalid_studio_fire", detail}`.
The fire is stamped with the active incident; `outside_drill` lists ignition ids more than 3 km
outside the bounding box of the drill's zones. Stored in `live_studio_fires`. Answers `201`:

```json
{ "fire_id": "sf_0a1b2c3d4e5f", "incident_id": "pkg-example", "incident_name": "Berkeley Hills",
  "published_at": "2026-10-24T18:00:00Z", "outside_drill": [],
  "cleared": { "publishes": 1, "run_state": true, "guidance_withdrawn": 3, "road_closures": 0 } }
```

**A new Studio run replaces the drill state.** Studio is the source of truth for the Live board, so
each publish clears what the previous run left for that incident (`studio_fires._replace_previous_run`):
the older publishes (`live_studio_fires` keeps only the new one), the board's run state and household
states (`run_state.forget`, which also frees the single-writer lease for the new board's console),
the previous board run's resident guidance (withdrawn at once with new `live_guidance` versions at
level `none`, reason "The simulated board restarted", so phones do not keep its orders) and the
controller's road closures (`live_road_closures`; a new scenario is a clean drill). The audit log
(`live_decisions`, guidance history) is kept for the AAR; the Live activity feed shows only drill
decisions logged from the run's `published_at` on. `cleared` gives the count per step (`null` = that
step failed and was logged; the publish still stands). The Live board then restarts on the new run
alone at T+0 (`useCommandBoard.ts`; a console still running the old board may save it once more in the
seconds before it polls the feed, and its next save of the new run takes over again). Generating a
scenario in Studio, or a new shared-world seed, does not touch the Live board: only a publish does.

`GET /api/live/incidents/{id}/studio-fires[?after=<ISO Z>]` (any live role) answers
`{fires: [{fire_id, published_at, incident_id, name, scenario_id, region_id, ignitions, wind,
moisture, horizon_minutes, outside_drill}], evidence_class: "simulated"}`, newest first, at most 10.
Every ignition carries `report_minute` (`null` when not set, including fires stored before the
field existed).

`wind` is the run's constant wind (mph, bearing FROM, degrees true), or, for a run on an hourly
series with no weather record (a random scenario), the series' peak hour within the run. With
`weather_series` the Live board follows the series instead, read exactly as Studio's solver and
diorama read it (`fire/weatherSeries.ts` `weatherAtStep` at the same Studio minute, 10-minute steps),
re-solving at each new step; `wind` is then only the summary in labels. GET returns
`weather_series` (`null` for fires published before the field existed). `source` is `assumed` (set by hand), `historical`, `forecast`,
`worst_case` (climatology percentile) or `climatology` (a series' climatology analog); `label`
names it. On the board (`model.ts` `ingestStudioFire`) an ignition whose `id` is already a board
fire on the same landscape cell (burning, contained or waiting to start) is not started again:
a Studio rerun, or another Studio tab synced to the same shared world, republishes it. That
publish's wind and moisture still apply.

## Road closures

The controller closes drill roads on the Live map for the simulated command board (a drill
action, labelled "Closed (drill)"). Every router of the board then avoids them: zone routes
(`POST /api/demo/routes`) and unit legs (`POST /api/demo/crew_routes`) pass the closed segments to
`livecore.routing` / `livecore.inbound` as blocked segments (both directions) and echo the set
they used as `closed_segment_ids` plus `closures_status` (`ok`, or `unavailable` when MongoDB did
not answer). It does not touch the live drill's road reports, road state or phone guidance.
Code: `api/live/road_closures.py`; board side `app/src/demo/roadClosures.ts`
([command-demo-realism.md, Road closures](command-demo-realism.md#road-closures)).

- `GET incidents/{id}/road-closures` (any live role): `{closures: [{segment_id, name, line,
  closed_at, board_minute, by, evidence_class: "drill"}], evidence_class: "drill"}`, oldest
  first. `line` is the drill segment, WGS84 `[lon, lat]`; `board_minute` the closing console's
  board minute (or `null`); `by` is `controller` or the `agent:<name>` of
  [Actor attribution](#actor-attribution).
- `GET incidents/{id}/road-closures?near=<lon>,<lat>` (any live role): the drill segment nearest
  the point within 75 m, `{segment: {segment_id, name, line, distance_m, closed}}` or
  `{segment: null}`. Nothing stored (the confirm panel's preview).
- `POST incidents/{id}/road-closures` (controller) `{"segment_id": "s22", "board_minute": 12}`:
  `201 {closure, created: true}`, or `200 {closure, created: false}` when already closed.
  `400 invalid_road_closure` for a segment not in the drill; `409 too_many_closures` past 20.
- `DELETE incidents/{id}/road-closures/{segment_id}` (controller): reopens it,
  `{reopened: segment_id}`; `404` when it is not closed.

Stored in `live_road_closures`: one small document per closed segment `{incident_id, segment_id,
name, closed_at, board_minute, by}` (unique on incident and segment; deleted on reopen). The
routers re-read it at most every 2 s per process.

## Run state

The Live board simulation runs in the controller's browser (`app/src/demo/model.ts`). It is zone and
cohort based, and while it runs it saves the current state of its run to MongoDB, so the map can
show which houses are safe. Everything here is simulated (`evidence_class: "simulated"`). The
per-household states are a **deterministic stand-in allocation** of the board's zone counts to the
resource snapshot's households (see [scenario-snapshots.md](scenario-snapshots.md)). The board knows
how many households of a zone are safe, not which ones, so any single house's status is an
allocation, not an observation. Label it that way in the UI. Code: `api/live/run_state.py` (storage,
endpoints) and `livecore/household_states.py` (pure allocation).

Household statuses: `home` (no order in effect), `waiting` (ordered or scheduled, not left yet),
`evacuating` (on the road), `safe` (arrived), `needs_transport` (no vehicle, still home in an
ordered or threatened zone), `not_leaving` (ordered, did not comply), `caught` (home when fire
overran the zone), `unknown`.

**`PUT incidents/{id}/run-state`** (controller). The body can be up to 1 MB, with at most 2000 zones:

```json
{ "run_id": "board-6mxw7w-c7f48805", "previous_run_id": null, "board_minute": 42.5,
  "zones": [{ "zone_id": "Z01",
              "households": { "home": 60, "waiting": 20, "evacuating": 15, "safe": 12, "needs_transport": 9 },
              "people": { "home": 150, "waiting": 50, "evacuating": 37, "safe": 30, "needs_transport": 25 },
              "order": { "status": "leaving", "start_minute": 30, "destination_id": "dest-1" } }],
  "totals": { "households": { "home": 60, "waiting": 20, "evacuating": 15, "safe": 12, "needs_transport": 9 },
              "people": null } }
```

Rules:

- **Fields.** `run_id` is a string of at most 80 characters. `board_minute` is a number `>= 0`, in
  board minutes. Every count is a non-negative integer keyed by a status. `people` is `null` when
  unknown. `order.status` is one of `none|scheduled|leaving|done|overrun|lifted`. `start_minute` and
  `destination_id` may be `null`. Optional, for resident guidance
  ([Guidance from the Live board's orders](#guidance-from-the-live-boards-orders)):
  `order.route` `{via: [road names, at most 5], eta_min, distance_m, safety:
  clear|passes_near_fire|passes_fire, line: [[lon, lat], ...] (2..400 points)}` or `null`, and
  `order.issued_by` `ai_agent|controller|null`. `route` is not stored in the run document.
- **Errors.** A bad field returns `400 invalid_run_state` with a `detail`.
- **Storage.** The body is stored as the incident's one `live_run_state` document:
  `{_id: incident_id, incident_id, run_id, board_minute, zones, totals, updated_at, evidence_class}`.
- **Single writer.** Every open console runs its own board. A PUT with a different `run_id` from the
  stored one is accepted only in two cases. The first is when `previous_run_id` equals the stored
  `run_id` (the same console after a reset or restart). The second is when the stored document
  has not been updated for `STALE_WRITER_S` = 30 s. **ASSUMPTION:** a console that has not saved for
  30 s is closed or idle. Otherwise the PUT returns `409 {error: "run_state_owned", detail, run_id,
  board_minute, updated_at}`, describing the owner. PUTs for the same run are always accepted.
- **New run.** When an accepted PUT starts a different run, the previous run's household states are
  deleted first. Run and household state of incidents the live API no longer serves (anything but
  Camp and the active incident) is deleted too.
- **Response.** The answer is `{run_id, board_minute, households_written, households_changed,
  households_pending, materialization, snapshot, guidance_published}` (`guidance_published`: guidance
  versions this PUT published from the board's orders; `null` when publishing failed, which never
  fails the PUT). Writing to Atlas is slow, so a background thread does it for each incident. The
  writer is paced so the console's polls keep working: the free tier moves about 100 KB/s for the
  whole API, and a writer going flat out made every other query wait about a second (`command`
  polls took 10 to 15 s and /live showed OFFLINE, measured 2026-10-25). After each batch the writer
  pauses twice as long as the batch took, and only one batch runs at a time across incidents
  (`run_state.py` `_pace`, `PACE_FACTOR`). That is about 75 household documents a second, so a run's
  first 20k take about 4.5 min.
  It always applies the newest PUT. The PUT waits up to 5 s for it. `materialization` is one of:
  - `done`: everything is written.
  - `writing`: `households_pending` documents are still to write.
  - `loading`: the snapshot households or the stored states are still being read (paced too), which
    takes about 80 s for 20k households after a backend restart. `households_changed` and `households_pending` are `null` while
    loading.
  - `no_snapshot`: only the summary is stored.

  Don't overlap PUTs; one every few seconds is fine. A PUT whose counts did not change (the console's
  20 s heartbeat) only replaces the run document: no household is rewritten. The writer lives in the
  backend process, so after a restart the next PUT reloads the stored states and finishes the writes.

**Materialization** (`livecore.household_states.assign_zone`, one zone at a time):

1. **Scale.** If the board's zone total differs from the snapshot zone's household count, the
   status counts are scaled to the snapshot count with largest-remainder rounding (ties go in
   status-enum order). The assigned total always equals the snapshot zone's households. A zone with
   a board total of 0, or a snapshot zone missing from the PUT, is all `unknown`. A zone in the PUT
   but not in the snapshot is ignored.
2. **Side statuses.** `needs_transport`, `not_leaving`, `caught` and `unknown` are sticky: holders
   keep them while the count allows, and surplus holders are released first in, first out.
   `needs_transport` is filled with carless households (snapshot `vehicles == 0`) first and releases
   households with a vehicle first. `caught` takes households just released from
   `needs_transport` or `not_leaving` first, then the least advanced.
3. **Chain.** The remaining households are sorted most advanced first along
   `home → waiting → evacuating → safe`. Within a status the order is first in, first out: the
   board minute the household entered the status, then a stable hash of `(run_id, household_id)`,
   so each run shuffles differently and the same run is stable. The sorted list is then sliced by
   the counts. When the board's counts only move forward, each household moves forward or stays,
   never back. Exactly the board's flows change, which is the fewest changes such a slicing allows:
   a household changes when a cumulative boundary (at least waiting, at least evacuating, safe)
   passes it. In the verification PUT, 5,615 of 19,913 Camp households changed, which equals the
   boundary shifts, and none moved backward.

One `live_household_state` document per snapshot household, with short keys to fit the free tier
(the API maps them back to the names below):

```
{_id: "<incident_id>:<household_id>", z: zone_id, x: lon, y: lat, o: occupants, v: vehicles,
 s: status, m: since_minute, u: updated_at}
```

- `m` (`since_minute`) is the board minute the household entered its status.
- `z`, `x`, `y`, `o` and `v` are copied from the snapshot when the document is created, so reads
  need no join.
- There is no run id per document: the documents are the run of the incident's `live_run_state`
  (a new run deletes the previous run's documents before writing its own). The incident and the
  household id are the two halves of `_id`.
- Only changed documents are written, in unordered batches of 250. A new run deletes the previous
  run's documents in paced batches of 1000.
- One index besides `_id`: `u` (for `changed_since`), created best effort. Incident, status and zone
  filters run on the `_id` prefix range (at most one snapshot's households). The writer deletes
  documents of the older long-keyed format when it reloads an incident and rewrites them.

**`GET incidents/{id}/run-state`** (any role) returns the stored document (`updated_at` in ISO Z),
or `404 not_found` "No run state yet."

**`GET incidents/{id}/household-state`** (any role) takes optional query parameters:
`after=<household_id>`, `limit=1..5000` (default 5000), `status=<status>`, `zone_id=<zone>` and
`changed_since=<ISO Z>`. The response:

```json
{ "incident_id": "camp-2018-drill", "run_id": "board-…", "board_minute": 42.5, "snapshot": true,
  "households": [{ "household_id": "hh_0004e58c8537500e", "zone_id": "bg:060070018001",
                   "lon": -121.592496, "lat": 39.791378, "status": "needs_transport",
                   "since_minute": 30.0, "occupants": 1, "vehicles": 0 }],
  "next": "hh_0004e58c8537500e", "as_of": "2026-10-25T06:02:44Z", "households_pending": 0,
  "evidence_class": "simulated" }
```

- **Paging.** Results are ordered by `household_id`; pass `next` as `after` until it is `null`. For a
  moment after a new run starts the previous run's documents can still be listed under the new
  `run_id`, until the writer has deleted them.
- **Incremental polling.** Pass the previous response's `as_of` as `changed_since`. `as_of` lags the
  server clock by 30 s so a batch in flight is not missed, so expect a few repeats and treat them as
  idempotent.
- **`households_pending`.** The number of documents this backend process still has to write, or
  `null` when it does not know. While it is above 0, the map is mid-update.
- **No snapshot.** Without a snapshot the response has `snapshot: false`, `households: []` and a
  `reason`. Households are never invented. A full 20k read takes about 4 pages, each up to around
  10 s on the free tier.

**`DELETE incidents/{id}/run-state?run_id=<run>`** (controller, called by "Reset board") deletes the
run document and all of the incident's household states, then returns `{deleted_households: n}`.

- `run_id` is required (`400` without it).
- A different, fresh owner gets `409 run_state_owned`, as for PUT.
- A drill reset (`POST incidents/{id}/drill` `reset`) also deletes the current run's state, in the
  background.

**Storage budget.** Measured on Atlas (2026-10-25) for Camp, 19,913 households, before and after
the short-key change. Index sizes are what `collStats` reports (file sizes), scaled to 20k from the
collection totals, which also held the active incident's households:

| Item | Long keys, 3 extra indexes (before) | Short keys, `u` index only (now) |
| --- | --- | --- |
| Average household document | 293 B | 138 B |
| Data per 20k households | 5.8 MB | 2.8 MB |
| `_id` index per 20k | 2.4 MB | about 2.4 MB (4.4 MB after the test churn below) |
| Other indexes per 20k | 8.7 MB (`updated_at`, `zone_id`, `status`) | 0.2 MB (`u`, freshly built) |
| Data plus indexes per 20k | about 17 MB | about 5.4 MB |
| Run document (43 zones) | 8.9 KB | 8.9 KB |

Index and collection files keep their high-water size: every status change rewrites a `u` key, and
after six full test runs the `u` index reported 10.5 MB until it was rebuilt (0.18 MB). WiredTiger
reuses freed pages, so this should level off rather than grow per run, but that was not measured
over a long drill; dropping and recreating `u_1` is cheap if it does grow (Atlas M0 refuses
`compact`). Only the current run of at most two incidents (Camp and the active incident) is kept.
Nothing keeps history.

## Endpoint summary (v2 additions)

| Method and path | Role |
| --- | --- |
| `GET /api/live/active` | none ([Active incident](#active-incident-adr-0047)) |
| `POST /api/live/active` | controller |
| `GET incidents/{id}/situation[?zones=0]` | any |
| `POST incidents/{id}/checkins` | any |
| `POST me/location`, `DELETE me/location`, `POST me/profile` | civilian, responder |
| `GET participants` | controller |
| `POST me/destination` | civilian, responder |
| `POST tasks/{id}` with `accepted` | responder |
| `POST tasks/{id}` with `done` (assist tasks) | responder, controller |
| `POST checkins/{id}/help` | controller |
| `GET incidents/{id}/command` | controller |
| `POST incidents/{id}/replan` | controller |
| `POST proposals/{id}/approve`, `POST proposals/{id}/reject` | controller |
| `POST incidents/{id}/drill` | controller |
| `GET incidents/{id}/events?since=` | controller ([Event stream](#event-stream)) |
| `GET`, `POST`, `DELETE incidents/{id}/injects[/{inject_id}]` | controller ([Injects](#injects)) |
| `PATCH`, `DELETE me/reports/{id}` | any, owner ([Edit or withdraw](#edit-or-withdraw-your-own-report)) |
| `GET incidents/{id}/twin` | controller ([twin-api.md](twin-api.md#http-adapter-live-drill-appbackendapilivetwin_servicepy)) |
| `POST incidents/{id}/twin/whatif` | controller |
| `GET`, `POST`, `DELETE incidents/{id}/virtual-people` | controller ([app-integration.md, Simulated people](app-integration.md#simulated-people)) |
| `POST incidents/{id}/impact` | controller ([Impact analysis](#impact-analysis)) |
| `GET incidents/{id}/aar` | controller ([After-action report](#after-action-report)) |
| `POST /api/live/studio-fires` | controller ([Studio fires](#studio-fires)) |
| `GET incidents/{id}/studio-fires[?after=]` | any |
| `PUT`, `DELETE incidents/{id}/run-state` | controller ([Run state](#run-state)) |
| `GET incidents/{id}/run-state`, `GET incidents/{id}/household-state` | any |
| `GET incidents/{id}/road-closures[?near=]` | any ([Road closures](#road-closures)) |
| `POST incidents/{id}/road-closures`, `DELETE incidents/{id}/road-closures/{segment_id}` | controller |
| `GET incidents/{id}/board` | any ([Task board](#task-board-passive-observations-and-information-priority-adr-0041)) |
| `POST incidents/{id}/voice` | any ([Voice mode](#voice-mode)); with `"stream": true` it answers NDJSON ([Streaming voice](#streaming-voice-token-endpoint-and-ndjson-replies)) |
| `POST incidents/{id}/voice/token` | any (a 300 s Cartesia token with `stt` and `tts` grants; 6 per minute per device) |

## Location (v2)

Unchanged for civilians: the zone is found on the device; position leaves the
phone only inside a report, a prompts query, a route request, or a `need_help`
check-in. Voice mode ([above](#voice-mode)) sends no position. Board questions (ADR 0041) are picked on the device; a board answer carries the
question's place, and a passive report carries no position at all. Responders who turn on sharing send their latest position while the app
is in the foreground; the server keeps only that one position, for 15 minutes.

## MongoDB plan

All live data goes through `api/mongodb.py` `get_database()` (ADR 0008). Documents
store times as BSON dates (UTC) and coordinates as `[lon, lat]`; the API renders
ISO 8601 `Z`. Ids are prefixed strings (`rpt_`, `tsk_`, `prp_`, `chk_`, `dev_`,
`rsp_`) generated by the server; `_id` is never exposed.

| Collection | One document per | Key fields | Indexes |
| --- | --- | --- | --- |
| `live_devices` | issued token (civilian or responder) | `token_hash` (SHA-256), `role`, `party_key`, `incident_id`, `created_at`, `last_seen_at`, `expires_at` | `token_hash` unique; `party_key`; TTL on `expires_at` (`expireAfterSeconds: 0`; civilian 30 days after last seen, responder 24 h) |
| `live_reports` | report | v1 document + `replay_at`, server-maintained `updated_at` (cursor), `edited_at` (date or null), `withdrawn_at` (date or null), `revisions` (array); `status` includes `withdrawn` | `{incident_id, client_id}` unique (client_id stored lowercased); `{incident_id, received_at}`; `{incident_id, updated_at}` (the `since` cursor); `{reporter.party_key, received_at}`; `id` unique; 2dsphere on `location.coord` (optional; P0 filters in Python) |
| `live_tasks` | task | v1 + `assignee`, `accepted_at`; board questions add `created_by`, `question`, `place`, `place_id`, `expires_at`, `priority` (ADR 0041) | `id` unique; `{incident_id, status}`; `{assignee, status}`; `{incident_id, created_by, status}` |
| `live_injects` | drill inject ([Injects](#injects)) | `id`, `incident_id`, `type`, `params`, `at`, `status`, `actor`, `created_at` | `id` unique; `{incident_id, at}` |
| `live_decisions` | audit entry (append only) | `incident_id`, `at`, `actor`, `action`, `report_ids`, `proposal_id`, `note` | `{incident_id, at}` |
| `live_drills` | incident | see [Drill clock](#drill-clock) | `incident_id` unique |
| `live_guidance` | zone guidance version (append only; only the derived `route.safety`, `caveat`, `alternatives` of the current version are rewritten by a replan) | `ZoneGuidance` + `incident_id` | `{incident_id, zone_id, version}` unique; `{incident_id, published_at}` |
| `live_proposals` | proposal | `Proposal` | `id` unique; `{incident_id, status, created_at}` |
| `live_checkins` | party per incident (latest only) | `CheckIn` + `incident_id`, `party_key` | `{incident_id, party_key}` unique; `{incident_id, zone_id, status}` |
| `live_destination_choices` | device per incident and zone (latest only) | `incident_id`, `party_key`, `zone_id`, `destination_id`, `guidance_version`, `at`, `expires_at`; no location | `{incident_id, party_key, zone_id}` unique; `{incident_id, zone_id, destination_id}`; TTL on `expires_at` (`at + 2 h`) |
| `live_board` | incident (latest only) | `incident_id`, `computed_at`, `replay_at`, `arrivals_source`, `items` (ranked priority places; no people data) | `incident_id` unique |
| `live_responder_locations` | responder (latest only) | `incident_id`, `party_key`, `coord`, `accuracy_m`, `at`, `expires_at` | `{incident_id, party_key}` unique; TTL on `expires_at` (`at + 900 s`) |
| `sim_truth` | generated event per incident (hidden ground truth, ADR 0042) | `incident_id`, `event_id` (the report's `client_id`, or `truth_change:<id>`), `true`, `kind_of_noise`, `source_event_id`, `notes`, `entry` (the full `sim/gen_noise.py` truth entry), `profile`, `seed`, `written_at` | `{incident_id, event_id}` unique. Read only by the AAR's `triage_quality` after the drill; never served |

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
