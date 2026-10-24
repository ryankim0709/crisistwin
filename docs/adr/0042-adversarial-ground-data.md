# 0042: Adversarial and noisy ground data in simulated drills

Date: 2026-10-24. Status: accepted; implemented on `feat/adversarial-data` (noise layer, truth log,
triage scoring; the source-diversity check is built but off, see "Corroboration finding"). Extends the generators of [0030](0030-scenario-engine.md)
and the task board of [0041](0041-crowdsourced-task-board.md).

## Context

Generated reports so far are honest and timely. Real incidents are not: people misread
roads, repeat each other, upload late from dead zones, and conditions change faster than
reports. A strategy (a human or the orchestrator agent) is only tested if triage is hard.

## Decision

A noise layer, `sim/gen_noise.py`, transforms and adds to the honest streams (residents,
comms, responders, passive observations). It is seeded, every rate is a named ASSUMPTION or
CALIBRATED constant, and it is enabled per scenario as a profile (`clean`, `typical`,
`hostile`).

| Kind | What happens | Calibration hint |
| --- | --- | --- |
| Honest error | Wrong road (a parallel or crossing street), GPS offset, wrong kind (smoke reported as fire) | 2018 record: duplicate and misplaced rows |
| Duplicates | The same person resubmits; many people report one event; a retry storm after the signal returns | Offline outbox behaviour, ADR 0011 |
| Stale or late | Offline reports upload minutes to hours later with their original `observed_at` | Tower outages (injects, ADR 0030) |
| Fast-changing truth | A road flips open → blocked → open; a fire spots across a road; a shelter fills then reopens; a block clears without a report | Fire and twin timelines |
| Rumour | A false claim (e.g. "Skyway closed") spreads, so several independent-looking parties echo it: correlated, not independent, corroboration | Assumed; scenario-tunable |
| Out of area | Reports from people far away relaying media or social posts | Assumed |
| Malicious | A burst from one device; a set of fake devices agreeing (Sybil); help requests at empty locations | Assumed; tests the rate limits and the corroboration rules |

Rules:

- Everything generated keeps `evidence_class: "simulated"` in the live data. Whether an item
  is **true** is recorded only in a separate ground-truth log (`sim_truth`, keyed by report
  id) that the console, the phones and the MCP tools cannot read during the drill.
- The after-action report reads the truth log afterwards and scores triage quality:
  confirmations of false reports, true reports dismissed, time to detect changes, decisions
  (reroutes, dispatches) made on false information, and rumour containment time.
- Profiles are part of the scenario, so batch runs compare strategies under the same noise
  with the same seed.
- Real (non-simulated) drills never get injected noise; it applies only to simulated
  participants.

## Consequences

- Corroboration rules (independent parties, half-lives, responder confirmation) get tested
  against correlated false reports, which today's counting treats as independent. Expect to
  add source-diversity checks (same device family, same time burst, same wording).
- The orchestrator agent can be evaluated on robustness, not just on speed.

## Implementation (2026-10-24)

- `sim/gen_noise.py`: `apply_noise(events, profile, seed, NoiseOptions) -> (events_out, truth)`.
  Stdlib, pure, seeded per honest event (keyed by its id) and per injected family, so runs on one
  seed stay paired across strategies. It reads residents' events, comms items and responder report
  calls; anything else, or any event whose `evidence_class` is not `simulated`, passes through
  unchanged with no truth entry. Injected reports use the residents' party-key format and note, so
  live data does not reveal which reports are noise. `NoiseOptions.changes` is the ground-truth
  timeline (`TruthChange`: a place goes from one true kind to another at a drill time); every report
  near a changing place is judged against it (`true`, `true_until`, `true_from`).
- Truth entry: `{true, kind_of_noise, source_event_id, notes, claim, coord, observed_at, upload_at,
  party_key, ...}` plus `rumour_id`, `attack_id`, `change_id`, `retry_copies`, `late_min` where they
  apply, and one `truth_change:<id>` entry per timeline change.
- `sim_truth` (MongoDB, `{incident_id, event_id}` unique) holds it. `api/live/simtruth.py` writes it
  and injects the generated reports into `live_reports` as `simulated` (same validation, snapping,
  `client_id` idempotency and civilian rate limits as `POST reports`); command
  `python manage.py live_inject_noise`. Comms items (911, radio) get noise and truth but are not
  injected: they are not phone reports and have no live path yet.
- Scoring: `sim/triage_quality.py`, exposed as the AAR's `triage_quality` (docs/live-reports.md,
  "Triage quality") and as the secondary metrics `sim/evaluation.py` `TRIAGE_METRICS`.

### Default rates per profile

Shares are per eligible honest report (exclusive transforms drawn from one uniform; duplicates on
top). Rates are per drill hour of the event window. Only the two CALIBRATED values come from data.

