# 0047: The active incident: the console switches the one live wildfire, phones follow

Date: 2026-10-24. Status: accepted.

Builds on [0030-scenario-engine](0030-scenario-engine.md) item 5 ("One active wildfire per
hosted instance"), [0034-multi-phone-hosting](0034-multi-phone-hosting.md) (`GET /api/live/active`)
and [0037-studio-drill-packages](0037-studio-drill-packages.md) (stored drill packages).

## Context

The live API served one incident, `camp-2018-drill`: a constant in `livecore.drill`, the auth
check, one cached drill index, one Camp-only twin, the web console's `INCIDENT_ID` and the
iOS default. Studio can now store a drill package for a fire anywhere in California, but
nothing could make it live.

## Decision

1. **Stored active record.** MongoDB `live_active` holds one document (`_id: "active"`):
   `incident_id, source (bundle|package), package_id, bundle (path), name, label,
   activated_at, actor`. Without it the active incident is the settings default
   (`LIVE_ACTIVE_INCIDENT_ID`, else Camp). `GET /api/live/active` reads it (cached 2 s per
   process); `POST /api/live/active` (controller) takes `{package_id}` or `{incident_id}`,
   loads the drill first, writes the record, logs `incident_activated` and warms the twin.
   Only the console switches; phones and batch runs never do.
2. **Served incidents.** `live_view` accepts Camp (always, so existing clients and
   `live_smoke` keep working) and the active incident; any other id is `404 not_found`. A
   stored package that is not active is not served. Routes without an incident in the path
   use the active one.
3. **Per-incident drill index.** `drillcache.get_index(incident_id)` keys the cache by
   incident and loads Camp with `load_drill` or a package with `load_package`
   (`incidents.source_for`: `studio-<hex>` maps to `pkg_<hex>`, the same digest). Camp stays
   cached; at most three package indexes are kept. Without an argument it uses the request's
   path incident (a context variable set by `live_view`), else the active one. The drill
   clock's default start is per drill (`default_replay_start`: 15:00Z for Camp, `clock.start`
   for a package).
4. **Per-incident twin.** Twin inputs are built per incident in the background.
   `sim.twin.package_inputs` builds them from a package: OSM roads (edges under 1 m are
   lengthened to 1 m, zero-capacity edges get 600 veh/h per lane), the package's synthetic
   zones (homes per km of residential street times vehicles per home; every vehicle evacuates
   once its zone is ordered; vehicles start at the road nodes inside the zone hull, or the
   nearest node), its exits, and the simulated Studio fronts as the fire area. There are no
   historical orders or closures, so zones leave only when published guidance orders them.
   These assumptions appear in the twin's `limitations`. Camp is unchanged.
5. **Camp-only data stays Camp-only.** The 2018 ground record and response record are empty
   for a package incident (`available: false`); the LLM rationale prompt no longer says
   "Camp Fire".
6. **Clients follow.** The web console polls `/api/live/active` every 30 s and re-subscribes
   when it changes; its "…" menu has a "Drill" switcher (Camp plus stored packages, with a
   confirm step), and Studio's "Use as live drill" result has an "Activate" button. The iOS
   `LiveStore` re-reads the active incident after a situation 404 and every 60 s; on a change
   it drops the old incident's state, queued outbox items and responder credential, and
   reloads. The controller MCP server follows the active incident unless `ORCH_INCIDENT_ID`
   pins one.

## Consequences

- Switching is one write; every console and phone moves within their poll interval. Data of
  the old incident stays under its id, and switching back resumes it.
- A responder must rejoin after a switch (responder tokens belong to one incident).
- A package twin is a planning experiment on synthetic demand; Camp remains the only
  incident with a historical record to compare against.
- Simulated participants (`live_sim_responders`, residents, comms) still default to Camp;
  pointing them at a package incident is a per-command `--incident` choice.
