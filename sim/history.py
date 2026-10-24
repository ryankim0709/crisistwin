"""Load a verified historical incident package into typed, time-sorted observations."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from tools.build_camp_history import SourceError, verify_package


def parse_utc(value: str) -> datetime:
    """Parse an ISO 8601 timestamp that carries Z or an offset; return aware UTC."""
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise SourceError(f"invalid timestamp: {value}") from exc
    if parsed.tzinfo is None:
        raise SourceError(f"timestamp needs a UTC offset or Z: {value}")
    return parsed.astimezone(timezone.utc)


def format_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


@dataclass(frozen=True)
class PerimeterSnapshot:
    """One observed cumulative fire perimeter. Geometry is GeoJSON in OGC:CRS84 (lon, lat)."""

    snapshot_at: datetime
    area_km2: float
    geometry: dict
    feature: dict  # original normalized GeoJSON feature, unmodified


@dataclass(frozen=True)
class DamagePoint:
    """Post-fire structure assessment. Has no time of damage; never use as arrival evidence."""

    lon: float
    lat: float
    damage: str
    structure_category: str
    feature: dict


@dataclass(frozen=True)
class IncidentHistory:
    package: Path
    manifest: dict
    perimeters: tuple[PerimeterSnapshot, ...]  # sorted by snapshot_at, ascending
    damage: tuple[DamagePoint, ...]

    @property
    def incident_id(self) -> str:
        return self.manifest["incident_id"]

    @property
    def package_version(self) -> str:
        return self.manifest["package_version"]

    @property
    def perimeter_bbox(self) -> list[float]:
        """[min_lon, min_lat, max_lon, max_lat] of all perimeter snapshots."""
        return self.manifest["layers"]["fire_perimeters"]["bbox"]


def load_history(package: Path) -> IncidentHistory:
    """Verify the package hashes and normalization, then load its layers."""
    manifest = verify_package(package)
    perimeter_features = json.loads((package / "normalized/fire_perimeters.geojson").read_text())["features"]
    perimeters = sorted(
        (
            PerimeterSnapshot(
                snapshot_at=parse_utc(f["properties"]["snapshot_at"]),
                area_km2=float(f["properties"]["area_km2"]),
                geometry=f["geometry"],
                feature=f,
            )
            for f in perimeter_features
        ),
        key=lambda p: p.snapshot_at,
    )
    if not perimeters:
        raise SourceError("package has no fire perimeter snapshots")
    damage_features = json.loads((package / "normalized/damage_assessments.geojson").read_text())["features"]
    damage = tuple(
        DamagePoint(
            lon=f["geometry"]["coordinates"][0],
            lat=f["geometry"]["coordinates"][1],
            damage=f["properties"]["damage"],
            structure_category=f["properties"]["structure_category"],
            feature=f,
        )
        for f in damage_features
    )
    return IncidentHistory(package=package, manifest=manifest, perimeters=tuple(perimeters), damage=damage)
