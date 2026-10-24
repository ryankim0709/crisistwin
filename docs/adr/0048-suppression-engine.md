# 0048: Suppression engine on sourced resource data

Date: 2026-10-24. Status: accepted for the demo. Supersedes in part
[0020-studio-firefighting](0020-studio-firefighting.md) (production rates, resource kinds) and
[0023-studio-crew-dispatch](0023-studio-crew-dispatch.md) (bases, road speeds). Wires in the
data of [0040-realistic-suppression-data](0040-realistic-suppression-data.md). Builds on
[0024-studio-crews-assist-evacuation](0024-studio-crews-assist-evacuation.md) and
[0025-dispatch-fire-tactics](0025-dispatch-fire-tactics.md).

## Context

The Studio modelled three resources with one assumed rate each, housed at OSM stations and
driven over public roads at free-flow speed. ADR 0040 added sourced production tables, road
access rules, aircraft data and base locations but left the simulator unchanged. The simulator
now reads them, and each choice below is marked as sourced, simulated or an assumption.

## Decision

**Data path.** `tools/suppression_resources.json` is turned into
`app/src/studio/suppressionData.generated.ts` by `tools/gen_suppression_ts.py`;
`suppressionData.test.ts` fails when the two drift. `app/src/studio/apparatus.ts` holds the
catalogue: ground kinds (T1, T3 and T6 engines, T1 and T2 hand crews, T1 and T2 dozers,
tactical and support tenders, chief officer), the access class each is routed as, the line
builder, the holding limit (hand tools 4 ft, engines and dozers 8 ft, as before), the base type
and the turnout or mobilisation time (80 s turnout, 30 min crews, 60 min dozers; the last two
are assumptions in the data).

**Line rates (sourced, per metre of ground line).** Hand crews use Broyles 2011 Table 2
sustained direct attack for a 20-person crew: Type 1 342 m/h and Type 2 191 m/h in grass (were
400 m/h for both). Engines use PMS 465 p.164 by crew size, from the PMS 200 minimum staffing:
Type 3 (three people) 483 m/h in grass, Type 1 (four) 704, Type 6 (two) 241 (was 600). Dozers
use PMS 465 p.140 by size, slope class (0-25, 26-40, 41-55%) and building line up or down the
slope, none above 55%: a medium (Type 2) dozer makes 1,770 m/h on flat ground going upslope in
grass (was 1,200). The tables are keyed by Anderson's 13 fuel models, and the board has FBFM40.
The crosswalk in `andersonModel()` is an **assumption**, by fuel family, and unvalidated; so
are the Broyles column for fuel models 3, 7 and 11-13 and the conifer rows for fuel models 8
and 9. The dispatch agent's engine is now a Type 3 (`DISPATCH_ENGINE_KIND` in
`app/src/dispatch/fireAttack.ts`), 8.05 m/min in grass instead of 10.

**Road access.** `app/src/studio/roadAccess.ts` ports `road_access()` (rules R01-R12 of
[suppression-data.md](../suppression-data.md)); `roadAccess.test.ts` checks parity with the
Python reference on 14 tag cases across the five classes. Deviations, both assumptions: `*_link`
roads take their parent class and `living_street` is treated as residential; R10 (dead end
without turnaround) applies only when the area carries boundary nodes, since otherwise a road
cut by the box looks like a dead end. Edge grade is the steepest rise over a 100 m window from
the DEM sampled every 10 m (**assumption**, to calibrate against surveyed grades); off the
board it is taken as 0% and the notes say so. `crewDispatch.ts` runs a Dijkstra per access
class over `area.allOutgoing`, which includes access-only service roads and tracks; evacuation
still uses `area.outgoing` only. A resource whose class reaches no road point within 1,500 m of
the fire is reported as "no access", with the rule found on the route an unrestricted vehicle
would take. A resource that parks short of the fire reports the rule that stopped it. The
backend change is in [0017-dispatch-anywhere](0017-dispatch-anywhere.md) (`dispatch-area/4`, and
`GET /api/suppression/bases` in `app/backend/api/suppression_bases.py`).

