# Curated demo seeds (Berkeley Hills & Tilden, 30 x 30 km)

The single-view `/run` page offers a few preset scenarios. They live in
`app/src/oneview/demoSeeds.ts` (`DEMO_SEEDS: DemoSeedPreset[]`, type in
`app/src/demo/runContracts.ts`). This note is how they were chosen, every candidate tried with
its numbers, and what the numbers do and do not show.

All numbers below are model output on **synthetic** inputs: the ignition points, wind and
fuel-moisture preset are illustrative scenario choices (ASSUMPTION, not an observed or forecast
incident), and the homes, vehicles and occupants are the dispatch-area builder's synthetic
households. They are planning-experiment numbers, not predictions of any real fire.

> **STALE (worktree-agent-ad39edb7c016812e1):** every number below was measured with the wind and
> fuel moisture held constant for 6 h. The Berkeley presets now carry an easing offshore event
> (`weatherSchedule`: the preset wind until T+150, then 12 mph from the same direction; "critical"
> moisture until T+240, then "dry"; all ASSUMPTION, `easingOffshoreEvent` in `demoSeeds.ts`), and
> the board now closes a fire that burns itself out (`closedBy: "burned_out"`). Neither change is
> re-measured yet; re-run the harness before quoting these figures.
>
> **Re-measured on `SPREAD_MODEL` 5.1.1 (after the fire-resume fix, feat/one-view 386b101).**
> Every outcome number in earlier versions of this note and in the earlier `demoSeeds.ts`
> (commit 11880b6, board code e67007d) was taken before that fix and is superseded.

## The presets

