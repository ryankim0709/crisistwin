# 0012: Large fire landscapes and long horizons

Date: 2026-10-24. Status: accepted for the demo.

The `/fire` page now runs Bay-Area-sized boards (50 km radius) and the prebuilt Southern
California regions (ADR 0013, 25–40 km at 60/90 m), and offers 12- and 24-hour horizons.
LANDFIRE's native 30 m lattice cannot do that in a browser: a 50 km radius is about 4200
native cells per side, roughly 18 million cells per layer. This entry records how the
loader coarsens the landscape, what the coarse grid loses, and what the solver does at
coarse cells and long horizons. Fire physics, fuel tables and every model constant
(ADRs 0004, 0007, 0008, 0009) are unchanged.

## Contract (`app/src/fire/landscape.ts`, `app/src/fire/spread.ts`)

- `loadLandscape(lon, lat, groundRadiusMeters, signal, { cellMeters?, endpoints? })`.
  `cellMeters` omitted or ≤ 30 loads the native lattice exactly as before. Larger values
  build a coarse lattice whose **ground** cell is exactly `cellMeters`.
  `landscapeCellMetersFor(radius)` picks the next multiple of 30 m that keeps the grid at
  most `MAX_GRID_CELLS_PER_SIDE` (900) cells across. A coarse request over that limit is
  refused. The native lattice is 30 Mercator metres, which is 30·cos(latitude) on the
  ground, so a native grid near the limit can be up to 1/cos(latitude) wider (about 1013
  cells for a 12 km radius at 38° N).
- `LandscapeGrid.cellMeters` (30 for native) and `LandscapeGrid.resampling`
  (`"native" | "mode" | "nearest"`; the loader emits only the first two).
  `groundCellSizeMeters`, `originX/Y` (centre of cell 0,0) and `cellSizeX/Y` (signed
  Mercator metres) describe whichever lattice was built.
- `FireRun.resolution`: `{ cellMeters, groundCellSizeMeters, resampling, maxStepMeters,
  spottingReachCeilingMeters }`, which the page uses to state the resolution. The existing
  `FireRun.cellSizeMeters` field is unchanged.
- `endpoints: { landfireWcsUrl?, terrainTileUrl?, fetch?, userAgent? }`. The defaults are
  the browser path (`/landfire/wcs` proxy, public terrain bucket). A Node caller passes
  `LANDFIRE_UPSTREAM_WCS_URL` and `LANDFIRE_USER_AGENT` and sends no browser headers,
  because the USGS firewall blocks browser-looking traffic (see `app/vite.config.ts`).
  The load path no longer uses canvas or `createImageBitmap`. Terrain PNGs are decoded
  with `DecompressionStream`, so the loader runs unchanged in Node 22+.
- `HORIZON_CHOICES` is `[120, 180, 360, 720, 1440]`. `FIRE_STEP_MINUTES` stays 15 at
  every horizon, so a 24-hour run has 97 frames and frame k is always at k × 15 minutes.
  It is an output sampling interval, not a solver step: arrival times are continuous.
- `SPREAD_MODEL.version` 4.1.0. Arrival times and frames are bit-identical to 4.0.0 on the
  same landscape. The version moves because the run carries a new field and the
  propagation description no longer says "30 m".

## Resampling

**Fuel: mode over a regular sample grid.** For each coarse cell, the loader asks the
LANDFIRE WCS for nearest-neighbour samples on a grid spaced at about a third of the cell
(WCS 2.0 `scalesize` + `interpolation=nearest-neighbor`). The cell takes the most
frequent FBFM40 code among the 9 or so samples whose centres fall inside it. Ties go to
the sample nearest the centre, then to the first in row-major order, so the result is
deterministic. No-data samples vote like any other code, so a cell that is mostly ocean
outside CONUS stays unmapped. The mode is computed in the client. Server-side
nearest-neighbour alone would pick one arbitrary 30 m cell per coarse cell, and
averaging is meaningless for categorical codes.

Two properties of the service were measured, not assumed, and the code depends on both:

- At more than 2× the native spacing, GeoServer reads from its reduced-resolution
  overview, and returned values stop sitting where the response's georeferencing says.
  A 4× request matched the native raster at its own pixel centres on only 45 % of
  samples. So samples are never spaced more than 57 Mercator m apart. Coarse cells
  wider than 171 Mercator m get more than 3 samples per axis.
