"""The drill bundle, loaded once per process, plus lookups the API needs (road snapping).

The bundle path is ``LIVE_DRILL_BUNDLE`` (default: ``app/public/replays/camp-2018.json``).
"""

from __future__ import annotations

import json
import logging
import math
from collections import defaultdict
from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path
from threading import Lock
from typing import Any

from django.conf import settings
from livecore.drill import Destination, Drill, Zone, load_drill, parse_time
from livecore.geo import LonLat, to_geojson

from .common import ApiError

log = logging.getLogger(__name__)

SNAP_MAX_M = 75.0
"""A road report snaps to the nearest segment within this distance, else ``road_ref`` is null."""
SNAP_CELL_DEG = 0.005
"""Grid cell size of the snapping index (about 400-550 m at the Camp latitude)."""
METERS_PER_DEG_LAT = 111_320.0


@dataclass(frozen=True)
class DrillIndex:
    drill: Drill
    zones: dict[str, Zone]
    destinations: dict[str, Destination]
    segment_lines: dict[str, tuple[LonLat, ...]]
    segment_names: dict[str, str | None]
    zones_json: list[dict[str, Any]]
    command_zones_json: list[dict[str, Any]]
    destinations_json: list[dict[str, Any]]
    grid: dict[tuple[int, int], tuple[str, ...]]
    response_record: tuple[tuple[datetime, dict[str, Any]], ...] = ()
    """Historical (non-simulated) bundle events as ``(at, item)``, sorted by ``at`` ascending."""


_index: DrillIndex | None = None
_lock = Lock()


def bundle_path() -> Path:
    configured = (getattr(settings, "LIVE_DRILL_BUNDLE", "") or "").strip()
    if configured:
        return Path(configured)
    return Path(settings.BASE_DIR).parent / "public" / "replays" / "camp-2018.json"


def _cell(lon: float, lat: float) -> tuple[int, int]:
    return int(math.floor(lon / SNAP_CELL_DEG)), int(math.floor(lat / SNAP_CELL_DEG))


def _response_record(drill: Drill, path: Path) -> tuple[tuple[datetime, dict[str, Any]], ...]:
    """The 2018 response record: bundle ``events`` whose evidence_class is not ``simulated``."""
    with open(path, encoding="utf-8") as fh:
        events = json.load(fh).get("events") or []
    edges = drill.roads.edges
    out: list[tuple[datetime, dict[str, Any]]] = []
    for e in events:
        if not isinstance(e, dict) or e.get("evidence_class") in (None, "simulated"):
            continue
        try:
            at = parse_time(e["at"])
        except (KeyError, ValueError):
            continue
        target = e.get("target") or {}
        segments = sorted({edges[i].segment_id for i in target.get("edge_ids") or [] if i in edges})
        source = e.get("source") or {}
        out.append((at, {
            "id": e.get("id"),
            "at": at.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "type": e.get("type"),
            "label": e.get("label"),
            "evidence_class": e.get("evidence_class"),
            "source_id": source.get("id"),
            "source_url": source.get("locator"),
            "time_precision": e.get("time_precision"),
            "zone_ids": list(target.get("zone_ids") or []),
            "segment_ids": segments[:50],
        }))
    out.sort(key=lambda x: x[0])
    return tuple(out)


def _build(drill: Drill) -> DrillIndex:
    segment_lines: dict[str, tuple[LonLat, ...]] = {}
    segment_names: dict[str, str | None] = {}
    grid: dict[tuple[int, int], set[str]] = defaultdict(set)
    for edge in drill.roads.edges.values():
        if edge.segment_id in segment_lines:
            continue
        segment_lines[edge.segment_id] = tuple(edge.coords)
        segment_names[edge.segment_id] = edge.name
        for lon, lat in edge.coords:
            grid[_cell(lon, lat)].add(edge.segment_id)
        for (lon1, lat1), (lon2, lat2) in zip(edge.coords, edge.coords[1:]):
            grid[_cell((lon1 + lon2) / 2, (lat1 + lat2) / 2)].add(edge.segment_id)
    zones_json = [{"id": z.id, "name": z.name, "geometry": to_geojson(z.geometry)} for z in drill.zones]
    command_zones_json = [
        {**zj, "households": z.households, "vehicles": z.vehicles} for zj, z in zip(zones_json, drill.zones)
    ]
    destinations_json = [
        {"id": d.id, "name": d.name, "kind": d.kind, "coord": [d.coord[0], d.coord[1]], "capacity_veh": d.capacity_veh}
        for d in drill.destinations
    ]
    return DrillIndex(
        drill=drill,
        zones={z.id: z for z in drill.zones},
        destinations={d.id: d for d in drill.destinations},
        segment_lines=segment_lines,
        segment_names=segment_names,
        zones_json=zones_json,
        command_zones_json=command_zones_json,
        destinations_json=destinations_json,
        grid={k: tuple(sorted(v)) for k, v in grid.items()},
    )


def get_index() -> DrillIndex:
    """The cached drill; ``ApiError(503, drill_unavailable)`` when it cannot be loaded."""
    global _index
    if _index is not None:
        return _index
    with _lock:
        if _index is None:
            path = bundle_path()
            try:
                built = _build(load_drill(path))
                _index = replace(built, response_record=_response_record(built.drill, path))
            except NotImplementedError as exc:
                raise ApiError(503, "drill_unavailable", "The drill engine is not implemented yet.") from exc
            except (OSError, ValueError, KeyError, AttributeError) as exc:
                log.exception("live drill: cannot load bundle %s", path)
                raise ApiError(503, "drill_unavailable", "The drill bundle could not be loaded.") from exc
    return _index


def _point_segment_m(p: LonLat, a: LonLat, b: LonLat) -> float:
    """Distance from p to segment ab in meters (equirectangular around p)."""
    kx = METERS_PER_DEG_LAT * math.cos(math.radians(p[1]))
    ax, ay = (a[0] - p[0]) * kx, (a[1] - p[1]) * METERS_PER_DEG_LAT
    bx, by = (b[0] - p[0]) * kx, (b[1] - p[1]) * METERS_PER_DEG_LAT
    dx, dy = bx - ax, by - ay
    length2 = dx * dx + dy * dy
    t = 0.0 if length2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / length2))
    return math.hypot(ax + t * dx, ay + t * dy)


def snap_to_segment(index: DrillIndex, point: LonLat) -> tuple[str, float] | None:
    """Nearest segment within SNAP_MAX_M as ``(segment_id, meters)``, or None."""
    cx, cy = _cell(*point)
    candidates: set[str] = set()
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            candidates.update(index.grid.get((cx + dx, cy + dy), ()))
    best: tuple[str, float] | None = None
    for segment_id in candidates:
        line = index.segment_lines[segment_id]
        for a, b in zip(line, line[1:]):
            d = _point_segment_m(point, a, b)
            if best is None or d < best[1]:
                best = (segment_id, d)
    if best is None or best[1] > SNAP_MAX_M:
        return None
    return best


def response_record_until(index: DrillIndex, until: datetime, limit: int = 100) -> list[dict[str, Any]]:
    """Record items with ``at <= until`` (drill time), newest first, at most ``limit``."""
    items = [item for at, item in index.response_record if at <= until]
    return items[::-1][:limit]
