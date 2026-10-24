"""Build per-fire mobility sidecars from licensed Advan Weekly Patterns Plus subsets.

Reads the regional parquet subsets (one directory per fire, files named
``<YYYY-MM-DD>--data_*.parquet``) and writes only aggregates to
``<output-dir>/<replay_id>.mobility.json`` (schema: docs/mobility-sidecar.md).
Licensed data: no per-POI rows, names or addresses are ever written, and
series or cells with fewer than MIN_POIS POIs are dropped.

Requires pyarrow, e.g.
    uv run -q --no-project --with pyarrow python -m tools.dewey_mobility \
        --subsets <dir> --output-dir app/public/replays
"""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from operator import add
from pathlib import Path
from zoneinfo import ZoneInfo

import pyarrow.parquet as pq

SCHEMA_VERSION = "1.0.0"
HOURS_PER_WEEK = 168
CELL_DEG = 0.02
MIN_POIS = 3
COLUMNS = ["ID_STORE", "LATITUDE", "LONGITUDE", "TOP_CATEGORY", "POI_CBG",
           "DATE_RANGE_START", "VISITS_BY_EACH_HOUR", "VISITOR_HOME_CBGS"]
ROOT = Path(__file__).resolve().parents[1]
INCIDENTS = ROOT / "data" / "incidents"

# Extraction bbox (w, s, e, n) from the Dewey extract script; the grid origin is (w, s).
# replay_id: subset dir, package, timezone, baseline weeks, event weeks.
FIRES = {
    "camp-2018": dict(subset="camp", package="camp-2018-evacuation/17e67cfe5669fe50",
                      tz="America/Los_Angeles", bbox=(-122.5, 39.0, -121.0, 40.3),
                      baseline=["2018-10-29"], event=["2018-11-05", "2018-11-12", "2018-11-19"],
                      area=dict(kind="replay_perimeter", file="camp-2018.json")),
    "woolsey-2018": dict(subset="woolsey", package="woolsey-2018-evacuation/4d4ccdead01abb0d",
                         tz="America/Los_Angeles", bbox=(-119.4, 33.9, -118.2, 34.5),
                         baseline=["2018-10-29"], event=["2018-11-05", "2018-11-12", "2018-11-19"],
                         area=dict(kind="feds_perimeter", file="fire_perimeters_feds.geojson",
                                   at_or_before="2018-11-10T00:00:00Z")),
    "kincade-2019": dict(subset="kincade", package="kincade-2019-evacuation/1f44d6f11dd290ac",
                         tz="America/Los_Angeles", bbox=(-123.3, 38.1, -122.3, 39.1),
                         baseline=["2019-10-14"], event=["2019-10-21", "2019-10-28", "2019-11-04"],
                         area=dict(kind="crosswalk_rows",
                                   label="Block groups \u226550% inside the 2019 EOC evacuation zones")),
    "marshall-2021": dict(subset="marshall", package="marshall-2021-evacuation/415166c55516b100",
                          tz="America/Denver", bbox=(-105.4, 39.7, -104.8, 40.2),
                          baseline=["2021-12-20"], event=["2021-12-27", "2022-01-03", "2022-01-10"],
                          area=dict(kind="crosswalk_zones",
                                    label="Block groups \u226550% inside the Boulder County Everbridge evacuation launch areas")),
}
# category id -> (Advan TOP_CATEGORY, label); "all" matches every POI.
CATEGORIES = {
    "all": (None, "All places"),
    "traveler_accommodation": ("Traveler Accommodation", "Hotels and motels"),
    "gasoline_stations": ("Gasoline Stations", "Gas stations"),
    "grocery": ("Grocery Stores", "Grocery stores"),
    "general_merchandise": ("General Merchandise Stores, including Warehouse Clubs and Supercenters",
                            "General merchandise and warehouse clubs"),
    "religious": ("Religious Organizations", "Places of worship"),
    "schools": ("Elementary and Secondary Schools", "K-12 schools"),
    "restaurants": ("Restaurants and Other Eating Places", "Restaurants"),
}
TOP_TO_ID = {top: cid for cid, (top, _) in CATEGORIES.items() if top}
REGIONS = {
    "evacuation_area": None,   # label depends on the fire's area rule
    "surrounding": "Rest of the extraction bbox",
}
AREA_SHARE_MIN = 0.5      # a block group joins the evacuation area at this overlap share
LATTICE_DEG = 0.002       # lattice of cell centres for perimeter overlap (matches the zone crosswalks)
ORIGIN_LABEL = "Residents of the evacuation-area block groups"
SOURCE = {
    "provider": "Advan Weekly Patterns Plus via Dewey Data",
    "license": "Dewey subscription; derived aggregates shared with the team via Atlas only; never commit to Git or redistribute",
}


