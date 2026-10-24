"""Open live feeds: poll, store, and report status. Adapters live in `intel_feeds.py`.

POST /api/intel/feeds/<feed>/poll   -> {feed, status, fetched_at, created, updated, unchanged, ...}
GET  /api/intel/feeds               -> {feeds: [{feed, label, status, last_poll_at, counts, ...}]}

Auth is the same as the rest of /api/intel (open, throttled; the demo has no sign-in).
Polling is idempotent: a candidate's id derives from the source's own record id, so a re-poll
updates the candidate while it is still `unconfirmed` and only counts the sighting once a
planner has reviewed it. Nothing here ever sets `confirmed`.
"""

import re
import zlib
from datetime import UTC, datetime

from django.conf import settings
from pymongo.errors import DuplicateKeyError, PyMongoError
from rest_framework.decorators import (
    api_view,
    authentication_classes,
    permission_classes,
    throttle_classes,
)
from rest_framework.permissions import AllowAny
from rest_framework.throttling import AnonRateThrottle

from . import intel_feeds as feeds
from .intel import (
    MAX_SMALL_BODY_BYTES,
    SLUG,
    IntelThrottle,
    _db_error,
    _error,
    _now,
    _ok,
    _read_json,
)
from .mongodb import get_database

CANDIDATES = "intel_candidates"
FEED_STATE = "intel_feeds"
FEED_RAW = "intel_feed_raw"
DEFAULT_INCIDENT = "live-feeds"
POLL_KEYS = {"incident", "bbox", "districts", "area"}
AREA = re.compile(r"^[A-Z]{2}$")
# Fields a re-poll may refresh on an unconfirmed candidate. Review fields and created_at are never in it.
SOURCE_FIELDS = (
    "incident",
    "type",
    "feed",
    "source_key",
    "occurred_at",
    "occurred_from",
    "occurred_to",
    "time_precision",
    "time_role",
    "observation_window_min",
    "available_at",
    "available_at_status",
    "available_at_reason",
    "local_time_as_written",
    "target",
    "geometry",
    "geocode_method",
    "description",
    "quote",
    "action_status",
    "source_time_method",
    "source_number",
    "evidence_class",
    "source_id",
    "source_url",
    "source_locator",
    "document_id",
    "mode",
    "extraction",
    "fetched_at",
    "source_updated_at",
    "details",
)


class IntelFeedPollThrottle(AnonRateThrottle):
    """Each poll is a request to a free public service."""

    scope = "intel_feed_poll"
    rate = "12/min"


def default_districts() -> list[int]:
    raw = getattr(settings, "INTEL_FEEDS_CALTRANS_DISTRICTS", "3")
    return [int(p) for p in str(raw).split(",") if p.strip().isdigit() and int(p) in feeds.CALTRANS_DISTRICTS] or [3]


def validate_poll(feed: str, data: object) -> tuple[dict | None, str | None]:
    """Validated poll options, or (None, problem)."""
    if data is None:
        data = {}
    if not isinstance(data, dict):
        return None, "Body must be a JSON object."
    unknown = set(data) - POLL_KEYS
    if unknown:
        return None, f"Unknown keys: {', '.join(sorted(unknown))}."
    incident = data.get("incident", DEFAULT_INCIDENT)
    if not isinstance(incident, str) or not SLUG.match(incident):
        return None, "`incident` must be a lowercase slug."
    bbox = None
    if data.get("bbox") is not None:
        bbox = feeds.parse_bbox(data["bbox"])
        if bbox is None:
            return None, "`bbox` must be [west, south, east, north] in degrees."
    districts = data.get("districts")
    if districts is None:
        districts = default_districts()
    elif (
        not isinstance(districts, list)
        or not 1 <= len(districts) <= 4
        or not all(isinstance(d, int) and not isinstance(d, bool) and d in feeds.CALTRANS_DISTRICTS for d in districts)
    ):
        return None, "`districts` must be 1 to 4 Caltrans district numbers (1-12)."
    area = data.get("area", getattr(settings, "INTEL_FEEDS_NWS_AREA", "CA"))
    if not isinstance(area, str) or not AREA.match(area):
        return None, "`area` must be a two-letter state code."
    if feed in (feeds.WFIGS,) and bbox is None:
        return None, "WFIGS needs a `bbox`; the national layer is too large to poll unbounded."
    return {"incident": incident, "bbox": bbox, "districts": sorted(set(districts)), "area": area}, None


