"""Deterministic subset extraction from bulky Marshall Fire source downloads.

The full Census and FIRMS downloads are too large to package. This module
extracts a bbox-limited subset whose bytes are packaged under ``raw/`` as
``derived`` evidence. The full files' URL, byte size and SHA-256 are recorded
in ``sources.json`` so the extraction can be repeated and checked.
Only the Python standard library is used.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import struct
import zipfile
from pathlib import Path


BBOX = (-105.30, 39.90, -105.05, 40.03)  # west, south, east, north (lon/lat)
FIRMS_WINDOW_UTC = ("2021-12-29T00:00:00Z", "2022-01-03T00:00:00Z")

# (table, sequence, start position in the sequence row (1-based), cell count)
ACS_TABLES = {
    "B01001": ("0001", 7, 49),
    "B01003": ("0002", 130, 1),
    "B11001": ("0035", 7, 9),
    "B25044": ("0119", 114, 15),
    "B25046": ("0119", 148, 3),
}


class ExtractError(ValueError):
    """A bulky source cannot be subset safely."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_dbf(data: bytes) -> list[dict[str, str]]:
    if len(data) < 32:
        raise ExtractError("DBF header is truncated")
    count, header_len, record_len = struct.unpack("<IHH", data[4:12])
    fields = []
    offset = 32
    while data[offset] != 0x0D:
        name = data[offset:offset + 11].split(b"\0", 1)[0].decode("ascii")
        fields.append((name, data[offset + 16]))
        offset += 32
    rows = []
    for index in range(count):
        start = header_len + index * record_len
        record = data[start:start + record_len]
        if record[:1] == b"*":
            continue
        position = 1
        row = {}
        for name, length in fields:
            row[name] = record[position:position + length].decode("latin-1").strip()
            position += length
        rows.append(row)
    return rows


def read_shp_polygons(data: bytes) -> list[list[list[tuple[float, float]]] | None]:
    """Return each record's rings (lon, lat). Ring orientation is preserved."""
    if struct.unpack(">i", data[:4])[0] != 9994:
        raise ExtractError("not a shapefile")
    shapes = []
    offset = 100
    while offset < len(data):
        _, length_words = struct.unpack(">ii", data[offset:offset + 8])
        content = data[offset + 8:offset + 8 + length_words * 2]
        offset += 8 + length_words * 2
        shape_type = struct.unpack("<i", content[:4])[0]
        if shape_type == 0:
            shapes.append(None)
            continue
        if shape_type not in (5, 15, 25):
            raise ExtractError(f"unsupported shape type {shape_type}")
        num_parts, num_points = struct.unpack("<ii", content[36:44])
        parts = list(struct.unpack(f"<{num_parts}i", content[44:44 + 4 * num_parts]))
        point_base = 44 + 4 * num_parts
        points = [struct.unpack("<dd", content[point_base + 16 * i:point_base + 16 * i + 16])
                  for i in range(num_points)]
        rings = [points[a:b] for a, b in zip(parts, parts[1:] + [num_points])]
        shapes.append(rings)
    return shapes


def ring_area(ring: list[tuple[float, float]]) -> float:
    return sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1])) / 2


def rings_to_geometry(rings: list[list[tuple[float, float]]]) -> dict:
    """Shapefile outer rings are clockwise and holes counter-clockwise; RFC 7946
    wants the opposite, so every ring is reversed. A hole joins the preceding
    outer ring, as the shapefile specification orders them."""
    polygons: list[list[list[list[float]]]] = []
    for ring in rings:
        coords = [[x, y] for x, y in reversed(ring)]
        if ring_area(ring) < 0 or not polygons:
            polygons.append([coords])
        else:
            polygons[-1].append(coords)
    if len(polygons) == 1:
        return {"type": "Polygon", "coordinates": polygons[0]}
    return {"type": "MultiPolygon", "coordinates": polygons}


def segment_intersects_bbox(p: tuple[float, float], q: tuple[float, float]) -> bool:
    west, south, east, north = BBOX
    t0, t1 = 0.0, 1.0
    dx, dy = q[0] - p[0], q[1] - p[1]
    for denom, numer in ((-dx, p[0] - west), (dx, east - p[0]), (-dy, p[1] - south), (dy, north - p[1])):
        if denom == 0:
            if numer < 0:
                return False
            continue
        t = numer / denom
        if denom < 0:
            t0 = max(t0, t)
        else:
            t1 = min(t1, t)
        if t0 > t1:
            return False
    return True


def point_in_rings(x: float, y: float, rings: list[list[tuple[float, float]]]) -> bool:
    inside = False
    for ring in rings:
        for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                inside = not inside
    return inside


def polygon_intersects_bbox(rings: list[list[tuple[float, float]]]) -> bool:
    west, south, east, north = BBOX
    for ring in rings:
        if any(segment_intersects_bbox(a, b) for a, b in zip(ring, ring[1:] + ring[:1])):
            return True
    # bbox entirely inside the polygon
    return point_in_rings((west + east) / 2, (south + north) / 2, rings)


