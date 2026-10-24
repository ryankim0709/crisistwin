# 0033: Controller MCP server for an external orchestrator agent

Date: 2026-10-24. Status: accepted.

## Context

[ADR 0030](0030-scenario-engine.md) makes the live drill's controller API the tool set for an
orchestrator agent a teammate is building, to test how prompting and tool design change its
behaviour. It left open whether that agent expects REST tools, an MCP server or a Python SDK, and
asked for an event stream and per-action actor attribution. The `command` poll is several MB
(zone polygons, route polylines, 500 reports), which an agent paying per token cannot read every
turn, and every controller write was logged as `controller`, so a run could not be told apart from
a human at the console.

## Decision

1. **A stdio MCP server, `orchestrator_mcp/`**, standalone like `agent/`: the package
   `crisistwin_mcp`, run as `python -m crisistwin_mcp`. It talks to a running backend over HTTP
   (`CRISISTWIN_API_BASE`, `CRISISTWIN_CONTROLLER_TOKEN`) and holds no drill logic. MCP works
   with Claude Code, Claude Desktop and the Agent SDK without client code, and the tool
   schemas and descriptions are the thing the teammate wants to vary.
2. **New dependency: the official MCP Python SDK (`mcp`, `>=1.20,<2`)**, pinned in
   `orchestrator_mcp/requirements.txt` (compiled with uv). Only this package uses it; the backend
   gains no dependency. HTTP uses the standard library.
3. **Tools** (names, typed JSON schemas and agent-facing descriptions in `server.py`): read tools
   `get_situation`, `get_events`, `get_zone`, `get_report`, `get_task_route`, `run_impact`,
   `twin_whatif`, `get_aar`; write tools `triage_report`, `create_task`, `handle_help`, `replan`,
   `approve_proposal`, `reject_proposal`; `set_drill` only when `ORCH_ALLOW_CLOCK=1`, because the
   drill clock is shared by the console and every phone. Each description starts with
   "Read-only" or "Changes ...", and says which numbers are computed (planner), simulated (twin)
   or reported.
4. **Compact, verbatim output.** Tools return compact JSON text: geometry and polylines are
   dropped unless asked, null and empty fields are omitted, and numbers are copied from the
   backend unchanged. The server computes only counts and the review-queue flags (mirroring
   `app/src/live/queue.ts` where no geometry is needed). An LLM never fills a number in.
5. **Event stream** `GET incidents/{id}/events?since=` in `api/live/events.py`: a read-only merge
   of reports, decisions, proposals, guidance, check-ins, help and task changes, at least once with
   stable keys ([contract](../live-reports.md#event-stream)). The MCP server keeps the cursor and
   drops events it already returned.
6. **Actor attribution.** MCP writes send `X-CrisisTwin-Actor: agent:<ORCH_AGENT_NAME>`; on a
   controller request the backend records it as `actor` in `live_decisions` through a
   request-scoped context variable read by `log_decision`, so no view signature changed
   ([contract](../live-reports.md#actor-attribution)).
7. **Incident.** Every tool takes an optional `incident_id` defaulting to `camp-2018-drill`
   (`ORCH_INCIDENT_ID`). Following the active incident (`GET /api/live/active`, ADR 0030) is a TODO
   in `config.py`.

## Consequences

- The drill is still a labelled exercise: an agent approving a proposal publishes drill guidance
  to drill phones, as a human controller would, never real alerts (ADR 0012).
- Proposals keep `decided_by: "controller"`; who decided is in `live_decisions.actor`. The AAR
  timeline on `feat/drill-aar` reads that log, so it will show the agent.
- `get_situation` reads `command`, which, like the console's poll, may start the backend's lazy
  automatic replan.
- The token is read from the environment, sent only as a header, and never logged or returned.
