# 0032: Similar past situations by Atlas Vector Search

Date: 2026-10-24. Status: accepted for the demo. Builds on
[0031-dispatch-run-memory](0031-dispatch-run-memory.md).

## Context

The run journal (0031) shows the agent earlier runs on the *same* road network. Lessons also
transfer between places: two neighbourhoods with a fast fire, little order slack and a lost exit
call for similar moves. Matching by situation needs a similarity search over many decisions,
which MongoDB Atlas Vector Search provides on the cluster we already use.

## Decision

- **Situation vector, not text embeddings** (`api/situation.py`, pure). 21 features computed from
  the observation's simulator figures only: shares of households in the fire path, not ordered,
  waiting, en route, out and exposed; threatened and unaddressed zones; the tightest order slack;
  urgent zones; burning fires, burned area (log), crowning; wind speed and direction (sin, cos);
  planner closures and fire-cut roads (log); blocked routes; available engines; the clock. Each is
  scaled to [0, 1] then centred to [-1, 1]; cosine similarity compares the shape of situations.
  No embedding provider, no new key, deterministic. `VERSION` guards the layout.
- **Collection `dispatch_situations`** (`api/dispatch_situations.py`): one document per journalled
  decision: vector, a readable `situation` summary, the orders and summary, `has_outcome` and the
  run's `outcome` (set by the outcome endpoint for all of the run's situations).
- **Index** `situation_vector` (type vectorSearch: the vector with cosine similarity, filters on
  `has_outcome`, `session_id`, `version`). Created on first use or with
  `python manage.py dispatch_vector_index`, which also reports when Atlas has it READY.
- **Query** before every decision: `$vectorSearch` (150 candidates, 20 results) over finished runs
  other than this session, keep scores ≥ 0.9 (Atlas cosine score (1 + cos) / 2, so cos ≥ 0.8),
  best one per run, top 3. They go to the agent as `<similar_situations>` with similarity,
  whether it is the same road network, the situation, the orders given and the run outcome. The
  prompt says they are lessons from other simulated runs and that their ids must never appear in
  orders. The final `orders` event carries `similar_situations`; the log says "Matched N similar
  situations … by Atlas Vector Search".
- **Failure is cheap.** Any search error (no Atlas, index missing or building) skips the block and
  turns the search off for 60 s, so a decision never waits on repeated timeouts.

## Consequences

- The agent sees what was done in comparable moments anywhere and how it ended, by the
  simulator's counts. Repeating the same scenario matches itself (score ≈ 1).
- Hand-picked features decide what "similar" means; they ignore road layout and zone geometry.
- The index needs Atlas (or Atlas local); plain MongoDB runs without the feature.
- Revisit: text embeddings of the agent's summaries (for example Voyage AI) as a second vector for
  hybrid search, and weighting features by how much they predicted outcomes.
