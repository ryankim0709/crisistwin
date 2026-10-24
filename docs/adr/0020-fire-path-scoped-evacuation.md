# 0020: Evacuate only the fire path

Date: 2026-10-24. Status: accepted for the demo. Amends [0019](0019-live-dispatch-monitor.md).

## Context

The dispatch area is the fire's footprint plus a 2.5 km buffer, at least 6 km across, so a small
fire still brings in many zones the fire never reaches. The agent tended to order or stage those
too, which puts unthreatened households on the roads the threatened ones need.

## Decision

- **Zone impact (engine, pure).** `DispatchEngine.zoneImpact` classifies every zone from the fire
  model's first contact (`exposure.zoneContact`): `burning` (fire is there), `threatened` (within
  the 60-minute forecast lookahead), `later` (after that, by the horizon) or `outside` (not
  reached by the horizon). It is a simulator value, never the agent's.
- **Observation.** Each zone carries `impact`; `fire.fire_path` counts zones and households in and
  outside the fire path. A model note explains the tiers.
- **Prompt.** The agent evacuates only burning and threatened zones, by order slack. `later` zones
  wait until their slack gets small (the monitor already wakes the agent then, or when fire enters
  the lookahead) or are staged behind a threatened zone. `outside` zones are never ordered or
  staged.
- **Enforced twice.** The server rejects `order_evacuation` and `stage_evacuation` for an
  unordered `outside` zone, and the engine rejects them when `restrictToFirePath` is set (the
  dispatch session sets it). A zone that already has an order can still be redirected. The
  Studio's evacuate-everyone policy (ADR 0018) leaves the flag off.
- **Console.** Unordered outside zones are listed separately as "Outside the fire path".

## Consequences

- With a fixed, precomputed fire run, an outside zone stays outside for the whole session; if the
  fire spreads toward a zone, its `impact` moves to `later`/`threatened` and the monitor wakes the
  agent through the existing slack and forecast checks.
- There is no precautionary buffer: a zone the forecast misses by 100 m is outside. If that proves
  too tight, add a distance band from the forecast perimeter rather than letting the model decide.
