# People and facilities data

Sourced inputs for the scenario engine's residents generator and the traffic model. Decision and
trade-offs: `docs/adr/0043-people-and-facilities-data.md`. Everything here is either an observed
public number with a locator, a derived number with its arithmetic, or an `assumption` placeholder.
Observed, derived and assumed values never share a field.

Files:

| File | What | How made |
| ---- | ---- | -------- |
| `tools/people_data.py` | Downloaders (Census, facilities), validators, CLI | stdlib; network only when a subcommand runs |
| `tools/people_behavior.json` | 23 behaviour and vulnerability parameters, each tagged | hand-curated from the sources below |
| `tools/people_acs_butte_fixture.json` | 200 Butte County block groups, ACS 2018-2022 | `census --counties 007 --source bulk` |
| `tools/people_facilities_butte_fixture.json` | 254 facilities and schools in Butte County | `facilities --counties Butte` |
| `tests/test_people_data.py` | 33 tests: parsers, validators, fixtures, parameter file vs `sim/` constants | no network |

## Commands

```bash
python3.12 -m tools.people_data census --counties 007 --source bulk --out ~/crisistwin-sources/people
python3.12 -m tools.people_data census --bbox -122.0,39.5,-121.3,40.1 --out DIR     # keyless API; see below
python3.12 -m tools.people_data facilities --counties Butte --out DIR
python3.12 -m tools.people_data validate tools/people_acs_butte_fixture.json tools/people_facilities_butte_fixture.json
python3.12 -m unittest tests.test_people_data
```

`census --counties` takes county FIPS3 codes within California. `--bbox west,south,east,north`
keeps block groups whose TIGER internal point is inside. Output records URL, bytes and SHA-256 for
every response, plus the vintage and licence. Add `--year` for another ACS 5-year (the bulk files
exist from 2021; earlier years need the API).

