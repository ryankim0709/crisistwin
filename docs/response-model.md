# Fire response and resource management model

Date: 2026-10-24. A shared, pure TypeScript model of how fire agencies respond to a fire and
manage their resources: initial attack by run card, containment tactics, escalation and resource
orders, departments and mutual aid, and unit states. It runs the `/live` command board's
rule-based response today. Simulation Studio reads its run card and staffing turnout. Every
number below is sourced, derived from sourced numbers, or a named **ASSUMPTION**. Outputs are
planning experiments, not operational dispatch guidance.

## Code

| File | What |
| --- | --- |
| `app/src/response/rng.ts` | Seeded stream (mulberry32, as the board), derived from the board seed with a salt, so response draws do not move the ignition sequence |
| `app/src/response/fleet.ts` | Departments, tiers and units from the CAL FIRE facilities layer (`buildFleet`), turnout by staffing (`engineTurnoutMinutes`) |
| `app/src/response/runCards.ts` | Dispatch level from fire danger, run cards, initial-attack (IA) size, escalation stages and orders, the Operations Bulletin #1 caps, `ORDERABLE` |
| `app/src/response/containment.ts` | Tactic by flame length, production per tactic, line needed, seeded holding test, Fried & Fried check |
| `app/src/response/orders.ts` | Mutual aid and state tiers, fill draws, lead times, state caps |
| `app/src/response/travel.ts` | BPR congestion from evacuation flows on shared roads, seeded travel variation, fire-cut test |
| `app/src/response/units.ts` | Work/rest, water, availability, move-up, mop-up release, aircraft cycles and flight gating |
| `app/src/demo/boardResponse.ts` | The board adapter: applies the model each board step (`respondToNewFire`, `responseTick`, `advanceContainment`, `escalate`, `placeOrder`) |

Wiring: `demo/model.ts` calls the adapter from `ignite` and `stepOnce`. `send_crew` uses the
same dispatch path (`dispatchTeam`), and the new `order_resources` order calls `placeOrder`.
`demo/observation.ts` adds `fires[].tactic/dispatch_level/ia_status/escalation_stage/first_arrival_min/line_breaches/air_line_m/aircraft`,
`crews[].department/tier/water_pct/work_h`, and a `response` block (departments, aircraft,
orders, `orderable`, IA record). The shapes are in `demo/contracts.ts`.
`useCommandBoard` exposes `ruleResponse` and `setRuleResponse`; both are on by default and the
page has no toggle yet. In Studio, `firefighting.ts` takes `FIRST_ALARM` from the shared medium run
card, with the same numbers as before. `crewDispatch.ts` gives off-board engines the staffing
turnout. The server validates `order_resources` in `app/backend/api/demo.py`.

## Before: three response models disagreed

| | `/live` board (`demo/model.ts`) | Dispatch agent (`dispatch/engine.ts`) | Studio (`studio/initialAttack.ts`, `firefighting.ts`) | Python |
| --- | --- | --- | --- | --- |
| Units | Fixed roster of 12 | One engine per OSM station | Counts per kind from settings | `livecore/apparatus.py`: 1.6 Type 3 per CAL FIRE station, 1 Type 1 elsewhere |
| Turnout | Kind's turnout (80 s engines) | 80 s, or the kind's | Kind's | 80 s paid, 120 s other |
| Line | Per kind, fuel and slope | Grass-equivalent | Grass-equivalent pool | none (`sim/` has no suppression) |
| Containment | Line ≥ solver perimeter and head flame ≤ best holding limit | Line ≥ ellipse perimeter; flame limit gates direct attack once | Pooled line ≥ ellipse perimeters | none |
| Tactics, aircraft, escalation | none | Manual direct, flank or indirect via solver lines; none; none | Control lines plus aircraft; no escalation | none |

Now the board and Studio share the run card and the staffing turnout, and the board uses the
full model. The dispatch agent still has its own engine (not changed; see Gaps).

## Initial attack

- **Dispatch level** (`dispatchLevel`, **ASSUMPTION** mapping). CAL FIRE units set dispatch
  levels from NFDRS Burning Index breakpoints in unit Fire Danger Operating Plans; none was
  retrieved, and the board has no NFDRS inputs. The level is *high* when moisture is critical,
  or dry with a Red Flag-like wind of 25 mph or more. It is *medium* when moisture is dry or the
  wind is 15 mph or more, and *low* otherwise. Both breakpoints are assumptions; NWS Red Flag
  criteria vary by office.
