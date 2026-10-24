"""Decode a bbox subset of the USGS 3DEP 1 arc-second GeoTIFF tile n40w122 (stdlib only).

The source is a tiled, LZW-compressed float32 GeoTIFF with the floating-point
predictor (TIFF predictor 3). ``fetch`` copies the header bytes and only the
512 x 512 tiles that intersect the study bbox via HTTP range requests; the
decoder rebuilds ``terrain_grid.json`` from those verbatim byte ranges.
"""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import math
import struct
import subprocess
from pathlib import Path

from tools.build_camp_evacuation import BBOX, SourceError


DEM_URL = "https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1/TIFF/current/n40w122/USGS_1_n40w122.tif"
HEADER_BYTES = 65536
ELEVATION_ROUNDING_M = 1  # nearest metre keeps the package under the size budget; 3DEP vertical RMSE is ~1 m


def tags(header: bytes) -> dict[int, tuple]:
    if header[:4] != b"II*\x00":
        raise SourceError("DEM is not a little-endian classic TIFF")
    ifd = struct.unpack("<I", header[4:8])[0]
    count = struct.unpack("<H", header[ifd:ifd + 2])[0]
    sizes = {1: ("B", 1), 2: ("c", 1), 3: ("H", 2), 4: ("I", 4), 12: ("d", 8)}
    out = {}
    for index in range(count):
        tag, kind, n, value = struct.unpack("<HHII", header[ifd + 2 + 12 * index:ifd + 14 + 12 * index])
        fmt, size = sizes[kind]
        raw = header[ifd + 10 + 12 * index:ifd + 14 + 12 * index] if n * size <= 4 else header[value:value + n * size]
        if len(raw) < n * size:
            raise SourceError(f"TIFF tag {tag} lies outside the stored header bytes")
        out[tag] = raw[:n] if kind == 2 else struct.unpack(f"<{n}{fmt}", raw[:n * size])
    return out


def layout(header: bytes) -> dict:
    t = tags(header)
    expected = {258: (32,), 259: (5,), 277: (1,), 317: (3,), 339: (3,)}
    if any(t.get(tag) != value for tag, value in expected.items()):
        raise SourceError("DEM is not single-band float32 LZW with floating-point predictor")
    keys = t[34735]
    geokeys = {keys[i]: keys[i + 3] for i in range(4, 4 + 4 * keys[3], 4)}
    if geokeys.get(2048) != 4269 or geokeys.get(1025) != 1:
        raise SourceError("DEM is not NAD83 geographic PixelIsArea")
    scale, tie = t[33550], t[33922]
    return {
        "width": t[256][0], "height": t[257][0], "tile_w": t[322][0], "tile_h": t[323][0],
        "offsets": t[324], "counts": t[325], "origin_lon": tie[3], "origin_lat": tie[4],
        "cell_lon": scale[0], "cell_lat": scale[1], "nodata": float(t[42113].rstrip(b"\0").decode()),
    }


def window(info: dict, bbox=BBOX) -> tuple[int, int, int, int]:
    west, south, east, north = bbox
    col0 = math.floor((west - info["origin_lon"]) / info["cell_lon"])
    col1 = math.ceil((east - info["origin_lon"]) / info["cell_lon"])
    row0 = math.floor((info["origin_lat"] - north) / info["cell_lat"])
    row1 = math.ceil((info["origin_lat"] - south) / info["cell_lat"])
    return row0, row1, col0, col1


