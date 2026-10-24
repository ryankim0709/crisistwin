# Mobility sidecar (Advan / Dewey), schema 1.0

An optional, **local-only** file next to a replay bundle that summarises phone-panel
foot traffic around an incident. The replay loads it if present and hides the feature
if not.

- Path: `app/public/replays/<replay-id>.mobility.json` (the bundle URL with `.json`
  replaced by `.mobility.json`). The existing `app/public/replays/**/*.json` ignore rule
  covers it.
- Built by `tools/dewey_mobility.py` from the Advan Weekly Patterns Plus subsets
  downloaded under our Dewey subscription. **Licensed data: never commit this file or
  its inputs to Git.** The built sidecars (our aggregates only) are shared with the team
  through Atlas like the replay bundles: `python3 -m tools.mongo_data pull` fetches them
  (listed in `app/data-manifest.json`). The raw Advan subsets are never uploaded anywhere;
  rebuilding needs Dewey access.
- Every value is our own aggregate (`evidence_class: "derived"`). No per-POI rows,
  names, or addresses. Cells **and series** with fewer than `min_pois` POIs are dropped, so
  a series may be absent (e.g. `religious` and `schools` do not occur in the Advan
  `TOP_CATEGORY` values of these extracts, so no such series are emitted); the UI must not
  assume every region x category exists.

## Shape

```jsonc
{
  "kind": "crisistwin_mobility",
  "schema_version": "1.0.0",
  "replay_id": "camp-2018",
  "incident_package": "camp-2018-evacuation/17e67cfe5669fe50",
  "evidence_class": "derived",
  "source": {
    "provider": "Advan Weekly Patterns Plus via Dewey Data",
    "license": "Dewey subscription; derived aggregates shared with the team via Atlas only; never commit to Git or redistribute",
    "weeks": ["2018-10-29", "2018-11-05", "2018-11-12", "2018-11-19"],
    "files": 36,
    "bbox": [-122.5, 39.0, -121.0, 40.3]          // extraction bbox, [w, s, e, n]
  },
  "timezone": "America/Los_Angeles",
  // UTC epoch seconds of each hourly bin over the event weeks (week 1 Monday 00:00 local
  // + i*3600). Length = 168 x number of event weeks.
  "hour_starts": [1541404800, 1541408400],
  "event_weeks": ["2018-11-05", "2018-11-12", "2018-11-19"],
  "baseline": {
    "weeks": ["2018-10-29"],
    // baseline arrays have 168 entries indexed by local hour-of-week (Mon 00:00 = 0);
    // the baseline for hour_starts[i] is baseline[i % 168].
    "method": "mean visits per local hour-of-week over the baseline weeks"
  },
  "regions": {
    // label states the rule and source; population = sum of ACS population of those block groups
    "evacuation_area": { "label": "Block groups \u226550% inside the reconstructed fire perimeter at 2018-11-09 08:00Z",
                         "block_groups": 32, "population": 33728 },
    "surrounding": { "label": "Rest of the extraction bbox" }
  },
  // One series per region x category. visits: len(hour_starts); baseline: 168.
  "series": [
    {
      "id": "evacuation_area:traveler_accommodation",
      "region": "evacuation_area",
      "category": "traveler_accommodation",
      "label": "Hotels and motels",
      "poi_count": 12,
      "visits": [0, 3],
      "baseline": [1, 0]
    }
  ],
  "cells": {
    "size_deg": 0.02,           // square grid on lon/lat, origin at (bbox w, bbox s)
    "min_pois": 3,
    "items": [
      {
        "id": "c_12_40",        // c_<col>_<row>, row 0 south
        "center": [-122.25, 39.81],
        "poi_count": 8,
        "in_evacuation_area": true,   // majority of its POIs are in evacuation-area block groups
        "visits": [0, 5],
        "baseline": [2, 1]
      }
    ]
  },
  // Weekly visitors whose Advan home block group is in the evacuation area, seen at POIs
  // outside it, summed per cell. Advan omits small home-CBG counts, so these are lower bounds.
  "origin_flows": {
    "origin_label": "Residents of the evacuation-area block groups",
    "baseline_week": "2018-10-29",
    "weeks": [
      {
        "week": "2018-11-05",
        "items": [{ "cell_id": "c_30_10", "center": [-121.6, 39.21], "visitors": 410, "baseline_visitors": 35 }]
      }
    ]
  },
  "notes": ["..."]
}
```

### What "evacuation area" means (per fire)

A block group (BG) is in `evacuation_area` if at least 50% of its area is covered, and
every other BG (including destination cities such as Chico) is `surrounding`. The package's
`population_units.geojson` is only a bbox selection and is **not** used as the region.

| Fire | Rule (source) |
|---|---|
| kincade-2019 | max `area_share` over zones >= 0.5 (`zone_population_crosswalk.json` rows; zones overlap, so shares are never summed). The crosswalk does not separate orders from warnings, so warning zones (21, 31-34) are included. |
| marshall-2021 | max `share_of_unit_area` over zones >= 0.5 (`zone_population_crosswalk.json`). Includes Everbridge warning zones (4, 9) as well as orders. |
| camp-2018 | >= 50% of a 0.002 deg lattice inside the BG is inside the last reconstructed perimeter in `camp-2018.json` (`fire.perimeters[-1]`, 2018-11-09 08:00Z). |
| woolsey-2018 | same lattice rule against the latest NASA FEDS perimeter at or before 2018-11-10T00:00Z (2018-11-09 20:00Z). |

The perimeter rule (Camp, Woolsey) undercounts the evacuated area, since people also left
from outside the burned area. These are reconstructed, not official, zones. `notes` repeats
the rule and counts. The UI should show `regions.evacuation_area.label` verbatim.

Categories (`category` ids → Advan `TOP_CATEGORY`): `all` (every POI),
`traveler_accommodation` (Traveler Accommodation), `gasoline_stations` (Gasoline
Stations), `grocery` (Grocery Stores), `general_merchandise` (General Merchandise Stores,
including Warehouse Clubs and Supercenters), `religious` (Religious Organizations),
`schools` (Elementary and Secondary Schools), `restaurants` (Restaurants and Other Eating
Places).

Caveats the UI must show: phone-panel estimates, not counts of people; one baseline week
per fire (Marshall's is Christmas week); Advan's handling of DST hours is unverified,
so hours after a DST change may be off by 1 h.
