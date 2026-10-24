# 0031: Dispatch run journal and agent memory in MongoDB Atlas

Date: 2026-10-24. Status: accepted for the demo. Builds on
[0008-mongodb-backend](0008-mongodb-backend.md) and [0019-live-dispatch-monitor](0019-live-dispatch-monitor.md).

## Context

Dispatcher decisions lived only in the browser tab. Nothing recorded what was tried on a road
network or how it turned out, and every run started from nothing. The app already uses Atlas
(`MONGODB_URI`) for landscapes, families, intel and the live broadcast, so persisting runs adds
no service.

## Decision

- **Collection `dispatch_runs`**, one document per session (`_id` = a random UUID the page makes
  at start; index on `area_id, updated_at`): `area_id`, `area_name`, `scenario` (fire names, wind,
  horizon), `decisions[]` (minute, `woke_because`, planner closures in effect, totals, orders as
  text, rejected count, summary, model; last 120 kept) and `outcome` (minute, finished, totals,
  `no_action_exposed`). Labelled `evidence_class: "simulated"`.
- **Writes.** `POST /api/dispatch/decide` takes an optional `session_id`. After the final NDJSON
  line it appends the decision (`$push` with `$slice`, upsert), so a slow database never delays
  orders on the live clock; a failure is logged and ignored. When the session finishes or is
  stopped the page sends `POST /api/dispatch/runs/<session_id>/outcome` (204; 404 when no decision
  was journalled; it never creates a journal).
- **Memory.** On a session's first decision the server reads up to 3 earlier runs on the same
  `area.id` that have an outcome, and puts them before the observation in a `<past_runs>` block
  (orders tried, closures, last summaries, outcome). The lookup is cached per session in the
  worker, including a failed one. The prompt says these are lessons from other simulated runs,
  possibly with other fires, never facts about this run. The final `orders` event carries
  `recalled_runs` and the log shows "Recalled N earlier simulated runs … (MongoDB Atlas)".
- **Read.** `GET /api/dispatch/runs?area_id=` lists the 20 most recent runs (summaries only).

## Consequences

- The agent can learn across runs on the same roads, for example which exit jammed or which zone
  was ordered too late, without the server inventing numbers: outcomes are the simulator's.
- Past summaries are earlier model output fed back as data; they are marked as such and the
  observation remains the only source of current figures.
- Unauthenticated local demo endpoints, like `/decide` and `/live/broadcast`. Anyone who can reach
  the API can read run summaries; they hold no resident data (homes and zones are synthetic).
- Revisit: Atlas Vector Search over decision embeddings to recall similar *situations* rather
  than the same area, and a history view in the console.
