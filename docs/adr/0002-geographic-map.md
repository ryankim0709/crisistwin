# 0002: Reusable geographic map

Date: 2026-10-23. Status: accepted.

Use Leaflet 1.9.4 for a plain 2D geographic map with OpenStreetMap raster tiles.
Keep `MapCanvas` separate from its minimal `/maps` page so future simulation UI
can supply a center, zoom, and location-selection callback. The default view is
California; the map has no region bounds, imported overlays, or demo locations.

`center` and `onLocationSelect` use named `latitude` and `longitude` fields in
WGS84 decimal degrees. The callback normalizes longitude to [-180, 180]. It
reports only user intent; it does not compute simulation results or persist
scenario state. Changing center or zoom recreates the map and clears its marker.
Map effects clean up the Leaflet instance, resize observer, and tile timeout on
unmount, including React Strict Mode's development lifecycle.

The tradeoff is network-dependent background geography and no vector road graph
for simulation. The component reports unavailable tiles. Visible attribution,
normal browser caching/referrers, and viewport-only tile requests follow the
[OSM tile policy](https://operations.osmfoundation.org/policies/tiles/). Revisit
the provider before larger deployment. No paid service, API key, backend API,
or persistence changes are introduced.

The existing Vite/Nginx fallback supports `/maps`; a pathname switch keeps the
workspace at `/` without adding a routing dependency. This deliberately limits
the feature to a reusable map component rather than a scenario dashboard.
