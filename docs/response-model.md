# Fire response and resource management model

Date: 2026-10-24. A shared, pure TypeScript model of how fire agencies respond to a fire and
manage their resources: initial attack by run card, containment tactics, escalation and resource
orders, departments and mutual aid, and unit states. It runs the `/live` command board's
rule-based response today. Simulation Studio sends its run card from the same fleet. Every
number below is sourced, derived from sourced numbers, or a named **ASSUMPTION**. Outputs are
planning experiments, not operational dispatch guidance.

## Code

| File | What |
| --- | --- |
| `app/src/response/rng.ts` | Seeded stream (mulberry32, as the board), derived from the board seed with a salt, so response draws do not move the ignition sequence |
| `app/src/response/fleet.ts` | Departments, tiers, units and aircraft from the facilities on and near the board (`buildFleet`), the one units-per-facility table (`FACILITY_INVENTORY`), the plain summary (`summarizeFleet`), turnout by staffing (`engineTurnoutMinutes`) |
| `app/src/studio/mapResources.ts` | Studio: the fleet from the facilities around the board (`mapResources`) and the run card filled from it (`planMapDispatch`) |
| `app/src/studio/useMapStations.ts` | Studio map: a labelled marker for every facility that can respond |
| `app/src/response/runCards.ts` | Dispatch level from fire danger, run cards, initial-attack (IA) size, escalation stages and orders, the Operations Bulletin #1 caps, `ORDERABLE` |
| `app/src/response/containment.ts` | Tactic by flame length, production per tactic, line needed, seeded holding test, Fried & Fried check |
| `app/src/response/orders.ts` | Mutual aid and state tiers, fill draws, lead times, state caps |
| `app/src/response/travel.ts` | BPR congestion from evacuation flows on shared roads, seeded travel variation, fire-cut test |
| `app/src/response/units.ts` | Work/rest, water, availability, move-up, mop-up release, aircraft cycles and flight gating |
| `app/src/response/report.ts` | Time from ignition to dispatch by remoteness (nearest home in sight, nearest road, night), AI camera and satellite detection, 911 answering, transfer and processing (`reportDelay`) |
| `app/src/response/reach.ts` | Off-road reach from where a unit parks: hose reach, hiking in (Tobler), engine crews on foot, dozers walking in (`planWork`) |
| `app/src/demo/boardResponse.ts` | The board adapter: applies the model each board step (`respondToNewFire`, `responseTick`, `advanceContainment`, `escalate`, `placeOrder`) |

Wiring: `demo/model.ts` calls the adapter from `ignite` and `stepOnce`. `send_crew` uses the
same dispatch path (`dispatchTeam`), and the new `order_resources` order calls `placeOrder`.
`demo/observation.ts` adds `fires[].tactic/dispatch_level/ia_status/escalation_stage/first_arrival_min/line_breaches/air_line_m/aircraft`,
`crews[].department/tier/water_pct/work_h`, and a `response` block (departments, aircraft,
orders, `orderable`, IA record). The shapes are in `demo/contracts.ts`.
`useCommandBoard` exposes `ruleResponse` and `setRuleResponse`; both are on by default and the
page has no toggle yet. In Studio, `studio/mapResources.ts` builds the same fleet from the
facilities around the board and sends the run card from it (see "Resources come from the map");
`crewDispatch.ts` routes each chosen unit from its own base. The server validates
`order_resources` in `app/backend/api/demo.py`.

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
- **Dispatch waits for the report**: the run card goes out when the dispatch centre has the
  fire. See "From ignition to dispatch" below.

## From ignition to dispatch

`reportDelay` (`response/report.ts`) draws, per fire and seeded, the minutes from ignition until
the dispatch centre has it, as a function of how remote the fire's origin is. The board sends
the run card then. The commander sees only reported fires, with `reported_after_min`,
`reported_by` and `reported_reason`. The fire list reads "Started 14:02 · reported 14:11 ·
first engine 14:24" (Pacific time; the board clock starts at the wind series' T+0). The fire
panel adds the reason, for example "Reported after 53 min — 7.9 km from the nearest home, at
night, found by satellite". Studio (`firefighting.ignitionReportDelayMinutes`) uses the same
model, seeded by the ignition's place and minute, for crew dispatch and aircraft. Studio has no
road lines, so there it uses homes only.

