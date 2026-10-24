# Workspace pages reference

Moved from the root README. `/overview` and `/maps` no longer exist ([ADR 0015](adr/0015-remove-overview-and-maps.md)).

## Workspace navigation

The sidebar home link uses the transparent logo at
`app/public/brand/crisistwin-logo.png`, served at `/brand/crisistwin-logo.png`.
Asset usage and the generation prompt are in `app/public/brand/logo-notes.txt`.

The web app shares a sidebar across all pages. On narrow screens, **Menu**
expands the navigation. The current page is marked with an arrow and
`aria-current`; a keyboard-accessible **Skip to content** link reaches the main
content. Each page has its own URL and document title:

- `/`: redirects to `/fire`.
- `/scenarios`: editable name/weather/notes, sample templates, a local draft
  review, reproducibility fields, and the future scenario library.
- `/evacuation`: synthetic population/vehicle inputs, departure strategy and
  timings, shelter capacity, a sample road-closure toggle, and pending results.
- `/comparison`: baseline/candidate strategy controls, a metric comparison
  layout, compatibility requirements, and an explanation empty state.
- `/incidents`: disconnected source status, inbox search/type controls, and an
  optional clearly labeled synthetic evidence-review example.
- `/stress-tests`: selectable disruptions, a bounded candidate-run budget,
  investigation progress, and findings/unknowns empty states.

These are UI scaffolds based on [the project scope](project-scope.md).
Editable inputs are temporary component state and reset on navigation/reload;
they do not transfer between pages or modify map inputs. No scenario saving,
traffic execution, comparison results, incident ingestion, or stress-test jobs
are connected. Unsupported execution buttons are disabled with explanations.
Sample inputs are synthetic user assumptions, and unavailable results use empty
states or dashes rather than fabricated metrics. Unknown paths show a not-found page. Trailing slashes are
accepted. Navigation uses normal links and the existing Vite/Nginx HTML fallback,
so direct links, refresh, and browser history use document navigation. Temporary
map state resets when leaving or reloading the page; no scenario is saved.

To integrate a feature, extend its component in `app/src/pages/`, retaining its
URL and shared `AppShell`. `WorkspaceUI.tsx` and `workspace.css` provide common
page headers, panels, fields, status tags, and empty states. `navigationItems`
holds route metadata only. Pages own their main landmark with `id="main-content"`
and `tabIndex={-1}`. No backend contract changed. See the
[navigation decision](adr/0005-workspace-navigation.md) and
[UI scaffold boundaries](adr/0006-planning-ui-scaffolds.md).

## Simulation Studio (`/simulation`)

Place up to five fires on the map, give each a start time in elapsed simulation minutes,
set constant wind and fuel moisture, press **Run simulation**, and play the combined spread
on one timeline. All fires run through one solver pass on one shared landscape, so overlap
and "fire F1 reached F3 before its scheduled start" are modelled, not overlaid. The solve runs
in a Web Worker; the draft is kept in `localStorage` ("Saved on this device") and can be
exported or imported as JSON. Model and contracts: [ADR 0011](adr/0011-simulation-studio.md).

Limits: wind and moisture are constant for the whole run; horizons are 1, 2, 3 or 6 hours;
fires must be close enough to share one landscape (at most about 24 km across, including
spread room); edits mark the result stale and nothing re-runs automatically; a run that
reaches the grid edge is incomplete from that minute. It is a planning experiment, not an
operational forecast.

## Dispatch agent (`/dispatch`)

Set `ANTHROPIC_API_KEY` in the environment of the Django backend and restart it; without it
the endpoint returns 503. Optionally set `DISPATCH_AGENT_MODEL` and
`DISPATCH_AGENT_EFFORT` (`low`, `medium` or `high`; the default is `low`). Open
**http://localhost:5173/dispatch**, press **Load demo fire** (or pick an area and click the
landscape), wait for the roads and homes to load from OpenStreetMap (the backend needs
internet the first time a box is used; results are cached), then press **Start the AI
dispatcher**. Playback runs at 1, 2 or 4 simulated minutes per second so the agent has time to
decide; each decision is a paid model call. Model, assumptions and contracts:
[ADR 0014](adr/0014-dispatch-agent.md) and [ADR 0016](adr/0016-dispatch-anywhere.md).
