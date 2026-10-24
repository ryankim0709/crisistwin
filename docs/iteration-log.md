# Live loop iteration log

Each round of adversarial review: what was fixed, what was reverted, and the gate result.

## Round 1

Fixed:
- R1-A: independent reporters are counted by server receive time; routes avoid the fire estimate (least-exposure fallback, labelled); destinations are validated; no zero-length routes.
- R1-B: partial approval of proposals by zone; changes driven by crowd-only blocks are held for the controller; one clock on /live.
- R1-C: the twin stays in sync after drill restart, seek and speed changes.
- R1-D: still-there prompts for crowd-reported hazards; situation cache for offline launch; change banners lead with what changed.
- R1-E: one-tap report sheet.

Reverted: none. R1-B and R1-D were retried after skeptic refutations; the retries were not re-verified by a skeptic before the run was stopped.

Gate: PASS (livecore, twin, Django, tsc, iOS build).

Open: user directives D1–D7 (destination choice, fire-fallback and status band, a real draggable sheet, free-form reports, Liquid Glass tabs and Home on iOS 26, field app structure, planner workspace) are in .iterate/user-directives.md.
