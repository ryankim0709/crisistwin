# 0036: Simulated residents derived from the traffic twin

Date: 2026-10-24. Status: accepted (generator only; not yet wired into the live server).

## Context

The scenario engine (`docs/adr/0030-scenario-engine.md`) needs a **people** generator: simulated
residents who send the same phone data real residents send in a live drill (check-ins, help
requests, field reports, destination choices), so a drill or a headless run has ground data without
real phones. ADR 0030 asks that they derive from the twin's vehicles, so the traffic and the phone
activity tell one story.

## Decision

`sim/gen_residents.py` (standard library, pure, seeded) observes a `sim.twin.Twin` and emits events.

**Population.** Each twin zone's `households` share its `vehicles` exactly
(`allocate_vehicles`): one each, a second for some (`VEHICLES_TAKEN_CAP = 2`, as `sim/demand.py`),
and carless households only when a zone has fewer vehicles than households. Party keys are synthetic
(`sim_` + a hash of seed, zone and household index). No real resident data is used.

**Mapping to the twin.** The fixed-delay twin (the Camp replay) does not carry packet identity past
departure, so households are *assigned* to vehicles, not tracked:

- The twin's per-zone counters (`z_departed`, `z_arrived`) say how many vehicles have left and
  arrived. A seeded per-zone order says which households: a household has departed once its first
  vehicle is among the departed, and is `out` once all its vehicles have arrived. Conservation holds
  by construction; the generator asserts it every observation.
- En-route households are placed on their zone's actual packets (edge queues, nodes waiting for an
  edge, turned-back packets), most advanced first by the twin's remaining route cost. Their queue,
  closure and fire exposure are the twin's.

**Events** (all only from app households, at or after the state that causes them):

| Event | When | Body |
| --- | --- | --- |
| check-in `out` | all of the household's vehicles arrived; after a lognormal delay | `{status, zone_id}` |
| check-in `need_help` | hazard while at home with fire at an origin node of the zone, or while the twin reports the vehicle blocked; once per household | `{status, zone_id, coord}` |
| check-in `staying` | a household of the staying share, when its zone is ordered or fire reaches it | `{status, zone_id}` |
| report `heavy_traffic` | on an edge with ≥ 10 queued vehicles and < 0.5 of free-flow speed; once per road | report body, `severity: "slow"` |
| report `road_blocked` | a closed road in the vehicle's way (below); once per road | report body, `severity: "full"`, at the closed edge |
| report `fire_seen` | within 2,000 m of modelled fire (burned edge midpoints, burned origin nodes); once | report body, at the reporter |
| `me/destination` | on departure, a share choose among the zone's offers | `{zone_id, destination_id}` |

A closed road is "in the way" when the vehicle's own edge is event-closed, when the same road
continues closed at the node ahead (unless the vehicle is already driving out over burned road, which
the twin allows), or when the twin reports the vehicle blocked. Fire-closed side streets at an
intersection are not reported. A first version counted every closed edge leaving the node ahead, once
per segment. On the 3-hour Camp run below it produced 12,310 `road_blocked` reports. This rule
produces 476.

**Event shape.** Each event carries the exact POST body plus provenance, so a driver can POST it with
a civilian token or insert it directly:

```jsonc
{ "type": "checkin",                       // report | checkin | destination
  "method": "POST", "path": "incidents/camp-2018-drill/checkins",   // or .../reports, me/destination
  "body": { "status": "need_help", "zone_id": "bg:060070024001", "coord": [-121.510645, 39.794918] },
  "at": "2018-11-08T15:13:00Z",            // drill (replay) time, UTC
  "party_key": "sim_bd10e8095e53b36e",     // stable synthetic id
  "evidence_class": "simulated",
  "zone_id": "bg:060070024001", "household": 216,
  "cause": { "state": "not_departed_fire_in_zone", "at": "2018-11-08T15:13:00Z" },
  "generator": "gen-residents@0.1.0" }
```

Report bodies have `client_id` (a deterministic UUID), `kind`, `severity`, `location {coord,
accuracy_m}`, `heading_deg: null`, `destination_id: null`, `task_id: null`, `observed_at` (= `at`),
and `note: "Simulated resident (gen-residents)"`. Inserted directly, a report must be stored with
`evidence_class: "simulated"`. A POSTed report is stamped `field_report` by the server. A driver that
POSTs during a running drill should set `observed_at` to wall time. The server stamps `replay_at`.
Destination choices are validated against the zone's current guidance: pass `offered=` from
`situation.guidance[].alternatives`. The default offer list is the nearest usable twin destinations.

**Invariants** (`check_invariants`, run by `run_residents`): every event is labelled `simulated`
and comes from a known app household; bodies pass the live API's input checks; events are in time
order and never before their cause; at most one `out` per household and none from a carless one; no
`need_help` after `out`; checking-in parties ≤ households; `out` per zone ≤ the zone's households.

**Driver.** `run_residents(twin, until, params, every_s=60, incident_id=..., offered=...)` steps the
twin and collects events, the population summary, counts, help rates and provenance (twin
fingerprint and action-log hash, parameters, seed). `camp_twin(start_at, root)` builds the Camp twin
with the live drill's packages. CLI: `python3.12 -m sim.gen_residents --from ... --until ...`.

