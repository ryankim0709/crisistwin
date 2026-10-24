"""ACS 2014-2018 5-year block-group population layer for the Kincade package.

Vintage choice: the 2014-2018 ACS (released December 2019, after the fire)
is the five-year period ending in the year before the fire; the 2013-2017
release is the latest that was public on 2019-10-23. Both describe pre-fire
residents; the package uses 2014-2018 and states it.

Inputs are bulky federal files, so ``extract_subset`` (run once with the full
downloads) writes a deterministic subset that the package keeps; offline
verification rebuilds the normalized layer from that subset.
"""

from __future__ import annotations

import csv
import io
import json
import struct
import zipfile

from tools.kincade_common import BBOX, SourceError, bbox_of, walk_coords

ACS_BASE = "https://www2.census.gov/programs-surveys/acs/summary_file/2018/data/5_year_seq_by_state/California/Tracts_Block_Groups_Only"
TIGER_URL = "https://www2.census.gov/geo/tiger/TIGER2018/BG/tl_2018_06_bg.zip"
ACS_VINTAGE = "ACS 2014-2018 5-year"
# table -> (sequence, 1-based start column including the six header fields, cell count)
TABLES = {
    "B01001": ("0002", 7, 49),
    "B01003": ("0003", 130, 1),
    "B11001": ("0036", 7, 9),
    "B25044": ("0114", 114, 15),
    "B25046": ("0114", 148, 3),
}
AGE_65_PLUS_CELLS = (20, 21, 22, 23, 24, 25, 44, 45, 46, 47, 48, 49)  # B01001 male/female 65+
SOURCE_ID = "census-acs-2018-5yr-bg"
TIGER_SOURCE_ID = "census-tiger-2018-bg"


# --------------------------------------------------------------------------- shapefile
def read_dbf(data: bytes) -> list[dict]:
    if len(data) < 32:
        raise SourceError("dbf too short")
    count, header_len, record_len = struct.unpack("<IHH", data[4:12])
    fields = []
    offset = 32
    while data[offset] != 0x0D:
        name = data[offset:offset + 11].split(b"\0", 1)[0].decode("ascii")
        length = data[offset + 16]
        fields.append((name, length))
        offset += 32
    rows = []
    for index in range(count):
        start = header_len + index * record_len
        record = data[start:start + record_len]
        if record[:1] == b"*":
            continue
        pos = 1
        row = {}
        for name, length in fields:
            row[name] = record[pos:pos + length].decode("latin-1").strip()
            pos += length
        rows.append(row)
    return rows


def _ring_area2(ring: list[list[float]]) -> float:
    return sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:]))


def read_shp_polygons(data: bytes) -> list[dict | None]:
    if struct.unpack(">I", data[:4])[0] != 9994:
        raise SourceError("not a shapefile")
    shapes: list[dict | None] = []
    offset = 100
    while offset < len(data):
        _, content_words = struct.unpack(">II", data[offset:offset + 8])
        content = data[offset + 8:offset + 8 + content_words * 2]
        offset += 8 + content_words * 2
        shape_type = struct.unpack("<i", content[:4])[0]
        if shape_type == 0:
            shapes.append(None)
            continue
        if shape_type != 5:
            raise SourceError(f"unsupported shape type {shape_type}")
        num_parts, num_points = struct.unpack("<ii", content[36:44])
        parts = list(struct.unpack(f"<{num_parts}i", content[44:44 + 4 * num_parts]))
        base = 44 + 4 * num_parts
        flat = struct.unpack(f"<{2 * num_points}d", content[base:base + 16 * num_points])
        points = [[flat[2 * i], flat[2 * i + 1]] for i in range(num_points)]
        polygons: list[list[list[list[float]]]] = []
        for i, start in enumerate(parts):
            ring = points[start:parts[i + 1] if i + 1 < num_parts else num_points]
            if _ring_area2(ring) < 0:  # shapefile outer rings are clockwise
                polygons.append([ring[::-1]])  # RFC 7946: exterior counter-clockwise
            elif polygons:
                polygons[-1].append(ring[::-1])
            else:
                raise SourceError("shapefile hole precedes its outer ring")
        geometry = ({"type": "Polygon", "coordinates": polygons[0]} if len(polygons) == 1
                    else {"type": "MultiPolygon", "coordinates": polygons})
        shapes.append(geometry)
    return shapes


