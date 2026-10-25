# CrisisTwin UI standard

Every screen in the web app is built from one set of design tokens and one component
kit, both in this directory. A judge clicking from the fire model to the dispatch agent
to the planning pages should see the same type, colour, buttons, panels and states.

```
app/src/ui/
  tokens.css        design tokens (CSS custom properties, --ct-*)
  components.css    styles for the shared components (classes prefixed ui-)
  index.ts          the only import path: import { Button, Panel } from "../ui"
  Button.tsx        Button, IconButton, LinkButton, buttonClass()
  SegmentedControl.tsx
  Layout.tsx        Page, Panel, Card, Eyebrow
  Feedback.tsx      Notice, EmptyState, LoadingState, Spinner, ProgressBar, DataState
  Data.tsx          Tag, EvidenceTag, Metric, MetricGrid, Facts, Kbd
  Form.tsx          Field, Fieldset
  Legend.tsx        Legend
  cx.ts             class-name joiner
```

`tokens.css` and `components.css` are imported once, by `src/index.css`. Feature code
imports components from `../ui` (or `../../ui`), never from an individual file.

## Rules

1. **Use a kit component when one fits.** Before writing a button, panel, tag, notice,
   empty/loading/error state, metric tile, form field, legend or toggle group, use the
   component below. Extend the kit (add a variant here) rather than restyling locally.
2. **Use tokens, not literals.** Colours, font sizes, spacing, radii, shadows, z-index and
   durations come from `var(--ct-*)`. A raw hex value in a feature stylesheet is a bug
   unless it is a data colour baked into a WebGL/three.js material or MapLibre paint
   expression (those cannot read CSS variables; keep them in the feature's `palette.ts`
   and mirror the hue in `tokens.css` if it is user-facing).
3. **Feature stylesheets own layout, not primitives.** `fire.css`, `replay.css` and the
   rest position the stage, dock and panels. They may alias tokens locally
   (`--fr-ink: var(--ct-ink)`) but must not redefine what a button or panel looks like.
4. **Prefix feature classes.** One prefix per feature so selectors never collide:
   `fr-` fire, `fdx-` fire diorama scene labels, `studio-` simulation studio, `dsp-`
   dispatch, `dm-` demo, `rp-` replay, `dio-` diorama, `wld-` shared-world menu, `ppl-` live people layer, `pmr-` app-integration phone mirror, `nav-`/`sidebar-` shell, `ws-` planning pages.
   `ui-` is reserved for this kit.
5. **Every async view has three states:** loading (`LoadingState`), empty (`EmptyState`),
   error (`Notice tone="danger"`). Never a blank panel.
6. **Never colour alone.** Status tags, legend items and notices always carry text or a
   shape. Use `EvidenceTag` to label simulated, observed, fixture and AI-generated data.
7. **Accessible by default.** Icon-only buttons use `IconButton` (label required). Inputs
   sit inside `Field`. Toggle groups use `SegmentedControl` (arrow-key navigation). Keep
   focus outlines; they come from `:focus-visible` in `index.css`.

## Themes

