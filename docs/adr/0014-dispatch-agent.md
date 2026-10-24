# 0014: Dispatch agent

Date: 2026-10-24. Status: accepted for the demo; amended by [0016](0016-dispatch-anywhere.md)
(runtime OSM areas anywhere, households, 3D diorama; the fixture and its build tool are gone).

Builds on [0011](0011-simulation-studio.md). The `/simulation` page and the fire solver keep
their behaviour; `/dispatch` reuses the scheduled fire run unchanged.

## Context

The Studio produces a fire footprint on a timeline but nothing responds to it. We want to
try whether a language model can act as a dispatcher during that run: order evacuations,
redirect traffic and send fire engines, while the fire plays out. The risk is that a model
asked to "plan an evacuation" invents routes, travel times and counts. The repository rule
is that an LLM must not invent computed results (`AGENTS.md`), so the design has to keep
all numbers in the simulator.

## Decision

Add a page, `/dispatch` ("Dispatch agent"), a copy of the Simulation Studio. After the
Rothermel run is computed, a dispatch simulation and a Claude-based agent run alongside
playback. The pipeline is:

fixture (road graph, zones, exits, stations) -> engine (traffic and engines stepped against
the fire run) -> observation (JSON snapshot) -> `POST /api/dispatch/decide` -> Claude ->
validated orders -> engine.

- **The agent chooses from listed options.** The observation lists, for each zone, up to
  three reachable exits with drive minutes and bottleneck capacity (`exit_options`, fastest
  first), the units, and the tasks. An order names an id from those lists. The agent never
  supplies a route, time or count, and derived figures it would otherwise compute itself,
  such as how long a zone's queue takes to clear at the route bottleneck
  (`queue_clear_min`), are supplied by the simulator. The browser computes every route (Dijkstra, `routing.ts`),
  flow and count (`engine.ts`).
- **Two validation layers.** The server checks every order against the observation it
  received (known zone, unit and task; the exit must be in that zone's `exit_options`; at
  most 20 orders; one order per zone or unit per decision) and returns the rest in
  `rejected`. The page then applies orders through `DispatchEngine.applyOrders`, which
  validates again against live state (zone not overrun, exit reachable avoiding fire,
  unit has a fire-free route) and records an accepted or rejected outcome with a note. These
  outcomes go back to the agent as `previous_outcomes` at the next decision.
- **The clock waits for the agent.** Decisions happen every 10 simulated minutes
  (`DECISION_INTERVAL_MINUTES`), at T+0 first. An urgent alert (ignition, fire contact with
  vehicles still waiting, zone overrun, blocked route, vehicles exposed, unit withdrawn or
  stranded) brings the next decision forward, but never closer than 3 minutes to the last
  (`MIN_DECISION_GAP_MINUTES`). At a decision the simulation clock pauses, the request is
  sent, and the clock resumes only when the final `orders` event arrives. A model that
  streams for 20 seconds therefore costs no simulated time. The clock is the simulation
  clock; wall time only sets playback speed. Speeds are limited to 1 and 2 simulated
  minutes per second (`DISPATCH_SPEED_CHOICES`) so the streamed reasoning can be read.
- **Failure handling.** If a request fails the session stops in a `failed` state. The user
  can retry the same decision or skip it and continue with no new orders. Stopping aborts
  any in-flight request, so a late response cannot be applied to a newer session.
- **No-action baseline.** `noActionBaseline` runs the same engine, area and fire exposure
  to the horizon with no orders (and no scheduled-ignition alerts), so the agent run is
  compared with the same inputs and model settings. Its totals are vehicles, not ordered,
  exposed and so on.

## Model simplifications and assumptions

All constants are named in `engine.ts` unless noted.

- **Fire is precomputed and fixed.** Orders, engines and traffic do not change the spread.
  `structure_defense` has no modelled effect at all.
