# Historical incident packages

Status: proposed target format and acquisition plan, researched 2026-10-23.
One bounded Camp Fire package with CAL FIRE and NASA VEDA sources is implemented.
A retrospective perimeter-frame selector exists; the general replay engine and
application integration are not implemented. The application scaffold is described
in the repository README.

## Objective and fidelity

Package one historical incident so it can be replayed offline, used to evaluate a
simulator, and forked into reproducible counterfactual scenarios. Preserve original
evidence, its uncertainty, and every transformation. Smooth animation is a display
choice, not evidence of second-by-second historical accuracy.

Use Kincade 2019 to pilot traffic calibration and Camp Fire 2018 to pilot detailed
fire/closure reconstruction. They are separate incident packages. Never combine
their observations into one purported historical event. Incident selection remains
conditional on actual coverage and access checks.

## Package layout and formats

```text
<incident-id>/<immutable-package-version>/
  manifest.json
  sources.json
  raw/                         # original downloaded bytes and metadata
  normalized/
    road_nodes.parquet         # GeoParquet points
    road_edges.parquet         # GeoParquet directed edges
    buildings.parquet          # GeoParquet points or footprints, explicitly typed
    shelters.parquet           # GeoParquet; historical existence/capacity provenance
    fire_perimeters.parquet    # GeoParquet snapshots, preserving holes/components
    fire_detections.parquet     # GeoParquet observations
    evacuation_zones.parquet   # GeoParquet versioned polygons
    traffic_observations.parquet
    highway_trips.parquet      # sampled endpoints, not full trajectories
    damage_assessments.parquet
    events.jsonl               # discrete evidence assertions, one JSON object/line
    rasters/                   # GeoTIFF terrain/fuels/weather if acquired
  derived/
    entity_links.parquet      # source IDs -> local entities; matching evidence
    timeline.jsonl            # policy-resolved replay actions referencing evidence
    checkpoints/              # optional generated replay-state caches
  quality.json                 # coverage, unresolved records and validation results
```

Files are optional by layer; the manifest explicitly declares `present`, `missing`,
`not_applicable`, or `access_blocked` and why. An empty file must not imply complete
coverage with zero events. This layout is a proposal, not a list of acquired data.

