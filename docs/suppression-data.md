# Suppression resource data

Sourced firefighting resource data for the suppression model (engines, water tenders,
dozers, hand crews, helicopters, airtankers, air attack): types, performance, operating
constraints, California bases and response times. Decision record:
[0040-realistic-suppression-data](adr/0040-realistic-suppression-data.md). The Studio simulator
now reads this data ([0048-suppression-engine](adr/0048-suppression-engine.md)). Data gathered
2026-10-24.

| File | What |
| --- | --- |
| `tools/suppression_resources.json` | 250 values, each with `unit` and either `source_id` + `page` or `assumption: true` + `reason` |
| `tools/ca_fire_bases.json` (not in git; build with `python -m tools.suppression_data --refresh-bases`) | 1,046 active CAL FIRE-layer facilities with coordinates, agency, unit, owner, funding. Kept out of git because the source layer states no open licence |
| `tools/suppression_data.py` | loader, validator, summary, unit converters, `road_access()`, `--refresh-bases` |
| `tests/test_suppression_data.py` | schema, units, "every number sourced or flagged", road rules |

```bash
python3 -m tools.suppression_data                 # validate and print the summary
python3 -m unittest tests.test_suppression_data
python3 -m tools.suppression_data --refresh-bases # re-download the CAL FIRE layer (size + SHA-256 recorded)
```

Units stay as the sources print them (gallons, feet, chains, lb, knots, percent). Convert at
the simulator boundary with the helpers in `suppression_data.py`: 1 chain = 20.1168 m, 1 kt =
1.852 km/h, 1 gal = 3.78541 L.

## Sources

