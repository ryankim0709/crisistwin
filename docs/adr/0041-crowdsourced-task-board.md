# 0041: Crowdsourced task board, passive auto-completion, and information priority

Date: 2026-10-24. Status: accepted (implemented; see Implementation notes). Builds on [0011](0011-live-field-reports.md),
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

## Implementation notes

Contract and constants: [live-reports.md "Task board, passive observations and information
priority"](../live-reports.md#task-board-passive-observations-and-information-priority-adr-0041).

- **Priority** (`app/backend/livecore/priority.py`, pure): `impact = 1 - exp(-v / 5000)` over
  vehicle-equivalents `v`; `p_change` combines the kind's half-life over a 30 min horizon with
  `exp(-d_fire / 2000 m)`; `staleness = 1 - 0.5 ** (age / half_life)` since the newest non-dismissed
  report there (passive included), 1 when never observed.
- **Road impact uses the cheap approximation**, not the impact analysis's two planner runs per
  segment: segments of each published route come from the planner's remembered edge ids
  (`live_plan_routes`), and a zone counts double when none of its published alternatives avoids the
  segment. Running `plan` twice per candidate would cost minutes per refresh.
- **Destinations** use the twin's simulated arrivals when a cached read is fresh, else the vehicles
  of the `evacuate_now` zones the published plan sends there; only destinations with a known
  capacity (Camp: exits, by their entering edges' hourly capacity) are candidates.
- **Gateways** use only the simulated fire model's fronts within the next 30 drill minutes (never
  future observed perimeters), with a spread-acceleration factor. They are console suggestions and
  never board questions; the controller dispatches a responder if it wants one.
- **Board** (`app/backend/api/live/board.py`): refreshed at most once a minute on a `command` or
  `board` read; segment and destination places become `created_by: "priority"` verify tasks,
  deduplicated per place, spaced 1500 m, at most 3 new per refresh and 8 open, 10 min cooldown,
  expiring after 30 min, never within 1000 m of the fire estimate (re-checked on every board read).
  `GET board` returns only task id, rank, question, place and expiry: no reports, people, help
  requests or assignments. Board tasks are not in responders' task lists.
- **Passive reports**: `method: "passive"` with `segment_id`, `speed_class` and time only; a
  `location`, heading, note or destination is rejected, and the server places the report at the
  segment midpoint. Only `road_passable` and `heavy_traffic`. A party seen only through passive
  reports counts 0.5 toward publicity (`PASSIVE_PARTY_WEIGHT`); passive-only reports never reopen a
  block, and a responder's passive report is not a responder report.
- **Phone** (`mobile/CrisisTwin/Features/Live/Board.swift`): selection on the device (own route or
  within 1500 m, not within 1000 m of the fire estimate, at most 3); passive traversal only with
  "Share road observations" on (default off), keeping no list of positions; a stall over 120 s asks
  one explicit question. The situation has no per-segment near-fire flag, so the phone uses the
  geometric fire exclusion only.
- **Simulated residents** (`sim/gen_residents.py`) answer board questions on the road they drive
  (`BOARD_ANSWER_SHARE` 0.3) or send passive observations (`PASSIVE_SETTING_SHARE` 0.2), both
  ASSUMPTIONs, when given the board.
- Not done: the AAR "minutes critical places were stale" metric; simulated responders do not yet
  read the board.
