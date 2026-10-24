# 0037: Studio drill packages: any California Studio fire as a live drill package

Date: 2026-10-24. Status: accepted (building and storing; activation is separate).

## Context

ADR 0030 (`docs/adr/0030-scenario-engine.md`) makes every live drill an incident backed by a
**drill package**, with two builders: historical replay bundles (Camp) and Studio scenarios
anywhere in California. The live backend reads a drill only through `livecore.drill.load_drill`
(zones, roads, destinations, fire timeline). Simulation Studio (ADR 0011,
`docs/adr/0011-simulation-studio.md`) solves a fire in the browser and has no clock, roads or
homes; `/api/dispatch/area` (ADR 0017, `docs/adr/0017-dispatch-anywhere.md`) builds OSM roads,
stations and synthetic homes grouped into zones for any box.

## Decision

1. **The package is a replay bundle.** `livecore/package.py` (pure, stdlib) converts a Studio
   run export plus a dispatch area into a document `load_drill` reads unchanged, with an added
   `drill_package` block, a `stations` layer and `mode: "scenario"`. The contract is in
   `docs/replay-bundle.md` "Drill packages". `load_package` wraps `load_drill` to set the
   package's own incident id, label and name (`load_drill` would give it the Camp label).
2. **The fire timeline is the browser's frame perimeters**, sent as WGS84 MultiPolygons and
   stored as `fire_simulated.fronts` (`simulated`), so the drill shows exactly what the Studio
   showed. The arrival grid (Web Mercator, seconds after T+0) is sent too: the server validates
   the frames against it, derives the road box from it, and stores a resampled bundle-shape
   `arrival_grid` for "time until fire reaches here" lookups. There are no perimeters,
   observations or events.
3. **The server picks the road box** from the reached cells and ignitions plus 3 km, within the
   dispatch area's size limit, and fetches the area through the existing cache. A fire larger than
   that box keeps its full timeline, and a limitation says roads cover its centre only.
4. **California only**, checked with a 20-vertex outline in `package.py` (box centre and every
   ignition). It is accurate to a few km; a precise state boundary was not worth a dependency.
5. **Stations are a separate layer.** `destinations` are evacuation targets (exit, shelter,
   refuge) and `load_drill` rejects other kinds, so stations go in `stations` for responder
   generators (ADR 0030 item 2).
6. **Storage is files**: `{LIVE_PACKAGES_DIR}/{package_id}.json` plus a `.meta.json` summary
   (default `app/backend/var/packages`, git-ignored), written atomically. Ids hash the run, the
   area and the builder, so posting the same run twice returns the stored package. This answers
   ADR 0030's open storage question for now; GridFS can replace it without changing the API.
7. **Building never activates.** `POST /api/live/packages` (controller) builds, verifies with
   `load_package` and stores. `activate(package_id)` in `api/live/packages.py` only returns
   what would change (incident id, bundle path, loader, clock, label, twin); `/api/live/active`
   owns switching.
8. **Labels travel with the data.** Wind, moisture, ignition time and ignitions are stated as
   assumed; zones are `fixture` with `synthetic: true`; the fire is `simulated`; the drill label
   says "simulated Studio fire … Not a real incident."
9. **Web:** "Use as live drill" under the Studio's Export JSON posts the current, non-stale run
   (the free-burning fire, never a firefighting plan) with T+0 = now, and shows the package id,
   zone count and synthetic home count, or the error. Controller auth comes from the Vite proxy.

## Consequences

- A package is a few MB (roads, fronts, grid); the run export up to 24 MB, read past Django's
  2.5 MB upload limit on this endpoint only.
- The traffic twin, ground record and incident list are still Camp-only; activation must
  rebuild the twin from the package's roads and zones.
- Packages depend on OSM at build time; once stored they are self-contained.
