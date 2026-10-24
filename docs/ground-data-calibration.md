# Ground-data calibration: Camp Fire 2018 (911, radio, rescue)

Empirical rates for a future generator of synthetic 911 calls, radio traffic and rescue
requests. Code: [`sim/ground_rates.py`](../sim/ground_rates.py) (stdlib only), with
`fit_camp_2018() -> GroundRateParams`. Tests: `python3.12 -m unittest tests.test_ground_rates`.
The numbers below come from a run on 2026-10-24 with `tools/camp_ground_record.json`
(ground-record-1) and `app/public/replays/camp-2018.json`. They are not wired into the app.

**What this is:** a description of one sampled, retrospectively transcribed record (NIST TN 2252
and TN 2252sup). **What it is not:** a call-centre volume, a forecast, or an operational rate.

## Conventions

- **Time:** every timestamp is UTC. The source clock was PST (UTC-08:00; DST had ended on
  2018-11-04), and the record already holds `at = PST + 8 h` at 1-minute resolution. Local
  times are shown in brackets. Offsets are in minutes.
- **Rates:** events per 1,000 households per hour (`/kHH/h`). Exposure is in 1,000
  household-hours (kHH·h). Households are from the bundle's 43 block-group zones (19,913 HH).
- **Distance:** metres, measured on the bundle's 200 m arrival grid (local equirectangular
  projection; the test checks that our grid reproduces the bundle's metres per degree).
- **Uncertainty:** medians carry seeded percentile-bootstrap 95% intervals (seed 20181108,
  2,000 resamples). Count CIs use Byar's approximation (Breslow & Day 1987), with the exact
  bound for a count of zero.

## Inputs and bases

| Quantity | Basis | Source in the bundle |
| --- | --- | --- |
| Zone of a row | Point-in-polygon of the row's `coord` in the block-group zones | `zones` |
| **Zone fire arrival (primary)** | **Observed:** earliest non-residual NIST fire observation inside the zone, excluding observations sourced from 911 calls or the radio log (otherwise the arrival would be timed from the rows being measured). Available for 36/43 zones. | `fire_observations` (reconstructed) |
| Zone fire arrival (sensitivity) | **Modelled:** the earliest `rothermel-mtt` arrival-grid cell in the zone. Available for 32/43 zones. | `insights.zones[].fire_arrival_at` (simulated) |
| Fire distance | **Modelled:** distance from the zone centroid to the nearest burning arrival-grid cell at the bin midpoint | `fire_simulated.arrival_grid` |
| Order time | First `evacuation_order` crosswalked to the zone (all 43 zones) | `insights.zones[].order_at` |

Observed arrival is late-biased, because an observation shows fire present rather than first
arrival. Where both exist (31 zones), the observed arrival is a median **19 min later** than
the modelled one (IQR 8 to 61 min). The model's held-out arrival error is a median of 104 min
(bundle `fire_simulated.calibration`). I used observed arrival for the offsets because a
generator will treat its own simulated arrival as the truth for its scenario. Calibrating
against Camp's modelled arrival would bake Camp's model error into the generator.

Rows used: 911 = 93 (90 with a coordinate, all 90 inside a zone), radio = 263 (250 / 244),
rescue (K-1) = 196 (190 / 185). Notification (35) and evacuation (18) rows come from summary
tables and have no coordinates, so they are not rate-modelled.

## 1. Timing relative to zone fire arrival

Row time minus observed zone arrival, in minutes. The counts are rows; bin labels are start inclusive.

| Offset (min) | <-240 | -240 | -180 | -120 | -60 | 0 | 60 | 120 | 180 | 240-359 | 360-599 | >=600 | n |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 911 | 3 | 1 | 1 | 4 | 17 | 32 | 28 | 3 | 0 | 0 | 0 | 0 | 89 |
| radio | 3 | 0 | 2 | 4 | 20 | 55 | 57 | 32 | 16 | 22 | 16 | 13 | 240 |
| rescue (K-1) | 0 | 1 | 2 | 4 | 9 | 33 | 49 | 22 | 14 | 25 | 18 | 4 | 181 |

The module stores 30-minute bins (`offset_hist_observed`).

| Channel | n | Median (min) [95% CI] | IQR (min) | Median, modelled-arrival basis |
| --- | --- | --- | --- | --- |
| 911 | 89 | **+34** [19, 44] | -2 to +74 | +53 [40, 65] (n 86) |
| radio | 240 | **+88** [71, 107] | +39 to +194 | +115 [103, 138] (n 229) |
| rescue | 181 | **+106** [82, 135] | +56 to +240 | +134 [110, 165] (n 177) |