## Assumptions (named constants in the module)

| Constant | Value | Basis |
| --- | --- | --- |
| `APP_ADOPTION` | 0.25 | ASSUMPTION within reported opt-in alert enrollment of about 2-40% of residents: Sonoma SoCoAlerts about 2% (2017), Santa Barbara Nixle about 9% (2019), NotifyLA 5% (2019), Paradise CodeRED under 40% (2018). Sources: [KTVU](https://www.ktvu.com/news/2-investigates-why-didnt-officials-sound-mass-wildfire-alert), [Noozhawk](https://www.noozhawk.com/state_senate_passes_bill_automatically_enroll_residents_emergency_alerts/), [TMJ4/Scripps](https://www.tmj4.com/news/national/californians-say-they-didn-t-receive-emergency-wildfire-alerts), [Local News Matters](https://localnewsmatters.org/tag/codered/) |
| `STAYING_SHARE` | 0.03 | ASSUMPTION; they are the zone's last departures, and they check in `out` if the twin later moves their vehicle |
| `OUT_CHECKIN_SHARE`, lag | 0.8; lognormal median 5 min, sigma 0.8, cap 60 min | ASSUMPTION |
| `NEED_HELP_HAZARD_AT_HOME_PER_H` | 0.1 /h | ASSUMPTION (see the comparison below) |
| `NEED_HELP_HAZARD_TRAPPED_PER_H` | 0.5 /h | ASSUMPTION |
| `REPORT_PROB_PER_ENCOUNTER` | heavy_traffic 0.05, road_blocked 0.2, fire_seen 0.1 | ASSUMPTION |
| `HEAVY_TRAFFIC_MIN_QUEUED_VEH`, speed fraction | 10 veh; 0.5 | ASSUMPTION; 0.5 is the twin's `CONGESTED_SPEED_FRACTION` |
| `FIRE_SIGHTING_DISTANCE_M` | 2,000 m | reused from `sim/behavior.py` `fire_cue_distance_m` (an assumption there) |
| `DESTINATION_CHOICE_SHARE`, `RECOMMENDED_CHOICE_SHARE` | 0.3; 0.7 | ASSUMPTION |
| `REPORT_ACCURACY_M` | 10 m | ASSUMPTION (GPS.gov: smartphones about 4.9 m under open sky) |
| `CAMP_*_RATE_FIRE_IN_ZONE_PER_KHH_H` | rescue 3.41, 911 sample 2.82 (x >= 3.67) | CALIBRATED reference only, `docs/ground-data-calibration.md` section 2 (branch `feat/live-replay-sim`) |

## Measured (Camp twin, 2018-11-08 15:00-18:00Z, seed 20181108, 60 s observations)

19,913 households, 31,638 vehicles, 4,961 app households. Generation took about 10 s, after a 12 s
twin build. Events: 1,065 `out`, 193 `need_help`, 128 `staying`, 1,181 destination choices, 324
`fire_seen`, 1,336 `heavy_traffic` and 476 `road_blocked`. With seed 1, each event count was within
15% of these (`staying` 110, `road_blocked` 443, help 35.0 per kHH·h). The same seed reproduces the
identical event list.

**Help rate against the 2018 record.** Counting every household, not only app households, the
generator produced **35.6 help requests per 1,000 households per hour** in zones the fire had
reached. The record's rates for zones the fire had reached, 0-2 h after the order, are **3.41**
(K-1 rescue) and **2.82** for the NIST 911 sample. The sample understates true 911 volume by at
least 3.67x, so the 911 rate is at least **10.35**. The generator is therefore about 10x the rescue
rate and about 3.4x the 911 lower bound.

The constant was not adjusted to close this gap. These are not the same quantity. The record counts
calls and rescue entries from a sample of unknown coverage, and its 911 figure is a lower bound. The
generator counts first requests per household, from a twin whose departure timing is uncalibrated,
over all order phases. Neither number is a calibration of the other.

If the app's help requests behave like 911 calls, the at-home hazard is high by 3x or more. Sweep it
(`ResidentParams(help_at_home_per_h=...)`) before reading anything into help volumes. `rates()` reports
this comparison with every run.

## Consequences

- One population for traffic and phones: a check-in `out` happens only after the twin's vehicles
  arrive, and road reports come from where the twin's queues and closures are.
- The generator reads the twin engine's state (`queue`, `waiting`, `returning`, per-zone counters,
  closure and fire sets) but never writes it. A change to those internals breaks it loudly (its
  conservation asserts), not silently.
- Destination choices do not steer the twin's vehicles. The live planner uses them only as a soft
  load input.
- Tests: `tests/test_gen_residents.py` covers determinism, conservation step by step, causality and
  the invariant checker, rate sanity (help hazard, out share, choice shares and app adoption, each
  within 4 sigma), and shape. The shape tests run the server's `_validate_report` and compare
  constants when Django is importable (backend venv). An optional Camp window test runs when the
  package artifacts are present (`CRISISTWIN_DATA_ROOT`).