def needed_tiles(info: dict) -> list[tuple[int, int]]:
    row0, row1, col0, col1 = window(info)
    return [(r, c) for r in range(row0 // info["tile_h"], (row1 - 1) // info["tile_h"] + 1)
            for c in range(col0 // info["tile_w"], (col1 - 1) // info["tile_w"] + 1)]


def lzw_decode(data: bytes) -> bytes:
    table = [bytes([i]) for i in range(256)] + [b"", b""]
    out = bytearray()
    width, prev = 9, None
    buffer, nbits, position, size = 0, 0, 0, len(data)
    while True:
        while nbits < width and position < size:
            buffer = ((buffer << 8) | data[position]) & 0xFFFFFF
            position += 1
            nbits += 8
        if nbits < width:
            break
        nbits -= width
        code = (buffer >> nbits) & ((1 << width) - 1)
        if code == 256:
            table, width, prev = table[:258], 9, None
            continue
        if code == 257:
            break
        if prev is None:
            entry = table[code]
        else:
            entry = table[code] if code < len(table) else prev + prev[:1]
            table.append(prev + entry[:1])
            if len(table) + 1 >= (1 << width) and width < 12:
                width += 1
        out += entry
        prev = entry
    return bytes(out)


def undo_float_predictor(data: bytes, width: int, height: int) -> list[float]:
    row_bytes = width * 4
    if len(data) != row_bytes * height:
        raise SourceError("decoded DEM tile has unexpected size")
    values: list[float] = []
    for row in range(height):
        chunk = bytes(itertools.accumulate(data[row * row_bytes:(row + 1) * row_bytes], lambda a, b: (a + b) & 0xFF))
        merged = bytearray(row_bytes)
        for plane in range(4):
            merged[plane::4] = chunk[plane * width:(plane + 1) * width]
        values.extend(struct.unpack(f">{width}f", merged))
    return values


def tile_name(row: int, col: int) -> str:
    return f"tile_r{row}_c{col}.bin"


def terrain_grid(header: bytes, tiles: dict[str, bytes]) -> dict:
    info = layout(header)
    across = math.ceil(info["width"] / info["tile_w"])
    row0, row1, col0, col1 = window(info)
    decoded = {}
    for r, c in needed_tiles(info):
        index = r * across + c
        data = tiles[tile_name(r, c)]
        if len(data) != info["counts"][index]:
            raise SourceError(f"DEM tile {r},{c} byte count differs from TIFF index")
        decoded[(r, c)] = undo_float_predictor(lzw_decode(data), info["tile_w"], info["tile_h"])
    elevations: list[int | None] = []
    for row in range(row1 - 1, row0 - 1, -1):  # output row 0 is the southern edge
        tr, ty = divmod(row, info["tile_h"])
        for col in range(col0, col1):
            tc, tx = divmod(col, info["tile_w"])
            value = decoded[(tr, tc)][ty * info["tile_w"] + tx]
            elevations.append(None if value == info["nodata"] or not math.isfinite(value)
                              else round(value / ELEVATION_ROUNDING_M) * ELEVATION_ROUNDING_M)
    valid = [v for v in elevations if v is not None]
    return {
        "source_id": "usgs-3dep-1as-n40w122", "source_url": DEM_URL,
        "origin_lon": info["origin_lon"] + col0 * info["cell_lon"],
        "origin_lat": info["origin_lat"] - row1 * info["cell_lat"],
        "origin_corner": "south-west corner of cell (row 0, col 0)",
        "cell_deg": info["cell_lon"], "cell_deg_lat": info["cell_lat"],
        "cell_m_approx": {"east_west": round(info["cell_lon"] * 111320 * math.cos(math.radians(39.75)), 1),
                          "north_south": round(info["cell_lat"] * 110950, 1)},
        "horizontal_crs": "NAD83 geographic (EPSG:4269), used as OGC:CRS84 without datum shift (sub-2 m)",
        "ncols": col1 - col0, "nrows": row1 - row0, "row_order": "row 0 = south; each row west to east",
        "elevation_m": elevations, "nodata": None, "elevation_rounding_m": ELEVATION_ROUNDING_M,
        "elevation_range_m": [min(valid), max(valid)] if valid else None,
        "vertical_datum": "NAVD88 (USGS 3DEP)", "source_resolution": "1 arc-second (~30 m)",
        "resampling_method": "none: native 1 arc-second cells cut at whole-cell bounds covering the bbox",
        "evidence_class": "observed",
    }


def fetch(out_dir: Path) -> dict:
    """Copy the header and the bbox tiles with bounded curl range requests."""
    def get(start: int, end: int) -> bytes:
        result = subprocess.run(["curl", "--fail", "--silent", "--show-error", "--retry", "3", "--max-time", "300",
                                 "-r", f"{start}-{end}", DEM_URL], capture_output=True, check=False, timeout=1300)
        if result.returncode or len(result.stdout) != end - start + 1:
            raise SourceError(f"DEM range {start}-{end} failed: {result.stderr.decode(errors='replace')}")
        return result.stdout
    out_dir.mkdir(parents=True, exist_ok=True)
    header = get(0, HEADER_BYTES - 1)
    (out_dir / "header.bin").write_bytes(header)
    info = layout(header)
    across = math.ceil(info["width"] / info["tile_w"])
    record = {}
    for r, c in needed_tiles(info):
        index = r * across + c
        start = info["offsets"][index]
        data = get(start, start + info["counts"][index] - 1)
        (out_dir / tile_name(r, c)).write_bytes(data)
        record[tile_name(r, c)] = {"byte_range": [start, start + len(data) - 1], "sha256": hashlib.sha256(data).hexdigest()}
    return record


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fetch-to", type=Path, required=True)
    print(json.dumps(fetch(parser.parse_args().fetch_to), indent=2))


if __name__ == "__main__":
    main()
