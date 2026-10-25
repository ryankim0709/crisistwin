"""``/api/world/…``: the shared world the workspace tabs read and control (docs/shared-world.md).

One active world per instance (MongoDB ``world_active``, one document ``_id: "active"``) and
named scenarios (``world_scenarios``). Reads are unauthenticated. Writes go through the live
controller check (``live_view(roles={"controller"})``): no token is needed unless
``LIVE_CONTROLLER_TOKEN`` is set, as for ``/api/live/active``.

- ``GET /api/world/active``: the active world; the default world (revision 0) until one is written.
- ``PATCH /api/world/active``: ``{baseRevision, updatedBy, changes}``; nested objects merge,
  arrays (``fire.ignitions``) replace. ``409 {error, detail, world}`` when ``baseRevision`` is stale.
- ``GET/POST /api/world/scenarios``, ``GET/DELETE /api/world/scenarios/<id>``,
  ``POST /api/world/scenarios/<id>/load``.

The world is configuration (a user assumption or a chosen historical case), not observed data
and not a simulation result; it carries no computed values.
"""

from __future__ import annotations

import copy
import json
import math
import re
from datetime import datetime
from typing import Any

from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from pymongo import DESCENDING
from pymongo.errors import DuplicateKeyError

from .live.auth import Principal, live_view
from .live.common import ApiError, col, iso, new_id, ok, parse_coord, parse_iso, wall_now

SCHEMA = "crisistwin.world/1"
ACTIVE_ID = "active"
WRITERS = ("fire", "simulation", "dispatch", "live", "mcp", "api")
REGION_KINDS = ("catalogue", "custom", "historical_fire", "incident")
WEATHER_MODES = ("historical_replay", "climatology_percentile", "forecast", "assumed")
MOISTURE_MODES = ("derived", "preset")
MOISTURE_PRESETS = ("critical", "dry", "moderate", "wet")
EXTRAS_KEYS = ("fire", "simulation", "dispatch", "live")

MAX_PATCH_BYTES = 64 * 1024
MAX_SCENARIO_BYTES = 3 * 1024 * 1024
MAX_EXTRAS_BYTES = 2 * 1024 * 1024
MAX_IGNITIONS = 50
MAX_START_MINUTE = 7 * 24 * 60
MAX_SEED = 2**32 - 1
MAX_SCENARIOS_LISTED = 200
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
SERVER_FIELDS = ("schema", "revision", "updatedAt", "updatedBy")

DEFAULT_WORLD: dict[str, Any] = {
    "schema": SCHEMA,
    "revision": 0,
    "updatedAt": None,
    "updatedBy": None,
    # Catalogue region berkeley-hills-tilden (app/src/fire/regions.ts).
    "region": {
        "kind": "catalogue",
        "id": "berkeley-hills-tilden",
        "name": "Berkeley Hills & Tilden",
        "center": [-122.23, 37.895],
        "radiusMeters": 15000,
        "cellMeters": 60,
    },
    "conditions": {
        "startUtc": "2025-08-15T20:00:00Z",
        "weather": {"mode": "historical_replay"},
        "moisture": {"mode": "derived"},
    },
    "fire": {"ignitions": [], "stochastic": {"enabled": False, "seed": 1}},
    "liveIncidentId": None,
    "seed": 1,
}


def default_world() -> dict[str, Any]:
    return copy.deepcopy(DEFAULT_WORLD)


# ---- validation ----


def _bad(field: str, message: str) -> ApiError:
    return ApiError(400, "invalid_world", f"`{field}` {message}")


def _object(value: Any, field: str, allowed: tuple[str, ...]) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise _bad(field, "must be an object.")
    unknown = sorted(set(value) - set(allowed))
    if unknown:
        raise _bad(field, f"has unknown keys: {', '.join(unknown)}.")
    return value


def _number(value: Any, field: str, low: float, high: float) -> float | int:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise _bad(field, "must be a finite number.")
    if not low <= value <= high:
        raise _bad(field, f"must be between {low:g} and {high:g}.")
    return value


def _integer(value: Any, field: str, low: int, high: int) -> int:
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
        raise _bad(field, f"must be an integer from {low} to {high}.")
    return value


