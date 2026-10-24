# 0041: Crowdsourced task board, passive auto-completion, and information priority

Date: 2026-10-24. Status: proposed. Builds on [0011](0011-live-field-reports.md),
[0012](0012-controller-guidance.md) and [0030](0030-scenario-engine.md).

## Context

Responders get dispatched check tasks; evacuees only answer "Still there?" prompts about
public items near them. Every phone moving through the area is a sensor, but nothing tells
the system which facts matter most right now, and phones that drive through a road without
reporting add nothing.

## Decision

### 1. One task board, filtered by role and position

- A task is a **question about a place**: a road segment, a junction, a destination, or a
  point (`kind: verify`; `assist` stays responder-only).
- **Responders** see dispatched tasks they accept and drive to (unchanged).
- **Evacuees** see only **passive questions** about places on their own published route or
  within `PASSIVE_RADIUS_M` of where they already are, and never anything inside or toward the
  fire estimate (route segments that the planner marks `near_fire` are excluded). Questions
  expire after `PASSIVE_TTL_S`. They are observations, never instructions: an evacuee is never
  asked to go anywhere.
- The phone picks the questions on the device from the public board, so a civilian's location
  still never leaves the phone (ADR 0011). Answers are ordinary reports carrying `task_id`.
- Help requests and their locations stay controller and responder only; they are never tasks
  on the public board.
- Answers from independent parties corroborate as reports already do. The console shows each
  task's answers and freshness ("3 open, 1 blocked, 4 min ago").

### 2. Passive auto-completion while navigating

- While a phone navigates a published route, it notices **on the device** when it traverses a
  segment or passes a place that has an open question: entering and leaving the segment's
  buffer in order, at driving speed.
- If the person has turned on **"Share road observations"** (off by default, per device), the
  phone sends one minimal observation: `road_passable` for that segment, plus
  `heavy_traffic` when its speed over the segment was below `SLOW_RATIO` × free-flow. The body
  carries the segment, time and coarse speed class, but no track, no other positions and no
  identity beyond the device's pseudonymous party key.
- An observation completes or updates the matching task like any answer, labelled
  `evidence_class: "field_report"`, `method: "passive"` so the console can weigh it apart from
  an explicit answer.
- If a person is stopped inside the buffer for longer than `STALL_S`, the phone asks a single
  explicit question ("Road ahead blocked?") instead of inferring a block.

### 3. Information priority: what should be fresh

Each candidate place gets a model-computed **information priority**:

`priority = impact_if_changed × p_change × staleness`

- **impact_if_changed** (from the models, never an LLM):
  - **road chokepoints**: vehicles on published routes that cross the segment, and how many
    zones would lose or lengthen their route if it closed (the planner already computes this
    for impact analysis, `POST incidents/{id}/impact`);
  - **fire-growth gateways**: places where fire arriving would accelerate spread or reach many
    homes. These come from the fire model's arrival field: cells where the spread rate rises
    sharply, or wildland-urban entry points where the next 30 minutes of modelled growth crosses
    into home density. Packages without a fuel grid use the drill's fire timeline;
  - **destinations** near capacity (twin arrivals vs `capacity_veh`).
- **p_change**: by kind, from the report half-lives (`livecore.public.HALF_LIFE_S`) and distance
  to the fire front.
- **staleness**: time since the last independent observation, relative to the half-life.

Priority drives the board: the top N places become open tasks automatically (deduplicated,
rate-limited). Responder tasks are suggested to the controller rather than auto-dispatched.
Passive questions are ranked so each phone sees at most `MAX_PASSIVE_QUESTIONS`. The console
shows a "stale and critical" list. Simulated residents and responders (ADR 0030) answer the
same board, so batch runs exercise it.

## Consequences

- Freshness becomes measurable: an AAR metric "minutes critical places were stale" scores how
  well a strategy kept its picture current.
- Passive observations can be wrong (a GPS jump, or a person who took a side road), so they
  count as weaker evidence than an explicit answer and never confirm a block on their own.
- New constants (`PASSIVE_RADIUS_M`, `PASSIVE_TTL_S`, `SLOW_RATIO`, `STALL_S`,
  `MAX_PASSIVE_QUESTIONS`, the priority weights) are assumptions to calibrate in drills.