def extract_block_groups(tiger_zip: Path) -> dict:
    with zipfile.ZipFile(tiger_zip) as archive:
        names = {Path(name).suffix: name for name in archive.namelist()}
        shp, dbf = archive.read(names[".shp"]), archive.read(names[".dbf"])
    shapes, rows = read_shp_polygons(shp), read_dbf(dbf)
    if len(shapes) != len(rows):
        raise ExtractError("shapefile and DBF record counts differ")
    features = []
    for rings, row in zip(shapes, rows):
        if rings is None or not polygon_intersects_bbox(rings):
            continue
        features.append({
            "type": "Feature", "id": row["GEOID"],
            "geometry": rings_to_geometry(rings),
            "properties": {key: row[key] for key in ("GEOID", "STATEFP", "COUNTYFP", "TRACTCE", "BLKGRPCE",
                                                     "NAMELSAD", "ALAND", "AWATER", "INTPTLAT", "INTPTLON")},
        })
    features.sort(key=lambda feature: feature["id"])
    if not features:
        raise ExtractError("no block groups intersect the bbox")
    return {"type": "FeatureCollection", "features": features}


def extract_acs(acs_zip: Path, geoids: set[str]) -> dict:
    with zipfile.ZipFile(acs_zip) as archive:
        geo = archive.read("g20205co.csv").decode("latin-1")
        logrecnos = {}
        for row in csv.reader(io.StringIO(geo)):
            if row[2] == "150" and row[48].startswith("15000US") and row[48][7:] in geoids:
                logrecnos[row[4]] = {"geoid": row[48][7:], "name": row[49], "logrecno": row[4]}
        if set(item["geoid"] for item in logrecnos.values()) != geoids:
            raise ExtractError("ACS geography lacks some selected block groups")
        tables = {}
        for kind in ("e", "m"):
            for table, (sequence, start, cells) in sorted(ACS_TABLES.items()):
                text = archive.read(f"{kind}20205co{sequence}000.txt").decode("latin-1")
                for row in csv.reader(io.StringIO(text)):
                    if row[5] in logrecnos:
                        values = row[start - 1:start - 1 + cells]
                        tables.setdefault(logrecnos[row[5]]["geoid"], {}).setdefault(kind, {})[table] = values
    return {
        "acs_release": "ACS 2016-2020 5-year summary file (sequence-based), Colorado tracts/block groups",
        "geography_vintage": "2020 Census block groups",
        "tables": {table: {"sequence": seq, "start_position": start, "cells": cells}
                   for table, (seq, start, cells) in sorted(ACS_TABLES.items())},
        "block_groups": {geoid: {"name": next(v["name"] for v in logrecnos.values() if v["geoid"] == geoid),
                                 "estimates": tables[geoid]["e"], "margins_of_error": tables[geoid]["m"]}
                         for geoid in sorted(tables)},
    }


def extract_firms(csv_path: Path) -> bytes:
    """Keep the header and rows in the bbox and UTC date window, byte for byte."""
    west, south, east, north = BBOX
    start, end = FIRMS_WINDOW_UTC
    out = []
    with csv_path.open("rb") as handle:
        header = handle.readline()
        columns = header.decode().strip().split(",")
        index = {name: i for i, name in enumerate(columns)}
        out.append(header)
        for line in handle:
            parts = line.decode().strip().split(",")
            lat, lon = float(parts[index["latitude"]]), float(parts[index["longitude"]])
            date = parts[index["acq_date"]]
            if west <= lon <= east and south <= lat <= north and start[:10] <= date < end[:10]:
                out.append(line)
    return b"".join(out)


def encoded(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tiger-zip", type=Path)
    parser.add_argument("--acs-zip", type=Path)
    parser.add_argument("--firms-csv", type=Path, action="append", default=[])
    parser.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    if args.tiger_zip:
        block_groups = extract_block_groups(args.tiger_zip)
        (args.out_dir / "tiger2020-bg-subset.geojson").write_bytes(encoded(block_groups))
        print("block groups", len(block_groups["features"]), sha256_file(args.tiger_zip))
        if args.acs_zip:
            acs = extract_acs(args.acs_zip, {f["id"] for f in block_groups["features"]})
            (args.out_dir / "acs2020-5yr-bg-subset.json").write_bytes(encoded(acs))
            print("acs block groups", len(acs["block_groups"]), sha256_file(args.acs_zip))
    for csv_path in args.firms_csv:
        subset = extract_firms(csv_path)
        (args.out_dir / f"firms-subset-{csv_path.stem}.csv").write_bytes(subset)
        print("firms", csv_path.name, subset.count(b"\n") - 1, sha256_file(csv_path))


if __name__ == "__main__":
    main()
