# Running a scenario live (`live_run_scenario`)

A watched drill can fill itself with calibrated, simulated activity: the generators of a batch
scenario spec ([batch runner](batch-runner.md)) run against the **active incident** on the live drill
clock, writing through the same paths real participants use, so the console and phones see it.
Design: [ADR 0030](adr/0030-scenario-engine.md) §2. Code: `app/backend/api/live/scenario_runner.py`,
command `app/backend/api/management/commands/live_run_scenario.py`.

**Everything it writes is simulated and labelled** (`evidence_class: "simulated"`, simulated devices,
a `comms.label` on generated calls). It is a planning experiment, not observed data, and it contacts
nobody outside the drill.

## Commands

Start a backend, then run the scenario against it (from `app/backend`, with the backend venv). The
example uses a throwaway database and the Camp bundle; the Camp twin also needs the package artifacts
under `data/incidents/` (git-ignored).

```sh
export MONGODB_URI=mongodb://127.0.0.1:27017 MONGODB_DATABASE=crisistwin_runner_dev
export LIVE_CONTROLLER_TOKEN=dev-controller LIVE_INVITE_CODE=DRILL
export LIVE_DRILL_BUNDLE=$PWD/../public/replays/camp-2018.json
python manage.py live_init_db
python manage.py runserver 127.0.0.1:8040 --noreload &

python manage.py live_run_scenario --spec api/live/specs/camp-2018-live-typical.json \
    --base http://127.0.0.1:8040 --speed 10 --start
```

| Flag | |
| --- | --- |
| `--spec` | A batch scenario spec (same JSON), plus the optional `live` block below |
| `--start` | (Re)start the drill clock at the spec's `window.start` |
| `--speed` | Set the drill speed. The runner always follows the drill clock: without the flag it keeps whatever speed the console sets, pauses when the clock pauses, and restarts its generators when the clock is reset |
| `--seed` | Panel seed (default: the spec's first seed) |
| `--noise` | `clean`, `typical` or `hostile` (default: `live.noise_profile`, else `typical`) |
| `--duration` | Stop after this many wall seconds (default: at `window.end` or Ctrl-C) |
| `--interval` | Wall seconds between ticks (default 2) |
| `--invite`, `--controller-token` | Default to `LIVE_INVITE_CODE`, `LIVE_CONTROLLER_TOKEN` |
| `--summary-out` | Write the final counts as JSON |

## Spec additions

```jsonc
{
  // ... the batch spec (docs/batch-runner.md) ...
  "comms": {"enabled": true, "bursts": true},       // within-zone bursts (sim/gen_comms.py, docs/ground-data-calibration.md)
  "residents": {"enabled": true},                    // any ResidentParams field, e.g. "no_vehicle_share"
  "twin": {"enabled": true, "people": "camp_2018_sourced"},  // or "grounded", "historical" (default), or fields
  "live": {"noise_profile": "typical",
           "comms_towers": {"enabled": true, "scenario_date": "2018-11-08"}}
}
```

`twin.people` and `comms.bursts` apply to the batch runner too. `record_2018` is ignored live: the
server always serves the 2018 Camp record itself. The batch runner ignores `live`.

## What runs, and where it writes

| Stream | Generator | Path into the drill |
| --- | --- | --- |
| Residents: reports, check-ins (out, staying, need help, transport), destination choices, board answers | `sim/gen_residents.py` on the runner's own twin | HTTP, one civilian device per household (`sim_` party key, `simulated: true`, token derived from the server secret, seed and party key) |
| 911, radio, rescue | `sim/gen_comms.py` (drawn up front from the seed) | `groundrecord.materialize_simulated`: the review queue, as unverified `simulated` reports |
| Responders | `livecore/responders_sim.py` | `live_sim_responders`' HTTP tick (joined with the invite code, flagged simulated) |
| Noise and truth | `sim/gen_noise.py`, per drill minute | noised events take the paths above; the hidden truth goes to `sim_truth` |
| Injects | the spec's injects, and `sim/comms_towers.py` outages | `POST incidents/{id}/injects` (actors `scenario`, `comms_towers`) when the clock reaches them |

- **The twin** is the runner's copy of the live twin (the batch runner's inputs and seed rule,
  with `twin.people`). Every drill minute it takes the published live guidance (`evacuate_now`
  becomes `order_zone`, the destination becomes `reroute_zone`) and the live road state and silent
  closures (closures), so simulated residents react to what the console publishes. The console's own
  twin panel runs the server's twin, which does not get `twin.people`.
- **Destination choices** are made only among the live guidance's offered destinations
  (`alternatives`, `state.offered_destination_ids`); with no published guidance there are none.
- **Generated comms** follow the 2018 record's rules: their ~100 m points are controller-only
  (`GET reports` hides them from responders), they count for nothing (corroboration, public map,
  road state, fire) until a controller confirms them (`groundrecord.queue_only`), a drill reset
  deletes them, and a `psap_reroute` inject drops the 911 items of its zones.