def clean(value: float):
    return int(value) if float(value).is_integer() else round(value, 3)


def local_monday_utc(week: str, tz: ZoneInfo) -> int:
    return int(datetime.combine(date.fromisoformat(week), datetime.min.time(), tz).timestamp())


def utc_offset(week: str, tz: ZoneInfo):
    return datetime.combine(date.fromisoformat(week), datetime.min.time(), tz).utcoffset()


def cell_of(lon: float, lat: float, w: float, s: float):
    return math.floor((lon - w) / CELL_DEG), math.floor((lat - s) / CELL_DEG)


def add_into(acc: list[int], values: list[int], offset: int):
    acc[offset:offset + HOURS_PER_WEEK] = map(add, acc[offset:offset + HOURS_PER_WEEK], values)


def spans(polys, y):
    """Sorted even-odd crossing x values of every ring of ``polys`` on the horizontal line y."""
    xs = []
    for rings in polys:
        for ring in rings:
            for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
                if (y1 <= y) != (y2 <= y):
                    xs.append(x1 + (y - y1) * (x2 - x1) / (y2 - y1))
    xs.sort()
    return list(zip(xs[0::2], xs[1::2]))


def lattice_count(intervals, h=LATTICE_DEG):
    return sum(math.ceil(b / h - 0.5) - math.ceil(a / h - 0.5) for a, b in intervals)


def intersect(a, b):
    out, i, j = [], 0, 0
    while i < len(a) and j < len(b):
        lo, hi = max(a[i][0], b[j][0]), min(a[i][1], b[j][1])
        if lo < hi:
            out.append((lo, hi))
        i, j = (i + 1, j) if a[i][1] < b[j][1] else (i, j + 1)
    return out


def polygons(geometry):
    return geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]


def perimeter_overlap_share(bg_polys, perimeter_polys, cache):
    """Share of the block group's 0.002 deg lattice points that fall inside the perimeter."""
    ys = [y for rings in bg_polys for ring in rings for _, y in ring]
    h, total, inside = LATTICE_DEG, 0, 0
    for j in range(math.ceil(min(ys) / h - 0.5), math.floor(max(ys) / h - 0.5) + 1):
        y = (j + 0.5) * h
        bg = spans(bg_polys, y)
        total += lattice_count(bg)
        if bg:
            if j not in cache:
                cache[j] = spans(perimeter_polys, y)
            inside += lattice_count(intersect(bg, cache[j]))
    if total:
        return inside / total
    ring = [pt for rings in bg_polys for pt in rings[0]]    # no lattice point: test the vertex centroid
    cx, cy = sum(x for x, _ in ring) / len(ring), sum(y for _, y in ring) / len(ring)
    return float(any(a <= cx < b for a, b in spans(perimeter_polys, cy)))


