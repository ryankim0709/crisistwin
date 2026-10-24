"""Simulation state API: the Studio's evacuation run, read back as advice per home.

Simulation Studio publishes a run (zones and synthetic homes) to MongoDB, then pushes the
state at each playback tick. The iOS app reads per-home advice: leave now, leave later, left,
no order, cut off. Wire contract, limits and documents: docs/sim-state-api.md.

POST sim-state/runs                  publish a run; it becomes the latest -> 201 {run_id}
POST sim-state/runs/<run_id>/tick    state at one simulation minute        -> 200 {run_id, minute, changed_zones}
GET  sim-state/latest                latest run, current minute, zone state (no homes)
GET  sim-state/advice                ?lon=&lat= (nearest home within 300 m) or ?home_id=
GET  sim-state/homes                 ?q=&limit= address search in the latest run

Everything is simulated: homes and addresses are synthetic and the advice is a planning
experiment, so every read carries `evidence_class: "simulated"` and a `notice`. Collections
`sim_runs` and `sim_homes`; only the 3 newest runs are kept. `changed_zones` is the number of
zones whose (advice, order_minute, departed) differed from the stored state and whose homes
were rewritten. The body is read from the stream (not `request.body`), so Django's
DATA_UPLOAD_MAX_MEMORY_SIZE does not apply; the 8 MB limit is enforced here.
"""

import json
import math
import re
import threading
import uuid
from datetime import UTC, datetime

from pymongo import ASCENDING, DESCENDING, GEOSPHERE
from pymongo.errors import PyMongoError
from rest_framework.decorators import (
    api_view,
    authentication_classes,
    permission_classes,
    throttle_classes,
)
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle

from .live_broadcast import _number as _is_number
from .mongodb import get_database

RUNS = "sim_runs"
HOMES = "sim_homes"
EVIDENCE_CLASS = "simulated"
NOTICE = (
    "Simulated evacuation (planning exercise). Homes and addresses are synthetic. "
    "This is not an evacuation order."
)

MAX_BODY_BYTES = 8 * 1024 * 1024
MAX_ZONES = 500
MAX_HOMES = 25_000
MAX_LABEL = 120
MAX_TEXT = 200
MAX_ADDRESS = 120
KEEP_RUNS = 3
INSERT_CHUNK = 1000
NEAR_RADIUS_M = 300
EARTH_RADIUS_M = 6_371_008.8
DEFAULT_LIMIT = 20
MAX_LIMIT = 50
MAX_QUERY = 100
ADVICE = ("leave_now", "leave_later", "no_order", "cut_off", "cleared", "overrun")
ZONE_ID = re.compile(r"[A-Za-z0-9_:-]{1,64}")


class SimPublishThrottle(AnonRateThrottle):
    scope = "sim_state_publish"
    rate = "10/min"


class SimTickThrottle(AnonRateThrottle):
    scope = "sim_state_tick"
    rate = "120/min"


class SimReadThrottle(AnonRateThrottle):
    scope = "sim_state_read"
    rate = "240/min"


class Invalid(ValueError):
    """A request that fails validation; the message is safe to return."""


def _error(status: int, code: str, detail: str) -> Response:
    return Response({"error": code, "detail": detail}, status=status, headers={"Cache-Control": "no-store"})


def _ok(body: dict, status: int = 200) -> Response:
    return Response(body, status=status, headers={"Cache-Control": "no-store"})


def _unavailable() -> Response:
    return _error(503, "database_unavailable", "The simulation store is unavailable.")


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# --- storage -----------------------------------------------------------------------------

_indexes_lock = threading.Lock()
_indexes_ready = False


def ensure_indexes(db) -> None:
    """Create the indexes once per process (idempotent in MongoDB)."""
    global _indexes_ready
    if _indexes_ready:
        return
    with _indexes_lock:
        if _indexes_ready:
            return
        db[RUNS].create_index([("published_at", DESCENDING)])
        db[HOMES].create_index([("run_id", ASCENDING), ("home_id", ASCENDING)], unique=True)
        db[HOMES].create_index([("run_id", ASCENDING), ("zone_id", ASCENDING), ("rank", ASCENDING)])
        db[HOMES].create_index([("location", GEOSPHERE)])
        db[HOMES].create_index([("run_id", ASCENDING), ("address_lc", ASCENDING)])
        _indexes_ready = True


