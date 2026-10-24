# 0016: Live simulation drill and families in the resident app

Date: 2026-10-24. Status: accepted for the demo.

Builds on [0009](0009-mobile-meeting-plan.md) (meeting plan), [0010](0010-civilian-ios-app.md)
(civilian app) and [0014](0014-dispatch-agent.md) (dispatch agent).

## Context

The resident iOS app could only practise with an embedded copy of the web fire page. We want
residents to see, natively, the fire a planner is playing on the web, and what the dispatch
agent's orders mean for their zone ("leave now via this exit", "wait a little longer", "your
route changed"). Households also want to share one set of meeting points and tell each other
they are safe, which ADR 0009 left as the "trusted circle" phase.

`AGENTS.md` forbids turning simulated recommendations into operational instructions. Every
screen added here is therefore a **simulation drill**: a persistent banner says the fire and
orders come from CrisisTwin's models, not emergency services, and nothing is pushed as a
notification or alert.

## Decision

### Live broadcast (web -> backend -> app)

- The web `/fire` and `/dispatch` pages build a `LiveSnapshot` (`app/src/live/contracts.ts`)
  of the run they are playing and `POST /api/live/broadcast` it at most every 2 s while
  something changed, one request at a time so an older minute never lands after a newer one.
  Leaving the page, or turning off **Share with resident app** (on by default, remembered in
  the browser), re-sends the last snapshot as `playback: "stopped"`.
- The backend keeps only the latest snapshot (MongoDB `live_broadcast`, one document) with
  the server receive time. The app polls `GET /api/live` every 3 s in the foreground.