| Kind | Parameter | clean | typical | hostile | Basis |
| --- | --- | --- | --- | --- | --- |
| Honest error: wrong road | `wrong_road_share` (road kinds; onto another named road within 600 m, else 150-400 m off) | 0 | 0.03 | 0.06 | ASSUMPTION |
| Honest error: GPS offset | `gps_offset_share` (residents; sigma 40 m per axis; stays true) | 0 | 0.10 | 0.15 | ASSUMPTION (GPS.gov 4.9 m open sky; degraded fixes tens of m) |
| Honest error: wrong kind | `wrong_kind_share` (smoke and fire, jam and block, both ways) | 0 | 0.05 | 0.10 | ASSUMPTION |
| Duplicates: resubmit | `resubmit_share` (same party, new id, 20-600 s later) | 0 | 0.0326 | 0.0652 | CALIBRATED: 12 of 368 Table A-2 911/radio rows were duplicate quotes merged by the record builder (hostile doubles it) |
| Duplicates: many people, one event | `crowd_echo_share` (other parties within 100 m and 15 min; 1, 2 or 4 extra with weights 18, 6, 2) | 0 | 0.0861 | 0.0861 | CALIBRATED: of the record's 340 911/radio rows with a point, 302 same-category, same-point, 15-min groups, 26 of them repeated (38 extra rows) |
| Duplicates: retry storm | `retry_storm_share` of late uploads, resent 2-5 times with the same `client_id` within 30 s | 0 | 0.5 | 0.8 | ASSUMPTION (ADR 0011 outbox; the server dedupes) |
| Stale or late | `late_upload_share` (lognormal, median 20 min, shape 1, cap 4 h; `observed_at` kept). Comms outages in `NoiseOptions.outages` delay every resident report observed inside them to the end plus up to 60 s | 0 | 0.05 | 0.15 | ASSUMPTION |
| Fast-changing truth | `outdated_per_change` (old-state echoes within 45 min, false) and `change_signals_per_change` (new-state reports, lognormal median 10 min, true; none for a `silent` change) | 0 and 0 | 1 and 2 | 3 and 1 | ASSUMPTION |
| Rumour | `rumours_per_h`, `rumour_parties_mean` (at least 3; exponential spacing, mean 4 min; pins sigma 150 m around the claimed place) | 0 | 0.25, 5 | 1.0, 8 | ASSUMPTION |
| Out of area | `out_of_area_per_h` (30-150 km from the centre, fire_seen or road_blocked) | 0 | 0.5 | 2.0 | ASSUMPTION |
| Malicious: burst | `bursts_per_h`, `burst_size` (one device, 120 s, within 800 m) | 0 | 0 | 0.25, 30 | ASSUMPTION |
| Malicious: Sybil | `sybil_sets_per_h`, `sybil_devices` (spaced 130-300 s and 120-400 m, just outside the same-party rule) | 0 | 0 | 0.25, 6 | ASSUMPTION |
| Malicious: help at empty places | `empty_help_per_h` (help_needed at least 500 m from any occupied point) | 0 | 0 | 1.0 | ASSUMPTION |

Dismissal rates could not be calibrated: the 2018 record holds no triage outcomes.

### Truth-log isolation

`sim_truth` is read in one place, `aar.triage_quality`, reached only through
`build_aar(..., truth_scoring=True)`. The endpoint passes that only with `?truth=1`, when
`LIVE_TRUTH_SCORING=true` (default false, else `403`) and the drill clock is not running (else
`409`). Headless runs call it in Python after the horizon. Truth is never written onto a report.
`api/live/tests/test_sim_truth.py` scans the backend, the MCP server, the web client and the iOS
app for readers and `truth=` queries, and calls the non-twin GET endpoints (controller and
civilian) with a seeded truth log, asserting that no truth field appears.

### Corroboration finding

Measured with `livecore.public.independent_counts` on groups generated by `gen_noise` (hostile
rates with 1 rumour per hour, 40 seeds; a true crowd is the 6-per-change `change_signal` reports
after a road closes). `tests/test_gen_noise.py` `CorroborationTest` asserts the same on 12 seeds.

| Group | Parties (mean) | Counted today (share) | Public by party count today | Counted with the check (600 s, 1 km) | Public with the check |
| --- | --- | --- | --- | --- | --- |
| Rumour (214 groups) | 8.3 | 0.96 | 99% | 0.34 | 57% |
| Sybil set (51) | 6.0 | 1.00 | 100% | 0.33 | 0% |
| True crowd after a change (120) | 5.8 | 0.75 | 93% | 0.39 | 33% |

As expected, today's counting treats correlated rumour and Sybil parties as independent: the
same-party rule (120 s and 100 m) catches almost none of them. The cheap check (parties first seen
in one burst near one coarse place count as one) is built behind `LIVE_SOURCE_DIVERSITY` (default
false; `public.SOURCE_DIVERSITY_ENABLED`, `same_burst`). It stops a Sybil set, but it folds a true
crowd about as much as a rumour, because under these models the two have the same timing and
spread. A sweep finds no window and radius that separates them (share public, rumour vs true
crowd): 300 s and 500 m, 87% vs 69%; 1200 s and 1 km, 20% vs 8%; 1800 s and 2 km, 5% vs 1%. So it
stays off. Both models are ASSUMPTIONS; the conclusion holds for this simulator.

Proposed source-diversity checks that use evidence a rumour lacks, cheapest first:

1. **Device age and history:** weight a party by how long its device has existed and whether it
   reported or checked in earlier in the incident (`live_devices.created_at`, prior reports). Sybil
   sets and relays are new and silent; people in a queue have often reported before.
2. **Location provenance:** have the phone say whether `location` is a GPS fix or a dropped pin,
   and the fix's age. A relay of "Skyway is closed" is a pin; a driver at the block is a fresh fix.
3. **A different channel:** require a responder, a passive observation or another source kind
   (a 911 call, a camera) before a crowd-only block changes guidance. Guidance already holds
   crowd-only blocks for the controller (`crowd_only_segments`), which is why the rumour cost here is
   public-map exposure and controller time, not automatic reroutes.
4. **Same wording:** near-duplicate notes across parties (MinHash over normalized text). Phones
   rarely send notes, so this signal is weak.

Checks 1 and 2 change the report contract and 3 needs new sources; none is built here.
