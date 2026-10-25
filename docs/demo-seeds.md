# Curated demo seeds (Berkeley Hills & Tilden, 30 x 30 km)

The single-view `/run` page offers a few preset scenarios. They live in
`app/src/oneview/demoSeeds.ts` (`DEMO_SEEDS: DemoSeedPreset[]`, type in
`app/src/demo/runContracts.ts`). This note is how they were chosen, every candidate tried with
its numbers, and what the numbers do and do not show.

All numbers below are model output on **synthetic** inputs: the ignition points, wind and
fuel-moisture preset are illustrative scenario choices (ASSUMPTION, not an observed or forecast
incident), and the homes, vehicles and occupants are the dispatch-area builder's synthetic
households. They are planning-experiment numbers, not predictions of any real fire.

## The presets

Board: `berkeley-hills-tilden@15km` (region `berkeley-hills-tilden`, 15 km half-width = the
Studio's "About 30 x 30 km", 60 m cells). Moisture preset `critical`, horizon 360 min, fire
reported 4 min after ignition, board seed 1. Wind is the open 20 ft wind in mph, FROM degrees
true (offshore, Diablo-type directions; the 35 to 40 mph speeds are scenario choices, within
the Studio's 0 to 60 mph limit).

| id | ignition (lon, lat) | wind | no action at 6 h: homes burned / people caught | first home burned (min) |
|---|---|---|---|---|
| `berkeley-claremont-hills-ene` | -122.2180, 37.8600 | 40 mph from 60 | 1,255 / 807 | 30 |
| `berkeley-grizzly-peak-ene` | -122.2180, 37.8760 | 40 mph from 60 | 999 / 534 | 150 |
| `berkeley-south-hills-east-wind` | -122.2340, 37.8680 | 40 mph from 80 | 1,158 / 777 | 30 |
| `berkeley-two-spot-ene` | -122.2340, 37.8680 and -122.2260, 37.8760 | 35 mph from 60 | 1,110 / 1,206 | 70 |

Why these four (what each is for):

- **Claremont hills** is the fast one: homes burn within half an hour of ignition. With board
  seed 1 the scripted policy's initial attack contains the fire at minute 18 with zero homes
  lost (seed 8 did the same; seeds 2 and 3 did not), so it is the clearest "fast dispatch
  matters" demo. The no-action harm is large and the seeds agree on homes (1,255 to 1,357).
- **Grizzly Peak hills** builds slowly (first home after about 2.5 h): it leaves time to watch
  evacuation orders being sequenced, and its seeds agree well on homes (892 to 999).
- **South Berkeley hills, east wind** tests a different wind direction on a different slope;
  fast (first home within 30 min).
- **Two spots** has two fronts, and has the most repeatable no-action people-caught figure
  (1,161 to 1,206 across three seeds) and the largest, steadiest gain from evacuation advice.

## Method

Tool: the headless harness `app/scripts/live-eval/evaluate.ts` (header explains it). It loads the
command board exactly as `/live` does, steps the board clock deterministically, and prints the
outcome metrics. It writes nothing to the drill.

- `--policy none`: nobody acts (no crews, no orders). This is the `measured` field.
- `--policy baseline`: a scripted policy (`baselinePolicy.ts`) that uses only the model's own
  decision aids, no LLM. It stands in for what a commander can do with the same information.
- Synthetic Studio fire: `--ign lon,lat[;lon,lat] --start 0 --report 4 --wind MPH --from DEG
  --moisture critical --board berkeley-hills-tilden@15km --seed N --minutes 360`.
- Each pick was measured on **its own drill package**, built the way `/run` builds it
  (`oneview/studioPackage.ts`: the Studio solve of the preset on the 30 km board, firefighting
  off, then `POST /api/live/packages`), because the package's road box (the fire's reach plus
  3 km) decides which zones and synthetic homes exist. A different fire gives a different box, so
  numbers from one package do not transfer to another. Packages used (dispatch builder
  `dispatch-area/6`): claremont `pkg_706776a190eb`, grizzly `pkg_ef6ee9c95bec`, south hills
  `pkg_26f34b02b314`, two-spot `pkg_b630ceb1dc58`. The resource snapshot was seeded the way
  activation does it (`live_seed_snapshots`: synthetic occupants, vehicles, engines).
- Determinism: for each pick `--policy none --seed 1` was run twice; the two results were
  identical in every reported number (homes, people, area, timeline).
- Variance: seeds 1, 2 and 3 for `none` and for the scripted policy.

### Why a sidecar backend (nothing shared was touched)

The harness reads the active drill from the live API, which serves only the Camp bundle and the
**active** incident, and the zones, roads and stations come from that incident's package. The
local backend on :8000 had the Camp exercise active (Paradise zones), which is meaningless on a
Berkeley board, and the task was not to change the active incident. So the measurements ran on
private backends: Django on 127.0.0.1:8101 to 8104 from this worktree's backend code, each with
its own Mongo database for the live collections (`crisistwin_oneview_i`), read access to the
shared landscape and dispatch-area caches, a scratch `LIVE_PACKAGES_DIR` and
`LIVE_ACTIVE_INCIDENT_ID` set to the pick's package, and the harness pointed at it with
`--base http://127.0.0.1:810x`. The only writes outside that are a few new cached Berkeley
dispatch areas (one per package) in the shared cache database. Scratch tooling (not committed): a Studio-equivalent
run exporter (`loadLandscapeCached` + `simulateScheduledFireSpread` + `buildRunExport`) and a
copy of `evaluate.ts` with a `--no-prefetch` flag.

`--fast --no-prefetch` were used: the harness's per-board-minute road-time prefetch costs about
3 s of wall time each and only refines the decision aids' travel times (road legs for dispatched
units are still fetched when the clock waits on them). Without prefetch a `none` run takes
1.5 to 3 min and a scripted-policy run 8 to 27 min (several runs in parallel on one machine).

