# 0011: Diorama view for the fire spread model

Date: 2026-10-23. Status: accepted for the demo.

The `/fire` page replaces its MapLibre aerial-imagery map with a three.js miniature of the
loaded landscape, matching the art direction of the `/diorama` page (ADR 0010). The model
(Rothermel spread, crown fire, spotting, structure spread — ADRs 0003/0004/0007/0008/0009),
its inputs and its data sources do not change.

## What is drawn, and from what

- Terrain: `LandscapeGrid.elevationMeters`, downsampled for the mesh, with a stated
  vertical exaggeration so relief reads at miniature scale.
- Ground cover: LANDFIRE FBFM40 fuel codes and canopy cover. Timber families become pines
  and round trees, shrub families low bushes, grass families meadow tones, urban/developed
  (91) small houses, water (98) water, other non-burnable codes bare ground or fields.
  Tree and house placement is stylized and deterministic per cell; it shows the fuel class,
  not individual observed trees or buildings.
- Fire: `FireRun.arrivalMinutes` (added in this change; additive to `FireRun`). At time t a
  cell is burning when `arrival ≤ t < arrival + window`, burned afterwards, unburned
  otherwise. The page animates t continuously between the 15-minute frames; the frames,
  perimeters and statistics remain the model's output.
- Ignition marker and wind arrow from the page's inputs.

Choosing an area: the page loads the landscape around an *area centre* (default Berkeley
Hills) when it opens, so there is a board to click before any ignition. Clicking the board
sets the ignition point inside the loaded area without refetching. A small locator map
picks a new area centre. On the `/fire` page it is the only remaining imagery map;
`/maps` and the replay views still use MapLibre.

## Module boundaries

| Path | Contents |
| --- | --- |
| `app/src/fire/diorama/types.ts` | Contract (`FireDioramaSceneApi`). |
| `app/src/fire/diorama/*.ts` | three.js renderer `FireDioramaScene`; may import generic helpers from `app/src/diorama/scene/`. |
| `FireSimulatorPage.tsx`, `fire.css`, page components | Layout, controls, locator, playback, results. |

Limits: houses and trees are symbols for fuel classes; vertical exaggeration distorts
slope visually (never the model's slope); the board covers the modelled square only.

## Addendum (2026-10-24): real streets on the board

`/fire` and the Studio 3D view (`/simulation`, and `/dispatch`, which renders the Studio page) now draw the board's OpenStreetMap roads and
place houses along residential streets, instead of the stylized house lattice and the
procedural street grid in the ground shader. Data comes from the dispatch area endpoint
(`GET /api/dispatch/area`, ADR 0017) for the board's extent (`fire/useBoardStreets.ts`; boxes
larger than the endpoint allows get the centre 0.2° × 0.26°). Homes are that endpoint's
synthetic homes (~40 m apart along residential streets, thinned uniformly past 20,000),
turned to face the nearest road; they burn with the arrival field like the lattice houses.
Trees and bushes are kept off the roads. Road widths are exaggerated (minimum 0.45–1.35 world
units by class). Renderer: `fire/diorama/streets.ts`, `FireDioramaSceneApi.setStreets`.

If the roads cannot be loaded (backend down, Overpass busy, no roads on a wilderness board)
the board keeps the stylized lattice. The first visit to a new board waits on Overpass
(typically 5–30 s); afterwards the box is cached in process and in MongoDB. A page that draws its
own homes (the `DispatchOverlay`) still hides the board's houses with `setCoverHouses(false)`.
