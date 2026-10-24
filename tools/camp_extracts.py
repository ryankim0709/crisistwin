"""Cut deterministic, redistributable subsets from large Camp Fire source downloads.

The full downloads stay outside the repository (ACS summary-file sequences, the
California TIGER/Line 2018 block-group shapefile, FIRMS 2018 US archives and the
NIST fire-observation workbook). This module writes small subsets whose bytes
are either verbatim source lines or a lossless JSON decoding of the selected
records, plus an extraction manifest with the full-file size and SHA-256.
Only the Python standard library is used.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

from tools.build_camp_evacuation import BBOX, SourceError, encoded_json


ACS_BASE = ("https://www2.census.gov/programs-surveys/acs/summary_file/2018/data/"
            "5_year_seq_by_state/California/Tracts_Block_Groups_Only/")
ACS_LOOKUP_URL = ("https://www2.census.gov/programs-surveys/acs/summary_file/2018/documentation/"
                  "user_tools/ACS_5yr_Seq_Table_Number_Lookup.csv")
ACS_SEQUENCES = ("0002", "0003", "0036", "0114")
ACS_TABLES = ("B01001", "B01003", "B11001", "B25044", "B25046")
TIGER_URL = "https://www2.census.gov/geo/tiger/TIGER2018/BG/tl_2018_06_bg.zip"
FIRMS_URLS = {
    "modis": "https://firms.modaps.eosdis.nasa.gov/data/country/modis/2018/modis_2018_United_States.csv",
    "viirs-snpp": "https://firms.modaps.eosdis.nasa.gov/data/country/viirs-snpp/2018/viirs-snpp_2018_United_States.csv",
}
FIRMS_DATES = ("2018-11-08", "2018-11-09")  # acq_date is the UTC acquisition date
FIRE_OBS_URL = "https://data.nist.gov/od/id/mds2-2954"
FIRE_OBS_KEEP = {"A": "source_number", "B": "date_serial", "C": "time_fraction", "D": "time_source",
                 "E": "obs_window_min", "F": "latitude", "G": "longitude", "H": "location_source",
                 "I": "info_source", "K": "type_of_fire", "L": "residual_fire", "M": "ssi"}
FIRE_OBS_EXCLUDED = {"J": "Fire Behavior Observations (free text; may describe specific residential locations); "
                          "only a 12-hex SHA-256 prefix is kept so distinct observations are not merged"}
XLSX_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def file_record(path: Path, url: str) -> dict:
    data = path.read_bytes()
    return {"url": url, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "local_name": path.name}


# --- TIGER/Line shapefile (stdlib reader) -------------------------------------------------

def read_dbf(data: bytes) -> list[dict]:
    count, header_len, record_len = struct.unpack("<IHH", data[4:12])
    fields = []
    pos = 32
    while data[pos] != 0x0D:
        name = data[pos:pos + 11].split(b"\0", 1)[0].decode("ascii")
        fields.append((name, data[pos + 11:pos + 12].decode(), data[pos + 16]))
        pos += 32
    records = []
    for index in range(count):
        start = header_len + index * record_len
        raw = data[start:start + record_len]
        if raw[:1] == b"*":
            raise SourceError("deleted DBF record in TIGER source")
        offset, row = 1, {}
        for name, kind, length in fields:
            text = raw[offset:offset + length].decode("utf-8").strip()
            row[name] = int(text) if kind == "N" and text and "." not in text else text
            offset += length
        records.append(row)
    return records


def read_polygons(shp: bytes) -> list[list[list[list[float]]]]:
    if struct.unpack(">i", shp[:4])[0] != 9994 or struct.unpack("<i", shp[32:36])[0] != 5:
        raise SourceError("TIGER .shp is not a polygon shapefile")
    pos, shapes = 100, []
    while pos < len(shp):
        _, words = struct.unpack(">ii", shp[pos:pos + 8])
        body = shp[pos + 8:pos + 8 + words * 2]
        pos += 8 + words * 2
        if struct.unpack("<i", body[:4])[0] != 5:
            raise SourceError("unexpected null or non-polygon shape in TIGER source")
        num_parts, num_points = struct.unpack("<ii", body[36:44])
        parts = list(struct.unpack(f"<{num_parts}i", body[44:44 + 4 * num_parts])) + [num_points]
        coords = struct.unpack(f"<{2 * num_points}d", body[44 + 4 * num_parts:44 + 4 * num_parts + 16 * num_points])
        points = [[coords[2 * i], coords[2 * i + 1]] for i in range(num_points)]
        shapes.append([points[parts[i]:parts[i + 1]] for i in range(num_parts)])
    return shapes


def point_in_ring(x: float, y: float, ring: list[list[float]]) -> bool:
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def segments_cross(p1, p2, q1, q2) -> bool:
    def orient(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    d1, d2 = orient(q1, q2, p1), orient(q1, q2, p2)
    d3, d4 = orient(p1, p2, q1), orient(p1, p2, q2)
    return (d1 > 0) != (d2 > 0) and (d3 > 0) != (d4 > 0)


def polygon_intersects_bbox(parts: list[list[list[float]]], bbox=BBOX) -> bool:
    west, south, east, north = bbox
    xs = [p[0] for ring in parts for p in ring]
    ys = [p[1] for ring in parts for p in ring]
    if max(xs) < west or min(xs) > east or max(ys) < south or min(ys) > north:
        return False
    if any(west <= x <= east and south <= y <= north for x, y in zip(xs, ys)):
        return True
    corners = [(west, south), (east, south), (east, north), (west, north)]
    # TIGER rings: outer rings clockwise, holes counter-clockwise; even-odd over all rings.
    if any(sum(point_in_ring(cx, cy, ring) for ring in parts) % 2 for cx, cy in corners):
        return True
    edges = list(zip(corners, corners[1:] + corners[:1]))
    return any(segments_cross(a, b, c, d) for ring in parts for a, b in zip(ring, ring[1:]) for c, d in edges)


def extract_tiger(zip_path: Path) -> dict:
    with zipfile.ZipFile(zip_path) as archive:
        records = read_dbf(archive.read("tl_2018_06_bg.dbf"))
        shapes = read_polygons(archive.read("tl_2018_06_bg.shp"))
        prj = archive.read("tl_2018_06_bg.prj").decode()
    if len(records) != len(shapes):
        raise SourceError("TIGER .dbf and .shp record counts differ")
    selected = [{"attributes": attrs, "parts": parts} for attrs, parts in zip(records, shapes)
                if polygon_intersects_bbox(parts)]
    selected.sort(key=lambda item: item["attributes"]["GEOID"])
    return {"source": "tl_2018_06_bg.zip", "prj": prj, "selection": {
        "rule": "block-group polygon intersects the requested bbox (vertex-in-box, corner-in-polygon or edge crossing)",
        "bbox": list(BBOX)}, "records": selected}


# --- ACS 2014-2018 5-year summary file -----------------------------------------------------

def extract_acs(acs_dir: Path, geoids: set[str]) -> dict[str, bytes]:
    out: dict[str, bytes] = {}
    geo_lines, logrecnos = [], set()
    with open(acs_dir / "g20185ca.txt", "rb") as handle:
        for line in handle:
            geoid = line[178:218].decode("latin-1").strip()
            if line[8:11] == b"150" and geoid.startswith("15000US") and geoid[7:] in geoids:
                geo_lines.append(line)
                logrecnos.add(line[13:20].decode())
    if len(geo_lines) != len(geoids):
        raise SourceError(f"ACS geography file has {len(geo_lines)} of {len(geoids)} selected block groups")
    out["acs2018/g20185ca-subset.txt"] = b"".join(geo_lines)
    lookup = (acs_dir / "ACS_5yr_Seq_Table_Number_Lookup.csv").read_bytes().splitlines(keepends=True)
    out["acs2018/seq-table-lookup-subset.csv"] = lookup[0] + b"".join(
        line for line in lookup[1:] if line.split(b",")[1].decode() in ACS_TABLES)
    for seq in ACS_SEQUENCES:
        with zipfile.ZipFile(acs_dir / f"20185ca{seq}000.zip") as archive:
            for kind in ("e", "m"):
                name = f"{kind}20185ca{seq}000.txt"
                lines = [line for line in archive.read(name).splitlines(keepends=True)
                         if line.split(b",", 6)[5].decode() in logrecnos]
                if len(lines) != len(logrecnos):
                    raise SourceError(f"{name} lacks some selected logical records")
                out[f"acs2018/{name.replace('.txt', '-subset.txt')}"] = b"".join(lines)
    return out


# --- NASA FIRMS archive ---------------------------------------------------------------------

def extract_firms(path: Path) -> bytes:
    west, south, east, north = BBOX
    lines = path.read_bytes().splitlines(keepends=True)
    header = lines[0].decode().strip().split(",")
    lat_i, lon_i, date_i = header.index("latitude"), header.index("longitude"), header.index("acq_date")
    kept = [lines[0]]
    for line in lines[1:]:
        cells = line.decode().strip().split(",")
        if cells[date_i] in FIRMS_DATES and west <= float(cells[lon_i]) <= east and south <= float(cells[lat_i]) <= north:
            kept.append(line)
    return b"".join(kept)


# --- NIST fire-observation workbook ---------------------------------------------------------

def extract_fire_observations(path: Path) -> dict:
    with zipfile.ZipFile(path) as book:
        shared = ["".join(t.text or "" for t in si.iter(f"{XLSX_NS}t"))
                  for si in ET.fromstring(book.read("xl/sharedStrings.xml")).findall(f"{XLSX_NS}si")]
        workbook = ET.fromstring(book.read("xl/workbook.xml"))
        rels = {rel.get("Id"): rel.get("Target") for rel in ET.fromstring(book.read("xl/_rels/workbook.xml.rels"))}
        rows = []
        for sheet in workbook.iter(f"{XLSX_NS}sheet"):
            target = rels[sheet.get(f"{REL_NS}id")].lstrip("/")
            target = target if target.startswith("xl/") else f"xl/{target}"
            root = ET.fromstring(book.read(target))
            header = None
            for row in root.iter(f"{XLSX_NS}row"):
                cells = {}
                for cell in row.findall(f"{XLSX_NS}c"):
                    value = cell.find(f"{XLSX_NS}v")
                    text = None if value is None else (shared[int(value.text)] if cell.get("t") == "s" else value.text)
                    cells[re.match(r"[A-Z]+", cell.get("r"))[0]] = text
                if header is None:
                    header = cells
                    if header.get("F") != "Latitude" or header.get("J") != "Fire Behavior Observations":
                        raise SourceError(f"unexpected fire-observation header in sheet {sheet.get('name')}")
                    continue
                if not cells.get("F"):
                    continue
                kept = {name: cells.get(col) for col, name in FIRE_OBS_KEEP.items()}
                text = cells.get("J")
                kept["observation_text_sha256_12"] = hashlib.sha256(text.encode()).hexdigest()[:12] if text else None
                kept["sheet"] = sheet.get("name")
                kept["row"] = int(row.get("r"))
                rows.append(kept)
    return {"source": path.name, "kept_columns": FIRE_OBS_KEEP, "excluded_columns": FIRE_OBS_EXCLUDED,
            "rows": rows}


def run(args: argparse.Namespace) -> dict:
    out_dir: Path = args.out_dir
    files: dict[str, bytes] = {}
    sources: dict[str, dict] = {}
    tiger = extract_tiger(args.tiger_zip)
    files["tiger2018-bg-subset.json"] = encoded_json(tiger)
    sources["tiger2018-bg-ca"] = file_record(args.tiger_zip, TIGER_URL)
    geoids = {record["attributes"]["GEOID"] for record in tiger["records"]}
    files.update(extract_acs(args.acs_dir, geoids))
    for seq in ACS_SEQUENCES:
        sources[f"acs2018-5yr-seq{seq}"] = file_record(args.acs_dir / f"20185ca{seq}000.zip", f"{ACS_BASE}20185ca{seq}000.zip")
    sources["acs2018-5yr-geo"] = file_record(args.acs_dir / "g20185ca.txt", f"{ACS_BASE}g20185ca.txt")
    sources["acs2018-5yr-lookup"] = file_record(args.acs_dir / "ACS_5yr_Seq_Table_Number_Lookup.csv", ACS_LOOKUP_URL)
    for key, path in (("modis", args.firms_modis), ("viirs-snpp", args.firms_viirs)):
        files[f"firms-{key}-2018-us-subset.csv"] = extract_firms(path)
        sources[f"firms-{key}-2018-us"] = file_record(path, FIRMS_URLS[key])
    files["nist-fire-observations-subset.json"] = encoded_json(extract_fire_observations(args.fire_obs_xlsx))
    sources["nist-fire-observations"] = file_record(args.fire_obs_xlsx, FIRE_OBS_URL)
    manifest = {"bbox": list(BBOX), "firms_acq_dates_utc": list(FIRMS_DATES), "full_sources": sources,
                "extracts": {name: {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                             for name, data in sorted(files.items())}}
    files["extraction_manifest.json"] = encoded_json(manifest)
    for name, data in files.items():
        path = out_dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return {name: len(data) for name, data in sorted(files.items())}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--acs-dir", type=Path, required=True)
    parser.add_argument("--tiger-zip", type=Path, required=True)
    parser.add_argument("--firms-modis", type=Path, required=True)
    parser.add_argument("--firms-viirs", type=Path, required=True)
    parser.add_argument("--fire-obs-xlsx", type=Path, required=True)
    print(json.dumps(run(parser.parse_args()), indent=2))


if __name__ == "__main__":
    main()
