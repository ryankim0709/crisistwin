"""Fires published by Simulation Studio for the Live command page (all simulated).

``POST /api/live/studio-fires`` (controller): Studio publishes the scenario it just ran. The
fire is stamped with the active incident and stored in ``live_studio_fires``. A new Studio run
replaces the incident's drill state: the older publishes, the board's run state and household
states (``run_state.forget``), the board's resident guidance (withdrawn) and the controller's road
closures are cleared, so the stored state is the new run's only (``_replace_previous_run``).
``GET /api/live/incidents/<id>/studio-fires[?after=ISO]`` (any live viewer) lists the newest 10.
Contract: docs/live-reports.md "Studio fires".
"""

from __future__ import annotations

import logging
import math
import secrets
from datetime import datetime
from typing import Any

from pymongo import DESCENDING
from pymongo.errors import PyMongoError

from . import board_guidance, incidents, road_closures, run_state
from .auth import Principal, live_view
from .common import ApiError, col, iso, json_body, ok, parse_iso, wall_now
from .drillcache import get_index

log = logging.getLogger(__name__)

COLLECTION = "live_studio_fires"
LIST_LIMIT = 10
MAX_IGNITIONS = 5
OUTSIDE_DRILL_KM = 3.0
CODE = "invalid_studio_fire"
# Descriptive provenance labels (wind source, weather series); Studio clamps to this (studio/liveFire.ts).
LABEL_MAX_CHARS = 300
MOISTURE_KEYS = ("dead1h", "dead10h", "dead100h", "liveHerb", "liveWoody")
# Hourly weather series of the run (fire/weatherSeries.ts MAX_WEATHER_SAMPLES, MAX_SERIES_WIND_MPH).
MAX_SERIES_SAMPLES = 433
MAX_SERIES_WIND_MPH = 120
SERIES_MINUTE_RANGE = (-4320, 4320)
# Same run limit as fire/horizon.ts (seven days); validation limits, not model parameters.
MAX_HORIZON_MINUTES = 10080
_index_ready = False