- **Labels on HTTP writes**: a device marked `simulated` stores its reports as
  `evidence_class: "simulated"` (never `field_report`) and its check-ins and destination choices
  with `simulated: true`. This also labels `live_sim_responders` reports.
- **Comms outages**: the server refuses phone traffic of a zone in a `comms_outage` (503
  `no_signal`); the runner keeps those events in the phone's outbox and resends them when the outage
  ends (counted as `held_no_signal` and `...:after_outage`). Responders keep their radio.
- **Rate limits** are the server's: 30 civilian reports per minute per IP. All simulated phones post
  from one address, so above about speed 3 on Camp the runner's reports are delayed (429, retried
  on later ticks, `rate_limited_429`). The run below shows it.
- **Restarts are idempotent**: the runner replays from `window.start`; report `client_id`s are seeded
  UUIDs, comms `client_id`s are `simcomms:<seed>:<item id>`, devices and check-ins are keyed by the
  household's party key, and injects already posted are skipped.

## Realism and calibration in the generators

### Residents' help rate (recalibrated)

Target: the Camp rescue (K-1) rate in zones the fire had reached, 0-2 h after the order,
**3.41 /kHH/h** (95% CI 2.71-4.25; [ground-data calibration](ground-data-calibration.md) §2). One
latent help request per household is an incident, which is what the rescue log counts. Ceiling: 911
help calls, scaled by the lower bound on 911 volume, 2.82 × 3.67 × 0.60 (help_needed + trapped share
after arrival, §3) = **6.21 /kHH/h** (all 911 calls: 10.35).

Measure: `ResidentGenerator.rates()["fire_zone_latent_help_per_khh_h"]`, latent help (app or not,
at home or trapped) per 1,000 households × hours in zones whose origin nodes the modelled fire reached;
the Camp twin as the live drill builds it, 14:30-18:00Z, seeds 1-3.

| `help_at_home_per_h` (trapped = 5×) | Rate /kHH/h, seeds 1, 2, 3 | Mean |
| --- | --- | --- |
| 0.1 (before; trapped 0.5) | 35.0 (seed 1) | 10.3× the target, 3.4× the 911 ceiling |
| 0.0085 | 3.52, 3.22, 3.26 | 3.33 |
| **0.0095 (after)** | 3.39, 3.52, 3.13 | **3.35** |
| 0.0105 | 4.05, 3.92, 3.74 | 3.90 |

`NEED_HELP_HAZARD_AT_HOME_PER_H = 0.0095`, `NEED_HELP_HAZARD_TRAPPED_PER_H = 0.0475` (the 5:1 ratio of
the old assumptions is kept, `NEED_HELP_TRAPPED_TO_HOME_RATIO`). The sweep ran with households without a
vehicle on (the new default). Transport requests are counted apart and are not in this rate.

### Households with no vehicle

Per-zone ACS counts from the twin's demand report (`households_no_vehicle_in_extract`, ACS 2014-2018
B25044, the same vintage and clipping as the twin's vehicles; else Butte County 0.0608 from
`tools/people_behavior.json`). On Camp: **1,172 of 19,913 households** (5.9%). They own no twin
vehicle and never drive; the zone's vehicles are shared among the others, so the twin's vehicle count
is unchanged and conserved. `CARLESS_TRANSPORT_REQUEST_SHARE = 0.5` of them ask the drill for
transport (a `need_help` check-in with their location, cause `no_vehicle_transport`) at 2.0/h once
their zone is ordered or fire reaches it. **Both numbers are assumptions** (no source gives them);
on Camp 14:30-18:00Z they give about 510-540 latent transport requests (130-150 from app households).
For scale, NIST TN 2252 §10.5.8 counts at least 59 of 198 Camp entrapment/assistance/rescue events
involving a pre-existing condition, including no vehicle. Transport requests are not rescues, but the
default is probably high; vary `residents.carless_transport_share`. Summaries report
`no_vehicle_households`, `noncompliant_households` and `transport_requests_latent`.

### People behaviour (`twin.people`)

`sim/behavior.py` `PeopleBehavior`, applied by `sim.twin.with_people_behavior` to the fixed-delay twin.
`historical` (the default) returns the inputs unchanged: same fingerprint (`dbe294975d1426a3`) and
the same totals as `main`.

| Field | `camp_2018_sourced` | Source |
| --- | --- | --- |
| `order_compliance` | 0.875 (range 0.870-0.968) | Wong et al. 2020 Table 11, Oct 2017 N. California fires (the fast, low-notice analogue; the choice is ours). Applied as demand participation (`sim.demand.with_participation`); in the residents generator the same share of vehicle households stays and says so |
| `shadow_evacuation_share` | 0.291 (range 0.291-0.750) | Same table. Packets of a zone with no order leave once fire reaches one of its origin nodes (`TrafficParams.shadow_evacuation_share`, own random stream) |
| `departure_delay_median_min` | 67.5, sigma 0.8 | Camp awareness-to-departure mean 93 min (Grajdura 2022 pp. 51-52, a difference of means); median of a lognormal with that mean and the existing sigma 0.8 (assumed) |

Camp twin from 14:30Z, measured (vehicles):