- **Run cards** (`WILDLAND_RUN_CARDS`, `STRUCTURE_RUN_CARD`):

  | Level | Engines | Crews | Dozers | Air attack | Airtankers | Helicopters | Evidence |
  | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
  | low | 2 | 1 | 0 | 0 | 0 | 1 | ASSUMPTION |
  | medium | 3 | 1 | 1 | 1 | 2 | 1 | Ground: data leaf `deployment.initial_attack_ground_first_alarm_sra_high`, itself an ASSUMPTION. Air: California Fire Pilots Association package, secondary source |
  | high | 5 | 2 | 2 | 1 | 2 | 2 | ASSUMPTION: the aircraft source says the package "may be augmented by fire weather" |
  | structure (ignition on FBFM40 91) | 4 | 0 | 0 | 0 | 0 | 0 | ASSUMPTION sized from NFPA 1710 5.2.4.2 (14 to 15 members for a 2,000 ft² house; as cited, not re-fetched) |

- **Closest resource** (`fillCard`). The card is filled by expected arrival:
  turnout + road minutes × congestion. Candidates are the board's free or returning units plus
  the nearest 8 off-board pool units of each kind; an off-board unit drives from its real station.
  This follows the closest-resource concept of Cal OES Operations Bulletin #1. The first pass
  keeps each department's drawdown reserve; a second pass fills what is still short without it.
  A ground shortfall is ordered at once as immediate-need mutual aid.
- **Turnout** (`fleet.ts`): engines take 80 s at paid (P) stations. That is NFPA 1710 4.1.2.1 as
  cited in data leaf `response_times.turnout_s`, not re-verified. Other staffing takes 120 s
  (data **ASSUMPTION** `wildland_turnout_s`, as `livecore/apparatus.py`). Crews mobilise in
  30 min and dozers in 60 min (data ASSUMPTIONS).
- **Not modelled**: detection and report delay, and call processing. Dispatch happens at the
  ignition minute.

## Containment

The race is Fried & Fried (1996, *Forest Science* 42(3):267-281): line built along the perimeter
while it grows. The board uses the solver's own perimeter (`fireField.perimeterAt`). With linear
growth P = k·t and line rate R from arrival t_a, it reduces to t* = R·t_a / (R − k)
(`containmentMinuteLinear`), with no containment when R ≤ k.

| Tactic | When (head flame, PMS 465 p.12 Hauling chart) | Line needed | Holds | Production |
| --- | --- | --- | --- | --- |
| direct | Within the assigned units' limit: 4 ft hand tools, 8 ft engines, dozers and retardant (PMS 465 pp.171, 174) | Perimeter now | Best on-scene limit; waits for a machine when only crews are there at 4-8 ft | Sourced tables (`studio/apparatus.ts`) |
| parallel | Above that limit, at most 11 ft, and finishable | Perimeter + 2π × 20 m (Steiner offset; offset **ASSUMPTION**) | 11 ft (**ASSUMPTION**: the 8-11 ft band held only with burnout) | Crews × Broyles (2011) Table 2 indirect/direct ratio for the fuel (grass 9.5/17, chaparral 5/6.6, brush 4.9/16.5, timber 6.9/10.5); engines and dozers × 1 (**ASSUMPTION**) |
| indirect | As parallel, but a parallel line cannot be finished | The solver perimeter 30, 60, 90 or 120 min ahead (first finishable; **ASSUMPTION** leads) | 11 ft, tested when the fire reaches the line; an unfinished line is breached | As parallel |
| structure | Head on developed ground (91) | Perimeter now | No Hauling test (**ASSUMPTION**, as `dispatch/fireAttack.ts`) | Engines at their grass rate (Anderson model 1) |
| flank | Above 11 ft or crowning | Flank line, capped at the perimeter | Never contains | As direct |

- **Holding test** (`holdingTest`): when the line is complete, the flame it meets is the head
  flame × a lognormal factor (log-SD 0.3, **ASSUMPTION**). That is of the order of the ±35% band
  fire-model evaluations use (Cruz & Alexander 2013, *Env. Modelling & Software* 47:16-28), not
  fitted. A flame above the limit breaches the line: 25% of the line is lost (**ASSUMPTION**),
  with a retry after 10 min.
- **Aircraft** lay line (IASG 2017 Table 8 by gallons, Table 7 coverage level for the fuel, × the
  wind effect between 15 and 25 kt). That line counts only where retardant can hold: head flame
  8 ft or less, no crown fire, or a parallel or indirect tactic. Containment needs ground units on scene.