def _choice(value: Any, field: str, options: tuple[str, ...]) -> str:
    if value not in options:
        raise _bad(field, f"must be one of {', '.join(options)}.")
    return value


def _text(value: Any, field: str, max_len: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > max_len:
        raise _bad(field, f"must be a non-empty string of at most {max_len} characters.")
    return value.strip()


def _ident(value: Any, field: str) -> str:
    if not isinstance(value, str) or not ID_PATTERN.match(value):
        raise _bad(field, "must be an id of 1-64 letters, digits, '.', '_', ':' or '-'.")
    return value


def _coord(value: Any, field: str) -> list[float]:
    lon, lat = parse_coord(value, field, "invalid_world")
    return [lon, lat]


def _utc(value: Any, field: str) -> str:
    parsed = parse_iso(value, field, "invalid_world")
    if not 1900 <= parsed.year <= 2100:
        raise _bad(field, "must be between 1900 and 2100.")
    return iso(parsed)  # normalised to YYYY-MM-DDTHH:MM:SSZ


def _region(value: Any) -> dict[str, Any]:
    r = _object(value, "region", ("kind", "id", "name", "center", "radiusMeters", "cellMeters"))
    kind = _choice(r.get("kind"), "region.kind", REGION_KINDS)
    raw_id = r.get("id")
    if raw_id is None:
        if kind != "custom":
            raise _bad("region.id", f"is required for kind {kind}.")
        region_id = None
    else:
        region_id = _ident(raw_id, "region.id")
    cell = _integer(r.get("cellMeters"), "region.cellMeters", 30, 300)
    if cell % 30:
        raise _bad("region.cellMeters", "must be a multiple of 30.")
    return {
        "kind": kind,
        "id": region_id,
        "name": _text(r.get("name"), "region.name", 120),
        "center": _coord(r.get("center"), "region.center"),
        "radiusMeters": _number(r.get("radiusMeters"), "region.radiusMeters", 1000, 60000),
        "cellMeters": cell,
    }


def _weather(value: Any) -> dict[str, Any]:
    w = _object(value, "conditions.weather", ("mode", "percentile", "windSpeedMph", "windFromDegrees"))
    mode = _choice(w.get("mode"), "conditions.weather.mode", WEATHER_MODES)
    out: dict[str, Any] = {"mode": mode}
    # Mode-specific fields are kept when present (switching back restores them), required for their mode.
    if w.get("percentile") is not None:
        out["percentile"] = _number(w["percentile"], "conditions.weather.percentile", 0, 100)
    if w.get("windSpeedMph") is not None:
        out["windSpeedMph"] = _number(w["windSpeedMph"], "conditions.weather.windSpeedMph", 0, 150)
    if w.get("windFromDegrees") is not None:
        out["windFromDegrees"] = _number(w["windFromDegrees"], "conditions.weather.windFromDegrees", 0, 360)
    if mode == "climatology_percentile" and "percentile" not in out:
        raise _bad("conditions.weather.percentile", "is required for climatology_percentile.")
    if mode == "assumed" and not {"windSpeedMph", "windFromDegrees"} <= set(out):
        raise _bad("conditions.weather", "needs windSpeedMph and windFromDegrees for assumed.")
    return out


def _moisture(value: Any) -> dict[str, Any]:
    m = _object(value, "conditions.moisture", ("mode", "preset"))
    mode = _choice(m.get("mode"), "conditions.moisture.mode", MOISTURE_MODES)
    out: dict[str, Any] = {"mode": mode}
    if m.get("preset") is not None:
        out["preset"] = _choice(m["preset"], "conditions.moisture.preset", MOISTURE_PRESETS)
    if mode == "preset" and "preset" not in out:
        raise _bad("conditions.moisture.preset", "is required for preset.")
    return out


def _fire(value: Any) -> dict[str, Any]:
    f = _object(value, "fire", ("ignitions", "stochastic"))
    ignitions = f.get("ignitions")
    if not isinstance(ignitions, list) or len(ignitions) > MAX_IGNITIONS:
        raise _bad("fire.ignitions", f"must be a list of at most {MAX_IGNITIONS}.")
    out_ignitions, seen = [], set()
    for i, raw in enumerate(ignitions):
        field = f"fire.ignitions[{i}]"
        ig = _object(raw, field, ("id", "at", "startMinute"))
        ig_id = _ident(ig.get("id"), f"{field}.id")
        if ig_id in seen:
            raise _bad(f"{field}.id", "must be unique.")
        seen.add(ig_id)
        out_ignitions.append(
            {
                "id": ig_id,
                "at": _coord(ig.get("at"), f"{field}.at"),
                "startMinute": _number(ig.get("startMinute"), f"{field}.startMinute", 0, MAX_START_MINUTE),
            }
        )
    s = _object(f.get("stochastic"), "fire.stochastic", ("enabled", "seed"))
    if not isinstance(s.get("enabled"), bool):
        raise _bad("fire.stochastic.enabled", "must be true or false.")
    return {
        "ignitions": out_ignitions,
        "stochastic": {"enabled": s["enabled"], "seed": _integer(s.get("seed"), "fire.stochastic.seed", 0, MAX_SEED)},
    }


def validate_content(world: Any) -> dict[str, Any]:
    """A complete world's content (no server fields), normalised; ``ApiError(400)`` otherwise."""
    w = _object(world, "world", ("region", "conditions", "fire", "liveIncidentId", "seed", *SERVER_FIELDS))
    if w.get("schema", SCHEMA) != SCHEMA:
        raise _bad("schema", f"must be {SCHEMA}.")
    c = _object(w.get("conditions"), "conditions", ("startUtc", "weather", "moisture"))
    live_id = w.get("liveIncidentId")
    return {
        "region": _region(w.get("region")),
        "conditions": {
            "startUtc": _utc(c.get("startUtc"), "conditions.startUtc"),
            "weather": _weather(c.get("weather")),
            "moisture": _moisture(c.get("moisture")),
        },
        "fire": _fire(w.get("fire")),
        "liveIncidentId": None if live_id is None else _ident(live_id, "liveIncidentId"),
        "seed": _integer(w.get("seed"), "seed", 0, MAX_SEED),
    }


def merge(base: dict[str, Any], changes: dict[str, Any]) -> dict[str, Any]:
    """Deep merge: objects merge key by key; arrays, scalars and null replace."""
    out = dict(base)
    for key, value in changes.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def _writer(value: Any, default: str = "api") -> str:
    if value is None:
        return default
    return _choice(value, "updatedBy", WRITERS)


# ---- storage ----


def _public(doc: dict[str, Any] | None) -> dict[str, Any]:
    if doc is None:
        return default_world()
    updated = doc.get("updatedAt")
    return {
        "schema": SCHEMA,
        "revision": int(doc.get("revision", 0)),
        "updatedAt": iso(updated) if isinstance(updated, datetime) else updated,
        "updatedBy": doc.get("updatedBy"),
        "region": doc["region"],
        "conditions": doc["conditions"],
        "fire": doc["fire"],
        "liveIncidentId": doc.get("liveIncidentId"),
        "seed": doc["seed"],
    }


def active_world() -> dict[str, Any]:
    return _public(col("world_active").find_one({"_id": ACTIVE_ID}))


def _write_active(content: dict[str, Any], base_revision: int, updated_by: str) -> dict[str, Any] | None:
    """Store ``content`` as revision ``base_revision + 1`` if the stored revision is still
    ``base_revision``; the new world, or None when another write got there first."""
    doc = {
        "_id": ACTIVE_ID,
        **content,
        "revision": base_revision + 1,
        "updatedAt": wall_now(),
        "updatedBy": updated_by,
    }
    active = col("world_active")
    if base_revision == 0:
        try:
            active.insert_one(doc)
        except DuplicateKeyError:
            return None
    else:
        result = active.replace_one({"_id": ACTIVE_ID, "revision": base_revision}, doc)
        if result.matched_count == 0:
            return None
    return _public(doc)


def _conflict(world: dict[str, Any]):
    return ok(
        {"error": "revision_conflict", "detail": "The world changed since your copy; reload it.", "world": world},
        status=409,
    )


# ---- request bodies ----


def _reject_constant(name: str):
    raise ApiError(400, "invalid_request", "Body must be valid JSON without NaN or Infinity.")


def _body(request, limit: int) -> dict[str, Any]:
    """The JSON object body, reading at most ``limit`` bytes (bypasses Django's 2.5 MB cap)."""
    try:
        length = int(request.META.get("CONTENT_LENGTH") or 0)
    except ValueError:
        raise ApiError(400, "invalid_request", "Invalid Content-Length.") from None
    if length > limit:
        raise ApiError(413, "too_large", f"Request body exceeds {limit} bytes.")
    stream = request.stream
    raw = stream.read(limit + 1) if stream is not None else b""
    if len(raw) > limit:
        raise ApiError(413, "too_large", f"Request body exceeds {limit} bytes.")
    if not raw.strip():
        return {}
    try:
        data = json.loads(raw, parse_constant=_reject_constant)
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise ApiError(400, "invalid_request", "Body must be valid JSON.") from None
    if not isinstance(data, dict):
        raise ApiError(400, "invalid_request", "Body must be a JSON object.")
    return data


# ---- views: active world ----


@live_view(["GET"], auth=False)
def get_active(request, principal: Principal | None):
    return ok(active_world())


@live_view(["PATCH"], roles={"controller"})
def patch_active(request, principal: Principal):
    body = _body(request, MAX_PATCH_BYTES)
    unknown = sorted(set(body) - {"baseRevision", "updatedBy", "changes"})
    if unknown:
        raise ApiError(400, "invalid_request", f"Unknown keys: {', '.join(unknown)}.")
    base_revision = body.get("baseRevision")
    if not isinstance(base_revision, int) or isinstance(base_revision, bool) or base_revision < 0:
        raise ApiError(400, "invalid_request", "`baseRevision` must be a non-negative integer.")
    updated_by = _writer(body.get("updatedBy"))
    changes = body.get("changes")
    if not isinstance(changes, dict):
        raise ApiError(400, "invalid_request", "`changes` must be an object (a partial world).")
    changes = {k: v for k, v in changes.items() if k not in SERVER_FIELDS}

    current = active_world()
    if base_revision != current["revision"]:
        return _conflict(current)
    content = validate_content(merge(current, changes))
    world = _write_active(content, base_revision, updated_by)
    if world is None:
        return _conflict(active_world())
    return ok(world)


@csrf_exempt
def world_active(request):
    if request.method == "GET":
        return get_active(request)
    if request.method == "PATCH":
        return patch_active(request)
    return JsonResponse({"error": "method_not_allowed"}, status=405)


# ---- views: scenarios ----


def _summary(doc: dict[str, Any]) -> dict[str, Any]:
    world = doc.get("world") or {}
    return {
        "id": doc["_id"],
        "name": doc.get("name", ""),
        "notes": doc.get("notes", ""),
        "tags": doc.get("tags", []),
        "createdAt": iso(doc.get("createdAt")),
        "updatedBy": doc.get("updatedBy"),
        "region": world.get("region"),
        "startUtc": (world.get("conditions") or {}).get("startUtc"),
        "extrasKeys": sorted(doc.get("extrasKeys", [])),
    }


def _full(doc: dict[str, Any]) -> dict[str, Any]:
    extras_json = doc.get("extrasJson")
    return {
        **_summary(doc),
        "world": doc.get("world"),
        "extras": json.loads(extras_json) if extras_json else {},
    }


def _scenario(scenario_id: str) -> dict[str, Any]:
    doc = col("world_scenarios").find_one({"_id": scenario_id})
    if doc is None:
        raise ApiError(404, "not_found", "Unknown scenario.")
    return doc


def _saved_world(value: Any) -> dict[str, Any]:
    """A complete world to save: validated content plus its provenance (revision, author)."""
    content = validate_content(value)
    revision = value.get("revision", 0)
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 0:
        raise _bad("world.revision", "must be a non-negative integer.")
    updated_at = value.get("updatedAt")
    by = value.get("updatedBy")
    return {
        "schema": SCHEMA,
        "revision": revision,
        "updatedAt": None if updated_at is None else _utc(updated_at, "world.updatedAt"),
        "updatedBy": None if by is None else _writer(by),
        **content,
    }


def _extras(value: Any) -> tuple[str | None, list[str]]:
    if value is None:
        return None, []
    extras = _object(value, "extras", EXTRAS_KEYS)
    extras = {k: v for k, v in extras.items() if v is not None}
    if not extras:
        return None, []
    encoded = json.dumps(extras, separators=(",", ":"), allow_nan=False)
    if len(encoded.encode()) > MAX_EXTRAS_BYTES:
        raise ApiError(413, "too_large", f"`extras` exceeds {MAX_EXTRAS_BYTES} bytes.")
    return encoded, sorted(extras)


@live_view(["GET"], auth=False)
def list_scenarios(request, principal: Principal | None):
    docs = (
        col("world_scenarios")
        .find({}, {"extrasJson": 0})
        .sort([("createdAt", DESCENDING), ("_id", DESCENDING)])
        .limit(MAX_SCENARIOS_LISTED)
    )
    return ok({"scenarios": [_summary(d) for d in docs]})


@live_view(["POST"], roles={"controller"})
def create_scenario(request, principal: Principal):
    body = _body(request, MAX_SCENARIO_BYTES)
    unknown = sorted(set(body) - {"name", "notes", "tags", "world", "extras", "updatedBy"})
    if unknown:
        raise ApiError(400, "invalid_request", f"Unknown keys: {', '.join(unknown)}.")
    name = _text(body.get("name"), "name", 120)
    notes = body.get("notes") or ""
    if not isinstance(notes, str) or len(notes) > 4000:
        raise _bad("notes", "must be a string of at most 4000 characters.")
    tags = body.get("tags") or []
    if not isinstance(tags, list) or len(tags) > 20:
        raise _bad("tags", "must be a list of at most 20 strings.")
    tags = [_text(t, f"tags[{i}]", 40) for i, t in enumerate(tags)]
    world = _saved_world(body.get("world"))
    extras_json, extras_keys = _extras(body.get("extras"))
    doc = {
        "_id": new_id("scn_"),
        "name": name,
        "notes": notes.strip(),
        "tags": tags,
        "createdAt": wall_now(),
        "updatedBy": _writer(body.get("updatedBy"), world["updatedBy"] or "api"),
        "world": world,
        "extrasJson": extras_json,
        "extrasKeys": extras_keys,
    }
    col("world_scenarios").insert_one(doc)
    return ok(_full(doc), status=201)


@csrf_exempt
def world_scenarios(request):
    if request.method == "GET":
        return list_scenarios(request)
    if request.method == "POST":
        return create_scenario(request)
    return JsonResponse({"error": "method_not_allowed"}, status=405)


@live_view(["GET"], auth=False)
def get_scenario(request, principal: Principal | None, scenario_id: str):
    return ok(_full(_scenario(scenario_id)))


@live_view(["DELETE"], roles={"controller"})
def delete_scenario(request, principal: Principal, scenario_id: str):
    result = col("world_scenarios").delete_one({"_id": scenario_id})
    if result.deleted_count == 0:
        raise ApiError(404, "not_found", "Unknown scenario.")
    return ok({"deleted": scenario_id})


@csrf_exempt
def world_scenario(request, scenario_id: str):
    if request.method == "GET":
        return get_scenario(request, scenario_id=scenario_id)
    if request.method == "DELETE":
        return delete_scenario(request, scenario_id=scenario_id)
    return JsonResponse({"error": "method_not_allowed"}, status=405)


@live_view(["POST"], roles={"controller"})
def load_scenario(request, principal: Principal, scenario_id: str):
    """Make the scenario's world the active world as a new revision. ``baseRevision`` is
    optional: given, a stale one is a 409; omitted, the load replaces whatever is active."""
    body = _body(request, MAX_PATCH_BYTES)
    unknown = sorted(set(body) - {"baseRevision", "updatedBy"})
    if unknown:
        raise ApiError(400, "invalid_request", f"Unknown keys: {', '.join(unknown)}.")
    updated_by = _writer(body.get("updatedBy"))
    base_revision = body.get("baseRevision")
    if base_revision is not None and (
        not isinstance(base_revision, int) or isinstance(base_revision, bool) or base_revision < 0
    ):
        raise ApiError(400, "invalid_request", "`baseRevision` must be a non-negative integer.")
    doc = _scenario(scenario_id)
    content = validate_content(doc["world"])
    for _attempt in range(5):
        current = active_world()
        if base_revision is not None and base_revision != current["revision"]:
            return _conflict(current)
        world = _write_active(content, current["revision"], updated_by)
        if world is not None:
            return ok({"world": world, "scenario": _full(doc)})
    return _conflict(active_world())