**Remoteness** d = min(distance to the nearest occupied home × 2 when terrain hides the smoke
from it, distance to the nearest road).
- *Homes*: the nearest developed landscape cell (FBFM40 91), or 0 inside a drill zone dense
  enough to be NFPA 1720 "suburban" (500 people/mi² or more, at 2.5 persons per household).
- *Line of sight*: 12 elevation samples between smoke 30 m up and an eye 2 m up.
- *Roads*: the board's evacuation route lines (drill roads; a partial network).
- *Assumptions*: the ×2, the 30 m and 2 m heights, and the household size. The NFPA 1720 bands
  are labels only.

Median minutes to the first 911 call, log-linear in 1 + d/250 m:

  day(d) = 3 × (1 + d/250)^0.748          night(d) = day(d) + 18.5 × (1 + d/250)^0.396

| Anchor | Value | Evidence |
| --- | --- | --- |
| d = 0, day | 3 min | ASSUMPTION: no absolute figure retrieved |
| d = 0, night | +18.5 min | NIST TN 2174 (Gilbert et al. 2021, NFIRS) Table 2: residential fires at night, smoke alarms present |
| d ≈ 1 km, day | 10 min | Camp Fire 2018 (Butte County DA, Camp Fire Public Report 2020, p.7): line interruption 06:15, seen about 06:20 from Highway 70, 911 received by the CAL FIRE ECC at 06:25:19. The 1 km distance is ASSUMED |
| d ≈ 1 km, night | 45 min | Grass Valley, 11 Sept 2023: ALERTCalifornia camera alert 05:19, first 911 call 06:01, "near a residential area". The distance is ASSUMED |
| Exponents 0.748 and 0.396 | Follow from the anchors | Derived; the 250 m scale is an ASSUMPTION |
| Spread | Lognormal, log-SD 0.7 | ASSUMPTION; Alberta delays have CV above 1 (Huang & Wichmann 2024) |
| Night | 23:00-06:00 Pacific anywhere (TN 2174's window), or darkness when d ≥ 1 km (smoke unseen) | ASSUMPTION on the second part; NOAA sunrise and sunset |

Beyond the anchors the curve is extrapolated: by day 29 min at 5 km and 80 min at 20 km.
Remote fires are then mostly found another way, whichever channel comes first:

| Channel | Model | Evidence |
| --- | --- | --- |
| AI camera (wildland) | In view for 60% of ignitions; median 15 min (log-SD 0.6) + 2 min ECC confirmation | ASSUMPTIONS. Check: ALERTCalifornia flagged 636 of 1,668 detected fires (38%) before any 911 call (Bay Area News Group, 2025) |
| Satellite (wildland) | Median 55 min (log-SD 0.8) + 5 min to act | Camp Fire: first GOES-16 hotspot about 07:10 PST, about 55 min after 06:15 (secondary source). The wide spread allows the Kincade Fire (2019): GOES-17 flagged it 5 min after ignition (Lindley et al. 2020, *J. Operational Meteorology*) |
| 911 answer | 90% within 15 s (median 8 s assumed) | NFPA 1225 (2022) 15.4.1, secondary source; another gives 10 s |
| Transfer to the CAL FIRE ECC | 90% within 30 s (median 20 s assumed) | NFPA 1225 15.4.2, secondary source, unverified |
| Processing | 90% within 64 s (median 40 s assumed) | NFPA 1710 4.1.2.3.3, as NFPA 1221 |
| Field reports | No discovery delay | Model |

Traffic on the nearest road is not used.

Sampled totals, ignition to dispatch (5,000 draws; median / p90, minutes; share first found by
911 / camera / satellite). Distance 0 is a structure fire, where cameras and satellites do not apply.

| d | Day | Night |
| --- | --- | --- |
| 0 | 3.8 / 8.2; all 911 | 22.1 / 52.2; all 911 |
| 250 m | 6.2 / 12.6; 95 / 5 / 0% | 18.7 / 41.0; 46 / 42 / 12% |
| 1 km | 10.3 / 20.9; 83 / 15 / 2% | 21.5 / 52.3; 33 / 49 / 18% |
| 5 km | 18.7 / 41.5; 46 / 41 / 12% | 24.6 / 74.3; 16 / 54 / 30% |
| 20 km | 24.0 / 70.1; 17 / 54 / 28% | 25.9 / 92.5; 6 / 55 / 39% |

## Off-road reach

A unit parks at the end of its road leg: the last point of the `crew_routes` line, which stops
at the road node nearest the fire that its class may use. Without a road leg the access is
unknown; it is taken to park at its target and labelled "road access not known". From there
`planWork` (`response/reach.ts`) sets how it works:

| Unit | Works the edge when | Line | Evidence |
| --- | --- | --- | --- |
| Engine, hose | The edge is within hose reach: Type 3 305 m (1,000 ft of 1½-inch), Type 1 152 m (500 ft) | PMS 465 p.164 engine rate | NWCG PMS 200 Engine Typing Standard hose minimums. Reach = the 1½-inch trunk, no extra hose: ASSUMPTION |
| Engine crew on foot | Beyond hose reach, up to 800 m: hikes in, then builds hand line | Persons (Type 3: 3, Type 1: 4, PMS 200) × PMS 465 p.39 Table 1 per-person chains/h for the fuel model | 800 m: ASSUMPTION (the crew stays near its engine and water) |
| Hand crew | Up to 3 km: hikes in | Broyles 2011 (direct or indirect) | 3 km: ASSUMPTION (escape routes back to the road) |
| Dozer | Up to 3 km, at 3 km/h off the lowboy, only if no sampled slope on the way exceeds 55% | PMS 465 p.140 | 55%: data leaf. Speed and distance: ASSUMPTIONS |
| Anything else | Out of reach | none | |

- **Hiking time** follows Tobler's hiking function (Tobler 1993, NCGIA TR 93-1):
  6·exp(−3.5·|S + 0.05|) km/h, × 3/5 off path, with S the climb from parking to the nearest edge
  point over the distance. That gives 3.0 km/h on the flat, 1.06 km/h up 30% and 1.5 km/h down
  30%. 1.5 km on the flat takes 30 min; 1.5 km with a 300 m climb takes 60 min.
- **Reach envelope**: each working unit reaches a disc of its reach radius around where it
  parked. The fire's open edge is sampled (up to 400 burned cells facing ground that can burn,
  refreshed every 5 min). `edge_in_reach_pct` is the share of the sample inside any working
  unit's disc.
