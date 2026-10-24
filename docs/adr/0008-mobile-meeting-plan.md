# 0008: Household meeting plan on iOS

Date: 2026-10-24. Status: Phase 1 implemented; later phases proposed.

Civilians need a simple answer to "where do we meet if we get separated?" The
iOS app gets a **My Plan** tab: a household chooses an ordered set of meeting
points ahead of time, and later phases check them against the simulated fire and
point people to the first one the simulation does not reach. Meeting points are
the user's own choices. They are never presented as official shelters or
evacuation instructions, and the UI says to follow local authorities first.

## Phase 1 (implemented): plan on the device

- A primary meeting point and an optional backup, each with a name, a note, and
  a WGS84 latitude/longitude in decimal degrees. Points are chosen with Apple
  Maps search (`MKLocalSearch`) or by tapping a MapKit map. No location
  permission is requested and the user's position is never read.
- Trusted contacts come from `CNContactPickerViewController`, which needs no
  Contacts permission because iOS returns only the person picked. The app keeps
  the contact identifier, display name, and first phone number.
- The plan is stored only on the device as versioned JSON
  (`Application Support/meeting-plan.json`, `version: 1`) with complete file
  protection. An unreadable file is moved aside to
  `meeting-plan.unreadable.json` rather than silently replaced.
- Sharing is user-initiated: Messages opens prefilled for the contacts' numbers
  when the device can send texts, otherwise the share sheet. The text lists
  each point with an Apple Maps directions link, so recipients need no app.
  **Open in Maps** gives directions to a point. Nothing is sent automatically.

```json
{
  "version": 1,
  "primary": {"name": "Live Oak Park", "note": "", "latitude": 37.8834777, "longitude": -122.2690608},
  "backup": null,
  "contacts": [{"id": "<CNContact identifier>", "name": "Kate Bell", "phone": "(555) 564-8583"}]
}
```

## Phase 2 (proposed): switch to a point the simulated fire does not reach

When a fire is simulated, each preset point is checked against the perimeter
frames. If the simulation reaches the current point, the app highlights the
next point in the household's order that it does not reach and offers
directions there. This is the planning equivalent of "if the park is unsafe,
go to the backup".

- **Data source:** the fire frames come from the existing web model (ADR 0003),
  not a second Swift model. The web map page would post its `FireRun` to the app
  through a `WKScriptMessageHandler` when a run completes. That is a small
  change in `app/src/maps/MapsPage.tsx`, which the web owner must agree to.
  Persisted runs (the `feat/db-migrations` work) can replace it later.
- **Check:** a point is "reached at +N min" when it falls inside the first
  frame's polygon that contains it (ray casting on [longitude, latitude], which
  is adequate at neighborhood scale), or "not reached within 120 min".
- **Result:** the first point in order that is not reached within the horizon.
  If every point is reached, the app says so and does not invent a new place
  (AI suggestions, phase 3, address that).
- **Labels:** results say "simulated, illustrative fire model" and are not
  operational instructions. Wind, origin, and model version from the run are
  shown with the result so it can be reproduced.
- **Known limit:** Apple Maps directions do not know about the simulated fire or
  closed roads, so the suggested route may cross the simulated area.
  Fire-aware routing needs the team's road-network and traffic engine, which
  does not exist yet.

## Later phases (proposed)

- **AI-suggested points:** candidates come from Apple Maps search (parks,
  schools, community centers); deterministic rules score distance and the
  phase 2 fire check; a server-side LLM ranks them and explains using only
  those facts. The user confirms before saving. The API key stays on the backend.
- **Trusted circle:** contacts who have the app join by invite, see the plan,
  and post status (safe, on the way, arrived, need help). Status only, with no
  live location. This needs server accounts, owner-scoped authorization, and
  the persistence work.

## Tradeoffs

Phase 1 works offline and collects almost nothing, but a plan lives on one phone
until it is shared as text, and shared copies do not update. Two points cover
the common primary/backup practice; a longer ordered list is a small model
change if phase 2 needs it.
