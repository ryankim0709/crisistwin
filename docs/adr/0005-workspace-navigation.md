# 0005: Shared workspace navigation

Date: 2026-10-23. Status: accepted for the hackathon navigation scaffold.

Wrap the existing overview and map in `AppShell`, with a persistent desktop
sidebar and a collapsible inline menu on narrow screens. Keep the current cream
and green visual language. Each page owns one main landmark, reachable through
the shell's skip link. Navigation identifies the current page with text, color,
and `aria-current="page"`; the shell sets the document title.

Keep `/` and `/maps` compatible. Add `/scenarios`, `/evacuation`, `/comparison`,
`/incidents`, and `/stress-tests` as labeled, informational empty states derived
from the P0/P1 project scope. These pages introduce no simulated metrics, observed
incidents, persistence, or executable planning actions. Unknown paths render an
explicit not-found page instead of silently returning the overview.

Use the existing pathname selection in `main.tsx` and native anchor navigation;
normalize trailing slashes and reuse the Vite/Nginx HTML fallback. Navigation
labels and placeholder content live in `navigation.ts`. A routing dependency is
not needed for these flat routes. The tradeoff is a full document load and loss
of temporary map state on navigation, which is disclosed on the map and in the
README. Persistent scenario state and client-side routing can be introduced when
those workflows exist, with an explicit state-lifecycle decision.

No dependencies, API contracts, setup commands, simulation models, or mobile
interfaces change. Future pages should retain these URLs, live inside the shared
shell, and keep a focusable `main` with `id="main-content"` for the skip link.
