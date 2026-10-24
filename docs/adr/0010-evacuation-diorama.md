# 0010: Fictional wildfire evacuation diorama

Date: 2026-10-23. Status: accepted for the demo.

Add a `/diorama` page: a scripted, ~90-second, looping 3D miniature of a fictional town
("Larkspur Hollow") showing fire spread, evacuation traffic, a bridge bottleneck and fire
crew response. All data are synthetic and generated deterministically from a fixed seed.
It is a visual demonstration, not a validated fire or traffic model, and not operational
guidance. The page says so permanently: "Fictional scenario · Synthetic data · Visual
demonstration". It has no backend, live data, paid services or keys.

## Rendering choice

`three` (pinned 0.170.0) with procedural low-poly geometry, instancing for trees and
vehicles, and `OrbitControls` from `three/examples/jsm`. MapLibre is a geographic map and
cannot produce a stylized diorama; a hand-rolled 2D isometric canvas would make orbit/zoom
and lighting much harder. No other dependency is added.

## Module boundaries (`app/src/diorama/`)

| Path | Owner | Contents |
| --- | --- | --- |
| `types.ts`, `world.ts` | shared | Contract types; fixed synthetic geography (roads, homes, households, trees, river, terrain `heightAt`). |
| `scenario/` | scenario logic | `createScenario(world): Scenario` — pure TypeScript, no DOM or three. Precomputes the fire field and vehicle trajectories with a fixed time step; `sample(t)` returns a `SimSnapshot`. |
| `scene/` | rendering | `DioramaScene` class rendering `World`, `FireField` and a `SimSnapshot`. |
| `ui/`, `DioramaPage.tsx`, `diorama.css` | interface | Playback clock, controls, timeline, legend, caption, counters, pick labels, recap. |

### Scene API (`scene/DioramaScene.ts`)

```ts
new DioramaScene(container: HTMLElement, world: World, fire: FireField, opts: { reducedMotion: boolean })
update(snapshot: SimSnapshot): void   // whenever simulation time changes
resetView(): void                      // animate back to the composed view
onPick(cb: (target: PickTarget | null) => void): void
project(target: PickTarget): { x: number; y: number } | null  // CSS px within container
setReducedMotion(value: boolean): void
setViewInsets(insets: { top: number; right: number; bottom: number; left: number }): void
  // CSS px of the container covered by overlay UI; the default view and resetView frame the
  // whole board in the remaining rectangle (projection shifted via setViewOffset), refit on change
dispose(): void
```

The scene owns its render loop, resize handling and camera. The page owns simulation time.

## Simulation invariants

- `population` is fixed; `atHome + walking + inVehicles + sheltered === population` in every snapshot.
- Vehicles follow road polylines only, never closed edges (routes are planned around edges
  closed at departure time; edges close before any vehicle is routed over them).
- Vehicles keep a minimum gap on shared lanes, so queues form at the single-lane bridge.
- Counters are derived from the same snapshot that drives the animation.
- Determinism: no `Math.random`, no wall clock; the same `t` returns the same snapshot.

Simplifications: the fire is a scripted wind-biased spread over a grid with deterministic
noise; it is not Rothermel and ignores fuel moisture and spotting. Traffic is a simple
follow-the-leader model. Crew suppression is a scripted hold of one perimeter section.
