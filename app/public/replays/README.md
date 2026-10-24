# Replay bundles

Generated, not committed. Fetch the team's copies (bundles, variants, mobility sidecars) from
MongoDB Atlas with `python3 -m tools.mongo_data pull`; after regenerating any file, run
`python3 -m tools.mongo_data record`, `push`, and commit `app/data-manifest.json`.
`python3 -m tools.mongo_data status` shows whether your copies match the committed manifest.
The replay view at `/replay` loads `camp-2018.json`.
Build it from the repository root (Python 3.12, about 10 s):

```sh
python3 -m sim --package data/incidents/camp-2018-paradise-slice/a6d2cc03f525ed65 bundle \
  --roads-package data/incidents/camp-2018-evacuation/b1b318c16bbd3270 \
  --output app/public/replays/camp-2018.json
```

The format is in [docs/replay-bundle.md](../../../docs/replay-bundle.md). Roads come from
2018 OpenStreetMap. Demand zones, vehicle counts, and evacuation orders are fixtures
until the historical layers are acquired.
