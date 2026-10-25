"""Compact historical-fire files for the /fire page's 3D dioramas of real fires.

For each fire with observed NASA VEDA FEDS perimeters (Camp 2018, Kincade 2019, Woolsey 2018,
Marshall 2021) this reads the incident package's normalized perimeters and writes

    app/public/historical-fires/index.json           list of fires (id, name, t0, board, ...)
    app/public/historical-fires/<id>.json            ignitions, simplified perimeters, board, sources
    app/public/historical-fires/<id>.simulated.json  the replay bundle's simulated arrival grid

The perimeter file is observed data (satellite-derived cumulative perimeters, half-day time
precision). The `.simulated.json` file is model output copied from the replay bundle's
`fire_simulated` layer and is labelled simulated; it is written only when the bundle exists.

Geometry is simplified (Douglas-Peucker in local metres, `--tolerance-m`, default 60 m, well
under the 375 m VIIRS pixel the perimeters are built from) and rounded to 5 decimals. Snapshots
after the fire stopped growing are dropped; a snapshot whose area did not change keeps its time
with `geometry: null` ("same as the previous snapshot"), because the time still bounds when the
next growth happened. Board size mirrors `landscapeCellMetersFor` in app/src/fire/landscape.ts.

Units: coordinates WGS84 [lon, lat]; times UTC ISO-8601; `minute` = minutes after `t0` (the
earliest ignition); areas km2; board radius and cell in ground metres.

Standard library only. The incident packages and replay bundles are not in Git; pull them first
(`python3 -m tools.mongo_data pull`, bundles via `python3 -m sim ...`). From the repository root:

    python3 -m tools.build_historical_fires
    python3 -m tools.build_historical_fires --data-root /path/to/data/incidents \\
        --replays /path/to/app/public/replays
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_INDEX = "crisistwin.historical_fires/1"
SCHEMA_FIRE = "crisistwin.historical_fire/1"
SCHEMA_SIM = "crisistwin.historical_fire_simulated/1"

#: Mirrors MAX_GRID_CELLS_PER_SIDE in app/src/fire/landscape.ts.
MAX_GRID_CELLS_PER_SIDE = 900
#: Board margin around the final perimeter: 15 percent of the half-width plus this much.
BOARD_MARGIN_M = 1500.0
BOARD_MARGIN_FRACTION = 0.15
#: A snapshot counts as growth when it adds at least this share of the final area.
GROWTH_FRACTION = 0.002
#: Rings (outer or hole) smaller than this after simplification are dropped, km2.
MIN_RING_KM2 = 0.02
M_PER_DEG_LAT = 111_195.0

FEDS_SOURCE = {
    "id": "nasa-veda-feds",
    "provider": "NASA VEDA Fire Event Data Suite (FEDS) large-fire perimeter archive",
    "url": "https://openveda.cloud/api/features/collections/public.eis_fire_lf_perimeter_archive/items",
    "documentation": "https://docs.openveda.cloud/user-guide/notebooks/tutorials/mapping-fires.html",
    "license": "not stated on the VEDA collection endpoint",
}

FIRES = [
    {
        "id": "camp-2018",
        "name": "Camp Fire (2018)",
        "place": "Paradise, Butte County, California",
        "timezone": "America/Los_Angeles",
        "package": "camp-2018-paradise-slice/a6d2cc03f525ed65",
        "perimeters": "normalized/fire_perimeters.geojson",
        "feds_fire_id": "F17028",
        "bundle": "camp-2018.json",
        "ignitions": [
            {
                "id": "origin",
                "name": "Origin",
                "coord": [-121.434004, 39.81461],
                "at": "2018-11-08T14:20:00Z",
                "evidence_class": "reconstructed",
                "provenance": (
                    "Time from NIST TN 2252 Sec. 1.2 ('at approximately 06:20 on November 8, "
                    "2018'); place from NIST fire observation 0001 (origin, first 911 report)."
                ),
                "source": "https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.2252.pdf",
            }
        ],
    },
    {
        "id": "kincade-2019",
        "name": "Kincade Fire (2019)",
        "place": "Geyserville, Healdsburg and Windsor, Sonoma County, California",
        "timezone": "America/Los_Angeles",
        "package": "kincade-2019-evacuation/1f44d6f11dd290ac",
        "perimeters": "normalized/fire_perimeters.geojson",
        "feds_fire_id": "F15031",
        "bundle": "kincade-2019.json",
        "ignitions": [
            {
                "id": "origin",
                "name": "Origin",
                "coord": [-122.78005, 38.79246],
                "at": "2019-10-24T04:27:00Z",
                "evidence_class": "observed",
                "provenance": "CAL FIRE incident record: started 10/23/2019 9:27 PM PDT, published point.",
                "source": "https://incidents.fire.ca.gov/umbraco/api/IncidentApi/List?inactive=true&year=2019",
            }
        ],
    },
    {
        "id": "woolsey-2018",
        "name": "Woolsey Fire (2018)",
        "place": "Malibu, Thousand Oaks and Agoura Hills, Los Angeles and Ventura Counties, California",
        "timezone": "America/Los_Angeles",
        "package": "woolsey-2018-evacuation/9902f6caf7877f3d",
        "perimeters": "normalized/fire_perimeters.geojson",
        "feds_fire_id": "F17192",
        "bundle": "woolsey-2018.json",
        "ignitions": [
            {
                "id": "origin",
                "name": "Origin",
                "coord": [-118.70128, 34.235],
                "at": "2018-11-08T22:24:00Z",
                "evidence_class": "reported",
                "provenance": (
                    "First report 2:24 PM PST (Citygate AAR, CPUC SED, CAL FIRE incident page); "
                    "point as published by CAL FIRE ('E Street and Alfa Road, South of Simi Valley')."
                ),
                "source": "https://www.fire.ca.gov/incidents/2018/11/8/woolsey-fire/",
            }
        ],
    },
    {
        "id": "marshall-2021",
        "name": "Marshall Fire (2021)",
        "place": "Superior and Louisville, Boulder County, Colorado",
        "timezone": "America/Denver",
        "package": "marshall-2021-evacuation/415166c55516b100",
        "perimeters": "normalized/fire_perimeters.geojson",
        "feds_fire_id": "F2391",
        "bundle": "marshall-2021.json",
        "ignitions": [
            {
                "id": "eldorado-springs-fire",
                "name": "Eldorado Springs",
                "coord": [-105.2255, 39.9547],
                "at": "2021-12-30T18:05:00Z",
                "evidence_class": "reported",
                "provenance": (
                    "First reported about 11:05 MST (AAR, FLA); place approximate (+/- 400 m) near "
                    "the CO 93 / Eldorado Springs Dr / Marshall Rd junction (Boulder County "
                    "Investigative Summary 2023, pp. 4-6)."
                ),
                "source": "boco-investigative-summary-2023",
            },
            {
                "id": "trailhead-fire",
                "name": "Marshall Mesa Trailhead",
                "coord": [-105.2317, 39.952],
                "at": "2021-12-30T19:05:00Z",
                "evidence_class": "reported",
                "provenance": (
                    "Second ignition about one hour later; place approximate (+/- 200 m) south of "
                    "the Marshall Mesa Trailhead (Boulder County Investigative Summary 2023, p. 6)."
                ),
                "source": "boco-investigative-summary-2023",
            },
        ],
    },
]


def parse_utc(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc)


def iso(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def minutes_between(start: datetime, end: datetime) -> float:
    return round((end - start).total_seconds() / 60.0, 1)


# ------------------------------------------------------------------------------- geometry


def to_local(ring, lat0):
    kx = M_PER_DEG_LAT * math.cos(math.radians(lat0))
    return [(lon * kx, lat * M_PER_DEG_LAT) for lon, lat in ring]


def ring_area_m2(points) -> float:
    total = 0.0
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        total += x0 * y1 - x1 * y0
    return abs(total) / 2.0


def douglas_peucker(points, tolerance):
    """Indices kept by Douglas-Peucker on an open polyline (iterative)."""
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        first, last = stack.pop()
        if last - first < 2:
            continue
        (ax, ay), (bx, by) = points[first], points[last]
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy)
        worst, worst_d = -1, -1.0
        for i in range(first + 1, last):
            px, py = points[i]
            if length == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                d = abs(dy * px - dx * py + bx * ay - by * ax) / length
            if d > worst_d:
                worst, worst_d = i, d
        if worst_d > tolerance:
            keep[worst] = True
            stack.append((first, worst))
            stack.append((worst, last))
    return [i for i, k in enumerate(keep) if k]


def simplify_ring(ring, lat0, tolerance_m):
    """Simplified closed ring as [[lon, lat], ...] (closed), or None when too small."""
    if len(ring) < 4:
        return None
    if ring[0] != ring[-1]:
        ring = ring + [ring[0]]
    local = to_local(ring, lat0)
    if ring_area_m2(local) / 1e6 < MIN_RING_KM2:
        return None
    # Split the closed ring at its farthest vertex from the start so both halves are open.
    far = max(range(len(local)), key=lambda i: math.dist(local[0], local[i]))
    first = douglas_peucker(local[: far + 1], tolerance_m)
    second = [far + i for i in douglas_peucker(local[far:], tolerance_m)]
    kept = first + second[1:]
    out = [[round(ring[i][0], 5), round(ring[i][1], 5)] for i in kept]
    if len(out) < 4:
        return None
    out[-1] = out[0]
    return out


def simplify_geometry(geometry, lat0, tolerance_m):
    polygons = (
        [geometry["coordinates"]]
        if geometry["type"] == "Polygon"
        else geometry["coordinates"]
        if geometry["type"] == "MultiPolygon"
        else []
    )
    result = []
    for polygon in polygons:
        outer = simplify_ring(polygon[0], lat0, tolerance_m)
        if outer is None:
            continue
        holes = [h for h in (simplify_ring(r, lat0, tolerance_m) for r in polygon[1:]) if h]
        result.append([outer, *holes])
    return {"type": "MultiPolygon", "coordinates": result} if result else None


def geometry_bbox(geometry):
    xs, ys = [], []
    for polygon in geometry["coordinates"]:
        for lon, lat in polygon[0]:
            xs.append(lon)
            ys.append(lat)
    return [min(xs), min(ys), max(xs), max(ys)]


def cell_meters_for(radius_m: float) -> int:
    """Same rule as landscapeCellMetersFor (app/src/fire/landscape.ts)."""
    needed = (2 * radius_m) / MAX_GRID_CELLS_PER_SIDE
    return max(30, math.ceil(needed / 30) * 30)


def board_for(bbox):
    west, south, east, north = bbox
    lat = (south + north) / 2
    lon = (west + east) / 2
    half_w = (east - west) / 2 * M_PER_DEG_LAT * math.cos(math.radians(lat))
    half_h = (north - south) / 2 * M_PER_DEG_LAT
    radius = max(half_w, half_h) * (1 + BOARD_MARGIN_FRACTION) + BOARD_MARGIN_M
    radius = math.ceil(radius / 500) * 500
    return {
        "center": [round(lon, 5), round(lat, 5)],
        "radius_m": radius,
        "cell_m": cell_meters_for(radius),
    }


# ------------------------------------------------------------------------------- build


def snapshot_time(props) -> str:
    return props.get("snapshot_at") or props["t_utc"]


def snapshot_area(props) -> float:
    value = props.get("area_km2")
    return float(value if value is not None else props["farea_km2"])


def build_fire(spec, data_root: Path, replays: Path | None, tolerance_m: float):
    package_dir = data_root / spec["package"]
    path = package_dir / spec["perimeters"]
    collection = json.loads(path.read_text())
    features = sorted(collection["features"], key=lambda f: parse_utc(snapshot_time(f["properties"])))
    if not features:
        raise SystemExit(f"{path}: no perimeters")

    ignitions = spec["ignitions"]
    t0 = min(parse_utc(ig["at"]) for ig in ignitions)
    final_area = max(snapshot_area(f["properties"]) for f in features)

    # Last snapshot that still grew the fire by a visible amount.
    last_growth = 0
    previous = 0.0
    for index, feature in enumerate(features):
        area = snapshot_area(feature["properties"])
        if area - previous >= GROWTH_FRACTION * final_area or index == 0:
            last_growth = index
        previous = max(previous, area)
    features = features[: last_growth + 1]

    lat0 = sum(ig["coord"][1] for ig in ignitions) / len(ignitions)
    snapshots = []
    source_classes = set()
    previous_area = None
    for feature in features:
        props = feature["properties"]
        at = parse_utc(snapshot_time(props))
        area = snapshot_area(props)
        source_classes.add(props.get("evidence_class"))
        unchanged = previous_area is not None and abs(area - previous_area) <= 1e-6 * max(area, 1)
        geometry = None if unchanged else simplify_geometry(feature["geometry"], lat0, tolerance_m)
        if geometry is None and not unchanged:
            continue
        snapshots.append(
            {
                "at": iso(at),
                "minute": minutes_between(t0, at),
                "area_km2": round(area, 3),
                "geometry": geometry,
            }
        )
        previous_area = area

    final_geometry = next(s["geometry"] for s in reversed(snapshots) if s["geometry"])
    west, south, east, north = geometry_bbox(final_geometry)
    for ig in ignitions:
        west, east = min(west, ig["coord"][0]), max(east, ig["coord"][0])
        south, north = min(south, ig["coord"][1]), max(north, ig["coord"][1])
    bbox = [round(v, 5) for v in (west, south, east, north)]

    manifest = json.loads((package_dir / "manifest.json").read_text())
    simulated_file = None
    simulated = None
    if replays is not None:
        bundle_path = replays / spec["bundle"]
        if bundle_path.exists():
            simulated = build_simulated(spec, json.loads(bundle_path.read_text()), t0)
            if simulated is not None:
                simulated_file = f"{spec['id']}.simulated.json"

    fire = {
        "schema": SCHEMA_FIRE,
        "id": spec["id"],
        "name": spec["name"],
        "place": spec["place"],
        "timezone": spec["timezone"],
        "t0": iso(t0),
        "ignitions": [
            {**ig, "minute": minutes_between(t0, parse_utc(ig["at"]))} for ig in ignitions
        ],
        "perimeters": {
            "evidence_class": "observed",
            "source_evidence_class": sorted(c for c in source_classes if c),
            "method": "FEDS satellite-derived (VIIRS active fire) cumulative perimeter",
            "time_precision": "half_day",
            "time_note": (
                "FEDS snaps each perimeter to local noon or midnight; times are UTC derived "
                f"with {spec['timezone']}. Between snapshots the front is interpolated, not observed."
            ),
            "simplified_tolerance_m": tolerance_m,
            "feds_fire_id": spec["feds_fire_id"],
            "snapshots": snapshots,
        },
        "final_area_km2": round(final_area, 3),
        "bbox": bbox,
        "board": board_for(bbox),
        "simulated_file": simulated_file,
        "package": {
            "path": f"data/incidents/{spec['package']}",
            "package_version": manifest.get("package_version"),
            "perimeter_file": spec["perimeters"],
        },
        "sources": [FEDS_SOURCE],
        "generated_by": "tools/build_historical_fires.py",
    }
    return fire, simulated


def build_simulated(spec, bundle, t0: datetime):
    layer = bundle.get("fire_simulated")
    grid = (layer or {}).get("arrival_grid")
    if not grid or not grid.get("minutes"):
        return None
    minutes = grid["minutes"]
    ncols, nrows = int(grid["ncols"]), int(grid["nrows"])
    # Crop to the reached cells so the file stays small.
    rows = [r for r in range(nrows) if any(minutes[r * ncols + c] is not None for c in range(ncols))]
    cols = [c for c in range(ncols) if any(minutes[r * ncols + c] is not None for r in range(nrows))]
    if not rows or not cols:
        return None
    r0, r1, c0, c1 = rows[0], rows[-1], cols[0], cols[-1]
    cell = float(grid["cell_m"])
    cropped = [
        None if minutes[r * ncols + c] is None else round(float(minutes[r * ncols + c]), 1)
        for r in range(r0, r1 + 1)
        for c in range(c0, c1 + 1)
    ]
    sim_t0 = parse_utc(grid["t0"])
    model = layer.get("model") or {}
    calibration = layer.get("calibration") or {}
    return {
        "schema": SCHEMA_SIM,
        "id": spec["id"],
        "evidence_class": "simulated",
        "model": {"id": model.get("id"), "version": model.get("version")},
        "calibration_headline": calibration.get("headline"),
        "ignition_provenance": (layer.get("ignition") or {}).get("provenance"),
        "arrival_grid": {
            "origin_lon": grid["origin_lon"] + c0 * cell / grid["m_per_deg_lon"],
            "origin_lat": grid["origin_lat"] + r0 * cell / grid["m_per_deg_lat"],
            "cell_m": cell,
            "ncols": c1 - c0 + 1,
            "nrows": r1 - r0 + 1,
            "m_per_deg_lon": grid["m_per_deg_lon"],
            "m_per_deg_lat": grid["m_per_deg_lat"],
            "order": "row_major_south_first",
            "t0": grid["t0"],
            "minute_offset": minutes_between(t0, sim_t0),
            "minutes": cropped,
        },
        "source": f"app/public/replays/{spec['bundle']} fire_simulated",
        "generated_by": "tools/build_historical_fires.py",
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data-root", type=Path, default=ROOT / "data" / "incidents")
    parser.add_argument("--replays", type=Path, default=ROOT / "app" / "public" / "replays")
    parser.add_argument("--output", type=Path, default=ROOT / "app" / "public" / "historical-fires")
    parser.add_argument("--tolerance-m", type=float, default=60.0)
    args = parser.parse_args(argv)

    args.output.mkdir(parents=True, exist_ok=True)
    replays = args.replays if args.replays.exists() else None
    index = []
    for spec in FIRES:
        fire, simulated = build_fire(spec, args.data_root, replays, args.tolerance_m)
        out = args.output / f"{spec['id']}.json"
        out.write_text(json.dumps(fire, separators=(",", ":")) + "\n")
        if simulated is not None:
            (args.output / fire["simulated_file"]).write_text(
                json.dumps(simulated, separators=(",", ":")) + "\n"
            )
        snaps = fire["perimeters"]["snapshots"]
        index.append(
            {
                "id": fire["id"],
                "name": fire["name"],
                "place": fire["place"],
                "file": out.name,
                "t0": fire["t0"],
                "last_snapshot_at": snaps[-1]["at"],
                "final_area_km2": fire["final_area_km2"],
                "bbox": fire["bbox"],
                "board": fire["board"],
                "has_simulated": simulated is not None,
            }
        )
        print(
            f"{fire['id']}: {len(snaps)} snapshots to {snaps[-1]['at']}, board {fire['board']}, "
            f"{out.stat().st_size / 1024:.0f} KiB"
            + (f", simulated {(args.output / fire['simulated_file']).stat().st_size / 1024:.0f} KiB" if simulated else ""),
            file=sys.stderr,
        )
    (args.output / "index.json").write_text(
        json.dumps({"schema": SCHEMA_INDEX, "generated_by": "tools/build_historical_fires.py", "fires": index}, indent=1)
        + "\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
