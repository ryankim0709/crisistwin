# Historical replay work in progress — 2026-10-23

## Current acquisition task (2026-10-23)

The user clarified that this phase is **data acquisition**, not app integration or
replay UI work. The current detailed contract is
`/private/tmp/claude-501/-Users-kangheecho-PycharmProjects-crisistwin/51554362-cbb5-4106-bf05-8c335b902d4a/scratchpad/data-acquisition-prompt.md`.
It calls for a new `camp-2018-evacuation` package with historical roads,
timestamped fire/evacuation/road events, zones, population, traffic, shelters,
and documented missing layers. Do not edit `sim/` or `app/`; another session owns
them. Existing immutable package `camp-2018-paradise-slice/a6d2cc03f525ed65`
must not be modified in place.

Source discovery so far: NIST's public [fire-observation spreadsheet](https://data.nist.gov/od/id/mds2-2954)
was downloaded to `/private/tmp/nist-camp-fire-observations.xlsx` (438,645 bytes,
SHA-256 `14fac49ca633d4c944fcb2ba2b22e95ea8751b8d0dd58216a836d2b6e89268a3`).
It has 2,839 populated geolocated rows across 15 corridor sheets but only 2,282
unique complete rows; corridor sheets repeat observations. Fields include source,
date, time, observation window minutes, latitude, longitude, source/method, fire
description and fire type. The stored Excel date serials are `44508` and `44509`
(2021-11-08/09), despite the NIST publication clearly documenting the 2018 Camp
Fire. Preserve raw values; a normalized date correction must cite the report and
be marked derived. Some text may contain specific residential locations, so do
not commit raw text without privacy review.

