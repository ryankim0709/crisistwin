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

## Round 2

Fixed:
- R2-A: the phone is an iOS 26 tab app (Home, Map, Reports, Plan, plus Tasks for responders) in the new design, with a live-guidance bottom accessory and Liquid Glass map controls. The status band's action text never truncates. Family and the Web simulation feed sit in Plan. The deployment target is 26.0 (ADR 0018).
- R2-B: the least-exposure fallback prefers destinations that leave the fire area. A temporary refuge counts only if it is outside the fire estimate plus its buffer. When every option passes the fire, the planner returns a caveat.
- R2-C: /live is one planner workspace: a togglable incident map, a review queue (new, conflicting, stale, high-impact; sorted by impact), actions on the selected item, impact analysis from the twin what-if, and the evacuation picture.

Reverted: none.

Not verified (kept but unverified):
- R2-A: VoiceOver, Reduce Motion, haptics, iPad and a physical device; the new-guidance moment (route ghost and draw-on) live; Home with no zone, location off and offline.
- R2-B: the caveat and route exposure are not serialized in api/live yet, so the phone never shows the caveat.
- R2-C: ETA deltas can be negative. The twin deltas vary from run to run because the twin uses a single seed. On screen the only caveat is the "Simulated" tag.

Directives done: D5, D6, D7. D2 and D9 are partly done (see their status lines).

Gate: PASS (livecore, twin, Django, tsc, iOS build).

Open:
- D2: serialize `caveat` and `route.exposure` through api/live, types.ts, LiveModels.swift and docs/live-reports.md, and show the caveat as the headline.
- D1, D3, D4: destination choice, a real draggable sheet, free-form reports (round 3).
- D9: Live Activity, App Intents and Control, TipKit (round 3).
- D8: polish pass and end-to-end walkthrough (round 4).
