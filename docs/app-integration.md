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
| Stats | Everyone else: still at home, driving out, in traffic, stuck, safely out; on our app: real and simulated | `GET incidents/{id}/people` (simulated) minus our app residents (below); `participants.counts` |
| On our app | Every joined phone and simulated person: name, plain status line, up to two flag chips, "Last seen" for a real phone not heard from in 30 min; **+ Add a simulated person** | `GET incidents/{id}/participants`; `POST incidents/{id}/virtual-people` `{count: 1, seed}` |
| Map | Zones with their guidance (LEAVE NOW / GET READY), the drill fire estimate, closed roads, the people layer ("everyone else": homes, cars on the roads, queues, stuck clusters, arrivals), our app users as dots, and the selected person's route | `command` (zones, guidance, fire, public items), `people` (`app/src/live/people`), `participants` |
| Needs your OK | Pending proposals as plain sentences ("Tell Tract 9, BG 1 to leave now", "Send 3 zones a new way out") with how many people and app users they reach: **Send** / **Don't send**. Open help requests: **Send a responder** / **Tell them we got it** | `command.proposals` (`POST proposals/{id}/approve`, `.../reject`); `command.checkins.need_help` (`POST checkins/{id}/help` `assign` with any responder, or `acknowledge`) |
| Messages | One timeline: "To Tract 16, BG 3: leave now", "From Ana: heavy traffic on Severns Lane", "To Chloe: we got your request", "Not sent: ..." | `participants.messages` |
| What *name* sees | One line about the person (real or simulated, zone, status; simulated people's own story) and a phone-frame mirror of their current screen | `PhoneMirror` (`app/src/appint/PhoneMirror.tsx`, props `{incidentId, participantId}`; owned by the phone-view work) |
| What simulated people did | Simulated households by headline behaviour: followed the order, left late, took a different road, went back home, stayed home, waited to see the fire, drove toward the fire | `participants[].behaviour.choices` (below) |

Map marks: solid blue dot = real phone, hollow dot = simulated person, square = responder, larger with an amber
ring = selected. Real phones are labelled with their name; simulated ones only when selected. Clicking a dot
selects that person; the list is a listbox (arrow keys move the selection).

**Real time rule.** A real phone counts as joined while it was heard from in the last 30 min
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
resident, `rsp_...` responder). Simulated people come from the virtual-people module
(`list_participants(incident_id)` in `api/live/virtual_people.py` or
`livecore/virtual_people.py`). That module had not landed when this was written:
`_virtual_participant` in `app/backend/api/live/phone_view.py` is the marked hook, and until
then only real participants resolve. A simulated person is returned with `kind: "simulated"`
and `evidence_class: "simulated"`.

| Field | Meaning |
|---|---|
| `participant_id`, `name`, `role` (`civilian` / `responder`), `kind` (`phone` / `simulated`) | who |
| `screen` | `guidance` (a zone with an order), `no_order`, `checked_out` ("You're marked out"), `help_requested`, `responder` (task screen), `not_joined` (no place known yet) |
| `headline`, `sub`, `lines[]` | the card text as the app words it: "Via Wilder Drive", "Leave now", "Exit west, 19 min", the server's reason |
| `buttons[]` | `{label, kind: primary / danger / secondary}`; mirrors only, nothing is clickable. The help button follows the controller's handling ("Help requested", "Request seen", "Responder assigned") |
| `zone` | `{id, name}` the phone is in (stored location, else the check-in zone), or `null` |
| `position`, `position_is` | `[lon, lat]`; `device` for a stored location, `zone_centre` when only the zone is known (drawn as a dashed marker) |
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
