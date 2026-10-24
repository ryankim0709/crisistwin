# Communications infrastructure data

Sourced inputs for simulating cell, power and alerting degradation, and 911 overload, during
California wildfires. Compiled 2026-10-24. Everything here is a planning input: observed
history, derived arithmetic, or a labelled ASSUMPTION. Nothing here is live data.

Files:

| File | What |
| --- | --- |
| `tools/comms_degradation.json` | Parameters. Each has `provenance` (sourced, derived, ASSUMPTION), `unit`, source ids and a note. |
| `tools/comms_infra_data.py` | Downloader, extractors, CodeRED table parser, parameter validator. Network only when run. |
| `tools/comms_fixtures/source_manifest.json` | URL, size and SHA-256 of every source fetched on 2026-10-24, or `unavailable`. |
| `tools/comms_fixtures/butte_asr_structures.json` | FIXTURE. 92 FCC ASR structures in Butte County (31 KB). |
| `tools/comms_fixtures/butte_uls_cellular_sites.json` | FIXTURE. 16 active legacy FCC ULS Cellular licence locations in Butte County. |
| `tools/comms_fixtures/codered_delivery_table.json` | OBSERVED, script-transcribed. NIST TN 2252 sup. Tables D-2 and D-3. |
| `tests/test_comms_infra_data.py` | Offline tests: parser, validator, fixtures, derived arithmetic. |

Run `python -m tools.comms_infra_data validate` to check the parameter file. To rebuild:
`download --dest <empty dir>`, then `extract-asr`, `extract-uls` and `extract-codered` on the files in it.
The FCC server returned 403 to a user agent containing the word "fetch"; the tool sends
`CrisisTwin-research/0.1`.

## Coverage

| Topic | Result | Strength |
| --- | --- | --- |
| Cell-site locations, Butte | FCC ASR (92 structures, all uses) and ULS Cellular (16 licences) fixtures. DIRS says 174 sites are served, so locations are incomplete. | Partial |
| OpenCelliD | Not used. Downloads need an account token; CC BY-SA 4.0 share-alike would also bind derived data. | Unavailable |
| HIFLD cellular towers | Not used. HIFLD Open went offline 2025-08-26; archives only re-derive FCC data. | Unavailable |
| Camp 2018 outages by county over time | Not published. Carrier reports to the CPUC are confidential. Point counts only (17 first day, 66 cumulative, 7 to 9 in Paradise). | Weak |
| Tubbs 2017 | About 70 towers in the first hours; 341 across the North Bay siege (Cal OES via Santa Rosa Fire Chief testimony). | Weak |
| Kincade 2019 | FCC DIRS daily county snapshots, 26 to 30 Oct (Butte, Marin, Sonoma, state). PSPS-driven, not fire damage. | Good for power |
| CPUC resiliency rulemaking | D.20-07-011: 72 h backup in Tier 2/3 High Fire Threat Districts, within 12 months of 16 Jul 2020. Secondary source only. | Medium |
| PSPS footprints | Event sizes (729,000 and 941,000 customers, mean outage 55 h). Per-circuit tables not built. | Medium |
| Alert reach, CodeRED | Full per-message delivery tables (29 messages, 15 re-calls). Opt-in rate only bounded (below 50% of 26,000). | Good (delivery), weak (opt-in) |
| WEA | Camp 2018: none sent. Reach and delay for a what-if WEA are ASSUMPTIONs. | Mixed |
| Landline vs mobile | CDC NHIS 2018 California adult shares. No Butte or Paradise figure. | Medium |
| 911 capacity | Paradise PD: 3 consoles, 15 lines, reroute to Chico at 08:20 on 2018-11-08. Butte County Sheriff and Chico positions: unavailable, ASSUMPTION placeholders. | Partial |

## Licences and decisions

