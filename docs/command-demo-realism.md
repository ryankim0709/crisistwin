# Command demo: realism

Date: 2026-10-24. Extends the `/demo` board of `docs/adr/0047-command-demo.md` (the ADR is not
changed). The board keeps its clock (now running only while the AI agent is on, below), its speeds (1× to 120×) and its Claude commander;
the fire, units, travel and households are now driven by sourced models and data. Every input
the board uses is listed under "Model inputs" on the page and in `observation.inputs` for the
commander, with its evidence class.

## AI agent only: the clock runs only while the AI agent is on

The `/live` board is AI agent only: nothing is dispatched or ordered unless the AI agent (or the
drill controller) orders it ([response-model.md](response-model.md#decisions-and-mechanics-on-the-live-board));
there is no rule-based response toggle in the UI (`useCommandBoard.ts` `aiOnly` forces
`autoDispatch` and `autoEscalate` off on every board it builds). So the board clock runs only while
the **AI agent** switch is On (`useCommandBoard.ts` `clockPause`): with it Off (the default, so no
Claude tokens are spent by accident) nothing advances (fire, units, traffic, households) and a
fresh board waits at T+00:00 with "Simulation paused — turn on the AI agent to run it." under the
clock, which reads "Paused (AI agent off)". Turning the agent On starts the clock (clearing an
earlier Pause); Pause/Resume works only while it is On (Resume is disabled with that reason while
Off). Turning it Off, or hiding the tab, aborts any Claude call in flight so a late answer cannot
apply. "Ask Claude now" while Off is one decision on the frozen board: its orders apply at that
board minute and the clock stays paused. Simulation Studio publishes are still ingested while
paused (their ignitions are scheduled from the board minute).

**Auto speed** (`app/src/demo/autoSpeed.ts`, on by default, remembered per browser): the speed
follows the board. While Claude is deciding on an **urgent** wake (below; also "Ask Claude now",
or an urgent event queued behind a routine call) it is 1×, so the board barely moves before the
orders land; while it is on a **routine** wake (a continuous review, an arrival, a finished line)
it is also 1× (`AUTO_SPEED_REVIEWING`). Fire, units and traffic share the same simulation
clock during every decision; while nothing is going on (`boardIsIdle`: no
reported fire burning or contained — an unreported or scheduled fire does not count — no unit
moving or working, no zone leaving or scheduled, no aircraft flying, no resource order due within
30 min) it is 60×; otherwise 20×. It drops to 20× (or 1×) at once and goes back up to 60× only
after the board has been idle for 5 board minutes, also after each Claude call. These rates are
UI choices; only the board minutes per real second change, and `step` lands on the same minutes
and events at any rate, so results do not depend on them. Moving the speed slider turns Auto off
and keeps that speed; the "Auto" button turns it back on. The speed reads "60× · idle",
"1× · Claude deciding (urgent)", "1× · Claude reviewing", "20× · active" or "· manual". With the
agent Off it shows what Auto would pick. While Claude is thinking, playback is temporarily
held to 1× even with manual speed selected; the selected speed resumes after the decision.

### AI agent cadence: near-continuous while a fire burns

The monitor (`app/src/demo/observation.ts` `wakeReasons`, run by `useDemoAgent.ts`) compares the
board with what Claude saw at its last decision and calls `POST /api/demo/decide`:

- **At once on events** (checked every board minute, a new reported fire on every board change):
  a new reported fire, an extended-attack stage due, a fire outrunning its crews (with free crews),
  a line breached, the chosen strategy turning `not_containable` or no longer offered, a unit on
  scene at a burning fire with no work ("standing there": parked out of reach, or on direct
  attack with no open edge within its reach radius, `boardResponse.ts` `idleOnSceneReason`), a
  zone reached by fire (urgent with people home), a zone short of order slack — all **urgent** —
  and units arrived on scene, a line finished, crews freed, a zone newly threatened with people
  home and no order, a road closure, or orders refused in the last decision (at most one
  follow-up in a row) — **routine**.
- **Continuous review**: while a reported fire burns or a zone is threatened, Claude is called
  again `CONTINUOUS_GAP_MINUTES` = 3 board minutes (a UI/ops choice) after each decision's orders
  land, even with no event; with only contained fires or leaving zones, every 30 board minutes
  (`REVIEW_EVERY_MINUTES`). Nothing on the board: no calls.
- Every wake after the first ends with "Since the last decision (T+…, n min ago): …": per fire its
  area and growth (ha), reach from ignition (m), containment % before → now, and which units are
  working, walking in, en route or idle on scene; fires gone out; orders refused. All numbers come
  from the board's models; Claude only reads them (`observation.monitor`, `previous`).
- **One call in flight.** Events while Claude thinks are compared with what that call saw, so they
  start exactly one follow-up call as soon as it finishes (the feed's pending row says "follow-up
  queued"). A decision's own orders (a released crew, a new strategy) do not wake it again.
- The feed's pending row reads "Claude is deciding (urgent)…" or "Claude is reviewing the
  board…" with the wake reasons; reviews that issue no orders collapse into "Claude reviewed the
  board n times: no change." The decision log keeps the last 80 decisions.

**Cost and effort.** The request carries `urgency` (`urgent` | `routine`, validated in
`api/demo.py`): urgent runs at `DISPATCH_AGENT_EFFORT` (default `low`), routine at
`DISPATCH_AGENT_ROUTINE_EFFORT` (default `low`, never above the urgent effort), and on
`DISPATCH_AGENT_ROUTINE_MODEL` when set (default: the urgent model). Keep both efforts equal: an
effort or model change gives the other kind of call its own cache entries (effort can invalidate
the system cache on this model; caches are per model). Historical load estimates under the
previous Auto speeds (not estimates for the current 1× reviews), from a timing model of the cadence (3-minute gap at 20×, routine calls at 5×, urgent at 1×; scratch
model, not measured): **about 10–20 calls per hot board hour** and about 75–170 calls per real hour
while a fire burns (measured on 2026-10-25: calls 6–18 s apart). Turn the agent Off between
demos; hiding the tab pauses it.

**Prompt caching** (`api/demo.py` `system_blocks`, `split_observation`, `build_user_content`).
Render order is tools → system → messages; two breakpoints:

1. Tools + system prompt (~6.3k tokens, constant per incident), **1-hour TTL**. While the board
   runs, calls are seconds apart and any TTL stays warm; the 1-hour write ($8 vs $5 per MTok)
   pays off on the first Off/tab-hidden pause of 5–60 minutes, which demos have.
2. `<observation_static>` (~7.1k tokens on Berkeley Hills: clock constants, `activity`, `inputs`,
   wind provenance, each crew's identity fields — kind, class, label, base, station, department,
   tier, `holds_flame_ft` — the departments' fixed fields, `response.orderable` and the auto flags),
   **5-minute TTL**. The server splits the posted observation (the wire contract is unchanged) and
   serializes it with sorted keys, so it is byte-identical for a whole run: one digest
   (`static=` in the `Demo decide` log line) across every call, even across consoles. It changes
   only when the board does (new run, a Studio fire setting moisture, units added): one write.
   The rest (`<observation>`, the minute, fires, unit status, zones, forecasts, wake reasons) follows
   uncached. The system prompt tells Claude to read both parts as one observation, by id.

Measured (count_tokens on a captured observation, 1 fire, 29 units, 8 listed zones, 59 kB, then
real calls on 2026-10-25; Claude Opus 5.5 list prices: $4 input, $20 output, $0.20 cache read,
$5 / $8 cache write 5 min / 1 h per MTok):

| per call | before (tools + system cached) | after (+ static observation cached) |
|---|---|---|
| cached prefix (read) | 6.2k | 13.5k |
| uncached input | 27.8k (whole observation) | 21.5k (dynamic part) |
| input cost, warm | $0.113 | $0.089 |
| real warm calls, early board (9.8–13.1k uncached, 13.5k read, 290–1,300 output) | ≈ $0.074–0.105 (same calls, old shape, estimated) | **$0.050–0.081** (measured) |
| first call of a run (cold: 6.3k 1-h write, 7.2k 5-min write) | — | $0.155 (measured) |

Output (thinking plus the assessment and the tool call) was 290–1,300 tokens per call at `low`
effort ($0.006–0.026). Per real hour of a burning fire (75–170 calls): **about $4–14** on an early
board (before: $5.5–18), and **about $8–19** with mid-fire observations around 28k tokens (before:
$10–23), more as the observation grows. Every call's usage and cost are logged
(`Decision usage: … cost_usd=…` from `api.dispatch`, INFO) and returned as `usage` on the final
NDJSON line; /live shows "Claude spend this session: $X.XX (N calls, cache hit Y%)" under the AI
agent switch (`demo/AgentSpend.tsx`; list-price estimate since page load).

Not done, and why:
- **Dynamic part as a diff in a multi-turn session** (previous turns cached, only changes sent):
  nearly every number in the dynamic part (ETAs, margins, forecasts, strategy options, line
  progress) moves every 3 board minutes, so a diff stays a large share of it, while the model would
  have to apply patches to read exact values it must not invent (a stale ETA sends a crew to the
  wrong place), each turn's tool call needs a tool result, preserved thinking ties history to the
  conversation, and history grows the cached read and latency every turn. The saving (at most the
  ~$0.086 dynamic input, realistically well under half of it) is not worth that risk here.
- **Pre-warm with `max_tokens: 0` when the agent is switched On**: the first real call follows
  within seconds and writes the same prefix; a pre-warm only moves that write earlier (about a
  second of prefill on 13k tokens) and is a pure extra write when no call follows.
- **Biggest remaining lever** is the dynamic observation itself: dropping `null` values and empty
  lists cut the captured observation from 27.8k to 22.9k tokens (−18%, count_tokens) but needs a
  prompt rule ("absent = null"); `DISPATCH_AGENT_ROUTINE_MODEL=claude-sonnet-5-5` would halve
  routine calls ($2 / $10, cache read $0.10) at a quality cost not yet measured.

## Fires come from Simulation Studio

The board (now run inside Live command, `/live`) starts no fires itself: no random or hand-placed fires,
no activity setting, no "Add fire", and a `fire_seen` field report no longer creates a fire (it
only joins a fire already there, so closing that fire resolves the report). Fires arrive when
Simulation Studio runs a simulation and publishes it (`POST /api/live/studio-fires`); the page
polls `GET /api/live/incidents/<id>/studio-fires` every 5 s (`app/src/demo/useStudioFires.ts`) and
`model.ts` `ingestStudioFire` takes each publish once per board (by `fire_id`):

- Each enabled Studio ignition starts at the ingest board minute + its Studio `start_minute`, as
  fire `S<n>-<ignition name>` (n counts the board's publishes, e.g. `S1-F1`), source `studio`.
  The clock lands exactly on each scheduled start. Each ignition also carries `report_minute`
  (same Studio clock; set by the Studio user, or `null` for the board's modelled report delay;
  `app/src/demo/useStudioFires.ts` reads one before the start as `null`).
- **Report rule.** The fire is reported to dispatch at ignition + (`report_minute` −
  `start_minute`) when set (a Studio assumption, `reported_by: "studio"`), else after the modelled
  report delay. From the report the AI commander is called at once to dispatch initial attack
  (nothing is sent automatically). Until then nobody can act on it: no aircraft, escalation,
  resource order, `send_crew` or attack position (refused by board state, for the AI commander and for a person
  alike), and Claude's observation, the outcomes' threat counts and the feed carry nothing derived
  from it. It still spreads and can catch households. The controller's map shows it as
  "not yet reported (sim)". Details: [response-model.md](response-model.md#from-ignition-to-dispatch).
- Ignitions in `outside_drill` (more than 3 km outside the drill zones' box) or off the board's
  landscape are skipped, with a board event saying why. Every ingest is logged
  ("Studio fire 'X' received as S1: 2 ignitions, wind 25 mph from 45° (assumed), Dry fuel
  moisture.") and shows in the audit log as source "Simulation Studio".
- Which publish a board runs: Studio's newest run only (Studio is the source of truth). At its
  first read of the feed a board takes the newest stored publish (the server keeps only that one:
  a publish clears the previous run's state, [live-reports.md](live-reports.md#studio-fires)). This
  covers a reload, a run published while Live command was closed or while the board was still
  loading after Studio switched the drill. A publish that appears later restarts the board on
  that run alone at T+0 (a new board: new run id, Claude's memory cleared; feed line "Simulation
  Studio run S1 received: board restarted with its 2 fires."). "Restart board" restarts on the
  newest publish with a new seed; "Reset board" deletes the publishes and starts empty. A new
  shared-world seed (Studio's random scenario) no longer restarts the board. With a
  `weather_series` the board's wind and moisture follow Studio's hourly series at the same Studio
  minute. Map and 3D labels show Studio's ignition name with the board id: "F1 (S1-F1)".
- With no fire on the board the stage shows "No fires. Run a simulation in Simulation Studio to
  start one here." and the AI commander's monitor has nothing to wake it.

Code: `app/src/demo/realism.ts` (inputs and data), `app/src/demo/model.ts` (board),
`app/src/demo/fireField.ts` (fire solve and what the board reads from it),
`app/src/demo/fireSolver.worker.ts` + `useFireSolver.ts` (solves off the main thread),
`app/src/demo/fireFootprint.ts` (map polygons), `app/src/demo/useDemoEnvironment.ts`,
`app/src/demo/useCrewRoutes.ts`, `app/backend/api/demo_realism.py`. Contract:
`app/src/demo/contracts.ts`. The response model (run cards, departments and fleet, tactics, holding
test, escalation, unit states) is `app/src/demo/boardResponse.ts` over `app/src/response/`, documented
in [response-model.md](response-model.md); road access per drill road is under "Road access" below.
The /live map's People layer (`app/src/live/people/`) is documented in [twin-api.md](twin-api.md) and
[app-integration.md](app-integration.md); this document covers the board's own households.

## Realism

| Element | Before | Now | Evidence |
| --- | --- | --- | --- |
| Fire spread | Constant head rate 8-32 m/min drawn at random per fire; fixed L:B 2.5; wind fixed from 45°, later one Rothermel ellipse per fire | The simulator's cell solver, the same as `/fire` and Simulation Studio (`fire/spread.ts` `simulateScheduledFireSpread`): Rothermel (1972) per cell with per-cell midflame wind from canopy (Albini & Baughman 1979), crown fire (Van Wagner, Cruz, Scott & Reinhardt), ember spotting and structure-to-structure spread at their defaults (`DEFAULT_SPOTTING`, `DEFAULT_STRUCTURE_SPREAD`). Every board fire is a solver source; spot fires belong to the fire that threw them (the board's own random spot rule is gone). No ellipse fallback. The board asks the solver for seeded natural variation (`stochastic: {enabled, seed: board seed}` in `buildFireSolveRequest`, on by default, the same seed for every solve of a board so a resumed solve repeats its draws; [response-model.md](response-model.md)) | Model |
| Fuel and terrain | SH5 assumed everywhere; Camp 3DEP slope at 200 m | LANDFIRE FBFM40 fuel, canopy and terrain of the Studio board the drill was run on when `GET /api/live/active` names one (`region_id`, e.g. `berkeley-hills-tilden@10km`: loaded exactly as Studio loads it, same centre, radius and cell size, so it reads Studio's MongoDB landscape cache entry, and the Board size control starts at that radius); otherwise of the prebuilt region covering the drill (`GET /api/landscapes`, e.g. Berkeley Hills & Tilden, Pacific Palisades). With no covering region (Camp) or the store down, the same layers are loaded live from LANDFIRE for a square around the drill zones (half-width + 1.5 km ignition ring + 3 km margin, cell size as `/fire` picks for that radius), as Simulation Studio does when its stored board is unavailable. The board waits while it loads and shows an error, not a fallback, if it fails | Observed (mapped product) |
| Moisture | none | The Studio run's fuel moisture values (a Scott & Burgan 2005 scenario or custom), labelled "Assumed in Simulation Studio". Earlier: one scenario per activity level (removed with the activity levels) | Assumption (Studio scenario) |
| Wind (Studio fire on the board) | none | The Studio run's wind (speed mph, direction FROM), held constant as Studio runs it, labelled "Assumed in Simulation Studio" with Studio's own source (assumed, historical, worst case, forecast). A newer publish's wind and moisture apply to every fire on the board (the solver runs one wind) | Assumption (Studio scenario) |
| Station wind (no Studio fire yet) | none | Hourly series from `sim/weather.py` via `GET /api/demo/wind`, changing every simulated hour and looping. Three choices: 1-8 Nov 2018 observed (default), Camp Fire day observed, November 95th-percentile offshore episode (derived). Jarbo Gap RAWS (JBGC1, 10 km) for the observed modes; Chico ASOS for the derived one. Endpoint down: **ASSUMPTION** constant 5.9 m/s from 45° | Observed / derived |
| Wind in the solver | n/a | The solver takes one wind per run. With a Studio fire that is the Studio wind, constant. Without one (no fires, so nothing is solved) each solve would use the current hour's sample for its whole 6 h lookahead. When the sample (or the moisture) changes, the board re-solves from that minute, continuing from the burned ground with the solver's progress-preserving resume (`ResumeFrom` in `fire/spread.ts`): burned cells keep their times, and a step in progress keeps the share it covered at the old rate and finishes at the new one. So the footprint follows the hourly wind; **forecasts (zone ETAs, containment estimates) assume the current hour's wind persists** | Model (stated approximation) |
| Re-solves | n/a | On a new fire, a contained or closed fire (it stops spreading from that minute), a wind or moisture change (a newer Studio publish with other conditions), and when fewer than 120 min of lookahead remain. The board clock holds while a required solve runs, so results do not depend on machine speed; with unchanged weather a resumed solve reproduces an uninterrupted one exactly | Model |
| Fire shape and numbers | Analytic ellipse | The fire's own footprint in the arrival field. Area = its cells. Perimeter = its cell edges facing ground that can still burn (not rock, water, other fires' burned ground) x cell size x π/4 (mean staircase-to-smooth ratio, Cauchy-Crofton). Head figures = the solver's Rothermel rate, flame, heading and L:B at the leading front cell (the burned cell farthest from the ignition that still faces unburned fuel); a crowning or torching leading cell holds against no line (as `studio/initialAttack.ts`). Zone contact and overrun read the field over each zone's cells and at its core cell | Model |
| Units | 6 synthetic strike teams of 5 engines at 5× the Studio engine rate (about 50 m/min each) | Departments built by `response/fleet.ts` `buildFleet` from the CAL FIRE facilities layer (agency, unit code, staffing) with **ASSUMED** counts per facility, aircraft at helitack and air attack bases, and a mutual-aid pool of the off-board stations ([response-model.md](response-model.md)). When the drill has a scenario resource snapshot (`model.ts` `buildBoardUnits`), its engines available at T+0 are the board's engine units, one department per snapshot station (Camp 8, Berkeley Hills 25, Palisades 12; synthetic engines, see "Resource snapshot" below); the layer supplies the hand crews, dozers, aircraft and the mutual-aid and state pool. Layer engines within `SAME_STATION_M` (300 m, **ASSUMPTION**: the same station) of a snapshot station are dropped; other on-board layer engines join the pool and answer as closest resources. Without the layer, the fixed roster (6 Type 3, 3 Type 1 engines, 2 crews, 1 dozer) stands in, and hand crews and dozers are the assumed extras labelled "assumed (not in the snapshot)". With no snapshot the units come from the layer, labelled `NO_SNAPSHOT_FLEET_LABEL` ("No resource snapshot for this drill — units from the CAL FIRE facilities layer (assumed counts per facility)"), or from the roster when the layer is also missing ("No resource snapshot for this drill — using assumed roster"). The board clock starts at the snapshot's `scenario_time`. Line from the sourced tables for the fuel and slope: about 2.7, 5.0, 2.2 and 10.7 m/min in SH5 (`studio/apparatus.ts`: PMS 465 p.164, Broyles 2011, PMS 465 p.140). Turnout 80 s (paid) or 120 s (other) for engines (an engine of unknown staffing, as every snapshot engine, uses `engineTurnoutMinutes(null)`), mobilisation 30 min (crews) and 60 min (dozers) | Sourced rates; assumed counts |
| Response | The AI commander or a person sent every unit | **AI agent only** (again): the board makes no decision itself. No run card, automatic aircraft, resource or extended-attack order or station move-up; every dispatch, order, release and evacuation is an order from the AI commander or the drill controller (`model.ts` `applyOrder`: `send_crew` with a crew or aircraft id, `release_crew`, `order_resources`, `order_evacuation`, `cancel_evacuation`, `lift_evacuation`: an order is lifted only by the commander, once the fire model allows it, [All clear](#all-clear-lifting-an-evacuation-order)). The response model supplies the mechanics: tactic by flame length, seeded line holding, unit states (resting, refilling, out of service, returning), work/rest, water, aircraft cycles, off-road reach, ordered resources arriving, the return to station after containment, fire out or release ([response-model.md](response-model.md#decisions-and-mechanics-on-the-live-board)). The run card (by dispatch level, closest resource, skipping units whose apparatus class cannot reach the target) is computed only as the commander's `recommended_initial_attack`, and an extended-attack stage that falls due is logged and given as `extended_attack_due`. The dispatch level comes from the Studio run's fuel moisture class (`boardMoistureClass`) and wind (`boardWind`); order fill odds from `FILL_ACTIVITY_BY_MOISTURE` (wet and moderate quiet, dry active, critical severe; **ASSUMPTION**). A resting, refilling or out-of-service unit is refused | Sourced structure, assumed counts |
| Holding | Any line held | Contained only when the tactic's line is complete and holds the head flame (units building a line at an attack position do not count toward a direct attack's containment): direct attack within the unit's limit (Hauling chart, PMS 465 p.12: 4 ft hand tools, 8 ft engines and dozers), parallel or indirect up to 11 ft, none above; the holding test draws the flame with a seeded **ASSUMED** spread ([response-model.md](response-model.md)). A fire that its built control lines hold (the solver forecasts no further spread) is contained by the same handling | Sourced limits, assumed spread |
| What is on fire now | Every burned cell drawn as fire until the fire was closed; a contained fire was out 10 min later | Per cell (`demo/fireState.ts`): unburned, burning, burned out or extinguished. A cell burns for the front's half-cell crossing at its normal speed (1/\|∇t\| of the arrival field, upwind differences) plus Anderson (1969) flaming residence 384/σ of its coarsest loaded fuel class (**ASSUMPTION** per class), then is burned out; smouldering is not modelled. Direct-attack units put out burning edge cells within reach at their sourced line rate, where the Byram flame there is within the Hauling-chart limit; the knocked-down edge is inert in the solver with line around it, so it stops advancing. Mop-up units put out burning cells inside a contained fire (**ASSUMPTION** rate). A contained fire is out when nothing of it still burns. Deterministic at any playback speed ([response-model.md](response-model.md#cell-fire-state-and-suppression)) | Sourced rates and residence; assumed per-class rule and mop-up rate |
| Bases | 3 synthetic stations | With a snapshot: its stations (OSM / NIST locations, observed; Camp's four Chico points synthetic), all of them, also those with no available engine. Without one: real CAL FIRE facilities from `GET /api/suppression/bases`: Type 3 engines and the dozer at the nearest CAL FIRE state stations (Paradise, Jarbo Gap, Stirling City, Forest Ranch, Cohasset, Harts Mill), Type 1 engines at the nearest Schedule A stations (Paradise FD 81 and 82, Upper Ridge), crews from Table Mountain Fire Center. Without the local-only bases file: synthetic stations, labelled. The map marks each station | Observed locations |
| Travel | Straight line × 1.3 at 50 km/h | `POST /api/demo/crew_routes`: `livecore.inbound.reach_route` over the drill roads, per apparatus class (`tools.suppression_data.road_access`, rules R01-R12, on each road's OSM tags and DEM grade: "Road access" below), avoiding fire. A unit no allowed road brings to its fire stops at the nearest point it can reach. A base (or a target, such as an attack position in the wildland) off the network gets a straight-line × 1.3 leg at the heavy-apparatus secondary-road cap to (from) the nearest road node. Units only move along that road line: a unit dispatched before its road time is known waits at its base (travel `pending`) and sets off, timed from its dispatch, when the leg arrives; a trip with no road route releases the unit with the router's reason. **ASSUMPTION** straight line × 1.3 at 60 km/h only for options and ETAs shown before a road time is known. On top of the leg the board applies the unit's turnout (from rest only), the congestion factor and a seeded trip variation (`model.ts` `dispatch`, `travelMinutesTo`), and reroutes a unit whose road fire cuts (`rerouteTeam`: it waits where it stands for a new road leg; the straight-line fallback is never a trip; at most 3 reroutes per trip with a backoff, then the trip is reported blocked by fire and the unit stays free where it stopped, [response-model.md](response-model.md)). The board clock holds while a dispatched, returning or moving-up unit waits for its road leg (`model.ts` `roadLegsAwaited`, `useCrewRoutes.ts` `createRoadLegHold`), as it does for a fire solve, so a unit sets off at the board minute it was sent whatever the router's latency or the playback speed; each leg holds the clock for at most 10 s of real time (`ROAD_LEG_HOLD_MAX_MS`, **ASSUMPTION**), after which the clock runs on and the unit waits as before (console warning; timing then depends on the router). Sending a unit home, moving it up and covering a station are road trips too (`driveHome`, `startRoadTrip`) ([response-model.md](response-model.md)) | Model |
| Departure | Uniform over 45 min after an order, everyone leaves | Exponential delay, mean 93 min, counted from the minute the order takes effect: now, or the `start_minute` it was scheduled for (Camp awareness-to-departure, Grajdura 2022; the exponential shape is an **ASSUMPTION**). 92% of households with a vehicle leave on an order (**ASSUMPTION** inside the sourced 0.87-0.97). See "Staged evacuation orders" below | Sourced mean and range |
| Shadow evacuation | With no order, 30% of households with a vehicle left once fire touched the zone (**ASSUMPTION** inside the sourced 0.29-0.75), on the zone's best route | **Cue-driven self-evacuation** (`demo/selfEvacuation.ts`, both board modes): with no order, households with their own vehicle (not the drill's given cars) decide to leave on cues read from the fire solver (any fire, reported or not) and from neighbours: fire forecast at the zone edge within 60 min 15.5% (0.367 x 0.423, Zhao et al. 2022 Kincade, derived; lead time **ASSUMPTION**), most neighbours within 2 km gone 29.1% (Wong et al. 2020 Table 11 shadow share; radius and 50% threshold **ASSUMPTION**), fire in the zone 36.7% (shadow + wait-and-see, Studio's grounded draw), fire within 500 m of the core 92% (Studio's near cue). Each rise departs on the board's exponential curve (mean 93 min; 45 min after the near cue, derived from McGee 2018 p. 1157), +18.5 min at night for a zone's first cue (NIST TN 2174), binomial spread per zone from its own seeded stream. Self-evacuees take the zone's best open route and load the roads. An order sends 92% in total, the rest on its own curve. The observation shows `self_evacuated` and `self_evac_cue` per zone; `self_evacuation` events log a zone's new cue | Sourced shares, assumed cue thresholds |
| No vehicle | none | The snapshot's `needs_transport_households` per zone (Camp: ACS, 1,172 over 43 zones, the replay bundle's demand table; packages: synthetic, 1,586 Berkeley, 672 Palisades); without a snapshot the environment's ACS count (Camp) or none. They stay home and are shown as "No vehicle, at risk" when a fire touches or is forecast to reach their zone | Observed (ACS) |
| Congestion | not modelled | One traffic state. Households: evacuating vehicles load their route's road segments each minute; BPR volume-delay on the flow that passes plus a point queue where demand exceeds capacity, on the drill roads' per-segment assumed capacities (see "Evacuation traffic" below). Fire units read the same evacuees' flows (`board.traffic.zoneFlow`, the zones' departure flow in veh/h, `boardResponse.ts` `flowIndex`): `response/travel.ts` slows a responder's road leg where it runs within `SHARED_ROAD_M` (60 m) of a route in use by a leaving zone, by a BPR factor against a fixed `CAPACITY_VEH_PER_HOUR` of 1,700 veh/h per direction (**ASSUMPTION**, HCM 2010 two-lane highway; opposing flow weighted `OPPOSING_FLOW_WEIGHT` 0.5, **ASSUMPTION**), not the segment's own capacity and not the evacuees' queues ([response-model.md](response-model.md)) | Model on assumed capacities |

## Resource snapshot

The board starts from the drill's scenario resource snapshot (`GET
/api/live/incidents/<id>/snapshot`, [scenario-snapshots.md](scenario-snapshots.md)), read once
per incident by `useCommandBoard.ts` and again on **Reset board**. The board is built only when the
command data and the snapshot answer of the same `incident_id` have both arrived; an incident
switch or Reset board rebuilds it (units free at their stations, every household home). A
snapshot re-seeded while a board runs is picked up at the next Reset board.

- **Households** (`model.ts` `createBoard` / `zoneState`, matched by `zone_id`): `households`,
  `occupants` (persons), `evacuating_vehicles` (what the households drive out with, the traffic
  model's demand), `needs_transport_households` and `_occupants` (carless: stay home, need
  transport), `vehicles` (owned, shown only). A board zone the snapshot does not list keeps the
  drill file's households and vehicles with persons unknown.
- **Persons** (`zonePeople`): carless households' persons stay home; the other persons follow
  their households, `floor(households x vehicle persons / households with a vehicle)` for those
  left and those out (**ASSUMPTION**: equal persons per vehicle household within a zone; the
  snapshot gives zone sums). Caught persons are frozen at the overrun. Unknown occupants (`null`,
  or `unknown_households > 0`) stay `null` (shown as unknown), never 0, with `known_occupants`
  and the unknown households alongside.
- **Units** (`snapshotTeams`, `buildBoardUnits`): one per engine with `status_at_start: "available"`, id = its
  `engine_id` (`S04-E2`, `ST81-E1`), at its station; `type3_engine` runs as `engine_t3`,
  `type1_engine` as `engine_t1` (`realism.ts` `SNAPSHOT_ENGINE_KIND`, sourced rates in
  `studio/apparatus.ts`). Committed and out-of-service engines are on the station records
  (`board.stations[].engines`, `stationRecords`) but never units, so a station with no available
  engine has no unit. The snapshot has no hand crews or dozers, so `realism.ts`
  hand crews and dozers come from the CAL FIRE facilities layer (`buildFleet`) when it loaded. Without the
  layer, `realism.ts` `ASSUMED_EXTRA_UNITS` keeps the fallback roster's 2 Type 1 hand crews (C1, C2) and Type 2
  dozer (D1), labelled "assumed (not in the snapshot)", at the nearest CAL FIRE crew camp /
  state station when the bases layer loaded, else at the snapshot station nearest the
  drill centre (Camp ST81, Berkeley S03, Palisades S09). One department per snapshot station with an
  available engine; layer engines within `SAME_STATION_M` of a snapshot station are dropped (see the
  Units row above). The T+0 out-of-service draw skips snapshot engines.
- **No snapshot** (404 `no_snapshot`, network error, timeout): the board still runs, on the
  assumed roster and the drill file's counts, with `board.resources.label` "No resource snapshot
  for this drill — using assumed roster" and the reason (`board.resources.problem`,
  `useCommandBoard().resourceNotice`, also put in the page notice).
- **One assignment per unit.** A unit is on at most one fire and one line. `send_crew` on a unit
  en route or on scene reassigns it: it is released from its fire or line first (logged "released
  from ... to be reassigned"), then sent; a trip with no road route changes nothing. Sending it
  where it already is is refused.
- **Return to station** (continuous board: units cycle station, fire, station with no end
  state). A unit released for any reason (its line finished, its fire out after mop-up or closed
  by hand, `release_crew`, a dispatched trip with no road route, its unfinished line dropped)
  drives back to its home station on a road leg from `POST /api/demo/crew_routes` (its class's
  roads; an end off the network as `road_offboard`; never a straight line), status `returning`,
  on no fire, and is `available` at the station on arrival (logged "back at ... and
  available"). While its road home is not known it waits where it stands (`travel: "pending"`);
  with no road route home it waits and asks again every 10 board min (`RETURN_RETRY_MINUTES`).
  A returning unit can be sent again, with no turnout: its trip is keyed from where it was at
  the start of the current 5 board min (`RETURN_KEY_MINUTES`, `model.ts` `tripStart`, so road
  legs are reused), and it turns back along its road home to that point (the minutes since,
  `leadMin`) and then drives the leg; options list it with that time. Releasing a returning unit
  is refused ("already returning"). The observation gives `crews[].status: "returning"`,
  `eta_home_min` (null while its road home is not known) and `totals.crews_returning`; the wake
  monitor treats a unit leaving its assignment as freed. `checkBoardInvariants`: a returning
  unit is on no fire or line and has a trip home. `checkBoardInvariants` (run after every step in dev builds,
  `console.error` once per message) checks that no unit is in two fires' crew lists, a line's
  units are on its fire, engine units are available snapshot engines, no unit is on a straight-line trip, and households and
  persons balance (home + on the road + out + caught = total, nothing negative).
- **Commander** (`observation.ts`): crews carry `engine_id`, `station_id`, `assumed`; zones
  `occupants`, `known_occupants`, `unknown_occupant_households`, `people_home` / `_en_route` /
  `_out` / `_caught`, `needs_transport_households`, `needs_transport_occupants(_home)`,
  `demand_source`; totals `people`, `people_known`, `people_caught_total`,
  `needs_transport_people_at_risk`; `inputs.stations` and `inputs.demand` say where they come
  from.

Measured (2026-10-25, scratch script on the stored snapshots, synthetic flat SH5 ground, half the
zones ordered at T+0 and two 20 mph Studio ignitions, 480 min): units = available engines + 3
(Camp 8 + 3, Berkeley 25 + 3, Palisades 12 + 3); stations with no available engine (Camp SYN1,
Berkeley S02, Palisades S02 and S08) have no engine unit; households and persons balanced at every
minute (e.g. Berkeley T+483: 19,882 = 14,388 home + 24 on the road + 1,787 out + 3,683 caught;
49,112 persons = 35,540 + 61 + 4,405 + 9,106); a second send of a dispatched engine reassigned it
(on one fire's list only), a third was refused.

## Evacuation traffic

The board's own traffic model (`app/src/demo/traffic.ts` maths, `model.ts` "evacuation traffic"
glue). It is not the traffic twin (`sim/traffic.py`): the board's households are not in the
twin, so the board runs this small deterministic model on the same drill roads instead.

- **Roads.** `POST /api/demo/routes` now gives each option `segment_ids` and the answer a
  `segments` table (`{name, length_m, lanes, capacity_veh_h, free_flow_min}` by id;
  `app/backend/api/demo.py` `route_segments`). A segment is a maximal run of a route's directed
  drill edges that every route of the answer uses all of or none of, with one capacity, lane
  count and name, so two zones on the same stretch list the same id. Ids are per answer; on each
  new answer the board moves every leaving zone onto the newest route to its destination
  (`setRoutes`), so loads keep matching. Option `destination_capacity_veh` is the bundle's
  destination capacity (from the safe area's capacity since dispatch-area/6; null for a map-edge
  exit). The request may carry `excluded_destination_ids`: destinations the board closed
  (`demo/safeDestinations.ts`: the fire is forecast to reach the road node or within 300 m of it
  within FORECAST_MINUTES, or vehicles sent reach `capacity_veh`); no route goes to them.
- **Capacity** (veh/h, one direction, all lanes) is the bundle edge's `capacity_veh_per_hour`:
  lanes x an assumed per-lane capacity by OSM class. Camp: `sim/traffic.py` `_HIGHWAY_DEFAULTS`
  (motorway 2,000, trunk 1,800, primary 1,600, secondary 1,200, tertiary 1,000, unclassified
  700, residential 600, service 400 veh/h/lane; "rough HCM-style planning values"). Studio drill
  packages: `app/backend/api/dispatch_area.py` `CAPACITY_PER_LANE_VPH` (motorway 1,900, trunk
  1,600, primary 1,200, secondary 1,000, tertiary 800, other 600; lower than textbook values for
  narrow hill roads). An edge with no capacity gets lanes x 600 (`DEFAULT_CAPACITY_PER_LANE_VPH`,
  as `sim/twin.py`). These are **assumptions**, not observed counts.
- **Vehicles.** A departing household takes the snapshot zone's `evacuating_vehicles` /
  households with a vehicle (1-2: the snapshot caps a household at 2 cars taken); without a
  snapshot the drill file's zone vehicles / households with a vehicle (at least 1,
  **ASSUMPTION**). Carless households still stay home.
- **Loading.** Every whole simulation minute the vehicles that left each zone in that minute
  (from the analytic departure curves) load every segment of the zone's current route at once
  (static loading: a vehicle counts on its whole route from departure, not where it is).
- **Moving time** per segment is the BPR function (Bureau of Public Roads, *Traffic Assignment
  Manual*, 1964): t = t0 (1 + 0.15 (v/c)^4), on the flow that passes (v at most c, so at most
  +15 %), capped at `CONGESTION_MAX_FACTOR` = 10 (`livecore/routing.py`) as a guard.
- **Queues.** Demand above capacity waits in a deterministic point queue per segment (Vickrey
  1969 bottleneck model): q(t) = max(0, q(t-1) + inflow(t) - capacity), per minute over the
  departure curves of the zones currently routed over it. The wait is the largest queue delay
  (queue / capacity) on the route; queues in series are not summed because static loading gives
  every segment the full inflow. BPR alone could not show a jam: it scales a segment's free-flow
  time, and bottleneck links are often a few hundred metres long.
- **Arrival.** A cohort's arrival is fixed when it departs: departure minute + moving time +
  wait then, first in first out per zone. Households home when fire reaches the zone core are
  still caught; vehicles on the road are not caught (as before). Counts are conserved: home +
  on the road + out + caught = households.
- **What the commander sees** (`observation.zones[].options[]`): `free_flow_min`,
  `congested_eta_min` (current loads and queues plus this zone's own departure rate, as if
  ordered now when not ordered), `vehicles_on_route_now`, `bottleneck` (the option's segment
  slowest to pass everything committed to it: other zones' vehicles on the road or still to
  leave on routes through it, plus this zone's), `clearance_min` (that load / capacity),
  `margin_min` = `fire_core_eta_min` - (`departure_mean_min` + `clearance_min` +
  `congested_eta_min`), `destination_load_vehicles` and `destination_capacity_veh`. Per zone:
  `vehicles`, `vehicles_en_route`, `margin_min` (current destination when ordered, else best
  option). Board: `traffic.vehicles_on_road` and `traffic.worst_segment`. The margin is
  conservative (it adds the mean departure delay to the clearance of the whole zone); it is for
  ranking zones, not a clock. The commander picks a destination and a start minute per zone
  ("Staged evacuation orders" below); the model computes every number.
- **On screen.** Routes in use are drawn on the 2D board map coloured and labelled by their
  delay (Slow at 1.25x free-flow, Jammed at 2x) and widened by the zone's vehicles on the road;
  evacuating vehicles are dots (2D) and small blue cars (3D) placed along the road line of their
  route at the share of their trip time elapsed, one per at least 10 vehicles, at most 400.
  The zone panel shows time in traffic, margin and bottleneck per option.
- **Outcomes on /live** (`app/src/demo/outcomes.ts`, `app/src/live/Outcomes.tsx`, right column), people
  first, households beside them, persons "unknown" (never 0) when a zone's occupants are unknown:
  evacuated = persons whose cohort has arrived (`zonePeople.out`) of all occupants; on the road =
  `zonePeople.enRoute`; a zone is *threatened* when fire has touched it or the forecast reaches any of
  its cells within `FORECAST_MINUTES` (`model.ts` `zoneThreatened`, the same rule as the totals'
  "at risk"); still in threatened zones = persons home there (carless included); unable to reach
  safety = caught (zones still overrun) + carless persons home in threatened zones (no pickup
  model); the progress bar is persons out of everyone in the threatened zones (overall when none);
  arrivals by destination group arrived cohorts by the destination each left toward (`Trips.dest`,
  recorded at departure); a *close call* is a cohort that left home less than 15 min
  (`CLOSE_CALL_MINUTES`, a display **ASSUMPTION**) before fire reached its zone's core
  (`overrunAt`), from the whole-minute cohort departure times, so a margin can read up to 1 min short.

### Staged evacuation orders

Most people leave on an order (some self-evacuate on their own cues, see the Shadow evacuation row), and an order
can start later than it is given, so the commander can stagger zones by fire ETA instead of
putting every zone's cars on a shared road at once (`model.ts` `applyOrder`, `orderEvacuation`,
`startScheduledEvacuations`).

- **Order contract** (`contracts.ts` `DemoOrder`, `model.ts` `BoardOrder`, `demo.py` tool schema):
  `{type: "order_evacuation", zone_id, destination_id, start_minute, reason}`. `start_minute` is
  an **absolute whole board minute** (the T+ clock; `null` or absent = now), at most
  `MAX_SCHEDULE_AHEAD_MINUTES` = 240 after the clock (**ASSUMPTION**, a board rule: twice the
  forecast horizon). `{type: "cancel_evacuation", zone_id, reason}` drops a scheduled order that
  has not started. One decision may hold several, e.g. at minute 40 Z1 `null`, Z2 `60`, Z3 `75`
  (one order per zone per decision).
- **Validation.** The server (`demo.py` `normalize_order`) rejects a non-integer `start_minute`,
  one before the observation's `clock.minute` or more than 240 min after it, and
  `cancel_evacuation` on a zone whose `order.status` is not `scheduled`. The page (`applyOrder`)
  checks again at the board minute the decision arrives: the clock keeps running while Claude
  thinks, so a start the clock has already reached leaves now, and the log says so ("its start
  T+00:45 had passed: leaving now"); more than 240 min ahead, non-finite, an overrun zone, an
  unknown destination, a duplicate schedule, a start minute or a cancel on a zone already leaving
  are refused with a reason. Re-issuing `order_evacuation` for a scheduled zone replaces the
  schedule (new minute or destination, or now); for a leaving zone it redirects, now only.
- **Model.** A scheduled order is `zone.pendingOrder` (start minute, route, who, when). The
  board clock lands exactly on each start minute (`step`), where the order takes effect with
  `orderedAt` = the start minute itself, so departures, traffic loads and arrivals do not depend
  on the tick size; the route followed is the newest route to the chosen destination
  (`setRoutes` re-keys scheduled routes as it does leaving ones). From then on the departure
  curve, compliance, traffic and catch rules are the ones above. A zone whose core fire reaches
  before its start minute is caught as an unordered zone and the schedule is dropped (logged with
  the overrun). Invariant (`checkBoardInvariants`): a schedule never sits on a zone already
  leaving or overrun, and no household leaves a zone with no order in effect.
- **What the commander sees** (`observation.zones[]`): `status` (`no_order`, `warning`, `scheduled`,
  `ordered`, `overrun`, `lifted`), `order: {status: none | warning | scheduled | leaving | done | overrun | lifted,
  start_minute, starts_in_min, destination_id, margin_at_start_min}` (`model.ts`
  `zoneOrderStatus`; done = every household the order sends out has left and arrived;
  `margin_at_start_min` = the scheduled option's `margin_min` - `starts_in_min`, traffic as now),
  `departure_peak_veh_h` (the flow an order puts on the road at its start: 0.92 x households with
  a vehicle / 93 min x vehicles per household, `orderPeakVehiclesPerMinute`; it decays to half in
  93 ln 2 = 64 min) and `departure_flow_now_veh_h` (`board.traffic.zoneFlow`). Per option:
  `latest_start_minute` (= minute + `margin_min`, the latest start with a non-negative margin if
  other zones' traffic stays as it is now, **ASSUMPTION**) and `scheduled_on_route` (other zones
  scheduled onto that option's road segments: start minute and the vehicles their order will put
  on the road; not in `clearance_min`). `clock.max_schedule_ahead_min` = 240. The monitor's
  order-slack wake counts a scheduled zone's slack from its start minute
  (`fire_core_eta_min` - `starts_in_min` - `departure_mean_min`).
- **On screen.** The zone panel shows "Scheduled T+00:35", the scheduled route and who scheduled
  it, "Evacuate now via" buttons (replace the schedule) and "Cancel scheduled evacuation"; a person
  can order now or cancel, not schedule. The 2D board map labels a scheduled zone "LEAVES T+00:35
  (sim)" with its fire ETA. The /live activity feed logs `evacuation_scheduled` /
  `evacuation_rescheduled` (proposed until the start minute, sub-line "Leaves at T+00:35 (in 20
  min)"), `evacuation_cancelled`, and `evacuation_started` when the start minute arrives (in
  progress, then completed once the zone's order status is done). The outcomes panel splits
  "Still in threatened zones" into "scheduled to leave" (zones with a pending order) and "with no
  order" (neither in effect nor scheduled); persons stay "unknown" when unknown.

Measured (2026-10-24, scratch script outside the repo, synthetic board with no fire: three zones
of 600 households, 50 carless, 900 vehicles, all routed over one 1,200 veh/h segment with 1 + 2 min
free flow; zones kept from reopening). Each zone's `departure_peak_veh_h` is 534. All three ordered
at T+0: peak load 1,594 veh/h on the shared segment, a queue of up to 85.9 vehicles, mean drive
4.45 min (worst 7.60). Staged at T+0, T+40, T+80: peak 1,102 veh/h (534 + 534 e^(-40/93) +
534 e^(-80/93) = 1,107 by hand), no queue, mean drive 3.04 min (worst 3.21). The staged run's
cohorts were identical at 1 min and 0.37 min clock ticks, invariants held at every step, and with
no order no household left. At T+400 each zone had 101 households home (50 carless + 44 who do
not comply + 7 still to leave, as 50 + 550 x 0.08 + 550 x 0.92 x e^(-400/93) = 100.9 predicts).

Measured (2026-10-24, scratch script on the Camp routes with no fire, two 1,000-household zones of
1,700 vehicles each, ordered at T+0, `bg:060070009011` and `bg:060070022004`, whose best routes to
Exit west share a 1,200 veh/h motorway link): alone, the first zone's mean drive is 9.8 min (free
flow 9.8). Both on the shared route: 16.8 and 24.9 min mean, 25.0 and 33.1 min worst, a 287-vehicle
queue at T+60, clearance 112-116 min. Sending the second zone to its other destination (Paradise
Police Department refuge): 9.8 and 14.1 min mean (the second zone still queues on its own 600 veh/h
Almond Street). Mean arrival T+109 / T+117 shared against T+102 / T+107 split.

### All clear: lifting an evacuation order

Code: `app/src/demo/allClear.ts` (`allClearCheck`, `liftEvacuation`, `noteZoneThreats`,
`finishLifts`), wired into `model.ts` (`applyOrder`, `zoneCounts`, `zoneOrderStatus`, `step`).
Once the fire that threatened an evacuated zone is contained, its residents may go home. As every
other decision on /live, this is the commander's: nothing lifts an order on its own. (The old
automatic reopening, `reopenZones`: an ordered or overrun zone reopened after `REOPEN_MINUTES` =
90 with no fire near, now runs only with the rule-based response, `board.response.autoDispatch`,
i.e. scripts.)

- **Eligibility** (`allClearCheck`, simulated). All of: (1) the zone's order is in effect, done,
  or the zone was overrun (`zoneOrderStatus` leaving / done / overrun), not already lifted; (2)
  every reported fire that threatened it is contained or out, and has been for at least
  `ALL_CLEAR_HOLD_MINUTES` = 30 (**ASSUMPTION**, a board rule: a line that has just passed its
  holding test is not trusted at once; real repopulation follows damage and hazard assessment over
  hours to days); (3) no other reported burning fire puts the zone in the evacuation order tier
  now (`evacThreat.ts` `orderTierThreat`, see [Evacuation tiers](#evacuation-tiers-and-warnings)):
  arriving within `ALL_CLEAR_WINDOW_MINUTES` = 360 (**ASSUMPTION**: the solver's whole lookahead)
  and within the latest safe start plus the 30-min decision window, and not expected contained
  45 min before it reaches the zone's core. On /live the observation adds (4): the evacuation
  schedule (with each route's traffic) does not still give the zone tier `order`.
  "Threatened" (`zone.threatFireIds`, recorded every whole minute by `noteZoneThreats`) = a
  reported fire that put the zone in the order tier at some minute, or, while the zone has an
  order in effect or scheduled, reached it within the window without being held by its units'
  containment (so an order is not lifted the moment the forecast moves, only once that fire is
  contained or out). Until 2026-10-25 rule (3)
  blocked a lift for any reported burning fire arriving within 360 min in free burn, and any such
  fire was recorded as threatening: a zone ordered for a small fire stayed ordered while another
  fire, under control or hours away, burned anywhere within six hours of it. Unreported fires neither block
  nor allow a lift (report rule). Reasons are listed when not eligible, e.g. "S1-F1 was contained
  12 min ago (wait 30 min)", "S1-F2 is still burning", "S2-F1 is forecast to reach it in 48 min".
- **Order contract**: `{type: "lift_evacuation", zone_id, reason}` (`contracts.ts` `DemoOrder`,
  `model.ts` `BoardOrder`, `demo.py` tool enum). The server rejects it unless the observation's
  `zones[].all_clear.eligible` is true for that zone (with its reasons), and the page refuses it
  again at the minute it applies (`liftEvacuation`: "Z23: the evacuation order cannot be lifted
  yet: ..."). The zone panel has "Lift evacuation order (all clear)" for the controller, disabled
  with the reasons while not eligible.
- **Effect** (`ZoneState.lift`). The order ends at the lift minute: departures freeze (households
  not yet departed stay home), and every household that left drives back along its route,
  starting at max(its arrival at the destination, the lift) and home `returnMinutes` later, the
  route's free-flow drive time (`RouteOption.eta_min`) at the lift (**ASSUMPTION**: no re-entry
  congestion, return trips do not load the traffic model, and nobody waits before setting off).
  `zoneCounts` gains `returning` and `returnedHome` (included in `home`): out -> returning -> home,
  and home + on the road + out + returning + caught = households (`checkBoardInvariants`; persons
  likewise in `zonePeople`). Households still on their outbound trip at the lift finish it, then
  turn back. Once everyone is home the zone's order is dropped ("Z23: all n households that left
  are back home"); once no active fire's burned ground touches the zone, its touch and overrun
  marks clear (an overrun zone's caught households stay in the run totals, as with the old
  reopening); `ALL_CLEAR_LABEL_MINUTES` = 30 after the lift (display only) the lift record goes and
  the zone is an ordinary quiet zone. A new `order_evacuation` on a lifted zone ends the lift first
  (households still driving back count as home and leave again with the new order: a board
  simplification). A fire overrunning a lifted zone stops the returns (those not home count as out
  again) and the zone shows as overrun.
- **What the commander sees.** Each zone with an order in effect, done or overrun has
  `all_clear: {eligible, reasons, threat_fire_ids, window_min: 360, hold_min: 30}` (null
  otherwise), and `households_returning` / `people_returning`; `decision_aids.all_clear` lists the
  eligible zones with `basis` ("fire S1-F2 contained 45 min ago") and `households_away`. The monitor
  wakes the agent (routine) the first time a zone becomes eligible (`all_clear_eligible`), so the
  all clear is not missed after the fires are out (periodic reviews stop then). The prompt
  (`demo.py`): life safety first, lift only an eligible zone (never one the schedule gives tier
  `order`; one still listed as `warn` is warned next), keep the order when in doubt; returning
  residents re-enter the roads (timed at free flow, not loaded on the traffic model). The baseline
  policy (`scripts/live-eval/baselinePolicy.ts`) lifts every eligible zone not in tier `order`.
- **On screen.** The orange "Leave now" / "LEAVE NOW (sim)" signs go at the lift; the 2D board map
  and the 3D diorama show a neutral "ALL CLEAR (sim) · Z23 · n returning" / "All clear · <zone>"
  label with a thin grey outline and no fill for 30 board minutes, then nothing (a fire forecast to
  reach the zone again shows "At risk"). Legend rows on both. The 3D houses of returning
  households keep their "safe" mark until home, and returning vehicles are drawn on the road
  heading back. The activity feed shows "Claude lifted the evacuation order for Z23 (fire S1-F2
  contained 45 min ago): residents may return.", "All clear: Z23 residents returning home (n
  households, about m min drive back)." and "Z23: n households back home after the all clear.";
  the outcomes panel shows "Returning home" while anyone drives back. Residents' phones: the run
  state sends order status `lifted` (below) and the server publishes the all clear
  ([live-reports.md](live-reports.md#guidance-from-the-live-boards-orders)).

Measured (2026-10-25, scratch copy of the evaluation harness, baseline policy, Berkeley Hills &
Tilden, one synthetic Studio fire at -122.25024, 37.88381, 7 mph from 229°, dry, reported at T+3;
board invariants and `checkRunState` checked every minute, none broken). Z09 (248 households) and
Z16 (210) ordered at T+3; S1-F1 contained T+12, out T+22. Not eligible until T+42 ("S1-F1 was
contained 29 min ago (wait 30 min)" at T+41; a controller lift at T+20 was refused with "contained
8 min ago (wait 30 min)"). The `all_clear_eligible` wake at T+42 led to `lift_evacuation` on both.
Z09 at the lift: 170 home, 10 on the road, 68 out -> 170 home, 10 on the road, 68 returning (run
state: home 170, evacuating 10, safe 68, no waiting / not_leaving); T+50: 241 home (71 back), 7
returning; all 78 back by T+54 (route free-flow 6 min), Z16's 66 by T+56; both quiet zones again
after T+72 (label time over). A new order on Z09 at T+45, with 78 still on their way back, counted
them home (248) and started a fresh departure curve.

## Run state in the database

Code: `app/src/demo/runState.ts` (`boardRunState`, `checkRunState`), `app/src/demo/useRunStateSync.ts`
(transport), `app/src/live/RunStateStatus.tsx` (the status line under the board clock). While a
board runs, the /live controller's browser saves where every zone's households and persons are
to MongoDB, so the database holds the current state of the experiment. Simulated: every count is
a model result.

`PUT /api/live/incidents/<incident_id>/run-state` (controller), body (illustrative values: the
hand-built zone of the scratch check below at T+10):

```json
{"run_id": "board-k2j9x1-3f9a01bc", "board_minute": 10,
 "zones": [{"zone_id": "zone-c",
            "households": {"home": 0, "waiting": 197, "evacuating": 22, "safe": 0, "needs_transport": 11,
                           "not_leaving": 20, "caught": 0, "unknown": 0},
            "people": {"home": 0, "waiting": 507, "evacuating": 56, "safe": 0, "needs_transport": 25,
                       "not_leaving": 52, "caught": 0, "unknown": 0},
            "order": {"status": "leaving", "start_minute": 0, "destination_id": "dest1"}}],
 "totals": {"households": {"...": 0}, "people": null}}
```

`board_minute` is simulation minutes since T+0 (fractional, the board clock). `people` is null
when the zone's occupants are unknown (no snapshot, or households with unknown occupants), never
zeros; `totals.people` is null when any zone's is. `order.status` is model.ts `zoneOrderStatus`
(`none`, `scheduled`, `leaving`, `done`, `overrun`, `lifted`); `start_minute` is the scheduled
start or the minute the order took effect, or for `lifted` the minute it was lifted (then
`destination_id` and `route` are null and `issued_by` is who lifted it). `order.route` (via, eta_min, distance_m, safety, line rounded to 5
decimals; null with no order) and `order.issued_by` (`ai_agent` / `controller`: the actor of the
zone's latest order event, or the scheduled order's actor; null when unknown) let the server
publish the order as the zone's resident guidance ([live-reports.md](live-reports.md#guidance-from-the-live-boards-orders)).
The page adds `previous_run_id` (see Sync below). `DELETE
...?run_id=<id>` clears that run; `GET` returns the stored doc (404 when none).

How each status maps from the model (W = households with a vehicle, `withVehicle`; D = households
departed, `departed`; L = households the order sends out in the end, the limit of
`floor(W x ORDER_COMPLIANCE x share)` as the departure share tends to 1, i.e. `ceil(W x 0.92) - 1`):

| Status | Households | Model field |
|---|---|---|
| `caught` | home when fire reached the zone core | `zone.caught` while `zone.overrunAt` is set; persons `zone.caughtPeople` |
| `evacuating` | departed, cohort arrival still ahead | `zoneCounts.enRoute`, persons `zonePeople.enRoute` |
| `safe` | arrived at the route's destination, or driving back home after a lift (no separate status key: safe -> home) | `zoneCounts.out + zoneCounts.returning`, persons likewise |
| `waiting` | order in effect: compliers in their departure delay, L - D; order scheduled: all W | `zone.orderedAt`, `departedShare`, `ORDER_COMPLIANCE`; `zone.pendingOrder` |
| `not_leaving` | order in effect: households with a vehicle that do not comply, W - L | `ORDER_COMPLIANCE` (0.92) |
| `needs_transport` | carless households in a zone with an order in effect or scheduled, or threatened | `zone.noVehicle`; `zoneThreatened` on the "reported" forecasts |
| `home` | no order in effect or scheduled: W, plus the carless when the zone is not threatened | `zone.orderedAt === null && zone.pendingOrder === null` |
| `unknown` | always 0 for households (the model tracks every one); persons are null instead | |

An overrun zone has nobody else home (its carless households are among the caught). Compliance is
applied only once an order is in effect, so a scheduled zone's non-compliers count as `waiting`
until its start minute. A reopened zone (`reopenZones`) is all `home` again. A lifted zone has no
`waiting`, `not_leaving` or `needs_transport`: everyone not away is `home` (`zoneCounts.home`,
which includes the households back home after the lift). Persons follow their
households as `zonePeople` apportions them (`vehiclePersons(n)` = persons of the first n
households with a vehicle): waiting `vp(L) - vp(D)`, not leaving `vp(W) - vp(L)`, carless the rest
of `zonePeople.home`. No rounding of its own: every count is one of the model's integers or a
difference of them. Note: the outcomes panel counts carless households as needing transport only
in threatened zones; the run state also counts them in ordered zones that are not threatened.

Invariants (`checkRunState`; `assertRunState` throws in dev builds and the hook then does not
save): per zone the household statuses are non-negative integers summing to `zone.households`,
with evacuating / safe / caught equal to `zoneCounts` (safe = out + returning) and evacuating +
safe = `departed` - `returnedHome`;
persons are null exactly when `zone.occupants` is, else sum to it and match `zonePeople`; totals
are the zone sums.

Sync (`useRunStateSync`): at most one PUT per 10 s of wall time, and only when the whole board
minute or a count or order changed (a paused board sends nothing); never two requests at once.
Each PUT also carries `previous_run_id`, the run this page last saved for the incident (null on
its first save). The run id is per Board object (`boardRunId`): Reset board, restart and a
landscape change build a new board, so the page PUTs the new run with the old one as
`previous_run_id` and the server replaces the stored run itself; the page never DELETEs on its
own (`clear()` sends `DELETE ...?run_id=<this page's run>` for a caller that wants it). Single
writer: while another Live console owns the incident's run state the server answers 409
`run_state_owned`; the page then shows "Another Live console is saving the run state (since
T+hh:mm); this one is not saving.", retries every 30 s (the server hands over once the owner has
been quiet for 30 s) and saves normally after the next PUT that succeeds. Heartbeat: while a page owns
the lease (its last PUT succeeded) and is visible, it re-PUTs the current state every 20 s even
when nothing changed (a paused board), so the lease only passes to another console when the owner
is closed or hidden (a hidden page sends no heartbeat). Other errors (503 while
Atlas is over quota) back off, doubling up to 5 min, and the Simulation block shows "Run state not
saved: <reason>" (otherwise "Run state saved to database at T+00:42 (simulated)"). Switching
incident deletes nothing.

Measured (2026-10-24, scratch script over T+0..T+900 on seven hand-built zones driven by the
model's own `departed` / `recordCohort`, 25 min drives): 0 invariant failures in 901 minutes. A
250-household zone with 11 carless and 640 persons ordered at T+0 reads at T+10 waiting 197,
evacuating 22, needs transport 11, not leaving 20 (persons 507 / 56 / 25 / 52), and at T+900
safe 219, needs transport 11, not leaving 20, waiting 0 (`zoneOrderStatus` done).

## Predictive attack and control lines

Code: `app/src/demo/attack.ts` (positions, line raster), `app/src/demo/model.ts` (`AttackLine`,
`attackPositions`, `positionOptions`, line building, `heldByLine`), `app/src/demo/fireField.ts`
(`controlLines` in the solve). Units are not only sent to the fire: the commander (and the
selected-fire panel) can send them to build line where the fire is forecast to go.

- **Positions** come from the fire solver's lookahead field for each burning fire, re-planned on
  every solve and every 10 board minutes (`POSITION_REPLAN_MINUTES`): `head_30` and `head_60`, the
  fire's leading front cell 30 and 60 min from now (`fireGeometry` at that minute); `flank_left`
  and `flank_right`, the front cells farthest either side of the spread axis 30 min from now;
  `zone_<id>`, the cell where the fire first reaches each of the (at most 2) zones it reaches
  first within 120 min. Positions the fire reaches within 5 min are not offered. Each lists
  `fire_eta_min` (the field's arrival there), the fuel, the solver's directional spread rate and
  Byram flame facing the line (`spread.ts` breach rule), crowning, and `protects_zone_ids` (zones
  this fire first reaches later, ahead of the line and within its span: a geometric reading of the
  forecast, not a re-solve).
- **Line geometry**: across the forecast spread direction (at a head, the solver's direction of
  maximum spread; elsewhere the arrival-field gradient), through the position, out each side as
  far as the forecast burns across that line within 60 min of reaching the position
  (`LINE_SIZING_MINUTES`), stopping at ground that carries no fire (a natural anchor), plus one
  cell, at most 750 m a side. Rasterised as a 4-connected chain of cells so no solver step slips
  between cells.
- **Orders**: `send_crew` takes an optional `position_id` (validated on the server against that
  fire's listed ids, and again by the page). The unit drives the road route to the position's
  anchor point, parks where its road leg ends, reaches the anchor as its off-road reach allows
  (`lineAccessPlan`: hose within reach, else the crew hikes in and builds hand line, else out of
  reach and builds nothing; see "Why units stand away from the fire"), then builds line outward
  both ways at its sourced rate (`lineMetersPerMinute` at the anchor's fuel and slope; an engine
  crew on foot at the PMS 465 p.39 hand-line rate); several units on one line add up. Without
  `position_id`, the unit attacks the fire's edge as before (perimeter race). When a line is
  finished its units are free; the line stays. When the fire reaches an unfinished line's
  anchor its units pull back (`withdrawFromOverrunLines`). Options per position give
  `arrive_min`, `work_starts_min` (arrival plus the walk in) and `line_done_min` for the free
  units that start building first; units whose road leg ends out of their reach of the anchor
  are left out.
- **Reachability per apparatus class**: road access differs by class (`access_class`, rules
  R01-R12 of [suppression-data.md](suppression-data.md); measured 2026-10-24 on drill
  `studio-f5caaabd2a1e`, scratch script: to -122.19607, 37.87509 in the Berkeley hills every
  Type 1 engine tried, `engine_t1_t2`, gets `no_open_road`, while the nearest Type 3s,
  `engine_t3`, S04-E2/E3, drive 19.2 min).
  `useCrewRoutes.ts` asks `POST /api/demo/crew_routes` (at most 40 legs a request, one request
  at a time) for each burning fire's crew target and each attack position (re-planned positions
  are new targets) from the 2 nearest free units of each access class (`PROBES_PER_CLASS`),
  then the nearest units overall; units already known unable to reach a target are skipped.
  Each leg's answer is cached on the board (`board.travel` / `board.noRoute` by travelKey) and
  noted per class (`board.classReach`, key `access_class|destination id|target lon,lat` at 3
  decimals). A class cannot reach a target when its legs there failed for a reason at the
  target's end (`no_open_road`, `no_access`, `target_in_fire`, `target_off_network`) from 2
  distinct origins, or from every origin its free units stand at, and none succeeded
  (`model.ts` `classBlocked`; two origins guard against one station in a pocket of roads the
  class cannot leave). Fire and position `options` list only crews that can reach the target,
  with `route: "road"` (turnout + road leg for every crew) or `"estimate"` (some crew's road
  leg not known yet: straight line x 1.3 at 60 km/h, **ASSUMPTION**); `unreachable_classes:
  [{access_class, kinds, reason}]` says which apparatus cannot use the roads there, and
  `crews[].access_class` names each crew's class. An order for a crew whose class cannot
  reach the target (or whose own leg failed) is refused at once with the reason; no dispatch
  waits on it.
- **Line in the spread model**: every built cell becomes a solver control line
  (`spread.ts ControlLines`) from the minute it was finished, holding flames up to the builder's
  Hauling-chart limit (crown fire breaches any line; embers still fly over). The board re-solves,
  resuming from the burned ground, each time a line passes another 100 m (`LINE_RESOLVE_CHUNK_M`)
  or is finished; the clock lands exactly on those moments and on units' arrival at a line, so a
  run is the same at any tick size. Forecasts (zone ETAs, positions) then include the line. A fire
  with line is **contained** when the solver, with its line, forecasts no further spread to its
  horizon (at least 2 h ahead).
- **Measured** (2026-10-24, scratch script, Berkeley Hills & Tilden 507 x 507 cells of 23.7 m, one
  Studio ignition in GR2 grass at -122.2241, 37.92762, Dry moisture, wind from 45°, positions at
  T+30, all positions ahead of the fire):
  - 10 mph: head_30 / head_60 lines 237 / 260 m, fire there in 29 / 58 min, head flame 1.7 ft.
    A head_60 line built at T+30 (solver only) cuts the forecast area at T+150 from 13.4 to
    5.8 ha and at T+390 from 60.2 to 44.6 ha. On the board, E1, E2 and D1 sent to head_60 at
    T+30 finish its 260 m at T+53.5 (three re-solves for line), and the fire is 35.5 ha at T+360
    against 55.0 ha with no units; head, both flanks and head_30 together (eight units) leave it at 10.1 ha, still
    backing slowly at the heel (not contained). Direct attack with the same units contains this
    small fire at 1.6 ha (T+65). Tick 0.2 and 0.73 min give identical areas and line times.
  - 25 mph: head_60 falls in timber litter that crowns (`crowning: true`); a line there changes
    the T+390 area by 0.2 ha (51.4 to 51.2 ha), which is the model's answer for a crowning head.
    A zone_Z24 line cuts T+150 from 27.1 to 12.6 ha.
  - Solves on the board with line: about one per 100 m of line (16 for the four lines above),
    about 50 ms each with one fire.

## Why units stand away from the fire

Code: `app/src/demo/unitActivity.ts` (`unitActivity`, `unitSpotLabel`: what each unit is doing and
how far it is from its fire, for the map labels), `model.ts` (`lineAccessPlan`, `lineWorkers`,
`withdrawFromOverrunLines`), `boardResponse.ts` (`accessWorkPlan`, `fireEdgeSample`).

**Measured** (2026-10-25, scratch copy of the evaluation harness with a per-unit probe every 10
board minutes, drill `studio-f5caaabd2a1e` on Berkeley Hills & Tilden, Studio fire 'Three fires
(illustrative demo)' F1 at -122.24292, 37.86686, 25 mph from 45°, critical moisture, seed 1,
`--fast`; distance = unit to the nearest burned cell of its fire):

| Why it is there | Spread policy (all units over head_60, head_30, flanks, the rest direct) | Baseline policy (decision aids) |
| --- | --- | --- |
| Driving from its station (label `→ S1-F1`) | direct: median 1.9 km, max 4.1 km; to lines 0.7-1.7 km | to head_30: median 2.6 km, max 5.2 km (22 units, "all units" package) |
| Direct attack, parked at the heel anchor | all 18 at one road point 72-99 m from the edge; 120 m from the burned area | 123-134 m |
| Building line ahead of the head (`head_60`, `head_30`) | head_60 830 m ahead at T+10 (fire there in 43 min), 500 m at T+20; head_30 240-490 m | head_30 181 m, head_60 130-217 m |
| Building line on a flank (`flank_*`) | 10-42 m | 390-499 m |
| Still building after the fire reached the anchor (before the fix) | head_60 36 m, head_30 13 m, until the line ran out | none |

So the far units are, in order: driving (kilometres, while the label says `→ S1-F1`), building
an indirect line where the head is forecast in 30-60 min (a few hundred metres to about 0.8 km
ahead), or anchored at the heel 100-130 m off the burned edge while the head runs away from them.
In this drill the road end was within 43 m of every line anchor and 99 m of the heel, so parking
was not the cause here; with sparser roads it can be (the router snaps a target to a road node up
to 1 km away and stops a class short by up to 3 km, `livecore/inbound.py`).

**Against practice** (NWCG Incident Response Pocket Guide, PMS 461, 2022; S-130/S-190, S-215,
S-290; Fire Behavior Field Reference Guide, PMS 437, Hauling chart):

- Realistic: driving in from stations a few km away; anchoring at the heel and working the flanks
  ("anchor, flank and pinch"; Watch Out 8 is building line without a safe anchor point); indirect
  line set back from a fast head far enough to finish it before the fire arrives (here 0.2-0.8 km
  for a 30-60 min lead), with the Hauling chart's limits (control at the head probably
  ineffective above 8 ft flame, ineffective above 11 ft) shown on each option; engines confined
  to roads they can drive, with hose reach (PMS 200 minimum hose) and a crew hike beyond it;
  structure protection at the zone edge the fire reaches first (`zone_<id>`, S-215 triage).
- Not realistic, fixed: a crew parked away from its line built it at once from the road end
  (now it walks in first, or is out of reach and builds nothing, and options count the walk);
  crews kept building where the fire had already arrived, and the overrun line stayed listed as
  a position (LCES and the Standard Firefighting Orders: crews disengage to a safety zone; now
  they pull back and the position is re-planned). Measured after the fix (same drill and fire,
  scratch check at T+12 with three Type 3 engines sent to head_30, 746 m of line, fire there in
  23 min, road legs ending 0, 250 and 600 m from the anchor): the first two use hose (within
  305 m) and build from arrival at 8.05 m/min each; the third parks 600 m off, hikes 16 min and
  then builds hand line at 1.01 m/min (it used to build at 8.05 m/min from the road end at once).
  The fire reaches the anchor at T+35 with 276 m built: all three pull back, the overrun line
  leaves the list and head_30 is re-planned 12 min ahead of the fire, and a new send there is
  accepted (before: 12 orders refused as "Fire has already reached" in the spread-policy run).
  In the spread-policy run, no unit stood on a line after the fire reached its anchor (before: 5
  samples at 13-36 m); burned area and containment were unchanged (19.4 ha, contained T+93 vs
  T+94).
- Not realistic, not changed (listed for the decision aids and the prompt): every direct-attack
  unit parks at the one heel point and never progresses along a flank (with 305 m of hose most
  of them work the same few hundred metres of edge; the reach cap keeps the line count honest);
  the "all units" decision aid can send 20+ engines to one short line (a strike team is 5 engines
  under a leader, ICS span of control 3-7); a frontal line across a 25 mph head is offered
  whenever it is forecast to finish in time (Watch Out 10, frontal assault, and 11, unburned fuel
  between you and the fire, call for burnout and lookouts that the board does not model); there
  are no staging areas or trigger points.

**Labels.** The 3D board labels each spot with `unitSpotLabel`: the ids on each job and the job,
e.g. `S03-E1 S06-E1 · building S1-F1 head_60 line 830 m ahead of the head · 35/722 m`,
`S04-E3 · parked, crew hiking 600 m to its S1-F1 head_30 line · 17 min`,
`S01-E1 · driving to S1-F1 · 7 min`, `S05-E1 · hose line on the S1-F1 edge (120 m away)`.
`unitActivity(board, team)` returns `{kind, label, fireId, positionId, workPoint, fromFireM}`:
`kind` one of `awaiting_route`, `rerouting`, `driving`, `hiking_in`, `building_line`,
`direct_attack`, `out_of_reach`, `no_edge_in_reach`, `refilling`, `resting`, `returning`,
`moving_up`, `blocked_by_fire`, `out_of_service`, `available`; `workPoint` (WGS84) is the line's
anchor or the nearest point of the fire's open edge when that is not where the unit stands (for
a leader line); `fromFireM` is ground metres to the fire's open edge. The observation adds
`crews[].from_fire_m`, `attack_positions[].from_fire_m` and `options[].work_starts_min`.

## Run metrics, decision aids and the evaluation harness

### Run metrics (`app/src/demo/scoring.ts`)

Pure functions over the board; the /live outcomes panel shows "Homes burned", the commander's
observation carries them as `outcomes`, and the harness reports all of them.

- **Casualties (caught)**: households and persons still home when fire reaches their zone's core
  (the board's catch rule, `model.ts`). `caughtBreakdown` splits a zone's caught households by why
  they were home: `no_vehicle` (carless; the board has no pickup), `no_order` (no order in effect by the
  overrun and not gone on their own cues: self-evacuation, `demo/selfEvacuation.ts`), `stayed_despite_order` (the 8% of ordered households with a vehicle that do
  not comply, `ORDER_COMPLIANCE` 0.92) and `ordered_too_late` (complying households still inside
  their departure delay). Only the last two depend on the commander's timing, and only the last
  can be driven to zero by ordering earlier. Persons apportion vehicle persons evenly per
  household with a vehicle (rounded per part).
- **Unable to reach safety**: `outcomes.ts` `unable` (caught in zones still overrun plus carless
  persons home in threatened zones).
- **Homes burned**: the board carries no household points, so each zone's households are spread
  evenly over its developed cells (FBFM40 91; a zone without any: its burnable cells), and
  homes burned = households x the share of those cells burning or burned out. Cells crews put
  out before they burned out count as "reached, saved". **ASSUMPTION**: homes uniform over
  those cells.
- **Area burned** (all fires, removed ones included), **containment and out minutes** (the
  harness records each fire's report, containment and out minute).

### Decision aids (`app/src/demo/decisionAids.ts`, observation `decision_aids`)

Model output the commander chooses from; Claude never computes these numbers.

- **Evacuation schedule** (`evacuationSchedule`): every zone a reported burning fire reaches
  within the solver's lookahead (360 min) in the free-burn field (line already built is in the
  field; a containment that has not happened is not assumed in the ETA), in tiers: see
  [Evacuation tiers and warnings](#evacuation-tiers-and-warnings).
  `latest_safe_start_minute` = now + core ETA - (departure lead + clearance_min + congested
  drive) - `EVAC_SAFETY_MARGIN_MIN` (30 min). The departure lead is the time for
  `EVAC_TARGET_DEPARTED_SHARE` (90%) of complying households to leave under the exponential
  departure curve (mean 93 min): 93 x ln 10 = 214 min. Both are **ASSUMPTIONS** (planning
  targets). `recommended_start_minute` is now when that is already past (`too_late`, "order now")
  and otherwise the earliest minute (5-min steps) the zone's departure peak fits every road
  segment of its route beside the decaying departure flows of zones already leaving or planned,
  never after the latest safe start (`over_capacity` when it cannot). Each entry gives the
  expected caught persons if ordered now and at the recommended start. With the 214-min lead,
  almost every zone within reach of a fast fire is "order now". Zones on the schedule are listed
  in `observation.zones` so they can be ordered or warned.
- **Strategy recommendation** (`strategyAid`): per reported burning fire, every strategy option
  with the homes the solver's forecast burns by its containment minute (or by the fire reaching a
  finished line, or by the 120-min forecast horizon when it does not contain), whether it is
  containable (contained, or a line finished before the fire with no breach or crown warning),
  and `recommended_strategy_id` = the containable option burning the fewest homes (ties: sooner,
  fewer units). `recommended_send` is that option's units (the fewest the forecast needs) plus the
  run card's closest free units still needed (`initialAttackRecommendation`), so a first attack
  is not sized at the bare minimum of a forecast. `overdue` is set when the chosen strategy is
  still burning `STRATEGY_OVERDUE_GRACE_MIN` (15 min, **ASSUMPTION**) past its predicted
  containment or line-done minute. When nothing contains, or the strategy is overdue,
  `all_units`: a protection line finished before the fire reaches it (no crown fire forecast
  there) in front of the most households not yet overrun, else the perimeter option burning the
  fewest homes (flank last; the homes forecast cannot rank lines, whose effect is only in the
  field once built); every free unit that can reach the fire; the available aircraft; and the
  cumulative sized extended-attack orders of the stages due (at least stage 1,
  `ESCALATION_ORDERS`, capped by `MAX_ORDER_COUNT`) less what was already ordered for the fire.
  `idle_units` lists free units while it burns.
- The decide prompt (`app/backend/api/demo.py`) ranks life safety in proportion to the threat
  (follow the schedule's tiers: leave now only for `order_now`, or a fire plainly outrunning its
  containment toward the zone; `warn_evacuation` for `warn`; withdraw warnings and cancel
  schedules whose zones leave the list), then property (the recommended strategy, or all units), then
  containment (a strategy and initial attack on every new fire, never idle units while a fire
  grows), and tells it to use `monitor.urgency`.

### Evacuation tiers and warnings

Code: `app/src/demo/evacThreat.ts` (the shared threat rule), `decisionAids.ts`
(`evacuationSchedule`), `evacWarning.ts` (`warn_evacuation`), `allClear.ts`. Until 2026-10-25 the
schedule listed every zone any reported burning fire reached within 360 min of free burn and,
because the 214-min departure lead plus the 30-min margin put almost every such zone past its
latest safe start, said "order now" for all of them: a 0.06 ha litter fire that the first engines
contained in minutes had its two neighbouring zones (Z09, Z16 on Berkeley Hills) ordered out at
T+3 and kept ordered while other fires burned. The schedule now answers in proportion to the
threat. Every number is a board model result; the thresholds are **ASSUMPTIONS** (board rules,
not sourced), named in `evacThreat.ts`:

- **Threat** (`threat`). `if_containment_fails` when every reported burning fire reaching the zone
  is expected contained at least `EVAC_CONTAINMENT_MARGIN_MIN` = 45 min (15 min overdue grace + 30
  min safety margin) before its free-burn arrival at the zone's core (`contained_by_minute`);
  otherwise `free_burn`. The containment estimate is the units on the fire
  (`currentContainment`, direct attack, including units en route), none when the chosen strategy
  is overdue; for a fresh fire with no strategy and no unit, the strategy aid's recommended
  perimeter option (`containedInMin`). The core, because the board catches households still home
  when fire reaches the core; a fire other than the core's first arrival uses max(its arrival at
  any zone cell, the core's earliest arrival), a lower bound. Life-safety trade: if that
  containment fails, the failure shows (overdue) about 30 min before the fire reaches the core by
  the same forecast, far less than the 214-min lead; a fire outrunning its crews also wakes the
  commander (`outrun`, `strategy_failing`, `line_breached`) and the prompt says to order then.
- **Tier** (`tier`, `action`). `order` when the threat is `free_burn` and the latest safe start is
  within `EVAC_DECISION_WINDOW_MIN` = 30 min of now (or past: `too_late`): `order_now`, or
  `schedule` / `reschedule` / `scheduled_ok` when the roads fit only later (unchanged staggering).
  Ordering at the latest safe start still meets the schedule's own target (90% of complying
  households gone 30 min before core arrival); the window covers the agent's 3-min review cadence
  and think time. Otherwise `warn`: `action` `warn` (or `warned` when the zone already has one), with
  `order_by_minute` = latest safe start - 30 (when the aid will say order now if nothing changes).
  A zone already scheduled in time keeps `scheduled_ok` in free burn; for a contingent zone the
  warning replaces the schedule. `leaving` for a zone ordered out, with its `tier` still computed.
  Zones off the list need nothing (a warning or schedule there is withdrawn).
- **Warning order** (`{type: "warn_evacuation", zone_id, destination_id | null, reason}`,
  `contracts.ts` `DemoOrder`, `model.ts` `BoardOrder`, `demo.py`): order status `warning`, residents
  told to be ready to leave toward `destination_id` (null = the zone's first route option). Nobody
  leaves (no source on how much a warning shortens a later order's departures, so the departure
  curve is unchanged). Allowed on none, warning (new route), scheduled (replaces the schedule) and
  lifted (ends the lift, as a new order does); refused on leaving, done, overrun.
  `order_evacuation` supersedes it; `cancel_evacuation` withdraws it. Phones get `be_ready` with the
  route and `reason_code: "board_warning"` ([live-reports.md](live-reports.md#guidance-from-the-live-boards-orders)).
  On screen: "BE READY (sim) · Z09 · fire n min" on the 2D map, "Be ready · <zone>" in 3D, both
  amber and dashed like "At risk" (never the orange "Leave now"); zone panel "Be ready (warning)"
  with "Withdraw evacuation warning"; feed "Evacuation warning: <zone>, be ready to leave".
- **All clear** follows the same rule ([All clear](#all-clear-lifting-an-evacuation-order)): an
  order stays only while some reported fire puts the zone in the order tier, or a fire that did
  has been contained less than 30 min. A contained small fire's zones become eligible 30 min after
  containment unless another fire threatens them in the order tier.
- **Baseline policy**: `order_now` -> ordered, `schedule` -> scheduled, `warn` -> warned; scheduled
  or warned zones off the list are cancelled / withdrawn; eligible zones lifted (never tier
  `order`), then warned next call if still listed as `warn`.

Measured (2026-10-25, evaluation harness, baseline policy, `--fast`, Berkeley Hills & Tilden;
"old" = the same tree with the decision window and the held-before rule switched off in a scratch
copy, so the only difference is this change). Studio publish `sf_7a09abf8e4f0` (seed 1439539660,
7 mph, 3 fires; 120 min): old ordered Z16 (210 households) at T+3 for S1-F1 (0.1 ha, contained
T+14) and lifted it at T+50; new warned Z16 at T+3 and withdrew the warning at T+21, no order.
Synthetic 25 mph from 45°, critical moisture, at the same urban ignition (contained T+12 at 0.1
ha): old ordered 5 zones (1,762 households) at T+4-7; new warned the same 5 and withdrew them at
T+25-26. Synthetic 25 mph wildland ignition in Tilden (-122.21439, 37.91337; 240 min, 15.9 ha,
never contained, no zone reached): old ordered Z09 at T+49 and Z16 at T+82 (458 households); new
warned both, withdrew at T+111, ordered Z09 at T+155 (248 households). Synthetic 25 mph WUI
ignition (-122.2405, 37.8790; 240 min, 63 ha, 21 homes burned in Z16 and Z23): both ordered the
same 9 zones (3,558 households), the same minutes except Z24 (old T+4; new warned T+4, ordered
T+65). Casualties 0 people in every run, old and new; homes burned equal.

### Next-state prediction and evacuation balance (`app/src/demo/predict.ts`, `app/src/demo/evacBalance.ts`; observation `predicted`, `evac_balance`)

Simulated model output, never observed; Claude quotes it and never recomputes it. Types in
`app/src/demo/contracts.ts` (`PredictedObservation`, `EvacBalanceObservation`).

- **`predicted`** (horizons 30 / 60 / 120 min from now). `zones`: `edge_eta_min`, `core_eta_min`
  (minutes) and `burned_pct` (percent of the zone's ground, one value per horizon). `segments` (of
  the current and scheduled orders): `vc` (demand / capacity, veh/h over veh/h, per horizon),
  `peak_vc`, `peak_queue_vehicles`, `queue_delay_min`, `fire_eta_min`, `clears_in_min` (until 90%
  of the committed traffic has passed) and `danger` (fire before clearance). `destinations`:
  `committed_vehicles` against `capacity_veh` and `over_capacity`. `dangers`: one line per problem.
- **`evac_balance`**: per order-tier or already-leaving zone of `decision_aids.evacuation` (warning-only zones are excluded), `action` (order_now / schedule /
  reschedule / keep / leaving), `destination_id`, `start_minute` (absolute board minute), `peak_vc`,
  `worst_segment`, `expected_caught_*`, `exposed_vehicles`, `fire_cuts_route`, `why`; `totals` of
  the plan against `all_now` (every listed zone ordered now to decision_aids' destinations).
- **Fire.** The solver's free-burn arrival field of the reported fires (line built so far in the
  field, containment not assumed) gives each zone's edge / core ETA and burned share. A segment's
  fire arrival samples its route line, split over the segments by length share.
  `predictedFireRings(board, minutes[])` (minutes AHEAD of the board minute, e.g. `[30, 60, 120]`)
  returns, per horizon, the closed `[lon, lat]` outer rings of the reported fires' predicted
  footprint for the 3D overlay (largest first, at most 40 rings of 240 points).
- **Traffic.** The board's exponential departure curve, static loading of segments by zone, and a
  Lindley point queue per segment at `PREDICT_STEP_MIN` = 5-min steps over the solver's 360-min
  lookahead (`PREDICT_WINDOW_MIN`), starting from the board's current queues. Moving time is free
  flow (BPR adds at most 15% on the flow that passes, `traffic.ts`).
- **Optimizer.** Picks a destination (one of the zone's route options) and a start minute jointly
  across zones, minimising expected people caught at home + people on a segment when the fire
  reaches it + destination overload + a small queue-time term. Greedy by latest safe start, then
  local improvement passes; deterministic, target under 50 ms. A zone is never routed through a
  segment the fire reaches before 90% of its traffic has passed, unless every option is cut
  (`fire_cuts_route` true).
- **Parameters.** Start offsets 0-240 min in 5-min steps (board rule, the schedule's
  `EVAC_SCHEDULE_STEP_MIN` and `MAX_SCHEDULE_AHEAD_MINUTES`). `QUEUE_WEIGHT_PERSON_PER_VEH_MIN` =
  1/600 (**ASSUMPTION**: 10 vehicle-hours of queueing weigh as one person at risk).
  `FIRE_CUT_PENALTY` = 10000 person-equivalents per zone (**ASSUMPTION**: makes the fire-cut rule
  effectively hard). Destination overload counted as persons at risk (**ASSUMPTION**). Clearance =
  90% of complying vehicles past the segment (`EVAC_TARGET_DEPARTED_SHARE` in `decisionAids.ts`,
  **ASSUMPTION**). `MAX_IMPROVE_PASSES` = 3.
- The decide prompt (`app/backend/api/demo.py`) tells the commander to issue
  `order_evacuation(zone_id, destination_id, start_minute)` with the plan's own destination and
  start for order_now / schedule / reschedule entries, never after `latest_safe_start_minute`.

### Evaluation harness (`app/scripts/live-eval/`)

`evaluate.ts` runs one scenario headless and prints the metrics. It loads the board as /live
does (the active drill's command zones, resource snapshot and Studio fires from the live API;
landscape and inputs through `useDemoEnvironment.loadEnvironment`; zone routes from
`POST /api/demo/routes` and road legs from `POST /api/demo/crew_routes`), runs the fire solver
in-process, steps the clock deterministically (every solve, route refresh and awaited road leg
is awaited before the clock moves, as the page's holds do) and calls the commander at
useDemoAgent's cadence (monitor every board minute, a new reported fire at once, one call in
flight). It is board-local: no run-state PUTs, guidance, Studio publishes or report triage.

- `--policy claude`: the real `POST /api/demo/decide` (costs money: at most a few full runs).
  While Claude thinks, the board advances latency x Auto speed (1 board min per real min urgent,
  1 routine), then the orders apply. Cost per run comes from the orders line's `usage`
  (`dispatch.decision_usage`), or from matching the backend's "Decision usage" log lines to the
  run's call windows.
- `--policy baseline`: `baselinePolicy.ts`, a scripted commander that reads only the
  observation and follows the decision aids (free). `--policy none`: no orders.
- Scenario: the drill's newest Studio publish per scenario (as a fresh /live board takes it),
  `--fire-id sf_...` for one listed publish, or a synthetic, never published fire for scenario
  search: `--ign lon,lat --start 0 --report 4 --wind 10 --from 45 --moisture dry`.
- `--fast` (search only): routes every 15 board min and one prefetch request per minute (the
  routes call takes about 4 s on the dev backend). `--seed`, `--minutes`, `--out file.json`,
  `--base URL`.

```sh
cd app && npx esbuild scripts/live-eval/evaluate.ts --bundle --platform=node --format=esm \
  --outfile=/tmp/live-eval.mjs --log-level=error
node /tmp/live-eval.mjs --policy baseline --fire-id sf_48d1e76013b7 --out /tmp/base.json
```

A run takes 10-40 min of wall time, almost all of it in the routes and crew_routes calls; the
backend's single runserver process is the bottleneck, so parallel runs need their own backend
processes (e.g. extra `runserver --noreload` ports in the backend container, with the harness run
in the frontend container against `--base http://backend:<port>`).

## Endpoints

All anonymous local-demo endpoints, 60 requests per minute per client, `Cache-Control` set,
errors `{"error", "detail"}`. Each takes an optional `?incident=<id>`: absent is Camp
(`camp-2018-drill`); Camp or the active incident (the live API's rule, a Studio drill package
anywhere in California) are served, anything else is 404 `not_found`. The board follows the
active incident, not only the Camp map.

- `GET /api/demo/wind?mode=historical_replay|climatology_percentile&start=<ISO>&hours=<1-168>`:
  `sim.weather.scenario_wind`, cached per process and point. The station search starts at Paradise (-121.60, 39.76) for Camp, else at the mean of the incident's zone centroids. 503
  `weather_unavailable` when no series loads (the IEM archive cache is cold and offline).
- `GET /api/demo/environment`: `{terrain, terrain_detail, households_no_vehicle,
  households_no_vehicle_source, center}`; `center` is `[lon, lat]` (the wind point). For a
  non-Camp incident `terrain` is null (Camp-only package; the board no longer reads `terrain`, its
  slope comes from the LANDFIRE landscape) and carless households are `{}`, labelled unknown (counted as 0). `stations`
  (`[{id, name, lon, lat}]`) and `stations_source` carry the drill package's OpenStreetMap fire
  stations (observed; Camp: `[]` and null). The board uses them only when the CAL FIRE bases
  file is unavailable: the nearest stations fill all three base pools and the two nearest double as
  crew camps; unit types and counts per station stay assumed, and `basesLabel` says so. Terrain needs the Camp incident package locally
  (`DEMO_TERRAIN_PACKAGE`, default `data/incidents/camp-2018-evacuation/17e67cfe5669fe50`);
  slope is sent as rise/run × 1000 integers, aspect as whole degrees.
- `POST /api/demo/crew_routes`, body `{fires: rings, requests: [{id, access_class, from, to}]}`
  (at most 40): per request `drive_min` (no turnout), `distance_m`, `basis` (`road`,
  `road_offboard`), `offboard_m` (off-network legs at the start and the end, summed), `reason` when there is no route, and the line (ending at `to` when `to` is off the network). Road access
  fields (additive; older clients ignore them):
  - `access_status`: `reached` (drives to the road node nearest `to`), `detour` (gets there, but a
    faster road is closed to the class), `stopped_short` (no allowed road gets there), or null
    when there is no route.
  - `stop_point`: `[lon, lat]` where the vehicle must stop, `stopped_short` only. Then
    `drive_min`, `distance_m` and `line` end there, and `reason` is null.
  - `off_road_m_to_target`: straight-line metres from the end of `line` to `to` (the road snap
    distance when `reached`): the walk in or hose lay a consumer may add.
  - `blocked_rule` (`R01`-`R10`) and `blocked_reason` (plain language, e.g. "Paved road too steep
    (19%) for a Type 1 engine on Apple Lane (R05)"): the first road closed to the class on the
    route an unrestricted vehicle would take. Set for `detour`, `stopped_short`, and a no-route
    leg whose better road is closed; else null.
  - `unrestricted_drive_min`: `detour` only, that unrestricted vehicle's drive minutes.
  - Top level `road_access: {status, basis}`: `ready` (OSM tags and grade), `grade_only` (tags
    still loading), `none` (highway class only); `basis` says what was used.

  A stop short is taken however far the nearest reachable road is from `to`
  (`livecore.inbound.STOP_SHORT_MAX_M` is infinite; the former 3 km cutoff left remote fires
  with no ground response). `off_road_m_to_target` then says how far is left, and the off-road
  reach rules (`app/src/response/reach.ts` `planWork`) decide what the unit does: hose, hike
  in, walk a dozer in, or hold the road as indirect line. A leg with no reachable road at all
  keeps its `reason` (`no_access`, `target_in_fire`, `no_open_road`). A target inside the fire also stops
  short, at the nearest reachable road outside it. Consumers (the response model) should read
  `access_status`, `stop_point`, `off_road_m_to_target` and `blocked_reason`; an older server
  omits them, which means `reached`.
- `GET /api/demo/road_access`: `{status, basis, classes: [{access_class, label, open_km,
  closed_km, top_rules: [{rule, km, example}]}], closed_roads: FeatureCollection, evidence_class:
  "derived"}`. `closed_roads` holds each drill segment closed to at least one class, with
  `closed` (class -> rule), `reason` and `grade_pct`. Cached for an hour once `status` is
  `ready`; the /live map draws it ("Roads trucks can't use" layer, and for a selected unit).

## Road access

The drill bundle keeps only `highway`, `lanes`, `bridge` and speed per edge, so without more
the rules R01-R12 ([suppression-data.md](suppression-data.md)) closed nothing on Camp.
`api/drill_road_attrs.py` adds, per drill segment (`livecore/road_attrs.py`):

- **OSM tags** (observed): surface, tracktype, smoothness, width, maxweight, maxheight, bridge,
  access, emergency, motor_vehicle, 4wd_only, fetched from Overpass by the way id in each edge id
  (`osm-way:<id>:...`), with `dispatch_area.overpass` (same mirrors). Today's tags; 308 of the
  5,291 Camp ways no longer exist and take their tags as of 2018-11-08 (attic query). The drill's
  own highway class and speed are kept. `4wd_only` is carried but no rule reads it. Cached in
  MongoDB `dispatch_areas` (`builder: drill-road-tags/1`); the first fetch (about a minute) runs
  in the background, and until then the rules see grade only (`status: grade_only`).
- **Grade** (derived): the steepest 150 m least-squares slope of each segment's elevation
  profile on the Camp package's USGS 3DEP 1 arc-second DEM, sampled every 10 m and
  median-filtered over ±50 m; bridges unknown. **ASSUMPTION**: window and filter are not
  sourced. Coarse 2018 OSM geometry on canyon rims cuts across slopes, so the estimate runs
  high there (a few roads read above 40%). The endpoint difference over 100 m that Studio uses
  (`studio/roadAccess.ts`) gave about 460 km above 16% on Camp; this gives about 340 km.
  Other incidents get no grade (0% assumed, labelled); a Studio drill package built from now on
  keeps its dispatch-area OSM tags per edge (`livecore/package.py`).

Camp drill roads (3,083 km of segments, one direction each), closed per class with tags and
grade (before: 0 km for every class):

| Class | Open km | Closed km | Top rules |
| --- | --- | --- | --- |
| Type 1/2 engine (`engine_t1_t2`) | 2,672 | 411 (13%) | R05 paved grade > 16%: 299; R04 unpaved: 111; R03 smoothness: 2 |
| Type 3 engine (`engine_t3`; hand crew carriers) | 2,957 | 126 (4%) | R05 paved > 25%: 101; R06 unpaved > 20%: 26 |
| Type 4-7 engine (`engine_t4_t7`) | 2,974 | 109 (4%) | R05: 101; R06 unpaved > 25%: 9 |
| Support tender / dozer transport (`tender_support`) | 2,468 | 615 (20%) | R05 paved > 12%: 502; R04: 111; R03: 2 |
| Tactical tender (`tender_tactical`) | 2,746 | 336 (11%) | R05 > 16%: 299; R06 > 15%: 38; R09: 0.2 |

Most closures are short canyon-side roads: from Paradise, Chico, Magalia or Oroville a Type 1
engine still reaches 96% of the main road nodes, a support tender 90%, a Type 3 engine 99%.
The evacuation planner and `POST /api/demo/routes` are unchanged (the rules are for apparatus,
not cars).

## Travel time

Per edge and per apparatus class, `livecore/apparatus_travel.py`, applied in
`livecore.apparatus.access_profile`. Every consumer of a class profile uses it: `POST
/api/demo/crew_routes`, task routes (`api/live/responder_routing.py`) and the simulated responders
(`livecore/responders_sim.py`). Parameters live in `tools/suppression_resources.json`
(`road_access.travel`, and `engine_hp` and `frontal_area_m2` per vehicle class), each with a source
or an ASSUMPTION flag.

1. **Level speed**: the R11/R12 speed at grade 0. That is the OSM or posted speed, capped by
   `heavy_apparatus_speed_kmh_by_highway` (still an ASSUMPTION) and by the unpaved and single-lane
   factors, then by the NFPA 1901 top speed (68 mph; 60 mph above 50,000 lb GVWR).
   - **Bug fixed**: before this change the backend read `speed_kph` from `road_access`, which
     returns `speed_kmh`. No class cap ever applied, so trucks drove at the OSM speed, e.g. 105 km/h
     on Highway 32.
2. **Curves**: the radius is the three-point circumradius of the OSM vertices, with neighbours at
   least 25 m apart (ASSUMPTION). The speed cap is AASHTO `V² = 127 R (e + f)`.
   - `f` is from Green Book Table 3-7 (via Iowa DOT Table 2B.1).
   - `e` is 6% on highways and 4% on local roads (ASSUMPTION).
   - The truck brakes into each curve at 3.4 m/s² (the AASHTO value, not retrieved here).
3. **Grade**: a point-mass truck model on the signed 3DEP profile, integrated along the edge, so
   momentum carries a truck over short pitches. Constants are from Rakha et al. (2001), as given in
   Lucic (2001): `F = 3600 η P / v`, plus rolling, aerodynamic and grade resistance.
   - Mass is the class's GVWR.
   - Power is 350 hp for the Type 3 (BME CAL FIRE Model 34) and 450 hp for the Type 1 (Pierce
     spec). The other classes are ASSUMED at 350 hp.
   - Acceleration is capped at the NFPA 1901 minimum, 0 to 35 mph in 25 s.
   - Downhill, the truck goes no faster than it climbs the same 150 m grade (CDL gear rule,
     ASSUMPTION as applied).
   - Steady climbing speeds, Type 3 (km/h): 92 at 4%, 74 at 6%, 51 at 10%, 34 at 16%. For the
     support tender: 64, 48, 31 and 20. Both meet NFPA's 20 mph (32 km/h) on 6%.
   - Camp only, where the DEM is wired. Elsewhere the ground is flat, labelled in `basis`.
4. **Junctions**: at the end of an edge, the arriving road is compared with the other roads that
   meet there.
   - A higher OSM class means a complete stop: NFPA 1500 requires stops at stop signs and at
     negative right-of-way junctions. The stop costs 2 s plus the speed-change loss.
   - The same class means a slow-down to 25 km/h (ASSUMPTION).
   - A lower class means no delay.
   - Turns onto a road with priority and traffic signals are not modelled.
5. The twin congestion factor and the R01-R12 access rules still apply on top.

`crew_routes` adds `travel_breakdown` per road leg: `free_flow_min`, `curve_min`, `grade_min`,
`junction_min`, `junction_stops`, and `car_posted_speed_min` (the same roads at the OSM speed).

Measured on Camp (`POST /api/demo/crew_routes`, no fire, Type 3). The car time is at the
OSM/posted speed on the same roads. RAND is `T = 0.65 + 1.7 D`, an urban cross-check (MTAS).

| Route | Before (min, km/h) | After (min, km/h) | Free / curve / grade / junction (min) | Car (min) | RAND (min) |
| --- | --- | --- | --- | --- | --- |
| Chico → Paradise, 22.5 km | 18.5, 73 | 21.8, 62 | 19.8 / 0.0 / 0.0 / 1.9 (5 stops) | 18.5 | 24.4 |
| Paradise → Chico | 18.3, 73 | 21.4, 66 | 19.8 / 0.1 / 0.1 / 1.5 | 18.4 | 25.5 |
| Paradise → Concow, 26 km | 35.8, 44 | 45.7, 34 | 44.7 / 0.0 / 0.3 / 0.7 | 35.8 | 28.2 |
| Oroville → Paradise | 30.9, 64 | 34.7, 57 | 31.2 / 0.1 / 0.2 / 0.3 | 27.9 | 35.6 |
| Paradise → Magalia, 8.3 km | 9.4, 53 | 10.1, 49 | 9.6 / 0.0 / 0.0 / 0.6 | 9.4 | 9.4 |
| Magalia → Stirling City | 21.1, 51 | 21.6, 55 | 21.2 / 0.1 / 0.2 / 0.2 | 21.1 | 21.6 |
| Chico → Forest Ranch (Hwy 32) | 17.1, 89 | 24.6, 62 | 23.0 / 0.0 / 0.1 / 1.4 | 17.1 | 27.5 |

- **No class beats the car time on any route.** The support tender loses 0.8 to 2.1 min to grade
  on the Skyway climbs.
- **Most of the change is the level-speed cap**, now applied (the bug above), plus junction stops.
- **Curves add under 0.1 min**: where roads wind, the level speed is already low (35-45 km/h,
  ×0.6 on single-lane roads).
- **Grade costs little for engines**: about 15-20 kW/t holds 74 km/h on 6%.
- **Paradise → Concow is slower than RAND**: canyon roads on single-lane speed factors. RAND is
  urban, so this is expected.
- **Not modelled**: momentum across edge boundaries (each edge starts at its capped or crawl
  speed), turn slow-downs, and signals. The Studio dispatch engine (`studio/roadAccess.ts`) still
  uses the step grade penalty, and the same model is not yet ported there.

## Road closures

On Live command the controller can close a drill road for the drill: **Close road** (bottom
right of the map), click a road, confirm in the panel. A closed road is drawn as a thick dark
line with white X marks and a "CLOSED (drill)" label (legend: "Closed road (drill,
controller)"); click it, or its row in the panel, to **Reopen**. Closures are stored per
incident ([live-reports.md, Road closures](live-reports.md#road-closures)), so every console and
the AI agent see them (each console polls every 4 s).

- **Routing** (server side): `POST /api/demo/routes` and `POST /api/demo/crew_routes` treat every
  closed segment as blocked, the same rule as the live planner's blocked roads, so no zone option,
  unit leg, crew option or ETA uses it. The page never uses a routing answer whose
  `closed_segment_ids` misses a closure it knows of (`demo/roadClosures.ts` `answerCovers`); it
  asks again.
- **Units** (`applyClosureSet`): a unit on the road whose line ahead of it uses a newly closed
  road stops where it is and waits for a new road leg (the clock holds for it as for any leg).
  This does not count as a fire cut (`MAX_FIRE_CUT_REROUTES` and its backoff are for fire only).
  A unit with no road route left is handled as any failed leg: logged, it stays or waits; it never
  drives through. Cached legs over the closed road are dropped; a reopening drops all cached legs,
  no-route answers and class reach notes, so they are asked again.
- **Evacuation** (`reconcileZones`, on the first routes answer that honours the closure): a zone
  leaving (or scheduled) on a route over the closed road that the answer no longer offers takes
  the answer's best option. Households already on the road and past the closure keep their
  arrival; those before it take the new route (**ASSUMPTION**: from the closure minute, the new
  route's free-flow time; distance already driven is neither credited nor charged; they do not
  load the new route's segments again). With no route left the zone is held: households that leave
  wait at the zone and those before the closure wait where they are, until a route opens; a
  scheduled order with no route is dropped. Departures and counts are untouched (population is
  conserved) and arrivals stay first in first out.
- **"Uses the road"** is geometric (route lines carry no segment ids): within 30 m of, and within
  40° of the direction of, two of three points at 25/50/75% of the closed segment (its midpoint for
  one under 50 m), so a road that only crosses it at an end does not count. **ASSUMPTION**: tuned
  for lines simplified at 25 m.
- **Feed and AI**: the feed shows "Road closed: <road> (drill, by controller) — 2 units and 3
  zones rerouted", "Road reopened: …", and "<zone>: no open route around the closed road;
  households wait". The observation lists `closed_roads` (segment id, name, since minute, by) and
  the prompt says routes already avoid them. The agent cannot close or reopen roads.
- **Claude reacts at once** (`demo/useDemoAgent.ts` closure monitor, `demo/closureWake.ts`): a
  closure or reopening wakes the agent on wall time with urgency `urgent` (board at 1× while it
  decides), without waiting for the board monitor's minute bucket. It first waits for the routes
  answer for the new closure set and the rerouted units' new legs (at most 5 s wall; the reason
  says so when it times out). A routine review in flight is aborted (its plan was for the old
  roads); an urgent call in flight queues one urgent follow-up. The reason names the road, the
  rerouted units (minutes gained or lost, new arrival) and the zones whose route changed or has
  none left, e.g. "Controller closed Grizzly Peak Blvd (segment s22) at T+00:42: units rerouted:
  S04-E1 to F2 (+7 min, arrives T+00:55); zones affected: Z30 (evacuating) redirected to Exit B
  14 min (was Exit A 8 min); Z23 best route now CA 13 south 12 min (was Exit A 9 min); Z29: no
  route left." Every number comes from the board's routers.

## Measured

- Earlier ellipse model (removed), kept for comparison. Rothermel at SH5, flat, dry moisture: 4.2 m/min at 2 m/s open wind, 14.4 m/min at 5.9 m/s,
  40.6 m/min at 14.3 m/s; head flame 4.9, 8.6 and 13.9 ft. Engines hold the head only below
  about 5 m/s of wind in dry fuel.
- Crew routes, Paradise FS to central Paradise: 7.0 min by road (5.75 km) against 6.1 min by
  the old straight-line rule; Table Mountain Fire Center: 65.7 min (3.9 km off-board, then
  40 km of road).
- Earlier ellipse model (removed): 24 simulated hours on the 43 drill zones with a greedy
  commander (3 nearest units to every new fire, no evacuation orders): with 1-8 Nov wind, 4 to 7
  of about 30 fires contained; with the Camp-day or P95 wind, none.
- Fire solver on the board (2026-10-24, node, scratch check): Berkeley Hills & Tilden, 507 x 507
  cells of 23.7 m, canopy present. A 24 h Active board with 1-8 Nov wind and a greedy commander:
  178 solves (89 new fires, 72 containments, 17 wind changes), median 82 ms, p95 0.6 s, max 0.7 s;
  at most 18 sources. Camp loaded live from LANDFIRE for an 11 km radius: 954 x 954 cells of 23.1 m,
  11 s to load, 0.3-1.1 s per solve with 8 fires at 2-9.4 m/s.
- Solver resume (2026-10-25, solver 5.1.1): resuming every 10 or 30 minutes with unchanged
  deterministic weather gives the uninterrupted run's area exactly (one grass fire on Berkeley Hills,
  13.06 ha at T+2 h, 24.60 ha at T+200 at 4 mph; arrivals within float32 storage). Solver 5.0.0 to
  5.1.0 drifted (22.8 ha at T+2 h re-solving every 10 min), which made /live fires on an hourly
  Studio weather series grow about twice as fast as the same Studio run. Earlier (before 5.0.0):
  with unchanged weather, resuming at any minute (or 17 times in a row) matched the
  uninterrupted run to 1e-4 min (float32 storage) with identical cells and attribution; after a
  135° wind shift and speed-up no burned cell changes and nothing burns before the resume minute.
  The default solver path (no extension) is bit-identical to before for `/fire` and Studio.
- Determinism: the same seed stepped at 0.2 and 0.73 min ticks gives identical fires, areas,
  statuses and zone contact times over 6 h (the clock lands exactly on ignitions and wind hours).

## What is still not realistic

- Forecasts hold the current hour's wind for the whole lookahead; the footprint itself follows the
  hourly series only as it is reached. Wind is uniform over the landscape.
- At a wind change, a cell that was crowning carries an active crown fire on only into canopy
  that sustains it at the new wind; the arrival breakdown counts resumed cells as surface spread.
- Perimeter is a lattice estimate (π/4 is exact only for orientations spread evenly; an elongated
  fire aligned with the grid reads up to 21% low, one diagonal to it up to 11% high). Direct-attack
  line is counted against the open perimeter for containment; the cells it puts out are a
  separate per-cell reading of the same production (units work only cells in reach, parked where
  their road ends: an engine does not reposition along the edge, so with 305 m of hose it can lose
  a running head), and the solver sees the knocked-down edge only every 5 board minutes. Parallel
  and indirect line from direct-attack units is not placed on cells. "Burning" is at cell
  resolution (a 24-30 m cell counts while the front is in it). Line at attack positions is
  built along its path and blocks every fire, but its production rate is the anchor cell's
  (fuel and slope along the line are not varied), the walk from the road end to the anchor is
  timed (Tobler) but the line is still built outward from the anchor only, and the line's length
  is fixed when it is started. Units on one line add their production linearly, with no span of
  control or crowding (20 engines on a 367 m line build it 20 times as fast). Crews pull back only
  when the fire reaches the anchor itself, not at an earlier trigger point.
- The containment check uses the head flame at the leading front cell and takes it to persist in
  the forecast; a fire whose head has stalled at a barrier is judged at its farthest still-open
  cell, often a flank.
- A fire started where another fire will arrive first contributes nothing (the solver's
  "reached before start"); one started on burned ground, non-burnable ground or off the
  landscape is labelled and does not spread.
- Dead ends (R10) and lane counts are not applied to apparatus routing; road grade is a DEM
  estimate that runs high on canyon-rim roads (see "Road access"). The response model does not
  yet add a walk-in or hose-lay time for `off_road_m_to_target`.
- Engine counts and availability per station are the snapshot's assumptions (synthetic) when a snapshot is used, and the snapshot has no hand crews or dozers (the facilities layer supplies them, at assumed counts, or the assumed extras without it); committed engines never become available during a run. The same-station match between layer and snapshot (`SAME_STATION_M`) is an assumption. Otherwise unit counts per facility are assumed. Aircraft, water, work/rest, move-up and escalation are modelled by the response model ([response-model.md](response-model.md), with its own list of gaps).
- Persons are spread evenly over a zone's vehicle households (the snapshot's per-household
  occupants are not used household by household).
- Under observed November winds, fires routinely escape initial attack and the board fills to
  its 25-fire cap. That is the model's answer, not a defect to tune away; a labelled
  escaped-fire handoff rule would be the next step for long 24/7 runs.
- Under strong Studio winds, fires routinely escape initial attack. That is the model's answer,
  not a defect to tune away. The Studio run's `horizon_minutes` is not applied: board fires burn
  until contained or closed.
- Ingest timing is a wall-clock input (when the poll sees the publish); given the same publishes
  ingested at the same board minutes, a run replays exactly.
- Self-evacuation is per zone and aggregate (shares per cue, not per household); its cue lead
  time (60 min), neighbour radius (2 km) and social threshold (50% gone) are assumptions, and
  the fire forecast stands in for what residents can see.
- Household evacuation traffic uses static loading (a vehicle loads its whole route at departure), point
  queues without spillback into upstream links, no intersections or signals, and assumed
  capacities; a zone redirected mid-evacuation moves its past departures to the new route in the
  queue history. Fire units read these households' zone flows (`board.traffic.zoneFlow`) but are slowed by a BPR factor
  at a fixed 1,700 veh/h per direction on route lines near leaving zones, not by the per-segment capacities or queues ([response-model.md](response-model.md)). Destination
  capacity is enforced only at routing: a full destination is left out of new routes
  (`demo/safeDestinations.ts`); zones already going there keep going (map-edge exits have none). Carless households have no pickup model.
- Fires that leave the board keep their burned ground in the field (no reburn) until restart.
- `fire/rothermel.ts` used to give SH5 half the replay's head rate (85 against 173 m/min) by
  weighting each category's reaction term by its surface-area share. Since `SPREAD_MODEL`
  4.4.0 both codes match Behave (173 m/min, 6,144 Btu/ft²/min), so board fires in SH5 now
  spread about twice as fast and burn about twice as hot as the figures measured before it
  ([fire-simulator.md](fire-simulator.md#surface-model-equations-and-reference-check)).

Live fire synchronization: a native Studio field includes scheduled future ignitions. When
one starts, its own source-owned arrival does not count as previously burned ground; an
arrival owned by another source still does. A discarded worker reply for an older board
wakes the replacement board to request its field, including while the clock is paused.
Playback speed changes only the shared board clock, not numerical fire spread rates.

Merge integration: self-evacuation departures freeze when an evacuation order is lifted; once
residents have returned, their previous self-evacuation curves reset with the order. `/run` fire
publishes include the preset’s native `fire_settings`; `landscape_box: null` uses the active
drill landscape. Coordinates remain WGS84 and times remain simulation minutes.