- **Mop-up release** (**ASSUMPTION**): at containment the nearest engine and crew stay for mop-up.
  Everything else is released, and pending orders are cancelled.

## Escalation and resource ordering

- **IA outcome**: the CAL FIRE goal metric, contained at 10 acres (4.05 ha) or less
  (calfire_house_2019 p.4), whatever resources it took.
- **Escalation stages** (`ESCALATION_STAGE_ACRES` 10 / 100 / 1,000 acres; 10 is sourced, its use as
  a trigger and the rest are **ASSUMPTIONS**). Stage 1 also starts on a line breach, or when the
  units on scene cannot catch the fire in the forecast with none still coming. The orders
  (`ESCALATION_ORDERS`, **ASSUMPTION** sizes) are, for stage 1: 2 engine strike teams, 1 crew
  strike team, 1 dozer strike team, 2 airtankers and 1 helicopter.
- **Tiers** (Cal OES Operations Bulletin #1, April 2022, pp.1-3, fetched):
  1. *Closest*: stations on the board answer IA. Off-board stations also answer IA when nearer.
  2. *Mutual aid*: immediate need from one adjacent area, once per incident, within the
     bulletin's caps (five engine strike teams per type, five crew strike teams, two dozer strike
     teams, two helicopters). Units come from real off-board stations, nearest first, within their
     department's drawdown. Assembly takes 30 min (**ASSUMPTION**), then they drive from the station.
  3. *State*: later orders, and orders the area cannot fill, go through the normal ordering
     system. Lead time is 60 min processing + 60 min assembly + 200 km at the 80 km/h trunk cap,
     about 4.5 h to the board edge nearest the fire (all **ASSUMPTIONS**; no published
     California lead times were retrieved). State aircraft arrive after 15 min reaction (PMS 508
     p.44) + 150 km at cruise (distance **ASSUMPTION**).