By category (observed basis): median offset and IQR in minutes, with n.

| Channel | help_needed | trapped | fire_seen | road_blocked | heavy_traffic | evacuation_order |
| --- | --- | --- | --- | --- | --- | --- |
| 911 | +39 (-5..70), 37 | +87 (76..94), 13 | +8 (-9..30), 6 | -172 (-807..37), 5 | +36, 2 | +1 (-9..30), 14 |
| radio | +130 (52..303), 36 | +97 (70..291), 15 | +114 (34..230), 18 | +85 (40..263), 19 | +76 (30..124), 42 | -9 (-45..16), 20 |
| rescue | +102 (32..229), 104 | +106 (68..267), 77 | none | none | none | none |

The 911 sample ends at 18:06Z (10:06 PST), so 911 offsets are truncated on the right. An offset
of +3 h or more is "not estimable" for 911, not "zero".

## 2. Per-zone rate model

Unit: zone × UTC hour inside each channel's coverage window (first to last row of that channel,
by hour). Covariates at the bin midpoint:

- **Distance band:** `fire_in_zone` means the modelled arrival in the zone has passed. The other
  bands are by centroid-to-front distance: `lt_2km`, `2_5km`, and `ge_5km_or_unreached`.
- **Order phase:** `before_order`, `order_0_2h`, `order_ge_2h`.

I fixed the bands before fitting. For the GLM I then merged `lt_2km` with `2_5km` into `lt_5km`
after seeing that `lt_2km` held about 1% of exposure: the modelled front crosses a zone's 2 km
ring in under an hour. This is a post-hoc merge.

### Empirical table (the defensible output)

Rate in /kHH/h, with the 95% CI and events / exposure in kHH·h. Cells with no exposure are omitted.

| Channel | Band | Phase | Events | Exposure | Rate [95% CI] |
| --- | --- | --- | --- | --- | --- |
| 911 | fire_in_zone | before_order | 4 | 1.9 | 2.14 [0.58, 5.47] |
| 911 | fire_in_zone | order_0_2h | 65 | 23.0 | **2.82** [2.18, 3.60] |
| 911 | fire_in_zone | order_ge_2h | 3 | 11.1 | 0.27 [0.06, 0.79] |
| 911 | lt_2km | order_0_2h | 3 | 3.2 | 0.93 [0.19, 2.71] |
| 911 | 2_5km | before_order | 8 | 5.6 | 1.43 [0.62, 2.83] |
| 911 | 2_5km | order_0_2h | 1 | 4.5 | 0.22 [0.00, 1.24] |
| 911 | ge_5km_or_unreached | before_order | 4 | 27.0 | 0.15 [0.04, 0.38] |
| 911 | ge_5km_or_unreached | order_0_2h | 2 | 3.1 | 0.65 [0.07, 2.33] |
| 911 | ge_5km_or_unreached | order_ge_2h | 0 | 0.3 | 0 [0, 11.2] |
| radio | fire_in_zone | before_order | 13 | 2.5 | 5.18 [2.76, 8.86] |
| radio | fire_in_zone | order_0_2h | 102 | 23.4 | **4.35** [3.55, 5.28] |
| radio | fire_in_zone | order_ge_2h | 104 | 226.0 | 0.46 [0.38, 0.56] |
| radio | lt_2km | order_0_2h | 0 | 3.2 | 0 [0, 1.14] |
| radio | 2_5km | before_order | 6 | 5.6 | 1.08 [0.39, 2.34] |
| radio | 2_5km | order_0_2h | 1 | 4.5 | 0.22 [0.00, 1.24] |
| radio | 2_5km | order_ge_2h | 1 | 28.4 | 0.04 [0.00, 0.20] |
| radio | ge_5km_or_unreached | before_order | 6 | 53.2 | 0.11 [0.04, 0.25] |
| radio | ge_5km_or_unreached | order_0_2h | 4 | 8.7 | 0.46 [0.12, 1.18] |
| radio | ge_5km_or_unreached | order_ge_2h | 7 | 42.7 | 0.16 [0.07, 0.34] |
| rescue | fire_in_zone | before_order | 0 | 2.1 | 0 [0, 1.77] |
| rescue | fire_in_zone | order_0_2h | 80 | 23.4 | **3.41** [2.71, 4.25] |
| rescue | fire_in_zone | order_ge_2h | 91 | 341.0 | 0.27 [0.22, 0.33] |
| rescue | lt_2km | order_0_2h | 3 | 3.2 | 0.93 [0.19, 2.71] |
| rescue | 2_5km | before_order | 1 | 5.6 | 0.18 [0.00, 1.00] |
| rescue | 2_5km | order_0_2h | 1 | 4.5 | 0.22 [0.00, 1.24] |
| rescue | 2_5km | order_ge_2h | 5 | 43.9 | 0.11 [0.04, 0.27] |
| rescue | ge_5km_or_unreached | before_order | 1 | 33.8 | 0.03 [0.00, 0.17] |
| rescue | ge_5km_or_unreached | order_0_2h | 1 | 8.7 | 0.12 [0.00, 0.64] |
| rescue | ge_5km_or_unreached | order_ge_2h | 2 | 71.5 | 0.03 [0.00, 0.10] |

