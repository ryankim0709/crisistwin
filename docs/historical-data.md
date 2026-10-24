# Historical incident data

Moved from the root README.

## Incident data in MongoDB Atlas

Large incident-package files (`raw/` and `normalized/`) are not stored in Git.
Each package's `manifest.json` stays in Git and lists every artifact with its SHA-256;
the bytes live in MongoDB Atlas (GridFS, deduplicated by hash). After cloning:

```sh
pip install -r tools/requirements.txt
export MONGODB_URI='mongodb+srv://...'   # ask a teammate; never commit it
python3 -m tools.mongo_data pull         # restores data/incidents/*/*/{raw,normalized}
```

After building a new package locally, run `python3 -m tools.mongo_data push` and commit its manifest.
`python3 -m tools.mongo_data status` reports local app data (replay bundles, variants, simulations)
that differs from the committed `app/data-manifest.json`, and with `MONGODB_URI` set, any listed
artifact missing from Atlas. If it reports drift after you pulled, the author has not yet run `record`, `push` and committed the manifest.

Prebuilt California fire landscapes from the San Francisco Bay Area to San Diego (ADR 0013) are built and uploaded with
[`tools/build_landscape_regions`](../tools/build_landscape_regions/README.md):
`node tools/build_landscape_regions/run.mjs` then
`python3 -m tools.build_landscape_regions upload`.

[Historical incident packages](historical-replay.md) proposes source acquisition,
data formats, provenance, timing, and offline replay semantics for historical wildfire
scenarios. [The historical package decision](adr/0005-historical-incident-packages.md)
records the proposed tradeoffs. The first [Camp Fire incident package](../data/incidents/camp-2018-paradise-slice/a6d2cc03f525ed65/manifest.json)
contains 290 public structure assessments in a bounded Paradise area from
[CAL FIRE DINS](https://publish.data.ca.gov/dataset/cal-fire-damage-inspection-dins-data)
and 45 historical satellite-derived fire perimeters from
[NASA VEDA FEDS](https://docs.openveda.cloud/user-guide/notebooks/tutorials/mapping-fires.html).
It includes original API responses, normalized GeoJSON, attribution, and checksums.
The damage data describe post-fire outcomes, not building ignition times. The
perimeters are half-day estimates, not exact fire arrival times. A small offline
replay tool selects the latest observed perimeter and reports its age. Road
closures, traffic, and population movement have not been added to this package.

The collector uses the Python standard library and curl; it adds no dependency to
the app's Python lockfile. From the repository root, with Python 3.12 and curl:

```sh
python3.12 -m tools.build_camp_history --verify-package data/incidents/camp-2018-paradise-slice/a6d2cc03f525ed65
python3.12 -m tools.replay_camp_history --package data/incidents/camp-2018-paradise-slice/a6d2cc03f525ed65 --at 2018-11-09T15:00:00Z --output /tmp/camp-frame.geojson
```

To reacquire these sources, run `python3.12 -m tools.build_camp_history --output-root data/incidents`
with internet access. The queries fix the incident, date window, box, and selected
fields and do not collect addresses or parcel numbers. Six DINS records lie
slightly outside the requested box; the manifest records the actual extent. The
replay command writes a GeoJSON frame for viewing or testing and makes no claim
about information availability to responders at that historical time.

## Camp Fire ground record (911, radio, rescue)

[`tools/camp_ground_record.json`](../tools/camp_ground_record.json) is a de-identified,
time-stamped record of what callers and responders reported on 8 November 2018. The `/live`
drill console replays it (`app/backend/api/live/groundrecord.py`). It comes from
[NIST TN 2252sup](https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.2252sup.pdf)
and [NIST TN 2252](https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.2252.pdf). Both
are US government works. It has four parts:

- Table A-2 rows whose Info. Source is a 911 call or the Radio Log: 356 items (93 from 911,
  263 from radio), `evidence_class: "reported"`.
- Table K-1 evacuation-assistance and rescue events: 196 items.
- Main-report Table 10 (notification timeline): 35 items.
- Main-report Table 13 (Paradise evacuation timeline): 18 items.

Items from K-1, Table 10 and Table 13 are `"reconstructed"`. Times are UTC: the source
gives Pacific Standard Time, and the builder adds 8 hours. Points are `[lon, lat]`, rounded
to 3 decimals (about 100 m).

The record keeps no source free text. The `summary` field is a template built from the
channel, category and road name, for example "911 call: trapped by fire, Pentz Road". The
category comes from keyword rules in the builder. `road_name` is limited to the
builder's `MAIN_ROADS` list: main roads, arterials, three collectors and the state highways.
Any other road becomes null. A row that names a residential street has its point rounded to
2 decimals (about 1 km). `text_sha12`, a SHA-256 prefix, is used
only to merge the same quote when NIST lists it at several places. A merged quote has no
point.

NIST transcribed these rows afterwards from a sample of the recordings. They are not a CAD
export and not a complete call log. To rebuild, see [tools/README.md](../tools/README.md).