def _database():
    db = get_database()
    ensure_indexes(db)
    return db


def _latest_run(db) -> dict | None:
    return db[RUNS].find_one({}, sort=[("published_at", DESCENDING)])


# --- validation --------------------------------------------------------------------------


def _reject_constant(name: str):
    raise Invalid("Body must be valid JSON without NaN or Infinity.")


def _parse_body(request) -> dict:
    """The JSON object in the request body, reading at most MAX_BODY_BYTES."""
    try:
        length = int(request.META.get("CONTENT_LENGTH") or 0)
    except ValueError:
        raise Invalid("Invalid Content-Length.") from None
    if length > MAX_BODY_BYTES:
        raise Invalid(f"Body must be at most {MAX_BODY_BYTES // (1024 * 1024)} MB.")
    stream = request.stream
    raw = stream.read(MAX_BODY_BYTES + 1) if stream is not None else b""
    if len(raw) > MAX_BODY_BYTES:
        raise Invalid(f"Body must be at most {MAX_BODY_BYTES // (1024 * 1024)} MB.")
    try:
        body = json.loads(raw, parse_constant=_reject_constant)
    except (ValueError, RecursionError):
        raise Invalid("Body must be a JSON object.") from None
    if not isinstance(body, dict):
        raise Invalid("Body must be a JSON object.")
    return body