# --------------------------------------------------------------------------- subset
def extract_subset(tiger_zip: bytes, geo_txt: bytes, seq_zips: dict[str, bytes]) -> tuple[bytes, bytes]:
    """Return (block-group GeoJSON subset, ACS JSON subset) for BGs overlapping BBOX."""
    archive = zipfile.ZipFile(io.BytesIO(tiger_zip))
    shapes = read_shp_polygons(archive.read("tl_2018_06_bg.shp"))
    rows = read_dbf(archive.read("tl_2018_06_bg.dbf"))
    if len(shapes) != len(rows):
        raise SourceError("TIGER shp/dbf record counts differ")
    west, south, east, north = BBOX
    features = []
    for geometry, row in zip(shapes, rows):
        if geometry is None:
            continue
        x0, y0, x1, y1 = bbox_of(walk_coords(geometry["coordinates"]))
        if x1 < west or x0 > east or y1 < south or y0 > north:
            continue
        features.append({"type": "Feature", "id": row["GEOID"], "geometry": geometry,
                         "properties": {k: row[k] for k in ("GEOID", "STATEFP", "COUNTYFP", "TRACTCE", "BLKGRPCE", "NAMELSAD", "ALAND", "AWATER")}})
    features.sort(key=lambda f: f["id"])
    wanted = {f["id"] for f in features}
    logrec = {}
    for line in geo_txt.decode("latin-1").splitlines():
        if line[8:11] == "150" and line[11:13] == "00":
            geoid = line[178:218].strip()
            if geoid.startswith("15000US") and geoid[7:] in wanted:
                logrec[line[13:20]] = geoid[7:]
    if set(logrec.values()) != wanted:
        raise SourceError("ACS geography file lacks some TIGER block groups")
    values: dict[str, dict] = {g: {} for g in wanted}
    for seq, payload in sorted(seq_zips.items()):
        z = zipfile.ZipFile(io.BytesIO(payload))
        for kind in ("e", "m"):
            text = z.read(f"{kind}20185ca{seq}000.txt").decode("latin-1")
            for rec in csv.reader(io.StringIO(text)):
                geoid = logrec.get(rec[5])
                if geoid is None:
                    continue
                for table, (tseq, start, cells) in TABLES.items():
                    if tseq == seq:
                        values[geoid][f"{kind}_{table}"] = rec[start - 1:start - 1 + cells]
    for geoid, record in values.items():
        if len(record) != 2 * len(TABLES):
            raise SourceError(f"ACS subset incomplete for {geoid}")
    geo = (json.dumps({"type": "FeatureCollection", "features": features}, sort_keys=True, separators=(",", ":")) + "\n").encode()
    acs = (json.dumps({"vintage": ACS_VINTAGE, "tables": TABLES, "values": values}, sort_keys=True, separators=(",", ":")) + "\n").encode()
    return geo, acs


PLACE_URL = "https://www2.census.gov/geo/tiger/TIGER2018/PLACE/tl_2018_06_place.zip"
PLACE_NAMES = ("Geyserville",)  # places named as order targets in the matrix


def extract_places(place_zip: bytes) -> bytes:
    archive = zipfile.ZipFile(io.BytesIO(place_zip))
    shapes = read_shp_polygons(archive.read("tl_2018_06_place.shp"))
    rows = read_dbf(archive.read("tl_2018_06_place.dbf"))
    if len(shapes) != len(rows):
        raise SourceError("TIGER place shp/dbf record counts differ")
    features = [{"type": "Feature", "id": row["GEOID"], "geometry": geometry,
                 "properties": {k: row[k] for k in ("GEOID", "NAME", "NAMELSAD", "LSAD", "CLASSFP", "ALAND", "AWATER")}}
                for geometry, row in zip(shapes, rows) if row["NAME"] in PLACE_NAMES and geometry]
    if len(features) != len(PLACE_NAMES):
        raise SourceError("TIGER place subset did not find every named place exactly once")
    features.sort(key=lambda f: f["id"])
    return (json.dumps({"type": "FeatureCollection", "features": features}, sort_keys=True, separators=(",", ":")) + "\n").encode()


# --------------------------------------------------------------------------- normalize
def _cell(cells: list[str], index: int, field: str, geoid: str) -> tuple[int | None, str | None]:
    raw = cells[index - 1].strip()
    if raw in ("", "."):
        return None, f"{field} not published for {geoid}"
    try:
        return int(raw), None
    except ValueError:
        raise SourceError(f"{geoid}: non-integer {field} value {raw!r}") from None


