# tools/

Offline data-acquisition, packaging and sync scripts. Run everything from the repository
root as modules (`python3.12 -m tools.<module>`); do not move files, because modules import
each other as `tools.<module>`. Most scripts use only the Python standard library and `curl`;
only `mongo_data` and `build_landscape_regions upload` need `pip install -r tools/requirements.txt`
(PyMongo). Each script's module docstring and `--help` are the authority on its flags.

Incident packages are immutable directories under `data/incidents/<incident>/<version>/`.
Their `manifest.json` stays in Git; `raw/`, `normalized/` and `derived/` live in MongoDB Atlas
(see `mongo_data`). `--verify-package PATH` on a builder rebuilds the normalized layers from the
packaged raw bytes offline and compares them.

## Script groups

| Group | Files | Purpose |
| ----- | ----- | ------- |
| Camp Fire (2018) | `build_camp_history.py`, `replay_camp_history.py`, `build_camp_evacuation.py`, `add_camp_road_events.py`, `add_camp_codedred.py`, `camp_add_layers.py`, `camp_extracts.py`, `camp_terrain.py` | Paradise damage + perimeter package, pre-fire OSM roads, NIST road events and CodeRED alerts, then zones, events, population, shelters, calibration targets, FIRMS and terrain. Each step builds a child package of the previous one. `replay_camp_history` exports one perimeter frame as GeoJSON. |
| Kincade Fire (2019) | `kincade_build.py` (entry point), `kincade_common.py`, `kincade_events.py`, `kincade_fire.py`, `kincade_population.py`, `kincade_roads.py`, `kincade_traffic.py`, `kincade_zones.py` | Evacuation package: `fetch`, `build`, or `--verify-package`. |
| Marshall Fire (2021) | `marshall_build.py` (entry point), `marshall_extract.py`, `marshall_geopdf.py` | Evacuation package from OSM, FEDS, CDOT counts, Census/FIRMS subsets and the county GeoPDF launch areas. |
| Woolsey Fire (2018) | `woolsey_build.py` | Evacuation package: `fetch-osm`, `fetch-feds`, `extract-firms`, `extract-acs`, `build`, or `--verify-package`. |
| Mongo sync | `mongo_data.py` | `push`, `pull`, `record`, `status` for incident-package artifacts and generated app data (`app/data-manifest.json`). Needs `MONGODB_URI`. |
| Mobility sidecars | `dewey_mobility.py` | Aggregates licensed Advan parquet subsets into `app/public/replays/<id>.mobility.json` (needs `pyarrow`; licensed data is never committed). Format: [docs/mobility-sidecar.md](../docs/mobility-sidecar.md). |
| Landscape regions | `build_landscape_regions/` | Node builder + Python uploader for prebuilt California fire landscapes. See its [README](build_landscape_regions/README.md). |

## Data tables (`*.json` at this level)

The `camp_*_table.json`, `kincade_*.json`, `marshall_*_table.json` and `woolsey_*.json` files are
**inputs**, not outputs: hand-curated transcriptions of official reports and tables, read by the
matching build script (and by `tests/`). Do not delete or regenerate them.

## Commands

```sh
# Sync large incident artifacts and generated app data (Atlas)
pip install -r tools/requirements.txt
export MONGODB_URI='mongodb+srv://...'      # never commit
python3 -m tools.mongo_data pull | push | record | status

# Camp Fire history package: verify offline, or re-acquire (network)
python3.12 -m tools.build_camp_history --verify-package data/incidents/camp-2018-paradise-slice/a6d2cc03f525ed65
python3.12 -m tools.build_camp_history --output-root data/incidents
python3.12 -m tools.replay_camp_history --package data/incidents/camp-2018-paradise-slice/a6d2cc03f525ed65 \
  --at 2018-11-09T15:00:00Z --output /tmp/camp-frame.geojson

# Other incidents (inputs directory lives outside the repository)
python3.12 -m tools.kincade_build fetch --sources DIR
python3.12 -m tools.kincade_build build --sources DIR
python3.12 -m tools.kincade_build --verify-package PATH
python3.12 -m tools.woolsey_build fetch-osm --inputs DIR      # then fetch-feds, extract-*, build
python3.12 -m tools.marshall_build --stage DIR                # or --verify-package PATH

# Landscapes
node tools/build_landscape_regions/run.mjs && python3 -m tools.build_landscape_regions upload
```

Package unit tests for these builders are in `tests/` at the repository root.
