# Replay bundles

Generated, not committed. The replay view at `/replay` loads `camp-2018.json`.
Build it from the repository root (Python 3.12, about 10 s):

```sh
python3 -m sim --package data/incidents/camp-2018-paradise-slice/a6d2cc03f525ed65 bundle \
  --roads-package data/incidents/camp-2018-evacuation/b2624d1cda93d9e5 \
  --output app/public/replays/camp-2018.json
```

The format is in [docs/replay-bundle.md](../../../docs/replay-bundle.md). Roads come from
2018 OpenStreetMap. Demand zones, vehicle counts, and evacuation orders are fixtures
until the historical layers are acquired.
