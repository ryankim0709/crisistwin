"""Which modelled assets a projected fire footprint reaches, and when.

:class:`FixtureExposureModel` walks the frames of a :class:`SpreadProjection` in
ascending elapsed time and answers one narrow question per registry asset: which
is the *first* frame whose perimeter covers that asset's representative point.
That frame's ``elapsed_minutes`` becomes ``first_exposure_minutes``.

What this module does not claim:

- It is not an observation. The perimeter it reads is simulated, so every
  exposure time derived from it is simulated too. The assessment therefore
  carries ``Evidence(kind="simulation")`` and never a narrower kind.
- It is not a safety finding. An asset the footprint never covers is simply
  absent from the assessment. Absence means "this run did not reach it within
  its horizon under these inputs", never "safe".
- It is not a footprint intersection. Each asset is reduced to a single point,
  so a fire that clips the end of a road or the edge of a neighborhood is not
  counted until it covers that one point. The assessment says so in
  ``ExposureAssessment.limitations`` rather than leaving it implied.

Geometry is standard library only: even-odd ray casting over GeoJSON Polygon
rings, with interior rings treated as holes. No shapely and no geopandas - a
point-in-polygon test is not a concrete need for a new dependency.

Units and conventions: coordinates are WGS84 decimal degrees, GeoJSON positions
are ``[longitude, latitude]``, and elapsed times are whole simulation minutes
from ignition.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final, cast

from .domain import (
    AssetKind,
    Evidence,
    ExposedAsset,
    ExposureAssessment,
    GeoPoint,
    SpreadProjection,
    utc_now,
)
from .ports import PortUnavailableError

DEFAULT_MODEL_ID: Final[str] = "fixture-exposure-v1"
DEFAULT_ASSET_REGISTRY_PATH: Final[Path] = (
    Path(__file__).resolve().parent.parent / "fixtures" / "berkeley_assets.json"
)

_ASSET_KINDS: Final[frozenset[str]] = frozenset({"road_segment", "shelter", "neighborhood", "facility"})
_AREAL_GEOMETRY_TYPES: Final[frozenset[str]] = frozenset({"Polygon", "MultiPolygon"})

_ON_EDGE_TOLERANCE_DEGREES: Final[float] = 1e-12
"""A point within this many degrees of a perimeter edge counts as on the edge, and so as exposed."""

Vertex = tuple[float, float]
"""A GeoJSON position as (longitude, latitude), in that order."""

Ring = tuple[Vertex, ...]


@dataclass(frozen=True, slots=True)
class _Polygon:
    """One GeoJSON polygon: an exterior ring and any number of holes."""

    exterior: Ring
    interiors: tuple[Ring, ...] = ()

    def contains(self, point: GeoPoint) -> bool:
        x, y = point.longitude, point.latitude
        if not _ring_contains(self.exterior, x, y, edge_is_inside=True):
            return False
        return not any(_ring_contains(hole, x, y, edge_is_inside=False) for hole in self.interiors)


def _point_on_segment(x: float, y: float, x1: float, y1: float, x2: float, y2: float) -> bool:
    """Whether (x, y) lies on the segment (x1, y1)-(x2, y2), within the edge tolerance."""
    cross = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)
    if abs(cross) > _ON_EDGE_TOLERANCE_DEGREES:
        return False
    tol = _ON_EDGE_TOLERANCE_DEGREES
    within_x = min(x1, x2) - tol <= x <= max(x1, x2) + tol
    within_y = min(y1, y2) - tol <= y <= max(y1, y2) + tol
    return within_x and within_y


def _ring_contains(ring: Ring, x: float, y: float, *, edge_is_inside: bool) -> bool:
    """Even-odd ray cast of a horizontal ray from (x, y) against one closed ring.

    ``edge_is_inside`` decides the boundary case. Exterior rings pass ``True`` so
    that a point exactly on the perimeter counts as exposed; hole rings pass
    ``False`` so that a point on the rim of a hole stays exposed too. Both
    choices lean the same way: touching the fire counts as reached.
    """
    inside = False
    count = len(ring)
    for index in range(count):
        x1, y1 = ring[index]
        x2, y2 = ring[(index + 1) % count]
        if _point_on_segment(x, y, x1, y1, x2, y2):
            return edge_is_inside
        if (y1 > y) != (y2 > y):
            crossing_x = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if x < crossing_x:
                inside = not inside
    return inside


def _ring_from_positions(raw: Any, context: str) -> Ring:
    if not isinstance(raw, (list, tuple)) or len(raw) < 3:
        raise ValueError(f"{context}: a linear ring needs at least 3 positions, got {raw!r}")
    vertices: list[Vertex] = []
    for position in raw:
        if not isinstance(position, (list, tuple)) or len(position) < 2:
            raise ValueError(f"{context}: a GeoJSON position needs [longitude, latitude], got {position!r}")
        longitude, latitude = position[0], position[1]
        if not isinstance(longitude, (int, float)) or not isinstance(latitude, (int, float)):
            raise ValueError(f"{context}: non-numeric position {position!r}")
        vertices.append((float(longitude), float(latitude)))
    if len(vertices) > 3 and vertices[0] == vertices[-1]:
        vertices.pop()
    if len(vertices) < 3:
        raise ValueError(f"{context}: a linear ring needs at least 3 distinct positions")
    return tuple(vertices)


def _polygon_from_rings(raw_rings: Any, context: str) -> _Polygon:
    if not isinstance(raw_rings, (list, tuple)) or not raw_rings:
        raise ValueError(f"{context}: a Polygon needs at least an exterior ring")
    rings = [_ring_from_positions(raw, context) for raw in raw_rings]
    return _Polygon(exterior=rings[0], interiors=tuple(rings[1:]))


def _collect_geometry(geometry: Any, polygons: list[_Polygon], skipped: list[str], context: str) -> None:
    """Append every areal polygon in ``geometry``; record the types that bound no area."""
    if geometry is None:
        skipped.append("null geometry")
        return
    if not isinstance(geometry, dict):
        raise ValueError(f"{context}: geometry must be a GeoJSON object, got {type(geometry).__name__}")
    geometry_type = geometry.get("type")
    if not isinstance(geometry_type, str):
        raise ValueError(f"{context}: geometry has no string 'type'")
    if geometry_type == "Polygon":
        polygons.append(_polygon_from_rings(geometry.get("coordinates"), context))
    elif geometry_type == "MultiPolygon":
        parts = geometry.get("coordinates")
        if not isinstance(parts, (list, tuple)):
            raise ValueError(f"{context}: MultiPolygon coordinates must be a list of polygons")
        polygons.extend(_polygon_from_rings(part, context) for part in parts)
    elif geometry_type == "GeometryCollection":
        for member in geometry.get("geometries") or []:
            _collect_geometry(member, polygons, skipped, context)
    else:
        skipped.append(geometry_type)


def _polygons_from_geojson(perimeter: Any) -> tuple[tuple[_Polygon, ...], tuple[str, ...]]:
    """Areal polygons in a GeoJSON perimeter, plus the geometry types that bound no area.

    Accepts a FeatureCollection (the shape ``SpreadFrame.perimeter`` uses), a
    single Feature, or a bare geometry. Anything that is not recognisable GeoJSON
    raises ``ValueError``: a malformed perimeter is an error to report, not an
    empty footprint to report as "nothing exposed".
    """
    if not isinstance(perimeter, dict):
        raise ValueError(f"perimeter must be a GeoJSON object, got {type(perimeter).__name__}")
    perimeter_type = perimeter.get("type")
    if not isinstance(perimeter_type, str):
        raise ValueError("perimeter has no string 'type'")

    polygons: list[_Polygon] = []
    skipped: list[str] = []
    if perimeter_type == "FeatureCollection":
        features = perimeter.get("features")
        if features is None:
            features = []
        if not isinstance(features, (list, tuple)):
            raise ValueError("FeatureCollection 'features' must be a list")
        for index, feature in enumerate(features):
            if not isinstance(feature, dict):
                raise ValueError(f"feature {index} is not a GeoJSON object")
            _collect_geometry(feature.get("geometry"), polygons, skipped, f"feature {index}")
    elif perimeter_type == "Feature":
        _collect_geometry(perimeter.get("geometry"), polygons, skipped, "feature")
    else:
        _collect_geometry(perimeter, polygons, skipped, "geometry")
    return tuple(polygons), tuple(skipped)


def point_in_perimeter(point: GeoPoint, perimeter: dict[str, Any]) -> bool:
    """Whether ``point`` falls inside the areal geometry of one GeoJSON perimeter."""
    polygons, _ = _polygons_from_geojson(perimeter)
    return any(polygon.contains(point) for polygon in polygons)


@dataclass(frozen=True, slots=True)
class RegistryAsset:
    """One entry of the asset registry, as loaded from the fixture file.

    ``representative_point`` is the single point the exposure test uses. For a
    neighborhood it is a rough centre; for a road segment it is the midpoint of
    the segment. The registry keeps ``capacity`` and ``single_egress`` so the
    planner-facing surfaces can show them, but neither affects containment.
    """

    asset_id: str
    kind: AssetKind
    name: str
    representative_point: GeoPoint
    population_estimate: int | None = None
    capacity: int | None = None
    single_egress: bool = False
    note: str | None = None


def _require_nonnegative_int(value: Any, field_name: str, asset_id: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"asset {asset_id}: {field_name} must be a whole number or null, got {value!r}")
    if value < 0:
        raise ValueError(f"asset {asset_id}: {field_name} must be nonnegative, got {value}")
    return value


def _geo_point_from_mapping(raw: Any, asset_id: str) -> GeoPoint:
    if not isinstance(raw, dict):
        raise ValueError(f"asset {asset_id}: representative_point must be an object with latitude and longitude")
    latitude, longitude = raw.get("latitude"), raw.get("longitude")
    if not isinstance(latitude, (int, float)) or not isinstance(longitude, (int, float)):
        raise ValueError(f"asset {asset_id}: representative_point needs numeric latitude and longitude")
    return GeoPoint(latitude=float(latitude), longitude=float(longitude))


def _exposure_sort_key(asset: ExposedAsset) -> tuple[int, int, str]:
    """Deterministic order: by first exposure time, then by asset id. Unknown times sort last."""
    if asset.first_exposure_minutes is None:
        return (1, 0, asset.asset_id)
    return (0, asset.first_exposure_minutes, asset.asset_id)


class FixtureExposureModel:
    """An :class:`~crisistwin_agent.ports.ExposureModel` over a synthetic asset registry.

    The registry is a fixture, so the populations and capacities it carries are
    invented. The exposure times are simulated, because the perimeters they come
    from are simulated. Both facts travel with the assessment.
    """

    def __init__(self, registry_path: Path | None = None, model_id: str = DEFAULT_MODEL_ID) -> None:
        self.model_id = model_id
        self.registry_path = Path(registry_path) if registry_path is not None else DEFAULT_ASSET_REGISTRY_PATH
        self._assets: tuple[RegistryAsset, ...] | None = None
        self._registry_id: str = "unknown-registry"
        self._registry_name: str = "unknown registry"

    @property
    def registry_id(self) -> str:
        self.registry_assets()
        return self._registry_id

    @property
    def registry_name(self) -> str:
        self.registry_assets()
        return self._registry_name

    def registry_assets(self) -> tuple[RegistryAsset, ...]:
        """The loaded registry. Loads on first use and caches; raises instead of returning an empty list."""
        if self._assets is None:
            self._assets = self._load_registry()
        return self._assets

    def assess(self, projection: SpreadProjection) -> ExposureAssessment:
        """Intersect ``projection``'s frames with the asset registry.

        Frames are walked in ascending ``elapsed_minutes``; the first frame whose
        perimeter covers an asset's representative point fixes that asset's
        ``first_exposure_minutes``. Assets no frame covers are left out.
        """
        assets = self.registry_assets()
        frames = sorted(projection.frames, key=lambda frame: frame.elapsed_minutes)

        parsed: list[tuple[int, tuple[_Polygon, ...]]] = []
        skipped_types: set[str] = set()
        for frame in frames:
            polygons, skipped = _polygons_from_geojson(frame.perimeter)
            parsed.append((frame.elapsed_minutes, polygons))
            skipped_types.update(skipped)

        exposed: list[ExposedAsset] = []
        for asset in assets:
            minutes = _first_containing_minutes(parsed, asset.representative_point)
            if minutes is None:
                continue
            exposed.append(
                ExposedAsset(
                    kind=asset.kind,
                    asset_id=asset.asset_id,
                    name=asset.name,
                    first_exposure_minutes=minutes,
                    population_estimate=asset.population_estimate,
                )
            )
        exposed.sort(key=_exposure_sort_key)

        return ExposureAssessment(
            projection_run_id=projection.run_id,
            assets=tuple(exposed),
            evidence=self._evidence(projection),
            limitations=self._limitations(projection, assets, tuple(sorted(skipped_types))),
        )

    def _evidence(self, projection: SpreadProjection) -> Evidence:
        return Evidence(
            kind="simulation",
            source_id=f"{self.model_id}:{self._registry_id}",
            source_name=f"CrisisTwin fixture exposure model over {self._registry_name}",
            retrieved_at=utc_now(),
            note=(
                f"Point-in-perimeter test of the synthetic registry {self.registry_path.name} against the frames "
                f"of projection {projection.run_id} (spread model {projection.model_id}). Derived from a "
                "simulation, so simulated throughout: nothing in this assessment was observed."
            ),
        )

    def _limitations(
        self,
        projection: SpreadProjection,
        assets: tuple[RegistryAsset, ...],
        skipped_geometry_types: tuple[str, ...],
    ) -> tuple[str, ...]:
        items: list[str] = [
            "Each asset is tested as a single representative point, not as its real extent: a neighborhood is one "
            "point rather than its built footprint, and a road segment is its midpoint rather than its length. "
            "Fire that crosses one end of a road, or the edge of a neighborhood, is not counted until it covers "
            "that one point, so these exposure times are optimistic and partial exposure is invisible.",
            f"Exposure time is resolved only to the projection's {projection.step_minutes}-minute frame step, so "
            "first_exposure_minutes is the first modelled frame that covers the point, not the modelled moment of "
            "arrival; the arrival falls somewhere inside the step before it.",
            "An asset the footprint never reaches is absent from this assessment rather than reported as safe. "
            "Absence means only that this run, under these inputs and within its horizon, never covered that "
            "point.",
            "Asset positions, population estimates, and shelter capacities come from a synthetic fixture registry "
            f"({self.registry_path.name}). They are invented for demonstration and describe no real community, so "
            "no number here counts real people, real buildings, or real capacity.",
            "Containment is an even-odd ray cast over the perimeter rings in longitude/latitude degrees, which "
            "treats the perimeter as flat; that holds over the few kilometres of this watch area but is wrong "
            "near the poles or across the antimeridian. A point lying exactly on a perimeter edge is counted as "
            "exposed.",
            "This model adds no observation of its own and sees only perimeter geometry. Smoke, embers and spot "
            "fires ahead of the front, radiant heat, road closures, loss of access, and structure-to-structure "
            "spread are all invisible to it, and it inherits every limitation of the projection it reads.",
        ]
        if any(asset.kind == "shelter" for asset in assets):
            items.append(
                "Shelter capacity is held in the registry but not in this assessment, and population_at_risk sums "
                "population estimates only. An exposed shelter therefore moves no population figure here, even "
                "though losing it would change the plan."
            )
        if any(asset.single_egress for asset in assets):
            items.append(
                "The registry marks a road as a sole outbound route, but this model routes no traffic and holds "
                "no road network. Reporting that segment says its midpoint is inside the modelled perimeter; it "
                "does not say that any neighborhood has lost its exit."
            )
        if skipped_geometry_types:
            joined = ", ".join(skipped_geometry_types)
            items.append(
                f"The projection's perimeter contained geometry that bounds no area ({joined}); only Polygon and "
                "MultiPolygon rings were tested for containment, and those features were ignored."
            )
        items.extend(f"Inherited from projection {projection.run_id}: {text}" for text in projection.limitations)
        return tuple(items)

    def _load_registry(self) -> tuple[RegistryAsset, ...]:
        try:
            raw_text = self.registry_path.read_text(encoding="utf-8")
        except OSError as exc:
            raise PortUnavailableError(f"asset registry {self.registry_path}", str(exc)) from exc
        try:
            payload = json.loads(raw_text)
        except json.JSONDecodeError as exc:
            raise PortUnavailableError(f"asset registry {self.registry_path}", f"invalid JSON: {exc}") from exc

        if not isinstance(payload, dict):
            raise ValueError(f"asset registry {self.registry_path} must be a JSON object")
        if "synthetic" not in payload:
            raise ValueError(
                f"asset registry {self.registry_path} does not declare whether it is synthetic; "
                "this loader refuses a registry of unknown provenance"
            )
        if payload["synthetic"] is not True:
            raise ValueError(
                f"asset registry {self.registry_path} is not marked synthetic; this loader accepts synthetic "
                "fixtures only, and no identifiable resident data belongs in it"
            )

        self._registry_id = str(payload.get("registry_id") or self.registry_path.stem)
        self._registry_name = str(payload.get("registry_name") or self.registry_path.stem)

        raw_assets = payload.get("assets")
        if not isinstance(raw_assets, list) or not raw_assets:
            raise ValueError(f"asset registry {self.registry_path} carries no 'assets' list")

        assets: list[RegistryAsset] = []
        seen: set[str] = set()
        for entry in raw_assets:
            if not isinstance(entry, dict):
                raise ValueError(f"asset registry {self.registry_path}: every asset must be an object")
            asset_id = entry.get("asset_id")
            if not isinstance(asset_id, str) or not asset_id.strip():
                raise ValueError(f"asset registry {self.registry_path}: an asset is missing a string asset_id")
            if asset_id in seen:
                raise ValueError(f"asset registry {self.registry_path}: duplicate asset_id {asset_id}")
            seen.add(asset_id)
            kind = entry.get("kind")
            if kind not in _ASSET_KINDS:
                raise ValueError(f"asset {asset_id}: kind {kind!r} is not one of {sorted(_ASSET_KINDS)}")
            name = entry.get("name")
            if not isinstance(name, str) or not name.strip():
                raise ValueError(f"asset {asset_id}: name must be a non-empty string")
            note = entry.get("note")
            assets.append(
                RegistryAsset(
                    asset_id=asset_id,
                    kind=cast("AssetKind", kind),
                    name=name,
                    representative_point=_geo_point_from_mapping(entry.get("representative_point"), asset_id),
                    population_estimate=_require_nonnegative_int(
                        entry.get("population_estimate"), "population_estimate", asset_id
                    ),
                    capacity=_require_nonnegative_int(entry.get("capacity"), "capacity", asset_id),
                    single_egress=bool(entry.get("single_egress", False)),
                    note=note if isinstance(note, str) else None,
                )
            )
        return tuple(assets)


def _first_containing_minutes(
    parsed_frames: list[tuple[int, tuple[_Polygon, ...]]],
    point: GeoPoint,
) -> int | None:
    """Elapsed minutes of the first frame covering ``point``, or ``None`` if no frame does."""
    for elapsed_minutes, polygons in parsed_frames:
        if any(polygon.contains(point) for polygon in polygons):
            return elapsed_minutes
    return None