- **Containment** (Fried & Fried) counts ground line only up to the reachable share of the line
  needed. Aircraft line can cover the rest, but containment still needs a ground unit working
  the edge. A fire whose edge is mostly out of reach is not contained by ground units. Forecasts
  (`containedIn`, `contained_in_min`) apply the same cap, the hike time and the on-foot rates.
- **UI**: the fire panel shows "E12 parked 600 m from F3 — hiking in to build hand line, ~14 min"
  per unit, and "Only 40% of this fire's edge is within reach of ground crews" when below 100%.
  The observation adds `crews[].parked_m/work_mode/working_in_min`.
- **Not modelled**: hose-lay speed on slopes (the PMS 465 engine table has no slope classes);
  engines repositioning along roads; trails; and the backend's own "no road within 1 km" answer
  (`target_off_network`), which still leaves the unit on a straight-line estimate to its target.
  Another agent owns that routing.

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

## Resources come from the map

The units that can respond are a pure function of the fire facilities on and near the current
board. Nothing is set by hand: Studio has no unit counts (only Firefighting on/off and the T+0
clock, which sets aviation daylight), and the /live board has no fixed roster.

- **Facilities** (`GET /api/suppression/bases`): the CAL FIRE Facilities for Wildland Fire
  Protection layer, with observed location, facility type, agency, unit code and staffing, plus
  the OpenStreetMap fire stations the layer does not list (`withOsmStations`: an OSM station within
  500 m of a layer facility is that facility, **ASSUMPTION** as `crewDispatch.ts`). The layer covers
  wildland protection, so city departments (San Francisco, Oakland) are often only in OSM. OSM
  stations come from the drill package (/live) or the board's roads (`DispatchArea.stations`,
  Studio). Without the layer, OSM stations alone. Neither path invents crew camps or air bases.