def _num(value: Any, field: str, lo: float, hi: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ApiError(400, CODE, f"`{field}` must be a finite number.")
    if not lo <= value <= hi:
        raise ApiError(400, CODE, f"`{field}` must be between {lo:g} and {hi:g}.")
    return float(value)


def _int(value: Any, field: str, lo: int, hi: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        if isinstance(value, float) and math.isfinite(value) and value == int(value):
            value = int(value)
        else:
            raise ApiError(400, CODE, f"`{field}` must be an integer.")
    if not lo <= value <= hi:
        raise ApiError(400, CODE, f"`{field}` must be between {lo} and {hi}.")
    return value


def _text(value: Any, field: str, max_len: int, required: bool = True) -> str:
    if value is None and not required:
        return ""
    if not isinstance(value, str) or (required and not value.strip()) or len(value) > max_len:
        raise ApiError(400, CODE, f"`{field}` must be a string of at most {max_len} characters.")
    return value.strip()


def _obj(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ApiError(400, CODE, f"`{field}` must be an object.")
    return value


def _moisture_values(value: Any, field: str, lo: float = 0.01, hi: float = 3) -> dict[str, float]:
    values = _obj(value, field)
    return {k: _num(values.get(k), f"{field}.{k}", lo, hi) for k in MOISTURE_KEYS}


def _weather_series(value: Any) -> dict[str, Any] | None:
    """The run's hourly series (optional): samples strictly ascending in minute, at most 433."""
    if value is None:
        return None
    series = _obj(value, "weather_series")
    raw = series.get("samples")
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_SERIES_SAMPLES:
        raise ApiError(400, CODE, f"`weather_series.samples` must be a list of 1 to {MAX_SERIES_SAMPLES} items.")
    samples, last = [], None
    for i, item in enumerate(raw):
        item = _obj(item, f"weather_series.samples[{i}]")
        minute = _num(item.get("minute"), f"weather_series.samples[{i}].minute", *SERIES_MINUTE_RANGE)
        if last is not None and minute <= last:
            raise ApiError(400, CODE, "`weather_series.samples` must be in strictly ascending `minute`.")
        last = minute
        moisture = item.get("moisture")
        samples.append({
            "minute": minute,
            "wind_speed_mph": _num(item.get("wind_speed_mph"), f"weather_series.samples[{i}].wind_speed_mph", 0,
                                   MAX_SERIES_WIND_MPH),
            "wind_from_deg": _num(item.get("wind_from_deg"), f"weather_series.samples[{i}].wind_from_deg", 0, 360),
            "moisture": None if moisture is None else _moisture_values(moisture, f"weather_series.samples[{i}].moisture", 0, 4),
        })
    return {
        "source": _text(series.get("source"), "weather_series.source", 80, required=False),
        "evidence": _text(series.get("evidence"), "weather_series.evidence", 40, required=False),
        "samples": samples,
    }


def _fire_settings(value: Any, horizon: int) -> dict[str, Any] | None:
    """Studio's FireSettings, in its native camelCase shape (studio/scenario.ts).

    Keep optional mechanisms absent when absent: the shared solver supplies their defaults.
    Older publishes have no settings; never manufacture a stochastic seed for them.
    """
    if value is None:
        return None
    raw = _obj(value, "fire_settings")

    def number(obj, key, path, lo=-math.inf, hi=math.inf):
        return _num(obj.get(key), f"{path}.{key}", lo, hi)

    def flag(obj, key, path):
        val = obj.get(key)
        if not isinstance(val, bool):
            raise ApiError(400, CODE, f"`{path}.{key}` must be a boolean.")
        return val

    settings = {
        "windSpeedMph": number(raw, "windSpeedMph", "fire_settings", 0, 60),
        "windFromDegrees": number(raw, "windFromDegrees", "fire_settings", 0, 360),
        "moisture": _moisture_values(raw.get("moisture"), "fire_settings.moisture"),
        "midflameAdjustment": number(raw, "midflameAdjustment", "fire_settings", 0.01, 1),
        "stepMinutes": number(raw, "stepMinutes", "fire_settings"),
        "horizonMinutes": _int(raw.get("horizonMinutes"), "fire_settings.horizonMinutes", 60, MAX_HORIZON_MINUTES),
    }
    if settings["horizonMinutes"] != horizon:
        raise ApiError(400, CODE, "`fire_settings.horizonMinutes` must match `horizon_minutes`.")
    for key, fields in (
        ("spotting", {"maxDistanceMeters": (0, 2000)}),
        ("structureSpread", {"rateMetersPerMinute": (0, 1000)}),
        ("stochastic", {"seed": (-math.inf, math.inf)}),
        ("fireInducedWind", {}),
    ):
        if key not in raw:
            continue
        path = f"fire_settings.{key}"
        obj = _obj(raw[key], path)
        out = {"enabled": flag(obj, "enabled", path)}
        out.update({field: number(obj, field, path, *bounds) for field, bounds in fields.items()})
        if key == "stochastic":
            for field in ("rosSigma", "rosCorrelationMeters", "gustFactor", "airTemperatureF"):
                if field not in obj:
                    continue
                if field == "gustFactor" and obj[field] is None:
                    out[field] = None
                else:
                    bounds = (0, math.log(3)) if field == "rosSigma" else (-math.inf, math.inf)
                    out[field] = number(obj, field, path, *bounds)
            for field in ("spotting", "windWander"):
                if field in obj:
                    out[field] = flag(obj, field, path)
        if key == "fireInducedWind" and "seed" in obj:
            out["seed"] = number(obj, "seed", path)
        settings[key] = out
    if "weatherSeries" in raw:
        path = "fire_settings.weatherSeries"
        obj = _obj(raw["weatherSeries"], path)
        enabled = flag(obj, "enabled", path)
        samples = obj.get("samples")
        if not isinstance(samples, list) or not (1 if enabled else 0) <= len(samples) <= MAX_SERIES_SAMPLES:
            raise ApiError(400, CODE, f"`{path}.samples` must have at most {MAX_SERIES_SAMPLES} samples, and at least one when enabled.")
        out = {"enabled": enabled, "samples": []}
        last = None
        for i, sample in enumerate(samples):
            at = f"{path}.samples[{i}]"
            sample = _obj(sample, at)
            minute = number(sample, "minute", at)
            if last is not None and minute <= last:
                raise ApiError(400, CODE, f"`{path}.samples` must be strictly ascending in minute.")
            last = minute
            item = {
                "minute": minute,
                "windSpeedMph": number(sample, "windSpeedMph", at, 0, MAX_SERIES_WIND_MPH),
                "windFromDegrees": number(sample, "windFromDegrees", at),
            }
            if "moisture" in sample:
                moist = _obj(sample["moisture"], f"{at}.moisture")
                item["moisture"] = {k: number(moist, k, f"{at}.moisture", 0, 4) for k in MOISTURE_KEYS}
            if "airTemperatureF" in sample:
                item["airTemperatureF"] = number(sample, "airTemperatureF", at)
            out["samples"].append(item)
        for field in ("source", "evidence"):
            if field in obj:
                out[field] = _text(obj[field], f"{path}.{field}", 10000, required=False)
        if "missing" in obj:
            missing = _obj(obj["missing"], f"{path}.missing")
            out["missing"] = {
                "hours": number(missing, "hours", f"{path}.missing", 0),
                "longestGapHours": number(missing, "longestGapHours", f"{path}.missing", 0),
                "startMissing": flag(missing, "startMissing", f"{path}.missing"),
            }
        settings["weatherSeries"] = out
    return settings


def validate(body: dict[str, Any]) -> dict[str, Any]:
    horizon = _int(body.get("horizon_minutes"), "horizon_minutes", 1, MAX_HORIZON_MINUTES)
    raw = body.get("ignitions")
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_IGNITIONS:
        raise ApiError(400, CODE, f"`ignitions` must be a list of 1 to {MAX_IGNITIONS} items.")
    ignitions, seen = [], set()
    for i, item in enumerate(raw):
        item = _obj(item, f"ignitions[{i}]")
        ign_id = _text(item.get("id"), f"ignitions[{i}].id", 40)
        if ign_id in seen:
            raise ApiError(400, CODE, f"Duplicate ignition id `{ign_id}`.")
        seen.add(ign_id)
        start = _int(item.get("start_minute"), f"ignitions[{i}].start_minute", 0, horizon)
        # Minute (same Studio clock) the fire is reported to dispatch, set by the user; null or
        # absent = not set, and Live models its own report delay.
        report = item.get("report_minute")
        if report is not None:
            report = _int(report, f"ignitions[{i}].report_minute", start, MAX_HORIZON_MINUTES)
        ignitions.append(
            {
                "id": ign_id,
                "name": _text(item.get("name", ign_id), f"ignitions[{i}].name", 80),
                "lon": _num(item.get("lon"), f"ignitions[{i}].lon", -180, 180),
                "lat": _num(item.get("lat"), f"ignitions[{i}].lat", -90, 90),
                "start_minute": start,
                "report_minute": report,
            }
        )
    wind_in = _obj(body.get("wind"), "wind")
    wind = {
        # A native series' peak-hour summary can exceed the constant-wind slider's 60 mph.
        "speed_mph": _num(wind_in.get("speed_mph"), "wind.speed_mph", 0, MAX_SERIES_WIND_MPH),
        "from_deg": _num(wind_in.get("from_deg"), "wind.from_deg", 0, 360),
        "source": _text(wind_in.get("source"), "wind.source", 40),
        "label": _text(wind_in.get("label"), "wind.label", LABEL_MAX_CHARS, required=False),
    }
    moist_in = _obj(body.get("moisture"), "moisture")
    values = _moisture_values(moist_in.get("values"), "moisture.values")
    box = body.get("landscape_box")
    if box is not None:
        box = _obj(box, "landscape_box")
        box = {k: _num(box.get(k), f"landscape_box.{k}", -20_037_509, 20_037_509)
               for k in ("minX", "minY", "maxX", "maxY")}
        if box["minX"] >= box["maxX"] or box["minY"] >= box["maxY"]:
            raise ApiError(400, CODE, "`landscape_box` must have positive width and height.")
    return {
        "scenario_id": _text(body.get("scenario_id"), "scenario_id", 80),
        "name": _text(body.get("name"), "name", 80),
        "region_id": _text(body.get("region_id"), "region_id", 80),
        "ignitions": ignitions,
        "wind": wind,
        "moisture": {
            "preset": _text(moist_in.get("preset"), "moisture.preset", 40),
            "label": _text(moist_in.get("label"), "moisture.label", LABEL_MAX_CHARS, required=False),
            "values": values,
        },
        "horizon_minutes": horizon,
        "fire_settings": _fire_settings(body.get("fire_settings"), horizon),
        "landscape_box": box,
        "weather_series": _weather_series(body.get("weather_series")),
    }


def outside_drill(incident_id: str, ignitions: list[dict[str, Any]]) -> list[str]:
    """Ids of ignitions more than 3 km outside the bounding box of the drill's zones."""
    zones = get_index(incident_id).drill.zones
    pts = [pt for z in zones for polygon in z.geometry for ring in polygon for pt in ring]
    if not pts:
        return [i["id"] for i in ignitions]
    west, east = min(p[0] for p in pts), max(p[0] for p in pts)
    south, north = min(p[1] for p in pts), max(p[1] for p in pts)
    far = []
    for ign in ignitions:
        dx = max(west - ign["lon"], 0.0, ign["lon"] - east) * 111_320 * math.cos(math.radians(ign["lat"]))
        dy = max(south - ign["lat"], 0.0, ign["lat"] - north) * 110_574
        if math.hypot(dx, dy) > OUTSIDE_DRILL_KM * 1000:
            far.append(ign["id"])
    return far


def _collection():
    global _index_ready
    fires = col(COLLECTION)
    if not _index_ready:
        # Best effort: the index only speeds the listing. A write-blocked cluster (e.g. Atlas over
        # its storage quota) must not take the read-only feed down with it; retried next call.
        try:
            fires.create_index([("incident_id", 1), ("published_at", DESCENDING)])
            _index_ready = True
        except PyMongoError:
            pass
    return fires


@live_view(["POST"], roles={"controller"})
def publish(request, principal: Principal):
    fields = validate(json_body(request, CODE))
    incident_id = incidents.active_incident_id()
    published_at = wall_now()
    doc = {
        "fire_id": "sf_" + secrets.token_hex(6),
        "incident_id": incident_id,
        "published_at": published_at,
        **fields,
        "outside_drill": outside_drill(incident_id, fields["ignitions"]),
        "evidence_class": "simulated",
    }
    fires = _collection()
    fires.insert_one(doc)
    cleared = _replace_previous_run(incident_id, doc["fire_id"], published_at)
    return ok(
        {
            "fire_id": doc["fire_id"],
            "incident_id": incident_id,
            "incident_name": incidents.active_json()["name"],
            "published_at": iso(published_at),
            "outside_drill": doc["outside_drill"],
            "cleared": cleared,
        },
        status=201,
    )


def _replace_previous_run(incident_id: str, fire_id: str, now: datetime) -> dict[str, Any]:
    """A new Studio run is the incident's drill from now on: clear what the previous run left.

    Deletes the older publishes, the board's run state and household states (``run_state.forget``,
    which also resets the single-writer lease, so the new board's console takes over), withdraws
    the previous board run's resident guidance at once (new ``live_guidance`` versions with level
    ``none``; history is kept) and reopens the controller's road closures. The audit log
    (``live_decisions``) is kept for the AAR. Best effort per step: a failed step is logged and
    reported as null, the publish itself stands. Returns the count per step."""
    cleared: dict[str, Any] = {}
    try:
        cleared["publishes"] = _collection().delete_many(
            {"incident_id": incident_id, "fire_id": {"$ne": fire_id}}).deleted_count
    except PyMongoError:
        log.warning("studio fires: cannot delete older publishes of %s", incident_id)
        cleared["publishes"] = None
    try:
        run_state.forget(incident_id)
        cleared["run_state"] = True
    except PyMongoError:
        log.warning("studio fires: cannot clear the run state of %s", incident_id)
        cleared["run_state"] = None
    try:
        cleared["guidance_withdrawn"] = board_guidance.withdraw_board(incident_id, f"studio-{fire_id}", now)
    except Exception:  # noqa: BLE001 - guidance must never fail the publish; logged
        log.exception("studio fires: withdrawing board guidance failed for %s", incident_id)
        cleared["guidance_withdrawn"] = None
    try:
        cleared["road_closures"] = road_closures.clear(incident_id)
    except PyMongoError:
        log.warning("studio fires: cannot clear road closures of %s", incident_id)
        cleared["road_closures"] = None
    return cleared


def _fire_json(doc: dict[str, Any]) -> dict[str, Any]:
    return {
        "fire_id": doc["fire_id"],
        "published_at": iso(doc["published_at"]),
        "incident_id": doc["incident_id"],
        "name": doc["name"],
        "scenario_id": doc["scenario_id"],
        "region_id": doc["region_id"],
        # Fires stored before `report_minute` existed read back as not set (null).
        "ignitions": [{**ign, "report_minute": ign.get("report_minute")} for ign in doc["ignitions"]],
        "wind": doc["wind"],
        "moisture": doc["moisture"],
        "horizon_minutes": doc["horizon_minutes"],
        "fire_settings": doc.get("fire_settings"),
        "landscape_box": doc.get("landscape_box"),
        "outside_drill": doc.get("outside_drill", []),
        # Absent on fires published before the field existed, and on runs with one constant wind.
        "weather_series": doc.get("weather_series"),
    }


@live_view(["GET", "DELETE"])
def list_fires(request, incident_id: str, principal: Principal):
    if request.method == "DELETE":
        # Controller "Reset board": clear this incident's published Studio fires so no console
        # (or a reload) starts them again.
        if principal.role != "controller":
            raise ApiError(403, "forbidden", "Only the controller can clear Studio fires.")
        try:
            deleted = _collection().delete_many({"incident_id": incident_id}).deleted_count
        except PyMongoError as exc:
            raise ApiError(503, "unavailable", "The fire feed is unavailable.") from exc
        return ok({"deleted": deleted})
    query: dict[str, Any] = {"incident_id": incident_id}
    after = request.query_params.get("after")
    if after:
        query["published_at"] = {"$gt": parse_iso(after, "after", "invalid_request")}
    try:
        docs = list(_collection().find(query, {"_id": 0}).sort("published_at", DESCENDING).limit(LIST_LIMIT))
    except PyMongoError as exc:
        raise ApiError(503, "unavailable", "The fire feed is unavailable.") from exc
    return ok({"fires": [_fire_json(d) for d in docs], "evidence_class": "simulated"})