def _int(value: object, name: str, low: int, high: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
        raise Invalid(f"`{name}` must be an integer from {low} to {high}.")
    return value


def _text(value: object, name: str, limit: int = MAX_TEXT) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise Invalid(f"`{name}` must be a non-empty string of at most {limit} characters.")
    return value


def _coord(value: object, name: str) -> list[float]:
    if (
        not isinstance(value, list | tuple)
        or len(value) != 2
        or not all(_is_number(v) for v in value)
        or not -180 <= value[0] <= 180
        or not -90 <= value[1] <= 90
    ):
        raise Invalid(f"`{name}` must be [lon, lat] in decimal degrees, finite and in range.")
    return [float(value[0]), float(value[1])]


def _object(value: object, name: str) -> dict:
    if not isinstance(value, dict):
        raise Invalid(f"`{name}` must be an object.")
    return value


def _list(value: object, name: str, maximum: int) -> list:
    if not isinstance(value, list) or not value:
        raise Invalid(f"`{name}` must be a non-empty array.")
    if len(value) > maximum:
        raise Invalid(f"`{name}` must have at most {maximum} entries.")
    return value


def validate_run(body: dict) -> dict:
    """Return the clean run (label, area, horizon, order, zones, homes) or raise Invalid."""
    label = _text(body.get("label"), "label", MAX_LABEL)
    area_in = _object(body.get("area"), "area")
    bbox = area_in.get("bbox")
    if not isinstance(bbox, list) or len(bbox) != 4 or not all(_is_number(v) for v in bbox):
        raise Invalid("`area.bbox` must be [west, south, east, north].")
    west, south, east, north = (float(v) for v in bbox)
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise Invalid("`area.bbox` must be [west, south, east, north] in range with west < east, south < north.")
    area = {"id": _text(area_in.get("id"), "area.id", 120), "name": _text(area_in.get("name"), "area.name", 120),
            "bbox": [west, south, east, north]}
    horizon = _int(body.get("horizon_minutes"), "horizon_minutes", 1, 1_000_000)
    order_minute = _int(body.get("order_minute"), "order_minute", 0, horizon)

    zones, ranks = [], {}
    for i, z in enumerate(_list(body.get("zones"), "zones", MAX_ZONES)):
        z = _object(z, f"zones[{i}]")
        zone_id = z.get("zone_id")
        if not isinstance(zone_id, str) or not ZONE_ID.fullmatch(zone_id):
            raise Invalid(f"`zones[{i}].zone_id` must be 1-64 letters, digits, `_`, `-` or `:`.")
        if zone_id in ranks:
            raise Invalid(f"Duplicate zone_id {zone_id!r}.")
        ranks[zone_id] = set()
        zones.append({
            "zone_id": zone_id,
            "name": _text(z.get("name"), f"zones[{i}].name", 120),
            "centroid": _coord(z.get("centroid"), f"zones[{i}].centroid"),
            "homes": _int(z.get("homes"), f"zones[{i}].homes", 0, MAX_HOMES),
        })

    homes, seen = [], set()
    for i, h in enumerate(_list(body.get("homes"), "homes", MAX_HOMES)):
        h = _object(h, f"homes[{i}]")
        home_id = _text(h.get("home_id"), f"homes[{i}].home_id", 64)
        if home_id in seen:
            raise Invalid(f"Duplicate home_id {home_id!r}.")
        seen.add(home_id)
        zone_id = h.get("zone_id")
        if not isinstance(zone_id, str) or zone_id not in ranks:
            raise Invalid(f"`homes[{i}].zone_id` must be a listed zone.")
        rank = _int(h.get("rank"), f"homes[{i}].rank", 0, MAX_HOMES)
        if rank in ranks[zone_id]:
            raise Invalid(f"Duplicate rank {rank} in zone {zone_id!r}.")
        ranks[zone_id].add(rank)
        homes.append({"home_id": home_id, "zone_id": zone_id, "rank": rank,
                      "coord": _coord(h.get("coord"), f"homes[{i}].coord"),
                      "address": _text(h.get("address"), f"homes[{i}].address", MAX_ADDRESS)})
    for z in zones:
        if ranks[z["zone_id"]] != set(range(z["homes"])):
            raise Invalid(f"Zone {z['zone_id']!r} must have ranks 0..{z['homes'] - 1} exactly once each.")
    return {"label": label, "area": area, "horizon_minutes": horizon, "order_minute": order_minute,
            "zones": zones, "homes": homes}


def validate_tick(body: dict, run: dict) -> tuple[int, list[dict]]:
    """Return (minute, zone states) for a tick against the stored run, or raise Invalid."""
    minute = _int(body.get("minute"), "minute", 0, run["horizon_minutes"])
    known = {z["zone_id"]: z for z in run["zones"]}
    states, seen = [], set()
    raw = body.get("zones")
    if not isinstance(raw, list) or len(raw) > MAX_ZONES:
        raise Invalid(f"`zones` must be an array of at most {MAX_ZONES} entries.")
    for i, z in enumerate(raw):
        z = _object(z, f"zones[{i}]")
        zone_id = z.get("zone_id")
        if not isinstance(zone_id, str) or zone_id not in known:
            raise Invalid(f"`zones[{i}].zone_id` must be a zone of this run.")
        if zone_id in seen:
            raise Invalid(f"Duplicate zone_id {zone_id!r}.")
        seen.add(zone_id)
        if z.get("advice") not in ADVICE:
            raise Invalid(f"`zones[{i}].advice` must be one of {', '.join(ADVICE)}.")
        homes = known[zone_id]["homes"]
        order = z.get("order_minute")
        exit_id = z.get("exit_id")
        states.append({
            "zone_id": zone_id,
            "advice": z["advice"],
            "order_minute": None if order is None else _int(order, f"zones[{i}].order_minute", 0, 1_000_000),
            "departed": _int(z.get("departed"), f"zones[{i}].departed", 0, homes),
            "at_home": _int(z.get("at_home"), f"zones[{i}].at_home", 0, homes),
            "exit_id": None if exit_id is None else _text(exit_id, f"zones[{i}].exit_id", 64),
        })
    return minute, states


# --- views -------------------------------------------------------------------------------


def _prune(db) -> None:
    """Keep the KEEP_RUNS newest runs; delete older runs and their homes."""
    old = list(db[RUNS].find({}, sort=[("published_at", DESCENDING)]).skip(KEEP_RUNS))
    ids = [r["run_id"] for r in old]
    if ids:
        db[HOMES].delete_many({"run_id": {"$in": ids}})
        db[RUNS].delete_many({"run_id": {"$in": ids}})


@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([SimPublishThrottle])
def publish_run(request):
    try:
        run = validate_run(_parse_body(request))
    except Invalid as exc:
        return _error(400, "invalid_run", str(exc))
    run_id = uuid.uuid4().hex
    docs = [
        {
            "run_id": run_id, "home_id": h["home_id"], "zone_id": h["zone_id"], "rank": h["rank"],
            "address": h["address"], "address_lc": h["address"].lower(),
            "location": {"type": "Point", "coordinates": h["coord"]},
            "advice": "unknown", "order_minute": None, "exit_id": None,
        }
        for h in run["homes"]
    ]
    try:
        db = _database()
        try:
            for start in range(0, len(docs), INSERT_CHUNK):
                db[HOMES].insert_many(docs[start:start + INSERT_CHUNK], ordered=False)
            db[RUNS].insert_one({
                "run_id": run_id, "label": run["label"], "area": run["area"],
                "horizon_minutes": run["horizon_minutes"], "order_minute": run["order_minute"],
                "zones": run["zones"], "home_count": len(docs), "published_at": _now(),
                "state": {"minute": None, "updated_at": None, "zones": {}},
                "evidence_class": EVIDENCE_CLASS,
            })
        except PyMongoError:
            try:
                db[HOMES].delete_many({"run_id": run_id})
            except PyMongoError:
                pass
            raise
        _prune(db)
    except PyMongoError:
        return _unavailable()
    return _ok({"run_id": run_id}, status=201)


@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([SimTickThrottle])
def tick_run(request, run_id: str):
    try:
        body = _parse_body(request)
    except Invalid as exc:
        return _error(400, "invalid_tick", str(exc))
    try:
        db = _database()
        run = db[RUNS].find_one({"run_id": run_id})
        if run is None:
            return _error(404, "unknown_run", "No such simulation run.")
        try:
            minute, states = validate_tick(body, run)
        except Invalid as exc:
            return _error(400, "invalid_tick", str(exc))
        stored = run.get("state", {}).get("zones", {})
        changed = 0
        for z in states:
            before = stored.get(z["zone_id"])
            key = (z["advice"], z["order_minute"], z["departed"])
            if before and (before.get("advice"), before.get("order_minute"), before.get("departed")) == key:
                continue
            changed += 1
            fields = {"order_minute": z["order_minute"], "exit_id": z["exit_id"]}
            zone_advice = "left" if z["advice"] == "cleared" else z["advice"]
            where = {"run_id": run_id, "zone_id": z["zone_id"]}
            db[HOMES].update_many({**where, "rank": {"$lt": z["departed"]}}, {"$set": {"advice": "left", **fields}})
            db[HOMES].update_many({**where, "rank": {"$gte": z["departed"]}}, {"$set": {"advice": zone_advice, **fields}})
        update = {"state.minute": minute, "state.updated_at": _now()}
        for z in states:
            update[f"state.zones.{z['zone_id']}"] = {k: z[k] for k in ("advice", "order_minute", "departed", "at_home", "exit_id")}
        db[RUNS].update_one({"run_id": run_id}, {"$set": update})
    except PyMongoError:
        return _unavailable()
    return _ok({"run_id": run_id, "minute": minute, "changed_zones": changed})


def _zone_state(run: dict, zone: dict) -> dict:
    s = run.get("state", {}).get("zones", {}).get(zone["zone_id"])
    return {
        "zone_id": zone["zone_id"], "name": zone["name"], "centroid": zone["centroid"], "homes": zone["homes"],
        "advice": s["advice"] if s else "unknown",
        "order_minute": s["order_minute"] if s else None,
        "departed": s["departed"] if s else 0,
        "at_home": s["at_home"] if s else zone["homes"],
        "exit_id": s["exit_id"] if s else None,
    }


def _envelope(run: dict) -> dict:
    state = run.get("state", {})
    return {"evidence_class": EVIDENCE_CLASS, "notice": NOTICE,
            "minute": state.get("minute"), "updated_at": _iso(state.get("updated_at"))}


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([SimReadThrottle])
def latest(request):
    try:
        run = _latest_run(_database())
    except PyMongoError:
        return _unavailable()
    if run is None:
        return _error(404, "no_simulation", "No simulation has been published.")
    body = _envelope(run)
    return _ok({
        "evidence_class": body["evidence_class"], "notice": body["notice"],
        "run": {"run_id": run["run_id"], "label": run["label"], "area": run["area"],
                "published_at": _iso(run["published_at"]), "horizon_minutes": run["horizon_minutes"],
                "order_minute": run["order_minute"], "zone_count": len(run["zones"]),
                "home_count": run["home_count"]},
        "minute": body["minute"], "updated_at": body["updated_at"],
        "zones": [_zone_state(run, z) for z in run["zones"]],
    })


def haversine_m(a: list[float], b: list[float]) -> float:
    """Great-circle distance in metres between two [lon, lat] points."""
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def _home_view(run: dict, home: dict, distance_m: float | None = None) -> dict:
    zone = next((z for z in run["zones"] if z["zone_id"] == home["zone_id"]), None)
    view = {"home_id": home["home_id"], "address": home["address"],
            "coord": list(home["location"]["coordinates"]), "zone_id": home["zone_id"],
            "zone_name": zone["name"] if zone else None}
    if distance_m is not None:
        view["distance_m"] = round(distance_m, 1)
    return view


def _query_float(params, name: str, low: float, high: float) -> float:
    try:
        value = float(params.get(name, ""))
    except ValueError:
        raise Invalid(f"`{name}` must be a number.") from None
    if not math.isfinite(value) or not low <= value <= high:
        raise Invalid(f"`{name}` must be a number from {low:g} to {high:g}.")
    return value


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([SimReadThrottle])
def advice(request):
    params = request.query_params
    try:
        by_id = "home_id" in params
        if by_id == ("lon" in params or "lat" in params):
            raise Invalid("Send either `home_id` or both `lon` and `lat`.")
        if by_id:
            home_id = params["home_id"]
            if not home_id or len(home_id) > 64:
                raise Invalid("`home_id` must be 1-64 characters.")
        else:
            lon = _query_float(params, "lon", -180, 180)
            lat = _query_float(params, "lat", -90, 90)
    except Invalid as exc:
        return _error(400, "invalid_query", str(exc))
    try:
        db = _database()
        run = _latest_run(db)
        if run is None:
            return _error(404, "no_simulation", "No simulation has been published.")
        if by_id:
            home = db[HOMES].find_one({"run_id": run["run_id"], "home_id": home_id})
            if home is None:
                return _error(404, "unknown_home", "No such home in the latest simulation.")
            distance = None
        else:
            near = {"$nearSphere": {"$geometry": {"type": "Point", "coordinates": [lon, lat]},
                                    "$maxDistance": NEAR_RADIUS_M}}
            home = next(iter(db[HOMES].find({"run_id": run["run_id"], "location": near}).limit(1)), None)
            if home is None:
                return _error(404, "no_home_nearby", f"No simulated home within {NEAR_RADIUS_M} m.")
            distance = haversine_m([lon, lat], home["location"]["coordinates"])
    except PyMongoError:
        return _unavailable()
    env = _envelope(run)
    minute = env["minute"]
    order = home.get("order_minute")
    return _ok({
        **{k: env[k] for k in ("evidence_class", "notice")},
        "run": {"run_id": run["run_id"], "label": run["label"], "published_at": _iso(run["published_at"]),
                "horizon_minutes": run["horizon_minutes"]},
        "minute": minute, "updated_at": env["updated_at"],
        "home": _home_view(run, home, distance),
        "advice": home.get("advice", "unknown"),
        "order_minute": order,
        "minutes_until_order": order - minute if order is not None and minute is not None and order - minute > 0 else None,
        "exit_id": home.get("exit_id"),
    })


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([SimReadThrottle])
def homes(request):
    params = request.query_params
    q = params.get("q", "").strip().lower()
    try:
        if len(q) < 2 or len(q) > MAX_QUERY:
            raise Invalid(f"`q` must be 2-{MAX_QUERY} characters.")
        limit = DEFAULT_LIMIT
        if "limit" in params:
            raw = params["limit"]
            if not raw.isascii() or not raw.isdigit() or not 1 <= int(raw) <= MAX_LIMIT:
                raise Invalid(f"`limit` must be an integer from 1 to {MAX_LIMIT}.")
            limit = int(raw)
    except Invalid as exc:
        return _error(400, "invalid_query", str(exc))
    try:
        db = _database()
        run = _latest_run(db)
        if run is None:
            return _error(404, "no_simulation", "No simulation has been published.")
        found = list(
            db[HOMES].find({"run_id": run["run_id"], "address_lc": {"$regex": re.escape(q)}})
            .sort([("address_lc", ASCENDING), ("home_id", ASCENDING)]).limit(limit)
        )
    except PyMongoError:
        return _unavailable()
    env = _envelope(run)
    return _ok({
        **{k: env[k] for k in ("evidence_class", "notice")},
        "homes": [
            {**_home_view(run, h), "advice": h.get("advice", "unknown"),
             "order_minute": h.get("order_minute"), "exit_id": h.get("exit_id")}
            for h in found
        ],
    })