### Poisson GLM (log link, offset log(kHH·h), fitted by IRLS in stdlib)

`rate = exp(intercept + band + phase)`. The reference levels are `ge_5km_or_unreached` and
`before_order`. "SE" is the Poisson standard error. "qSE" is the quasi-Poisson SE, multiplied
by √dispersion; use qSE.

| Term | 911 coef (SE / qSE) | RR | radio coef (SE / qSE) | RR | rescue coef (SE / qSE) | RR |
| --- | --- | --- | --- | --- | --- | --- |
| intercept | -1.608 (0.41 / 0.77) | 0.20 /kHH/h | -1.397 (0.25 / 0.47) | 0.25 /kHH/h | -3.761 (0.78 / 1.08) | 0.023 /kHH/h |
| band: fire_in_zone | 2.672 (0.51 / 0.96) | 14.5 | 2.714 (0.32 / 0.60) | 15.1 | 2.702 (0.53 / 0.73) | 14.9 |
| band: lt_5km | 1.532 (0.53 / 0.99) | 4.6 | 0.579 (0.45 / 0.84) | 1.8 | 1.335 (0.60 / 0.83) | 3.8 |
| phase: order_0_2h | -0.048 (0.34 / 0.65) | 0.95 | 0.140 (0.28 / 0.52) | 1.15 | 2.244 (0.74 / 1.03) | 9.4 |
| phase: order_ge_2h | -2.370 (0.67 / 1.26) | 0.09 | -2.046 (0.28 / 0.53) | 0.13 | -0.233 (0.75 / 1.03) | 0.79 |
| window (UTC) | 15:00-19:00Z 11/08 | | 14:00Z 11/08-10:00Z 11/09 | | 15:00Z 11/08-18:00Z 11/09 | |
| zone-hours / events | 172 / 90 | | 860 / 244 | | 1,161 / 185 | |
| deviance / null | 250.3 / 339.4 | | 866.0 / 1192.9 | | 678.3 / 967.9 | |
| pseudo-R² (1 - D/D0) | 0.26 | | 0.27 | | 0.30 | |
| Pearson dispersion | 3.53 | | 3.53 | | 1.92 | |

How good is the fit:

- It explains about a quarter of the deviance.
- It is overdispersed by 2 to 3.5 times. Calls cluster in zones and minutes (one burnover or
  one block produces many rows), so a generator should draw with overdispersion, for example a
  negative binomial or a Poisson with a zone-level gamma frailty. A plain Poisson draw would be
  too smooth.
- The one robust effect is `fire_in_zone`. Its rate ratio is about 15 for all three channels,
  and it is several qSEs from zero.
- `lt_5km` is only weakly identified: its qSE is close to its coefficient.
- Order phase is confounded with fire arrival, because most orders came at or after the fire.
  The exposure for `fire_in_zone × before_order` is only about 2 kHH·h. The rescue
  `order_0_2h` effect rests on 2 rescue rows before any order and should not be read as causal.
- No out-of-sample validation was run. With one fire, 43 zones and one record, a held-out score
  would mostly measure noise.

## 3. Category mix and lag structure

Category shares before and after the zone's observed arrival (rows in zones with an arrival):

