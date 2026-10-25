# App integration (`/app-integration`)

The phone app inside the **server-side live drill**: the incident of `GET /api/live/active` (default
`camp-2018-drill`), with its drill clock, zones, guidance, reports, check-ins, help requests, traffic twin
and people estimate, in real time. It is separate from the browser-side simulated board inside `/live`
(`app/src/demo`), which this tab does not use.

Everything here is a labelled drill. Simulated people and the population estimate are simulated; real
phones are drill participants. Nothing is sent outside the drill.

## Tab

Code: `app/src/appint/` (class prefix `aix-`). Sidebar entry "App integration" after "Live command".

| Part | What it shows | Data |
| --- | --- | --- |
| Header | Drill time, speed (Pause, Real time, ×5, ×20), **Invite phones** | `command.drill`; `POST incidents/{id}/drill` (`start` from the current drill time, or `set_speed`) |
| Stats | Everyone else: still at home, driving out, in traffic, stuck, safely out (one "Loading the traffic model…" tile until the first estimate; later 429s keep the last values); on our app: joined real phones and simulated people | `GET incidents/{id}/people` (simulated) minus our app residents (below); `participants.counts` |
| On our app | Every simulated person and every real phone heard from in the last 60 min (wall time): name, plain status line, up to two flag chips. Older real phones sit in a collapsed "Older phones (N)" list with "Last seen" and count nowhere else (tile, map, Needs your OK, real-time rule); **+ Add a simulated person** | `GET incidents/{id}/participants`; `POST incidents/{id}/virtual-people` `{count: 1, seed}` |
| Map | Zones with their guidance (LEAVE NOW / GET READY), the drill fire estimate, closed roads, the people layer ("everyone else": homes, cars on the roads, queues, stuck clusters, arrivals), our app users as dots, and the selected person's route | `command` (zones, guidance, fire, public items), `people` (`app/src/live/people`), `participants` |
| Needs your OK | Pending proposals as plain sentences ("Tell Tract 9, BG 1 to leave now", "Send 3 zones a new way out") with how many people and app users they reach: **Send** / **Don't send**. Open help requests: **Send a responder** / **Tell them we got it** | `command.proposals` (`POST proposals/{id}/approve`, `.../reject`); `command.checkins.need_help` (`POST checkins/{id}/help` `assign` with any responder, or `acknowledge`) |
| Messages | One timeline: "To Tract 16, BG 3: leave now", "From Ana: heavy traffic on Severns Lane", "To Chloe: we got your request", "Not sent: ..." | `participants.messages` |
| What *name* sees | One line about the person (real or simulated, zone, status; simulated people's own story) and a phone-frame mirror of their current screen | `PhoneMirror` (`app/src/appint/PhoneMirror.tsx`, props `{incidentId, participantId}`; owned by the phone-view work) |
| What simulated people did | Simulated households by headline behaviour: followed the order, left late, took a different road, went back home, stayed home, waited to see the fire, drove toward the fire | `participants[].behaviour.choices` (below) |

Map marks: solid blue dot = real phone, hollow dot = simulated person, square = responder, larger with an amber
ring = selected. Real phones are labelled with their name; simulated ones only when selected. Clicking a dot
selects that person; the list is a listbox (arrow keys move the selection).

**Real time rule.** A real phone counts as joined while it was heard from in the last 60 min
(`last_seen`). While one is joined the speed-ups are disabled, and if the drill is running faster than ×1 the
tab sets it back to ×1 once (`set_speed 1`) and says so. With no real phone joined the tab says a practice
speed-up is allowed.

**No double counting.** The people estimate covers every resident, and our app residents are among them.
For each app participant with role `resident` the tab picks the one people state it is in from its status
and flags (`out`: "out", "safe", "arrived"; `stuck`: flag Stuck, "stuck", "turned back", "blocked";
`queued`: flag Slowed, "traffic", "slow"; `driving`: "driv", "leaving", "on the way", "heading"; else
`home`), takes one person out of that state's total (never below 0) and draws them as their own dot. The
stats tiles show these "everyone else" numbers (`plain.ts` `everyoneElse`). The map's people layer still
draws the estimate as served; at Camp scale (48,088 residents) one person per dot is far below one dot of
the layer (2-200 people). Responders and observers are not residents and are not subtracted.

**Behaviour headline** (`plain.ts` `behaviourOf`), one per simulated household from its drawn
`sim/behavior.py` `HouseholdChoices`, first match wins: `protective_action` stay_and_defend or
shelter_in_place → stayed home; wait_and_see → waited to see the fire; `pickup_trip` → drove toward the
fire; any `trip_before_leaving` → went back home; `reroutes_in_congestion` → took a different road;
`milling` or `departure_delay_min` ≥ 60 → left late; else followed the order. Without choices it uses the
flags.

States: loading, empty ("Nobody yet" with Invite phones), unreachable (Retry), not the controller (open
Live command once for the token form), people estimate warming ("…" tiles), simulated people not
available on this server ("+ Add" answers 404).

### Start it

Same as `/live`: a backend with `LIVE_CONTROLLER_TOKEN` and `LIVE_INVITE_CODE`, and Vite (the dev proxy
signs controller calls). Open `http://localhost:5173/app-integration`. A headless check on other ports:

```sh
# backend on 8096 against a copy of the dev database
MONGODB_URI=mongodb://127.0.0.1:27017 MONGODB_DATABASE=<copy> LIVE_CONTROLLER_TOKEN=dev-controller \
  LIVE_INVITE_CODE=DRILL python manage.py runserver 127.0.0.1:8096 --noreload
# Vite on 5185 proxying to it
cd app && VITE_API_PROXY_TARGET=http://127.0.0.1:8096 LIVE_CONTROLLER_TOKEN=dev-controller \
  npx vite --port 5185 --strictPort
```

A "real phone" from the shell (what the iOS app does):

```sh
B=http://127.0.0.1:8096/api/live
T=$(curl -s -X POST $B/devices -H 'Content-Type: application/json' -d '{}' | jq -r .token)
curl -X POST $B/me/profile -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"name":"Ana","kind":"resident"}'
curl -X POST $B/me/location -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"coord":[-121.5985,39.7795]}'
curl -X POST $B/incidents/camp-2018-drill/checkins -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"status":"staying","zone_id":"bg:060070017041"}'
# a responder joins with the invite code instead: POST $B/incidents/camp-2018-drill/join {"invite_code":"DRILL"}
```

## Participants API

`GET /api/live/incidents/{id}/participants` (controller; `app/backend/api/live/participants.py`
`incident_participants`). Polled every 3 s by the tab. It sits beside the raw device list
`GET /api/live/participants` (docs/live-reports.md "Phone location, name and kind"), which it does not
change.

```jsonc
{ "incident_id": "camp-2018-drill",
  "now": "2026-10-25T03:20:50Z",            // wall time of the read
  "replay_now": "2018-11-09T03:04:51Z",     // drill time (additive)
  "participants": [
    { "id": "dev_1a2b3c4d5e6f7a8b",          // party_key; the phone-view endpoint takes this id
      "kind": "real",                        // real | simulated
      "role": "resident",                    // resident | responder | observer
      "name": "Ana",                         // me/profile name, else "Phone 7A8B" / "Responder 7A8B"
      "zone_id": "bg:060070017041",          // check-in zone, else destination-choice zone, else zone at position
      "position": [-121.5985, 39.7795],      // [lon, lat] or null
      "position_source": "gps",              // gps | estimated | null
      "status": "Staying home, told to leave, fire is close",
      "flags": ["Not leaving", "In danger"],
      "last_seen": "2026-10-25T03:20:47Z",
      "behaviour": null,                     // simulated only: {"narrative": [str], "choices": {...}}
      "evidence_class": "field_report" } ],  // field_report (real) | simulated
  "counts": { "real": 3, "simulated": 0, "by_role": { "resident": 2, "responder": 1, "observer": 0 } },
  "messages": [                              // additive; newest first, at most 60
    { "at": "2026-10-25T03:20:47Z", "replay_at": "2018-11-09T03:04:48Z", "direction": "from",
      "text": "From Ana: heavy traffic on Severns Lane", "participant_id": "dev_1a2b...", "kind": "real" } ] }
```

Flags come from: Stuck, Needs help, Late, Different road, Went back, Not leaving, In danger, Toward fire,
Slowed.

**Who is a real participant.** A device that is not `simulated`, not expired, and either a responder that
joined this incident or a civilian (civilian tokens are not bound to an incident), with any of: a check-in
here (deleted on drill reset), a destination choice here (2 h TTL), a field report here in the last 2 h, a
responder location here, or seen in the last hour (`ACTIVE_WINDOW`) while this incident is the active one.
Ordered by `last_seen`, newest first.

**Position** (real): the device's `me/location` fix (kept on `live_devices.location`; a stale fix is still
shown and `last_seen` says how old), else the responder location table, else the `need_help` check-in
point, else the location of a report sent in the last 20 min. All `gps`.

