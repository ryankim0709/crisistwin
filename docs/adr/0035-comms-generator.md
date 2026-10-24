# 0035: Comms generator: seeded synthetic 911, radio and rescue items

Date: 2026-10-24. Status: accepted (module and tests; not yet wired into the live drill).

## Context

The scenario engine ([0030-scenario-engine.md](0030-scenario-engine.md)) must generate all
live ground data for any simulated fire. The only calibration we have is the 2018 Camp record
(NIST TN 2252 sample), summarised by `sim/ground_rates.py` as `GroundRateParams`
([ground-data-calibration.md](../ground-data-calibration.md)). The live review queue already
consumes the record's item schema (`tools/camp_ground_record.json`,
`app/backend/api/live/groundrecord.py`).

## Decision

`sim/gen_comms.py`, standard library only and pure, with
`generate_comms(zones, roads, window_utc, params, seed, options) -> list[dict]`:

- **Process.** Per zone and channel, a non-homogeneous Poisson process at the channel's
  Poisson-GLM rate `exp(intercept + band + phase)` per 1,000 households per hour, sampled by
  thinning (Lewis & Shedler 1979). We use the GLM rather than the empirical cell table
  because the GLM covers every band × phase cell and its fitted totals equal the record's.
- **Overdispersion.** A mean-1 gamma zone factor with shape `k = mean(mu) / (dispersion - 1)`
  (NB2 moment estimator) from each fit's Pearson dispersion. One factor is shared by the three
  channels; radio and rescue multiply it by an independent gamma so that each channel's marginal
  variance matches its own fit. This is how radio and rescue are conditioned on the 911 stream.
- **Rescue.** A share of rescue entries takes the time, point and category of a 911
  help_needed/trapped call in the same zone, because K-1 times are often the 911 call itself.
  The share is the record's coinciding share inside the 911 coverage window (39/90). The share
  over all rescue rows (39/190) understates it, because most of those rows have no 911 coverage.
  No dispatch delay is modelled (not estimable).
- **911 volume.** `scale_911` defaults to the calibrated lower bound (132/36 = 3.67);
  `nist_sample_like=True` uses 1.0. `psap_reroute_at` drops 911 calls at and after that time
  from the local stream (Paradise to Chico at 16:20Z).
- **Output.** The record's item schema plus `generator`, `params_hash` and `seed`, with
  `evidence_class: "simulated"`, `time_precision: "minute"`, a template summary from
  `tools.camp_ground_record.summary_for`, a 3-decimal point (road-snapped for road_blocked and
  heavy_traffic, else uniform inside the zone) and `text_sha12: null` (there is no source text).
- **Seeding.** Every zone and channel has its own `random.Random` stream, seeded by a string of
  the seed, zone and channel, so adding a zone does not change the other zones' items.
- Every modelling choice that is not calibrated is an `ASSUMED_*` constant in the module.

## Consequences

- Generated items carry the calibration's limits: one fire, one sampled record, rates
  extrapolated outside each channel's coverage window, and no claim on absolute radio or rescue
  volume. They are planning-experiment inputs, never observed calls.
- On the Camp zones at scale 1, the expected counts in each channel's window reproduce the
  record (911 91.4 vs 90, radio 245.3 vs 244, rescue 185.9 vs 185).
- `groundrecord.materialize_due` currently stamps every item it materialises as
  `historical_record`. A drill that feeds generated items through it must keep the item's
  `evidence_class` (`simulated`) and label; that change belongs to the drill-wiring work.
- `tests/fixtures/ground_rates_camp_2018.json` is a snapshot of `fit_camp_2018()`, so tests
  and drills run without the gitignored replay bundle; a test checks it against a fresh fit
  when the bundle is present.