- **Availability drawn down by other fires** (**ASSUMPTION**, seeded): a tier fills an order
  with probability 0.9 / 0.75 / 0.5 (mutual aid) and 0.95 / 0.85 / 0.7 (state) on quiet, active
  and severe boards. An unfilled order ("unable to fill") retries with the state system every
  30 min. The state sends one board at most 40 ground units and 8 aircraft at once (**ASSUMPTION**;
  CAL FIRE's whole fleet is about 23 airtankers and 10 staffed helicopters).
- **Strike teams**: 5 engines (data leaf ASSUMPTION), 2 crews, 2 dozers (ICS definitions, not re-fetched).
- **AI commander**: `order_resources(fire_id, resource, count)` with resource one of
  `engine_strike_team`, `crew_strike_team`, `dozer_strike_team`, `airtanker`, `helicopter`.
  The count is capped at 5/5/2/4/2 (the bulletin's caps; airtankers 4 is an **ASSUMPTION**).
  It is validated by the server (`normalize_order`) and again by the board (`applyOrder`).

## Departments and mutual aid

`buildFleet` groups the CAL FIRE facilities layer (`GET /api/suppression/bases`, which now
returns `staffing`) into departments by agency class and unit code. Examples near Paradise: CAL
FIRE BTU unit, Paradise FD (PRA, Schedule A), Butte County Fire (BTC, Schedule A), and the
volunteer companies of the BTU area. The layer has no apparatus, so the counts per facility are
assumptions:

| Facility | Units | Evidence |
| --- | --- | --- |
| CAL FIRE station | 1.6 Type 3 engines (k-th station: floor(1.6k) − floor(1.6(k−1))) | Derived: 343 engines / 220 stations, 2019 (data leaf) |
| CAL FIRE unit | 1 Type 2 dozer at its first station | ASSUMPTION |
| Other station (local, Schedule A, contract county) | 1 Type 1 engine | ASSUMPTION, as `livecore/apparatus.py` |
| Federal station | 1 Type 3 engine | ASSUMPTION |
| Conservation camp or crew fire centre | 2 Type 1 crews | ASSUMPTION |
| Air attack base | 1 air attack + 2 S-2T | Derived: 12 air tactical and 22 airtankers at 13 bases (calfire_house_2019) |
| Helitack base | 1 Type 2 helicopter | ASSUMPTION |
| OSM-only package station | 1 Type 3 engine; the 2 nearest also as crew bases | ASSUMPTION |

Facilities inside the board's landscape answer IA. The rest (the bases endpoint returns up to 40
stations and 10 camps within 60 km, and every air base) form the mutual-aid pool. On a 60 km board
(`fire/boardSize.ts` on `feat/shared-world`) most of them are on the board. **Drawdown**: a
department keeps floor(25% of its engines) uncommitted (**ASSUMPTION**), so a department with
fewer than 4 engines keeps none. It always answers fires within 5 km of one of its stations
(**ASSUMPTION**). Without layer metadata the board falls back to the fixed roster, one
department per station.

## Resource management

| Rule | Value | Evidence |
| --- | --- | --- |
| States | available, en_route, on_scene, refilling, returning (can be redispatched), moving_up, resting, out_of_service | Model |
| Work/rest | Relieved after 16 h of work or travel; rests worked/2; idle time counts as rest at 2:1 | Interagency Standards for Fire and Fire Aviation Operations (NFES 2724) ch. 7: 2:1 work to rest; shifts over 16 h the exception (as found, edition not confirmed) |
| Water | Tank 500 gal (Type 3), 300 gal (Type 1); 20 gal/min while working; 20 min off the line to refill | Tanks: PMS 200 minimums. Use and refill: ASSUMPTION; refill inside the PMS 200 support-tender 15-30 min range, as a proxy |
| Out of service | 8% of idle units, redrawn every 8 h, for 1-8 h | ASSUMPTION, seeded |
| Move-up and cover | A station empty for 30 min gets a free engine from a station with 2 or more; the engine returns home when the station's own engines are back | ASSUMPTION (data leaf `deployment.move_up_and_cover`) |
| Demobilisation | Off-board and state units leave the board on release; mutual-aid units return to the pool | Model |
| Aircraft | Daylight windows by role (IASG pp.37, 42; PMS 508 p.46), hard wind stop 35 kt (ASSUMPTION), drop line × wind effect (15-25 kt, IASG p.100), airtanker cycle = round trip + 10 min reload (ASSUMPTION), helicopter turnaround by dip distance (ASSUMPTION formula); air attack makes airtankers "supervised" | `studio/aircraft.ts`, reused |
| Bounds | At most 160 units on the board; 60 orders kept; observation lists at most 24 aircraft and orders | Performance |

## Travel

The road leg comes from `POST /api/demo/crew_routes`: per apparatus class, road access rules
R01-R12, avoiding fire at request time. Until a leg arrives the fallback is a straight line
× 1.3 at 60 km/h (**ASSUMPTION**). On top of the leg:

- **Congestion from the board's evacuation** (`travel.ts`). Each zone that is leaving puts its
  departure rate × 1.6 vehicles per household onto its chosen route. 1.6 is inside the sourced
  1.52-1.82 (Wong et al. 2020 Table 10). Every 100 m of a responder's leg within 60 m of such a
  route, going the same way or the opposite way, takes the BPR (1964) factor
  1 + 0.15·((v_with + 0.5·v_against)/1,700)⁴. The capacity 1,700 veh/h per direction is HCM 2010
  ch. 15 for a two-lane highway, as cited and not re-fetched. The 0.5 against-flow weight is an
  **ASSUMPTION**. The factor is capped at 10 (`livecore/routing.py` CONGESTION_MAX_FACTOR).
  Checked values: at v/c = 1 the factor is 1.150 and at v/c = 2 it is 3.400; 2,400 veh/h with
  the flow gives 1.596, against the flow 1.037.
  The live traffic twin is not used: the board's households are not in it.
- **Seeded variation**: a lognormal multiplier per trip (log-SD 0.2, **ASSUMPTION**). The shape
  follows Budge, Ingolfsson & Zerom (2010), *Management Science* 56(4); the spread is not fitted.
- **Fire-cut roads**: each minute an en-route unit's remaining road line is sampled every 100 m,
  except the last 300 m. A burned cell stops the unit, which reroutes on a straight line × 1.5
  (**ASSUMPTION**) until a new road leg arrives.

## Measured

Scratch script (not committed): seeded boards run headlessly through `solveFireField`, real
facilities from the local `tools/ca_fire_bases.json`, and a **synthetic flat landscape** (the
LANDFIRE tiles load only in the browser). No road server was running, so all travel is the
straight-line fallback, which is optimistic for residential streets.

- **Worked examples**: Fried & Fried with R = 20 m/min, k = 8 m/min and t_a = 15 min gives
  t* = 25 min in closed form; the board's minute-step race also gives 25 min. The BPR values are
  listed under Travel.
- **Residential versus rural**, 6 seeds, 6 h each, 5.9 m/s wind, dry moisture:

  | Scenario | First engine (min) | Contained after (min) | Area at containment (ha) | Damage | IA |
  | --- | --- | --- | --- | --- | --- |
  | Residential: central Paradise on FBFM40 91, structure card | 3-5 (median 3) | 10-12 | 0.4 | 0.4 ha developed burned, 0 households caught | 6/6 contained |
  | Rural brush: SH5, nearest station 10 km (-121.802, 39.360) | 11-13 | 286-307 in 3 seeds; not contained by 6 h in 3 | 225-258; 358 at 6 h when not contained | 45 households caught (synthetic zones of 15) | 0/6; 13 orders each, stage 2 |
  | Rural grass: GR2, same point | 11-13 | 22 | 1.1 | none | 6/6 contained |

  NFPA 1710 (first engine within 80 s turnout + 240 s travel, about 5.3 min) is met in the
  residential case, but on straight-line travel. NFPA 1720's rural 14 min is met by the rural
  first engines. The expected direction holds: the residential fire spreads slowly (the solver's
  structure spread, 4 m/min at 20 mph scaled by wind) and is caught small, while rural brush
  escapes and does more damage. The residential result depends on two assumptions: the structure
  tactic has no flame-length test, and 60 m cells make 0.36 ha the smallest fire.
- **Evacuation traffic**: an evacuation was ordered at T+0 with routes converging on one
  south-west corridor, and the fire started at T+45. The engine nearest the corridor was slowed
  ×1.7, but first arrival changed by at most 1 min, because the legs are 1-4 km. Inbound against
  outbound traffic slows little until v/c is above 1.
- **24 h boards with scheduled ignitions** (36-53 fires a day in a 30 km square; synthetic fuel
  of developed Paradise, GR2 west of -121.72 and SH5 elsewhere, 4 m/s wind):

  | Case (3 seeds) | IA success | First arrival median / p90 (min) | Utilisation | Move-ups |
  | --- | --- | --- | --- | --- |
  | Quiet, SH5 wildland | 0-6% | 13-22 / 41-42 | 82-84% | 1 |
  | Quiet, SH5, water unlimited (sensitivity) | 0-5% | 11-18 / 40-43 | 81-84% | 1-2 |
  | Quiet, GR2 wildland (sensitivity) | 100% | 5-6 / 8 | 18% | 18-26 |
  | Active, SH5 wildland | 2-8% | 11-13 / 37-47 | 86% | 0-2 |

  This disagrees with CAL FIRE's 95% goal, and I trust the measurement as the model's answer
  for these inputs. In SH5 at 5.9 m/min head spread, the sourced line rates (engines about 2.7
  and 5.0 m/min, a crew 2.2 m/min) are below the perimeter growth, so Fried & Fried gives no
  containment. The 95% statewide figure covers a fuel and weather mix far milder than high-load
  shrub everywhere, and far fewer fires per area than the board's ignition rate. Water is not
  what decides it (see the sensitivity row). Nothing was tuned to close the gap.
- **Cost**: a 24 h board took 0.2-2.7 s of CPU for the board and response logic, against
  5-15 s for the fire solver. The observation is 9-67 kB (the decide limit is 200 kB) and builds
  in 2-10 ms. The browser's ×60 runs 24 h in 24 min.

## What is left

- **Traffic**: the live twin's per-edge congestion is not used, because the board's households
  are not in the twin. Congestion comes from the board's own flows on route lines, not on road
  edges, and there is no contraflow or lane count. `crew_routes` still reports
  `congestion: "not_modelled"` for its free-flow legs.
- **Residential fires**: structure-to-structure spread is the solver's fixed-rate assumption
  (owned by the solver files). There is no structure-fire suppression model (fire flow, exposures).
- **Run cards and dispatch levels** are assumptions: the next step is a unit Fire Danger
  Operating Plan with Burning Index breakpoints.
- **Escalation lead times, fill probabilities and state caps** are assumptions.
- **Line**: no burnout timing, no loss of an already contained line on a wind shift, no line
  degradation over time.
- **Units**: pilot duty limits are not modelled; water tenders are not units.
- **Response time**: detection and call processing are not modelled.
- **Reproducibility**: the browser steps the clock in variable fractions of a minute and road
  legs arrive asynchronously. A browser run is reproducible in its seeded draws but not
  minute-exact; a headless run with the same steps is exact.
- **The dispatch agent** (`dispatch/engine.ts`) still has its own containment and tactics; it
  could use `response/containment.ts` next.
- **No UI**: the page shows the new statuses and events, but no panel yet for orders,
  departments or aircraft.