def normalize_population(geo_subset: bytes, acs_subset: bytes) -> tuple[dict, dict]:
    geo = json.loads(geo_subset)
    acs = json.loads(acs_subset)
    if acs.get("vintage") != ACS_VINTAGE:
        raise SourceError("unexpected ACS vintage")
    features = []
    for feature in geo["features"]:
        geoid = feature["id"]
        record = acs["values"][geoid]
        props = {"geoid": geoid, "acs_vintage": ACS_VINTAGE, "name": feature["properties"]["NAMELSAD"],
                 "county_fips": "06" + feature["properties"]["COUNTYFP"],
                 "aland_m2": int(feature["properties"]["ALAND"]), "awater_m2": int(feature["properties"]["AWATER"])}
        reasons = {}

        def put(field: str, table: str, index: int) -> int | None:
            est, why = _cell(record[f"e_{table}"], index, field, geoid)
            moe, _ = _cell(record[f"m_{table}"], index, field, geoid)
            props[field] = est
            props[f"moe_{field}"] = moe
            if why:
                reasons[field] = why
            return est

        put("population", "B01003", 1)
        put("households", "B11001", 1)
        put("occupied_housing_units", "B25044", 1)
        put("vehicles_available_total", "B25046", 1)
        none_owner, _ = _cell(record["e_B25044"], 3, "x", geoid)
        none_renter, _ = _cell(record["e_B25044"], 10, "x", geoid)
        props["households_no_vehicle"] = None if None in (none_owner, none_renter) else none_owner + none_renter
        props["moe_households_no_vehicle"] = None
        props["moe_households_no_vehicle_status"] = "not_computed (sum of two ACS cells; combined MOE not derived)"
        breakdown = {}
        for label, owner_idx, renter_idx in (("0", 3, 10), ("1", 4, 11), ("2", 5, 12), ("3", 6, 13), ("4", 7, 14), ("5_plus", 8, 15)):
            o, _ = _cell(record["e_B25044"], owner_idx, "x", geoid)
            r, _ = _cell(record["e_B25044"], renter_idx, "x", geoid)
            breakdown[label] = None if None in (o, r) else o + r
        props["households_by_vehicles_available"] = breakdown
        ages = [_cell(record["e_B01001"], i, "x", geoid)[0] for i in AGE_65_PLUS_CELLS]
        props["population_65_plus"] = None if None in ages else sum(ages)
        props["moe_population_65_plus"] = None
        props["moe_population_65_plus_status"] = "not_computed (sum of 12 ACS cells)"
        props["value_status"] = reasons or None
        props["tables"] = {"population": "B01003", "households": "B11001", "vehicles": "B25044, B25046", "age": "B01001"}
        props["evidence_class"] = "observed"
        props["derived_fields"] = ["households_no_vehicle", "households_by_vehicles_available", "population_65_plus"]
        props["source_id"] = SOURCE_ID
        props["geometry_source_id"] = TIGER_SOURCE_ID
        features.append({"type": "Feature", "id": geoid, "geometry": feature["geometry"], "properties": props})
    quality = {
        "block_group_count": len(features),
        "population_total": sum(f["properties"]["population"] or 0 for f in features),
        "households_total": sum(f["properties"]["households"] or 0 for f in features),
        "selection": "TIGER 2018 block groups whose bounding box overlaps the package bbox (so totals exceed the evacuated area)",
        "notes": [
            "TIGER/Line geometry is NAD83 longitude/latitude, used as OGC:CRS84 (sub-metre difference).",
            "ACS values are survey estimates with 90% MOEs; MOEs of derived sums are not computed.",
            "ACS 2014-2018 was released after the fire; it describes the pre-fire resident population.",
        ],
    }
    return {"type": "FeatureCollection", "features": features}, quality


# --------------------------------------------------------------------------- crosswalk
def _point_in_ring(x: float, y: float, ring: list) -> bool:
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def _point_in_geometry(x: float, y: float, geometry: dict) -> bool:
    polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    for polygon in polygons:
        if _point_in_ring(x, y, polygon[0]) and not any(_point_in_ring(x, y, hole) for hole in polygon[1:]):
            return True
    return False


LATTICE_DEG = 0.002


def zone_crosswalk(population: dict, zones: dict) -> dict:
    """Area shares of each block group inside each matrix zone, by lattice sampling."""
    zone_items = []
    for zone in zones["features"]:
        if zone["properties"]["zone_kind"] != "matrix_zone":
            continue
        zone_items.append((zone["id"], bbox_of(walk_coords(zone["geometry"]["coordinates"])), zone["geometry"]))
    rows = []
    empty = []
    for bg in population["features"]:
        geometry = bg["geometry"]
        x0, y0, x1, y1 = bbox_of(walk_coords(geometry["coordinates"]))
        counts: dict[str, int] = {}
        total = 0
        i0, i1 = int(x0 // LATTICE_DEG), int(x1 // LATTICE_DEG) + 1
        j0, j1 = int(y0 // LATTICE_DEG), int(y1 // LATTICE_DEG) + 1
        candidates = [z for z in zone_items if not (z[1][2] < x0 or z[1][0] > x1 or z[1][3] < y0 or z[1][1] > y1)]
        for i in range(i0, i1 + 1):
            x = (i + 0.5) * LATTICE_DEG
            for j in range(j0, j1 + 1):
                y = (j + 0.5) * LATTICE_DEG
                if not _point_in_geometry(x, y, geometry):
                    continue
                total += 1
                for zid, zb, zg in candidates:
                    if zb[0] <= x <= zb[2] and zb[1] <= y <= zb[3] and _point_in_geometry(x, y, zg):
                        counts[zid] = counts.get(zid, 0) + 1
        if total == 0:
            empty.append(bg["id"])
        for zid, n in sorted(counts.items()):
            rows.append({"geoid": bg["id"], "zone_id": zid, "lattice_points_in_zone": n,
                         "lattice_points_in_block_group": total,
                         "area_share": round(n / total, 6)})
    return {
        "method": (f"derived: regular lattice of {LATTICE_DEG} degree cell centres; area_share = points inside both "
                   "the block group and the zone / points inside the block group. Area weighting assumes uniform "
                   "population density within a block group; overlapping zones (parents and subzones) are listed separately."),
        "evidence_class": "derived",
        "zone_kind": "matrix_zone",
        "small_block_groups_without_lattice_points": sorted(empty),
        "rows": rows,
    }