- Use GeoParquet 1.1.0 with WKB geometry and explicit CRS metadata for vector
  archives; ordinary Parquet for typed measurements. This keeps detailed geometry
  separate from rendering and supports time/entity filtering. See the
  [GeoParquet specification](https://geoparquet.org/releases/v1.1.0/).
- Use JSON for manifests and JSONL for modest discrete event streams. Keep large
  geometry in referenced tables rather than repeating it in every event.
- Export time/window-filtered GeoJSON for the browser. GeoJSON uses WGS84
  longitude, latitude; see [RFC 7946](https://www.rfc-editor.org/info/rfc7946/).
  GeoJSON is a derived delivery format, not the only archival representation.
- Preserve native raster resolution, nodata, units, CRS and acquisition date.
  Do not convert terrain/fuel rasters into millions of JSON points.
- Preserve unsimplified canonical geometry. Any display simplification records
  its tolerance, units, algorithm and parent hash and never enters calculations.

No database or stream broker is required for the initial package. A backend can
read these files and serve GeoJSON/JSON; a small demo can pre-export those slices.

The current [Camp pilot package](../data/incidents/camp-2018-paradise-slice/a6d2cc03f525ed65/manifest.json)
uses GeoJSON for its 290 structure points and 45 historical perimeter snapshots;
its tooling needs no third-party Python package. It retains original API responses
and supports offline regeneration/verification. The ArcGIS spatial query returned
six points slightly outside its requested box; both extents are recorded. Its
incident-start field is date-valued, not a building ignition or assessment time.
The FEDS time field is local California time corrected to half-day intervals; the
normalized layer records both local and derived UTC time. GeoParquet and the
broader replay contract remain proposed.

### Camp evacuation acquisition package

The separate [Camp evacuation package](../data/incidents/camp-2018-evacuation/05575afa537d22c9/manifest.json)
starts with a 2018-11-08 00:00Z OpenStreetMap snapshot for the requested
`[-121.90, 39.55, -121.40, 39.95]` bounding box. The source query uses Overpass
attic mode and is frozen in `sources.json` along with the original response.
The graph has 9,435 junction/end nodes and 21,768 directed edges after excluding
901 service ways and inaccessible ways. The largest strongly connected component
has 9,061 nodes. Source ways can extend beyond the query box; the actual node
extent is recorded in `quality.json`. Each missing acquisition layer is declared
`missing` in the manifest rather than represented by an empty file.

For this stdlib-only acquisition phase, normalized vectors are GeoJSON
(OGC:CRS84) and event streams will be JSONL. This is an implemented package
format for the hackathon; the GeoParquet layout above remains a possible later
archive format. The new package is immutable: adding events creates another
version and retains this road-only version.

Road fields are in each feature's `properties`:

| File | Fields and meaning |
| --- | --- |
| `normalized/road_nodes.geojson` | `node_id` (`osm-node:<id>`), `osm_node_id`, point geometry, source and evidence class |
| `normalized/road_edges.geojson` | `edge_id`, `from_node`, `to_node`, `osm_way_id`, `name`, `ref`, `highway`, `oneway`, `lanes`, `lanes_status`, `maxspeed_kph`, `maxspeed_status`, `length_m`, `bridge`, `tunnel`, source and evidence class; LineString follows travel direction |
| `normalized/exit_nodes.json` | Geometric query-boundary exits, with node ID, cardinal boundary, source road name/ref and null destination name |

`lanes` is directional. It is populated only from a directional lane tag, or
from the total lane tag of a one-way road. An undirected `lanes=2` on a two-way
road is **not** copied to both edges. `maxspeed_kph` is converted from an
explicit `mph` tag or read as km/h from an unqualified numeric OSM tag. Unknown
values are null. Way segments split at shared OSM nodes and way endpoints; OSM
turn restrictions, conditional access and lane-level controls are not modeled.

Representative node and edge shapes (IDs and coordinates are illustrative; see
the package for actual values):

```json
{"type":"Feature","id":"osm-node:123","geometry":{"type":"Point","coordinates":[-121.6,39.75]},"properties":{"node_id":"osm-node:123","osm_node_id":123,"source_id":"osm-overpass-2018","evidence_class":"observed"}}
{"type":"Feature","id":"osm-way:456:0:f","geometry":{"type":"LineString","coordinates":[[-121.6,39.75],[-121.59,39.75]]},"properties":{"edge_id":"osm-way:456:0:f","from_node":"osm-node:123","to_node":"osm-node:124","osm_way_id":456,"name":"Example Road","ref":null,"highway":"residential","oneway":false,"lanes":null,"lanes_status":"unknown","maxspeed_kph":null,"maxspeed_status":"unknown","length_m":856.4,"bridge":false,"tunnel":false,"source_id":"osm-overpass-2018","evidence_class":"observed"}}
```

Build from the fixed Overpass query with `python3.12 -m
tools.build_camp_evacuation --output-root data/incidents`, or normalize a saved
response using `--osm-response <file>`. Verify offline with `--verify-package
data/incidents/camp-2018-evacuation/05575afa537d22c9`. The OSM snapshot is a
record of mapped road geometry before the incident, not proof that each road
was physically passable during the evacuation.

The next immutable [event package](../data/incidents/camp-2018-evacuation/b2624d1cda93d9e5/manifest.json)
inherits those roads and adds 44 CodeRED alert events from 29 hand-reviewed rows
in [NIST TN 2252 Supplement, Table D-1](https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.2252sup.pdf),
pp. D-3–D-4. Fifteen rows report a re-call attempt, represented as a second
`alert_sent` event. These are message initiation times, **not** evidence of
order-request time, individual delivery, vehicle departure or compliance. The
source's `25:18` and `29:44` notation extends into November 9 and is converted
using America/Los_Angeles. Named areas remain unresolved until historical zone
polygons are acquired. The event layer is explicitly `partial`.

`normalized/events.jsonl` uses one object per line sorted by UTC `occurred_at`.
Each record includes `event_id`, `type`, `occurred_at`, `occurred_from`,
`occurred_to`, `time_precision`, `available_at` and its unknown reason,
`local_time_as_written`, `target`, nullable geometry, geocoding method,
description, nullable quote, evidence class, and exact source locator. A
numeric Paradise zone list maps to IDs such as `paradise-2017-zone-2`; named
areas retain the source text in `target.place_name`. The half-open one-minute
time window expresses source precision, not an independently observed duration.
For example, the first real event has:

```json
{"event_id":"nist-codedred:01:initial","type":"alert_sent","occurred_at":"2018-11-08T15:13:00Z","occurred_from":"2018-11-08T15:13:00Z","occurred_to":"2018-11-08T15:14:00Z","time_precision":"minute","available_at":null,"available_at_status":"unknown","local_time_as_written":"11/8 07:13","target":{"place_name":"Pulga"},"geometry":null,"geocode_method":"unresolved","evidence_class":"reconstructed","source_id":"nist-nettra-supplement","source_locator":"https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.2252sup.pdf#page=135; Table D-1; p. D-3; row 1"}
```

The package keeps the reviewed non-identifying Table D-1 transcription in
`curated/nist-codedred-table.json`, with the source PDF's SHA-256 and exact page
locators. The full 306-page supplement contains individual 911 details and
addresses, so it is not bundled in this public incident package. This is an
explicit privacy exception to retaining complete raw source bytes. The table
and normalized events are rebuildable and verified offline with
`python3.12 -m tools.add_camp_codedred --verify-package
data/incidents/camp-2018-evacuation/b2624d1cda93d9e5`.

## Manifest and provenance contract

The manifest records `schema_version`, `incident_id`, `package_version`, incident
aliases per provider, UTC time bounds, IANA display timezone, bounding box,
analysis CRS, units, layer statuses, network version, and build configuration.
Each artifact entry contains relative path, media type, byte count, SHA-256 hash,
schema version, row count where relevant, and source/parent artifact references.
Artifact hashes exclude the manifest itself; the manifest hash is stored externally
by runs or distribution metadata to avoid a circular checksum.

Each source entry records the landing URL/DOI, resolved download URL or API query,
provider version, retrieval timestamp, HTTP metadata where available, license and
attribution text/link, original CRS/timezone, field dictionary, and raw file hash.
Access/redistribution status must be explicit, including `unknown`; public access
does not by itself establish redistribution permission. Exclude credentials from
URLs and saved request metadata. Keep raw mobility files out of public demo bundles;
publish aggregates and synthetic agents unless the release explicitly permits more.

Every normalized record has a stable `record_id`, `source_id`, provider record ID
when present, a raw-file locator (row/sheet/page/map feature), and transformation
version. Source record IDs are namespaced by provider and frozen source version.
Deduplicate re-imports of the same record, but retain conflicting independent
observations. Corrections create a new package version and retain lineage.

## Temporal and evidence contract

All serialized times are UTC RFC 3339 strings; Parquet timestamps use UTC with
millisecond storage precision. Preserve source text, timezone, actual precision,
and conversion rule. Millisecond storage does not assert millisecond accuracy.
Use America/Los_Angeles for California display time and date-aware DST conversion.

| Field | Type / meaning |
| --- | --- |
| `event_time_lower`, `event_time_upper` | Nullable timestamps bounding when a transition occurred; equal for a reported exact time; one-sided bounds allowed |
| `observed_at` | Nullable timestamp when evidence was observed/collected; not necessarily ignition or closure time |
| `support_start`, `support_end` | Nullable timestamps for a measurement interval, using [start, end); required for interval counts/means |
| `available_at` | Nullable earliest documented time this information was available to the modeled decision-maker |
| `ingested_at` | Timestamp when CrisisTwin acquired the record; never substituted for event/availability time |
| `time_precision` | `second`, `minute`, `hour`, `day`, `interval`, or `unknown`; source-supported |
| `evidence_class` | `observed`, `reported`, `reconstructed`, `assumed`, or `simulated` |
| `method` | Measurement/reconstruction/extraction method and version |
| `spatial_resolution_m`, `position_accuracy_m` | Separate nullable values; sensor pixel size is not positional accuracy |
| `source_quality` | Original quality flags and their documented meanings; no invented confidence percentage |

Uncertain occurrence bounds are not measurement support intervals and do not mean
a state remained valid throughout that interval. Damage found after a fire does
not establish an ignition time. A report publication timestamp does not establish
that responders knew its retrospective findings during the incident.

### Representative event

This is a **synthetic schema illustration**, not a Camp or Kincade observation.
The referenced toy entities and source do not exist in the repository. Pretty
printing is for documentation; JSONL serializes each record on a single line.

```json
{
  "schema_version": "0.1.0",
  "record_id": "toy:closure:001",
  "incident_id": "synthetic-example",
  "entity_ids": ["toy:edge:17"],
  "kind": "road_access_report",
  "event_time_lower": "2019-10-27T08:10:00Z",
  "event_time_upper": "2019-10-27T08:20:00Z",
  "observed_at": "2019-10-27T08:20:00Z",
  "support_start": null,
  "support_end": null,
  "available_at": "2019-10-27T08:25:00Z",
  "ingested_at": "2026-10-23T18:00:00Z",
  "time_precision": "interval",
  "evidence_class": "reported",
  "method": "synthetic-documentation-example",
  "source_id": "toy-source",
  "source_record_id": "entry-42",
  "raw_locator": "toy-report.txt:42",
  "payload": {
    "access": "closed",
    "direction": "both",
    "reason": "debris",
    "physical_damage": "unknown",
    "reopened_at": null
  }
}
```

The canonical evidence never chooses a point inside this uncertain interval.
A derived replay action records `replay_at`, parent evidence IDs and the explicit
selection policy, such as a scenario using the earliest plausible closure. A
null reopening time means unknown, not proof of permanent closure.

## Domain tables and units

| Layer | Required domain content |
| --- | --- |
| Roads | Stable node/edge IDs; directed multigraph topology; geometry; length_m; permitted directions; lanes; free_speed_m_s; capacity_vehicles_s; source date and provenance for each inferred attribute |
| Fire snapshots | Geometry, observation/acquisition time or interval, perimeter method, incident match, source resolution; distinguish active perimeter from cumulative burned extent |
| Traffic | Station ID, direction/lane scope, interval, count_vehicles, speed_m_s, occupancy_fraction, quality/imputation flags; retain original units and definitions |
| Highway trips | Local trip ID, proxy endpoint coordinates/times, highway identifiers, sampling limitations; inferred paths live separately with method and network hash |
| Damage | Structure ID, assessment time if known, original and normalized damage categories, construction attributes, unknown ignition time by default |
| Infrastructure events | Target edge/asset IDs, reported accessibility, direction, reason, uncertain occurrence/reopening times; separate physical damage from access restriction |
| Evacuation orders | Zone geometry version, warning/order/lift status, issue/effective/availability times if documented; not evidence of departure |
| Population/shelters | Source-year population and household/vehicle assumptions; capacities with units (persons vs vehicles), operating intervals and provenance |
| Weather/fuels | Source-valid time, forecast issue/lead time if applicable, wind m/s and meteorological direction-from degrees clockwise from north, fuel classification/version |

Unknown numeric values are null, not zero. Vehicle counts cannot be converted to
people without an explicit occupancy assumption. Unknown road capacity is an
assumption to calibrate, not a measured value. Historical network snapshots and
historical shelter inventories are preferred; modern substitutes must be labeled.
Use a suitable projected analysis CRS in meters for distances and intersections;
record its definition and transformation versions. Browser exports use lon/lat.

## Source-specific acquisition plan

Prefer official downloads and APIs. Use HTML to discover files; extract PDFs only
where structured data is unavailable. Keep original files before parsing.

| Source and verified entry point | Acquisition and normalization | Fidelity/access limit |
| --- | --- | --- |
| [FEDS CONUS 2012–2025](https://zenodo.org/records/22921773) | Download the incident year's processed `lf_perimeter` FlatGeobuf and related files; filter by spatial/time overlap and reviewed event matching; preserve merge lineage | 12-hour estimates from VIIRS 375 m detections; no minute-level fire arrival. Unprocessed backing files need extra care. |
| [NASA FIRMS archive](https://firms.modaps.eosdis.nasa.gov/download/) | Bounding region/date export in CSV or geospatial format; retain acquisition time, satellite and quality flags | Archive authentication required; hotspots are observations, not complete fire perimeters. |
| [CAL FIRE DINS layer](https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/arcgis/rest/services/POSTFIRE_MASTER_DATA_SHARE/FeatureServer/0) | Read schema; filter `INCIDENTNAME`, `INCIDENTNUM`, `INCIDENTSTARTDATE` after verifying actual values; capture IDs and batch-fetch records and geometry | Observed fields include `GLOBALID`, `DAMAGE`, `STRUCTURECATEGORY`, `DEFENSIVEACTIONS`; field availability is not completeness. `INCIDENTSTARTDATE` is not building ignition time. |
| [Kincade detector data](https://zenodo.org/records/7410114) | Download both original XLSX files; inspect sheets/headers and accompanying study before field mapping; convert measurements to Parquet | 25.7 MB published files; exact schema, interval semantics, quality flags and reuse terms still need file-level inspection. |
| [Kincade highway routing documentation](https://www.nature.com/articles/s41597-022-01731-6) / [data DOI](https://doi.org/10.17603/ds2-9v8w-y830) | Acquire released CSV and highway shapefile; retain proxy entrance/exit points and epoch-millisecond timestamps | 21,160 records span before/during/after the incident; full paths and evacuation intent are not observed. DesignSafe file download not verified here. |
| [Sonoma Kincade orders](https://socoemergency.org/recover/2019-kincade-fire/kincade-fire-evacuation-orders/) | Extract the county order matrix and maps into reviewed, versioned zone events; save page references | Geometry and timing extraction require review; orders do not measure compliance. |
| [Stanford evacuation database](https://stanford.edu/~samhn/evacuation-data/) | Download shapefiles plus documentation; match incident/date; retain original text and source links | Page labels download preliminary; daily coverage cannot supply minute-precise orders. |
| [NIST Camp progression](https://www.nist.gov/programs-projects/wildland-urban-interface-wui-fire-data-collection-parcel-vulnerabilities/nist/fire) and [incident documents](https://www.nist.gov/programs-projects/wildland-urban-interface-wui-fire-data-collection-parcel-vulnerabilities/nist-1-0) | Download original reports/maps/redacted radio chronology; extract cited records; georeference maps only with documented control points and error | Complete underlying GIS database not confirmed; a digitized map remains reconstructed evidence. |
| [NIST Camp NETTRA](https://www.nist.gov/programs-projects/wildland-urban-interface-wui-fire-data-collection-parcel-vulnerabilities/nist/life) | Extract reviewed closure, traffic and refuge-area observations with report/page/time provenance | Incomplete observations; no basis for inventing every vehicle's trajectory. |

For ArcGIS, archive layer metadata and the filtered object-ID list, fetch bounded
ID batches, and reconcile expected/returned unique IDs. Check transfer limits and
service errors even on HTTP 200. A mutable service can change mid-export: use a
versioned export if available, otherwise record capture bounds and verify/retry
inconsistent batches. See [query API documentation](https://developers.arcgis.com/rest/services-reference/enterprise/query-feature-service-layer/).

For all collectors, use timeouts, bounded retries with backoff, resumable downloads,
atomic writes, and checksums. Failed/missing layers remain explicit. Do not silently
substitute cached files from a different incident or version. PDF/OCR/LLM extraction
produces candidates; reviewed source locations and extraction status are required
before those records enter the historical replay.

The [NIFC file share](https://ftp.wildfire.gov/) states it is not an archive;
incident-specific data now requires authenticated access while incident maps remain
public. Treat finer infrared/perimeter files as an incident-specific acquisition
target, not a guaranteed public historical feed.

## Replay behavior

Maintain two independent controls: incident time and evidence availability cutoff.

1. **Retrospective reconstruction:** display later-assembled historical evidence
   at its documented event/observation time, visibly labeled as retrospective.
2. **Decision-time replay:** expose only information with documented availability
   at or before the cutoff. Unknown availability is excluded or explicitly assumed
   in a separately labeled variant. No future geometry is used for interpolation.
3. **Counterfactual simulation:** fork the package plus initial state and proposed
   interventions. Store outputs in a separate run directory, never in raw history.

Perimeters change at observation times by default. A last-observed perimeter can
remain visible with its age; it must not assert that spread stopped between samples.
Optional interpolated animation is labeled and excluded from measured validation.
Unknown road accessibility is distinct from open and closed; any routing default
for unknown roads is a recorded scenario assumption. Post-fire building damage is
an assessment overlay, never a fabricated sequence of building fires.

Compile a deterministic timeline from evidence plus explicit resolution policies.
Each action stores parent IDs and a stable `(replay_at, sequence, action_id)` order;
sequence resolves ties deterministically but never asserts undocumented causality.
Unresolved contradictions remain visible and are not resolved by ingestion order.
Preserve distinct fire observations even when a mapped area shrinks after correction.

Play/pause/speed affect presentation only. Seek restores a matching checkpoint and
replays actions forward; seek without checkpoints replays from initial state.
Checkpoint keys include package hash, timeline hash, policy hash, reducer version,
and mode. A canceled/stale seek cannot replace the latest requested state.

Run metadata pins package/network hashes, model and code versions, dependency
environment, initial state, intervention list, random seed, integer simulation
tick in milliseconds, horizon, and optimizer budget. Events between model ticks
require a documented scheduling rule. Precomputed demo results carry the same
metadata and are labeled cached simulation. Offline demos must include required
map assets or a locally rendered road/terrain background, not depend on live tiles.

## Validation and first acquisition milestone

Before committing to a high-fidelity demo, produce a coverage report for one
bounded area and time window: fire observation gaps, monitored roads, trip sample
coverage, closure timing bounds, missing fields, network vintage, and uncertain
source/entity matches. Choose the demo window from this report.

The Camp DINS pilot acquires a small incident slice and checks source retention,
record completeness, location validity and reproducible offline normalization.
Before treating a multi-source incident as replayable, produce a quality report
and prove these additional checks:

- Rebuilding from frozen sources produces the same normalized records and timeline;
  recorded artifact hashes identify a particular build (byte-identical Parquet also
  requires pinned writer settings and exclusion of nondeterministic metadata).
- CRS, geometry, time zones, units, IDs and foreign-key references validate; field
  mapping failures and unmatched records are counted, not dropped silently.
- Sequential playback and arbitrary seek give identical canonical state.
- Decision-time replay cannot read evidence first available after its cutoff.
- Interval measurements are neither duplicated nor spread across smaller time
  bins as if those subdivisions had been measured.
- Missing/reopened/contradictory closure cases behave according to declared policy.
- Counterfactuals conserve modeled population, enforce shelter capacities, and
  never route over edges considered closed under the run's explicit policy.
- Traffic validation compares matching stations, directions, intervals and units;
  fire validation compares at actual observation times. Calibration and held-out
  evaluation slices are separated. Report sample coverage alongside errors.

FEDS alone cannot pass a minute-scale fire-arrival validation. Neither highway
endpoints nor final building damage can validate continuous trajectories or ignition
times. Finer evidence must be acquired or the supported fidelity claim narrowed.

## Next work (not implemented)

Inspect real files before freezing more provider field mappings. Add fire
progression and event timing for Camp if minute-scale disruption reconstruction is
the primary demo objective, or create a separate Kincade package with detector
measurements for traffic calibration. Acquire historical roads, population,
shelters and weather/fuels as needed and record their remaining gaps. Bulk scraping
every source is not a prerequisite for this pilot.