**Keyless Census access.** `--source api` (default) makes one request per table and county with no
key, at low volume; set `CENSUS_API_KEY` to use a key. On 2026-10-24 the API returned its "Missing
Key" page for every data request from the build environment (metadata calls worked), so the API
path is covered by unit tests on canned responses and was not run end to end. `--source bulk`
streams the table-based summary files from `www2.census.gov` (about 16 to 87 MB read per table, the
read stops after California's block groups) and needs no key. The fixture used it.

## Coverage: sourced vs assumed

| Topic | Status | Source |
| ----- | ------ | ------ |
| Order compliance (87.0% to 96.8% of order recipients left) | sourced | Wong et al. 2020, Table 11 |
| Camp: 19% received an order; 1.3% first learned from one | sourced | Grajdura 2022, pp. 37, 103 |
| Camp awareness, departure and CodeRED timing | sourced | Grajdura 2022, pp. 51-52 |
| Camp delay effects (men +23 min, insured owners +34 min, 15+ years' tenure about +30 min) | sourced | Grajdura 2022, pp. 52-53 |
| Kincade trigger mix (33% self, 23% shadow, 7% on warning, 38% on order) | sourced | Zhao et al., Sec. 4.4.1 |
| Shadow evacuation (29.1% to 75.0% of non-recipients) | sourced | Wong et al. 2020, Table 11 |
| Overall evacuation rate (46.8% to 89.4%; Kincade 80% survey, 46% GPS in zones) | sourced | Wong Table 10; Kuligowski; Zhao Sec. 4.4.3 |
| Wait and see 29%, stay and defend 24%, leave 47% (Australia, stated) | sourced | McLennan et al. 2014 |
| Stay reasons: protect property 16.7% to 36.7% of non-evacuees | sourced | Wong Table 20 |
| Departure hour of day | sourced | Wong Table 10 |
| Vehicles used per household (mean 1.52 to 1.82 by cap) | sourced + derived | Wong Table 10 |
| Households with pets (63.7% to 81.7%); pets as a reason to stay (7.1% to 10.0%) | sourced | Wong Tables A1, 20 |
| Returned home eventually (91.9% to 96.9%) | sourced | Wong Table 10 |
| Carless, 65+, disability, limited English by block group | sourced (ACS) | ACS 2018-2022 B25044, B01001, B18101, C16002 |
| Camp rescue events with a pre-existing condition (at least 30%) | sourced | NIST TN 2252, p. 211 |
| Camp B-Line buses, hospital and care-home timelines | sourced | NIST TN 2252, pp. 79-82, 153-154 |
| Order-compliance default 0.92; shadow share default 0.30 | assumption (inside sourced ranges) | none |
| Pet extra preparation 10 min | assumption | none |
| Delay distribution in minutes after an order or warning (Tubbs, Thomas, Kincade, Australia) | gap | not published as minutes |
| Return attempts into a closed zone | gap | none found |
| Effect of limited English or disability on notification delay | gap | none found |
| 2018 facility roster; B-Line GTFS | gap | see Gaps |

## Key parameter values, and how they differ from the traffic model

| Quantity | Value (source) | `sim/` today | Difference |
| -------- | -------------- | ------------ | ---------- |
| Evacuation participation of noticed households | 0.87 to 0.97 of order recipients (Wong T11); 0.46 GPS Kincade | `EVACUATION_PARTICIPATION = 1.0` | sim sends everyone |
| Shadow evacuation, no order | 0.29 to 0.75 of non-recipients (Wong T11); 23% of Kincade evacuees (Zhao) | none: demand only in zones with an order or warning | missing |
| Wait for fire / stay | 29% wait and see, 24% stay (Australia, stated); 3% to 13% non-compliance (Wong) | `wait_for_fire_share = 0.07` | inside the California non-compliance range; below Australian intentions |
| Order to departure | Camp: mean awareness 08:00 to mean departure 09:33, about 93 min, mostly unordered (Grajdura) | order: about 48 min mean; warning only: about 138 min; fire cue: about 28 min | Camp falls between order and warning-only; not calibrated |
| Trigger mix | Kincade: 55% left with no order for them; 7% on warning at once | warning hazard 0.5/h (median 83 min) | warning response much slower than Kincade's 7% immediate leavers |
| Camp first source of awareness | saw fire 44.6%, told in person 26.3%, call or text 17.1%, online 6.9%, TV or radio 3.8%, official notice 1.3% | order trigger plus fire and social cues | consistent: cues carry Camp |
| Vehicles per evacuating household | 1.52 to 1.65 (cap 2), 1.61 to 1.82 (uncapped) (Wong T10) | `min(available, 2)`: 1.69 for Butte | within 2% to 11% |
| Carless households | 6.1% of Butte households (ACS) | counted, not moved | same; needs a pickup model |
| Return into a closed zone | no source | `turn_back_prob = 0.5` on blocked edges (a different thing) | no counterpart |

## Facilities (Butte County fixture)

Current registry snapshot, not the 2018 roster.

| Kind | Source | Count | Capacity total |
| ---- | ------ | ----- | -------------- |
| Hospital (general acute) | CDPH | 4 | 465 beds |
| Skilled nursing | CDPH | 9 | 910 beds |
| Intermediate care | CDPH | 6 | 36 beds |
| Congregate living health, adult day health | CDPH | 1 + 1 | 16 beds + 0 |
| Residential care for the elderly | CDSS | 27 | 988 clients |
| Adult residential, adult day care | CDSS | 20 + 17 | 115 + 626 clients |
| Child care centres | CDSS | 82 | 3,023 children |
| Public schools (active) | CDE | 87 | 29,917 enrolled (2025-26) |

Camp, 2018 (NIST TN 2252, Sec. 7.3, pp. 79-82): Feather River Hospital held 60 patients; spot fires
reached its property at 08:11, one third were out by 08:36 and none remained at 08:45, using staff,
police and ambulance vehicles; two ambulances were caught in a burnover after 09:00. Paradise had
at least 20 care facilities from under 10 beds to over 130. Cypress Meadows (91 patients) began at
07:45, had moved 40 by 09:30 and was ordered out at about 10:00. Schools used buses and staff cars.
These are scenario examples; no 2018 roster was published.

## Licences

| Source | Licence as published | Checked |
| ------ | -------------------- | ------- |
| Census ACS, TIGER/Line | US government work, public domain | statute, Title 17 USC 105 |
| CDPH licensed and certified facility list (data.chhs.ca.gov) | `data_license: Terms of Use`; no open licence | package_show API, 2026-10-24 |
| CDSS Community Care Licensing (data.chhs.ca.gov, ArcGIS layer) | `data_license: Terms of Use`; no open licence | package_show API, 2026-10-24 |
| CDE school sites (data.ca.gov, ArcGIS layer) | none stated; data are self-reported | package_show and item JSON, 2026-10-24 |
| NIST TN 2252 | US government work | NIST |
| Papers (Wong, Grajdura, Zhao, Kuligowski, McLennan) | cited for facts only; no text is copied | n/a |

The fixtures store each licence statement with its URL. "Terms of Use" and "none" are not open
licences; get confirmation before publishing the repository.

## Gaps

- **Delay in minutes.** The survey papers give departure by clock hour or by day. Only Camp
  (Grajdura) gives awareness and departure in minutes, and Camp was cue-driven. A minutes-after-an-order
  distribution needs the raw Tubbs, Thomas or Kincade survey data (not public) or Zhao et al.'s GPS
  curves (Figure 10 shows days).
- **Camp-day demography.** The ACS fixture is 2018-2022 on 2020 block groups. Use ACS 2014-2018
  (needs the API with a key) on the 2018 block groups already in the Camp package.
- **2018 facility roster.** Registries are today's. CDPH publishes an "across time" summary file
  (`healthcare_facilities_across_time_summary_2026.csv`) that counts facilities by year, not a
  roster; Feather River Hospital and the Paradise nursing homes are not in the current files.
- **School capacity.** Enrolment only; no building capacity is published. Private schools are a
  separate CDE layer, not pulled.
- **CDSS status codes.** The layer does not define them; the extract keeps code 3 (almost all Butte
  rows) and calls it an assumption.
- **Transit.** The B-Line GTFS feed is listed on the Mobility Database (producer
  `planmyride.blinetransit.com`), but its licence is unstated and the current feed covers 2026
  service. Not downloaded. The Camp bus timeline is in the parameter file.
- **Survey bias.** Wong (online, gift-card incentive) and Grajdura (shelters and Facebook groups,
  78% female online) are convenience samples. Camp has no representative survey.
- **Whittaker et al. 2013** (Black Saturday, n=1,314) was read at abstract level only and is a
  pointer, not a source of a parameter.

## How to use it

**Residents generator.** For each block group draw households from `households`, split by vehicles
(`hh_no_vehicle`, `hh_1_vehicle`, `hh_2_vehicle`, `hh_3plus_vehicle`), then mark households as
carless, 65+ (`age_65plus` share of people), with a disability (tract share `disability`) or
limited-English (`limited_english`) using the shares from `tools.people_data.shares`. Draw from
the shares, not the margins: the `moe90` field says how loose a block group is, and disability
counts are tract totals repeated on each block group, so do not add them up. Seed every draw. Place
facilities as fixed groups of residents with their capacity: skilled nursing, intermediate care,
residential care and hospitals as people who need an assisted or ambulance pickup; schools and
child care as groups with staff vehicles and buses. Keep the evidence class `observed` on counts and
`simulated` on the people drawn.

**Traffic model.** (1) Replace `EVACUATION_PARTICIPATION = 1.0` with a draw in the order-compliance
range, 0.87 to 0.97, and report which end a run used. (2) Add a shadow demand: a share (0.29 to
0.75, suggested 0.30 as an assumption) of households in unordered block groups near the fire leave on
the fire or social cue. (3) Keep `VEHICLES_TAKEN_CAP = 2`; the observed mean is close. (4) Turn the
carless count into a pickup demand served by transit (B-Line timeline), neighbours (the Camp
record shows rides from strangers) or responders, and report unserved carless households instead of
dropping them. (5) Keep `wait_for_fire_share` at 0.07 as baseline and run 0.13 as the upper bound.
(6) Do not claim these numbers calibrate the model: they bracket it.