def evacuation_geoids(replay_id: str, cfg: dict, units: dict):
    """Return (geoid set, label, notes) for the block groups that qualify as the evacuation area."""
    area, normalized = cfg["area"], INCIDENTS / cfg["package"] / "normalized"
    kind = area["kind"]
    if kind in ("crosswalk_rows", "crosswalk_zones"):
        cw = json.loads((normalized / "zone_population_crosswalk.json").read_text())
        pairs = ([(r["geoid"], r["zone_id"], r["area_share"]) for r in cw["rows"]] if kind == "crosswalk_rows" else
                 [(u["geoid"], z["zone_id"], u["share_of_unit_area"]) for z in cw["zones"] for u in z["units"]])
        best = defaultdict(float)
        for geoid, _, share in pairs:    # zones overlap, so take the max share, never the sum
            best[geoid] = max(best[geoid], share)
        geoids = {g for g, share in best.items() if share >= AREA_SHARE_MIN}
        notes = [f"Evacuation area = block groups with max(area_share over zones) >= {AREA_SHARE_MIN} in "
                 f"zone_population_crosswalk.json ({len(best)} block groups touch a zone, {len(geoids)} qualify)."]
        if kind == "crosswalk_rows":
            notes.append("The Kincade crosswalk has one row per matrix zone and does not separate evacuation orders "
                         "from warnings, so warning zones (21 and 31-34 per tools/kincade_common.py) count as "
                         "evacuation area.")
        else:
            titles = {f["properties"]["zone_id"]: f["properties"].get("message_title")
                      for f in json.loads((normalized / "evacuation_zones.geojson").read_text())["features"]}
            orders = defaultdict(float)
            for geoid, zone, share in pairs:
                if titles.get(zone) == "Evacuation Order":
                    orders[geoid] = max(orders[geoid], share)
            only_warning = len(geoids - {g for g, share in orders.items() if share >= AREA_SHARE_MIN})
            notes.append(f"The Marshall crosswalk includes Everbridge warning zones (4 and 9) as well as orders; "
                         f"{only_warning} of the {len(geoids)} qualifying block groups qualify only through warnings.")
        return geoids, area["label"], notes
    if kind == "replay_perimeter":
        perimeter = json.loads((ROOT / "app" / "public" / "replays" / area["file"]).read_text())["fire"]["perimeters"][-1]
        when, geometry, source = perimeter["at"], perimeter["geometry"], "reconstructed fire perimeter"
    else:
        cutoff = datetime.fromisoformat(area["at_or_before"])
        feats = [f for f in json.loads((normalized / area["file"]).read_text())["features"]
                 if datetime.fromisoformat(f["properties"]["snapshot_at"]) <= cutoff]
        chosen = max(feats, key=lambda f: f["properties"]["snapshot_at"])
        when, geometry, source = chosen["properties"]["snapshot_at"], chosen["geometry"], "NASA FEDS reconstructed fire perimeter"
    perimeter_polys, cache = polygons(geometry), {}
    geoids = {g for g, feature in units.items()
              if perimeter_overlap_share(polygons(feature["geometry"]), perimeter_polys, cache) >= AREA_SHARE_MIN}
    stamp = when.replace("T", " ").rstrip("Z")[:16] + "Z"
    label = f"Block groups \u226550% inside the reconstructed fire perimeter at {stamp}"
    notes = [f"Evacuation area = package block groups with >= {AREA_SHARE_MIN} of a {LATTICE_DEG} deg lattice inside the "
             f"{source} at {when} ({len(geoids)} of {len(units)} qualify).",
             "A fire perimeter undercounts the evacuated area (people left from outside the burned area), so the "
             "evacuation-area region and origin flows are lower bounds."]
    return geoids, label, notes


