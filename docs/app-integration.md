# App integration

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
