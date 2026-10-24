# 0031: Congestion-aware evacuation planner with hysteresis, and a record comparison harness

Date: 2026-10-24. Status: accepted (implemented, planner-v4). Amends
[ADR 0012](0012-controller-guidance.md) and [ADR 0013](0013-realtime-twin.md).

## Context

The live-drill planner (`livecore.planner.plan`, `livecore.routing.best_routes`) picked every
zone's route on free-flow travel time. Zones near one exit all got that exit, even when the
traffic twin showed its approach jammed. Responder routes (`livecore.inbound`) already slow each
directed edge by a twin congestion factor. We also had no way to measure what acting on the 2018
ground record would change in the twin.

## Decision

1. **Congestion in the search cost.** At each replan the server reads the synced twin once
   (`twin_service.edge_speeds_at`) and builds the responder routes' factors
   (`livecore.inbound.congestion_factors`): `clamp(free_flow_kph / speed_kph, 1, 10)` on directed
   edges with at least 3 simulated vehicles. Edge search cost = free-flow seconds x fire weight
   (1, 5 or 20 by pass) x factor, in every pass, for the recommended route, the destination
   choice, the TwinController's candidate destinations and the alternatives. `eta_min` stays
   free-flow. The proposal records `inputs.congestion` (`"twin@<twin clock>"`, or `"unavailable"`
   when the twin is not ready, in which case the plan is free-flow) with `evidence_class`
   `simulated`. Congestion never triggers a replan on its own.
2. **Hysteresis.** The published route is the zone's incumbent (`routing.Incumbent`). Its edges
   come from `live_plan_routes` (edges of every proposed route keyed by zone, destination and
   via), else the cheapest route to the same destination now. Within a pass the incumbent is kept
   unless the new route is cheaper by `max(SWITCH_MIN_GAIN_S, SWITCH_MIN_GAIN_FRACTION x
   incumbent cost)` = max(120 s, 15 %), and always for `SWITCH_MIN_DWELL_S` = 900 drill seconds
   after the zone's guidance was published. An incumbent over a blocked segment, into a fire
   class the pass forbids, or to an unusable destination is never kept. All three are planning
   heuristics, not calibrated. The dwell rule was added after the first harness run showed the
   margin alone let zones swap exits every 5 to 10 minutes.
3. **Harness.** `python manage.py live_compare_record` (module `api.live.record_compare`) runs
   the live twin inputs and the planner headless on one simulation clock. It runs a baseline
   (`A`, historical actions only), a controller who confirms each 2018 `road_blocked` or
   `fire_seen` record entry N minutes after its time and approves every change (`B`), and the
   same controller with the previous free-flow planner (`B_free`). It writes JSON and Markdown,
   labeled as a simulated planning experiment. It reuses `sim.twin.Twin` and the
   `twin_service` command mapping; it adds no simulator.

## Measured (N = 5, seed 7, 14:30Z to 18:00Z, simulated)

| | A | B (planner-v4) | B_free (free-flow) |
| --- | ---: | ---: | ---: |
| Arrived by 17:30Z / 18:00Z | 4,876 / 9,325 | 6,170 / 9,620 | 6,155 / 9,936 |
| Exposed veh-min (sampled) | 814,390 | 705,248 | 710,244 |
| Trapped by fire, end / max | 15 / 335 | 190 / 2,624 | 155 / 2,658 |
| Destination changes (returns to an earlier exit) | 0 | 144 (52) | 42 (5) |

Hysteresis sensitivity (B only, same run; destination changes / arrived by 18:00Z):

| Setting | Changes | Arrived by 18:00Z |
| --- | ---: | ---: |
| margin only (120 s, 15 %) | 202 | 10,200 |
| 120 s, 15 %, 900 s dwell (shipped) | 144 | 9,620 |
| 120 s, 15 %, 1800 s dwell | 120 | 9,788 |
| 300 s, 30 %, 900 s dwell | 94 | 10,382 |

A controller acting on the record gets about 1,300 more vehicles out by 17:30Z than the
baseline and lowers sampled exposure by about 13 %. Max trapped-by-fire is higher in both B
variants, so ordering and routing zones early does not reduce every harm in this model. On this
seed, the congestion-aware planner does not separate measurably from the free-flow planner on
arrivals, exposure or trapped vehicles; the changes between settings are within single-seed
noise and do not move in one direction. It changes zone destinations about 3.4 times as often,
and about a third of those changes return a zone to an exit it left. The twin's instantaneous
queues are largely the zone's own committed traffic, so they are a noisy signal for where the
next departures should go. We trust the counts of changes, which are deterministic outputs of
the planner. We do not trust single-seed differences of a few percent in the outcome metrics.

## Consequences

- Proposals record the simulated congestion they used, and tests pin the cost rule, the
  hysteresis, the warming fallback and the safety precedence
  (`api/live/tests/test_planner_congestion.py`, `test_replan_congestion.py`).
- Route churn under congestion is real and is reported, not hidden. Before people follow
  congestion-driven reroutes, a stronger rule is needed: a longer dwell, a larger margin, or
  smoothing congestion over several reads. Choose it from multi-seed harness runs, not from this
  one seed.
- `live_plan_routes` is drill data: it is dropped by `live_init_db --drop-drill-data` and
  cleared on drill reset.