| Channel | Phase | n | help_needed | trapped | fire_seen | road_blocked | heavy_traffic | other |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 911 | before arrival | 26 | 0.42 | 0.04 | 0.12 | 0.12 | 0.00 | 0.31 |
| 911 | after arrival | 63 | 0.41 | 0.19 | 0.05 | 0.03 | 0.03 | 0.29 |
| radio | before arrival | 29 | 0.14 | 0.00 | 0.03 | 0.10 | 0.17 | 0.55 |
| radio | after arrival | 211 | 0.15 | 0.07 | 0.08 | 0.08 | 0.18 | 0.45 |
| rescue | before arrival | 16 | 0.94 | 0.06 | 0 | 0 | 0 | 0 |
| rescue | after arrival | 165 | 0.54 | 0.46 | 0 | 0 | 0 | 0 |

"other" pools `other`, `evacuation_order`, `evacuation_progress` and `shelter`. The categories
come from the record builder's keyword rules, not from a human coder.

Hourly 911 counts by category. All 93 rows fall between 15:00 and 19:00Z (07:00-11:00 PST):

| UTC hour (PST) | help_needed | trapped | fire_seen | road_blocked | heavy_traffic | other |
| --- | --- | --- | --- | --- | --- | --- |
| 15Z (07) | 1 | 1 | 4 | 2 | 0 | 12 |
| 16Z (08) | 21 | 7 | 3 | 2 | 1 | 12 |
| 17Z (09) | 16 | 5 | 0 | 1 | 1 | 3 |
| 18Z (10) | 1 | 0 | 0 | 0 | 0 | 0 |

The 911 mix shifts from situational reports (fire seen, orders) in the first hour to
help_needed and trapped calls at 16-17Z. Radio peaks at 17Z with 61 rows, of which 19 are
heavy_traffic and 11 road_blocked. Rescue (K-1) is 77% trapped/help_needed at 15-17Z and
continues at 0 to 18 rows per hour until 01Z 11/09.

**Road lags:**

- **Radio vs the bundle's historical road events.** There are 8 non-simulated
  `road_blocked`/`road_closed` events. Only one (`nist-a2-0918-vtd32`) is the same NIST source
  row as a record row; the others come from Table A-2 info sources that the record drops. For
  the 5 events whose label names a road that also has a radio `road_blocked` row, the nearest
  radio row precedes the event by 0, 2, 13, 28 and 106 min. With n = 5 this supports nothing
  stronger than "radio reports of blockage do not lag the documented closures".
- **Radio vs the modelled (simulated) road closures.** For 19 of the 24 radio `road_blocked`
  rows there is a modelled closure on the same named road within 1 km. The radio row comes a
  median **+56 min** after the modelled closure (IQR -83 to +205). The spread is wide: on the
  same road the model closes some segments hours early and others late. Not estimable for the
  other 5 rows (no modelled closure nearby).

## 4. Radio vs 911, and rescue vs 911

- **Radio : 911 within the 911 coverage window** (15:08-18:06Z, 07:08-10:06 PST): 134 radio
  rows to 93 911 rows, a ratio of **1.44** (95% CI 0.97 to 2.38, seeded bootstrap over 10-minute
  blocks). The whole-record ratio of 263 : 93 = 2.8 is misleading, because radio continues for
  15 hours after the 911 sample ends.
- **Rescue (K-1) vs 911.** 39 of the 190 K-1 rows with a coordinate fall within 1 minute and
  300 m of a 911 row. Counting only the 90 K-1 rows inside the 911 coverage window, where a
  partner call can exist, 39 of 90 (43%) coincide (`rescue_rows_coinciding_with_911_in_window`).
  In 18 zones that have both, the first K-1 row is a median **0 min** after
  the first 911 help_needed/trapped row (IQR 0 to 0; range -54 to +67). K-1 times are each
  event's *first datapoint*, which is often the 911 call itself. **K-1 is not an independent
  later "rescue request" stream:** a generator that emits a 911 call and a K-1 rescue for the
  same incident should give them the same time unless it models dispatch separately. A
  dispatch or rescue delay is **not estimable** from this record.
- In the offset distributions, K-1 is centred later than 911 (+106 vs +34 min). That comes from
  its longer tail into the night, not from a delay per incident.

## 5. Biases and scaling factors

