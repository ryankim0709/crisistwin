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

## Round 3

One pass with five parallel agents (Map, Home and guidance detail, Plan, Reports, backend) against the round-2 review (D10). The phone now uses the web UI kit's tokens: sage paper in light mode and the operations console in dark mode.

Fixed:
- Map: zones with an order are tinted by level, with a worded legend. Every floating control has one place, so nothing overlaps at any drawer height on iPhone 17e, 17 Pro and 17 Pro Max. The Exercise tag is inline in the drawer header. The drawer really drags (D3), and expanded it shows the exit choice, route steps, nearby confirmed facts and the person's reports. "SOS" is gone.
- Destination choice (D1): the server offers up to three alternatives per zone, each with route safety and load. Alternatives that take the same roads as one already offered are skipped. Choices go through `POST /api/live/me/destination` (2 h TTL, no location). The phone's exit picker switches the route, the headline, the ETA and the accessory, and falls back to Recommended when a pick is withdrawn. /live shows chosen destinations.
- Caveat (D2): `caveat` and `route.safety` are serialized, and the phone shows the caveat as the headline.
- Home: the incident name with an inline Exercise tag that explains itself, a tappable status block, a minimap card with Start, check-ins, Still there?, Near you, Changes and Family. When there is no incident, a calm empty state shows the plan summary.
- Guidance detail: opens from the Home status block and the bottom accessory. It shows the level and what it means, the source and age, the way out with roads and safety, the exit change, check-ins, fire distance and changes.
- Plan: a household page with a meeting-point map hero, a go-bag ring, family, trusted contacts and a compact final panel.
- Reports: the report sheet opens full height, with a minimap pin above the type grid and the nearest known road named from local data only. The Reports tab shows step meters. Tasks have inline Accept, show-on-map and Can't reach buttons. People are no longer asked "Still there?" about their own reports.

Reverted: none.

Not verified:
- The caveat line and the "no longer offered" line on Map were checked in code only.
- Unsigned simulator builds cannot keep Keychain credentials, so each relaunch registers a new device and family membership cannot be stored. This is a test-setup limit.
- The situation response grew to about 717 KB and is not gzipped. Destination load ignores twin vehicles and is unknown for Camp refuges (no capacities).
- A civilian's report never shows "Being checked", because civilians receive no tasks.

Directives done: D1, D2, D3, D10.

Gate: PASS (livecore, twin, Django, tsc, iOS build).

Open: D4 free-form reports, D9 system integrations (Live Activity, App Intents, Control, TipKit), D8 polish and end-to-end walkthrough.
