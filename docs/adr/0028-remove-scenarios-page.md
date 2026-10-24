# 0028: Remove the `/scenarios` page

Date: 2026-10-24. Status: accepted.

The `/scenarios` page was a planning UI scaffold ([ADR 0006](0006-planning-ui-scaffolds.md)).
It was never connected to a model or to storage: its "Saved scenarios" panel said
"Persistence not connected". The Simulation Studio saves real scenarios as a local draft
(`studio/scenario.ts`, `studio/draft.ts`, [ADR 0011](0011-simulation-studio.md)), so the
scaffold duplicated the studio without adding behaviour. In the demo it was a dead page.
This partly replaces ADR 0006, which scaffolded it.

Removed: `pages/ScenariosPage.tsx`, its route in `main.tsx`, and its sidebar entry in
`navigation.ts`. `IncidentSummary.tsx`, `WorkspaceUI.tsx`, `workspace.css` and
`workspaceData.ts` stay, because the evacuation and other planning pages still use them.

`/scenarios` now redirects to `/simulation`, as `/incidents` redirects to `/intel`
([ADR 0015](0015-remove-overview-and-maps.md) let `/maps` fall through to not-found instead).
Trailing slashes and query strings are kept. Saved scenarios are not migrated, because the
scaffold never stored any.