def build(replay_id: str, cfg: dict, subsets: Path) -> dict:
    tz = ZoneInfo(cfg["tz"])
    w, s, e, n = cfg["bbox"]
    baseline, event = cfg["baseline"], cfg["event"]
    weeks = baseline + event
    nbins = HOURS_PER_WEEK * len(event)
    geojson = json.loads((INCIDENTS / cfg["package"] / "normalized" / "population_units.geojson").read_text())
    units = {f["properties"]["geoid"]: f for f in geojson["features"]}
    geoids, area_label, area_notes = evacuation_geoids(replay_id, cfg, units)
    population = sum(units[g]["properties"].get("population") or 0 for g in geoids if g in units)
    outside_package = len(geoids - units.keys())
    mondays = [date.fromisoformat(x) for x in event]
    if any(mondays[i + 1] - mondays[i] != timedelta(days=7) for i in range(len(mondays) - 1)):
        raise SystemExit(f"{replay_id}: event weeks are not exactly 7 days apart")
    if any(d.weekday() != 0 for d in mondays + [date.fromisoformat(x) for x in baseline]):
        raise SystemExit(f"{replay_id}: a configured week does not start on a Monday")

    files = sorted((subsets / cfg["subset"]).glob("*--data_*.parquet"))
    by_week = Counter(f.name.split("--")[0] for f in files)
    missing = [x for x in weeks if not by_week[x]]
    if missing:
        raise SystemExit(f"{replay_id}: no files for weeks {missing}")
    stray = {k: v for k, v in by_week.items() if k not in weeks}
    files = [f for f in files if f.name.split("--")[0] in weeks]

    seen: dict[tuple, int] = {}            # (store, week) -> hash of the kept row's payload
    dup_identical = dup_differing = 0
    stats = Counter()
    stores: dict[str, tuple] = {}          # store -> (cell, in_evac, category id or None), first seen
    cell_stores: dict[tuple, set] = defaultdict(set)
    zeros = lambda: [0] * nbins
    cell_visits, cell_base = defaultdict(zeros), defaultdict(lambda: [0] * HOURS_PER_WEEK)
    series_visits, series_base = defaultdict(zeros), defaultdict(lambda: [0] * HOURS_PER_WEEK)
    series_stores: dict[tuple, set] = defaultdict(set)
    flows: dict[tuple, int] = defaultdict(int)   # (week, cell) -> visitors
    rows_per_week = Counter()

    for f in files:
        week = f.name.split("--")[0]
        table = pq.read_table(f, columns=COLUMNS).to_pydict()
        for i in range(len(table["ID_STORE"])):
            store, hours_raw = table["ID_STORE"][i], table["VISITS_BY_EACH_HOUR"][i]
            lat, lon, cbg = table["LATITUDE"][i], table["LONGITUDE"][i], table["POI_CBG"][i]
            stats["rows"] += 1
            started = table["DATE_RANGE_START"][i]
            if started is None or started.date().isoformat() != week:
                stats["date_range_start_mismatch"] += 1
            try:
                hours = json.loads(hours_raw)
                ok = isinstance(hours, list) and len(hours) == HOURS_PER_WEEK and all(isinstance(v, int) for v in hours)
            except (TypeError, ValueError):
                ok = False
            if not ok:
                stats["bad_hours_skipped"] += 1
                continue
            if store is None or lat is None or lon is None or not (w <= lon <= e and s <= lat <= n):
                stats["bad_location_skipped"] += 1
                continue
            home_raw = table["VISITOR_HOME_CBGS"][i]
            key, digest = (store, week), hash((hours_raw, home_raw))
            if key in seen:
                if seen[key] == digest:
                    dup_identical += 1
                else:
                    dup_differing += 1
                continue
            seen[key] = digest
            rows_per_week[week] += 1
            cell = cell_of(lon, lat, w, s)
            category = TOP_TO_ID.get((table["TOP_CATEGORY"][i] or "").strip())
            in_evac = cbg in geoids
            attrs = (cell, in_evac, category)
            if stores.setdefault(store, attrs) != attrs:
                stats["store_attrs_changed_across_weeks"] += 1
            cell, in_evac, category = stores[store]
            cell_stores[cell].add(store)
            region = "evacuation_area" if in_evac else "surrounding"
            targets = [("all", region)] + ([(category, region)] if category else [])
            is_event = week in event
            offset = event.index(week) * HOURS_PER_WEEK if is_event else 0
            for cat, reg in targets:
                series_stores[(reg, cat)].add(store)
                add_into((series_visits if is_event else series_base)[(reg, cat)], hours, offset)
            add_into((cell_visits if is_event else cell_base)[cell], hours, offset)
            if not in_evac and home_raw:
                try:
                    flows[(week, cell)] += sum(v for k, v in json.loads(home_raw).items() if k in geoids)
                except (ValueError, AttributeError):
                    stats["bad_home_cbgs"] += 1

    nb = len(baseline)
    def base(arr):
        return [clean(v / nb) for v in arr]

    series = []
    for reg in REGIONS:
        for cat, (_, label) in CATEGORIES.items():
            count = len(series_stores.get((reg, cat), ()))
            if count < MIN_POIS:
                continue
            series.append({"id": f"{reg}:{cat}", "region": reg, "category": cat, "label": label,
                           "poi_count": count, "visits": series_visits[(reg, cat)],
                           "baseline": base(series_base[(reg, cat)])})

    keep = {c for c, ids in cell_stores.items() if len(ids) >= MIN_POIS}
    def cid(c):
        return f"c_{c[0]}_{c[1]}"
    def center(c):
        return [round(w + (c[0] + 0.5) * CELL_DEG, 5), round(s + (c[1] + 0.5) * CELL_DEG, 5)]
    items = []
    for c in sorted(keep, key=lambda c: (c[1], c[0])):
        ids = cell_stores[c]
        items.append({"id": cid(c), "center": center(c), "poi_count": len(ids),
                      "in_evacuation_area": 2 * sum(stores[x][1] for x in ids) > len(ids),
                      "visits": cell_visits[c], "baseline": base(cell_base[c])})

    flow_weeks = []
    for week in event:
        rows = []
        for c in keep:
            v, b = flows.get((week, c), 0), flows.get((baseline[0], c), 0)
            if v > 0 or b > 0:
                rows.append({"cell_id": cid(c), "center": center(c), "visitors": v, "baseline_visitors": b})
        rows.sort(key=lambda r: (-r["visitors"], r["cell_id"]))
        flow_weeks.append({"week": week, "items": rows})

    offsets = {x: utc_offset(x, tz) for x in weeks}
    dst = sorted(x for x in event if offsets[x] != offsets[event[0]])
    notes = area_notes + [
        f"Evacuation area: {len(geoids)} block groups, ACS population {population}"
        + (f" ({outside_package} qualifying block groups are not in population_units and add no population)"
           if outside_package else "") + ". Block groups outside it, including destination cities, count as surrounding.",
        f"Input: {len(files)} parquet files, {stats['rows']} rows"
        + (f"; ignored files for weeks not in config: {dict(stray)}" if stray else "") + ".",
        f"Distinct POIs (ID_STORE) used: {len(stores)}; POI rows kept per week: {dict(sorted(rows_per_week.items()))}. "
        "The panel is whatever POIs Advan reports each week, so week-to-week changes include POI coverage changes.",
        f"Duplicate (ID_STORE, week) rows across files: {dup_identical} identical, {dup_differing} with different "
        "payloads; the first in sorted file-name order was kept and the rest dropped.",
        f"Skipped rows: {stats['bad_hours_skipped']} with VISITS_BY_EACH_HOUR not a 168-integer list, "
        f"{stats['bad_location_skipped']} with missing id or coordinates outside the bbox.",
        f"Other checks: {stats['date_range_start_mismatch']} rows whose DATE_RANGE_START date differs from the file's week "
        f"prefix; {stats['bad_home_cbgs']} unparseable VISITOR_HOME_CBGS (counted as no flow); "
        f"{stats['store_attrs_changed_across_weeks']} rows whose cell, CBG or category differed from the POI's first sighting "
        "(first sighting is used).",
        f"hour_starts are continuous UTC hours from {event[0]} 00:00 {cfg['tz']} ({offsets[event[0]]} offset); "
        + (f"the UTC offset changes in event weeks {dst}, where Advan's local-hour handling is unverified, so those "
           "hours may be off by 1 h." if dst else "no DST change occurs in the event weeks.")
        + f" Baseline weeks UTC offsets: {[str(offsets[x]) for x in baseline]}.",
        f"Series and cells with fewer than {MIN_POIS} POIs are dropped (series too, so no series is a single POI's "
        "data). A cell is in_evacuation_area only if strictly more than half of its POIs are.",
        "Origin flows count VISITOR_HOME_CBGS entries for evacuation-area block groups at POIs outside the area; "
        "Advan omits small counts, so these are lower bounds.",
    ]
    return {
        "kind": "crisistwin_mobility", "schema_version": SCHEMA_VERSION, "replay_id": replay_id,
        "incident_package": cfg["package"], "evidence_class": "derived",
        "source": {**SOURCE, "weeks": weeks, "files": len(files), "bbox": list(cfg["bbox"])},
        "timezone": cfg["tz"],
        "hour_starts": [local_monday_utc(event[0], tz) + i * 3600 for i in range(nbins)],
        "event_weeks": event,
        "baseline": {"weeks": baseline, "method": "mean visits per local hour-of-week over the baseline weeks"},
        "regions": {"evacuation_area": {"label": area_label, "block_groups": len(geoids), "population": population},
                    "surrounding": {"label": REGIONS["surrounding"]}},
        "series": series,
        "cells": {"size_deg": CELL_DEG, "min_pois": MIN_POIS, "items": items},
        "origin_flows": {"origin_label": ORIGIN_LABEL, "baseline_week": baseline[0], "weeks": flow_weeks},
        "notes": notes,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--subsets", type=Path, required=True, help="dir holding one subset dir per fire")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "app" / "public" / "replays")
    parser.add_argument("--fire", choices=sorted(FIRES), help="build one fire (default: all)")
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for replay_id in [args.fire] if args.fire else FIRES:
        doc = build(replay_id, FIRES[replay_id], args.subsets)
        out = args.output_dir / f"{replay_id}.mobility.json"
        out.write_text(json.dumps(doc, separators=(",", ":")) + "\n")
        print(f"{out}: {out.stat().st_size} bytes, {len(doc['cells']['items'])} cells, "
              f"{len(doc['series'])} series, {len(doc['hour_starts'])} hours")
        for note in doc["notes"][:8]:
            print("  ", note)


if __name__ == "__main__":
    main()