- **Tiers**: facilities inside the board answer initial attack (closest resource). The rest of
  the list (the endpoint returns the nearest 40 stations and 10 camps) is the mutual-aid pool.
  Beyond that, orders go to the state system ("Escalation and resource ordering").
- **Aircraft** come only from air attack bases (AAB) and helitack bases (HB) in the layer, within
  a dispatch radius of a 20-minute flight at the aircraft's cruise (`AIR_DISPATCH_FLIGHT_MINUTES`,
  **ASSUMPTION** after CAL FIRE's commonly quoted goal of reaching most fires within 20 minutes,
  not re-fetched): about 142 km for an S-2T (230 kt, IASG Table 3) and 62 km for a helicopter
  (100 kt, assumed). Time over the fire and the airtanker cycle follow from the distance
  (`studio/aircraft.ts`). /live fetches facilities within 150 km of the drill centre so the
  airtanker radius is covered; Studio uses the endpoint default of 250 km around the board centre.
- **No facilities at all**: no local units. /live says "No fire stations found on this map" and
  every run card goes short, so its ground shortfall is ordered from out of the area through the
  state tier (about 4.5 h to the board edge). Studio sends the shortfall the same way.
- **On the map**: every contributing facility is drawn with a plain label, for example
  "Paradise FS · CAL FIRE · 2 engines, 1 dozer" (Studio map: `studio/useMapStations.ts`;
  /live board: `demo/boardMapLayers.ts`). Mutual aid is drawn fainter and labelled
  "mutual aid"; air bases are squares in Studio. So what is on the map is what can respond.
- **Studio summary**: one line, for example "From the map: 9 stations · 11 engines, 2 crews,
  1 dozer · air from Chico AAB, ~10 min", with the per-station list, counts per type and their
  line rates, the inventory table and the T+0 clock under a collapsed "Details".
- **Studio dispatch** (`planMapDispatch`): the run card for the dispatch level from the scenario's
  fuel moisture (nearest `MOISTURE_PRESETS` entry by 1-h moisture, **ASSUMPTION**) and wind, or the
  structure card when the fire starts on developed ground; filled by the closest units on or off
  the board by estimated arrival (turnout + straight line × 1.3 at the heavy-apparatus secondary
  road speed), then routed on the board's roads. Aircraft: the nearest of each kind within its
  radius of the fire; an aircraft the map cannot supply is reported, not flown. Studio sends the
  initial-attack card only; escalation needs the board's minute loop (/live).
- **Old Studio drafts and files** with hand-set counts: the counts are dropped on load
  (`parseScenario`, draft defaults version 3) and the panel says "Units now come from the stations
  on the map".

### Units per facility (`FACILITY_INVENTORY`, `response/fleet.ts`)

The layer has no apparatus, so what each facility fields is the one remaining assumption, kept in
a single table. Staffing sets turnout (80 s paid, 120 s otherwise; "Initial attack"), not counts:
no source ties counts to staffing.

| Facility (type, agency) | Units | Evidence |
| --- | --- | --- |
| CAL FIRE station (FSA, FSB, FSAB, FSL, FSCC, FSO; agency CAL FIRE) | 1.6 Type 3 engines (k-th station of a unit: floor(1.6k) − floor(1.6(k−1))) | Derived: 343 engines / 220 stations, 2019 (calfire_house_2019; data leaf), as `livecore/apparatus.py` |
| CAL FIRE unit | 1 Type 2 dozer at its first (nearest) station | ASSUMPTION |
| Local, Schedule A or contract county station | 1 Type 1 engine | ASSUMPTION, as `livecore/apparatus.py` |
| Federal station | 1 Type 3 engine | ASSUMPTION |
| OSM station (CAL FIRE layer unavailable) | 1 Type 3 engine | ASSUMPTION, as `dispatch/stationApparatus.ts` |
| Conservation camp or crew fire centre (CC, FCFFC) | 2 Type 1 crews | ASSUMPTION |
| Air attack base (AAB) | 1 air attack + 2 S-2T | Derived: 12 air tactical and 22 airtankers at 13 bases (calfire_house_2019) |
| Helitack base (HB) | 1 Type 2 helicopter | ASSUMPTION (10 staffed helicopters, 17 bases in the layer) |