The default theme is **sage paper**: warm off-white surfaces, deep green ink, a single
green brand colour; every page uses it, including the historical replay and agent
simulation. The kit also ships an **operations console** dark theme, used for overlays
drawn over imagery (the studio map's wind badge and legend): add `ui-theme-dark` to an
element and the same token names resolve to dark
values, so every kit component restyles itself.

## Tokens

| Group       | Tokens                                                                                                                                                      | Notes                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Ink         | `--ct-ink`, `-muted`, `-subtle`, `-inverse`                                                                                                                 | Body text, secondary text, disabled/hints, text on brand                   |
| Surfaces    | `--ct-bg`, `--ct-surface`, `-raised`, `-sunken`, `-muted`, `-glass`, `-glass-strong`, `--ct-scrim`                                                          | `glass` = frosted panel over a map or scene                                |
| Borders     | `--ct-border`, `-subtle`, `-strong`                                                                                                                         |                                                                            |
| Brand       | `--ct-brand`, `-strong`, `-soft`, `-soft-hover`, `--ct-focus`                                                                                               | Primary actions, selected state, focus ring                                |
| Status      | `--ct-{success,warning,danger,info}` plus `-soft` and `-border`                                                                                             | Text, background and border for each tone                                  |
| Hazard data | `--ct-fire`, `-fire-hot`, `-ember`, `-ember-core`, `-burned`, `-smoke`, `-water`, `-route`, `-evacuee`, `-responder`, `-shelter`, `-closure`, `-vegetation` | Legends and overlays; the same meaning everywhere                          |
| Type        | `--ct-font-sans`, `-mono`, `-display`; `--ct-text-2xs`…`-3xl`, `-metric`; `--ct-weight-*`; `--ct-leading-*`; `--ct-tracking-*`                              | 10/11/12/13/14/16/18/23 px plus a fluid display size                       |
| Space       | `--ct-space-1`…`-12`                                                                                                                                        | 4 px grid: 4, 8, 12, 16, 20, 24, 28, 32, 40, 48                            |
| Shape       | `--ct-radius-xs`…`-xl`, `-pill`; `--ct-control-height`, `-sm`                                                                                               | Buttons are pills, inputs 8 px, panels 12 px; controls 40 px (32 px small) |
| Elevation   | `--ct-shadow-sm`, `-md`, `-lg`, `--ct-glass-filter`                                                                                                         | `md` for floating panels, `lg` for sheets/modals                           |
| Layering    | `--ct-z-base`, `-scene-labels`, `-map-controls`, `-overlay`, `-sheet`, `-popover`, `-modal`, `-toast`, `-skip-link`                                         | Never an ad hoc z-index                                                    |
| Motion      | `--ct-duration-fast`, `-duration`, `-duration-slow`, `--ct-ease`                                                                                            | Zeroed under `prefers-reduced-motion`                                      |

## Components

### Actions

| Component          | Use for                                                                    | Key props                                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`           | Any action                                                                 | `variant`: `primary` (one per view) · `secondary` (default choice for toolbars) · `soft` · `ghost` · `danger`; `size`: `md` · `sm`; `block`; `icon`; `aria-pressed` for toggles |
| `IconButton`       | Icon-only actions (close, zoom, collapse)                                  | `label` (required, becomes `aria-label` and tooltip)                                                                                                                            |
| `LinkButton`       | Navigation that looks like a button                                        | Same as `Button` plus `href`                                                                                                                                                    |
| `buttonClass()`    | Applying button styles to an element you cannot replace (e.g. `<summary>`) | Same style props                                                                                                                                                                |
| `SegmentedControl` | One-of-N choice: view mode, speed, units                                   | `label`, `options` (`{ value, label, title, icon, disabled }`), `value`, `onChange`                                                                                             |
| `.ui-text-link`    | Inline text links                                                          | class only                                                                                                                                                                      |

```tsx
<Button onClick={run}>Run simulation</Button>
<Button variant="secondary" size="sm" icon={<PlayGlyph />}>Play</Button>
<IconButton label="Close panel" onClick={close}>×</IconButton>
<SegmentedControl label="Playback speed" options={SPEEDS} value={speed} onChange={setSpeed} />
```

### Layout and surfaces

| Component                                                         | Use for                                       | Key props                                                                                                                   |
| ----------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `Page`                                                            | Every scrolling page in the sidebar shell     | `title`, `description`, `eyebrow`, `action`                                                                                 |
| `Panel`                                                           | Titled content block                          | `title`, `eyebrow`, `aside`, `glass` (over maps/scenes), `compact` (side panels); forwards `ref`, `role`, `style`, handlers |
| `Card`                                                            | Tile in a grid of items (renders `<article>`) | any HTML attribute (`className`, `aria-labelledby`, `id`)                                                                   |
| `Eyebrow`                                                         | Uppercase label above a heading               |                                                                                                                             |
| `.ui-split`, `.ui-columns`, `.ui-stack`, `.ui-row`, `.ui-cluster` | Page grids and flex rows                      | classes only                                                                                                                |
| `.ui-inset`                                                       | Sunken sub-section inside a panel             | class only                                                                                                                  |

Full-viewport tools (fire, studio, dispatch, replay, diorama) render their own stage
instead of `Page`, but their floating panels should be `Panel glass` (or reproduce its
tokens exactly) and their controls kit `Button`s.

### Feedback and state

| Component      | Use for                                      | Key props                                                                                                                  |
| -------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `Notice`       | Caveats, provenance, warnings, errors        | `tone`: `warning` (default) · `info` · `danger` (announced) · `success`; `title`; `compact` (inside docks and side panels) |
| `EmptyState`   | No data yet                                  | `title`, `symbol`, `action`                                                                                                |
| `LoadingState` | Async load in progress (announced)           | children = message                                                                                                         |
| `Spinner`      | Inline busy indicator                        | `size`: `md` · `lg`                                                                                                        |
| `ProgressBar`  | Determinate progress (0–1)                   | `value`, `label`                                                                                                           |
| `DataState`    | Loading/missing/error for a static data file | `load`, `what`, `path`                                                                                                     |

### Data display

| Component                                    | Use for                             | Key props                                                                                                           |
| -------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `Tag`                                        | Status or category                  | `tone`: `neutral` · `brand` · `success` · `warning` · `danger` · `info`                                             |
| `EvidenceTag`                                | Provenance of a value or layer      | `kind`: `observed` · `reported` · `simulated` · `reconstructed` · `fixture` · `derived` · `ai_explanation`          |
| `Metric`, `MetricGrid`                       | Headline numbers                    | `label`, `value`, `detail`                                                                                          |
| `Facts`                                      | Label/value rows                    | `items`                                                                                                             |
| `Kbd`                                        | Keyboard shortcut hint              |                                                                                                                     |
| `Legend`                                     | Map and scene legends               | `items: { label, color, shape, glyph }` with `shape`: `square` · `line` · `dot` · `dashed`, or a custom SVG `glyph` |
| `.ui-table` (+ `.ui-table-scroll`, `td.num`) | Tabular data                        | classes only                                                                                                        |
| `.ui-checklist`, `.ui-steps`                 | Bulleted and numbered process lists | classes only                                                                                                        |

### Forms

| Component                                | Use for                                          | Key props       |
| ---------------------------------------- | ------------------------------------------------ | --------------- |
| `Field`                                  | Every labelled input/select/textarea             | `label`, `hint` |
| `Fieldset`                               | Radio/checkbox groups                            | `legend`        |
| `.ui-input`                              | Styling a bare input outside a `Field` or `Page` | class only      |
| `.ui-fields`, `.ui-actions`, `.ui-check` | Two-column field grid, button row, checkbox row  | classes only    |

## Writing

- Sentence case for headings, buttons and labels ("Run simulation", not "Run Simulation").
- Buttons say what happens: a verb plus an object.
- Units always visible: `12 km/h`, `3.4 km²`, `14:05 PDT`. Use tabular numerals for
  changing numbers (`font-variant-numeric: tabular-nums`; kit metrics already do).
- Label simulated output as simulated. Never present a fixture or a model result as live
  or observed data.

## Adding to the kit

Add the component file here, its `ui-` styles to `components.css` using tokens only,
export it from `index.ts`, and add a row to the tables above in the same change.
