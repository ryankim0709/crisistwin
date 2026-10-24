# Controller MCP server

`crisistwin_mcp` is a stdio [MCP](https://modelcontextprotocol.io) server that lets an external
orchestrator agent act as the **controller of a CrisisTwin live drill**: read the situation,
follow changes, triage reports, task responders, handle help requests and approve or reject the
planner's guidance proposals. It wraps the live controller API of a running backend
([contract](../docs/live-reports.md)) and adds no drill logic of its own. Design:
[ADR 0033](../docs/adr/0033-controller-mcp-server.md); context: [ADR 0030](../docs/adr/0030-scenario-engine.md).

The drill is a labelled exercise replaying the 2018 Camp Fire. Nothing an agent does here reaches
real residents; approved guidance goes to drill phones only (ADR 0012). Outputs are planning
experiments.

## Install

Python 3.12. From this directory:

```sh
uv venv --python 3.12 .venv
uv pip sync --python .venv/bin/python requirements.txt
```

(or `python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt`). The only direct
dependency is the official MCP Python SDK (`mcp`, see `requirements.in`).

You need a running backend (`http://localhost:8000` in dev; see the root README quick start). Set
`LIVE_CONTROLLER_TOKEN` on the backend and give the server the same value.

## Configuration

Read from the server's environment only (placeholders in `.env.example`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `CRISISTWIN_API_BASE` | `http://localhost:8000` | Backend base URL |
| `CRISISTWIN_CONTROLLER_TOKEN` | unset | The backend's `LIVE_CONTROLLER_TOKEN`; sent as `Authorization: Bearer`, never logged or returned. Unset works only against a backend without a controller token |
| `ORCH_AGENT_NAME` | `orchestrator` | Writes send `X-CrisisTwin-Actor: agent:<name>`; the backend logs it as the decision `actor`. `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` |
| `ORCH_ALLOW_CLOCK` | unset | `1` exposes `set_drill`. Off by default: the drill clock is shared by the console and every phone |
| `ORCH_INCIDENT_ID` | unset: the backend's active incident (`GET /api/live/active`, re-read every 10 s; `camp-2018-drill` if unreadable) | Pins the `incident_id` of every tool |
| `ORCH_HTTP_TIMEOUT_S` | `120` | Per request; replans and what-ifs can take tens of seconds |

### Claude Code

```sh
claude mcp add crisistwin-controller \
  -e PYTHONPATH=/ABSOLUTE/PATH/TO/crisistwin/orchestrator_mcp \
  -e CRISISTWIN_API_BASE=http://localhost:8000 \
  -e CRISISTWIN_CONTROLLER_TOKEN=<token> \
  -e ORCH_AGENT_NAME=my-orchestrator \
  -- /ABSOLUTE/PATH/TO/crisistwin/orchestrator_mcp/.venv/bin/python -m crisistwin_mcp
```

`claude mcp list` should then show it connected (with the backend running).

### Claude Desktop (`claude_desktop_config.json`) or a project `.mcp.json`

```json
{
  "mcpServers": {
    "crisistwin-controller": {
      "command": "/ABSOLUTE/PATH/TO/crisistwin/orchestrator_mcp/.venv/bin/python",
      "args": ["-m", "crisistwin_mcp"],
      "env": {
        "PYTHONPATH": "/ABSOLUTE/PATH/TO/crisistwin/orchestrator_mcp",
        "CRISISTWIN_API_BASE": "http://localhost:8000",
        "CRISISTWIN_CONTROLLER_TOKEN": "<token>",
        "ORCH_AGENT_NAME": "my-orchestrator"
      }
    }
  }
}
```

Keep the real token out of committed files: `.mcp.json` in a shared repo should reference a
placeholder that each person fills in locally.

## Tools

Every tool takes an optional `incident_id` (default: the active incident). Output is compact JSON:
no geometry or polylines unless asked, null and empty fields omitted (absent means none), numbers
copied verbatim from the backend's models.

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_situation(max_queue=20)` | read | Digest of command + twin: clock, fire estimate (no geometry), every zone with guidance, check-in and simulated twin counts, review queue with flags, help requests, responders, open tasks, pending proposals with changes, road state, twin totals, `events_cursor` |
| `get_events(since?, limit=50)` | read | Changes since a cursor ([event stream](../docs/live-reports.md#event-stream)); keeps the cursor itself and skips events it already returned. `since`: cursor, `now` or `start` |
| `get_zone(zone_id, include_geometry=false)` | read | One zone in full: guidance, reason, route summary, alternatives, pending changes, check-ins, help, destination choices, twin counts |
| `get_report(report_id)` | read | One report with its road state, public flag, tasks, decisions and other reports on the segment |
| `get_task_route(task_id, from_coord?, include_line=false)` | read | Responder drive route to a task: via, distance, ETA, exposure, congestion; or `unreachable` / `no_origin` |
| `run_impact(segment_id or report_id, horizon_min=60)` | read (analysis) | Blocked vs open for one road: per-zone reroute and ETA delta (planner, computed), vehicles at risk and metrics delta (twin, simulated) |
| `twin_whatif(action_sets, horizon_min=60, fire_ahead="frozen", labels?)` | read (experiment) | Candidate action sets vs a baseline on forks of the traffic twin; metrics, objective, ranking (simulated) |
| `get_aar()` | read | After-action report and drill score, when the backend has `GET incidents/{id}/aar` (`feat/drill-aar`); else `aar_unavailable` |
| `triage_report(report_id, action, note?, into?)` | write | confirm / dismiss / merge / resolve; confirming a block or fire replans at once |
| `create_task(kind, target, report_ids?, assignee?, note?)` | write | A verify or assist task on responder phones |
| `handle_help(checkin_id, action, assignee?, note?)` | write | acknowledge / assign (assist task) / resolve a help request |
| `replan()` | write | Ask the planner for a proposal (publishes nothing) |
| `approve_proposal(proposal_id, zone_ids?, note?)` | write | Publish all or some zones' changes to drill phones |
| `reject_proposal(proposal_id, note?)` | write | Reject the whole proposal |
| `set_drill(action, speed?, replay_start?)` | write, shared | start / set_speed / reset the drill clock; listed only with `ORCH_ALLOW_CLOCK=1` |

Read tools carry the MCP `readOnlyHint`; `set_drill` is marked destructive (reset deletes guidance,
proposals and check-ins). Backend errors come back as tool errors with the backend's
`{"error", "status", "detail"}`.

## Safety notes

- **Shared drill.** The console, every phone and your agent act on the same incident. Writes are
  visible to everyone at once. Use a separate backend (or database) for unattended experiments,
  and leave `ORCH_ALLOW_CLOCK` unset when others are in the drill.
- **Attribution.** Every write sends `X-CrisisTwin-Actor: agent:<ORCH_AGENT_NAME>`, so
  `live_decisions` (and the console's activity log) shows the agent, not "controller".
- **Numbers.** The agent sees only numbers the planner, the twin or the bundle computed; the
  server never derives a route, ETA, count or score. Twin numbers are simulated (single seed,
  uncalibrated); 2018 record entries are historical, not drill reports.
- **Reads are not entirely free.** `get_situation` and `get_zone` read `command`, which (like the
  console's 5 s poll) may start the backend's lazy automatic replan.
- **Secrets.** The token stays in the environment and the `Authorization` header; it is never
  logged, returned or shown in `repr`.

## Example transcript (fixture data)

Against the synthetic fixture backend in `tests/fake_backend.py` (made-up values, not a drill
run). Output shortened with `…`.

```text
>>> get_situation {"max_queue": 3}
{"incident_id":"camp-2018-drill","label":"Drill: 2018 Camp Fire replay. Not a real incident.",
 "clock":{"replay_now":"2018-11-08T16:36:00Z","speed":1,"running":true,…},
 "fire":{"method":"model_nowcast","as_of":"2018-11-08T16:30:00Z","evidence_class":"simulated","observations":1},
 "zones":[{"id":"bg:060070018001","name":"Tract 18 BG 1","households":410,"vehicles":702,"level":"evacuate_now",
           "dest":"exit:1","via":["Pentz Road","Highway 99"],"eta_min":24,"safety":"clear","version":2,
           "checkins":{"out":12,"need_help":1,"staying":3},
           "twin":{"not_departed":100,"en_route":500,"arrived":102,"exposed":40,"ordered":true}},…],
 "queue":{"total":3,"shown":3,"items":[
   {"item":"help:chk_1","kind":"help_needed","checkin_id":"chk_1","flags":["help","new"],"help_status":"open",…},
   {"item":"seg:osm-way:100:0","kind":"road_passable","road":"Pentz Road","flags":["new","conflict","tasked"],
    "conflict":"2 blocked, 1 passable","reports":3,"civilian_parties":3,"report_ids":["rpt_c","rpt_a","rpt_b"],"task":"tsk_1"},
   {"item":"rpt:rpt_rec","kind":"help_needed","flags":["new","record"],"note":"2018 record: Radio: help needed",…}]},
 "proposals":{"pending":[{"id":"prp_pending1","policy":"needs_controller","causes":["fire"],"controller":"twin",
   "twin":{"evidence_class":"simulated","baseline":{"label":"No new actions","cost":84949.0},…},
   "changes":[{"zone_id":"bg:060070018002","kind":"level_change","from":{"level":"be_ready",…},
               "to":{"level":"evacuate_now","dest":"exit:2","via":["Skyway"],"eta_min":21,…}},…]}]},
 "twin":{"evidence_class":"simulated","totals":{"total_veh":31638,"arrived_veh":6564,…}},
 "events_cursor":"500:"}

>>> get_events {}
{"events":[{"at":"2026-10-24T18:05:00Z","replay_at":"2018-11-08T16:35:00Z","type":"report","id":"rpt_c",
            "change":"new","kind":"road_passable","status":"unverified","segment_id":"osm-way:100:0"},
           {"at":"2026-10-24T18:05:00Z","type":"proposal","id":"prp_pending1","change":"created","status":"pending","n_changes":2,…},
           {"at":"2026-10-24T18:05:30Z","type":"decision","id":"dec_1","actor":"controller","action":"dismiss","report_ids":["rpt_gone"]}],
 "next_cursor":"3000:decision:dec_1","more":false}

>>> run_impact {"report_id": "rpt_a"}
{"target":{"segment_id":"osm-way:100:0","name":"Pentz Road","state":"open","report_ids":["rpt_a"],…},
 "summary":{"affected_zones":1,"eta_delta_min":7,"vehicles_at_risk":600,"vehicles_at_risk_source":"twin",…},
 "zones":[{"zone_id":"bg:060070018001","change":"rerouted","eta_delta_min":7,
           "unblocked":{"dest":"exit:1","via":["Pentz Road"],"eta_min":24},"blocked":{"dest":"exit:1","via":["Skyway"],"eta_min":31}}],
 "twin":{"evidence_class":"simulated","horizon_min":60,"seed":7,"delta":{"total_exposed_veh_min":1200.0},…},
 "evidence":"planner side computed (free-flow); twin side simulated"}

>>> triage_report {"report_id": "rpt_a", "action": "confirm", "note": "crew saw it"}
{"report":{"id":"rpt_a","kind":"road_blocked","status":"confirmed","evidence_class":"field_report"},
 "replan":{"proposal":{"id":"prp_pending1","status":"pending",…}}}

>>> approve_proposal {"proposal_id": "prp_pending1", "zone_ids": ["bg:060070018002"]}
{"proposal":{"id":"prp_pending1","status":"approved","policy":"needs_controller","n_changes":2},
 "published":[{"zone_id":"bg:060070018002","level":"evacuate_now","dest":"exit:2","via":["Skyway"],"eta_min":21,"version":2,…}]}
```

The two writes went out with `X-CrisisTwin-Actor: agent:demo`; the reads without it.

## Tests

```sh
.venv/bin/python -m unittest discover -s tests -t .
```

The tools run over an in-memory MCP session against `tests/fake_backend.py` (no network). The
backend half (event stream, actor attribution) is tested in
`app/backend/api/live/tests/test_events.py`.

## Layout

| Path | Role |
| --- | --- |
| `crisistwin_mcp/config.py` | Environment configuration (`Config`) |
| `crisistwin_mcp/client.py` | HTTP client (stdlib), actor header, short `command` cache |
| `crisistwin_mcp/digest.py` | Pure response digests: field selection, queue flags, no geometry |
| `crisistwin_mcp/server.py` | The FastMCP server and tool definitions |
| `crisistwin_mcp/__main__.py` | `python -m crisistwin_mcp` (stdio) |
| `tests/` | Fake backend and tool tests |