def _store_raw(feed: str, url: str, body: bytes, status: int, fetched_at: str) -> dict:
    """Cache the raw response compressed, once per distinct body (size and sha256 kept)."""
    record = feeds.raw_record(feed, url, body, status, fetched_at)
    stored = zlib.compress(body, 6)
    get_database()[FEED_RAW].update_one(
        {"_id": record["_id"]},
        {
            "$setOnInsert": {**{k: v for k, v in record.items() if k != "_id"}, "encoding": "zlib", "body": stored,
                             "stored_bytes": len(stored), "first_fetched_at": fetched_at},
            "$set": {"last_fetched_at": fetched_at},
            "$inc": {"seen_count": 1},
        },
        upsert=True,
    )
    return {k: record[k] for k in ("_id", "url", "size", "sha256", "http_status")}


def _store_candidates(candidates: list[dict], now: str) -> dict:
    collection = get_database()[CANDIDATES]
    created = updated = unchanged = 0
    for candidate in candidates:
        fields = {k: candidate[k] for k in SOURCE_FIELDS}
        document = {
            "_id": candidate["event_id"],
            "event_id": candidate["event_id"],
            **fields,
            "review_status": "unconfirmed",
            "reviewer": None,
            "reviewer_note": None,
            "reviewed_at": None,
            "mapping": None,
            "flags": [],
            "created_at": now,
            "last_seen_at": now,
            "seen_count": 1,
        }
        try:
            collection.insert_one(document)
            created += 1
            continue
        except DuplicateKeyError:
            pass
        # Reviewed candidates keep everything a planner saw; only the sighting is recorded.
        result = collection.update_one(
            {"_id": candidate["event_id"], "review_status": "unconfirmed"},
            {"$set": {**fields, "last_seen_at": now}, "$inc": {"seen_count": 1}},
        )
        if result.matched_count:
            updated += 1
        else:
            collection.update_one(
                {"_id": candidate["event_id"]}, {"$set": {"last_seen_at": now}, "$inc": {"seen_count": 1}}
            )
            unchanged += 1
    return {"created": created, "updated": updated, "unchanged": unchanged}


def _gather(feed: str, options: dict, fetched_at: str) -> tuple[list[dict], dict, list[dict]]:
    """Fetch and parse one feed -> (candidates, stats, raw cache entries). Raises FeedError."""
    incident, bbox = options["incident"], options["bbox"]
    raws: list[dict] = []
    candidates: list[dict] = []
    stats: dict = {}
    if feed == feeds.NWS:
        url = feeds.nws_url(bbox, options["area"])
        body, status = feeds.fetch(url, "application/geo+json")
        raw = _store_raw(feed, url, body, status, fetched_at)
        raws.append(raw)
        candidates, stats = feeds.parse_nws(
            feeds.load_json(body), incident=incident, raw=raw, url=url, fetched_at=fetched_at
        )
    elif feed == feeds.CALTRANS:
        for district in options["districts"]:
            url = feeds.caltrans_url(district)
            body, status = feeds.fetch(url)
            raw = _store_raw(feed, url, body, status, fetched_at)
            raws.append(raw)
            found, part = feeds.parse_caltrans(
                feeds.load_json(body), incident=incident, raw=raw, url=url, fetched_at=fetched_at, bbox=bbox
            )
            candidates += found
            for key, value in part.items():
                stats[key] = stats.get(key, 0) + value
    else:
        incidents_url = feeds.wfigs_query_url(feeds.WFIGS_INCIDENTS_URL, bbox, feeds.WFIGS_INCIDENT_FIELDS)
        perimeters_url = feeds.wfigs_query_url(
            feeds.WFIGS_PERIMETERS_URL, bbox, feeds.WFIGS_PERIMETER_FIELDS, {"maxAllowableOffset": "0.0001"}
        )
        incidents_body, status = feeds.fetch(incidents_url, "application/geo+json")
        raw = _store_raw(feed, incidents_url, incidents_body, status, fetched_at)
        perimeters_body, p_status = feeds.fetch(perimeters_url, "application/geo+json")
        raws += [raw, _store_raw(feed, perimeters_url, perimeters_body, p_status, fetched_at)]
        candidates, stats = feeds.parse_wfigs(
            feeds.load_json(incidents_body),
            feeds.load_json(perimeters_body),
            incident=incident,
            raw=raw,
            url=incidents_url,
            fetched_at=fetched_at,
            bbox=bbox,
        )
    return candidates, stats, raws


def _seconds_since(stamp: str | None) -> float | None:
    if not stamp:
        return None
    return (datetime.now(UTC) - datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)).total_seconds()