- **Fire arrival resolution.** `fireExposure.ts` finds, by binary search over the frame
  perimeters, the first frame that contains a point. Arrival is therefore the minute of
  that frame (5-minute display steps plus ignition minutes), not a continuous time. An edge
  is reached when its start node, end node or middle vertex is reached. A zone has contact
  when any hull vertex, the centroid or the loading node is reached, and its core is
  reached when the loading node or centroid is.
- **Departures.** Residents leave only after an order. Households become ready uniformly
  over `DEPARTURE_SPREAD_MINUTES` = 45; 20 (`SUPPORTED_DEPARTURE_SPREAD_MINUTES`) while an
  engine is on scene with task `evacuation_support`.
- **Queueing and capacity.** Ready vehicles queue at the zone's loading node and enter the
  route at most at its bottleneck capacity (vehicles/hour divided by 60 per minute). Zones
  whose routes share an edge split that edge's capacity in proportion to demand.
- **No downstream queues.** After release a cohort drives at free-flow speed. Congestion
  beyond the loading-node queue is not modelled.
- **Routing.** Dijkstra on free-flow travel time that skips every edge the fire reaches
  within `ROUTE_LOOKAHEAD_MINUTES` = 10. Drivers on the road re-route by themselves when
  their route ahead becomes blocked, to the ordered exit or else the nearest reachable
  one. A zone whose ordered exit becomes unreachable holds departures until it gets
  another exit.
- **Exposure.** Vehicles not yet departed when fire reaches the zone core, and vehicles on
  an edge the fire has reached, are counted exposed and removed. This is a model count, not
  a casualty estimate.
- **Engines.** Engines drive the same free-flow network, ignoring congestion. They
  withdraw automatically when fire is within `UNIT_WITHDRAW_MARGIN_MINUTES` = 5 of the zone
  core, and become `stranded` if no fire-free route exists. One engine per station.
- **Forecast shown to the agent.** Fire ETAs are given up to `FORECAST_LOOKAHEAD_MINUTES`
  = 60 ahead; beyond that they are `null`. The ETAs come from the precomputed run, so the
  agent sees the model's future fire, which a real dispatcher would not have. The
  observation says so in `model_notes`.
- **Fixture traffic parameters** (`tools/build_dispatch_area.py`, assumed, not observed):
  lane capacity in vehicles/hour per direction by class (motorway 1900, trunk 1600,
  primary 1200, secondary 1000, tertiary 800, other 600); default speeds when OSM has no
  `maxspeed` (motorway 100 km/h, trunk 80, primary 56, secondary 48, tertiary 40,
  unclassified 40, residential 32, living street 16); lanes per direction from the OSM
  `lanes` tag (halved for two-way roads), defaulting to 1 (2 on motorways).
- **Fixture demand** (synthetic): 50 homes per km of residential street, 1.6 vehicles per
  home, grid cells of 1200 m, cells with less than 1.5 km of residential street dropped,
  exits within 400 m of one another merged, one engine per station.
- **Agent run.** The server calls the model with adaptive summarized thinking and a
  single strict `issue_orders` tool. Default model `claude-opus-5-5`, default effort
  `low`, 8000 max output tokens, 60 s upstream timeout, one retry. The model identifier is
  taken from the source and was not checked against the provider here.

## Data provenance