Code version: `feat/one-view` e67007d (self-evacuation on, fleets, safe-area destinations,
road-class routing). Re-measure after outcome-changing board changes.

## Final measurements (preset package, e67007d)

`homes` = homes burned, `people` = people caught by fire (synthetic occupants), at the end of
the 360 min run. "evac only" = the scripted policy with only its evacuation orders kept
(`EVAL_FILTER=evac` in the scratch harness copy): the fire is identical to no action, so only
people caught can differ. "full" = the whole scripted policy (crews, strategy, extra
resources, evacuation).

| pick | seed | none homes | none people | first home / first caught (min) | evac only people | full homes | full people |
|---|---|---|---|---|---|---|---|
| claremont | 1 | 1,255 | 807 | 30 / 100 | 387 | 0 (contained T+18) | 0 |
| claremont | 2 | 1,357 | 1,394 | 20 / 90 | 627 | 2,552 | 1,423 |
| claremont | 3 | 1,342 | 903 | 20 / 90 | 442 | 2,357 | 1,448 |
| grizzly | 1 | 999 | 534 | 150 / 200 | 258 | 2,857 | 1,537 |
| grizzly | 2 | 968 | 388 | 160 / 190 | 203 | 3,027 | 1,824 |
| grizzly | 3 | 892 | 292 | 160 / 240 | 154 | 2,917 | 1,601 |
| south hills | 1 | 1,158 | 777 | 30 / 120 | 528 | 1,761 | 726 |
| south hills | 2 | 1,126 | 861 | 30 / 100 | 605 | 1,617 | 744 |
| south hills | 3 | 1,461 | 1,007 | 20 / 90 | 768 | 2,445 | 1,157 |
| two-spot | 1 | 1,110 | 1,206 | 70 / 280 | 541 | 2,045 | 778 |
| two-spot | 2 | 989 | 1,193 | 70 / 260 | 509 | 2,260 | 1,101 |
| two-spot | 3 | 1,170 | 1,161 | 60 / 240 | 532 | 2,365 | 1,125 |

Burned area under no action (ha, seeds 1/2/3): claremont 777 / 865 / 856, grizzly 764 / 737 /
661, south hills 582 / 561 / 737, two-spot 669 / 691 / 747. First home / first caught are
10-minute timeline steps (the board's timeline samples every 10 minutes).

Claremont, extra seeds for the full scripted policy (to see how often the early containment
happens): seed 8 contained the fire at T+18 with 0 homes burned, like seed 1. Seeds 4, 5, 6 and
7 were stopped after T+120 to T+150 with the fire still burning and 149 to 347 homes already
burned (not run to the end). So the early containment came up in 2 of the 8 seeds tried (1 and
8); seed 1 is the preset's seed.

Evacuation advice alone (evac only vs none, people caught): claremont -52% / -55% / -51%,
grizzly -52% / -48% / -47%, south hills -32% / -30% / -24%, two-spot -55% / -57% / -54%
(seeds 1/2/3). The spread of the no-action figure across seeds is small for homes (claremont
+-4%, grizzly +-6%, two-spot +-8%; south hills larger, 1,126 to 1,461) and larger for people
caught in the claremont (807 to 1,394) and grizzly (292 to 534) picks; the two-spot figure is
the steadiest (1,161 to 1,206).

## What the full scripted policy does NOT show (a board finding)

In these runs the full scripted policy burned **more** homes than doing nothing in every seed
except the ones where it contained the fire at once (claremont 1 and 8), and its burned area was
about 1.5 to 2.2 times the no-action area. Isolation runs on the two-spot seed 1 (same seed,
scripted orders filtered by type; compared with no action through T+50): keeping only the
evacuation orders left the fire identical to no action (6.8 ha at T+30, 19.1 ha at T+60 in the
90 min run); keeping only `set_strategy` or only `order_resources` left it identical too; keeping
only `send_crew` made the fire diverge between T+10 and T+20 (T+20: 3.2 ha without crews, 12.6
ha with; T+30: 6.8 vs 39.6 ha; 2 fire solves vs 11 over the 60 min run), i.e. as soon as crews
are assigned and arrive. So the board's free-burning fire grows faster once crews work it. This looks
like a fire-solver or suppression-accounting issue on the board side (resumed solves, line or
knockdown cells), not a property of the scenarios. It matters for `/run`: an AI run that sends
crews will show more burned area and homes than the no-action baseline for the same seed until
that is understood. It is why the picks are ranked on the no-action harm, the repeatability and
the evacuation-advice gap (which is unaffected, because the fire is identical), not on the full
scripted policy's homes.

## Candidates tried (stage 1 screen)

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
- **`measured` is no-action only.** There is no measurement here of what the AI commander
  achieves (no ANTHROPIC key was available); the "evac only" column is the clean proxy for the
  evacuation part, the "full" column is unreliable for the reason above.
- **Containment on claremont seed 1** is a seeded draw (the board's response draws are keyed
  per purpose and seed); it repeats for the same seed and dispatch timing but another dispatch
  order or timing can change it.

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
