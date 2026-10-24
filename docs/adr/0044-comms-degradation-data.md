# 0044: Sourced communications-degradation data

Date: 2026-10-24. Status: accepted.

Related: [comms-infrastructure](../comms-infrastructure.md), `tools/comms_degradation.json`.

## Context

The scenario engine needs injects for cell, power and alerting loss and for 911 overload. They
must not invent numbers: `AGENTS.md` requires every input to be sourced or marked as an
assumption. The public record is thin. Carrier outage reports to the CPUC are confidential, the
FCC's Disaster Information Reporting System (DIRS) county reports we found cover the October 2019
power shutoffs and not the Camp Fire, and the usual open cell-tower datasets are gone or need an
account.

## Decision

Keep the inputs in one parameter file, `tools/comms_degradation.json`, loaded by the inject and
the comms generator.

- Every parameter carries `provenance`: `sourced` (read in a cited document), `derived`
  (arithmetic on sourced numbers) or `ASSUMPTION` (with a rationale). A validator in
  `tools/comms_infra_data.py` rejects missing sources, unknown source ids, shares above 1,
  negative values and inverted ranges. Any UI that shows an ASSUMPTION value must label it.
- Observed records stay apart from assumptions. Site-failure hazard under fire exposure, pre-2020
  battery duration, opt-in rate and the capacity of the Butte County Sheriff and Chico PSAPs are
  ASSUMPTIONs because no source was found. Camp 2018 counts (17 and 66 sites) are calibration
  targets for the hazard, not inputs that were fitted.
- Cell-site locations come from FCC ASR and ULS bulk files, kept as small Butte County fixtures
  with owner and contact fields removed. They are labelled FIXTURE and are not a census (92
  registered structures and 16 legacy licences against 174 sites FCC DIRS reports). The simulation
  adds the remaining sites as a labelled assumption.
- OpenCelliD is not used: downloads require an account, and its CC BY-SA 4.0 share-alike term
  would apply to derived data. HIFLD Open cellular towers is not used: the service went offline on
  2025-08-26 and holds FCC data we read directly. Both are recorded as unavailable in the manifest.
- The downloader records URL, size and SHA-256 for each source and does network access only when
  run. Tests are offline.
- The CodeRED delivery tables (NIST TN 2252 sup. D-2, D-3) are parsed by script into a fixture and
  checked against the NIST narrative (55% initial, 7% re-call success).

## Consequences

- The inject can run on day one with honest uncertainty, and each assumption can be replaced in
  place when a source arrives (CalOES PSAP roster, carrier resiliency plans, a county GIS layer).
- Outage parameters rest mostly on the 2019 power shutoffs and on point counts from news and
  testimony. They describe power-driven loss better than fire-driven loss. The docs say so.
- The CPUC 72-hour backup requirement comes from a law-firm summary; the decision text still needs
  checking before it drives a result.
- FCC bulk files change weekly, so a rebuilt fixture may differ. Each fixture stores the SHA-256 of
  the file it came from.
