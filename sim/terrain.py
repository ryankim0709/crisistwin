"""Terrain on the fire grid: USGS 3DEP elevation block-averaged to the grid, then slope and aspect.

Input is the package's `normalized/terrain_grid.json` (1 arc-second cells, row 0 = south,
origin at the south-west corner of cell (0, 0)). Elevation is in metres (NAVD88); the
horizontal CRS is NAD83 used as OGC:CRS84 without a datum shift (sub-2 m).
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

from sim.fire_obs import read_verified
from sim.geo import Grid

TERRAIN_PATH = "normalized/terrain_grid.json"


@dataclass(frozen=True)
class Terrain:
    """Per fire-grid cell: mean elevation (m), slope as tan(theta), and upslope bearing (deg clockwise from north).

    Cells the DEM does not cover have elevation None, slope 0 and are counted in `missing_cells`
    (treated as flat by the fire model).
    """

    grid: Grid
    elevation_m: list[float | None]
    slope_tan: list[float]
    upslope_deg: list[float]
    missing_cells: int
    source: dict

    def summary(self) -> dict:
        slopes = sorted(self.slope_tan)
        return {
            "source_id": self.source.get("source_id"),
            "source_resolution": self.source.get("source_resolution"),
            "vertical_datum": self.source.get("vertical_datum"),
            "resampling": f"block mean of 1 arc-second cells onto {self.grid.cell_m:g} m fire cells; "
                          "slope by Horn (1981) 3x3 gradient",
            "missing_cells": self.missing_cells,
            "missing_treatment": "flat (slope 0)",
            "slope_tan_median": round(slopes[len(slopes) // 2], 3),
            "slope_tan_p90": round(slopes[int(len(slopes) * 0.9)], 3),
        }


def load_terrain(package: Path, grid: Grid) -> Terrain:
    """Read the package DEM once and resample it to `grid`."""
    raw = json.loads(read_verified(package, TERRAIN_PATH))
    ncols, nrows = raw["ncols"], raw["nrows"]
    elevation = raw["elevation_m"]
    if len(elevation) != ncols * nrows:
        raise ValueError(f"terrain grid has {len(elevation)} cells, expected {ncols * nrows}")
    if raw.get("row_order", "").split(" ")[:3] != ["row", "0", "="] or "south" not in raw["row_order"]:
        raise ValueError(f"unexpected terrain row order: {raw.get('row_order')}")
    lon0, lat0 = raw["origin_lon"], raw["origin_lat"]
    dlon, dlat = raw["cell_deg"], raw.get("cell_deg_lat", raw["cell_deg"])
    nodata = raw.get("nodata")

    # Fire-grid column of each DEM column and row of each DEM row (DEM cell centres), -1 outside.
    m_lon, m_lat = grid._m_per_deg_lon, grid._m_per_deg_lat
    fire_col = [math.floor((lon0 + (c + 0.5) * dlon - grid.origin_lon) * m_lon / grid.cell_m) for c in range(ncols)]
    fire_col = [c if 0 <= c < grid.ncols else -1 for c in fire_col]
    total = [0.0] * grid.size
    count = [0] * grid.size
    for r in range(nrows):
        fr = math.floor((lat0 + (r + 0.5) * dlat - grid.origin_lat) * m_lat / grid.cell_m)
        if not 0 <= fr < grid.nrows:
            continue
        base, fbase = r * ncols, fr * grid.ncols
        for c, fc in enumerate(fire_col):
            if fc < 0:
                continue
            z = elevation[base + c]
            if z is None or z == nodata:
                continue
            total[fbase + fc] += z
            count[fbase + fc] += 1
    elev = [t / n if n else None for t, n in zip(total, count)]

    # Horn (1981) gradient over the 3x3 neighbourhood; missing neighbours fall back to the centre cell.
    gc, gr, cell = grid.ncols, grid.nrows, grid.cell_m
    slope = [0.0] * grid.size
    upslope = [0.0] * grid.size
    for row in range(gr):
        for col in range(gc):
            i = row * gc + col
            z0 = elev[i]
            if z0 is None:
                continue

            def z(dc: int, dr: int) -> float:
                c, r = col + dc, row + dr
                if 0 <= c < gc and 0 <= r < gr:
                    v = elev[r * gc + c]
                    return z0 if v is None else v
                return z0

            dzdx = ((z(1, 1) + 2 * z(1, 0) + z(1, -1)) - (z(-1, 1) + 2 * z(-1, 0) + z(-1, -1))) / (8 * cell)
            dzdy = ((z(-1, 1) + 2 * z(0, 1) + z(1, 1)) - (z(-1, -1) + 2 * z(0, -1) + z(1, -1))) / (8 * cell)
            slope[i] = math.hypot(dzdx, dzdy)
            upslope[i] = math.degrees(math.atan2(dzdx, dzdy)) % 360
    source = {k: raw.get(k) for k in ("source_id", "source_url", "source_resolution", "vertical_datum",
                                      "horizontal_crs", "evidence_class")}
    return Terrain(grid, elev, slope, upslope, sum(1 for v in elev if v is None), source)
