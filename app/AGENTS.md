# Web app instructions

Applies to `app/`. The root [`AGENTS.md`](../AGENTS.md) still applies.

## Frontend layout

```
app/src/
  main.tsx          route table (path → page); `/` redirects to `/fire`
  AppShell.tsx      sidebar shell used by every page
  navigation.ts     sidebar entries; add a route here and in main.tsx together
  index.css         element defaults + imports of the design system
  ui/               design system: tokens, component kit, UI standard (README.md)
  fire/             /fire        fire spread model (landing page, 3D diorama + maps)
  studio/           /simulation  Simulation Studio (fire + evacuation run)
  dispatch/         /dispatch    Claude dispatch agent on top of the studio
  live/             /live        live command: drill triage + guidance, with the simulated board
  demo/             simulated command board + Claude commander run by /live (/demo redirects)
  replay/           /replay, /simulate  historical replay and agent simulation
  diorama/          /diorama     scripted 3D evacuation diorama (synthetic)
  pages/            planning pages (evacuation, comparison, incidents, stress tests)
  maps/, lib/       shared basemap config and API client
  world/            shared world (docs/shared-world.md): contracts, useWorld, useScenarios, ScenarioMenu
```

## UI rules

- Import components from the kit (`import { Button, Panel } from "../ui"`). The full
  catalogue, tokens and rules are in [`src/ui/README.md`](src/ui/README.md).
- Use `var(--ct-*)` tokens in CSS; no new hex literals outside `ui/tokens.css`, except
  colours baked into WebGL/MapLibre code (keep those in the feature's palette module).
- One class prefix per feature (`fr-`, `studio-`, `dsp-`, `dm-`, `rp-`, `dio-`, `ws-`, `wld-`, `ppl-`); `ui-` is
  reserved for the kit.
- `<button>` is unstyled by default. Use `Button`/`IconButton`, never a bare styled
  button.
- New page inside the shell → wrap it in `Page`. Full-viewport tool → its own stage, with
  `Panel glass` floating panels and kit controls.

## Commands

From `app/`: `npm run dev` (Vite on :5173), `npx tsc -b --noEmit` (typecheck),
`npx vite build`, `npm run lint`. Do not write or run tests (see the root
`AGENTS.md`). Docker setup is in the root README.
