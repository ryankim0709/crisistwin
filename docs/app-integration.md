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