| Bias | Evidence | Factor for a generator | Source |
| --- | --- | --- | --- |
| 911 is a NIST sample, not the call volume | 93 rows from 84 distinct NIST call ids (`911-NNN`). In 14:30-16:20Z (06:30-08:20 PST) the record holds 36 distinct calls. | Multiply 911 counts in that window by **at least 3.67** (132 / 36). It is a lower bound because the figure is "at least 132", counts only answered calls, and counts only the Paradise Police center. | San Francisco Chronicle, 2019-01-20, review of Paradise Police dispatch audio: "at least 132" calls answered between 06:30 and 08:20 PST, when calls were rerouted to Chico ([article](https://www.sfchronicle.com/california-wildfires/article/Camp-Fire-911-calls-As-flames-raced-in-13541139.php)). KRCR reported "at least 130". |
| 911 after 16:20Z / 08:20 PST | PPD calls were rerouted to Chico; the NIST rows continue to 18:06Z | **Not estimable** | Same as above |
| Radio-log completeness | The record keeps A-2 rows whose Info. Source is the radio log; how much traffic the log captured is not stated | **Not estimable** (use the counts as a floor) | Record header `interpretation` |
| K-1 coverage | 196 of 198 parsed rows (2 had no time); the K-1 share of all rescues is not stated | **Not estimable** | Record header `extraction` |
| K-1 dates | K-1 has clock times only; rows after the 23:30 PST row whose times run backwards are dated 11/9. That is 4 rows at or after 08:00Z 11/09. A wrong date moves a row by exactly 24 h. | none; treat rows after 08:00Z 11/09 as uncertain | Record header `interpretation` |
| Coordinate coarsening | Rows naming a residential street are rounded to 2 decimals (about 1 km). At most 6/90 911, 52/244 radio and 2/185 rescue zone-assigned rows are 2-decimal (an upper bound: a 3-decimal value ending in 0 looks the same). | none; zone misassignment possible for about 21% of radio rows | Record header `coordinate_precision` |
| Time conversion | PST to UTC at +8 h; no DST ambiguity on 11/08-09; 1-minute resolution; 223 rows are `approximate` (window start or summary time) | none | Record header `time_conversion` |
| De-identification and categorization | Free text dropped; categories come from keyword rules; road names limited to main roads | none; the category mix carries rule error that has not been measured | Record header `de_identification` |
| Observed arrival is late | Earliest observation ≥ true arrival; zones with few observations are later still (7 zones have none and so no observed arrival; 2 rest on a single observation) | Offsets in Q1 are biased early by an unknown amount (tens of minutes at most where observations are dense) | Bundle `fire_observations.notes` |

## What a generator may and may not claim

May:

- generate ground reports whose **timing relative to fire arrival** follows Q1, whose
  **per-zone intensity** follows the empirical table or the GLM, and whose **category mix**
  follows Q3;
- scale 911 volume by ≥ 3.67 in the first two hours and say it is a lower bound from a
  newspaper's count;
- label every generated item `simulated`, calibrated to the "NIST TN 2252 sample of the 2018
  Camp Fire".

May not:

- present generated items as observed, historical or live calls;
- claim absolute 911 volumes after 08:20 PST, radio volumes, rescue volumes or dispatch delays
  (all not estimable here);
- claim the rates transfer to another fire, town, time of day or alerting regime. This is one
  fire, at about 06:30 PST, with a very fast front;
- read the order-phase coefficients as the effect of issuing an order. They are confounded
  with fire arrival.

## Reproduce

```sh
python3.12 -m unittest tests.test_ground_rates          # 14 tests, about 6 s
python3.12 -c "from sim.ground_rates import fit_camp_2018; import json; print(json.dumps(fit_camp_2018().to_dict(), indent=1, default=str))"
```

## Generator

[`sim/gen_comms.py`](../sim/gen_comms.py) turns these parameters into seeded synthetic 911,
radio and rescue items for any scenario ([ADR 0035](adr/0035-comms-generator.md)). It is stdlib
only and pure. Tests: `python3.12 -m unittest tests.test_gen_comms`.

```python
generate_comms(zones: Sequence[CommsZone], roads: Sequence[RoadEdge],
               window_utc: tuple[datetime, datetime], params: GroundRateParams, seed: int,
               options: CommsOptions = CommsOptions()) -> list[dict]
```

- `CommsZone(id, households, centroid_lonlat, geometry, fire_arrival_at=None, order_at=None,
  fire_distance_m=None)`: times are aware UTC. `fire_distance_m(at)` returns metres to the
  nearest burning point, `None` while nothing burns, and 0 once fire is in the zone.
- `RoadEdge(id, name, coords)`, in the bundle's `roads.edges` shape (`roads_from_bundle`).
- `CommsOptions(scale_911=None, nist_sample_like=False, psap_reroute_at=None,
  overdispersion=True, channels=("911", "radio", "rescue"), bursts=True)`. `scale_911=None`
  means `params.scale_911_at_least` (3.67, a lower bound). `nist_sample_like=True` uses 1.0.
  `bursts=False` gives the earlier output bit for bit (see Bursts below).
- Params without the bundle: `params_from_dict(json.load(open("tests/fixtures/ground_rates_camp_2018.json")))`.
  The fixture is a snapshot of `fit_camp_2018()`, and a test compares it with a fresh fit when
  the bundle is present.

**Output.** Each item has the record's keys (`id`, `at`, `time_precision`, `channel`,
`category`, `road_name`, `coord`, `summary`, `evidence_class`, `source_locator`,
`text_sha12`) plus `generator`, `params_hash` and `seed`, sorted by `at`:

- `evidence_class` is `"simulated"` and `time_precision` is `"minute"`. `at` is floored to the
  minute.
- `summary` comes from the record template (`tools.camp_ground_record.summary_for`).
- `text_sha12` is `null`, because a generated item has no source text.
- `coord` is rounded to 3 decimals. For road_blocked and heavy_traffic it is snapped to the
  nearest named road and `road_name` is set. Otherwise it is a uniform point inside the zone,
  kept only if the rounded point stays inside, so the zone can be recovered from the point.
- `source_locator` names the generator, seed, params hash and zone.
- `write_items_json(path, items, seed=, params_hash_hex=)` writes the record's file layout.

**Process** (each step and its source):

| Step | Model | Basis |
| --- | --- | --- |
| Rate | `exp(intercept + band + phase)` /kHH/h from each channel's GLM (section 2), × households/1000, × `scale_911` for 911 | Calibrated |
| Bands | `fire_in_zone` from the arrival; `lt_5km` from `fire_distance_m` < 5 km, or else the 33 min before arrival | Bands calibrated; lead time assumed (Camp median) |
| Time | Non-homogeneous Poisson by thinning (Lewis & Shedler 1979) | Exact for any rate path |
| Zone factor | Mean-1 gamma, shape `k = mean(mu)/(dispersion - 1)`: 911 0.207, radio 0.112, rescue 0.173. One factor is shared, and radio and rescue add an independent gamma (shapes 1.43 and 6.18) so that each channel's variance is `1/k`. With bursts, `dispersion - 1` becomes `dispersion - within-zone dispersion` for radio and rescue (shapes 0.185 and 0.346) | Dispersion calibrated; sharing assumed |
| Bursts | Radio and rescue rows come in within-zone clusters in time (Bursts below) | Cluster size and width calibrated; size law assumed |
| Category | Before- or after-arrival mix (section 3), with "other" kept pooled | Calibrated |
| Rescue | 39/90 of entries (the in-window share) take the time and point of a 911 call of the same category (help_needed or trapped) in the zone, within 60 min, one call per entry | Share calibrated; window and matching assumed |
| Reroute | 911 calls at or after `psap_reroute_at` are dropped. Rescue may still bind to them | Event from the calibration source; rescue rule assumed |

**Assumptions** (constants in the module, all `ASSUMED_*`):

- `ASSUMED_LT5KM_LEAD_MIN = 33`: the `lt_5km` band without a distance function. This is
  Camp's modelled median (IQR 23-66, n 28).
- `ASSUMED_RATES_TIME_HOMOGENEOUS`: no time-of-day effect. The 911 GLM saw only 15-19Z.
- `ASSUMED_SCALE_911_ALL_TIMES`: the 3.67 lower bound is applied after 16:20Z too.
- `ASSUMED_ZONE_FACTOR_SHARED`: one zone factor drives all channels.
- `ASSUMED_ZONE_FACTOR_TRANSFERS`: the shape fitted on block groups (median 414 HH) is used for
  zones of any size.
- `ASSUMED_OTHER_CATEGORY_POOLED`: "other" stays pooled.
- `ASSUMED_RESCUE_BIND_MAX_MIN = 60` and `ASSUMED_RESCUE_BIND_ONE_TO_ONE`.
- `ASSUMED_REROUTE_KEEPS_RESCUE`: a rerouted call still happened.
- `ASSUMED_ROAD_SNAP_MAX_M = 2000` and `ASSUMED_POINT_TRIES = 1000`.

**Validation** (measured 2026-10-24):

- **Camp reproduction.** On the 43 Camp zones (modelled arrival and front distance), at scale 1,
  the expected count in each channel's coverage window is 911 **91.4** (record 90), radio
  **245.3** (244) and rescue **185.9** (185). This is a test.
- **Camp round trip** without bursts (`bursts=False`; scratch script, not a test; 200 seeds at
  scale 1, refitting the GLM with `ground_rates.fit_channel` on 30 of them). The same run with
  bursts is under Bursts below.

  | Channel | Record | Generated mean (SE) [median] | Dispersion: record vs refit median (range) |
  | --- | --- | --- | --- |
  | 911 | 90 | 98.3 (2.9) [92] | 3.53 vs 2.95 (1.70-15.1) |
  | radio | 244 | 254.8 (9.9) [218] | 3.53 vs **1.93** (1.18-5.21) |
  | rescue | 185 | 198.5 (6.6) [177] | 1.92 vs 1.83 (0.94-4.61) |

  The means sit 1 to 2.4 SE above the analytic expectation. The three channels share one zone
  factor, so these are not three independent deviations, and the synthetic check below found no
  bias over 4,000 seeds. The refitted coefficients scatter around the input values by about
  one qSE. For example, the 911 `fire_in_zone` refit median is 2.29 against an input of 2.67
  (qSE 0.96).

  **Disagreement:** the radio refit dispersion has a median of 1.9, against 3.5 in the record.
  The zone factor is constant over time, so it cannot produce the within-zone bursts in time
  (one burnover, many radio rows in a few minutes) that the record shows. With radio's very
  heavy gamma (k = 0.11), the Pearson statistic is also strongly right-skewed over 43 zones, and
  the record's 3.53 falls inside the generated range. I trust the record. The generator
  under-represents radio clustering in time, and the shape was not tuned to close the gap.
  The burst process below was added for this.

  Radio : 911 in 15:08-18:06Z: generated median 1.27 (IQR 1.01-1.62), record 1.44 (CI 0.97-2.38).
  Rescue entries coinciding with a 911 row in that window (1 min, 300 m): generated median
  0.28, record 0.43. The cause is the same one-call-per-entry cap as in the synthetic check.
- **Synthetic 10-zone scenario, 600 seeds** (tests). Mean counts against the integrated target:

  | Channel | Default (scale 3.67, gamma) | `nist_sample_like`, Poisson |
  | --- | --- | --- |
  | 911 | 93.25 vs 95.05 (-1.9%, 0.6 SE) | 26.11 vs 25.92 (+0.7%) |
  | radio | 37.56 vs 37.95 (-1.0%) | 37.16 vs 37.95 (-2.1%, 3.4 SE) |
  | rescue | 24.91 vs 26.02 (-4.3%, 1.3 SE) | 25.76 vs 26.02 (-1.0%) |

  Over seeds 1000-4999, radio is 37.96 (+0.07 SE) and 911 is 25.90 (-0.3 SE), so the 3.4 SE gap
  for radio in seeds 0-599 is sampling noise, not bias.
- **Overdispersion.** In one zone (z31, 911), variance/mean is 60.8, against an NB2 prediction of
  73.9. Without the zone factor it is 1.03.
- **Category shift (911 trapped).** It moves from 0.037 before arrival to 0.190 after
  (calibration: 0.038 and 0.190). Rescue help_needed is 0.94, then 0.55 (calibration: 0.94,
  then 0.54).
- **Rescue binding.** At scale 1, 24.3% of rescue entries share a 911 call's time and point,
  against a bind probability of 43.3%. The shortfall comes from entries with no unused 911 call
  of their category in their zone within 60 min. This is a cap of the one-call-per-entry rule
  when 911 volume is at sample level. It is not corrected by raising the probability.

### Bursts

`CommsOptions.bursts` (on by default) clusters radio and rescue rows in time within a zone. The
zone factor is constant over time, so on its own it cannot put many rows of one zone into the
same hour. Constants are `CALIBRATED_BURST_*`, `CALIBRATED_WITHIN_ZONE_DISPERSION` and
`ASSUMED_BURST_*` in the module, whose comment block has the full derivation.

**Process.** A Neyman-Scott cluster process (Neyman & Scott 1958) replaces the Poisson draw for
radio and rescue. Cluster centres follow the channel's rate divided by `m`, drawn on the window
widened by W/2 at each end. Each centre has 1 + Geometric rows (mean `m`), each at the centre
plus a uniform offset in ±W/2 min. Rows outside the window are dropped. The expected count per
channel is unchanged, and the time-offset distribution is the rate's, smoothed over ±W/2. Each
row draws its category and point as before. The gamma zone factor then takes only the
between-zone part of the dispersion, `k = mean(mu) / (dispersion - within-zone dispersion)`,
so the calibrated total is kept. The 911 stream is drawn exactly as before.

**Basis** (record, each channel in its GLM window, 43 zones):

| Statistic | 911 | radio | rescue |
| --- | --- | --- | --- |
| Within-zone dispersion: Pearson of the GLM with a dummy per zone, zone × hour units | 1.14 | **2.00** | **1.46** |
| Same, generator without bursts, 30 seeds: median (range) | 0.95 (0.57-2.19) | 0.98 (0.84-1.34) | 1.00 (0.69-1.23) |
| Excess same-zone row pairs within 59 min (over the zone-dummy fit's rate) | 36 | 408 | 171 |
| Lag by which half of that excess is reached, tau50 (min) | 10.7 | 19.3 | 18.1 |
| W = tau50 / (1 - 1/√2) (min), the cluster width | none | **65.8** | **61.7** |
| m = 1 + excess / (rows × P(lag ≤ 59.5 min)), rows per cluster | none | **2.69** (244 rows) | **1.93** (185 rows) |

Radio and rescue lie above the range the generator gives without bursts; 911 lies inside it,
so 911 gets no bursts. W follows from the median lag of a triangular lag law on [0, W]. m
follows because a geometric cluster of mean m adds m(m - 1) pairs, and there are rows/m
clusters. The excess is counted only to 59 min, so W is if anything low. The record's
clustering is on the scale of an hour, not a few minutes, plus a same-minute spike (radio:
16 excess pairs at lag 0). The geometric size law and the independent category and point of
each row are assumptions.

**Measured** (2026-10-24, 43 Camp zones, scale 1, refit as in the round trip):

| Channel | Refit dispersion, no bursts: median (range), 30 seeds | With bursts | Record |
| --- | --- | --- | --- |
| 911 | 2.95 (1.70-15.1) | 2.59 (1.47-17.2) | 3.53 |
| radio | 1.93 (1.18-5.21) | **3.63** (2.86-7.49) | 3.53 |
| rescue | 1.83 (0.94-4.61) | 2.22 (1.44-3.55) | 1.92 |

| Channel | Mean count, no bursts (SE) [median], 200 seeds | With bursts | Analytic | Record |
| --- | --- | --- | --- | --- |
| 911 | 98.3 (2.9) [92] | 98.6 (3.1) [85] | 91.4 | 90 |
| radio | 254.8 (9.9) [218] | 258.3 (8.7) [227] | 245.3 | 244 |
| rescue | 198.5 (6.6) [177] | 192.8 (5.0) [180] | 185.9 | 185 |

- Means are unchanged within sampling error (radio +3.5, rescue -5.7, 911 +0.3; at most
  0.7 SE apart). With bursts they sit 1.4 to 2.3 SE above the analytic value, as without
  (1.0 to 2.4 SE).
- The 911 change is sampling noise: its marginal shape is unchanged (0.207), but its zone factor
  is now built from a different shared draw.
- Radio:911 in 15:08-18:06Z: median 1.29 (IQR 0.97-1.69) with bursts, 1.27 without; record 1.44.
- Rescue entries coinciding with a 911 row in that window: median 0.22 with bursts, 0.29
  without; record 0.43. Clustered rescue entries compete for the same few 911 calls under the
  one-call-per-entry rule, so the shortfall grows.
- Within-zone dispersion with bursts, 30 seeds: radio 2.37 (1.77-3.41), record 2.00; rescue
  1.72 (1.18-2.22), record 1.46. Excess pairs within 59 min per row: radio 1.25 (0.74-3.73),
  record 1.67; rescue 0.72 (-0.42-2.68), record 0.93. Same-minute excess pairs, radio: 4.5
  (median), record 16.

**Remaining disagreement.** The radio refit dispersion now has a median of 3.6 against 3.53 in
the record, and the record lies inside the generated range. Two finer statistics still
disagree in opposite directions. With bursts, the within-zone dispersion is about 20% above the
record, and the excess pair count is about 25% below it. In the record the excess pairs fall
mostly in busy zone-hours, which looks more like a rate that rises and falls within a zone
(variance growing with mu squared) than like clusters of fixed mean size. The uniform ±W/2
offsets also miss the record's same-minute spike. I trust the record on all three. The
constants come from the record as derived above and were not adjusted to close these gaps.

**May and may not** are as above. Every item is `simulated`, calibrated to one sampled record of
one fire, and is not an observed or live call.
