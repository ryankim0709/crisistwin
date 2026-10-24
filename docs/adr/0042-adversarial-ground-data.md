# 0042: Adversarial and noisy ground data in simulated drills

Date: 2026-10-24. Status: proposed. Extends the generators of [0030](0030-scenario-engine.md)
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
