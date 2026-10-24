"""Planar grid helpers: local projection, polygon rasterization, and mask export.

Coordinates enter and leave as GeoJSON OGC:CRS84 (longitude, latitude in degrees).
Internally the grid uses a local equirectangular projection in metres around the
grid origin; distortion is negligible at incident scale (tens of kilometres).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

EARTH_RADIUS_M = 6_371_008.8


@dataclass(frozen=True)
class Grid:
    """Square-cell raster. Cell (row, col) has index row * ncols + col; row 0 is the south edge.

    Masks over the grid are bytearrays of length ncols * nrows holding 0 or 1.
    """

    origin_lon: float  # south-west corner
    origin_lat: float
    cell_m: float
    ncols: int
    nrows: int

    @classmethod
    def covering(cls, bbox: list[float], cell_m: float, margin_m: float = 0.0) -> "Grid":
        """Grid covering [min_lon, min_lat, max_lon, max_lat] plus a margin on every side."""
        min_lon, min_lat, max_lon, max_lat = bbox
        mid_lat = math.radians((min_lat + max_lat) / 2)
        m_per_deg_lat = math.radians(1) * EARTH_RADIUS_M
        m_per_deg_lon = m_per_deg_lat * math.cos(mid_lat)
        width_m = (max_lon - min_lon) * m_per_deg_lon + 2 * margin_m
        height_m = (max_lat - min_lat) * m_per_deg_lat + 2 * margin_m
        return cls(
            origin_lon=min_lon - margin_m / m_per_deg_lon,
            origin_lat=min_lat - margin_m / m_per_deg_lat,
            cell_m=cell_m,
            ncols=max(1, math.ceil(width_m / cell_m)),
            nrows=max(1, math.ceil(height_m / cell_m)),
        )

    @property
    def size(self) -> int:
        return self.ncols * self.nrows

    @property
    def cell_area_km2(self) -> float:
        return self.cell_m * self.cell_m / 1e6

    @property
    def _m_per_deg_lat(self) -> float:
        return math.radians(1) * EARTH_RADIUS_M

    @property
    def _m_per_deg_lon(self) -> float:
        mid_lat = self.origin_lat + self.nrows * self.cell_m / self._m_per_deg_lat / 2
        return self._m_per_deg_lat * math.cos(math.radians(mid_lat))

    def to_xy(self, lon: float, lat: float) -> tuple[float, float]:
        """Metres east and north of the grid origin."""
        return (lon - self.origin_lon) * self._m_per_deg_lon, (lat - self.origin_lat) * self._m_per_deg_lat

    def to_lonlat(self, x: float, y: float) -> tuple[float, float]:
        return self.origin_lon + x / self._m_per_deg_lon, self.origin_lat + y / self._m_per_deg_lat

    def cell_of(self, lon: float, lat: float) -> int | None:
        """Cell index containing the point, or None outside the grid."""
        x, y = self.to_xy(lon, lat)
        col, row = math.floor(x / self.cell_m), math.floor(y / self.cell_m)
        if 0 <= col < self.ncols and 0 <= row < self.nrows:
            return row * self.ncols + col
        return None

    def cell_center_lonlat(self, index: int) -> tuple[float, float]:
        row, col = divmod(index, self.ncols)
        return self.to_lonlat((col + 0.5) * self.cell_m, (row + 0.5) * self.cell_m)

    def to_dict(self) -> dict:
        return {
            "origin_lon": self.origin_lon,
            "origin_lat": self.origin_lat,
            "cell_m": self.cell_m,
            "ncols": self.ncols,
            "nrows": self.nrows,
            "crs": "OGC:CRS84",
            "projection": "local equirectangular about grid centre latitude",
        }


def _polygons(geometry: dict) -> list[list[list[list[float]]]]:
    if geometry["type"] == "Polygon":
        return [geometry["coordinates"]]
    if geometry["type"] == "MultiPolygon":
        return geometry["coordinates"]
    raise ValueError(f"unsupported geometry type: {geometry['type']}")


def rasterize(grid: Grid, geometry: dict) -> bytearray:
    """Mask of cells whose centres lie inside a GeoJSON Polygon/MultiPolygon (holes respected)."""
    mask = bytearray(grid.size)
    for polygon in _polygons(geometry):
        # Even-odd rule over all rings of one polygon handles holes; parts are OR-ed.
        edges = []
        for ring in polygon:
            pts = [grid.to_xy(lon, lat) for lon, lat, *_ in ring]
            edges.extend(zip(pts, pts[1:] + pts[:1]))
        ys = [p[1] for edge in edges for p in edge]
        row_lo = max(0, math.floor(min(ys) / grid.cell_m))
        row_hi = min(grid.nrows - 1, math.ceil(max(ys) / grid.cell_m))
        for row in range(row_lo, row_hi + 1):
            yc = (row + 0.5) * grid.cell_m
            xs = sorted(
                x0 + (yc - y0) * (x1 - x0) / (y1 - y0)
                for (x0, y0), (x1, y1) in edges
                if (y0 <= yc) != (y1 <= yc)
            )
            base = row * grid.ncols
            for x_in, x_out in zip(xs[0::2], xs[1::2]):
                col_lo = max(0, math.ceil(x_in / grid.cell_m - 0.5))
                col_hi = min(grid.ncols - 1, math.floor(x_out / grid.cell_m - 0.5))
                for col in range(col_lo, col_hi + 1):
                    mask[base + col] = 1
    return mask


def point_in_geometry(lon: float, lat: float, geometry: dict) -> bool:
    """Even-odd point-in-polygon test in lon/lat space (adequate at incident scale)."""
    for polygon in _polygons(geometry):
        inside = False
        for ring in polygon:
            for (x0, y0, *_), (x1, y1, *_) in zip(ring, ring[1:] + ring[:1]):
                if (y0 <= lat) != (y1 <= lat) and lon < x0 + (lat - y0) * (x1 - x0) / (y1 - y0):
                    inside = not inside
        if inside:
            return True
    return False


def mask_to_geometry(grid: Grid, mask: bytearray | list) -> dict:
    """MultiPolygon of the set cells, merged into horizontal runs (one rectangle per run).

    Intended for display and export, not as a smoothed perimeter.
    """
    rects = []
    for row in range(grid.nrows):
        base = row * grid.ncols
        col = 0
        while col < grid.ncols:
            if not mask[base + col]:
                col += 1
                continue
            start = col
            while col < grid.ncols and mask[base + col]:
                col += 1
            x0, x1 = start * grid.cell_m, col * grid.cell_m
            y0, y1 = row * grid.cell_m, (row + 1) * grid.cell_m
            corners = [grid.to_lonlat(x, y) for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0))]
            rects.append([[[round(lon, 6), round(lat, 6)] for lon, lat in corners]])
    return {"type": "MultiPolygon", "coordinates": rects}