Observed (OpenStreetMap, ODbL; attribution carried in the fixture's `sources.osm`): road
geometry, class, name, lanes, `maxspeed` and `oneway` tags, and fire station locations,
fetched once through the Overpass API by the build tool. Nothing is fetched at runtime.
The bounding box is 37.82, -122.26 to 37.905, -122.15 (Oakland / Berkeley hills); only the
largest weakly connected road component is kept. The committed fixture
(`app/public/dispatch/east-bay-hills.json`) has 4,154 nodes, 5,163 edges, 49 zones, 14
exits, 12 stations and 35,037 vehicles in total, with OSM timestamp 2026-10-24T08:26:21Z.

Synthetic (assumed): zone boundaries, home and vehicle counts, lane capacities, default
speeds, one engine per station, and the departure behaviour above. Zone names are the
nearest OSM place name plus an id. Fire spread is simulated by the Studio solver, and
the agent's text is model output; the observation tags the fire as `evidence_class:
"simulated"` and the decision as `"ai_decision"` so these stay distinct.

To rebuild the fixture, from the repository root with internet access (stdlib only):

```
python3 -m tools.build_dispatch_area --output app/public/dispatch/east-bay-hills.json
```

## Interface

`POST /api/dispatch/decide`, defined in `app/src/dispatch/contracts.ts` and
`app/backend/api/dispatch.py`. Change both and this ADR together.

Request: JSON `{ "observation": Observation }`, at most 200,000 bytes, exactly that one key,
with `clock`, `zones`, `exits`, `units` and `totals` present. Minutes are elapsed
simulation minutes from T+0, vehicles are counts, capacities are vehicles/hour. The
observation also carries `fire`, `alerts` since the last decision, `previous_outcomes`,
`previous_summary` (the agent's own summary, for continuity) and `model_notes`. The
observation is sent to the model inside `<observation>` tags and the system prompt tells
the model to treat it as data.

Response: `application/x-ndjson`, one event per line, ending with exactly one `orders` or
`error` event. Errors before streaming (invalid body, too large, key not configured) are
ordinary JSON `{ "error", "detail" }` with status 400, 413 or 503. Failures after
streaming starts become a final `error` line (`upstream_timeout`, `upstream_error`,
`upstream_rate_limited`, `upstream_unreachable`, `upstream_refusal`,
`upstream_truncated`, `no_orders`, `ai_unavailable`).

```
{"type":"thinking","text":"Z07 core ETA is 12 min and no order is in effect..."}
{"type":"text","text":"Z07 is the most threatened zone with 410 vehicles waiting. X03 is the fastest exit."}
{"type":"orders","orders":[{"type":"order_evacuation","zone_id":"Z07","exit_id":"X03","reason":"Core ETA 12 min, 8 min drive."},{"type":"dispatch_unit","unit_id":"E02","zone_id":"Z07","task":"evacuation_support","reason":"Shorten departures."}],"rejected":[],"summary":"Ordered Z07 out via X03 and sent E02 to support.","model":"claude-opus-5-5","evidence_class":"ai_decision"}
```

The ids and figures above are illustrative, not from a real run. Orders are
`order_evacuation` (zone, exit; for a zone already ordered with a different exit it is a
redirect), `dispatch_unit` (unit, zone, task `evacuation_support` or `structure_defense`)
and `recall_unit` (unit). The endpoint is unauthenticated, is throttled per anonymous
client at 40 requests per minute, and spends the server's API key; it is a local demo
endpoint.

Configuration (server environment): `ANTHROPIC_API_KEY` (required; without it the endpoint
returns 503 `ai_unavailable`), `DISPATCH_AGENT_MODEL` (optional), `DISPATCH_AGENT_EFFORT`
(optional: `low`, `medium` or `high`; anything else returns 503).

## Consequences and limitations

- Fire spread does not respond to orders or engines, so the comparison with the baseline
  measures only evacuation timing against a fixed fire, not suppression.
- Congestion past the loading node and engine congestion are not modelled, so route
  choices that depend on downstream queues will look better than they would on real roads.
- Zones are synthetic grid cells, not official evacuation zones, and demand is not Census
  data. Results do not transfer to named neighbourhoods.
- Fire arrival is quantised to frame times, and the agent sees modelled future fire up to
  60 minutes ahead. The agent is therefore better informed than a real dispatcher.
- Results are not reproducible run to run: the model is nondeterministic and the fixture
  and prompts are not versioned with the output. The engine and fire run are deterministic
  for a given sequence of orders.
- The agent can be slow, unavailable or wrong. Rejected orders are shown and fed back; a
  failed request pauses the run rather than inventing orders.
- Each decision is a paid model call, bounded by the clock (about 6 calls per simulated hour
  plus urgent ones, at most one per 3 simulated minutes) and the server throttle.
- This is a planning experiment. It does not replace real dispatchers and is not
  operational guidance or an evacuation instruction.
