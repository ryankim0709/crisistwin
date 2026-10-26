# CrisisTwin

@AGENTS.md

`AGENTS.md` (imported above) is the canonical source of project rules for every coding
agent. It is already in your context, so do not open it with a tool. Put shared
convention changes in `AGENTS.md`, not in this adapter.

## Claude Code notes

- Nested `AGENTS.md` files are imported by a `CLAUDE.md` beside them (for example
  `app/CLAUDE.md`), so they load when you work in that directory. When adding a nested
  `AGENTS.md`, add that one-line `CLAUDE.md` with it.
- Prefer the named agents in `.claude/agents/` over `general-purpose`: `quick-task`
  (haiku), `docs-writer` (sonnet), `sim-physics` (opus). Use `Explore` for read-only
  searches across many files. If you do use `general-purpose`, pass `model` per
  [Subagents](AGENTS.md#subagents).
- For follow-up work in the same area, continue the agent you already have with
  `SendMessage` instead of spawning a new one.