def poll_feed(feed: str, options: dict) -> tuple[int, dict]:
    """Poll one feed now. Returns (http_status, body). Used by the view and the management command."""
    meta = feeds.FEEDS[feed]
    try:
        state = get_database()[FEED_STATE].find_one({"_id": feed}) or {}
    except PyMongoError:
        return 503, {"error": "database_unavailable", "detail": "The incident intelligence store is unavailable."}
    age = _seconds_since(state.get("last_success_at"))
    if age is not None and age < meta["min_interval_s"]:
        wait = int(meta["min_interval_s"] - age) + 1
        return 429, {
            "error": "polled_recently",
            "detail": f"{meta['label']} was polled {int(age)} s ago; try again in {wait} s.",
            "retry_after_s": wait,
        }
    fetched_at = _now()
    try:
        candidates, stats, raws = _gather(feed, options, fetched_at)
        counts = _store_candidates(candidates, fetched_at)
    except feeds.FeedError as failure:
        _save_state(feed, options, fetched_at, ok=False, error={"code": failure.code, "detail": failure.detail})
        return failure.status, {"error": failure.code, "detail": failure.detail}
    except PyMongoError:
        return 503, {"error": "database_unavailable", "detail": "The incident intelligence store is unavailable."}
    summary = {"candidates": len(candidates), **counts, "stats": stats}
    _save_state(feed, options, fetched_at, ok=True, summary=summary)
    return 200, {
        "feed": feed,
        "status": "ok",
        "incident": options["incident"],
        "fetched_at": fetched_at,
        **summary,
        "raw": [{k: v for k, v in r.items() if k != "_id"} | {"id": r["_id"]} for r in raws],
    }


def _save_state(feed: str, options: dict, at: str, *, ok: bool, summary: dict | None = None, error: dict | None = None):
    update: dict = {
        "last_poll_at": at,
        "status": "ok" if ok else "error",
        "error": error,
        "incident": options["incident"],
        "bbox": options["bbox"],
    }
    if ok:
        update.update(last_success_at=at, last_summary=summary)
    try:
        get_database()[FEED_STATE].update_one({"_id": feed}, {"$set": update}, upsert=True)
    except PyMongoError:
        pass


@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([IntelFeedPollThrottle])
def intel_feed_poll(request, feed: str):
    """Planner action: fetch one open feed now and upsert its candidates (all `unconfirmed`)."""
    if feed not in feeds.FEEDS:
        return _error(404, "not_found", f"Unknown feed; use one of {sorted(feeds.FEEDS)}.")
    if request.body:
        data, failure = _read_json(request, MAX_SMALL_BODY_BYTES)
        if failure:
            return failure
    else:
        data = {}
    options, problem = validate_poll(feed, data)
    if problem:
        return _error(400, "invalid_request", problem)
    status, body = poll_feed(feed, options)
    return _ok(body, status)


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([IntelThrottle])
def intel_feeds(request):
    """Each feed's last poll, status and candidate counts by review status."""
    incident = request.query_params.get("incident")
    if incident is not None and not SLUG.match(incident):
        return _error(400, "invalid_request", "`incident` must be a lowercase slug.")
    match: dict = {"feed": {"$in": list(feeds.FEEDS)}}
    if incident:
        match["incident"] = incident
    try:
        db = get_database()
        states = {s["_id"]: s for s in db[FEED_STATE].find({})}
        grouped = db[CANDIDATES].aggregate(
            [{"$match": match}, {"$group": {"_id": {"feed": "$feed", "status": "$review_status"}, "n": {"$sum": 1}}}]
        )
        counts: dict[str, dict[str, int]] = {}
        for row in grouped:
            counts.setdefault(row["_id"]["feed"], {})[row["_id"]["status"]] = row["n"]
    except PyMongoError:
        return _db_error()
    rows = []
    for feed, meta in feeds.FEEDS.items():
        state = states.get(feed) or {}
        by_status = counts.get(feed, {})
        rows.append(
            {
                "feed": feed,
                "label": meta["label"],
                "source_id": meta["source_id"],
                "type": meta["type"],
                "min_interval_s": meta["min_interval_s"],
                "status": state.get("status", "never"),
                "last_poll_at": state.get("last_poll_at"),
                "last_success_at": state.get("last_success_at"),
                "error": state.get("error"),
                "last_summary": state.get("last_summary"),
                "counts": {
                    "unconfirmed": by_status.get("unconfirmed", 0),
                    "confirmed": by_status.get("confirmed", 0),
                    "rejected": by_status.get("rejected", 0),
                },
            }
        )
    return _ok({"feeds": rows})