## Departments and mutual aid

`buildFleet` groups the facilities into departments by agency class and unit code. Examples near
Paradise: CAL FIRE BTU unit, Paradise FD (PRA, Schedule A), Butte County Fire (BTC, Schedule A),
and the volunteer companies of the BTU area. On a 60 km board (`fire/boardSize.ts`) most of the
listed stations are on the board. **Drawdown**: a department keeps floor(25% of its engines)
uncommitted (**ASSUMPTION**), so a department with fewer than 4 engines keeps none. It always
answers fires within 5 km of one of its stations (**ASSUMPTION**).

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
- **Residential versus rural, before call-in delays and off-road reach** (dispatch at ignition), 6 seeds, 6 h each, 5.9 m/s wind, dry moisture:

  | Scenario | First engine (min) | Contained after (min) | Area at containment (ha) | Damage | IA |
  | --- | --- | --- | --- | --- | --- |
  | Residential: central Paradise on FBFM40 91, structure card | 3-5 (median 3) | 10-12 | 0.4 | 0.4 ha developed burned, 0 households caught | 6/6 contained |
  | Rural brush: SH5, nearest station 10 km (-121.802, 39.360) | 11-13 | 286-307 in 3 seeds; not contained by 6 h in 3 | 225-258; 358 at 6 h when not contained | 45 households caught (synthetic zones of 15) | 0/6; 13 orders each, stage 2 |
  | Rural grass: GR2, same point | 11-13 | 22 | 1.1 | none | 6/6 contained |

  NFPA 1710 (first engine within 80 s turnout + 240 s travel, about 5.3 min) is met in the
  residential case, but on straight-line travel. NFPA 1720's rural 14 min is met by the rural
  first engines. The board's solver path enables structure-to-structure spread
  (`demo/fireField.ts` passes `DEFAULT_STRUCTURE_SPREAD`), so developed ground (FBFM40 91)
  burns; these runs used it. The expected direction holds: the residential fire spreads slowly
  (the solver's structure spread, 4 m/min at 20 mph scaled by wind) and is caught small, while rural brush
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

### With call-in delays and off-road reach (seeded natural variation on, the board's default; 4 seeds; day 12:00 and night 02:00 PDT; 6 h)

These runs went through `buildFireSolveRequest`, so they used the board's seeded natural
variation (`naturalVariation: true` by default; `stochastic` passed to the solver). An earlier
note here called them deterministic, which was wrong. The first "Measured" table above predates
natural variation and was deterministic. Report delays in this table are from the earlier
three-band model; the remoteness model's re-run is in the next table.

First engine and containment are minutes from **ignition**. "Remote" means every road leg was
made to end 1.5 km short of the fire, as `crew_routes` reports when roads stop short.

| Scenario | Reported after | First engine | First line work | Contained after | Area at containment or 6 h | IA (≤ 10 acres) | Households caught |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Residential day | 2.3-4.8 (911) | 7-8 | 7-8 | 13-15 | 0.4 ha | 4/4 | 0 |
| Residential night | 11.7-29.3 (911) | 17-33 | 17-33 | 24-45 | 0.4-0.7 ha | 4/4 | 0 |
| Rural brush (SH5) day | 4.8-15.8 (2 by camera) | 17-27 | 17-27 | not by 6 h | 491-683 ha | 0/4 | 60-75 |
| Rural brush night | 10.4-25.9 (camera) | 25-41 | 25-41 | not by 6 h | 491-683 ha | 0/4 | 60-75 |
| Rural grass (GR2) day | 4.8-15.8 | 17-27 | 17-27 | 27-38 | 0.7-2.5 ha | 4/4 | 0 |
| Rural grass night | 10.4-25.9 | 25-41 | 25-41 | 142-175 | 10.8-56.5 ha | 0/4 | 15 |
| Remote grass day | 4.8-15.8 | 16-26 (engines park 1.5 km out, idle) | 91-111 (hand crew after a 30 min hike) | 91-111 | 4.0-30.2 ha | 1/4 | 0-15 |
| Remote grass night | 10.4-25.9 | 24-39 | 110-137 | 234-244 | 44.6-119.5 ha | 0/4 | 15-30 |
| Remote brush day / night | as above | 16-39 | 91-137 | not by 6 h | 491-683 ha; 29-47% of the edge within reach | 0/8 | 60-75 |

From the 911 call, the residential first engine (7-8 min after ignition, minus a 2-5 min call-in)
is 3.5-5 min. That is inside NFPA 1710's 6.4 min (64 s processing + 80 s turnout + 240 s travel),
but on straight-line travel. The night penalty is the call-in, not the drive. On the 24 h boards
(2 seeds) the first-arrival median from ignition is now 37-38 min in SH5 (was 19-22) and 18-19
min in GR2 (was 5-6). IA success is 0-3% in SH5 and 100% in GR2. In GR2 every caught fire is one
75 m cell (0.56 ha), so the burned total does not change. Board and response logic still take
0.4-0.6 s of CPU per simulated day.

### With the remoteness model (natural variation on; 4 seeds; 6 h; minutes from ignition)

The rural cases have a hamlet (developed cells) 0.9 km from the ignition, like Camp. The remote
cases have their nearest homes 7.9 km away and every road ending 1.5 km short of the fire.

| Scenario | Reported after (reason) | First engine | Line work starts | Contained | Area | IA ≤ 10 ac | Caught |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Residential day | 2.3-4.8 ("among homes") | 7-8 | 7-8 | 13-15 | 0.4 ha | 4/4 | 0 |
| Residential night | 11.7-29.3 ("among homes, at night") | 17-33 | 17-33 | 24-45 | 0.4-0.7 ha | 4/4 | 0 |
| Rural grass day | 5.0-19.5 ("900 m from the nearest home") | 19-39 | 19-39 | 28-42 | 0.7-2.5 ha | 4/4 | 0 |
| Rural grass night | 13.4-26.5 (2 of 4 by AI camera) | 28-40 | 28-40 | 154-170 | 15-66 ha | 0/4 | 15 |
| Remote grass day | 13.4-26.5 ("7.9 km from the nearest home"; 2 by camera) | 26-38 | 109-143 | 109-143 | 7.9-31 ha | 0/4 | 0-15 |
| Remote grass night | 13.4-52.8 (1 by satellite at 52.8, 3 by camera) | 26-64 | 109-151 | 236-268 | 46-127 ha | 0/4 | 15-30 |
| Rural brush day / night | 5.0-26.5 | 19-40 | 19-40 | not by 6 h | 491-683 ha | 0/8 | 60-75 |

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
- **Report delays**: the 3 min doorstep median, the 250 m scale, the anchor distances, the
  camera coverage of 60% and the camera and satellite times are assumptions. There is no camera
  or road-traffic map, Studio has no road lines, and the 911 load of a large fire (queued
  calls) is not modelled.
- **Diurnal fire weather**: night runs use the same wind and moisture as day; the board has no
  diurnal cycle. Night is slower only through the call-in.
- **Stochastic spread**: the board passes seeded natural variation to the solver (`model.ts`
  `buildFireSolveRequest`, on by default), and the later measurements used it.
- **Reproducibility**: the browser steps the clock in variable fractions of a minute and road
  legs arrive asynchronously. A browser run is reproducible in its seeded draws but not
  minute-exact; a headless run with the same steps is exact.
- **The dispatch agent** (`dispatch/engine.ts`) still has its own containment and tactics; it
  could use `response/containment.ts` next.
- **No UI**: the page shows the new statuses and events, but no panel yet for orders,
  departments or aircraft.
