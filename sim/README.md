# Historical replay simulator (`sim/`)

Python 3.12, standard library only. This code is independent of the web app, HTTP,
and LLMs. It reads a verified incident package (see
[docs/historical-replay.md](../docs/historical-replay.md)) and produces JSON/GeoJSON.
All outputs are planning experiments, not operational fire or evacuation guidance.

| Module | Role |
|---|---|
| `history.py` | Verify a package (`tools.build_camp_history.verify_package`) and load time-sorted perimeters and damage points |
| `geo.py` | Square-cell grid in a local equirectangular projection, polygon rasterization, point-in-polygon, mask export |
| `replay.py` | Observed-data playback: `ReplayClock`, `observed_frame`, `perimeter_events`, `timeline` |
| `fire.py` | Fire-spread model `elliptical-mtt-ca`: minimum travel time (Dijkstra, 16-neighbour stencil) with a wind ellipse |
| `hindcast.py` | Simulate from an observed perimeter, score against later perimeters, calibrate without look-ahead |
| `firefront.py` | Simulated fire front from an assumed ignition, fitted to the first satellite perimeter; 10-minute isochrones |
| `traffic.py` | Evacuation traffic `meso-link-queue`: link queues with capacity, storage and spillback, nearest-exit routing, event-driven closures |
| `network.py` | Load the verified 2018 OSM road package into traffic types; unknown lanes and speeds take named class defaults |
| `scenario.py` | Hybrid scenario: observed roads and exits with fixture demand and orders until zones and events are acquired |
| `fixtures.py` | Fully synthetic network and scenario for development |
| `insights.py` | Responder and evacuee planning insights: zone lead times, roads' modelled fire arrival, bottlenecks |
| `incidents.py` | Incident registry (`camp-2018`, `marshall-2021`, `kincade-2019`, `woolsey-2018`) and the generic package path: verification, perimeters, ignition, clock, crosswalk demand, fitted front, `index.json` |
| `bundle.py` | Assemble the web-app replay bundle ([contract](../docs/replay-bundle.md)) |
| `__main__.py` | CLI |

## Commands