**Bases (assumptions).** Engines, tenders and chiefs leave OSM stations on the board, at most
one unit per kind per station. Further units are mutual aid from CAL FIRE-layer stations off the
board: straight-line distance times 1.3 (circuity) at 60 km/h, the data's cap for secondary
roads, to one of the four box-edge road nodes nearest the base, then routed on the board. Hand crews come from the nearest
conservation camp or crew centre and dozers from the nearest CAL FIRE-owned station, each after
its mobilisation time; camps and dozer bases are not depleted. The bases file
`tools/ca_fire_bases.json` has no open licence and is **local-only, never committed** (this
changes the decision in ADR 0040 to commit it). Without it every unit comes from board
stations round-robin and the result says so.

**Aircraft.** `app/src/studio/aircraft.ts` flies helicopters (Type 1-3) and airtankers (DC-10,
C-130, S-2T, AT-802F) from the nearest helitack and air attack bases, with air attack overhead.
Each drop becomes control line enforced by the same solver mechanism as ground line.
`daylight.ts` gives sunrise and sunset from the NOAA general solar position equations; a test
checks Boulder on 2021-12-30 against the US Naval Observatory within 3 minutes.

Sourced: capacities (PMS 200 minimums; IASG 2017 Table 3 airtanker gallons and cruise speeds),
line length per load by gallons and coverage level (IASG Table 8) and coverage by fuel model
(IASG Table 7), airtanker reaction time 15 min (PMS 508 p.44), air attack call to takeoff 5 min,
8 ft flame-length limit for retardant or water (PMS 465 pp.171, 174), wind (evaluate at 15 kt,
generally not effective at 25 kt or more; IASG p.100) and daylight windows (IASG pp.37, 42;
PMS 508 p.46).

Assumptions:

- Helicopter and air attack cruise speeds (100 and 180 kt), helicopter call to takeoff
  (10 min), airtanker reload ground time, the hard flight-stop wind, and the helicopter
  turnaround formula (twice the dip distance over cruise, plus 1.5 min hover fill and 0.5 min
  drop). These are flagged leaves in the data.
- Between 15 and 25 kt the line a load makes falls linearly to zero.
- The scenario's 20-ft wind stands in for the wind at drop height, which it understates.
- The dip site is the nearest LANDFIRE open-water cell (FBFM40 98) on the board, depth unknown;
  with none the dip is 8 km away.
- Water is treated like retardant: it holds flames up to 8 ft from the drop and does not
  evaporate. This overstates water.
- Loads under the table's 800 gal row scale linearly from it; loads over 3,000 gal are dropped
  as 3,000 gal segments.
- Drops go on the unsuppressed fire's edge at the drop minute, from the head if the ignition's
  head flame is 8 ft or less, else from the heel, and extend alternately along both flanks.
- No smoke, visibility, density altitude, crew duty limits or competing fires.
- The scenario clock is `FirefightingSettings.startLocalIso`; without it T+0 is
  2026-08-15T13:00-07:00.

Fixed-wing flights use a wider window (30 min before sunrise to 30 min after sunset) when air
attack is on scene, and a narrower one (not before 30 min after sunrise or after 30 min before
sunset) when it is not. Helicopters use the wider window, and fly at night only when the
scenario flags it.

**First alarm.** `FIRST_ALARM` in `firefighting.ts` is the preset: 3 engines, 1 dozer, 1 hand
crew and 1 chief officer (counts are an assumption in the data; there is no public CAL FIRE
dispatch matrix), as Type 3 engines, a Type 2 dozer and a Type 2 crew, plus air attack, two
S-2T airtankers and one Type 2 helicopter (California Fire Pilots Association, a secondary
source; the helicopter type is an assumption). Saved scenarios with only `handCrews`, `engines`
and `dozers` map to Type 2 crews, Type 3 engines and Type 2 dozers.

