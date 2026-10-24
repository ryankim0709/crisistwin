# `/demo` and `/dispatch` vs the `/live` scenario engine: overlap

Date: 2026-10-24. Compares work merged to `main` in PRs #60 to #66 (the `/demo` command board,
road closures during a dispatcher run, and dispatch run memory) with the `/live` scenario-engine
work: PR #59 is merged; PR #67 is open. It is a reconciliation note, not a decision.

Sources:

- `/demo`: `docs/adr/0047-command-demo.md`, `app/src/demo/`, `app/backend/api/demo.py`.
- Dispatch closures: `docs/adr/0030-live-road-closures.md`.
- Run memory: `docs/adr/0031-dispatch-run-memory.md`, `app/backend/api/dispatch_runs.py`.
- `/live`:
  - `docs/adr/0030-scenario-engine.md`
  - `orchestrator_mcp/`
  - `app/backend/api/live/` (`batch.py` and `aar.py` are in PR #67)
  - `docs/strategy-evaluation.md`, `docs/suppression-data.md`

## 1. AI commander

| | `/demo` (0047-command-demo) | `/live` MCP + batch runner |
| --- | --- | --- |
| Purpose | 24/7 board with a built-in Claude incident commander | Tool surface for any external agent on the real drill, plus scored strategy comparison |
| Agent | Built in: `POST /api/demo/decide` (NDJSON, shares `stream_decision` with `/dispatch`) | External: `orchestrator_mcp` exposes tools. `live_batch` (PR #67) runs rule strategies and an `mcp_agent` adapter |
| Actions | `send_crew`, `release_crew`, `order_evacuation` | `triage_report`, `create_task`, `handle_help`, `replan`, `approve_proposal`, `reject_proposal`, optional `set_drill` |
| Trigger | Browser monitor (`app/src/demo/observation.ts`): new fire, crews losing a fire, freed crews, zone running out of time, periodic review | Batch: fixed decision ticks. Live: the agent polls `get_situation` / `get_events` |
| World | The page's own model (`app/src/demo/model.ts`), routes from the backend router | The live backend: review queue, proposals, guidance, traffic twin, phones |
| Scoring | None (no end state) | AAR drill score, triage quality vs hidden truth (PR #67), paired statistics (`sim/evaluation.py`) |
| Determinism | Same seed and orders replay the run | Same spec and seed give identical metrics and action-log hash |

## 2. Fire and crews

| | `/demo` | `/live` + Studio suppression engine (PR #67) |
| --- | --- | --- |
| Fire | Constant-rate ellipse (L:B 2.5, wind from 45°); scheduled, spot, reported or clicked; at most 25 at once | Camp fire timeline or a Studio package's perimeters (live); Rothermel on LANDFIRE fuel and terrain (Studio) |
| Crews | 6 engine strike teams, 3 synthetic stations, line at 5× the Studio engine rate, straight line × 1.3 at 50 km/h | Sourced rates (`tools/suppression_resources.json`: Type 3 engine 483 m/h, Type 2 crew 191 m/h), CAL FIRE stations and air bases, road access R01–R12 per apparatus class, aircraft with daylight and wind limits |
| Evacuation | Order-only departure over 45 min, no congestion | Traffic twin with queues; planner proposals with controller approval |

The two crew models teach opposite lessons: `/demo` crews routinely contain fires, and the
sourced suppression model finds that no package catches the Studio demo grass fire (ADR
`0048-suppression-engine.md` in PR #67: at most a 1.4% smaller burned area).

## 3. Disruptions

| | `/dispatch` closures (0030-live-road-closures) | `/live` injects (0039-drill-injects) |
| --- | --- | --- |
| Where | Dispatch page, browser engine | Live drill backend (`app/backend/api/live/injects.py`, `livecore/injects.py`) |
| What | A planner closes or reopens a road mid-run; the agent is woken and told about closures and fire-cut roads | `silent_closure`, `psap_reroute`, `comms_outage`, `shelter_full`, `fire_jump` on the drill clock |
| Visibility | The agent sees closures directly | A silent closure stays hidden until a report or responder check finds it |

## 4. Memory vs evaluation

| | `dispatch_runs` (0031-dispatch-run-memory) | `/live` |
| --- | --- | --- |
| Store | Atlas `dispatch_runs`: decisions, closures, outcome per session | `live_decisions` audit log, `GET …/aar`, batch `RunManifest` JSONL |
| Use | Fed back to Claude as `<past_runs>` (3 earlier runs on the same area) | Scoring and comparison only; never fed to an agent |

An agent that reads `<past_runs>` is not a fixed strategy, so memory must be off, or recorded in
the strategy version, for fair comparisons (`docs/strategy-evaluation.md`, pitfalls).

## 5. Smaller overlaps

- Routing: `POST /api/demo/routes` runs `livecore.routing` over the drill roads, avoiding fire,
  without traffic. This is a third route path, next to the planner (twin congestion,
  `0031-congestion-aware-planner.md`) and inbound responder routes (`livecore/inbound.py`).
- Shared map code: `app/src/live/mapStyle.ts` (`loadStyle`, `fireHatch`) is now used by `/live`
  and `/demo`.
- `/demo` writes to the live drill: closing a fire resolves its `fire_seen` reports through the
  live triage API.
- ADR numbers clash: `0030`, `0031` and `0047` each name two different decisions. Per AGENTS.md
  ADRs are read-only and cited by full file name, so this note does not renumber anything.

## Possible convergence (for discussion)

1. Run the `/demo` commander as a batch-runner strategy: its observation-to-orders shape matches
   the `Strategy.decide` interface, so it can be scored on the same seeds as `rule_auto`.
2. One crew model, or an explicit label: `/demo` as arcade speed, or `/demo` reading
   `tools/suppression_resources.json`.
3. One disruption vocabulary shared by `/dispatch` closures and `/live` injects.
4. Agent memory (`<past_runs>`) off in evaluated runs, or part of the strategy version.
