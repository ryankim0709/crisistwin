# 0025: The dispatcher chooses how to fight each fire

Date: 2026-10-24. Status: accepted for the demo. Amends
[0022-dispatch-fire-attack](0022-dispatch-fire-attack.md); reuses the control lines of
[0020-studio-firefighting](0020-studio-firefighting.md).

## Context

ADR 0022 let engines attack a fire only when its ignition-point head flame was within the
8 ft engine limit and it was not crowning; otherwise the fire was "not attackable" and the
dispatcher could only send engines to evacuation support. A fire starting among houses always
failed that test, because the model gives a burning structure a fixed 10.4 ft flame. Both are
wrong for planning: the Hauling chart (NWCG) limits are for attacking the HEAD of a wildland
fire, and above them crews change tactics (flank, indirect, structure protection) rather than
leave; and engines fight building fires directly.

## Decision

- **Tactics** (`app/src/dispatch/fireTactics.ts`). `attack_fire(unit_id, fire_id, tactic)`:
  - `direct`: the containment race of ADR 0022, putting the fire out. Allowed where engines can
    hold the head (within the limit and not crowning) and now always for a structure fire
    (`FireTarget.structureFire`, origin on developed ground).
  - `flank`: anchor at the heel and build line up both flanks toward the head.
  - `indirect`: line around where the unchecked fire will be, starting across the head.
  - Flank and indirect are open to every fire another fire did not reach first. They use the
    Studio's line planner on the fire's own unchecked footprint (new
    `ScheduledFireRun.sourceIndexByCell`), with the outline LINE_LEAD_MINUTES after the first
    engine arrives (20 min flank, 60 min indirect, assumed), engines leapfrogging at their own
    arrival minutes. The fire model decides stretch by stretch whether the line holds.
  - One tactic per fire: a new order with another tactic switches every crew on it.
- **Session** (`tacticOptions.ts`). When crews join or leave a line, the session re-plans every
  line for the crews on it (keeping line already built), re-solves the fire with lines and
  put-out minutes, and swaps the new fire into the engine and the 3D view (lines drawn with the
  Studio's line overlay). A fire whose run shows it stopped growing at least 15 minutes before
  the horizon is "held" at that minute: an alert wakes the agent and its crews go home.
- **What-ifs for the agent.** Before each decision the session solves, per burning fire
  (largest first, at most 12 solves): each usable tactic with the nearest 2 and 4 engines not on
  it. The observation lists them (`tactic_options`: contained_in_min, burned_ha_at_horizon,
  homes_reached_by_horizon, line_km, line_held_km) next to `fire.current_outcome`, plus each
  fire's `tactics_blocked` reasons, tactic and held state. The prompt explains the doctrine,
  asks for the option that keeps the most homes out of the fire, then least area, then
  earliest containment, and keeps crew safety (LCES) and evacuation rules. The server
  validates the tactic against `tactics_blocked`.
- **Solver fix.** A control-line cell now blocks fire that would arrive after it is built,
  rather than fire whose neighbouring cell caught after it was built. With 30 m cells and slow
  flank or backing spread, the old rule let fire through line finished well before the fire
  got there. This changes ADR 0020's Studio results: on the demo board with 4 hand crews,
  4 engines and a dozer at T+30, the best line plan now holds the fires to 7 ha at 20 mph and
  dry fuel (was 37 ha) and to 4 ha at 12 mph (was 206 ha); critical moisture is still mostly
  out of reach (2,053 of 2,131 ha).

## Consequences

- A single house fire in the Berkeley flats at 2 mph (the case that prompted this): direct
  attack with the two nearest engines puts it out in 8 minutes with no homes reached, against
  25 homes and 8 ha with no fire fighting; flank and indirect options are listed and are worse
  there, because burning houses next to the line exceed what engines hold.
- Each decision now costs up to 12 extra fire solves on the main thread (about 0.3 s for one
  small fire, about 1 s for the three demo fires) while the session waits for the agent anyway.
- Rough: line plans use the engines' ETA when ordered (a later re-route does not re-plan);
  structure protection still has no modelled effect; crews never die or retreat on their own
  beyond the existing withdrawals; the structure flame stays a fixed 10.4 ft.
