# 0002: Reusable imagery map

Date: 2026-10-23. Status: accepted.

Use MapLibre GL JS 6 for `MapCanvas` and a `/maps` page. It replaces the initial
Leaflet implementation at the user's request. USGS The National Map imagery
provides the landscape background for the illustrative fire overlay. No terrain
elevation model is included; photographic relief is not a computed 3D surface.

## Map boundary

`center` and `onLocationSelect` use named WGS84 `latitude`/`longitude` fields;
convert to MapLibre's [longitude, latitude] order at the rendering boundary.
Callbacks normalize longitude to [-180, 180). `selectedLocation` controls the
origin marker; `null` removes it. `firePerimeter` accepts the GeoJSON frame shape
from [the fire model contract](0003-illustrative-fire-spread.md).

Changing center/zoom moves the existing camera. Perimeter changes update only
the GeoJSON source; they do not reload imagery. Changing `mapStyle` (a MapLibre
style object or URL) recreates the map. Keep style objects stable. The source
`fire-footprint` and layers `fire-fill`/`fire-boundary` are reserved for the overlay.
Selection does not persist scenarios. The existing Vite/Nginx fallback supports
`/maps`; the workspace remains at `/`.

## Imagery and responsiveness

Start over San Francisco at [latitude 37.7749, longitude -122.4194], zoom 11.5.
The public [USGS imagery service](https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer)
can respond slowly or fail, so bundle a georeferenced historical SF city overview
and four broader overview tiles as a local background. Display the cached status
and attribution on the map. `public/map-preview/provenance.json` records original
URLs, retrieval times, actual image bounds, and sizes. Acquisition dates vary;
retrieval time is not observation time. These are USGS/USDA geographic data, not
live incident data or model inputs.

Local images render beneath remote detail; gaps in the remote layer leave the
preview visible within its coverage. Remote requests use the published 256-pixel
tile grid, capped at zoom 16 with overscaling above. Limit concurrent images to
8, retain up to 128 tiles, cancel obsolete zoom requests, and cap canvas pixel
ratio at 2. These are pragmatic resource bounds, not measured performance claims.
Outside the bundled region the remote service is still required. Source errors
remain visible and a user-triggered retry reloads imagery without restarting
simulations. No automatic retry loop is added.

## Renderer lifecycle

MapLibre 6 needs an explicit worker URL when bundled. Import
`maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url` and call `setWorkerUrl` before
creating maps, following the [MapLibre Vite instructions](https://maplibre.org/maplibre-gl-js/docs/).
Default worker discovery points at Vite's optimized dependency directory and
cannot load the GeoJSON worker there. Raster imagery can appear even when that
worker is unavailable, so this is necessary for the fire overlay.

Require WebGL2; handle initialization and source errors. Clean up the map, marker,
resize observer, event listeners, and loading timeout on unmount. Async overlay
error callbacks are ignored after their input changes or the component unmounts.
No paid service, API key, backend API, persistence, or deployment changes are
introduced.