- **Fire:** the outer rings of the latest frame at or before the playback minute (15-minute
  frames on `/fire`, the Studio's frames on `/dispatch`). Holes are dropped, so the drawn area
  can only overstate the burn. Rings are thinned evenly to at most 600 points and the 60
  largest rings are kept.
- **Zones (dispatch only):** each dispatch zone's hull and resident guidance, computed in
  `app/src/live/snapshot.ts` from the dispatch engine. The agent chooses exits; the text is
  deterministic and uses simulator figures only:

  | `guidance`      | When                                                                                   |
  | --------------- | -------------------------------------------------------------------------------------- |
  | `no_order`      | No evacuation order yet ("be ready to leave", with the fire edge ETA when known).      |
  | `leave_now`     | Ordered with a usable route, and waiting is not justified.                             |
  | `wait`          | Ordered, households already queued take >= 10 min to enter the route at its bottleneck (`WAIT_MIN_QUEUE_MINUTES`), and the fire core is more than wait + drive + 30 min away (`WAIT_SAFETY_MARGIN_MINUTES`). `wait_min` is that queue time rounded to 5 min. |
  | `route_blocked` | Ordered but the exit is unreachable; departures hold until the agent gives a new exit. |
  | `cleared`       | Zone evacuated.                                                                        |
  | `overrun`       | Fire reached the zone core.                                                            |

  The app marks "route changed" when a zone's exit id changes within the same `session_id`.
  The agent's latest `summary` is passed through as clearly labelled AI text.
- **Privacy:** the app downloads the whole snapshot and works out the household's zone on the
  phone from a home location the user sets. The home location is stored only in the
  on-device plan file (`home`, optional, so existing version-1 files still load) and is never
  sent anywhere.
- **Meeting points:** the phase 2 check from ADR 0009 runs against the live fire: each point is
  "fire reached" if a current ring contains it, and the app points to the first point in order
  that is clear. If every point is reached it says so and suggests nothing.

### Families

- `POST /api/families` creates a family and returns the creator's membership; `POST
  /api/families/join` joins with an 8-character code (alphabet without 0/O/1/I/L). Each member
  gets a random bearer token returned once; the server stores only its SHA-256. Every read and
  write needs a member token. An unknown family and a wrong token both return 404.
- A family holds a name, the join code, a primary and optional backup meeting point (same
  shape as the on-device plan), and members with a fixed status: `unknown`, `safe`,
  `on_the_way`, `at_meeting_point`, `need_help`. No location is shared. Max 12 members.
- The app keeps its membership in the Keychain (this device only) and polls the family every
  10 s in the foreground. Editing meeting points in **My Plan** while in a family sends them
  to the family; when another member changes them (`meeting_points_updated_at` changes and
  `meeting_points_updated_by` is set) the app copies them into the on-device plan. Creating
  a family seeds it with the phone's current points. Removing the primary promotes the backup,
  because a backup cannot exist without a primary.
- Leaving deletes the member; the last member out deletes the family.

## Interface

`GET /api/live` -> 200 `{ "snapshot": LiveSnapshot, "received_at": "<ISO 8601 UTC, ms>" }`, 404
`no_broadcast`, 503 `database_unavailable`.

`POST /api/live/broadcast` with a `LiveSnapshot` body (<= 600 kB) -> 204; 400 with `{error,
detail}` when invalid. Validation lives in `app/backend/api/live_broadcast.py`.

```json
{
  "version": 1, "source": "dispatch_agent", "session_id": "6f1c…", "evidence_class": "simulated",
  "playback": "playing", "area_name": "East Bay Hills", "minute": 42, "horizon_minutes": 180,
  "wind": {"from_degrees": 45, "speed_mph": 40}, "bbox": [-122.26, 37.82, -122.15, 37.905],
  "fire": {"perimeters": [[[-122.21, 37.86], [-122.2, 37.86], [-122.2, 37.87], [-122.21, 37.86]]], "burned_area_ha": 310},
  "zones": [{
    "id": "Z07", "name": "Montclair Z07", "polygon": [[-122.22, 37.85], [-122.21, 37.85], [-122.21, 37.86], [-122.22, 37.85]],
    "guidance": "wait", "message": "Evacuation ordered via X03 (Grizzly Peak Boulevard). The route is backed up; if you are safe, wait about 15 min before leaving (about 9 min drive).",
    "exit": {"id": "X03", "name": "X03", "road": "Grizzly Peak Boulevard", "location": [-122.24, 37.88]},
    "route": [[-122.215, 37.855], [-122.24, 37.88]], "drive_min": 9, "wait_min": 15,
    "fire_eta_min": 20, "fire_core_eta_min": 70
  }],
  "agent": {"summary": "Ordered Z07 out via X03.", "model": "claude-opus-5-5", "minute": 40}
}
```

The ids and figures above are illustrative, not from a real run.

Families (all bodies JSON; responses carry `Cache-Control: no-store`):

| Method and path                          | Body                          | Success                                        |
| ---------------------------------------- | ----------------------------- | ---------------------------------------------- |
| `POST /api/families`                     | `{family_name, member_name}`  | 201 `{member_id, member_token, family}`        |
| `POST /api/families/join`                | `{join_code, member_name}`    | 201 `{member_id, member_token, family}`        |
| `GET /api/families/<id>`                 | -                             | 200 `Family`                                   |
| `PUT /api/families/<id>/meeting-points`  | `{primary, backup}` (null ok) | 200 `Family`                                   |
| `PUT /api/families/<id>/members/me`      | `{status}`                    | 200 `Family`                                   |
| `DELETE /api/families/<id>/members/me`   | -                             | 204                                            |

All but the first two need `Authorization: Bearer <member_token>`. `Family` is `{id, name,
join_code, primary, backup, meeting_points_updated_at, meeting_points_updated_by, members:
[{id, name, status, status_updated_at, is_me}]}`; a meeting point is `{name, note, latitude,
longitude}` in WGS84 degrees. Errors are `{error, detail}` with 400, 401, 404 or 503.

## Consequences and limitations

- One global broadcast: the last page to post wins, and every app sees it. Fine for a local
  demo; a real deployment needs per-incident channels and an authority approval step.
- The broadcast and family endpoints are unauthenticated to create (like the dispatch
  endpoint) and rate limited per anonymous client (120/min and 60/min). The join code is the
  only gate to joining a family; anyone who has it can read members, points and status.
- Guidance is only as good as the dispatch model (fixed fire, synthetic zones, no downstream
  congestion; see ADR 0014). "Wait" can be wrong when the queue model is.
- Apple Maps directions to an exit or meeting point do not know about the simulated fire.
- No push notifications: the app shows changes only while open.
- The resident app shows a planning experiment. It is not an evacuation order or an alert.
