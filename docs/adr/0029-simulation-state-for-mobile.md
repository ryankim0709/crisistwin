# 0029: Simulation state in Atlas for the phone app

Date: 2026-10-24. Status: accepted. Contract: [sim-state-api.md](../sim-state-api.md).

## Context

Simulation Studio runs an evacuation in the browser, minute by minute, against the modelled
fire (`app/src/studio/evacuation.ts`). The phone app should tell a resident, from the latest
simulation, whether their home leaves now, leaves later, or does not need to leave. The run's
homes are synthetic points along residential streets (`api/dispatch_area.py`), with zones and
a departure order. They have no addresses.

The live broadcast (`api/live_broadcast.py`,
[ADR 0016](0016-resident-live-and-family.md)) already shares the fire and per-zone guidance
from `/fire` and `/dispatch`, in one overwritten document. It has no homes and no addresses,
and it cannot say when a zone that has not been ordered yet will be. It does not cover
Studio either.

## Decision

- **Studio is the producer.** When the planner turns on "Publish to mobile", Studio posts the
  run once: zones, homes with a synthetic address (nearest OSM street name plus a made-up
  house number) and each home's rank in its zone's departure order. As playback moves, Studio
  posts the zone state at the playback minute (at most about one tick per second). Each tick
  carries the advice, the run's order minute for the zone and the number of households
  departed. Only zones that changed are sent. The deterministic policy run stays the single
  source of every number. The server only derives each home's state from its rank.
- **Atlas holds the state.** `sim_runs` has one document per run: metadata, zones, and a
  `state` that each tick overwrites. `sim_homes` has one document per home, with its current
  advice, a 2dsphere location and its address. Each tick updates homes only in zones that
  changed: two `update_many` calls split by rank, so a tick costs tens of writes, not
  thousands. The server keeps the 3 newest runs, and the latest published run is the one the
  app reads.
- **"Later" comes from the run's own schedule.** `leave_later` with an order minute comes from
  the full policy run to the horizon. It is the simulation's plan, which uses its own future
  fire as a perfect forecast. It is not a forecast of a real fire.
- **Public, synthetic, labelled.** The endpoints carry no auth, like `dispatch/area`, because
  the data holds no residents: it is synthetic homes only. Throttles and size limits bound
  abuse. Every response carries `evidence_class: "simulated"` and a notice, and the app always
  shows that notice. Nothing is pushed to phones: the app polls only while the card is on
  screen. This keeps to the AGENTS.md rule on resident alerts.

## Consequences

- Anyone who can reach the API can publish a run or a tick. That is acceptable for synthetic
  demo data. Before real addresses or any operational use, this needs controller auth (as in
  `api/live/auth.py`) and a new ADR.
- The phone shows only the latest tick received. Scrubbing playback backward moves the phone
  backward too.
- The matched home is the nearest synthetic point within 300 m of the resident's saved home,
  not their real house.