- Requests whose edges sit on the native lattice come back on exactly the requested grid.
  Unaligned requests are snapped by up to one native cell. So every sub-request is a
  512 × 512 sample block (compact 0.5 MB bodies; 600 × 600 hit the service's 2 MiB
  cut) whose edges lie on the LF2025 lattice. The response's size, origin and spacing are
  checked against the request, and any mismatch fails the load rather than shifting the
  fuels.

Validated against native 30 m rasters at Berkeley (37.87° N) and the Santa Monica
Mountains (34.09° N), at 60, 90, 120 and 240 m:

- Samples equal the native cell under their centre 99.4–100 % of the time.
- The 9-sample mode equals the true mode of all native cells in the coarse cell for
  80–93 % of cells. Taking only the centre sample (nearest neighbour) gets 54–84 %.
- On average the chosen code covers 49–73 % of the native cells in its coarse cell
  (lower at coarser cells), against 38–70 % for nearest.

**Canopy: mean over the samples carrying the chosen fuel.** The four canopy layers are
fetched on the same sample grid, so canopy sample k is the same ground as fuel sample k.
Each coarse cell averages the raw values of only those samples whose fuel code matches
the cell's mode. This keeps canopy consistent with the fuel bed it sits over. A cell
that comes out as grass does not inherit the cover of the timber samples it out-voted.
Scaling, plausibility limits and the missing-data rule that disables crown fire are the
same as the native path.

**Terrain: mean.** Terrarium tiles are read at the zoom whose pixel is no larger than the
cell (z11, 76 m pixels, for 120 m cells at 38° N, instead of z13). Each coarse cell takes
the mean of the pixels whose centres fall inside it. Slope and aspect then come from the
coarse elevations by Horn's method, at the coarse ground cell size.

**Terrain artefacts and water (both paths, native and coarse).** At some coastlines the
terrarium tiles hold values deeper than any ocean: −13,500 m near Point Mugu and
−12,700 m near Carpinteria. In the first builds of the Santa Monica Mountains and Ventura
regions these pushed land-cell slope tangents up to about 70, with 255 and 146 land cells
above 3. The loader now handles terrain like this:

- A tile sample below −500 m or above 9000 m is treated as missing before any averaging.
- After the fuel codes are known (`repairElevation`):
  - Open water (98) that is missing or below 0 m is set to 0 m. The board and the slope
    model want the water surface, not bathymetry. Lakes above sea level keep their
    surface elevation.
  - Unmapped cells (offshore, outside CONUS) below 0 m are set to 0 m.
  - A land cell below −100 m, or with no valid sample, is refilled with the mean of its
    valid 8-neighbours, growing outward pass by pass. −100 m is below Death Valley
    (−86 m) and the Salton basin (−70 m).
- `elevationComplete` is false if any tile was missing, or if more than 1 % of land cells
  had to be filled.

After the fix:

| Region | Max land slope tangent | Land cells above 3 | Land cells filled |
| --- | --- | --- | --- |
| Santa Monica Mountains (60 m) | 1.18 | 0 | 0 |
| Ventura / Los Padres (90 m) | 1.51 | 0 | 4 of 518,730 |

- In both regions, `elevationComplete` stayed true and every value is finite.
- Water cells sit at a median of 0 m and a 90th percentile of 2–4 m. The higher water
  values are inland reservoirs.
- Water slope reaches 0.44 only in cells at the shoreline. Water carries no fire, so this
  does not affect spread.

## What a coarse cell loses

These are real losses, and the page must state the resolution next to any result:

- **Narrow fuel breaks, roads and streams.** A feature narrower than about half a cell
  usually loses the vote and disappears. In a synthetic test, a 60 m river every 2 km
  held fire and forced spotting at 30 and 60 m, and was gone at 120 m. Because spotting
  only launches over unvegetated cells, losing gaps also removes spotting: there is less
  of it at coarse cells, and the shortest spot is longer (2 cells, 240 m at 120 m).
- **Small urban patches and the urban edge.** A developed block smaller than a cell can
  vanish into the surrounding vegetation. A subdivision with scattered yards can fill
  in solid. Structure spread and ember launch follow whichever code won.
- **Slope.** Averaging elevation and differencing over 120 m flattens steep, short
  slopes (canyon walls, road cuts), so Rothermel's slope factor is understated on
  rugged ground.
