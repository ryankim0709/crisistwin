"""Drill packages from Simulation Studio runs (docs/adr/0037-studio-drill-packages.md).

``POST /api/live/packages`` (controller): body is a Studio run export (``crisistwin_studio_run``
v1, at most ``MAX_RUN_BYTES``). The server picks the road box from the fire, gets the dispatch
area for it (``api.dispatch_area.get_area_gzip``: in-process cache, then MongoDB, then
Overpass), builds the package with ``livecore.package.build_package``, checks that
``load_package`` reads it, and stores it as ``{LIVE_PACKAGES_DIR}/{package_id}.json`` with a
``.meta.json`` sidecar. Returns ``201 {package_id, incident_id, summary}`` (``200`` when the
same run was already stored).

``GET /api/live/packages`` (controller): ``{packages: [{package_id, incident_id, created_at,
summary}]}``, newest first.

Building a package never changes the active drill. ``activate`` only reports what would change;
``POST /api/live/active {package_id}`` (``api.live_active``) switches.
"""

from __future__ import annotations

import gzip
import json
import logging
import os
import re
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from django.conf import settings

from livecore.package import PackageError, area_box, build_package, load_package, package_summary, parse_run

from .. import dispatch_area
from . import incidents
from .auth import Principal, live_view
from .common import ApiError, ok
from .drillcache import bundle_path

log = logging.getLogger(__name__)

MAX_RUN_BYTES = 24 * 1024 * 1024
"""Body cap for a run export (a 1,000 x 1,000 arrival grid is about 7 MB of JSON)."""
MAX_LISTED = 200
PACKAGE_ID_RE = re.compile(r"pkg_[0-9a-f]{12}")


def packages_dir() -> Path:
    """``LIVE_PACKAGES_DIR``, default ``app/backend/var/packages`` (git-ignored)."""
    configured = (getattr(settings, "LIVE_PACKAGES_DIR", "") or "").strip()
    return Path(configured) if configured else Path(settings.BASE_DIR) / "var" / "packages"


def _read_body(request) -> Any:
    try:
        length = int(request.META.get("CONTENT_LENGTH") or 0)
    except ValueError as exc:
        raise ApiError(400, "invalid_request", "Bad Content-Length.") from exc
    if length > MAX_RUN_BYTES:
        raise ApiError(413, "too_large", f"The run export exceeds {MAX_RUN_BYTES} bytes.")
    # Read the stream directly: request.body enforces DATA_UPLOAD_MAX_MEMORY_SIZE (2.5 MB).
    raw = request._request.read(MAX_RUN_BYTES + 1)
    if len(raw) > MAX_RUN_BYTES:
        raise ApiError(413, "too_large", f"The run export exceeds {MAX_RUN_BYTES} bytes.")
    try:
        return json.loads(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ApiError(400, "invalid_run", "Body must be a JSON run export.") from exc


def fetch_area(box: tuple[float, float, float, float]) -> dict[str, Any]:
    """The dispatch area for ``box`` (west, south, east, north degrees), cached as /api/dispatch/area."""
    snapped = dispatch_area.parse_bbox(",".join(f"{v:.6f}" for v in box))
    if snapped is None:
        raise ApiError(422, "bad_bbox", "The fire's road box is outside the dispatch area limits.")
    try:
        gz = dispatch_area.get_area_gzip(snapped)
    except dispatch_area.UpstreamUnavailable as exc:
        raise ApiError(502, "upstream_unavailable", "OpenStreetMap could not be reached; try again.") from exc
    except dispatch_area.NoRoads as exc:
        raise ApiError(422, "no_roads", "No drivable roads were found around this fire.") from exc
    except dispatch_area.NoExits as exc:
        raise ApiError(422, "no_exits", "No roads leave this area, so there is nowhere to evacuate to.") from exc
    return json.loads(gzip.decompress(gz))


def _write_json(path: Path, data: Any) -> None:
    """Atomic write (temp file + rename) so a reader never sees half a package."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, separators=(",", ":"), ensure_ascii=False)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def create_package(run_raw: Any) -> tuple[dict[str, Any], bool]:
    """Build, verify and store a package. Returns ``(meta, created)``. Raises ``ApiError``."""
    try:
        run = parse_run(run_raw)
        box = area_box(run)
    except PackageError as exc:
        raise ApiError(422 if exc.code == "outside_california" else 400, exc.code, exc.detail) from exc
    area = fetch_area(box.bbox)
    try:
        package = build_package(run_raw, area, box)
    except PackageError as exc:
        raise ApiError(422, exc.code, exc.detail) from exc
    package_id = package["drill_package"]["package_id"]
    directory = packages_dir()
    path = directory / f"{package_id}.json"
    meta_path = directory / f"{package_id}.meta.json"
    if path.exists() and meta_path.exists():
        return json.loads(meta_path.read_text(encoding="utf-8")), False
    _write_json(path, package)
    try:
        drill = load_package(path)
    except (OSError, ValueError, KeyError) as exc:
        path.unlink(missing_ok=True)
        log.exception("drill package %s does not load", package_id)
        raise ApiError(500, "package_invalid", "The built package could not be loaded as a drill.") from exc
    meta = {
        "package_id": package_id,
        "incident_id": drill.incident_id,
        "created_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "file": path.name,
        "summary": package_summary(package),
    }
    _write_json(meta_path, meta)
    return meta, True


def list_packages() -> list[dict[str, Any]]:
    directory = packages_dir()
    if not directory.is_dir():
        return []
    out = []
    for meta_path in directory.glob("pkg_*.meta.json"):
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            log.warning("unreadable drill package meta %s", meta_path.name)
            continue
        out.append({k: meta.get(k) for k in ("package_id", "incident_id", "created_at", "summary")})
    out.sort(key=lambda m: m.get("created_at") or "", reverse=True)
    return out[:MAX_LISTED]


def activate(package_id: str) -> dict[str, Any]:
    """What making ``package_id`` the active drill would change. Changes nothing.

    A dry run of ``POST /api/live/active {package_id}`` (docs/adr/0047-active-incident.md), which
    loads the package's drill index (``drillcache.get_index``), makes its ``incident_id`` the one
    ``live_view`` accepts next to Camp, and warms a traffic twin built from the package's roads,
    zones and fronts (``sim.twin.package_inputs``). Raises ``ApiError(404)``.
    """
    if not PACKAGE_ID_RE.fullmatch(package_id or ""):
        raise ApiError(404, "not_found", "Unknown package.")
    path = packages_dir() / f"{package_id}.json"
    meta_path = packages_dir() / f"{package_id}.meta.json"
    if not path.exists() or not meta_path.exists():
        raise ApiError(404, "not_found", "Unknown package.")
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    return {
        "applied": False,
        "package_id": package_id,
        "would_change": {
            "incident_id": {"from": incidents.active_incident_id(), "to": meta["incident_id"]},
            "drill_bundle": {"from": str(bundle_path()), "to": str(path)},
            "loader": "livecore.package.load_package",
            "clock": meta["summary"]["clock"],
            "label": meta["summary"]["label"],
            "twin": "built from the package roads, synthetic zones and simulated fronts",
            "response_record": "none (the package has no events)",
        },
    }


@live_view(["GET", "POST"], roles={"controller"})
def packages(request, principal: Principal):
    if request.method == "GET":
        return ok({"packages": list_packages()})
    meta, created = create_package(_read_body(request))
    body = {"package_id": meta["package_id"], "incident_id": meta["incident_id"], "summary": meta["summary"]}
    return ok(body, status=201 if created else 200)
