# Documentation index

| Document | What it is |
| -------- | ---------- |
| [project-scope.md](project-scope.md) | Cal Hacks 13.0 scope: proposed features, priorities, team split, demo. Proposals, not a statement of what is built. |
| [adr/](adr/) | Architecture decision records, one file each (several numbers are duplicated; cite by file name). |
| [historical-replay.md](historical-replay.md) | Proposed format and acquisition plan for historical incident packages. |
| [historical-replay-handoff.md](historical-replay-handoff.md) | Dated work-in-progress notes on historical replay acquisition (2026-10-23). |
| [replay-bundle.md](replay-bundle.md) | Contract for the replay bundle JSON that `python3 -m sim ... bundle` generates and `/replay` loads. |
| [mobility-sidecar.md](mobility-sidecar.md) | Schema of the optional local-only phone-panel mobility sidecar. |
| [fire-simulator.md](fire-simulator.md) | Reference for the `/fire` page, fire model assumptions and API sketch. |
| [workspace-pages.md](workspace-pages.md) | Reference for navigation, planning pages, Simulation Studio and dispatch agent. |
| [historical-data.md](historical-data.md) | Incident packages, MongoDB Atlas sync, Camp Fire collector. |
| [development.md](development.md) | Optional checks, running on the host, runtime images. |
| [plan-api.md](plan-api.md) | Draft API for commanding a branch of the replay. |
| [live-reports.md](live-reports.md) | Contract for the live drill API: field reports, road state, guidance, check-ins (`/api/live/…`). |
| [ground-data-calibration.md](ground-data-calibration.md) | Empirical 911, radio and rescue rates from the 2018 Camp Fire record (`sim/ground_rates.py`) and the seeded comms generator calibrated on them (`sim/gen_comms.py`). |
| [twin-api.md](twin-api.md) | Contract for the real-time traffic twin behind `/live`'s what-if. |
| [command-demo-realism.md](command-demo-realism.md) | What the `/live` command board models (fire, units, travel, households), with evidence labels. |
| [response-model.md](response-model.md) | The shared fire response and resource-management model (`app/src/response/`): run cards, containment tactics, escalation, departments and mutual aid, unit states, sources and measured outcomes. |
| [strategy-evaluation.md](strategy-evaluation.md) | Protocol for comparing response strategies across scenarios and seeds: paired design, metrics, statistics, prompt/tool A/B. |
| [iteration-log.md](iteration-log.md) | Round-by-round log of the live-drill iteration work. |

Other documentation lives next to the code: [../README.md](../README.md), [../app/src/ui/README.md](../app/src/ui/README.md)
(UI standard), [../app/backend/README.md](../app/backend/README.md), [../sim/README.md](../sim/README.md),
[../agent/README.md](../agent/README.md), [../tools/README.md](../tools/README.md), [../mobile/README.md](../mobile/README.md).