- **Mixed cells.** Every cell carries one fuel model. A cell that is 40 % chaparral and
  35 % grass burns as pure chaparral.

## Solver at coarse cells

Distances, areas and slope come from `groundCellSizeMeters`, converted once at the
boundary. The audit found no other dependence on 30 m:

- **Stencil radius stays 8 cells.** ADR 0009's reason for the radius is angular: the
  direction set, and the ellipse the lattice can draw, depend on the integer offsets,
  not on the cell size. Converting it to metres would cut the radius to 2 at 120 m cells
  and bring back the under-drawn ellipse 0009 fixed. The cost grows with the cell. The
  longest step, offset (8, 7), is 1.28 km at 120 m. A step carries its source cell's rate
  and checks only that the cells it crosses can burn, not how fast they burn, so in
  patchy fuel a long step can push a fast fuel's rate through a slow patch. Barriers
  hold at any cell size (ADR 0009's full-path rule). `FireRun.resolution.maxStepMeters`
  reports the longest step.
- **Spotting bound stays in cells.** `SPOTTING_MAX_PATH_CELLS` (48) bounds solver work, so
  it stays a cell count. In metres it grows with the cell: 1.1 km at Berkeley native,
  5.8 km at 120 m. A coarse run can therefore honour a spotting distance above 1.1 km
  that a native run would cut short. `FireRun.resolution.spottingReachCeilingMeters`
  reports the ceiling actually applied. The 500 m default binds first at every cell size.
- **Structure spread and crown fire** are per cell and have no cell-size term.
- **Uniform fuel is resolution-consistent.** On uniform GR2, SH5 and TU5 boards over
  3–12 hours, burned area at 60 and 120 m stayed within 7 % of 30 m, and reach within
  6 % (slightly short, from cell quantisation). Heterogeneous ground is not consistent.
  The river-and-fuel-boundary test above gave 421, 272 and 323 ha at 3 h for 30, 60 and
  120 m. The difference comes from the lost features and long steps, not from the
  solver's geometry.

## Long horizons

Weather is constant for the whole horizon: one wind speed, one wind direction, one set
of fuel moistures, with no diurnal cycle, no overnight humidity recovery, no wind shift,
and no suppression. A real wind-driven fire usually lies down at night, and a 24-hour
constant red-flag run is a stress test of the landscape, not a forecast of a day's
growth. A 24-hour run also extends further past the conditions behind every calibration
note in ADRs 0007–0008, all of which were made at 3 hours. The page must say this
wherever a 12- or 24-hour horizon is shown.

## Performance

Loads were measured from Node going directly to the upstream services, with 4 concurrent
LANDFIRE requests and 6 concurrent tile requests. Browser loads go through the proxy and
will differ.

| Board | Grid | LANDFIRE requests | Terrain tiles | Bytes | Time |
| --- | --- | --- | --- | --- | --- |
| Berkeley 3 km, native | 253² | 5 | 9 (z13) | 1.8 MB | 1.1 s |
| Bay 50 km, 120 m | 833² | 125 (25 × 5 layers) | 49 (z11) | 71 MB | 13.2 s |
| San Diego backcountry 40 km, 90 m | 889² | 180 (36 × 5) | 36 (z11) | 99 MB | 13.7 s |

Aborting a Bay load rejects at once, and no request starts after the abort. Requests
already in flight finish, as before.

Solver times (Node, same V8 as Chrome):

| Run | 4.0.0 | 4.1.0 |
| --- | --- | --- |
| Berkeley native, 40 mph, 3 h | 87 ms | 71 ms |
| Bay 120 m, 25 mph, 6 h | 197 ms | 83 ms |
| Bay 120 m, 40 mph, 24 h | 543 ms | 122 ms |
| San Diego 90 m, 40 mph, 24 h (70 % of the board burned) | 933 ms | 442 ms |
| Synthetic 833² GR2, 40 mph, 24 h (reaches edge) | — | 500 ms |

The speed-up comes from the frames, not the solver. Per-frame statistics now take one
binned pass over the grid instead of a full scan per frame. Contouring is limited to the
burned bounding box. Ring containment gets a bounding-box pre-test. All three return
exactly what the full scans did.

Outputs remain planning experiments, not operational evacuation instructions.