| Variant | Total | Departed by 16:00 | Arrived by 18:00 | Left unordered zones by 16:00 |
| --- | --- | --- | --- | --- |
| historical | 31,638 | 1,008 | 9,325 | 0 |
| compliance only | 27,680 | 881 | 8,573 | 0 |
| shadow only | 31,638 | 1,082 | 9,432 | 58 |
| delay only | 31,638 | 406 | 7,461 | 0 |
| camp_2018_sourced | 27,680 | 376 | 7,445 | 10 |
| grounded (measured 2026-10-24, TrafficParams seed 7) | 27,680 | 906 | 8,409 | not measured |

All Camp zones are ordered by 18:00 in the record, so shadow evacuation matters only early.

**`grounded`** (`twin.people: "grounded"`): the same compliance and shadow share, with the departure delay
of the per-household `grounded` profile (lognormal median 42.8 min, sigma 1.246: Camp's 93 min mean with
Marshall's spread; `sim/behavior_params.json`). The batch runner then also sets
`residents.behavior_profile: "grounded"`: every simulated household draws its own choices (warning reach,
stay or go, wait and see, leaving before any warning, delay, trips before leaving, route strategy,
destination type, pets, vehicles, help) from its own random stream, and the generator uses them to pick
which households stay, which leave first and which ask for transport. Values, sources and transferability:
[people data, Behaviour evidence](people-data.md#behaviour-evidence).

### Comms

- **Bursts**: a within-zone cluster process for radio and rescue (`CommsOptions.bursts`, default on;
  `False` is byte-identical to the old output). Radio refit dispersion: 1.93 → **3.63** (record 3.53);
  means unchanged within sampling error. Details and the remaining disagreements:
  [ground-data calibration](ground-data-calibration.md), "Bursts".
- **Tower failures**: `sim/comms_towers.py` schedules `comms_outage` injects per zone from its fire
  arrival, with parameters from `tools/comms_degradation.json` (fire-damage hazard, battery life, the
  72 h backup rule from 2021-07-16). Not calibrated; details and the disagreement with the observed
  2019 series: [comms infrastructure](comms-infrastructure.md), "Tower-failure model". In the example
  window (15:30-18:00Z) seed 20181108 schedules 4 outages (16:05Z onward, all fire damage).

## Example run (measured 2026-10-24)

`camp-2018-live-typical.json`, seed 20181108, noise `typical`, people `camp_2018_sourced`, 4 responder
units, fresh database, nobody at the console (so no published guidance), `--speed 10 --start
--duration 61`: drill 15:30-15:40Z (10 drill minutes, 61 wall seconds after a 13 s world build).
Posted per channel and kind:

| Channel | Kind | Count |
| --- | --- | --- |
| Resident reports (HTTP, `simulated`) | fire_seen | 29 |
| | heavy_smoke (a `wrong_kind` noise transform) | 1 |
| Resident check-ins (HTTP, `simulated: true`) | staying | 29 |
| | out | 3 |
| | need_help | 1 |
| Resident destination choices | (no published guidance, so nothing offered) | 0 |
| Generated 911 (review queue, `simulated`) | help_needed | 3 |
| | trapped (queued as help_needed) | 2 |
| Generated radio, rescue | (none drawn in these 10 minutes) | 0 |
| Responders (HTTP, simulated units) | join | 4 |
| | location | 36 |
| Injects | (first tower outage 16:05Z, PSAP reroute 16:20Z) | 0 |
| Truth log (`sim_truth`) | entries (6 false: wrong_kind) | 106 |

Delayed: 20 resident events got 429 (the per-IP report limit) and were still waiting for a retry when
the run stopped; 25 noised events (late uploads) were not yet due. The store matched the counts:
30 simulated resident reports, 5 generated 911 reports (hidden from a responder's `GET reports`,
shown to the controller), 6 2018-record reports (the server's own), 33 simulated check-ins. The same
command on another fresh database reproduced every count above exactly. A restart against a used
database (clock paused at 15:45Z) replayed from 15:30Z and found the first 5 comms items already stored
(`comms_existing` 5) and the earlier reports already stored (`report_existing`).

**Inject check** (same database, clock paused at 15:40:26Z): a `comms_outage` on all 43 zones until
15:44Z and a `psap_reroute` on all zones from 15:40:26Z, posted by hand, then the runner restarted at
speed 10 for 45 wall seconds (to 15:48Z). The reroute dropped 9 generated 911 items
(`comms_dropped_psap`); 55 resident events were refused with `no_signal` and held, and 33 of them were
delivered after 15:44Z (`...:after_outage`); 30 earlier reports were found already stored.

## Limitations

- Camp bundle only (the twin, residents and comms need it), like the batch runner.
- The runner's twin and the server's twin are separate copies; they agree on guidance and road state
  but not on random draws, and the server's twin does not get `twin.people`.
- Responders re-join with new tokens after a restart; their old tasks are left to the controller.
- Noise windows are drill minutes, so rate-based noise (rumours, bursts) is drawn per minute; the
  truth log is the same for the same seed and clock path.