Board: `berkeley-hills-tilden@15km` (region `berkeley-hills-tilden`, 15 km half-width = the
Studio's "About 30 x 30 km", 60 m cells). Moisture preset `critical`, horizon 360 min, fire
reported 4 min after ignition, board seed 1. Wind is the open 20 ft wind in mph, FROM degrees
true (offshore, Diablo-type directions; the 35 to 40 mph speeds are scenario choices, within
the Studio's 0 to 60 mph limit).

Listed in the order the presets appear in `DEMO_SEEDS` (most convincing and least variable
first). `none` = nobody acts; `aids` = the scripted decision-aid policy (see Method). Seed 1
(the preset's own seed), at 6 h:

| id | ignition (lon, lat) | wind | none: homes burned / people caught | aids: homes burned / people caught | first home burned (min, none) |
|---|---|---|---|---|---|
| `berkeley-grizzly-peak-ene` | -122.2180, 37.8760 | 40 mph from 60 | 730 / 371 | 465 / 129 | 150 |
| `berkeley-claremont-hills-ene` | -122.2180, 37.8600 | 40 mph from 60 | 1,118 / 807 | 0 / 0 (contained T+18) | 30 |
| `berkeley-two-spot-ene` | -122.2340, 37.8680 and -122.2260, 37.8760 | 35 mph from 60 | 1,034 / 1,115 | 951 / 496 | 70 |
| `berkeley-south-hills-east-wind` | -122.2340, 37.8680 | 40 mph from 80 | 1,038 / 777 | 935 / 136 | 30 |

Why this order and what each is for:

- **Grizzly Peak hills** is first because it is the steadiest and the clearest: the decision
  aids cut both homes burned (36%, 36%, 69% across seeds 1, 2, 3) and people caught (65%, 53%,
  65%) in every seed, and the no-action figures sit in a narrow band (homes 622 to 802, people
  292 to 388). It builds slowly (first home after about 2.5 h), which leaves time to watch
  evacuation orders being sequenced.
- **Claremont hills** is the fast one: homes burn within half an hour of ignition. With board
  seed 1 the decision aids' initial attack contains the fire at minute 18 with zero homes lost
  (a seeded draw: seeds 2 and 3 were not contained early, but still caught 82% and 71% fewer
  people and burned 15% and 12% fewer homes). The clearest "fast dispatch matters" demo, but the
  no-action people-caught figure varies a lot by seed (807 to 1,394).
- **Two spots** has two fronts, a large harm and a clear gain from the aids in every seed (homes
  8%, 7%, 22% lower; people 55%, 42%, 79% lower), but the no-action people-caught figure swings
  from 449 to 1,115 across seeds, so it is not the lowest-variance pick.
- **South Berkeley hills, east wind** tests a different wind direction on a different slope; fast
  (first home within 30 min) with a tight no-action band (homes 1,038 to 1,253), but the gain from
  the aids is the least steady (people 82%, 54%, 23% lower; homes 10%, 20%, 2% lower).

The earlier version of this note (commit 11880b6, board code e67007d) listed other numbers
(for example claremont 1,255 homes / 807 people, grizzly 999 / 534, two-spot 1,110 / 1,206, and a
"board finding" that crews made the fire grow faster). Those were taken before the fire-resume fix
(`SPREAD_MODEL` 5.1.1, lead P) and are **superseded**: the board re-solves the fire as it runs,
and the old resume credited a step's progress wrongly, which also changed the no-action fire and
made crews accelerate it.

## Method

Tool: the headless harness `app/scripts/live-eval/evaluate.ts` (header explains it). It loads the
command board exactly as `/live` does, steps the board clock deterministically, and prints the
outcome metrics. It writes nothing to the drill.

- `--policy none`: nobody acts (no crews, no orders). This is the `measured` field.
- `--policy baseline`: a scripted policy (`baselinePolicy.ts`) that uses only the model's own
  decision aids, no LLM (so, "aids"). It stands in for what a commander, or the AI, can do with
  the same information. It is not a measurement of the AI itself.
- Synthetic Studio fire: `--ign lon,lat[;lon,lat] --start 0 --report 4 --wind MPH --from DEG
  --moisture critical --board berkeley-hills-tilden@15km --seed N --minutes 360`.
- Each pick was measured on **its own drill package**, built the way `/run` builds it
  (`oneview/studioPackage.ts`: the Studio solve of the preset on the 30 km board, firefighting
  off, then `POST /api/live/packages`), because the package's road box (the fire's reach plus
  3 km) decides which zones and synthetic homes exist. A different fire gives a different box, so
  numbers from one package do not transfer to another. Packages used (dispatch builder
  `dispatch-area/6`): grizzly `pkg_1f40dababe05`, claremont `pkg_c2ecf25d6eb4`, two-spot
  `pkg_4150a8f4de75`, south hills `pkg_2c416ab57371` (same zones and homes as the earlier
  packages: 54, 51, 48 and 57 zones). The resource snapshot was seeded the way activation does it
  (`live_seed_snapshots`: synthetic occupants, vehicles, engines).
- Determinism: for each pick `--policy none --seed 1` was run twice; the two results were
  identical in every reported number (homes, people, area, timeline).
- Variance: seeds 1, 2 and 3 for `none` and for the decision-aid policy.

### Why a sidecar backend (nothing shared was touched)

The harness reads the active drill from the live API, which serves only the Camp bundle and the
**active** incident, and the zones, roads and stations come from that incident's package. The
local backend on :8000 had the Camp exercise active (Paradise zones), which is meaningless on a
Berkeley board, and the task was not to change the active incident. So the measurements ran on
private backends: Django on 127.0.0.1:8101 to 8104 from this worktree's backend code, each with
the same private Mongo database for the live collections (`crisistwin_oneview_q`, dropped
afterwards; the incident ids differ), read access to the shared landscape and dispatch-area
caches, a scratch `LIVE_PACKAGES_DIR` and `LIVE_ACTIVE_INCIDENT_ID` set to the pick's package, and
the harness pointed at it with `--base http://127.0.0.1:810x`. Scratch tooling (not committed): a
Studio-equivalent run exporter (`loadLandscapeCached` + `simulateScheduledFireSpread` +
`buildRunExport`) and a copy of `evaluate.ts` with a `--no-prefetch` flag.

`--fast --no-prefetch` were used: the harness's per-board-minute road-time prefetch costs about
3 s of wall time each and only refines the decision aids' travel times (road legs for dispatched
units are still fetched when the clock waits on them). With 16 runs in parallel on a 12-core
machine a `none` run took 1.5 to 2 min and a decision-aid run 4 to 17 min.

Code version: `feat/one-view` 386b101 (`SPREAD_MODEL` 5.1.1, board self-evacuation on, fleets,
safe-area destinations, road-class routing). The route fix in 386b101 (the routes endpoint 400 on
`excluded_destination_ids`) does not touch these runs: the harness posts `{ fires }` only and
all 679 routes requests in the sidecar logs returned 200 (and so did all 1,639 requests of any kind). Note that for the same
reason the harness's route options ignore closed or full safe areas (`excluded_destination_ids`),
which the browser board sends. Re-measure after outcome-changing board or fire-solver changes.

## Final measurements (preset package, 386b101)

`homes` = homes burned, `people` = people caught by fire (synthetic occupants), at the end of
the 360 min run (the contained claremont seed 1 aids run stopped at T+28 when the fire was out).
"aids" = the whole scripted decision-aid policy (crews, strategy, extra resources, evacuation).

| pick | seed | none homes | none people | none area (ha) | first home / first caught (min) | aids homes | aids people | aids area (ha) |
|---|---|---|---|---|---|---|---|---|
| grizzly | 1 | 730 | 371 | 566 | 150 / 200 | 465 | 129 | 465 |
| grizzly | 2 | 802 | 388 | 558 | 160 / 190 | 512 | 183 | 404 |
| grizzly | 3 | 622 | 292 | 470 | 160 / 240 | 190 | 102 | 240 |
| claremont | 1 | 1,118 | 807 | 675 | 30 / 100 | 0 (contained T+18) | 0 | 0.4 |
| claremont | 2 | 1,260 | 1,394 | 771 | 20 / 90 | 1,076 | 247 | 657 |
| claremont | 3 | 1,226 | 903 | 747 | 20 / 90 | 1,079 | 264 | 647 |
| two-spot | 1 | 1,034 | 1,115 | 561 | 70 / 280 | 951 | 496 | 440 |
| two-spot | 2 | 847 | 449 | 568 | 70 / 260 | 786 | 260 | 480 |
| two-spot | 3 | 1,035 | 1,104 | 606 | 60 / 240 | 807 | 236 | 444 |
| south hills | 1 | 1,038 | 777 | 513 | 30 / 120 | 935 | 136 | 470 |
| south hills | 2 | 1,071 | 861 | 516 | 30 / 100 | 857 | 399 | 430 |
| south hills | 3 | 1,253 | 881 | 596 | 20 / 90 | 1,224 | 677 | 568 |

First home / first caught are 10-minute timeline steps (the board's timeline samples every 10
minutes). The aids policy ended with a smaller burned area than no action in all 12 pairs.

Spread of the no-action figure across seeds: homes grizzly 622 to 802, claremont 1,118 to 1,260,
two-spot 847 to 1,035, south hills 1,038 to 1,253; people grizzly 292 to 388, claremont 807 to
1,394, two-spot 449 to 1,115, south hills 777 to 881.

Reduction by the decision aids vs no action (seeds 1 / 2 / 3), homes burned and people caught:
grizzly -36% / -36% / -69% and -65% / -53% / -65%; claremont -100% / -15% / -12% and -100% / -82% /
-71%; two-spot -8% / -7% / -22% and -55% / -42% / -79%; south hills -10% / -20% / -2% and -82% /
-54% / -23%.

Claremont seed 1 is the only run where the policy contained the fire early. It is a seeded draw
(the board's response draws are keyed per purpose and seed), so it repeats for the same seed and
dispatch timing but another dispatch order or timing can change it. The earlier note's extra
claremont seeds (4 to 8) were not re-run.

## The earlier "board finding" is resolved

The earlier note reported that the full scripted policy burned more homes and area than no action
because assigning crews made the free-burning fire grow faster (a fire-solver resume bug). With
`SPREAD_MODEL` 5.1.1 that no longer happens in any of the 12 seed/pick pairs measured above
(burned area with the aids is below no-action in all of them), so the `/run` AI run can be compared
with the no-action baseline for the same seed.

## Candidates tried (stage 1 screen)

Selection history only: this screen ran on older board code (before the fire-resume fix), so its
fire areas, homes and first-home times are superseded by the final measurements above; it still
shows why these ignitions and winds were chosen.

`none`, seed 1, 360 min, critical moisture, on a single broad package (`pkg_1eff3a47568d`, built
from a three-ignition 12 h Studio run, 53 zones), older board code (`176b4c1`: 16 units, before
self-evacuation, fleets and the new area builder). Used to choose which ignitions and winds to
re-measure; the homes and first-home numbers are not comparable with the final table (different
synthetic home placement), only the fire (area) is the same fire. Run by four sonnet subagents
(A Claremont, B Grizzly Peak, C Tilden/Kensington, D wind variants) in parallel. `hh` = households
caught; runs marked `*` ran before the resource snapshot was seeded (people unknown, households
not comparable). Ignitions are all on burnable fuel (probed on the board grid: grass GR2, shrub
SH3/SH5, timber litter).

| id | ignition (lon, lat) | wind mph from deg | homes burned | area ha | first home (min) | hh caught |
|---|---|---|---|---|---|---|
| A1 | -122.2340, 37.8680 | 35 / 45 | 684 | 457 | 60 | 476* |
| A1 | -122.2340, 37.8680 | 40 / 60 | 1,017 | 626 | 70 | 476* |
| A2 | -122.2180, 37.8600 | 35 / 45 | 816 | 697 | 50 | 1,540* |
| A2 | -122.2180, 37.8600 | 40 / 60 | 1,067 | 777 | 40 | 1,010 |
| A3 | -122.2180, 37.8520 | 35 / 45 | 193 | 178 | 250 | 378 |
| A3 | -122.2180, 37.8520 | 40 / 60 | 554 | 431 | 160 | 908 |
| B1 | -122.2340, 37.8760 | 35 / 45 | 0 | 8 | none | 0* |
| B1 | -122.2340, 37.8760 | 40 / 60 | 36 | 105 | 300 | 0* |
| B2 | -122.2260, 37.8760 | 35 / 45 | 341 | 368 | 190 | 476* |
| B2 | -122.2260, 37.8760 | 40 / 60 | 156 | 357 | 250 | 476 |
| B3 | -122.2180, 37.8760 | 35 / 45 | 547 | 649 | 50 | 772 |
| B3 | -122.2180, 37.8760 | 40 / 60 | 693 | 764 | 30 | 772 |
| C1 | -122.2340, 37.9000 | 35 / 45 | 70 | 338 | 250 | 0* |
| C1 | -122.2340, 37.9000 | 40 / 60 | 205 | 435 | 180 | 0* |
| C2 | -122.2340, 37.9080 | 35 / 45 | 240 | 399 | 250 | 0* |
| C2 | -122.2340, 37.9080 | 40 / 60 | 279 | 487 | 170 | 0 |
| C3 | -122.2500, 37.9160 | 35 / 45 | 298 | 391 | 230 | 590 |
| C3 | -122.2500, 37.9160 | 40 / 60 | 223 | 359 | 230 | 212 |
| D1 | -122.2420, 37.8840 | 40 / 60 | 615 | 497 | 90 | 236* |
| D2 | -122.2340, 37.8680 | 40 / 80 | 777 | 582 | 30 | 1,134* |
| D3 | -122.2340, 37.8680 | 30 / 45 | 540 | 387 | 70 | 476* |
| D4 | -122.2180, 37.8600 | 40 / 80 | 834 | 643 | 50 | 772 |
| D5 | -122.2340, 37.8680 + -122.2260, 37.8760 | 35 / 60 | 823 | 669 | 70 | 476 |
| D6 | -122.2340, 37.9000 | 40 / 80 | 323 | 514 | 190 | 794 |
| first test | -122.2260, 37.8760 | 25 / 45 | 12 | 125 | 290 | 0* |

How the picks came out of this table:

- 25 mph (the Studio default wind) is too weak: the first test burned 12 homes in 6 h. 30 to
  40 mph is where the board fire reaches the neighbourhoods inside the hour.
- The Tilden / Wildcat / Kensington ignitions (C1 to C3, north of the others) are the slowest
  (first home 170 to 250 min) and burn 70 to 300 homes: not rejected on harm, rejected on
  "fast enough to watch". They are a fit for a longer, calmer demo if one is wanted.
- B1 (timber litter below the ridge) barely spreads; B2 is slow and wind-direction sensitive.
- The four picks are the largest fast fires that are also spread across the hills: A2 (as
  claremont: the largest and the fastest), B3 (as grizzly: the largest of the central hills),
  D2 / A1 (as south hills: east wind variant, first home at 30 min) and D5 (two spots). A2 at
  40 mph from 80 (D4, 834 homes) and A1 at 40 mph from 60 (1,017 homes) were close seconds.
  Four, not five, because the remaining candidates repeat a location or are slow.


## Caveats

- **Package dependence.** Outcomes depend on the preset's own package (its zones and synthetic
  homes). `/run` builds the package from the preset; the fire solve is deterministic, so the same
  preset gives the same road box and the same zones. A different Studio board size or a changed
  ignition changes the numbers.
- **Synthetic people.** Occupants, vehicles and homes come from the dispatch-area builder and
  the snapshot (synthetic, labelled so in the package); `caughtPeople` is the board's count of
  those occupants.
- **Wind and ignition points are assumptions**, labelled as such; they are not tied to an
  observed Diablo-wind event.
- **`measured` is no-action only.** The "aids" figures come from the scripted decision-aid policy
  (no LLM; no ANTHROPIC key was available), a proxy for what the AI can do with the same
  information, not a measurement of the AI commander.
- **Containment on claremont seed 1** is a seeded draw (the board's response draws are keyed
  per purpose and seed); it repeats for the same seed and dispatch timing but another dispatch
  order or timing can change it.
- **Harness routes.** The harness requests routes with `{ fires }` only, so its evacuation
  options do not exclude closed or full safe areas the way the browser board does; real `/run`
  outcomes can differ somewhat.

## Reproduce

From `app/`: bundle the harness
(`npx esbuild scripts/live-eval/evaluate.ts --bundle --platform=node --format=esm
--outfile=/tmp/live-eval.mjs`), build a Berkeley package for the preset's fire, make it the
active incident of a **private** backend (do not switch the shared drill), and run, for example:

```
node /tmp/live-eval.mjs --base http://127.0.0.1:8101 --board berkeley-hills-tilden@15km \
  --policy none --fast --ign "-122.2180,37.8600" --start 0 --report 4 \
  --wind 40 --from 60 --moisture critical --seed 1 --minutes 360
```

Without a snapshot the board has no occupants (people caught are then unknown); seed one with
`manage.py live_seed_snapshots --incident <studio-id>` on the private backend's database.
