# 0013: Prebuilt Southern California landscapes in MongoDB

Date: 2026-10-24. Status: accepted for the demo.

The `/fire` diorama focuses on Southern California's vegetated wildland-urban interface
(Los Angeles, Riverside, San Bernardino, San Diego, Orange and Ventura counties). Large
boards need tens of LANDFIRE/terrain requests each, so regions are built once offline and
stored in the team's MongoDB Atlas `crisistwin` database; the page pulls a stored region
instead of rebuilding it. Live per-area fetching (ADR 0011) stays available for custom
areas. The model (ADRs 0003–0009, 0012) is unchanged; a stored region is exactly the
`LandscapeGrid` the live loader would have produced at that cell size, plus provenance.

## Catalogue

`app/src/fire/regions.ts` (`SOCAL_REGIONS`) lists region id, name, counties, centre,
radius and cell size. Regions frame vegetated ranges and their foothill neighbourhoods;
they are presentation choices, not risk designations.

## Package format (`app/src/fire/landscapePackage.ts`)

A gzip-compressed binary: ASCII magic `CTLS1\n`, little-endian u32 header length, a UTF-8
JSON header, zero padding to an 8-byte boundary, then raw little-endian typed-array
sections. Header fields: `format: "crisistwin-landscape"`, `version: 1`, `regionId`,
`builtAt` (UTC ISO), grid lattice (`width`, `height`, `originX`, `originY`, `cellSizeX`,
`cellSizeY`, `groundCellSizeMeters`, `cellMeters`, `resampling`), `elevationComplete`,
`canopyComplete`, `attribution` (fuel/terrain/canopy strings), `sources` (service URLs,
coverage ids, retrieval time), `sections` (`name`, `dtype`, `byteOffset` from the start
of the section block, `byteLength`) and `payloadSha256` over the section block. Sections:
`fuelCodes` int16, `elevationMeters`, `canopyBaseHeightMeters`, `canopyBulkDensityKgPerM3`,
`canopyCoverFraction`, `canopyHeightMeters` float32. Each section starts on an 8-byte boundary
within the block (zero padding between sections is covered by the checksum). Slope and aspect are recomputed on
decode with the live loader's `slopeAndAspect`, so they cannot drift from it. Decoders
reject unknown versions, size mismatches and checksum failures.

## Storage and API

GridFS bucket `landscape_packages`; `filename` is the SHA-256 of the gzip bytes
(content-addressed, like `incident_artifacts`). `metadata` holds `regionId`, `builtAt`
(BSON UTC datetime), `formatVersion`, `bytes`, the catalogue fields `name`, `counties`,
`summary`, `center {latitude, longitude}`, `radiusMeters`, and `lattice { width, height,
cellMeters, groundCellSizeMeters, originX, originY, cellSizeX, cellSizeY, resampling }`,
plus `elevationComplete`, `canopyComplete` and `sources`; the API lists regions from
metadata alone. The newest `builtAt` per `regionId` wins; the uploader creates the index
`{metadata.regionId: 1, metadata.builtAt: -1}` on `landscape_packages.files`.

- `GET /api/landscapes` → `{ "regions": [{ id, name, counties, summary, center, radiusMeters,
  cellMeters, width, height, builtAt, bytes, sha256 }] }` for stored regions.
- `GET /api/landscapes/<region_id>` → the gzip package bytes, `Content-Type:
  application/gzip` (no `Content-Encoding`, the page decompresses), `ETag` = sha256,
  `Cache-Control: public, max-age=3600`. 404 for unknown/unbuilt regions, 503 when
  MongoDB is unavailable.

Both endpoints are public and read-only (`AllowAny`, GET only): the data are public
LANDFIRE/USGS products, no user data is stored. Writes happen only through the offline
tool with the operator's `MONGODB_URI`; the server never writes.

## Build tool

`tools/build_landscape_regions` builds packages with the same TypeScript loader the page
uses (bundled for Node), writes them under an ignored local directory with a manifest,
and uploads missing packages to GridFS. It requires `MONGODB_URI` for upload only
(environment, then `~/.mongodb_uri`, then `app/.env`). Usage is in
`tools/build_landscape_regions/README.md`.