- **FCC ASR and ULS bulk files** (`data.fcc.gov/download/pub/uls/complete/`): US federal public
  data with no stated restriction. Weekly dumps; the fixture records the SHA-256 of the 2026-10-18
  file. Owner and contact fields (names, emails, phones) are dropped on extraction; the fixture keeps
  registration number, type, height, site description and coordinates only. ASR holds only structures
  that must be registered (tall, or near airports), and ULS Cellular holds only legacy site-based
  licences (PCS, AWS and 700 MHz are market licences with no site coordinates), so neither is a census.
- **OpenCelliD** (CC BY-SA 4.0, visible credit required): downloads need an API token from an account.
  Accounts are out of scope, so it is recorded as unavailable. If someone later opts in, the
  share-alike term applies to any dataset derived from it; keep it out of tracked fixtures.
- **HIFLD Open cellular towers**: data.gov lists US Government Works, but the service was deactivated
  2025-08-26 and its content is FCC data we already read. Not used.
- **FCC DIRS reports, CPUC/PG&E PSPS reports, NIST TN 2252, CDC NHIS, House testimony**: public
  government documents. News items (EMS1, GovTech, SF Chronicle, FRONTLINE) are marked `news` and
  only give numbers they attribute to named officials; read them as secondary.
- The 30 Oct 2019 DIRS reports come from a third-party mirror (tellusventure.com) because the FCC
  original was not found. The 26 Oct report is the FCC original.

## Key parameters

| Parameter | Value | Source |
| --- | --- | --- |
| Butte County cell sites served | 174 (Oct 2019) | FCC DIRS 26 Oct 2019 |
| Camp 2018 Butte towers lost, day 1 | 17 (9.8% of 174) | EMS1, citing CPUC sources |
| Camp 2018 Paradise towers down | 7 to 9 | Chief Reinbold in GovTech/LA Times |
| Camp 2018 Butte sites damaged or out, cumulative | 66 (38%) | Public Advocates motion, unverified |
| Tubbs 2017 | about 70 towers in the first several hours | Santa Rosa Fire Chief testimony |
| Failure cause mix, 30 Oct 2019 (PSPS) | power 74%, transport 17%, damage 5% | FCC DIRS |
| Site loss per fire-exposed hour | 0.25 per hour (0.1 to 0.5), ASSUMPTION | no source; calibrate to Camp 17 and 66 |
| Backup power required (after Jul 2021) | 72 h in Tier 2/3 HFTD, with exemptions | CPUC D.20-07-011 (secondary) |
| Backup power before 2020 | 4 h (2 to 8), ASSUMPTION | no fleet data found |
| Power-driven recovery | share still out after 1 day: 0.15 to 0.74 | FCC DIRS Marin and Sonoma |
| Mean PSPS customer outage | 55 h | PG&E 26 to 29 Oct 2019 report |
| Fire-damaged site repair | 45% repaired by about day 2 (2017) | Cal OES relay, single point |
| CodeRED initial call success | 55%; 59% early, 51% midday, 14% after midnight | NIST TN 2252 sup. D-2 |
| CodeRED re-call success | 7% | NIST TN 2252 sup. D-3 |
| CodeRED dial-through, zones 2/6/7/13 | 16 min (08:32 to 08:48) | NIST Table A-2 row VTD-19 |
| Paradise opt-in | below 50% of 26,000; 35% (20 to 50) ASSUMPTION | FRONTLINE |
| Evacuees who received any alert | 13.5% (7,000 of 52,000) | Butte County Grand Jury via FRONTLINE |
| WEA sent in Camp 2018 | 0 | FEMA, BCSO via FRONTLINE |
| CA adults: wireless-only 55.4%, landline-only 3.3%, landline-mostly 5.3% | 2018 | CDC NHIS Table 1 |
| Paradise PD | 3 consoles, 15 lines, calls rerouted to Chico 08:20 | NIST TD-078, SF Chronicle |

## How the simulation should use it

