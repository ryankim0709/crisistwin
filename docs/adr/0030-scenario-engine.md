# 0030: Scenario engine: any California fire as a live drill that generates all live data

Date: 2026-10-24. Status: proposed (design for the next build phase).

## Context

`/live` runs one incident: the 2018 Camp Fire replay (`camp-2018-drill`, ADR 0012/0013). Its
ground data comes from people (phones, the console) and from the de-identified 2018 record
(`tools/camp_ground_record.json`). That is enough to demo Camp, not to test strategies:

- strategies must be tried in situations we create (any California location and fire, plus
  injected failures such as 911 overload, a tower outage or a closure the field does not know);
- the strategy under test is an **orchestrator agent a teammate is building**, so CrisisTwin
  must expose a stable controller surface it can drive, and score what it did;
- several **real phones** must join **one hosted console** at once, next to simulated people;
- live mode should work for any scenario without depending on a sparse historical record.

## Decision

One engine serves a watched live drill and headless batch runs. A drill is an **incident**
(`incident_id`) backed by a **drill package**; everything downstream (console, phones, planner,
twin, queue, routing, AAR) stays incident-agnostic and unchanged in contract.

1. **Drill package** (per incident, built once, stored like the replay bundles): zones with
   households and vehicles, the road graph, destinations, stations and responder units, the
   fire timeline, and the historical record if any. Two builders:
   - **Historical replay**: today's bundle path (Camp, and later Marshall/Woolsey/Kincade).
   - **Studio scenario, anywhere in California**: the Studio run (fire arrival grid from the
     browser solver on LANDFIRE fuels and terrain, ignitions, wind assumptions) plus
     `/api/dispatch/area` for the same box (OSM roads, stations, synthetic homes grouped into
     zones). The browser posts the run; the backend validates and converts it. Every input
     keeps its label (assumed wind, synthetic homes, simulated fire).
2. **Generators** (`sim/` or `livecore/`, pure, seeded, stdlib). Driven by the drill clock,
   they write into the existing collections with `evidence_class: "simulated"`:
   - **people**: simulated residents derived from the twin's vehicles (one population for
     traffic and calls), producing phone reports, check-ins, help requests and destination
     choices;
   - **comms**: 911 calls, radio traffic and rescue requests at the rates from
     `sim/ground_rates.py` (calibrated on the 2018 record, extended with other fires' AAR
     volumes), categories conditioned on the fire and the roads;
   - **responders**: units from stations that accept tasks, drive inbound routes
     (`livecore/inbound.py`) and close them, reporting what they find;
   - **feeds**: closure and weather items in the live-feeds candidate format;
   - **injects**: scripted or instructor events (overload, outage, closure, shelter full).
3. **Controller surface for the orchestrator.** The existing controller API (command, triage,
   tasks, proposals, help, drill clock, twin what-if, impact, task routes) is the tool set,
   documented as a versioned contract with an event stream (`GET incidents/{id}/events?since=`)
   so an agent need not diff polls. Each action records `actor` (human, `auto_policy`, or an
   agent id). We do not build the teammate's agent; we ship the contract, a small reference
   client and fixtures.
4. **Evaluation.** A headless runner steps scenario × strategy × seed at full speed and scores
   each run with the AAR drill score (ADR pending, `feat/drill-aar`); output is a comparison
   table. Runs are reproducible from (package hash, generator params, seed, action log).
5. **One active wildfire per hosted instance.** A fire can start anywhere in California, but
   at any time the instance runs one **active incident**, and the console and every phone are
   attached to that same fire. The console chooses or starts it; phones never pick one. They
   read the active incident from the server (`GET /api/live/active`) and follow it when the
   console switches. Several real phones join at once, next to simulated participants. Real
   reports are labelled `field_report` and simulated ones `simulated`. Batch evaluation runs
   headless incidents in their own namespace and never become active. Hosting (venue LAN with
   the Mac's `.local` name, a tunnel, or a cloud deploy) is a separate, explicit decision;
   nothing here deploys anything.

## Consequences

- `INCIDENT_ID` stops being a constant: the drill index, twin sessions, ground record and the
  web client become per incident. Camp stays the default.
- Generated data is only as good as its calibration; every generated item is `simulated`, and
  scores are planning experiments, never claims about real outcomes.
- Testing stays automated: API smoke (`live_smoke`), backend tests, headless browser, and
  XCUITest on simulators; nothing drives a person's screen.

## Open questions

- The interface the teammate's orchestrator expects: REST tools, an MCP server, or a Python SDK.
- Hosting for multi-phone sessions.
- Package storage for generated scenarios (MongoDB GridFS like incident packages, or files).
