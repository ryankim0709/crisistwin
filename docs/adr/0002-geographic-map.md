# 0002: Reusable imagery map

Date: 2026-10-23. Status: accepted.

Use MapLibre GL JS 6 for the reusable `MapCanvas` component and a minimal `/maps`
page. It replaces the initial Leaflet implementation at the user's request.
USGS The National Map imagery replaces the street basemap, providing a simple
landscape view for future fire simulation overlays. No terrain elevation model
or fire model is added; photographic relief is not a computed 3D surface.

Keep the `center`, `zoom`, and `onLocationSelect` props; add an optional `mapStyle`
(MapLibre style object or URL) so coverage and providers are configurable.
`center` and selection callbacks use named WGS84 `latitude`/`longitude` fields;
convert to MapLibre's [longitude, latitude] order at the rendering boundary.
Selection callbacks normalize longitude to [-180, 180). Changing center, zoom,
or style recreates the map and clears its marker. Parent callers should keep
object props stable. Selection does not persist or start a simulation.

The default is a Sierra Nevada view using
[USGS Imagery Only](https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer).
This service includes historical aerial imagery, primarily for the US, with
coarser satellite imagery at small scales. Native imagery tiles stop at zoom 16;
closer views overscale the existing imagery. Attribution remains visible. This
is background geography, not current incident data or a routable road network.

MapLibre requires WebGL2 and the tile service requires internet access. Report
initialization and imagery failures, and clean up the map, marker, resize
observer, event listeners, and timeout on unmount. No paid service, API key,
backend API, persistence, or deployment changes are introduced.

The existing Vite/Nginx fallback supports `/maps`; the workspace remains at `/`.
See the [MapLibre satellite example](https://maplibre.org/maplibre-gl-js/docs/examples/display-a-satellite-map/)
for the raster-source rendering approach.