**Comms-outage inject** (the scenario engine's cell and power outage):

1. Place cell sites. Use the 174 Butte total as the target. The ASR and ULS fixtures give 108
   real anchors, many of them not cell sites; add the rest by an explicit ASSUMPTION (for
   example weighted by road and population density) and label the layer "assumed sites".
2. Fire damage: for each site inside the evolving fire footprint, fail with
   `1 - exp(-rate * hours_exposed)`, rate from `hazard_per_hour_inside_fire_perimeter`. Seed the
   draw. Calibrate the rate until a Camp Fire replay loses about 17 sites on day 1 and about 66
   cumulatively; report both as targets, not fits to hide.
3. Power: sites in de-energized or burned feeders run on battery for `pre_2020_battery_hours`
   (a per-site draw) and then fail. For scenarios dated after July 2021 in Tier 2/3 districts use
   72 h with the exempt share. After power returns, remaining outages decay by the daily
   remaining ratio (0.15 to 0.74). Fire-damaged sites recover on a repair clock; only one 2017
   data point exists, so mark that clock as an assumption.
4. Show results as site counts and an estimated coverage change, never as "no service": the FCC
   cautions that overlapping sites and temporary cells keep service up. Sites out of 174 is the
   comparable quantity to DIRS.
5. Validate: sites out never exceeds sites served; all shares in [0, 1].

**PSAP reroute inject:** Paradise PD has 3 call-taker positions and 15 lines; at the call-volume
peak all were busy. The 2018 reroute to Chico happened at 08:20 after 132 calls over about 110
minutes. Model the reroute as moving overflow calls to a second PSAP with its own capacity. The
Butte County Sheriff and Chico capacities are ASSUMPTIONs until the CalOES 911 Branch roster or a
records request supplies them. Show them as assumptions.

**Comms generator (resident alerts and reports):** it should draw each resident's reachability
from these inputs and keep the three sources separate in the output.

- Registered: opt-in share (ASSUMPTION 0.2 to 0.5, upper bound sourced). Registrations are per
  phone number, not per person.
- Reached by a CodeRED call: use the observed success by phase from the fixture (0.59 early,
  0.51 midday, 0.14 late night) and cut it further when the resident's serving site is down.
  Re-calls reach about 7%.
- Delay: calls to a zone took up to 16 minutes to dial through (08:32 to 08:48) and the system was
  limited to roughly 2,000 to 4,000 calls per minute. Queue messages at that rate rather than
  delivering them instantly.
- WEA: send none when replaying Camp 2018 (observed 0). For what-if runs, WEA depends on a working
  site and a capable handset (both ASSUMPTIONs) and is not slowed by call congestion (FEMA).
- Landline-only households (about 3% of California adults) keep CodeRED calls through a cell outage
  but lose them when power or the line fails.

Time handling: the CodeRED fixture uses hours since 00:00 on 2018-11-08 Pacific Standard Time
(25:18 is 01:18 on 9 Nov), the same convention as `tools/camp_codedred_table.json`. Convert to UTC with
the simulation clock, not the wall clock.

## Gaps

- No official county-by-hour cell outage series for Camp 2018, Tubbs 2017 or fire-time Kincade.
  Carrier filings to the CPUC are confidential, and no FCC DIRS Camp Fire report was found.
- Real cell-site coordinates. The best route is an offline carrier or county GIS layer; OpenCelliD
  is blocked by the account rule, and HIFLD is offline.
- California battery and generator inventory before 2020; carrier Communications Resiliency Plans
  (filed January 2021) and the D.20-07-011 text itself were not retrieved.
- Per-circuit PSPS footprints (Appendix C of the PG&E reports) are not converted to a county or
  site table.
- Butte County Sheriff and Chico PSAP positions; Butte County CodeRED registration count.
- Search results for "Butte ECC" and its 911 structure belong to Butte, Montana, not Butte County,
  California, and were discarded.
- The repository copies of `docs/adr/0030-scenario-engine.md` and `docs/ground-data-calibration.md`
  were not in this worktree when the data was compiled, so the inject wiring above follows the task
  description. Reconcile it with those documents when they land.
