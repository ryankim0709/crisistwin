# 0032: Open live feeds as planner-confirmable candidates

Date: 2026-10-24. Status: accepted for the demo.

Builds on [0018-apify-incident-intelligence](0018-apify-incident-intelligence.md). Contract:
[docs/incident-intel.md](../incident-intel.md), section "Live feeds".

## Context

The intel pipeline turns public pages into `reported` / `unconfirmed` candidates that a planner
confirms. Three free federal and state sources publish the same kinds of facts as structured
data, so no page scraping or model extraction is needed: weather warnings that matter for fire,
road closures, and active wildfire incidents. We add them as candidates through the same gate.

## Decision

Three stdlib (`urllib`) adapters in `app/backend/api/intel_feeds.py`; no new dependency, no key,
no scheduler. Polling is a planner action (`POST /api/intel/feeds/<feed>/poll`) or a cron-style
management command (`intel_poll_feeds`). Each candidate is `evidence_class: "reported"`,
`review_status: "unconfirmed"`, with `source_url`, `fetched_at` and `available_at` (fetch time,
`fetched_upper_bound`). Only the existing review endpoint changes the status. Candidate ids derive
from the source's own record id, so polling is idempotent; an unconfirmed candidate is refreshed
and a reviewed one is never overwritten (only `last_seen_at` / `seen_count` move). Raw responses
are cached in `intel_feed_raw` (zlib, with `size`, `sha256`, URL, fetch time), once per distinct body.
Failures return 503 (unreachable, HTTP error), 504 (timeout) or 502 (invalid body / too large)
with a `detail`, and are shown on the feed's status row. A per-feed minimum interval (NWS 60 s,
Caltrans and WFIGS 300 s) answers 429 `polled_recently`.

### Sources and terms as read (2026-10-24)

| Feed | Endpoint | Terms as read | Candidate |
| ---- | -------- | ------------- | --------- |
| NWS alerts | `https://api.weather.gov/alerts/active?point=<lat>,<lon>` (bbox centre) or `?area=CA` | weather.gov API docs: "intended to be open data, free to use for any purpose", no fee, unpublished "reasonable rate limits" (retry after about 5 s), a `User-Agent` identifying the app with a contact is required. | `weather_alert` for Red Flag Warning and Fire Weather Watch, with the polygon when given (zone-only alerts keep `geometry: null`) |
| Caltrans LCS | `https://cwwp2.dot.ca.gov/data/d<N>/lcs/lcsStatusD<NN>.json` (district; Butte is D3) | The LCS page says the files "are available for integration into your application", "available via HTTPS", refreshed every 5 minutes, "no charge for the use of this data", and points to the Conditions of Use. Those (dot.ca.gov/conditions-of-use, dated 2021-07-19) say site information is "in general ... in the public domain", may be distributed or copied as permitted by law, with no warranty of accuracy or completeness, and prohibit attempts to defeat security or use the system "for other than its intended purposes". The documented, intended use of these files is application integration, so automated polling at the 5-minute cadence is permitted. We do not hammer the files and send an identifying User-Agent. | `road_closure` for `typeOfClosure: "Full"` in effect now (not planned, not ended, no code 1098), with begin/end coordinates |
| WFIGS | NIFC ArcGIS FeatureServer `WFIGS_Incident_Locations_Current` and `WFIGS_Interagency_Perimeters_Current` (`services3.arcgis.com/T4QMspbfLg3qTGWY`) | The services carry no licence text. The public item metadata for these layers has only a disclaimer: not liable for improper use, data are dynamic, "not better than the original sources", no warranty. No restriction on automated or redistributed use is stated; they are public federal data. | `fire_incident` for wildfire (`WF`) and complex (`CX`) incidents (prescribed fire `RX` is skipped), with acres, percent contained and the perimeter when one is mapped |

### Evidence labels

All three are `reported`: agency-entered or agency-modelled records, not observations by us. A
closure is not "observed" because Caltrans lists it; a perimeter is a mapped or modelled estimate;
an alert is a forecast product. The UI shows the "Reported" evidence tag, the planner-review
state and a source badge (NWS, Caltrans, WFIGS) on every one. Feed content is data, never
instructions (the NWS free-text fields are stored as text and rendered as text).

### What confirming means here

Confirming a feed candidate records the planner's judgement; it does not change routing.
`useConfirmedClosures` applies only `road_closed` / `road_blocked` / `road_reopened`, which come
from extraction. `road_closure` is a separate type until a planner maps it to roads (a later,
explicit step). Review without a mapping keeps the source geometry.

### Excluded sources

- **CHP CAD / `sa.xml`**: no published terms or documented feed, free text can carry plates and
  names, and one of the two machine-readable URLs is an undocumented endpoint. Revisit only with
  written permission from CHP.
- **PulsePoint**: no public API; the partner licence needs per-app keys and agency authorisation
  and forbids sublicensing. Unofficial endpoints are off limits.
- **Broadcastify** (and scanner audio generally): the catalog API needs an approved key and its
  terms exclude apps that redistribute or mirror audio and AI/ML pipelines without a licence; audio
  and transcripts carry names, addresses and medical detail, which breaks the no-identifiable-resident-data rule.

## Consequences

- No secrets. `INTEL_FEEDS_CONTACT` (User-Agent contact), `INTEL_FEEDS_NWS_AREA`,
  `INTEL_FEEDS_CALTRANS_DISTRICTS` are placeholders in `app/.env.example`; the contact falls back to
  `contact-not-set` and should be set before any real use.
- Candidates that disappear from a source (an ended closure, a cleared alert) are not removed;
  `last_seen_at` shows when a feed last listed them. Planners reject stale ones.
- The candidates `bbox` filter still matches planner-mapped points only, so feed candidates are
  listed by incident. Caltrans data covers one district per request.
- Tests use recorded, trimmed or synthetic fixtures and never call the network. One real poll of
  NWS, Caltrans and WFIGS for the Butte County box was run by hand on 2026-10-24 to check the parsers.
