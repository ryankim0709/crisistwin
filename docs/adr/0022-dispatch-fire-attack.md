# 0022: Dispatched engines can attack a fire

Date: 2026-10-24. Status: accepted for the demo. Amends [0019](0019-live-dispatch-monitor.md) and
[0021](0021-fire-path-scoped-evacuation.md); builds on the direct-attack estimate of
[0020](0020-studio-firefighting.md).

> **Update (2026-10-24):** amended by [0025](0025-dispatch-fire-tactics.md): "not attackable"
> now blocks only direct attack; engines can flank or attack indirectly, and structure fires can
> be attacked directly.

## Context

The dispatcher could only send engines to zones for evacuation support or structure defense, and
neither changed the fire. So for a single house fire it sent engines to help people leave instead
of putting the fire out. The agent needs a real choice: attack a fire that engines can put out
early, or support the evacuation when they cannot.

## Decision

- **New order `attack_fire(unit_id, fire_id)`.** The engine drives (avoiding fire and closed roads)
  to the reachable road node nearest the fire's ignition point and builds line once there.
- **Containment race (`fireAttack.ts`, pure).** The same rough model as the Studio's initial
  attack, per fire and with each engine starting when it arrives: line at the engine rate
  (600 m/h in grass, slower in heavier fuel via `productionFactor`) against the edge of the
  fire's modelled area as an ellipse with its ignition-point length-to-breadth ratio. A fire
  whose ignition-point head flame is longer than an engine holds (8 ft) or that crowns there
  cannot be attacked. The engine steps the race minute by minute; the fire is out when the line
  covers the edge.
- **The fire changes.** When a fire goes out, the session re-solves the run with
  `simulateScheduledFireSpread(..., outFromMinuteBySource)` (ADR 0020) and swaps the new exposure
  into the engine (`setExposure`). Arrivals up to the put-out minute are unchanged, so only the
  future changes: zone ETAs, impact and order slack drop the fire, staged zones no longer reached
  stand down with an "all clear" notice, and the attacking engines return to station. The 3D view
  shows the dispatcher's fire through a new `setRunOverride` on the studio aside. On `/dispatch`
  that is always the run without the Studio's own firefighters, so the two models never stack.
- **Observation.** A `fires` block per run source: status, area, head flame, crowning,
  attackability (with the reason), engines attacking, line built and needed, `out_eta_min` with
  the current engines, and `attack_options`: the simulator's out estimate if the nearest 1–4
  engines not already on it were sent now. Units gain `fire_id`. The monitor wakes the agent on
  `fire_out`.
- **Prompt: engines are scarce.** Attack when a fire is attackable and an option puts it out
  early, ideally before it reaches homes; commit enough engines in one decision; still evacuate
  zones whose slack runs out before the out estimate; otherwise use engines on evacuation
  support. Re-weigh on every wake-up and pull engines off a failing attack.
- **Validated twice.** The server rejects `attack_fire` on an unknown, non-burning or
  non-attackable fire; the engine re-checks against its live state.

## Consequences

- A small attackable fire can now end early, which shrinks the evacuation the agent orders.
- The re-solve runs synchronously on the main thread when a fire goes out (one solve, a fraction
  of a second on the demo board), so playback stalls briefly.
- The estimate is rough (ADR 0020's caveats apply): ellipse perimeter, engines work the whole
  edge as one, no water supply, mop-up, rekindle or crew safety; engines stage at the nearest
  road node even when it is far from the fire's actual edge.
- A fire that is out stays out. If its area is later reached by another fire, that fire spreads
  there as usual.