## Consequences

- Hand-crew and engine rates fall against the old constants (crews by about half for Type 2,
  engines by about a fifth), and dozer rates rise by half, so results from before this change
  are not comparable.
- Results can say that a class cannot reach a fire and why, which the old model could not. The
  rules and grades are mostly assumptions (ADR 0040) and the result is a planning experiment.
- Not modelled: aircraft in the initial-attack race (`initialAttack.ts`; drops enter only the
  control-line plan); tenders and chiefs build no line and water supply is not modelled;
  resource availability and drawdown; road curve radius; the dispatch agent's own routing
  (`app/src/dispatch/engine.ts`) still uses public roads only and does not apply class rules.
- The bases file is absent on a fresh clone, so mutual aid, crew camps and aircraft depend on a
  local `python -m tools.suppression_data --refresh-bases`. Without it ground units fall back to
  board stations and aircraft report no base.

## Before and after

Measured 2026-10-24 with a node harness that runs both the code at ac3a492 (before) and this
change (after) on the same inputs. The scenario is the Studio demo's F1 only: East Bay hills,
37.87509, -122.19607, GR2 grass, T+0, 20 mph wind from 45°, critical moisture, 3 h horizon.
The landscape is LANDFIRE native 30 m (633 x 633 cells of 23.7 m). The dispatch area was
built live from Overpass, dispatch-area/4, box -122.25..-122.14, 37.83..37.92: 5,381 edges,
1,523 of them access-only, and 17,682 synthetic homes. The CAL FIRE bases come from the
local-only file. All results are simulated.

| Run | Line plan, ha | Homes reached (line plan) | Direct attack, ha | Blocked by access |
| --- | ---: | ---: | ---: | --- |
| No crews | 4,333.9 | 6,217 | – | – |
| Before: 4 crews, 4 engines, 1 dozer (400/600/1,200 m/h) | 4,275.4 | 6,056 | 4,333.9 | not modelled |
| After: same counts (Type 2 crews, Type 3 engines, Type 2 dozer) | 4,304.0 | 6,102 | 4,333.9 | 0 with no access; every unit stops short at a grade4 track (R04) and walks 0.68 km |
| After: first alarm with aircraft | 4,314.3 | 6,158 | 4,333.9 | 0 with no access; R04 stops as above |
| After: 3 structure engines and a support tender | 4,317.5 | 6,217 | 4,333.9 | 0 with no access; R04 stop |

What the numbers show:

- The first engine is on scene at T+16.2 after the change and T+16.4 before.
- The Type 2 crew comes from Delta Conservation Camp, 30 min mobilisation plus 62.5 min of
  driving, and is on scene at T+106. The dozer comes from a CAL FIRE station, 60 min
  mobilisation, and is on scene at T+112.
- Aircraft:
  - Two S-2Ts fly 88.9 km from Sonoma AAB: over the fire at T+27.5, a 35 min cycle, 5 drops each.
  - The Type 2 helicopter flies 43.4 km from Gnoss Field and dips at LANDFIRE open water
    1.97 km away: a 3.3 min cycle and 47 drops.
  - The wind is 17.4 kt, so a load lays 76% of its table line.
  - Of 5.9 km of drop line, 1.7 km held, 3.6 km was breached and 0.5 km was outrun.
- This fire runs at about 30 m/min with a 6.8 ft head flame. No package catches it, before or
  after; suppression changes the burned area by at most 1.4%.
- The lower sourced crew and engine rates and the later crew and dozer arrivals make the line
  plan slightly less effective than before (4,304 ha against 4,275 ha).
- The two first-alarm S-2Ts do not make up for the smaller ground package.
- Only one road class mattered here: the grade4 track nearest the fire. Every class except
  Type 4-7 stopped there.

Regression check: in the tests, no candidate plan burns more than the free run, and no cell
burns earlier than in the free run, for ground, air and mixed packages
(app/src/studio/aircraft.test.ts).