| id | Document | Used for | Licence / access |
| --- | --- | --- | --- |
| `nwcg_pms200_equipment` | NWCG PMS 200 Equipment, [web](https://www.nwcg.gov/publications/pms200/equipment-pms-200) (mod. 2024-04-25) | Engine types 1-7, water tender types, dozer typing | US Gov, fetched |
| `nwcg_pms200_crews` | NWCG PMS 200 Crews, [web](https://www.nwcg.gov/publications/pms200/crews-pms-200) | Type 1/2 crew size, production factor 1.0/0.8 | US Gov, fetched |
| `nwcg_pms200_aircraft` | NWCG PMS 200 Aircraft, [web](https://www.nwcg.gov/publications/pms200/aircraft-pms-200) | Airtanker and helicopter typing | US Gov, fetched |
| `pms465_tactics_1996` | Wildland Fire Suppression Tactics Reference Guide, PMS 465 (1996), [PDF](https://coloradofirecamp.com/suppression-tactics/suppression-tactics-guide.pdf) | Dozer production (p.140), engine production (p.164), crew rates (pp.39-40), flame-length limits (p.12), retardant limits (pp.171-174), turnaround (p.168) | US Gov, hosted copy |
| `broyles_2011` | Fireline Production Rates, USFS 1151-1805-SDTDC, [PDF](https://www.fs.usda.gov/t-d/pubs/pdf/11511805.pdf) | Observed crew rates (pp.6-7) | US Gov |
| `wheg_2013` | Water Handling Equipment Guide, PMS 447-1 (2013), [PDF](https://www.fs.usda.gov/eng/pubs/pdfpubs/pdfWHEG13/WHEG13.pdf) | Real apparatus: CAL FIRE Models 14/24/34, GVWR, 4x4, cab-to-axle (PDF pp.24-52) | US Gov |
| `iasg_2017` | Interagency Aerial Supervision Guide (2017), [PDF](https://gacc.nifc.gov/swcc/dc/nmsdc/documents/Dispatch/Reference/Aerial_Supervision_Guide_4-17.pdf) | Daylight and night rules, wind, airtanker table, coverage levels, line length (PDF pp.37-57, 100-104, 108) | US Gov |
| `pms508_iabog_2015` | Interagency Airtanker Base Operations Guide, PMS 508, [PDF](https://gacc.nifc.gov/oncc/docs/PMS%20508_IABOG_2015_%20merge.pdf) | 15-minute reaction time, sunrise/sunset (PDF pp.44, 46) | US Gov |
| `calfire_house_2019` | CAL FIRE testimony, House Oversight, 20 Aug 2019, [PDF](https://docs.house.gov/meetings/GO/GO28/20190820/109883/HHRG-116-GO28-Wstate-JohnsonD-20190820.pdf) | 343 engines, 22 airtankers at 13 bases, 10 helicopters, 12 air tactical, night Black Hawks, 95% at 10 acres | US Gov; counts are 2019 |
| `calfire_facilities` | [CAL FIRE Facilities for Wildland Fire Protection](https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/ArcGIS/rest/services/CAL_FIRE_Facilities_for_Wildland_Fire_Protection_-_Public_View/FeatureServer/0) | All base and station coordinates | **No open licence stated**; disclaimer only (see below) |
| `cal_ccr14_1273` | 14 CCR 1273.01-.07 Fire Safe Regulations, [LII](https://www.law.cornell.edu/regulations/california/14-CCR-1273.01) | Width, grade, radius, turnaround, bridge load | Regulation; design standards |
| `osm_wiki_smoothness`, `osm_wiki_tracktype` | OSM wiki `Key:smoothness`, `Key:tracktype` | Tag semantics | CC BY-SA 2.0 |
| `calfirepilots_fire` | California Fire Pilots Association, [page](https://www.calfirepilots.com/fire) | "Air Attack, two Air Tankers, and a Helicopter"; call-to-takeoff 5 min | Trade association; secondary |
| `nfpa_1710` | NFPA 1710 as cited in ADR 0023 | 80 s turnout, 240 s travel | **Not re-fetched** (paywalled); unverified |
| `calfire_web_snippet` | fire.ca.gov mobile-equipment and aviation pages | 58 dozers, 383 engines, 23 S-2T, S-70i 1,000 gal, UH-1H 360 gal, OV-10A | **Unavailable**: HTTP 403 to automated fetch; seen only in search summaries; unverified |

PDF page numbers are cited where the PDF's printed numbers differ (PMS 465 PDF page =
printed + 7; WHEG printed = PDF - 6; IASG printed = PDF + 4 to +6).

### Facilities layer licence and size

The layer has no open-data licence on its item page: only CAL FIRE's disclaimer of warranties
and the contact calfire.egis@fire.ca.gov. It is state-published public data, so the file
credits "California Department of Forestry and Fire Protection, Contract Counties" and records
the terms as unstated. Raw GeoJSON: 862,761 bytes, SHA-256
`9bc30a0a111097086ffbf6ac3a82335a0b8778862057086ced1893f80d89f799` (1,617 features, item
modified 2026-08-05). The committed file keeps 1,046 active fire-response facilities (309 KB):
214 Schedule A, 206 Schedule B, 38 Schedule A/B, 359 local and 96 contract-county (Greybook)
stations, 18 other stations, 31 conservation camps, 20 crew fire centers, 17 helitack bases,
16 air attack bases and 31 dispatch centers (19 ECC, 12 ICC). Address, phone and GlobalID are
dropped. `--refresh-bases` rebuilds it from the live layer.

## Coverage: sourced against assumed

| Section | Sourced | Sourced, source unverified | Assumption | Total |
| --- | ---: | ---: | ---: | ---: |
| engines (typing, 7 reference apparatus) | 58 | 0 | 0 | 58 |
| water tenders | 31 | 0 | 0 | 31 |
| dozers (typing, production by slope and fuel) | 6 | 0 | 1 | 7 |
| hand crews (production by fuel model) | 6 | 0 | 1 | 7 |
| engine production | 2 | 0 | 0 | 2 |
| helicopters | 21 | 2 | 2 | 25 |
| airtankers | 13 | 1 | 1 | 15 |
| air attack | 4 | 1 | 1 | 6 |
| ground constraints (14 CCR, masses, OSM semantics) | 22 | 0 | 0 | 22 |
| road access parameters | 13 | 0 | 29 | 42 |
| aviation constraints | 15 | 0 | 2 | 17 |
| deployment | 3 | 2 | 4 | 9 |
| response times | 3 | 2 | 4 | 9 |
| **Total** | **197** | **8** | **45** | **250** |

Note that "sourced" for the table leaves means a whole table is one leaf (for example the
dozer table); the 250 leaves hold well over a thousand numbers.

## How the simulator uses it

Status: wired into Simulation Studio by
[0048-suppression-engine](adr/0048-suppression-engine.md) through
`app/src/studio/suppressionData.generated.ts` (`tools/gen_suppression_ts.py`). Items 1-5 are
implemented there; the gaps (water supply, availability, curve radius, dispatch-agent routing)
are listed in that ADR. Dispatch-agent routing and the live drill's simulated responders now use
it too ("How responders use it" below).

1. **Resource types.** Map a dispatched resource to an NWCG type, then take tank, pump and
   crew from `engines.typing`. Use the CAL FIRE Type 3 (500 gal, 500 gpm, 4x4, 33,000-35,000
   lb) as the default state engine.
2. **Line production.** Replace the single per-type rate with the tables:
   `crew_line_rate_m_per_h(data, crew_type, fuel_group, mode)` from Broyles 2011,
   `dozer_line_rate_m_per_h(data, size, fuel_model, slope_pct, uphill)` from PMS 465 p.140
   (no dozer above 55% slope), and the engine table by crew size. Keep the Hauling-chart
   holding limits (4 ft hand tools, 8 ft engines and dozers) already in `firefighting.ts`.
3. **Roads.** Call `road_access(data, osm_tags, grade_pct, vehicle_class)` per way, with the
   grade from the elevation model along the way. It returns passable, speed and the rule id.
4. **Aircraft.** Gate fixed-wing by the daylight window, helicopters by the same window
   unless the base has night-capable aircraft, and both by wind and smoke; compute cycle time
   from distance to the dip or reload base, cruise speed and the ground time.
5. **Dispatch.** Place resources at `ca_fire_bases.json` stations (engines), conservation
   camps (hand crews), helitack bases and air attack bases (aircraft); use the response-time
   section for turnout and mobilisation.

### How responders use it

- **Live drill, simulated responders** (`livecore/apparatus.py`, `livecore/responders_sim.py`,
  `manage.py live_sim_responders`): units start at the CAL FIRE-layer stations nearest the
  fire estimate that sit on the drill road network. A state-owned CAL FIRE station holds Type 3
  engines (the default state engine), about 1.6 per station (the derived estimate, ASSUMPTION);
  any other station holds one Type 1 structure engine (ASSUMPTION). Turnout is 80 s at paid
  stations (`response_times.turnout_s`) and 120 s at volunteer, combination or unknown ones
  (`wildland_turnout_s`, ASSUMPTION). Each unit routes on the roads `road_access()` opens to its
  class, at the class's speed; a task only its class rules keep it from is cancelled with the
  rule in the note. Without the bases file the units fall back to approximate Chico points,
  labelled.
- **Drill roads lack the tags.** The camp-2018 bundle keeps only `highway`, `lanes` (per
  direction), `bridge` and speed per edge, so the rules run on the highway class alone with the
  documented defaults (paved, width by class), the edge speed as `maxspeed`, grade 0%
  (ASSUMPTION: no elevation per edge) and no R10 (no turning-circle data). Every camp-2018 road
  is then open to every class (R11): the class sets the speed only. Bundle edges that carry an
  OSM `tags` object get the full rules. `lanes` is not passed, because the bundle counts lanes
  per direction and R11 reads OSM `lanes=1` as a single-lane road.
- **Responder routes** (`GET /api/live/tasks/{id}/route?class=`, default `engine_t3`): the same
  per-class routing; `reason: "no_access"` with the rule when only the class rules block
  ([live-reports.md](live-reports.md#responder-route-to-a-task)).
- **Dispatch agent** (`/dispatch`, `app/src/dispatch/stationApparatus.ts` and `engine.ts`):
  each OSM station engine within 500 m of a state-owned CAL FIRE-layer station is a Type 3
  engine, within 500 m of another layer station a Type 1 structure engine (ASSUMPTION), else a
  Type 3 (ASSUMPTION). Units route on the Studio crew dispatch's per-class graphs
  (`accessTableFor`: OSM tags kept by `dispatch_area.py`, grades from the landscape DEM,
  service roads and tracks included), at the class's speed, with the kind's turnout and line
  rate (`apparatus.ts`). Orders a class cannot carry out are rejected with the rule, and
  `units[].no_access` tells the Claude dispatcher which threatened zones and burning fires each
  unit cannot reach and why. A fire more than 1.5 km from every road a class can use is out of
  its reach. Planner road closures (`setRoadClosed`) close the edge to every class.

### Road-access decision table

Applied in order; the first rule that matches decides. "Class" is one of `engine_t1_t2`
(structure engine, 2WD, up to 46,500 lb), `engine_t3` (4x4 wildland, up to 35,000 lb),
`engine_t4_t7` (light AWD wildland), `tender_support` (2WD, 56,000-60,000 lb),
`tender_tactical` (AWD tender). Hand crews walk from the last passable point; dozers arrive on
a transporter, so the tender column applies to their carrier. **Sourced** anchors are marked;
everything else is an assumption to calibrate with CAL FIRE or USFS unit staff.

| Rule | OSM condition | Result | Basis |
| --- | --- | --- | --- |
| R01 | `highway` in path, footway, steps, bridleway, cycleway, pedestrian, or not a road class | Not drivable | Obvious |
| R02 | `emergency=no`, or `motor_vehicle=no` without `emergency=yes` | Closed | Convention. `access=private/no` is treated as open with a gate delay (assumption) |
| R03 | `smoothness` outside the class list: T1/2 and support tender up to `intermediate`; T3 and tactical tender up to `very_bad`; T4-7 up to `horrible` | Closed | OSM wiki clearance classes (sourced); class lists assumed |
| R04 | Unpaved and `tracktype` outside the class list: T1/2 and support tender grade1; T3 and tactical grade1-3; T4-7 grade1-4. Missing tracktype inferred: gravel-like grade2, sand, grass, mud grade4, other unpaved grade3 | Closed | Drive train and mass from WHEG (sourced); list assumed |
| R05 | Paved and grade above 16% (T1/2, tactical), 12% (support tender), 25% (T3, T4-7) | Closed | 16% / 20% with approval is the 14 CCR 1273.03 design maximum (sourced); class limits assumed |
| R06 | Unpaved and grade above 8% (T1/2), 6% (support), 15% (tactical), 20% (T3), 25% (T4-7) | Closed | Assumed |
| R07 | `width` (or default by highway) below 3.05 m | Closed | 10 ft lane, 14 CCR 1273.01 (sourced) |
| R08 | `maxheight` below 4.11 m | Closed | 13 ft 6 in, 14 CCR 1273.01 (sourced) |
| R09 | `maxweight` below the class GVWR; or a `bridge` with no `maxweight` on a track, service or unpaved way and GVWR above 40,000 lb | Closed | GVWR from WHEG (sourced); 40,000 lb structure load 14 CCR 1273.02(b) (sourced); the unmarked-bridge rule is assumed |
| R10 | Dead end with no `highway=turning_circle` or loop, for T1/2 and both tenders | Closed | 40 ft turnaround radius, 14 CCR 1273.05 (sourced); who can reverse out is assumed |
| R11 | Otherwise paved | Open at min(highway speed cap, `maxspeed`) x grade factor x single-lane factor | Speeds assumed |
| R12 | Otherwise unpaved | Open at 40, 30, 20, 12 or 8 km/h for grade1-5, x grade and single-lane factors | Speeds assumed |

Grade factor: x0.8 above 8%, x0.6 above 12%, x0.4 above 16%. Single-lane (width below 5.0 m or
`lanes=1`, not `oneway=yes`): x0.6. Heavy-apparatus speed caps (km/h): motorway 90, trunk 80,
primary 70, secondary 60, tertiary 50, unclassified 45, residential 35, service 25. Default
widths when `width` is missing: motorway/trunk 7.3 m, primary 6.7, secondary 6.1, tertiary and
residential 5.5, unclassified 4.9, service 3.7, track 3.5 m.

### Aviation rules

- Fixed wing: multi-engine airtankers are dispatched to arrive not before 30 min after
  official sunrise and not after 30 min before official sunset when no aerial supervision is
  on scene. Retardant after sunset needs flight-crew concurrence and aerial supervision on
  scene. Daylight is 30 min before sunrise to 30 min after sunset (IASG PDF p.37, p.42;
  PMS 508 PDF p.46).
- Helicopters: same 30-minute window; multi-engine helicopters may fly at night in
  emergencies or at lighted airports; USFS night work uses night-vision goggles, VFR only. CAL
  FIRE's S-70i fleet is night capable (house testimony p.4); the model should allow night
  helicopter drops only from bases with an S-70i, which the data cannot place (gap).
- Visibility: stop when poor visibility precludes safe operations (IASG PDF p.40). Smoke and
  inversions hide the flight path (PMS 465 p.167).
- Wind: evaluate drops at 15 kt, generally ineffective at 25 kt or more (IASG PDF p.100);
  PMS 465 (1996) says 20 mph. Hard flight stop 35 kt is an assumption.
- Retardant or water is not effective for direct attack above 8 ft flames (PMS 465 pp.171,
  174).
- Cycle: heavy airtanker about one hour round trip for 2,000-3,000 gal/h (IASG PDF p.103);
  helicopter turnaround 3-5 min (IASG PDF p.103, PMS 465 p.168).

## Cross-check against the current model

- Engine 600 m/h in grass (about 30 chains/h) sits between the sourced three- and four-person
  engine crews in fuel model 1 (24 and 35 chains/h, PMS 465 p.164).
- Hand crew 400 m/h (19.9 chains/h) is above the observed direct rates in grass: 17 chains/h
  for a Type 1 crew and 9.5 for a Type 2 (Broyles 2011). It matches the 1996 handbook only for
  Type 2 (18) and overstates a Type 2 crew by about 2x on current data.
- Dozer 1,200 m/h (60 chains/h) is below the sourced medium dozer in grass on gentle upslope
  (88 chains/h) and matches steep upslope classes.
- Fuel factors in `firefighting.ts` (shrub 0.4, understory 0.5) are close to Broyles' ratios
  to grass for a Type 1 crew: chaparral 0.39, brush 0.97, timber 0.62. Brush is the largest
  difference: the sim slows brush to 0.4 where observed brush rate is nearly grass.

## Gaps

- **Federal and other-agency bases.** No USFS or BLM station layer was available. HIFLD Open
  fire stations are mirrored only at a NASA host that did not resolve from this environment
  (HIFLD Open itself has been retired), the USFS EDW service list has no fire-station layer,
  and an OSM Overpass query for federal-operator stations timed out (HTTP 502). Federal
  airtanker bases (NWCG PMS 507) need an EGP account and were not retrieved. The CAL FIRE layer
  includes only federal-owned facilities it lists (2 air attack bases, 6 stations).
- **Per-station apparatus.** The layer has no engine, crew or dozer counts. The estimate of
  about 1.6 engines per CAL FIRE-owned station is derived (343 engines / 220 stations, 2019).
  Local-government department apparatus (LA County, Orange County, Ventura, Kern) is not in
  any retrieved dataset beyond station locations.
- **Dispatch levels.** No CAL FIRE unit preplan or ECC dispatch matrix is public. Only the
  aircraft package (air attack, two airtankers, one helicopter) is sourced, from a trade
  association page. Ground first-alarm counts and move-up-and-cover thresholds are assumptions.
- **Fleet counts.** fire.ca.gov blocks automated access; 2019 testimony is the verified
  source and it is five years old. The dozer, S-2T, OV-10A and tank-size figures are from
  search summaries and flagged unverified.
- **PMS 410-1 Fireline Handbook** itself was not retrieved; its tables appear in PMS 465
  (1996), which is older than the 2011 observations.
- **Airtanker line-length table in PMS 465** (p.176) is an image; the IASG 2017 table
  replaces it.
- **Engine off-road capability.** No document gives grade, approach angle, wheelbase or turning
  radius for engines. WHEG gives "cab to axle" only. All unpaved limits are assumptions.
- **Aircraft speeds and ground times.** Helicopter and OV-10A cruise, airtanker reload time and
  helicopter call-to-takeoff are assumptions. NFPA 1710 times are unverified.
- **Night helicopter bases** and which CAL FIRE helitack bases host S-70i aircraft are not in
  the data.
- **Elevation-derived grade** needs a DEM along each way; the repo's terrain code provides
  it, the data here only supplies the thresholds.

## What is not realistic

- Production rates are sustained shift averages for 20-person crews. They ignore fatigue,
  access time, fireline width, mop-up and burnout, and are not valid above flame lengths the
  Hauling chart allows.
- A single cab-to-axle number is not a turning radius. Heavy-engine routing on narrow
  winding roads is likely optimistic because OSM rarely records curve radius or switchbacks;
  the 50 ft minimum curve radius of 14 CCR 1273.04 is available but not applied.
- OSM `width`, `surface`, `maxweight` and `bridge` are patchy, so defaults decide many ways.
  Private gates and locked access are unknown.
- Road speeds ignore traffic, evacuation contraflow and driver behaviour.
- Stations are treated as engine bases, but hand crews and dozers actually come from camps
  and contractors; aircraft come from bases that may be far away or busy elsewhere (statewide
  drawdown, other fires). Availability is not modelled.
- Airtanker line length assumes drop height and airspeed from the guide; wind, canopy and
  tank system change it. Retardant has no effect once the carrier evaporates or on crown fire.
- Outputs are planning experiments, not operational dispatch guidance.
