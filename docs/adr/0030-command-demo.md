# 0030: Command demo

Date: 2026-10-24. Status: accepted for the demo.

Builds on [0012-controller-guidance](0012-controller-guidance.md) (the Camp Fire drill zones,
destinations and roads) and [0014-dispatch-agent](0014-dispatch-agent.md) (the observation and
orders pattern, the evacuation departure spread and the engine line rate).

## Context

The dispatch agent ([0014-dispatch-agent](0014-dispatch-agent.md)) answers one scheduled run
that ends. A command centre does not work like that: fires keep starting, crews are a fixed pool,
and the question is who goes where and which zone leaves, hour after hour. We want to try that
loop, with a person and a Claude commander on the same board, on the map the `/live` controller
already uses. The Rothermel solver ([0011-simulation-studio](0011-simulation-studio.md)) is the
wrong tool here: it needs a landscape download, takes seconds per run, and could not advance a
board at 24/7 speed in the browser. The purpose is command and control, not fire prediction.

## Decision

Add a page, `/demo` ("Command demo"), a 24/7 wildfire monitoring board on the Camp Fire drill
map. Zones and destinations come from the live command API and the map looks like `/live`. There
is no win or end state. The simulation clock runs continuously at a chosen speed, and the fire
activity level (Quiet, Active, Severe) can be changed while it runs.

- **Fires.** They come from scheduled ignitions (seeded, at the activity level's interval), spot
  fires thrown downwind by large burning fires, `fire_seen` field reports from the live drill
  (each report becomes a fire, or joins the fire it is inside or that reaches it within 5
  minutes), and fires a person adds by clicking the map.
- **Model** (`app/src/demo/model.ts`, pure, seeded, simulation clock). A fire is an ellipse
  growing from its ignition point at a constant head rate with a fixed length-to-breadth ratio of
  2.5 and wind from 45 degrees. This is a scenario assumption, not a fuel or weather model.
  Six engine strike teams of 5 engines start from 3 synthetic stations chosen by
  farthest-point sampling over zone cores; they are not real stations. A team builds line at 5
  times the studio engine rate. A fire is contained when the line built reaches its perimeter;
  after 10 minutes of mop-up it goes out and frees its teams. A fire whose perimeter outgrows the
  line is never contained. Households leave only on an evacuation order, spread over the dispatch
  engine's 45 minutes, and are caught if fire reaches the zone core while they are still home.
  Congestion is not modelled. Teams drive in a straight line times a detour factor of 1.3 at 50 km/h
  after the engine's turnout time.
- **24/7 design.** At most 25 fires burn or smoulder at once. A fire that is out leaves the board
  after 30 minutes (its area stays in the burned total). An ordered or overrun zone reopens, with
  households back and the order cleared, after 90 minutes with no fire touching it and none
  forecast. Caught households stay in the running total. The event log and the set of seen
  reports are capped.
- **Routes** come from the backend, not the browser: `POST /api/demo/routes` runs the live
  planner's router (`livecore.routing`) over the drill road graph, avoiding the fire areas, for
  every zone's best route and up to three alternatives. Nothing is stored.
- **Claude commander.** `POST /api/demo/decide` streams a decision for an observation, as
  `/api/dispatch/decide` does. Claude may `send_crew`, `release_crew` or `order_evacuation`, and
  chooses only among ids the observation lists. The server validates every order against the
  observation, and the page validates again before applying it. It needs `ANTHROPIC_API_KEY` and
  reuses `DISPATCH_AGENT_MODEL` and `DISPATCH_AGENT_EFFORT`. `stream_decision` in
  `api/dispatch.py` gained the keyword parameters `system`, `tool` and `validate` so both
  endpoints share it.
- **Agent loop.** A deterministic monitor (`app/src/demo/observation.ts`) checks every few
  simulated minutes and calls Claude only on new fires, fires the assigned crews cannot hold,
  freed crews, zones running out of time, or a periodic review. An autopilot toggle turns the
  loop on or off, and the clock can be held while Claude decides.
- **Manual controls.** Select a fire and close it out by hand; send a free team; order a zone
  out; add a fire on the map. Closing a fire that came from field reports also resolves those
  reports through the live API's triage `resolve` action, so `/live` shows them closed.
- **Labels.** Everything on the board is simulated and labeled so. Every number comes from the
  model or is a scenario assumption; Claude explains and chooses, and never supplies a value.

## Contract

The shapes are in `app/src/demo/contracts.ts`; change it and `app/backend/api/demo.py` together.
Coordinates are WGS84 `[lon, lat]`, distances metres, areas hectares, times simulation minutes
from T+0. Errors are `{"error": code, "detail": text}` with `Cache-Control: no-store`.

`POST /api/demo/routes`, body at most 300,000 bytes. `fires` holds at most 60 rings, each 4 to
200 points (a ring that is not closed is closed). It lists the fires that are not out; an empty
list gives the routes with no fire.

```json
{"fires": [[[-121.60, 39.76], [-121.59, 39.76], [-121.59, 39.77], [-121.60, 39.76]]]}
```

Response 200, one entry per drill zone, best option first. `options` is empty if the zone has no
route; `safety` is `clear`, `passes_near_fire` or `passes_fire`:

```json
{"zones": [{"zone_id": "z1", "options": [
   {"destination_id": "d1", "name": "Chico", "kind": "shelter", "eta_min": 32,
    "distance_m": 24800, "via": ["Skyway"], "safety": "clear", "line": [[-121.62, 39.76]]}]}],
 "evidence_class": "simulated"}
```

`POST /api/demo/decide`, body at most 200,000 bytes, with an `observation` holding at least
`clock`, `fires`, `crews` and `zones` (the full shape is `DemoObservation`). Response is
`application/x-ndjson`: `thinking` and `text` lines, then one final `orders` or `error` line:

```json
{"type": "orders", "summary": "F3 outruns one crew; sending two more.",
 "orders": [{"type": "send_crew", "crew_id": "T2", "fire_id": "F3", "reason": "Nearest free crew."}],
 "rejected": [], "model": "claude-opus-5-5", "evidence_class": "ai_decision"}
```

At most 20 orders are accepted per decision, one per crew or zone. Errors: 400 `invalid_request`,
413 `too_large`, 503 `ai_unavailable` (no key, or a bad effort setting), 429 when throttled.
Routes allow 120 requests per minute and decisions 40 per minute per client IP.

## Consequences

- The board runs fast and offline from landscape data, and the same seed and orders replay the
  same run.
- Fire behaviour is far cruder than the Rothermel run. The constant-rate ellipse ignores fuel,
  terrain, wind change and spotting physics, and the crew, speed and detour figures are
  assumptions. This is a planning and demo experiment, not operational guidance. It sends no
  resident alerts and claims no authority approval.
- Routes ignore traffic, and household departure is uniform over the spread. Both are
  assumptions that favour the evacuees.
- The routes and decide endpoints are anonymous for the local demo, so the throttles and body limits
  are the only protection against paid-call abuse. Add authentication before any shared deployment.
- Resolving a field report from `/demo` changes live drill data. That is intended, but it means
  the demo is not purely read-only.