**Role**: the `me/profile` kind (`firefighter` → `responder`, `resident`, `observer`), else the token role
(responder token → `responder`, civilian → `resident`).

**Status and flags** (real; constants in `participants.py`):

| Who | Status | Flags |
| --- | --- | --- |
| Resident checked in `out` | Safely out | — |
| `need_help` | Asked for help (, request seen / , a responder is on the way); "Was helped" once resolved | Needs help (until resolved) |
| `staying` | Staying home (, told to leave when the zone is `evacuate_now`) | Not leaving (when told to leave) |
| No check-in, a road report in the last 10 min | Reported heavy traffic / road blocked on *road* | Slowed / Stuck |
| Otherwise | Told to leave now / Told to get ready / No order yet (the zone's published guidance) | — |
| Any resident not `out` | | Late: zone ordered `evacuate_now` 30+ drill min ago and the phone is not known to be outside the zone. In danger: within 500 m of the fire estimate (", fire is close") |
| Responder | Available / Asked to help a resident / Going to help a resident / Checking *road* | — |
| Observer | Watching | — |

**Simulated participants**: the simulated households of `virtual_people.list_participants(incident_id)`
(the driver module; this endpoint passes their fields through, forces `kind: simulated` and
`evidence_class: simulated`, and keeps only known flags; empty until that module exists), plus simulated
responder units that share a location (`live_sim_responders`): "Simulated unit N", `position_source:
estimated`, status from their tasks.

**Messages**: to phones, each guidance publish grouped by second and change ("leave now", "get ready to
leave", "no order now", or "new way out" when a zone's level is unchanged; with the road and destination
for a single zone); proposals the controller rejected ("Not sent: ..."); assignments to participant
responders; the controller's answer to a participant's help request. From phones: each participant's
latest check-in and their reports (not passive ones). Times: wall `at` and drill `replay_at`; the tab
shows drill time (UTC).

Errors: the live API's (`401`/`403` not the controller, `404` unknown incident, `503` store unavailable).

## Phone mirror

The controller can see what one participant's iOS app shows right now. The backend builds
the view from the same data the phone reads (the `situation` guidance, fire estimate,
check-in, tasks, the person's destination pick and stored location) and the copy of the
SwiftUI screens (`GuidanceSheet`, `CheckInButtons`, `HomeHero`, `TasksView`). Nothing is
written and no number is invented: routes and ETAs are the published guidance, the fire
distance is measured to the current fire estimate.

`GET /api/live/incidents/<incident_id>/participants/<participant_id>/phone-view`
(controller role only; `Cache-Control: no-store`). `404 not_found` for an unknown id.

`participant_id` is the `party_key` of a phone (`GET /api/live/participants`; `dev_...`
resident, `rsp_...` responder) or the `id` of a simulated person ([Simulated people](#simulated-people);
it is that person's device `party_key`, `sim_...`). `_virtual_participant` in
`app/backend/api/live/phone_view.py` resolves simulated people first: their stored check-in and
destination pick are read exactly as a phone's, their position is the estimated one, and the view
says `kind: "simulated"`, `position_is: "estimated"` and `evidence_class: "simulated"`.

| Field | Meaning |
|---|---|
| `participant_id`, `name`, `role` (`civilian` / `responder`), `kind` (`phone` / `simulated`) | who |
| `screen` | `guidance` (a zone with an order), `no_order`, `checked_out` ("You're marked out"), `help_requested`, `responder` (task screen), `not_joined` (no place known yet) |
| `headline`, `sub`, `lines[]` | the card text as the app words it: "Via Wilder Drive", "Leave now", "Exit west, 19 min", the server's reason |
| `buttons[]` | `{label, kind: primary / danger / secondary}`; mirrors only, nothing is clickable. The help button follows the controller's handling ("Help requested", "Request seen", "Responder assigned") |
| `zone` | `{id, name}` the phone is in (stored location, else the check-in zone), or `null` |
| `position`, `position_is` | `[lon, lat]`; `device` for a stored location, `estimated` for a simulated person (model estimate), `zone_centre` when only the zone is known (drawn as a dashed marker) |
| `fire_distance_km` | km from `position` to the fire estimate, `0` inside it, `null` when there is no estimate or it is farther than 500 km |
| `route` | `{line: [[lon, lat], ...], destination_name, eta_min}` of the guidance the phone follows (including the person's own destination pick), or `null` |
| `destination_coord` | `[lon, lat]` of that destination |
| `assignment` | responders: `{task_id, kind, status, place, target, note, open_tasks}` for the task the app shows first (accepted, then assigned to this phone, then oldest); otherwise `null` |
| `fire` | `{rings: [[[lon, lat], ...]]}` simplified outer rings of the fire estimate near the person and route, for the map strip |
| `fire_label`, `incident`, `as_of`, `evidence_class` | the fire estimate's label, `{id, name, mode}`, server time, and `reconstructed` / `simulated` / `none` (always `simulated` for a simulated person) |

A responder's `fire_distance_km` is measured from the stored location, else from the task
target. A checked-out person keeps the zone and fire fields but no route.

Example (resident in an `evacuate_now` zone, check-in "staying", route line shortened):

```json
{
  "participant_id": "dev_4441871ce40cff52", "name": null, "role": "civilian", "kind": "phone",
  "screen": "guidance", "headline": "Via Wilder Drive", "sub": "Leave now",
  "lines": ["Exit west, 19 min", "Fire estimate within 3 km"],
  "buttons": [{"label": "I'm out", "kind": "primary"}, {"label": "Need help", "kind": "danger"}],
  "zone": {"id": "bg:060070016002", "name": "Block Group 2, Census Tract 16"},
  "fire_distance_km": 3.94,
  "position": [-121.70502, 39.76729], "position_is": "zone_centre",
  "route": {"line": [[-121.70647, 39.77889], [-121.70662, 39.77882]], "destination_name": "Exit west", "eta_min": 19},
  "destination_coord": [-121.9006248, 39.7947781],
  "assignment": null, "fire": {"rings": [[[-121.6, 39.8], [-121.61, 39.81]]]},
  "fire_label": "Satellite perimeter, 20:00 drill time",
  "incident": {"id": "camp-2018-drill", "name": "Camp Fire 2018 exercise", "mode": "exercise"},
  "as_of": "2026-10-25T03:13:21Z", "evidence_class": "reconstructed"
}
```

Frontend: `<PhoneMirror incidentId participantId />` in `app/src/appint/PhoneMirror.tsx`
(CSS prefix `pmr-`). It polls every 3 s with the controller token the console uses, draws a
240 by 480 phone with a map strip (fire estimate, the person, the route), the guidance card
and the buttons as non-interactive mirrors, and a plain-language line and evidence tag
beneath. It has loading, unknown-participant and error states and keeps the last view while
a poll fails.

## Simulated people

Simulated people ("virtual phones") are synthetic households with the drill app that the server runs
on the drill clock. Each one draws its behaviour from published evidence, sees its zone's published
guidance like a phone, decides per its draws (not 100% obediently), and acts through the same view
functions the phone endpoints run (`checkins`, `incident_reports`, `my_destination`, `my_report`):
same validation, rate limits, comms-outage refusals and storage. What it sends is labelled by its
device flag: reports `evidence_class: "simulated"`, check-ins and destination choices
`simulated: true`, and `command.checkins.need_help[]` items carry `simulated`. Everything about them
is a planning experiment, never observed data.

Code: pure behaviour in `app/backend/livecore/virtual_people.py`; storage, ticking and endpoints in
`app/backend/api/live/virtual_people.py`; collections `live_virtual_people` (one per person) and
`live_virtual_runs` (one per incident: seed, epoch, ticked minute, lease), created by `live_init_db`.

### Endpoints (controller role)

| Method and path | Body | Returns |
| --- | --- | --- |
| `POST /api/live/incidents/<id>/virtual-people` | `{"count": 1-200, "seed"?: int}` | `201 {added, total, seed, label, people: [Participant]}` (the added ones). At most 200 per incident (`400`). The seed is fixed per incident: another seed while people exist is `409` (DELETE first). Default seed 20181108 |
| `GET /api/live/incidents/<id>/virtual-people` | | `200 {incident_id, label, seed, profile, epoch, count, ticked_to, twin, summary: {by_status, by_flag}, people: [Participant]}`. `twin`: `ready`, `unavailable` (warming, failed or busy: people moved at free-flow speed that tick) or `not_needed` |
| `DELETE /api/live/incidents/<id>/virtual-people` | | `200 {removed, reports_withdrawn, reports_kept, checkins_removed, assist_tasks_cancelled}` |

A phone follows one person's route and trail with `GET virtual-people/<person_id>/track`: see
[Follow a simulated person](#follow-a-simulated-person).

**DELETE removes them.** Each person's reports are withdrawn through the owner's withdraw path (status
`withdrawn`, kept for the record, out of every queue); a report a controller or responder already acted
on cannot be withdrawn and stays, labelled simulated (`reports_kept`). Their check-ins are deleted
(open assist tasks for their help requests are cancelled), then their destination choices, devices,
the people and the run.

`list_participants(incident_id) -> list[Participant]` (Python, `api.live.virtual_people`) is what the
participants endpoint merges in; it ticks first. `find_participant(incident_id, id)` returns one.

```jsonc
// Participant
{ "id": "sim_e144199ae870d9a3",            // also the device party_key
  "kind": "simulated", "role": "resident", "name": "Simulated 2",
  "zone_id": "bg:060070022001",
  "position": [-121.60874, 39.56551], "position_source": "estimated",   // [lon, lat], always estimated
  "status": "Driving out, 4 min to go",
  "flags": ["Toward fire"],
  "last_seen": "2026-10-25T03:31:03Z",     // wall time of the tick that last moved it
  "behaviour": {
    "narrative": ["first heard of the fire: online", "checked with others before deciding",
                  "left 24 min after its trigger", "followed a navigation app route", "went to: friends family"],
    "choices": { "protective_action": "evacuate", "departure_trigger": "warning", "departure_delay_min": 24.28,
                 "trip_before_leaving": null, "route_strategy": "navigation", "requests_help": false,
                 // ...every other sim.behavior.HouseholdChoices field
                 "evidence": { "departure_delay_min": ["derived"], "route_strategy": ["assumption"] } } },
  "evidence_class": "simulated" }
```

`narrative` is the household's drawn plan (`HouseholdChoices.narrative()`), not a log of what happened.
`choices.evidence` gives the labels (sourced, derived, assumption) of the parameters behind each choice.

Statuses: `At home`, `Waiting to see` (wait-and-see under an order), `Checking with neighbours`,
`Packing`, `Went back for a pet` / `Picking up family` / `Helping neighbours` / `Went back for
belongings` / `Went back home` (a trip before leaving), `Driving out, N min to go`, `Slow traffic, N min
to go`, `Stuck in traffic, N min`, `Stuck, road closed ahead, N min` (N: minutes stuck so far),
`Staying home`, `Asked for help` / `Asked for help, no car` / `Asked for help, request seen` / `Asked
for help, responder on the way`, `Picked up by responders`, `Safely out`. Flags, in this order:

| Flag | When |
| --- | --- |
| `Stuck` | en route in a long queue or blocked |
| `Needs help` | asked for help and not picked up yet |
| `Late` | still home 60+ min after an evacuate-now order (not staying on purpose) |
| `Different road` | picked, or rerouted to, another offered destination than the recommended one |
| `Went back` | on a trip before leaving |
| `Not leaving` | staying, or waiting to see under an order |
| `In danger` | not out and within 500 m of the fire estimate (or inside it) |
| `Toward fire` | on a trip home with fire within 2 km of home, or driving a route the guidance marks `passes_fire` / `passes_near_fire` |

### Behaviour

- **Population.** Person `n` lives in a zone drawn in proportion to the zones' households (the drill
  bundle's zones, the same block groups as the twin), at a seeded point inside the zone. A household
  has no car with the ACS Butte share 0.0608. Everything is seeded per (seed, person, draw), so the
  same seed gives the same people, homes and choices, and adding people never changes earlier ones.
- **Choices** come from `sim.behavior.draw_household_choices(seed, party_key, "grounded", ...)` (values
  and sources: [people data, Behaviour evidence](people-data.md#behaviour-evidence)): protective action
  (evacuate, wait and see, stay and defend, shelter in place), departure trigger (before any warning,
  on the order, on seeing fire), delay, milling, a trip before leaving and its purpose, route strategy,
  rerouting in congestion, help requests. A second draw with `ordered=False` says whether the household
  leaves on the fire cue without an order (shadow evacuation, 0.291).
- **Each drill minute** a person notices the fire (fire estimate within 8 km of home, or any guidance
  for its zone) and registers its zone's `evacuate_now` order and the fire cue (fire within 2 km). Its
  delay starts when its drawn trigger fires; with fire within 500 m of home every household that would
  ever leave goes within 10 min. Staying households check in `staying` 2-15 min after the order or cue.
  Households that ask for help (no car, or a member who needs assistance) check in `need_help` with
  their home point (rate 2/h after the order or cue) and wait; a resolved request means picked up, out
  30 min later. At departure a person picks a destination among the guidance's offered ones (the
  recommended one, or, with a familiar route, another offered one 40% of the time) and posts it
  (`me/destination`). With no guidance yet it heads for the nearest routable exit in a straight line.
  `fire_seen` reports (30% of people, when the fire cue hits) and `heavy_traffic` / `road_blocked`
  reports (50%, the first time slowed or blocked) go through the report endpoint; 80% check in `out` a
  few minutes after arriving.
- **Movement** (estimated): the home point, then the published route line of the chosen destination
  (simplified to 80 points), at the route's free-flow ETA plus the leg from home at 30 km/h. The speed
  each minute comes from the traffic twin's en-route vehicles of the zone (`vehicle_states`): the
  person's fixed rank in [0, 1) places it among the zone's blocked, long-queued, queued and moving
  shares, which move at 0, 0.1, 0.5 and 1 x free-flow. A household that reroutes in congestion switches
  to another offered destination after 10 min stuck. Without the twin: free-flow.
- Every assumption is a named constant in `livecore/virtual_people.py` with its basis.

### Ticking

`tick(incident_id)` moves every person one drill minute at a time up to the drill clock's current
minute; each person keeps its own `ticked_to`, so a minute is processed once. It runs on each
`GET command` (the console's 5 s poll, on a background thread so the poll never waits; the results
show on the next poll), each `GET virtual-people`, each `list_participants` and
phone-mirror read, and from `manage.py live_virtual_people` for a drill with no console open:

```sh
python manage.py live_virtual_people --incident camp-2018-drill --interval 2   # keep them moving
python manage.py live_virtual_people --add 20 --seed 7 --duration 600          # add 20, tick 10 min
```

A lease on the run document (`lease_until`, 60 s) lets one request tick while concurrent ones return
at once. Guidance is read as it stood at each minute (a version applies from the later of its plan
time and its publish time), and the fire estimate per minute (with fire-jump injects); the twin can
only be read now, so a long catch-up uses the current twin state for every minute. A drill reset,
restart or move back (the clock does not continue the one last ticked under; pause and speed changes
do) puts everyone back home at the new start and bumps `epoch`, which gives their reports new
`client_id`s. Events refused with `429` (rate limit; all simulated phones share one client address) or
`503 no_signal` (comms outage) stay in the person's outbox and are resent on a later tick, as a phone
would.

### Population and double counting

A simulated person is one of the zone's households already in the population estimate, labelled and
followed individually; it adds no one. The twin's demand and the people snapshot (`GET people`) are
unchanged, so nothing is counted twice there, and the person's position is derived from the twin's
zone state, not added to it. The small inconsistency left: the live twin runs the `historical`
behaviour (every household leaves when ordered), so a simulated household that stays, waits or asks
for help is still a departing vehicle in the twin: at most 200 households against Camp's 19,913 (1%).

`GET /api/live/participants` (devices seen in the last hour) also lists their devices, with
`simulated: true`, `name: "Simulated N"` and no location; merge by `party_key` = `id`.

## Live demo data flow

What a phone does reaches the /live AI incident commander, and its decisions reach phones, through
the ordinary live endpoints. Nothing is pushed; every hop is a poll. Latencies are the poll
intervals in code, not measurements; add request time (tens of ms locally).

1. Phone → server. A report (`POST incidents/{id}/reports`, including a Voice-mode report the
   person confirms: `api/live/voice.py` only proposes the action, the phone sends it through the
   same endpoint), a check-in or need_help, or a responder task answer is stored at once.
2. Server → board. /live polls `GET incidents/{id}/command` every 3 s after the previous answer
   (`live/useCommand.ts`); the board (`demo/useCommandBoard.ts`) also polls `.../people` and
   `.../participants` every 3 s. Worst case ≈ 3 s plus request time.
3. Board → commander. `demo/incidentPicture.ts` turns the three polls into
   `observation.incident_picture` (bounded to 14 kB: calls per zone, help requests, recent
   messages with evidence class and status, road reports and road state, check-ins, simulated
   stuck groups and destinations near capacity, no-signal zones, participants with real-phone
   reports flagged). With monitoring on, a new help request, road_blocked report, real-phone
   report or confirmation wakes the commander after a 2 s debounce, at most once per 15 s
   (`demo/useDemoAgent.ts` PICTURE_DEBOUNCE_MS, PICTURE_MIN_GAP_MS). So a phone report reaches
   Claude within about 5 s (up to 15 s right after another picture-triggered call), plus the
   model's own decision time.
4. Commander → live drill. `POST /api/demo/decide` validates every order against the
   observation's ids (`api/demo.py`); the page then runs live actions as the controller
   (`demo/liveOrders.ts`): `send_rescue` assigns the help request's assist task
   (`POST checkins/{id}/help` or `POST incidents/{id}/tasks` kind assist), `close_road` confirms
   the road's open road_blocked report, `reopen_road` resolves its blocked reports,
   `confirm_report` / `dismiss_report` triage (`POST reports/{id}/triage`).
5. Approval → phones. Confirming a road report replans; guidance changes become a proposal a
   person approves on /live before any phone sees them (ADR 0012). `order_evacuation` from the
   commander moves only the simulated board. Phones poll every 3 s (`LiveStore.pollInterval`),
   so an approved change or a new assist task shows on a phone within about 3 s.

## Follow a simulated person

An iPhone joins the drill as a participant and follows one server-side simulated person along their route:
it picks a person (their `id` is the `id` of a `GET homes` entry), says so with `POST me/follow`, and keeps
reading that person's track (position, route, progress, trail, status). /live and /run poll the controller's
list of the people phones follow and draw them on the 3D map. Following changes nothing about the person and
sends nothing to anyone.

Everything served is `evidence_class: "simulated"`: the person is a synthetic household run by the server on
the drill clock, and every position is an estimate along the published route, never an observation.

Code: `app/backend/api/live/follow.py` (the three views); `build_track`, `build_tracks` and `_track` in
`app/backend/api/live/virtual_people.py` (block "follow: the track of one person"); the trail in
`app/backend/livecore/virtual_people.py` (`_trail_add`, `TRAIL_MAX_POINTS`); web `app/src/live/followedPeople.ts`.

### Endpoints

| Method and path | Who | Body | Returns |
| --- | --- | --- | --- |
| `GET /api/live/incidents/<id>/virtual-people/<person_id>/track` | any authenticated role | | `200` the person's track (below). `404 unknown_person` |
| `POST /api/live/me/follow` | civilian or responder device token (a controller gets `403`) | `{"person_id": "<id>" \| null, "incident_id"?: "<id>"}` | `200 {"following": "<id>" \| null}`. `400 invalid_request`, `404 unknown_person` |
| `GET /api/live/incidents/<id>/followed` | controller | | `200 {incident_id, label, evidence_class, total_followers, people: [{person_id, followers, track}]}` |

All three also return the live API's usual `401` (missing or invalid token) and `404 not_found` (unknown
incident); a responder token for another incident gets `403`.

**Track.** Advances the incident's simulated people to the drill clock first, like every other read of
them (see [Ticking](#ticking)), so the track is as of the drill's current minute. `404 unknown_person` when
the incident has no simulated person with that id.

**Follow.** `person_id` is required: a simulated person's id (a string of 1-80 characters) to follow, or
`null` to stop. A missing key, a non-string or an empty or over-long id is `400 invalid_request`; an id
that is not a simulated person of the incident is `404 unknown_person` (so a stale id after the people were
removed fails instead of being kept). The incident is the token's own (a responder's joined incident, else
the active one); `incident_id` names another known incident (`404 not_found` when unknown). The device
follows one person at a time: a new call replaces the old follow. The follow is kept on the device
document (`live_devices.follow`) and also counts as the device being seen.

**Followed.** The controller's list, most followers first (ties by `person_id`), at most 50 people. A follow
counts for 15 minutes after the device was last seen (`FOLLOW_FRESH_FOR` in `follow.py`, ASSUMPTION: three
of the 5 min intervals at which `auth.LAST_SEEN_WRITE_INTERVAL` refreshes a device's `last_seen_at`). The
phone keeps calling the track endpoint while it follows, and that refreshes it; a phone that stops, goes
offline or whose token expires drops out of the list within that time. Following someone who has been removed
leaves them out. `total_followers` is the sum of `followers` over the listed people. The call ticks the
people once for all tracks. `label` is the simulated-people label (as in `GET virtual-people`).

### Track

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | The person's id (also their device `party_key`) |
| `label` | string | The synthetic street address of `GET homes` (made up from the nearest road, e.g. "8940 Lovett Lane", else "Home <n>, <zone>") |
| `phase` | string | Where the person is in their plan, see below |
| `status` | string | Plain-language status line as the participants list shows it ("Driving out, 35 min to go") |
| `flags` | string[] | Flags as the participants list shows them (see [Simulated people](#simulated-people)); may be empty |
| `position` | `[lon, lat]` | WGS84, an estimate: home until the person leaves, then along `path` |
| `path` | `[lon, lat][]` | The stored route polyline, 5 decimals; `[]` before the person leaves (see below) |
| `progress` | number | 0..1, fraction of `path` covered, 3 decimals; `0` without a path |
| `trail` | `{t, coord}[]` | Where the person has been, oldest first; may be empty (see below) |
| `drill` | object | `{now, speed, running}`: the drill clock when the track was built (`now` UTC drill time, `speed` x real time) |
| `evidence_class` | string | Always `"simulated"` |
| `zone` | `{id, name}` or null | The person's home zone (block group); null if unknown |
| `total_min` | number or null | Free-flow minutes of the whole route (1 decimal); null without a path |
| `eta_min` | number or null | Minutes to go at free flow, `(1 - progress) x total_min`; only while `en_route` or once finished driving (`0.0` when arrived), else null. The status line's "N min to go" is this rounded up |
| `destination` | `{id, name, coord}` or null | The chosen destination (an exit or shelter of the guidance, or the nearest exit); null before the person leaves |
| `motion` | string or null | Only while `en_route`: `driving`, `queued`, `long_queue` or `blocked` (the traffic twin's share the person falls into, see [Behaviour](#behaviour)); else null |

`phase` values: `home` (at home, not yet leaving, including "waiting to see"), `packing` (decided to leave,
getting ready or checking with neighbours), `trip` (a trip before leaving: pet, family, neighbours,
belongings; the position stays at home), `en_route` (driving out along `path`), `out` (arrived and safely
out), `staying` (staying home or sheltering), `help` (asked for help and waiting), `picked_up` (picked up by
responders; `out` follows 30 min later, with the position back at home). Only `en_route` people move.

`path` is the route of the destination the person chose when they left: the guidance's published route line
(simplified to 80 points), starting at the home point. When no guidance was published when the person left it
is a straight line from home to the nearest routable exit. It stays as it was until the person reroutes in
congestion, when it becomes the rest of the route to the other destination (and `progress` restarts at 0).

`trail` gets one point per drill minute that the person moves: the first at the door when they leave, then
one per minute along the route. A position equal to the last point (stuck in a queue or blocked) is not
repeated; it is capped at 120 points (`TRAIL_MAX_POINTS`, ASSUMPTION: 2 h of driving), oldest dropped; and it
is cleared when the drill resets or restarts. `t` is UTC drill time to the minute, `coord` is `[lon, lat]`.

A person who has left, on the move:

```json
{"id": "sim_ee29ddf58652b774", "label": "8940 Lovett Lane",
 "zone": {"id": "bg:060070020001", "name": "Block Group 1, Census Tract 20"},
 "phase": "en_route", "status": "Driving out, 35 min to go", "flags": ["In danger"],
 "position": [-121.55653, 39.76774],
 "path": [[-121.56611, 39.76218], [-121.39313, 39.8627]], "progress": 0.055,
 "total_min": 36.1, "eta_min": 34.1,
 "destination": {"id": "exit:osm-node:86441431", "name": "Exit east via Camp Creek Road", "coord": [-121.39313, 39.8627]},
 "motion": "driving",
 "trail": [{"t": "2018-11-08T15:47:00Z", "coord": [-121.56611, 39.76218]},
           {"t": "2018-11-08T15:48:00Z", "coord": [-121.56132, 39.76496]},
           {"t": "2018-11-08T15:49:00Z", "coord": [-121.55653, 39.76774]}],
 "drill": {"now": "2018-11-08T15:49:13Z", "speed": 60.0, "running": true},
 "evidence_class": "simulated"}
```

(Real output of a local scratch drill on the 2018-11-08 replay, with `path` shortened to its two end points.)
A person still at home:

```json
{"id": "sim_48db3ea34b8b4add", "label": "806 Green Ridge Place",
 "zone": {"id": "bg:060070017042", "name": "Block Group 2, Census Tract 17.04"},
 "phase": "home", "status": "At home", "flags": [],
 "position": [-121.59102, 39.87472], "path": [], "progress": 0.0,
 "total_min": null, "eta_min": null, "destination": null, "motion": null,
 "trail": [],
 "drill": {"now": "2018-11-08T15:49:13Z", "speed": 60.0, "running": true},
 "evidence_class": "simulated"}
```

A phone follows, then the controller lists who is followed (`$B` and `$T` as in [Tab](#tab); the controller
token is `$C`):

```sh
curl -X POST $B/me/follow -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"person_id":"sim_ee29ddf58652b774"}'
# {"following": "sim_ee29ddf58652b774"}
curl $B/incidents/camp-2018-drill/virtual-people/sim_ee29ddf58652b774/track -H "Authorization: Bearer $T"   # the track above
curl -X POST $B/me/follow -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"person_id":null}'
# {"following": null}
curl $B/incidents/camp-2018-drill/followed -H "Authorization: Bearer $C"
```

```jsonc
{ "incident_id": "camp-2018-drill",
  "label": "Simulated people ...",           // as GET virtual-people
  "evidence_class": "simulated",
  "total_followers": 2,
  "people": [
    { "person_id": "sim_ee29ddf58652b774",
      "followers": 2,
      "track": { "id": "sim_ee29ddf58652b774", "label": "8940 Lovett Lane", "phase": "en_route" /* ...the track above */ } } ] }
```

**Web.** `useFollowedPeople(incidentId, token)` in `app/src/live/followedPeople.ts` polls `GET followed`
every 3 s (`FOLLOWED_POLL_MS`) and returns `{people: FollowedPerson[], error}`; `FollowedPerson` is the map
shape of one entry (`personId`, `label`, `position`, `path`, `progress`, `status`, `followers`,
`destination`, and optionally `phase`, `flags`, `etaMin`, `motion`, `trail`). `[]` without an incident or token; a
failed poll keeps the last people and sets `error`. `FollowTrack` and `FollowedResponse` type the server's
shapes.

## Homes

`GET /api/live/incidents/<id>/homes?q=&id=&limit=` (any role; a phone's civilian token is enough) lists
the incident's simulated people as homes, for the phone's address setting. Read-only; `404 unknown_home`
for an unknown `id`; `limit` 1-200 (default 50); `q` is a case-insensitive substring of the address.

```json
{"incident_id": "camp-2018-drill", "label": "Simulated people ...", "evidence_class": "simulated",
 "notice": "Simulated households of the drill. Addresses are made up from the nearest road; household and story are simulated.",
 "total": 60,
 "homes": [{"id": "sim_48db3ea34b8b4add", "address": "806 Green Ridge Place", "address_basis": "synthetic",
            "coord": [-121.59102, 39.87472], "zone": {"id": "bg:060070017042", "name": "Block Group 2, Census Tract 17.04"},
            "household": {"has_vehicle": true, "vehicles_taken": 1, "has_pets": true, "needs_assistance": false},
            "story": ["first heard of the fire: saw fire", "left before any official warning", "..."],
            "status": "Helping neighbours", "flags": ["Went back"], "evidence_class": "simulated"}]}
```

`coord` is WGS84 `[lon, lat]`, the person's home point. `story` is the person's `narrative`, `status` and
`flags` are what the participants list shows now (the call advances the people to the drill clock). The
address is made up on read: the nearest named road of the drill's road network within 1 km, and an even
house number from a hash of the person's id (deduplicated); with no road that close, "Home <n>, <zone>".
Code: `app/backend/api/live/homes.py`.

The phone (Home "Your address", About "Address") uses the picked home's point in place of its GPS fix to
find its zone on the device, so the order, route and fire it shows are the live `situation`'s for that
address. The home point is never posted as the device's location. A fresh install picks the first home
whose zone has an order (else the first home) until the person chooses a home or "My location".
