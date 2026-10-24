# Historical replay work in progress — 2026-10-23

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
  the app scaffold. No commit or PR has been made for this data work.
- During final review, the shared checkout had switched to
  `feat/historical-replay-sim` and the data-work files were staged by another
  process/teammate; this agent did not switch branches or stage them. The later
  handoff updates and one README wording fix remained unstaged. Check both
  `git diff --cached` and `git diff` before committing, and coordinate ownership.

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
   with the current package. Review the final tree/diff before any commit or PR.
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
