# 0015: Remove the overview and `/maps` pages

Date: 2026-10-24. Status: accepted.

The workspace overview (`/`) and the illustrative "Map & simulation" page (`/maps`)
were superseded by the fire spread model (`/fire`), the Simulation Studio and the
dispatch agent. Both pages and their components (`App.tsx`, `MapsPage.tsx`,
`MapCanvas.tsx`, `simulation/fire.ts`) are removed. This partly replaces
[ADR 0005](0005-workspace-navigation.md), which kept `/` and `/maps` compatible.

`/` now rewrites to `/fire` in `main.tsx`, so the logo and "back" links land on the
fire model. `/maps` renders the not-found page. `maps/basemap.ts` stays because the
fire and replay maps share its imagery style.

The iOS Practice tab ([ADR 0007](0007-mobile-web-map.md)) now embeds `/fire` instead
of `/maps` and only allows navigation to `/fire`. It no longer hides a
planning-tools panel, because `/fire` has none. The API/database readiness check
that the overview showed is not shown anywhere in the web app now.
