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
| `sim/behavior_params.json` | Per-household behaviour: evidence entries plus the `legacy` and `grounded` profiles that `sim.behavior.draw_household_choices` draws from | hand-curated; see [Behaviour evidence](#behaviour-evidence) |
| `tools/people_acs_butte_fixture.json` | 200 Butte County block groups, ACS 2018-2022 | `census --counties 007 --source bulk` |
| `tools/people_facilities_butte_fixture.json` (local-only, not in git: CDPH, CDSS and CDE state no open licence; rebuild with `tools/people_data.py`) | 254 facilities and schools in Butte County | `facilities --counties Butte` |
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
  curves (Figure 10 shows days). Since found: Marshall 2021 mean and SD in minutes (awareness to
  departure) and Kincade GPS block-group medians after the order; see [Behaviour evidence](#behaviour-evidence).
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

## Behaviour evidence

Simulated households can draw their own behaviour, so they are not 100% obedient: some leave before any
warning, some wait until they see fire, some stay, some go back for a pet. The values and their sources
are in `sim/behavior_params.json` (`evidence`: one entry per finding with value, population, locator,
label and transferability; `profiles`: what the model draws). Labels: **sourced** (read in the cited
document), **derived** (arithmetic on sourced values, shown in the file), **assumption** (no source), **gap**
(looked for, not found, not used). Transferability: **high** = fast California WUI fire and population;
**medium** = another US fire or warning regime; **low** = stated intentions, Australian policy, another
hazard, or a qualitative count. Page numbers are printed pages except NIST TN 2103 (PDF pages; printed =
PDF - 5) and the McLennan et al. 2019 author preprint (manuscript pages).

### What the `grounded` profile draws

| Behaviour | Value (`grounded`) | Source | Transferability | Label |
| --- | --- | --- | --- | --- |
| First awareness of the fire | saw fire 0.446, told in person 0.263, call or text 0.171, online 0.069, TV or radio 0.038, official 0.013 | Grajdura 2022, Camp n=397, Table 1 p. 36 / Table 12 p. 103 | high for a no-notice fire; low with notice | sourced |
| Receives an official order (any time) | 0.19 | Grajdura 2022 p. 37 (p. 38 says 21%) | Camp only. Kincade 0.73 (Kuligowski 2022 p. 11), Marshall 0.65 (Forrister 2024 Table 4), Gatlinburg 0.031 order / 0.226 any warning (TN 2103 PDF pp. 19-22) | sourced |
| Phone alert (CodeRED-style call) reaches the household, by local hour | 0.17 default; 00-07 h 0.044, 07-11 h 0.182, 11-19 h 0.157, 19-24 h 0.235 | 0.17 = NIST TN 2252 pp. 43-44, Table 8 (6,573 of 20,926 numbers delivered, at most 17% of 39,000 people), scaled by the connect share of each hour band over the 0.55 mean (TN 2252 supplement Tables D-2/D-3, `tools/comms_degradation.json`) | low: a person-level bound used per household; after-midnight calls went to remote areas, so hour and place are confounded | derived |
| Order compliance (eventually leaves) | 0.875 | Wong et al. 2020 Table 11 p. 39, Oct 2017 N. California (0.870 to 0.968 across fires) | high (analogue choice is ours) | sourced |
| Shadow evacuation (no order, leaves on the fire cue) | 0.291 | Wong et al. 2020 Table 11 p. 39 (0.291 to 0.750) | medium | sourced |
| Stayers who defend (rest shelter at home) | 0.302 | TN 2103 PDF p. 32 (Gatlinburg stayers, N=43: 30.2% protect property); Wong Table 20 p. 51: 16.7% to 36.7% | medium; reasons are select-all | derived |
| Wait and see (leaves only on the fire cue), share of compliers | 0.13 = (0.17 x 2/3) / 0.875 | McLennan et al. 2019 preprint pp. 16-19: 17% of threatened residents intended to wait and see, two thirds of them left (8 Australian field studies, n=1,641) | low to medium; sensitivity 0.07 (`wait_for_fire_share`) to 0.33 (McLennan 2014 hypothetical 29%) | derived |
| Leaves before any warning, share of evacuating households | 0.423 = 0.33 / (0.33 + 0.07 + 0.38) | Zhao et al. 2022 Sec. 4.4.1 p. 16 (Kincade GPS) | medium: post-Tubbs population, slow fire | derived |
| Delay from trigger to departure | lognormal, median 42.8 min, sigma 1.246, cap 1,440 min (mean 92.7, p10 8.6, p90 219 in a 20,000 draw) | mean 93 min from Camp (Grajdura pp. 51-52, difference of means); sigma from Marshall's mean 136.59 and SD 263.44 min (Forrister 2024 Table 4 p. 8) | medium: Camp level, Marshall spread | derived |
| Sought more information before acting (milling) | 0.417 of evacuees | Wong Table 12 p. 41 (mandatory order; 0.298 to 0.500); Gatlinburg: 13.6% asked others what they would do (TN 2103 PDF p. 31) | high | sourced |
| Makes a trip before leaving | 0.595 of driving evacuees | Wong Table 16 p. 49 (1 - 0.405 with no trip; 0.595 to 0.800) | high | derived |
| Trip purpose | family 0.209, others 0.252, pet 0.151 (pet owners only), supplies 0.137, other or unknown 0.252 | Forrister et al. 2022, Marshall QR 349 Table 1 (shares of trip purposes; the report text gives 22/25/18/13%) | medium | sourced |
| Route strategy | navigation app 0.189, familiar 0.568, follow others 0.243 | navigation: Wong Table 10 p. 37 (used GPS and followed it, 0.075 to 0.189). The split of the rest reuses `herding_prob` 0.3 | high for the app share; the split is an assumption | assumption |
| Reroutes when queued | 0.25 | none: Kincade comments, 5 of 192 took back roads (Kuligowski 2022 p. 18) | n/a | assumption |
| Destination type | friends or family 0.486, hotel (incl. Airbnb) 0.243, public shelter 0.054, RV or camping 0.081, other 0.135 | Wong Table 10 p. 37 (Oct 2017); Marshall QR 349 agrees: 0.458 / 0.198 / 0.085 | high | sourced |
| Has pets | 0.759 | Wong Table A1 p. 61 (0.637 to 0.817); Kincade 0.796, Gatlinburg 0.676, Marshall animals 0.346 | medium (convenience samples) | sourced |
| Vehicles taken | one 0.405, two 0.432, three 0.135 | Wong Table 10 p. 38 (Oct 2017; "more than two" drawn as 3) | high | sourced |
| Needs assistance to evacuate | 0.078 (plus every no-vehicle household) | Kincade, 15 of 192 survey commenters (Kuligowski 2022 pp. 17-18); households with a disability 0.14 to 0.19 (Wong Table A1) is an upper bound | low | derived |
| No-vehicle household | ACS per zone (Butte 0.0608) | ACS 2018-2022 B25044 | high | sourced |
| Asks for help: no vehicle / needs assistance | 0.5 / 0.5 | none (Grajdura p. 74: at least 7% needed a stranger's or police vehicle or walked) | n/a | assumption |

### Evidence recorded but not drawn

| Behaviour | Value | Source | Why not drawn |
| --- | --- | --- | --- |
| Delay by first source of awareness | official notice -91.3 min (p = 0.099), told in person -21.5, saw fire +4.9 (n.s.); having received an order +47.1 (p < 0.01) | Grajdura Table 3 p. 46 | not significant; the order effect is reverse-causal (orders arrived after people left) |
| Delay after the zone's order or warning, Kincade GPS | mean of block-group medians 2.684 h (SD 3.500, max 17.0 h); 0 when people left before the order | Sun et al. 2024 Table 1 p. 12 | block-group medians, not a household distribution; a slow fire with days of notice |
| Delay by time of day | later awareness, shorter gap: Camp 0.743 min departure per min, Marshall -0.724 min delay per min | Grajdura Table 3 p. 46; Forrister Table 7 p. 9 | within-event urgency, not a clock effect; the twin's fire cue carries it. No delay by clock hour was found (gap) |
| Night departures | 50.8% (Dec 2017), 72.5% (Carr) | Wong et al. 2023 Table 6 | hour of departure, not a delay |
| Official order channels | Kincade: text 64%, social media 36%, email 28%, recorded call 25%, siren 24%, radio 21%; told by someone 44% | Kuligowski 2022 p. 11 | for a scenario with notice; Camp sent no WEA (NIST p. 42) |
| Order channels, Wong | e.g. reverse 911 8.3/34.1/38.8%, official in person 41.7/32.6/30.3%, someone told you 37.5/26.8/36.2% | Wong Table 12 p. 40 | channel mix, not reach |
| Away from home when warned, went back | NSW 2013: 58% away, 64% of them tried to return, 80% got there; Perth Hills 2014: 84% tried | McLennan et al. 2019 preprint p. 18 | the model does not know who is away; supports the trip draw |
| Australian actual responses | Black Summer residents: left before fire 38%, defended 20%, sheltered inside 4%; Black Saturday: defended 53%, sheltered 4%, left 43%, 54% of leavers left late | Whittaker et al. 2021 p. 12; McLennan 2019 pp. 17-18 quoting Whittaker 2013 | stay-and-defend is endorsed in Australia |
| Self-evacuation archetypes | e.g. experienced independent 20.3%, community guided 18.4%, threat denier 13.6% (n=457) | CFA/BNHCRC 2020 Table 6 p. 48 | a typology, not rates |
| Fort McMurray preparation time | none 11.7%, < 15 min 16.9%, 15-60 min 39.1%, 1-2 h 16.6%, > 2 h 8.6% | McGee 2018 p. 1157 | cross-check below |
| Persons per vehicle | 1.38 derived (Camp household size 2.37 / 1.72 vehicles); NIST bounds 1.0 to 2.5, 2.0 "conservative" | Grajdura Table 1; Wong Table 10; NIST p. 155, p. xxvi | two samples joined; no survey measures it |
| Camp outcome checks | 66 of 85 deaths not evacuating; 3 of 881 Paradise EA/R civilians refused to leave; at least 1,222 civilians in temporary refuge areas; 235 abandoned vehicles; 198 EA/R events (64 assistance requests, 38 pick-ups) | NIST pp. 218, 193, 155, 116-117, xxvii | outcomes to compare against, not inputs |

### Simulation Studio

The Studio's evacuation (`app/src/studio/householdBehavior.ts`, on by default as "Like real
evacuations") draws two `grounded` values per synthetic home, seeded by the road area and home index:
order compliance 0.875 (the rest stay home) and the departure delay lognormal (median 42.8 min, sigma
1.246, cap 1,440 min) from the zone's order. The dispatch engine applies them
(`DispatchEngine.setDepartureDelays`); without them it keeps its uniform 45 min spread. Shadow evacuation
and wait-and-see are not drawn there yet. The values reach TypeScript through
`app/src/studio/behaviorParams.generated.ts`; regenerate it after editing `sim/behavior_params.json` with
`python3 -m tools.gen_behavior_ts` (`--check` reports drift). The Studio's people strip and map layer
convert vehicles to people at 1.38 persons per vehicle (`app/src/studio/peopleSnapshot.ts`), an estimate.

### Gaps (assumption or nothing)

- Direction of family pickup trips (toward the fire or away): no count. NIST TN 2252 p. 65 mentions parents
  possibly going back to Ponderosa Elementary; the model draws family trips, not their direction.
- Returns into a closed or burning zone after leaving: no rate (also `tools/people_behavior.json`).
- Familiar route vs following other cars, and rerouting in congestion: no survey share.
- Time spent milling: no minutes; it is inside the total delay.
- Share of no-vehicle or assistance-needing households that ask for help: no source; 0.5 kept.
- Delay by warning channel or clock hour: none significant or published.
- Not read (paywalled or blocked): Strahan et al. 2018, Strahan and Watson 2019, Whittaker et al. 2013 full
  text, Haynes et al. 2010, KPMG 2017 (Fort McMurray), Lindell and Perry 2012, Grajdura et al. 2021, any
  Woolsey survey, Heath et al. 2001 full text.

### Cross-check

Fort McMurray preparation shares (normalised over the 92.9% who answered) against the `grounded` delay
lognormal: under 15 min 0.308 vs 0.200 drawn; 15-60 min 0.421 vs 0.407; 1-2 h 0.179 vs 0.189; over 2 h 0.093
vs 0.204. The drawn delay is awareness to departure (it includes deciding and trips), so it should run longer
than preparation alone; the tail does. This is not a calibration.

### Measured on the Camp twin (2026-10-24)

Camp twin from 14:30Z to 16:30Z, residents seed 3, 19,913 households in 43 zones.

| Run | Events | Twin vehicles | Noncompliant households | `staying` check-ins | `need_help` | `out` | Destination choices |
| --- | --- | --- | --- | --- | --- | --- | --- |
| default before this change (HEAD) | 1,137 (sha256 of events `4f67fb03c429b39a`) | 31,638 | 0 | 82 | 75 | 90 | 402 |
| default after this change | 1,137 (same sha), twin fingerprint `dbe294975d1426a3` unchanged | 31,638 | 0 | 82 | 75 | 90 | 402 |
| `twin.people: grounded` + `behavior_profile: grounded` | 1,310 | 27,680 | 2,340 (12.5% of vehicle households) | 387 | 87 | 62 | 316 |

Drawn shares in the grounded run (all 19,913 households): evacuate 0.758, wait and see 0.116, shelter in
place 0.091, stay and defend 0.035; left before any warning 0.321; sought information 0.371; trip before
leaving 0.493 (family 0.108, others 0.126, pet 0.060, supplies 0.071, other 0.128); route familiar 0.465,
follow others 0.203, navigation 0.155; destination friends or family 0.428, hotel 0.209, other 0.121,
RV or camping 0.070, public shelter 0.047; pets 0.763; needs assistance 0.131 (no-vehicle households
included); asks for help 0.064; drawn delay p10 8.8, median 44.1, p90 210.5, mean 91.9 min. Twin
vehicles departed by 16:00 / arrived by 18:00: historical 1,008 / 9,325; camp_2018_sourced 376 / 7,445;
grounded 906 / 8,409 (the shorter median delay outweighs the lower compliance before 16:00).

### How it is used

```python
from sim.behavior import HouseholdContext, draw_household_choices, PEOPLE_PRESETS
c = draw_household_choices(seed, "sim_bd10e8095e53b36e", "grounded", HouseholdContext(has_vehicle=True, local_hour=8))
c.protective_action, c.departure_trigger, c.departure_delay_min, c.trip_before_leaving, c.narrative()
c.sources["protective_action"]  # [{"param": "order_compliance", "label": "sourced", "evidence": [...]}, ...]
```

- Every choice draws from its own stream, `random.Random(f"{seed}:household-choice:{household_key}:{choice}")`,
  so households are independent and changing one parameter shifts only the draws of that choice (a choice
  that depends on another, such as the trip purpose, is drawn only when needed).
- Profiles: `legacy` reproduces today's behaviour (everyone told, everyone leaves after the 30 min lognormal,
  no trips, half of no-vehicle households ask for transport); `grounded` is the table above.
- Residents generator: `ResidentParams(behavior_profile="grounded")`. Default `None` leaves the population
  and every event unchanged. With a profile, drawn stayers are the noncompliant households (replacing
  `noncompliant_share` and `staying_share`), the twin's zone vehicles are shared by drawn vehicles, the
  departure order follows drawn trigger then delay (the twin still decides how many leave), and no-vehicle
  households ask for transport when their draw says so. Each `Household` has `choices`;
  `ResidentGenerator.household_choices(party_key)` returns them with sources and a narrative ("went back for
  a pet before leaving"). Trips, routes, rerouting and destination types are recorded, not simulated: the
  fixed-delay twin does not move vehicles by them.
- Twin: `twin.people: "grounded"` (`PEOPLE_PRESETS["grounded"]`, from the same profile) sets compliance
  0.875, shadow 0.291 and the delay lognormal (median 42.8, sigma 1.246; the twin keeps its 360 min cap).
  The batch runner then sets `residents.behavior_profile: "grounded"` too, unless the spec sets it.