NIST [TN 2252 supplement](https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.2252sup.pdf)
contains a geolocated, timestamped NETTRA table with road-block, traffic,
notification and evacuation flags, plus a CodeRED message table. Its download
was in progress at this update. NIST [TN 2252](https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.2252.pdf)
has per-zone request/notification times (Table 11), roadway traffic progressions
(e.g. Table 19), and closure maps. The [NIST incident page](https://www.nist.gov/programs-projects/wildland-urban-interface-wui-fire-data-collection-parcel-vulnerabilities/nist-1-0)
links the historic Paradise/Upper Ridge zone PDF and redacted radio chronology.
The [NIST ESCAPE page](https://escape.nist.gov/evacuation3AddressingFailuresEgresslearnmore1)
says all five egress arteries closed at least once, with Pentz Road first closed
at about 09:00 local; this is a retrospective summary, not an edge-level closure
log. [Caltrans PeMS](https://dot.ca.gov/programs/traffic-operations/mpr/pems-source)
requires a free account for historical detector data. [NASA FIRMS archive](https://firms.modaps.eosdis.nasa.gov/download/)
requires Earthdata/email access for 2018 active-fire detections. Neither should
be represented as acquired until access succeeds.

Acquisition attempts: the shell sandbox had no DNS, but approved network access
allowed the NIST spreadsheet download. An Overpass attic query for roads as of
2018-11-08 00:00Z to `overpass-api.de` returned HTTP 406; a second mirror query
at `overpass.kumi.systems` succeeded. The exact 9,702,322-byte OSM response is
in the new road-only package. Keep failed layers explicit instead of substituting
current OSM.

The road-only package is
`data/incidents/camp-2018-evacuation/05575afa537d22c9/`. It contains 9,435
routable OSM junction/end nodes, 21,768 directed edges from 5,291 selected
ways, and 76 geometric boundary exits. Its largest strongly connected component
has 9,061 nodes. It excludes 901 service ways and tagged private/inaccessible
ways, does not infer missing directional lane counts or speeds, and records the
actual geometry extent `[-121.9894704,39.5071452,-121.29823,40.029785]`.
`python3.12 -m tools.build_camp_evacuation --verify-package
data/incidents/camp-2018-evacuation/05575afa537d22c9` passed offline.

| New package layer | Status | Records / time | Spatial coverage | Gap / source terms |
| --- | --- | --- | --- | --- |
| Historical roads | Present | 9,435 nodes; 21,768 directed edges; OSM snapshot 2018-11-08 00:00Z | Requested bbox plus full intersecting ways; actual bbox above | ODbL 1.0; unknown lane/speed tags remain null; no service roads or turn restrictions |
| Timestamped events | Missing | 0 packaged | Camp evacuation area | NIST sources acquired for review; not yet normalized; no license inferred from PDF access |
| Evacuation zones | Missing | 0 packaged | Paradise/Upper Ridge historical map available | 2017 PDF has zone labels, machine-readable polygons unverified; NIST open license check pending |
| Population units | Missing | 0 packaged | Butte County target | ACS 2018 aggregate API identified; extraction pending; public federal data |
| Traffic observations | Missing | 0 packaged | Egress corridors target | PeMS historical detector access needs free account; no zero traffic inference |
| Calibration targets | Missing | 0 packaged | Camp Fire target | NIST quantitative tables under review |
| Shelters / refuge areas | Missing | 0 packaged | Camp Fire target | NIST Appendix I lists TRAs; actual operating times/capacities need review |
| Morning fire progression | Missing | 0 packaged | Camp Fire target | NIST 2,282 unique fire observations downloaded for review; FIRMS archive requires access; FEDS half-day perimeters exist in separate package |
| Post-event displacement | Missing | 0 packaged | Butte County target | Lower priority; no sourced records yet |

NIST NETTRA supplement completed download to
`/private/tmp/nist-camp-nettra-supplement.pdf` (24,237,169 bytes, 306 pages).
It contains Table A-2 with geolocated NETTRA observations and Table D-1 with 28
CodeRED message rows. The latter gives initial send times, message type, zone
labels, and some re-call times. This is **alert-sent** evidence, not proof of
delivery to or departure by all residents and not necessarily the original
evacuation-order issuance time. The 2017 Paradise/Upper Ridge zone map is at
https://www.nist.gov/document/paradise-ur-map and is useful for zone name
matching, but polygons have not yet been acquired. The PDF contains individual
911 observations and addresses, so do not copy it into the public incident
package wholesale. Use curated, non-identifying event extracts with source
page/table references and keep the complete PDF outside the repo.

This file preserves the active task state. The user asked to continue turning the
historical replay format into working acquisition and replay tooling and to keep
this context file updated. Read and update it at major milestones.

## Repository and concurrent work

- At the start of this turn, the repository had only the earlier replay design docs
  as uncommitted work. A teammate subsequently added and committed an app scaffold
  on the shared `main` checkout: `app/` uses React/Vite and Django/PostgreSQL. Read
  current `AGENTS.md`, `README.md`, and `docs/adr/0001-app-scaffold.md` before edits.
- Preserve the app scaffold and all other teammates' files. Current task files are
  `tools/build_camp_history.py`, `tools/replay_camp_history.py`,
  `tests/test_camp_history.py`, the incident data
  package, `docs/historical-replay.md`, `docs/adr/0002-historical-incident-packages.md`,
  and the historical-data section of `README.md`.
- `docs/adr/0002-historical-incident-packages.md` is proposed; ADR 0001 belongs to
  the app scaffold. The work was committed as `0af70fe` on
  `feat/historical-replay-sim`; no PR or merge was observed at this update.
- During final review, the shared checkout had switched to
  `feat/historical-replay-sim` and the data-work files were staged by another
  process/teammate; this agent did not switch branches or stage them. The staged
  and final unstaged updates were subsequently committed in `0af70fe`. Coordinate
  ownership before further shared-checkout edits.

## Completed and checked

- Built a CAL FIRE DINS acquisition tool with fixed official ArcGIS endpoint,
  incident name `Camp`, incident number `CABTU 016737`, query box
  `[-121.64,39.73,-121.63,39.74]` in longitude/latitude, and limited fields that
  exclude addresses and parcel numbers. It fetches metadata, an ID list, and
  bounded batches; validates the response; retains raw JSON; normalizes points to
  GeoJSON; and makes a manifest with SHA-256 hashes. It uses stdlib Python and curl.
- The public source returned 290 records. Six point coordinates lie slightly outside
  the requested query box; the package preserves them and records actual bounds.
  This slice has 205 single residences and 85 minor structures; it has no DINS
  records categorized as infrastructure. It cannot describe bridge/road damage.
- The current package is
  `data/incidents/camp-2018-paradise-slice/a6d2cc03f525ed65/`. Its offline verifier
  rebuilt both normalized layers from raw responses and passed. The CAL FIRE source
  field `INCIDENTSTARTDATE` is stored as a date, never as an ignition timestamp.
- Eight focused `unittest` cases passed on Python 3.12 after the FEDS extension.
  A retrospective replay command produced a frame for 2018-11-09 15:00Z from the
  08:00Z snapshot, with its age available in `replay.snapshot_age_seconds`.
- The earlier format proposal is in `docs/historical-replay.md`; it proposes
  GeoParquet/Parquet for larger production packages and explicit evidence time vs
  availability time. The small DINS pilot uses GeoJSON.

## Source findings and current state

- NASA VEDA's official FEDS OGC API has a Camp Fire perimeter series:
  `https://openveda.cloud/api/features/collections/public.eis_fire_lf_perimeter_archive/items`
  with `filter=fireid = 'F17028'`,
  `datetime=2018-11-01T00:00:00Z/2018-12-01T00:00:00Z`, `limit=100`.
  A successful call returned 45 GeoJSON cumulative perimeter features (about 2 MB).
  The unbounded fire ID request returned 110 matched features extending into 2019,
  so **the date filter is essential**. The official tutorial says `t` is local time
  corrected to noon/midnight, with about 12-hour nominal cadence:
  https://docs.openveda.cloud/user-guide/notebooks/tutorials/mapping-fires.html
- The filtered 2018 series runs from 2018-11-08 12:00 local to 2018-11-30 12:00
  local. Its first snapshots continue at 2018-11-09 00:00 and 12:00 local, then
  2018-11-10 00:00 and 12:00. A previous note about a five-day gap was incorrect:
  it came from looking at the first returned records of the **unbounded** mixed-year
  query. The filtered records must be sorted by `t` before coverage analysis.
  FEDS is still only nominally half-daily and satellite-derived; NIST is needed
  for finer first-day reconstruction.
- The FEDS acquisition and normalization are wired into
  `tools/build_camp_history.py`. It fetched 45 consecutive half-day snapshots,
  beginning 2018-11-08 20:00Z and ending 2018-11-30 20:00Z; maximum gap is 12 hours.
  It retains source geometry and local time with a derived UTC timestamp. The
  package manifest labels source availability unknown, so replay is retrospective.
- A source response is also saved in `/private/tmp/crisistwin-camp-feds-response.json`
  (filtered 45-feature response). The unbounded exploratory response is in
  `/private/tmp/crisistwin-camp-feds-all.json`; **do not use that for the incident**.
- The tool was renamed from `tools/ingest_camp_dins.py` to
  `tools/build_camp_history.py`. The old DINS-only generated package was removed
  after the new two-source package passed offline verification. The retrospective
  frame selector is `tools/replay_camp_history.py` and is invoked as a module.
- The FEDS source license was not shown on the VEDA collection endpoint. Zenodo's
  official API lists the **newer** FEDS CONUS archive under CC BY 4.0, but that is
  a different release. The original California FEDS Figshare Largefire dataset
  lists CC0 at https://springernature.figshare.com/articles/dataset/Largefire_tar_gz/19170071,
  but that is also not proven identical to the VEDA API collection. The VEDA
  reuse terms remain recorded as unknown. The manifest labels the newer archive
  as related, not the identical source.

## Next steps

1. Check the FEDS collection's reuse terms if possible; its API metadata does not
   state a license. The current manifest states this explicitly and cites the API,
   tutorial, and newer archive. Keep source attribution in any demo.
2. The manifest/verifier now record and check the maximum 12-hour snapshot gap.
   The current package is about 4.2 MB including original and normalized geometry.
   Review whether this footprint is appropriate for the demo repository.
3. README commands, Python 3.12 tests (8 pass), offline package verification,
   frame CLI, `git diff --check`, and Markdown local-link/whitespace checks passed
   with the current package. Review the branch diff against `main` before any PR.
   The shared README says pre-commit is the default hackathon check, while
   `AGENTS.md` also calls for focused tests and exact verification results.
4. Future work: acquire historical road geometry, evacuation/closure events, and
   traffic, then connect the package to the app. NIST's Camp reconstruction can
   refine the early fire timeline beyond FEDS's half-day cadence. Keep post-fire
   damage separate from time-progressing fire observations.

## Practical source commands and facts

- The CAL FIRE endpoint is
  `https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/arcgis/rest/services/POSTFIRE_MASTER_DATA_SHARE/FeatureServer/0`.
- The VEDA API can be fetched with curl `--http1.1 --get --data-urlencode`; the
  initial filtered request succeeded. An exploratory full response timed out on
  one retry before succeeding. Use bounded retries and timeouts.
- Python's `urllib` in the shell failed TLS verification against the environment;
  curl succeeded with its system trust store. The adapter invokes curl without a
  shell and with fixed endpoints. Do not disable certificate verification.