Package `raw/` and `normalized/` files are not in Git; they live in MongoDB Atlas. Before the
first run on a fresh clone, restore them (see
[Incident data in MongoDB Atlas](../README.md#incident-data-in-mongodb-atlas)):

```sh
pip install -r tools/requirements.txt   # pymongo, needed only for this step
export MONGODB_URI='mongodb+srv://...'  # from a teammate; never commit it
python3 -m tools.mongo_data pull
```

`sim/` itself still reads the local files with the standard library only.

Run these from the repository root:

```sh
P=data/incidents/camp-2018-paradise-slice/a6d2cc03f525ed65
python3 -m sim --package $P frame --at 2018-11-09T15:00:00Z --output /tmp/frame.geojson
python3 -m sim --package $P timeline --step-minutes 60 --output /tmp/timeline.json
python3 -m sim --package $P hindcast --spread 2 --wind-from 90 --wind-speed 5 --hours 48 --geometry --output /tmp/hindcast.json
python3 -m sim --package $P calibrate --train-hours 24 --test-hours 48 --output /tmp/calibration.json
python3 -m sim --package $P bundle --roads-package data/incidents/camp-2018-evacuation/b1b318c16bbd3270 \
  --output app/public/replays/camp-2018.json   # web app replay at /replay
```

Every command verifies the package hashes before it reads any data.

## Conventions

- **Coordinates:** GeoJSON OGC:CRS84 (longitude, latitude).
- **Grid:** row 0 is the southern edge, and cell index is `row * ncols + col`.
- **Time:** timestamps are aware UTC, serialized as ISO 8601 with `Z`. The model clock is
  seconds since `t0`, and wall-clock time is never used.
- **Units:** spread rates are in m/min, wind speed in m/s, and `wind_from_deg` is the
  meteorological direction the wind blows from, clockwise from north.
- **Evidence:** every output carries an `evidence_class`. Perimeters keep the package's
  label (FEDS perimeters are `reconstructed` satellite estimates). Model output is
  `simulated`. Damage points are post-fire assessments with no damage time, and are
  never used as arrival evidence.
- **Replay coverage:** replay is retrospective, because source availability is unknown.
  A perimeter applies from its `snapshot_at` until the next snapshot, with no interpolation.
- **Strict JSON:** the CLI writes JSON with `allow_nan=False`.

## Hindcast results on the Camp pilot package (2026-10-23)

The run starts from the first FEDS perimeter (2018-11-08T20:00Z, 165.5 km² rasterized)
on 200 m cells. `calibrate` searches 48 candidates using only the first 24 h. The
chosen parameters are a no-wind spread rate of 2 m/min and wind from 90° at 5 m/s.
On the held-out 24–48 h snapshots, mean IoU is 0.62 for the calibrated model and 0.41
for a no-growth baseline. Counting only area burned beyond the start perimeter, mean
IoU is 0.45.

The calibrated wind is a fitting parameter under uniform fuel and constant wind. It
is not a recovered historical wind; the day-1 wind was from the north-east. See
`ASSUMPTIONS` and `LIMITATIONS` in `hindcast.py` and `replay.py`, which are also
written into every output.

## Evacuation replay (2026-10-23)

`bundle` combines four inputs:
- satellite perimeters (`reconstructed`);
- a simulated fire front for the morning before the first perimeter;
- the 2018 OSM road network (`observed`; lanes and speeds mostly defaulted);
- the traffic model (`simulated`).

The front is fitted to the first perimeter at IoU 0.70, with wind from 67.5° at an
effective head rate of 80 m/min, and it starts from an assumed ignition time and place.
**Demand and evacuation orders are still fixtures**: a 2 km zone grid, a synthetic
total of 15,000 vehicles, and staggered order times. Treat traffic outcomes as a
demonstration of the mechanics until the zones, population, and order events layers
replace them.

On the real network, the run takes about 8 s and writes a 15 MB bundle (1.6 MB gzipped).

## Data source: local files or MongoDB Atlas

Package artifacts (`raw/`, `normalized/`) live in MongoDB Atlas GridFS per
[ADR 0006](../docs/adr/0006-incident-artifacts-in-mongodb.md); manifests stay in Git.
`sim` reads them directly. Every loader calls `sim.store.ensure_package`, which
downloads only the artifacts that are missing or whose SHA-256 differs from the
manifest, hash-checks them, and writes them into the package directory as a cache.
The package's own verifier then checks everything as before.

```sh
pip install -r tools/requirements.txt         # pymongo; only needed when a download is required
export MONGODB_URI='mongodb+srv://...'        # secret: shell only, never commit or log it
python3 -m sim --data-source auto --package ... bundle --roads-package ... --output ...
```

`--data-source` (or `CRISISTWIN_DATA_SOURCE` for `sim.variants`, `sim.optimize`,
`sim.stress_agent`) is `auto` by default: use valid local files, otherwise fetch from
MongoDB. `local` never connects, and `mongo` always reconciles with the manifest.
Bundles record what was fetched in `generated_by.data_sources`.

## Other fires: `--incident` (2026-10-23)

```sh
python3 -m sim --incident marshall-2021 bundle   # -> app/public/replays/marshall-2021.json + index.json
python3 -m sim --incident kincade-2019 bundle
python3 -m sim --incident woolsey-2018 bundle
python3 -m sim --incident camp-2018 bundle       # same as the explicit Camp --package/--roads-package command
```

`--incident` fills in `--package`, `--roads-package` and `--output`, and the explicit flags still
override it. Camp keeps its own path. For Marshall, Kincade and Woolsey, `sim.incidents` takes everything
from the evacuation package:
- perimeters from `fire_perimeters.geojson`;
- the ignition from the `fire_ignition` event. Kincade's place is fitted among the cells of the
  earliest FIRMS pass; Woolsey's is the CAL FIRE point published in `normalized/incident.json`;
  Marshall's ignitions come from its evidence file (below);
- the clock: the manifest focus window, starting 1 h before the hour of ignition;
- the timezone from the manifest (its leading IANA name);
- demand from `population_units` and `zone_population_crosswalk.json`, with orders and warnings
  targeting zones by their own IDs.

If the package crosswalk has no rows for a zone named by an order (Kincade's Geyserville CDP), its
block-group shares are derived here by 100 m raster overlap; `demand.crosswalk_derived_here` records this.
Orders without zone IDs stay on the timeline only (`demand.orders_without_zone_ids`).

A registry entry may name a curated evidence file in `sim/evidence/` (the packages are
content-addressed, so additions cannot go inside them). `sim/evidence/marshall_2021.json` holds, with
sources, locators and short quotes: the two documented ignitions; timed fire reports from the AAR,
the Facilitated Learning Analysis and Colorado Sun dispatch recordings, geocoded from OSM names;
the town-wide Superior order (12:58 MST) and the Louisville city-wide order (14:24 MST); and a split
of Everbridge zone 9 at the 2020 Louisville city limit. Warnings release no demand.

Marshall's front is `elliptical-mtt-ca` fitted to those reported arrival times and to the final
FEDS perimeter's shape, then clipped to that perimeter (`timed_package_fire`). Kincade's is fitted
only to the first perimeter and clipped to it. Neither package has terrain or fuel layers. The model settings chosen per fire are in the
registry (Kincade: 30 s step and 5 min frames over a multi-day clock). Validation rows are
`not_computed` for now. `simulate --incident` supports only Camp, and `sim.variants` still takes
explicit Camp packages.

The full offline verifier runs once per package manifest. The result is cached in
`~/.cache/crisistwin/verified/`, and the Kincade rebuild alone takes about 2 min. Later runs
re-check every artifact hash.
