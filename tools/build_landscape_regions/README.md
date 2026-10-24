# Prebuilt landscape regions

Builds the Southern California regions in `app/src/fire/regions.ts` (`SOCAL_REGIONS`)
into landscape packages (format in `docs/adr/0013-prebuilt-socal-landscapes.md`) and
uploads them to MongoDB GridFS bucket `landscape_packages` for `GET /api/landscapes`.

The builder runs the page's own loader (`app/src/fire/landscape.ts`) and encoder
(`app/src/fire/landscapePackage.ts`), bundled for Node with the app's esbuild. It calls
`loadLandscape` with `endpoints` pointing at the upstream LANDFIRE WCS
(`LANDFIRE_UPSTREAM_WCS_URL`) and terrain tiles, the app User-Agent, and the fetch in
`politeFetch.mts`: at most 4 concurrent requests per host, retries of network errors,
5xx and 429 up to 3 attempts with backoff, a 90 s timeout and one SIGINT abort signal.

## Build (needs Node 22 and `npm ci` in `app/`)

```sh
node tools/build_landscape_regions/run.mjs                                  # all regions
node tools/build_landscape_regions/run.mjs --region santa-monica-mountains  # one (repeatable)
node tools/build_landscape_regions/run.mjs --jobs 2                         # two regions at once (max 2)
```

Writes `data/landscapes/<regionId>/<sha256>.ctls.gz` and updates
`data/landscapes/manifest.json` (git-ignored; packages live in MongoDB, not Git). Ctrl-C
aborts in-flight requests; a region that fails is reported and the rest continue.
`--radius <m>` and `--cell-meters <m>` override the catalogue for smoke tests; use them
with `--out <scratch dir>` so the real manifest only holds catalogue builds.

## Upload (needs `pip install -r tools/requirements.txt`)

```sh
python3 -m tools.build_landscape_regions upload --dry-run  # what would upload
python3 -m tools.build_landscape_regions upload            # upload missing packages
python3 -m tools.build_landscape_regions list              # newest stored package per region
```

`MONGODB_URI` comes from the environment, then `~/.mongodb_uri`, then `app/.env`
(`MONGODB_DB` defaults to `crisistwin`). It is never printed. Upload checks every file
against its manifest SHA-256, skips packages already stored (filename = SHA-256, so it
is idempotent) and ensures the `{metadata.regionId: 1, metadata.builtAt: -1}` index.
