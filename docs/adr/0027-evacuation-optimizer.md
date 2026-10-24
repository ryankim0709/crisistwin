# 0027: Evacuation strategy optimizer in the Studio

Date: 2026-10-24. Status: accepted for the demo. Builds on
[0018-road-closures](0018-road-closures.md) and
[0024-studio-crews-assist-evacuation](0024-studio-crews-assist-evacuation.md).

## Context

The scope's P0 success criterion ([project scope](../project-scope.md) §24) is: "Closing a
road causes the traffic model to change, and the optimizer finds and evaluates an alternative
strategy." The Studio's evacuation (`app/src/studio/evacuation.ts`) runs one fixed policy: every
zone is ordered at the order minute to its fastest open exit. ADR 0018 left "optimisation over
order timing or exit choice" undone. Under that policy a closure that pushes several zones onto
one road makes them split its capacity, and nothing tries to spread them out or let the zone
the fire reaches first go first.

## Decision

- **Plans in the policy.** `EvacuationInputs.plan` (`EvacuationPlan`: `exits` zone → exit,
  `after` zone → zone) changes only the first order. A listed zone is ordered to its planned
  exit when that exit is reachable at the order minute avoiding closures and the fire's routing
  lookahead, else to its fastest open exit. A zone with `after` is staged behind that zone with
  the engine's `stage_evacuation` (released when the predecessor's households are all out of
  home and the loading queue, or when its own order slack runs out). Zones are ordered in index
  order first, then waves are staged once their predecessor is ordered or staged; a wave whose
  predecessor is cut off or overrun, that is part of a loop, or that the engine rejects, is
  ordered directly. Re-routing after fire cuts a route is unchanged (fastest reachable exit).
  Without a plan, or with an empty one, the run is identical to the default policy.
- **Fair accounting for waves.** Household-hours evacuating now also count households staged
  for a later wave (told to get ready, still at home), so delaying a zone is never a free gain.
  A planned wave that never got its order by the horizon means no all-clear;
  `EvacuationSummary.stagedHomes` reports its households.
- **Objective** (`compareSummaries`), lexicographic: fewer households caught, then more that
  reached an exit, then fewer household-hours evacuating (differences under 1e-6 h are ties),
  then an earlier all-clear (none by the horizon is worst). A change is adopted only when it is
  strictly better.
- **Search** (`app/src/studio/evacuationOptimizer.ts`), every candidate a full engine run:
  1. Baseline: the default policy under the same closures, fire, crews and order minute.
  2. Exit rebalancing by greedy coordinate descent. A zone is a candidate when its route at the
     order minute crosses an over-subscribed edge (the zones routed over it would push more
     vehicles per minute than it carries, so the engine splits it) or an edge the fire reaches
     by the horizon, and it has another reachable exit. Earliest fire contact first. Each
     candidate tries its other exits among the three fastest reachable (the engine's
     `EXIT_OPTIONS_PER_ZONE`); the best is kept if it beats the current plan. Up to two passes.
  3. Waves: from the best plan so far, zones in order of latest fire contact (zones the fire
     never reaches first) are each tried staged behind the earliest-contact zone that the fire
     reaches sooner and that shares an over-subscribed edge with it.
- **Budget.** At most `maxEvaluations` engine runs (default 80, baseline included); when wave
  moves exist, the exit phase stops at two thirds of the budget after the baseline. Identical
  plans are never run twice. Progress is reported after every run. A full 3 h run on a
  Berkeley-sized board takes well under 0.1 s, so the default budget is a few seconds in a Web
  Worker; on a synthetic 1,600-node, 54-zone, 19,818-home test board, 80 runs took 2.8 s in
  Node (about 36 ms per run).
- **Re-optimising.** The closures are an input, so the Studio re-runs the search whenever they
  change. The result keeps a few labelled strategies for display (fastest exit, rebalanced
  exits, rebalanced exits + waves when adopted, and the best change tried but rejected) and
  lists the zones whose exit or wave differs from the fastest-exit policy.
- Deterministic: no randomness, no clock, no network; ties break on zone index.

## Consequences

- The Studio can show, under the planner's closures, a strategy the optimizer found and the
  engine's numbers for it against the fastest-exit policy. Every number comes from the dispatch
  engine; the search only proposes plans. Results are planning experiments on synthetic homes
  and zones, not operational instructions, and counts are not casualty estimates.
- Gains come only from what the engine models: shared capacity on edges used by several
  zones' routes, each route's bottleneck, and fire exposure of homes, zone cores and roads.
  There are no downstream queues and drivers travel at free flow after release, so moving a
  zone to a longer road costs only its extra free-flow drive time, and a wave helps only by
  giving the earlier zone the whole shared edge.
- Greedy, local and budget-bound: the result is the best plan found, not a proven optimum.
  Candidate selection uses a static flow estimate (departure spread against route capacity),
  so a zone whose traffic only interacts with others later in the run may not be tried.
- Not optimised: the order minute, which zones are evacuated (the Studio evacuates everyone;
  ADR 0021's fire-path restriction stays off), crew assignments, more than one predecessor per
  zone, and re-routing after the fire cuts a route.
