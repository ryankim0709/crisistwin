"""Incident intelligence: public pages -> source documents -> Claude candidates -> planner review.

Contract: docs/incident-intel.md (sections (b) and (c)); decision: ADR 0018. Every extracted
record is `evidence_class: "reported"` and starts `review_status: "unconfirmed"`; only
POST /api/intel/candidates/<event_id>/review changes the status. Page text and model output
are untrusted data. Coordinates come only from a planner's mapping. APIFY_TOKEN,
APIFY_ACTOR_ID and ANTHROPIC_API_KEY are read from the server environment only.

POST /api/intel/runs                               -> 202 {run_id, dataset_id, status, ...}
POST /api/intel/ingest                             -> {incident, stored, duplicates, rejected, document_ids}
GET  /api/intel/documents?incident=                -> {documents}
POST /api/intel/documents/<document_id>/extract    -> {document_id, model, extracted_at, candidates, dropped}
GET  /api/intel/candidates?incident=&status=&types=&as_of=&bbox=  -> {candidates, count, as_of}
POST /api/intel/candidates/<event_id>/review       -> the updated candidate
"""

import hashlib
import ipaddress
import json
import math
import os
import re
from datetime import UTC, datetime
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import anthropic
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError, PyMongoError
from rest_framework.decorators import (
    api_view,
    authentication_classes,
    permission_classes,
    throttle_classes,
)
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle

from . import intel_apify
from .intel_feeds import FEED_TYPES
from .explain import MODEL, SET_KEY_HELP, UPSTREAM_MAX_RETRIES, UPSTREAM_TIMEOUT_S, answer_text
from .intel_extract import (
    INTEL_TYPES,
    MAX_CONFIRMED_CONTEXT,
    OUTPUT_SCHEMA,
    ROAD_INTEL_TYPES,
    SYSTEM_PROMPT,
    build_candidates,
    build_user_message,
    validate_model_output,
)
from .mongodb import get_database

RUNS = "intel_runs"
DOCUMENTS = "intel_documents"
CANDIDATES = "intel_candidates"

MAX_OUTPUT_TOKENS = 16000
MAX_RUN_BYTES = 32_000
MAX_INGEST_BYTES = 2_000_000
MAX_INGEST_ITEMS = 200
MAX_SMALL_BODY_BYTES = 32_000
MAX_LIST = 500
MAX_TEXT_CHARS = 50_000
EXCERPT_CHARS = 300
DEFAULT_TIME_ZONE = "America/Los_Angeles"

SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$")
UTC_TIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
APIFY_ID = re.compile(r"^[A-Za-z0-9]{1,64}$")
TIME_ZONE = re.compile(r"^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$")
EDGE_ID = re.compile(r"^osm-way:\d+:\d+(:[fr])?$")
WAYBACK_PREFIX = "https://web.archive.org/web/"
BLOCKED_HOST_SUFFIXES = (".localhost", ".local", ".internal", ".lan", ".arpa", ".onion")

MODES = {"live", "archive"}
SOURCE_KINDS = {"agency", "road_status", "shelter", "news", "other"}
REVIEW_STATUSES = {"unconfirmed", "confirmed", "rejected"}
ACTOR_INPUT_KEYS = {"mode", "sources", "window", "max_documents", "max_captures_per_source"}
ITEM_KEYS = {
    "kind",
    "schema_version",
    "source_id",
    "source_kind",
    "mode",
    "url",
    "original_url",
    "fetched_at",
    "archived_at",
    "http_status",
    "content_type",
    "sha256",
    "title",
    "text",
    "text_truncated",
    "language",
    "wayback_digest",
}
DOCUMENT_FIELDS = (
    "document_id",
    "incident",
    "source_id",
    "source_kind",
    "mode",
    "url",
    "original_url",
    "title",
    "fetched_at",
    "archived_at",
    "sha256",
    "text_chars",
    "excerpt",
    "extracted_at",
    "candidate_count",
)
MAPPING_KEYS = {"road_name", "point", "radius_m", "edge_ids"}
MAX_EDGE_IDS = 500


class IntelRunsThrottle(AnonRateThrottle):
    """Each run is paid Apify usage."""

    scope = "intel_runs"
    rate = "5/min"


class IntelExtractThrottle(AnonRateThrottle):
    """Each extraction is a paid model call."""

    scope = "intel_extract"
    rate = "10/min"


class IntelThrottle(AnonRateThrottle):
    scope = "intel"
    rate = "60/min"


def _error(status: int, code: str, detail: str) -> Response:
    return Response(
        {"error": code, "detail": detail}, status=status, headers={"Cache-Control": "no-store"}
    )


def _ok(data: dict, status: int = 200) -> Response:
    return Response(data, status=status, headers={"Cache-Control": "no-store"})


def _db_error() -> Response:
    return _error(503, "database_unavailable", "The incident intelligence store is unavailable.")


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _read_json(request, limit: int) -> tuple[object, Response | None]:
    if len(request.body) > limit:
        return None, _error(413, "too_large", f"Request body exceeds {limit} bytes.")
    try:
        return json.loads(request.body), None
    except (ValueError, UnicodeDecodeError):
        return None, _error(400, "invalid_request", "Body must be valid JSON.")


def _number(value: object) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value)


def _integer(value: object, low: int, high: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and low <= value <= high


def _lonlat(value: object) -> bool:
    return (
        isinstance(value, list)
        and len(value) == 2
        and _number(value[0])
        and _number(value[1])
        and -180 <= value[0] <= 180
        and -90 <= value[1] <= 90
    )


def _utc(value: object) -> bool:
    if not isinstance(value, str) or not UTC_TIME.match(value):
        return False
    try:
        datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return False
    return True


def _optional_text(value: object, limit: int) -> bool:
    return value is None or (isinstance(value, str) and len(value) <= limit)


def _http_url(value: object) -> bool:
    if not isinstance(value, str) or len(value) > 2000:
        return False
    try:
        parts = urlsplit(value)
    except ValueError:
        return False
    return parts.scheme in ("http", "https") and bool(parts.hostname)


def _public_source_url(value: object) -> bool:
    """http(s) URL on a public DNS name: no credentials, IP literals, local names or odd ports."""
    if not _http_url(value):
        return False
    parts = urlsplit(value)
    try:
        port = parts.port
    except ValueError:
        return False
    host = (parts.hostname or "").rstrip(".").lower()
    if parts.username or parts.password or port not in (None, 80, 443):
        return False
    try:
        ipaddress.ip_address(host.strip("[]"))
        return False
    except ValueError:
        pass
    return "." in host and host != "localhost" and not host.endswith(BLOCKED_HOST_SUFFIXES)


def validate_time_zone(value: object) -> str | None:
    if not isinstance(value, str) or len(value) > 64 or not TIME_ZONE.match(value):
        return "`time_zone` must be an IANA time zone name."
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError):
        return f"Unknown time zone {value!r}."
    return None


def _incident_and_zone(data: dict) -> tuple[str, str] | str:
    incident = data.get("incident")
    if not isinstance(incident, str) or not SLUG.match(incident):
        return "`incident` must be a lowercase slug."
    time_zone = data.get("time_zone", DEFAULT_TIME_ZONE)
    problem = validate_time_zone(time_zone)
    return problem if problem else (incident, time_zone)


def validate_actor_input(data: object) -> str | None:
    """Actor input per contract (a). Source URLs must be public http(s) hosts."""
    if not isinstance(data, dict):
        return "`input` must be an object."
    unknown = set(data) - ACTOR_INPUT_KEYS
    if unknown:
        return f"Unknown input keys: {', '.join(sorted(unknown))}."
    mode = data.get("mode")
    if mode not in MODES:
        return "`input.mode` must be `live` or `archive`."
    sources = data.get("sources")
    if not isinstance(sources, list) or not 1 <= len(sources) <= 20:
        return "`input.sources` must be a list of 1 to 20 sources."
    ids = set()
    for index, source in enumerate(sources):
        if not isinstance(source, dict) or set(source) != {"id", "url", "kind"}:
            return f"`input.sources[{index}]` must be {{id, url, kind}}."
        if not isinstance(source["id"], str) or not SLUG.match(source["id"]) or source["id"] in ids:
            return f"`input.sources[{index}].id` must be a unique lowercase slug."
        ids.add(source["id"])
        if not _public_source_url(source["url"]):
            return f"`input.sources[{index}].url` must be a public http(s) URL of at most 2000 characters."
        if source["kind"] not in SOURCE_KINDS:
            return f"`input.sources[{index}].kind` must be one of {sorted(SOURCE_KINDS)}."
    window = data.get("window")
    if mode == "archive" or window is not None:
        if not isinstance(window, dict) or set(window) != {"from", "to"}:
            return "`input.window` must be {from, to} (required in archive mode)."
        if not _utc(window["from"]) or not _utc(window["to"]) or window["from"] >= window["to"]:
            return "`input.window` must be UTC 'YYYY-MM-DDTHH:MM:SSZ' times with from < to."
    if "max_documents" in data and not _integer(data["max_documents"], 1, 200):
        return "`input.max_documents` must be an integer from 1 to 200."
    if "max_captures_per_source" in data and not _integer(data["max_captures_per_source"], 1, 50):
        return "`input.max_captures_per_source` must be an integer from 1 to 50."
    return None


def validate_item(item: object) -> str | None:
    """One Actor dataset item per contract (a); `sha256` is recomputed from `text`."""
    if not isinstance(item, dict):
        return "item must be an object"
    unknown = set(item) - ITEM_KEYS
    if unknown:
        return f"unknown keys {sorted(unknown)}"
    missing = ITEM_KEYS - set(item)
    if missing:
        return f"missing keys {sorted(missing)}"
    if item["kind"] != "crisistwin_intel_document" or item["schema_version"] != "1.0.0":
        return "kind/schema_version must be crisistwin_intel_document 1.0.0"
    if not isinstance(item["source_id"], str) or not SLUG.match(item["source_id"]):
        return "source_id must be a lowercase slug"
    if item["source_kind"] not in SOURCE_KINDS:
        return "source_kind is not allowed"
    mode = item["mode"]
    if mode not in MODES:
        return "mode must be live or archive"
    if not _http_url(item["url"]) or not _http_url(item["original_url"]):
        return "url and original_url must be http(s) URLs of at most 2000 characters"
    if not _utc(item["fetched_at"]):
        return "fetched_at must be UTC 'YYYY-MM-DDTHH:MM:SSZ'"
    if mode == "archive":
        if not _utc(item["archived_at"]):
            return "archived_at must be UTC 'YYYY-MM-DDTHH:MM:SSZ' in archive mode"
        if not item["url"].startswith(WAYBACK_PREFIX):
            return f"archive url must start with {WAYBACK_PREFIX}"
        if not isinstance(item["wayback_digest"], str) or not 1 <= len(item["wayback_digest"]) <= 64:
            return "wayback_digest must be a string in archive mode"
    elif item["archived_at"] is not None or item["wayback_digest"] is not None:
        return "archived_at and wayback_digest must be null in live mode"
    if not _integer(item["http_status"], 200, 299):
        return "http_status must be 2xx"
    content_type = item["content_type"]
    if not isinstance(content_type, str) or not content_type.startswith(("text/html", "text/plain")):
        return "content_type must be text/html or text/plain"
    if not _optional_text(item["title"], 300) or not _optional_text(item["language"], 35):
        return "title (<= 300) and language (<= 35) must be strings or null"
    text = item["text"]
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_CHARS:
        return f"text must be a nonempty string of at most {MAX_TEXT_CHARS} characters"
    if not isinstance(item["text_truncated"], bool):
        return "text_truncated must be a boolean"
    if not isinstance(item["sha256"], str) or not SHA256.match(item["sha256"]):
        return "sha256 must be 64 lowercase hex characters"
    if hashlib.sha256(text.encode("utf-8")).hexdigest() != item["sha256"]:
        return "sha256 does not match text"
    return None


def _document(item: dict, incident: str, time_zone: str, run_id: str | None, now: str) -> dict:
    document_id = "doc-" + item["sha256"][:16]
    archived_at = item["archived_at"]
    return {
        "_id": document_id,
        "document_id": document_id,
        "incident": incident,
        "time_zone": time_zone,
        "source_id": item["source_id"],
        "source_kind": item["source_kind"],
        "mode": item["mode"],
        "url": item["url"],
        "original_url": item["original_url"],
        "fetched_at": item["fetched_at"],
        "archived_at": archived_at,
        "available_at": archived_at if item["mode"] == "archive" else item["fetched_at"],
        "http_status": item["http_status"],
        "content_type": item["content_type"],
        "sha256": item["sha256"],
        "title": item["title"],
        "text": item["text"],
        "text_truncated": item["text_truncated"],
        "language": item["language"],
        "wayback_digest": item["wayback_digest"],
        "text_chars": len(item["text"]),
        "excerpt": item["text"][:EXCERPT_CHARS],
        "seen_count": 1,
        "run_id": run_id,
        "ingested_at": now,
        "extracted_at": None,
        "candidate_count": 0,
    }


def _store_documents(documents: list[dict]) -> tuple[int, int]:
    """Insert new documents; for known ones keep the earliest capture/fetch and count the sighting."""
    collection = get_database()[DOCUMENTS]
    stored = duplicates = 0
    for doc in documents:
        try:
            collection.insert_one(dict(doc))
            stored += 1
            continue
        except DuplicateKeyError:
            duplicates += 1
        existing = collection.find_one(
            {"_id": doc["_id"]}, {"mode": 1, "archived_at": 1, "fetched_at": 1}
        ) or {}
        updates = {}
        if doc["fetched_at"] < (existing.get("fetched_at") or "~"):
            updates["fetched_at"] = doc["fetched_at"]
            if existing.get("mode") == "live":
                updates["available_at"] = doc["fetched_at"]
        if (
            existing.get("mode") == "archive"
            and doc["mode"] == "archive"
            and doc["archived_at"] < (existing.get("archived_at") or "~")
        ):
            # The earlier capture becomes the provenance, so the locator stays consistent.
            updates.update(
                archived_at=doc["archived_at"],
                available_at=doc["archived_at"],
                url=doc["url"],
                wayback_digest=doc["wayback_digest"],
            )
        change = {"$inc": {"seen_count": 1}}
        if updates:
            change["$set"] = updates
        collection.update_one({"_id": doc["_id"]}, change)
    return stored, duplicates


@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([IntelRunsThrottle])
def intel_runs(request):
    """Start the incident-intel Actor on Apify (paid). Local demo endpoint: anonymous, throttled."""
    data, failure = _read_json(request, MAX_RUN_BYTES)
    if failure:
        return failure
    if not isinstance(data, dict) or set(data) - {"incident", "time_zone", "input"} or "input" not in data:
        return _error(400, "invalid_request", "Body must be {incident, time_zone?, input}.")
    checked = _incident_and_zone(data)
    if isinstance(checked, str):
        return _error(400, "invalid_request", checked)
    incident, time_zone = checked
    problem = validate_actor_input(data["input"])
    if problem:
        return _error(400, "invalid_request", problem)
    try:
        run = intel_apify.start_run(data["input"])
    except intel_apify.ApifyUnavailable as exc:
        return _error(503, "apify_unavailable", str(exc))
    except intel_apify.ApifyError as exc:
        return _error(502, "apify_error", str(exc))
    started_at = run["started_at"] or _now()
    try:
        get_database()[RUNS].replace_one(
            {"_id": run["run_id"]},
            {
                "_id": run["run_id"],
                "incident": incident,
                "time_zone": time_zone,
                "dataset_id": run["dataset_id"],
                "status": run["status"],
                "started_at": started_at,
                "input": data["input"],
                "created_at": _now(),
            },
            upsert=True,
        )
    except (PyMongoError, ValueError):
        return _error(
            503,
            "database_unavailable",
            f"Apify run {run['run_id']} started but could not be recorded; ingest it by run_id later.",
        )
    return _ok(
        {
            "run_id": run["run_id"],
            "dataset_id": run["dataset_id"],
            "status": run["status"],
            "incident": incident,
            "started_at": started_at,
        },
        status=202,
    )


@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([IntelThrottle])
def intel_ingest(request):
    """Store Actor output (by run/dataset id, or uploaded `items`) as documents. No extraction."""
    data, failure = _read_json(request, MAX_INGEST_BYTES)
    if failure:
        return failure
    allowed = {"incident", "time_zone", "run_id", "dataset_id", "items", "latest_run"}
    if not isinstance(data, dict) or set(data) - allowed:
        return _error(400, "invalid_request", f"Body keys must be among {sorted(allowed)}.")
    checked = _incident_and_zone(data)
    if isinstance(checked, str):
        return _error(400, "invalid_request", checked)
    incident, time_zone = checked
    given = [key for key in ("run_id", "dataset_id", "items", "latest_run") if key in data]
    if len(given) != 1:
        return _error(400, "invalid_request", "Give exactly one of `run_id`, `dataset_id`, `items` or `latest_run`.")
    run_id = data.get("run_id")
    latest = False
    if "latest_run" in data:
        if data["latest_run"] is not True:
            return _error(400, "invalid_request", "`latest_run` must be true.")
        latest = True
        try:
            found = intel_apify.latest_succeeded_run()
        except intel_apify.ApifyUnavailable as exc:
            return _error(503, "apify_unavailable", str(exc))
        except intel_apify.ApifyError as exc:
            return _error(502, "apify_error", str(exc))
        if found is None:
            return _error(404, "not_found", "The Actor has no SUCCEEDED run yet.")
        run_id = found["run_id"]
        if not APIFY_ID.match(str(run_id)):
            return _error(502, "apify_error", "Apify returned an unexpected run id.")
        try:
            seen = get_database()[RUNS].find_one({"_id": run_id}, {"ingested_at": 1})
        except (PyMongoError, ValueError):
            return _db_error()
        if seen and seen.get("ingested_at"):
            return _ok(
                {
                    "incident": incident,
                    "run_id": run_id,
                    "already_ingested": True,
                    "stored": 0,
                    "duplicates": 0,
                    "rejected": [],
                    "document_ids": [],
                }
            )
    if run_id is not None and "time_zone" not in data:
        # A run's stored zone and incident govern its documents unless the body overrides the zone.
        try:
            stored_run = get_database()[RUNS].find_one({"_id": run_id}, {"incident": 1, "time_zone": 1})
        except (PyMongoError, ValueError):
            return _db_error()
        if stored_run is not None:
            if stored_run.get("incident") != incident:
                return _error(400, "invalid_request", "`incident` differs from the stored run's incident.")
            time_zone = stored_run.get("time_zone") or time_zone

    if "items" in data:
        items = data["items"]
        if not isinstance(items, list) or len(items) > MAX_INGEST_ITEMS:
            return _error(400, "invalid_request", f"`items` must be a list of at most {MAX_INGEST_ITEMS}.")
    else:
        apify_id = run_id if latest else data[given[0]]
        if not isinstance(apify_id, str) or not APIFY_ID.match(apify_id):
            return _error(400, "invalid_request", f"`{given[0]}` must be an Apify id.")
        try:
            dataset_id = found["dataset_id"] if latest else (
                data.get("dataset_id") or intel_apify.run_dataset(apify_id)
            )
            items = intel_apify.dataset_items(dataset_id, limit=MAX_INGEST_ITEMS)
        except intel_apify.ApifyUnavailable as exc:
            return _error(503, "apify_unavailable", str(exc))
        except intel_apify.RunNotFinished as exc:
            return _error(409, "run_not_finished", f"The Apify run is {exc.status}, not SUCCEEDED.")
        except intel_apify.RunNotFound:
            return _error(404, "not_found", "No Apify run with that id.")
        except intel_apify.ApifyError as exc:
            return _error(502, "apify_error", str(exc))

    now = _now()
    rejected, documents = [], []
    for index, item in enumerate(items):
        problem = validate_item(item)
        if problem:
            rejected.append({"index": index, "reason": problem})
        else:
            documents.append(_document(item, incident, time_zone, run_id, now))
    try:
        stored, duplicates = _store_documents(documents)
        if latest:
            get_database()[RUNS].update_one(
                {"_id": run_id},
                {
                    "$set": {"ingested_at": now, "ingested_incident": incident},
                    "$setOnInsert": {
                        "incident": incident,
                        "time_zone": time_zone,
                        "dataset_id": found["dataset_id"],
                        "status": "SUCCEEDED",
                        "started_at": None,
                        "created_at": now,
                    },
                },
                upsert=True,
            )
    except (PyMongoError, ValueError):
        return _db_error()
    return _ok(
        {
            "incident": incident,
            **({"run_id": run_id, "already_ingested": False} if latest else {}),
            "stored": stored,
            "duplicates": duplicates,
            "rejected": rejected,
            "document_ids": list(dict.fromkeys(doc["document_id"] for doc in documents)),
        }
    )


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([IntelThrottle])
def intel_documents(request):
    """Stored source documents of an incident (no full text), oldest capture first."""
    incident = request.query_params.get("incident", "")
    if not SLUG.match(incident):
        return _error(400, "invalid_request", "`incident` must be a lowercase slug.")
    try:
        cursor = (
            get_database()[DOCUMENTS]
            .find({"incident": incident}, {"text": 0})
            .sort([("available_at", 1), ("_id", 1)])
            .limit(MAX_LIST)
        )
        documents = [{key: doc.get(key) for key in DOCUMENT_FIELDS} for doc in cursor]
    except (PyMongoError, ValueError):
        return _db_error()
    return _ok({"documents": documents})


@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([IntelExtractThrottle])
def intel_document_extract(request, document_id: str):
    """Planner-triggered, paid: extract candidate events from one document with Claude."""
    if len(request.body) > MAX_SMALL_BODY_BYTES:
        return _error(413, "too_large", f"Request body exceeds {MAX_SMALL_BODY_BYTES} bytes.")
    if request.body.strip():
        try:
            body = json.loads(request.body)
        except (ValueError, UnicodeDecodeError):
            body = None
        if body != {}:
            return _error(400, "invalid_request", "Body must be `{}`.")
    try:
        db = get_database()
        document = db[DOCUMENTS].find_one({"_id": document_id})
        if document is None:
            return _error(404, "not_found", "No document with that id.")
        confirmed = list(
            db[CANDIDATES]
            .find(
                {"incident": document["incident"], "review_status": "confirmed"},
                {"_id": 0, "event_id": 1, "type": 1, "target": 1, "occurred_at": 1},
            )
            .sort([("occurred_at", 1), ("_id", 1)])
            .limit(MAX_CONFIRMED_CONTEXT)
        )
    except (PyMongoError, ValueError):
        return _db_error()
    time_zone = document.get("time_zone") or DEFAULT_TIME_ZONE

    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        return _error(
            503, "ai_unavailable", f"AI extraction is not configured on the server. {SET_KEY_HELP}"
        )

    client = anthropic.Anthropic(
        api_key=api_key, timeout=UPSTREAM_TIMEOUT_S, max_retries=UPSTREAM_MAX_RETRIES
    )
    try:
        # Structured output constrains the shape; validate_model_output still checks every field.
        # Server-side fallback reroutes a safety-classifier refusal to another model.
        message = client.beta.messages.create(
            model=MODEL,
            max_tokens=MAX_OUTPUT_TOKENS,
            system=SYSTEM_PROMPT,
            thinking={"type": "adaptive"},
            output_config={
                "effort": "medium",
                "format": {"type": "json_schema", "schema": OUTPUT_SCHEMA},
            },
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            messages=[
                {
                    "role": "user",
                    "content": build_user_message(
                        document, document["incident"], time_zone, confirmed
                    ),
                }
            ],
        )
    except anthropic.APITimeoutError:
        return _error(504, "upstream_timeout", "The AI provider did not respond in time. Try again.")
    except anthropic.AuthenticationError:
        return _error(503, "ai_unavailable", f"The AI provider rejected the API key. {SET_KEY_HELP}")
    except anthropic.RateLimitError:
        return _error(429, "upstream_rate_limited", "The AI provider is rate limiting. Try again shortly.")
    except anthropic.APIStatusError as exc:
        return _error(502, "upstream_error", f"The AI provider returned HTTP {exc.status_code}.")
    except anthropic.APIConnectionError:
        return _error(502, "upstream_unreachable", "Could not reach the AI provider.")

    if message.stop_reason == "refusal":
        return _error(502, "upstream_refusal", "The model declined to extract from this document.")
    raw = answer_text(message)
    if not raw:
        return _error(502, "upstream_empty", "The model returned no text.")
    if message.stop_reason == "max_tokens":
        return _error(502, "extraction_invalid", "The model output was cut off at the length limit.")
    events = validate_model_output(raw)
    if isinstance(events, str):
        return _error(502, "extraction_invalid", events)

    extracted_at = _now()
    candidates, dropped = build_candidates(
        document,
        events,
        time_zone,
        model=message.model,
        extracted_at=extracted_at,
        confirmed_ids={c["event_id"] for c in confirmed},
    )
    dropped_indexes = {d["index"] for d in dropped}
    kept_indexes = [i for i in range(len(events)) if i not in dropped_indexes]
    try:
        collection = db[CANDIDATES]
        # Replace only still-unconfirmed candidates; reviewed ones are never overwritten.
        collection.delete_many({"document_id": document_id, "review_status": "unconfirmed"})
        reviewed = {
            doc["_id"]
            for doc in collection.find(
                {"_id": {"$in": [c["event_id"] for c in candidates]}}, {"_id": 1}
            )
        }
        fresh = []
        for index, candidate in zip(kept_indexes, candidates, strict=True):
            if candidate["event_id"] in reviewed:
                dropped.append({"index": index, "reason": "already_reviewed"})
            else:
                fresh.append(candidate)
        if fresh:
            collection.insert_many([{"_id": c["event_id"], **c} for c in fresh])
        db[DOCUMENTS].update_one(
            {"_id": document_id},
            {
                "$set": {
                    "extracted_at": extracted_at,
                    "candidate_count": collection.count_documents({"document_id": document_id}),
                }
            },
        )
    except (PyMongoError, ValueError):
        return _db_error()
    dropped.sort(key=lambda d: d["index"])
    return _ok(
        {
            "document_id": document_id,
            "model": message.model,
            "extracted_at": extracted_at,
            "candidates": fresh,
            "dropped": dropped,
        }
    )


def _comma_list(value: str, allowed) -> list[str] | None:
    items = [part.strip() for part in value.split(",") if part.strip()]
    return items if items and all(item in allowed for item in items) else None


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([IntelThrottle])
def intel_candidates(request):
    """Candidates filtered by incident, status, types, as_of (available_at) and mapped-point bbox."""
    params = request.query_params
    query: dict = {}
    incident = params.get("incident")
    if incident is not None:
        if not SLUG.match(incident):
            return _error(400, "invalid_request", "`incident` must be a lowercase slug.")
        query["incident"] = incident
    if "status" in params:
        statuses = _comma_list(params["status"], REVIEW_STATUSES)
        if statuses is None:
            return _error(400, "invalid_request", f"`status` must be a comma list of {sorted(REVIEW_STATUSES)}.")
        query["review_status"] = {"$in": statuses}
    if "types" in params:
        types = _comma_list(params["types"], INTEL_TYPES + FEED_TYPES)
        if types is None:
            return _error(400, "invalid_request", "`types` must be a comma list of intel event types.")
        query["type"] = {"$in": types}
    as_of = params.get("as_of")
    if as_of is not None:
        if not _utc(as_of):
            return _error(400, "invalid_request", "`as_of` must be UTC 'YYYY-MM-DDTHH:MM:SSZ'.")
        query["available_at"] = {"$lte": as_of}
    if "bbox" in params:
        try:
            west, south, east, north = (float(v) for v in params["bbox"].split(","))
        except ValueError:
            return _error(400, "invalid_request", "`bbox` must be west,south,east,north.")
        box = [west, south, east, north]
        if not all(math.isfinite(v) for v in box) or not (
            -180 <= west <= east <= 180 and -90 <= south <= north <= 90
        ):
            return _error(400, "invalid_request", "`bbox` must be west,south,east,north in degrees.")
        query["mapping.point.0"] = {"$gte": west, "$lte": east}
        query["mapping.point.1"] = {"$gte": south, "$lte": north}
    elif incident is None:
        return _error(400, "invalid_request", "Give `incident` or `bbox`.")
    try:
        candidates = list(
            get_database()[CANDIDATES]
            .find(query, {"_id": 0})
            .sort([("available_at", 1), ("occurred_at", 1), ("event_id", 1)])
            .limit(MAX_LIST)
        )
    except (PyMongoError, ValueError):
        return _db_error()
    return _ok({"candidates": candidates, "count": len(candidates), "as_of": as_of})


def validate_mapping(mapping: object) -> str | None:
    if not isinstance(mapping, dict):
        return "`mapping` must be null or an object."
    unknown = set(mapping) - MAPPING_KEYS
    if unknown:
        return f"Unknown mapping keys: {', '.join(sorted(unknown))}."
    if not _lonlat(mapping.get("point")):
        return "`mapping.point` must be a finite [longitude, latitude]."
    road_name = mapping.get("road_name")
    if road_name is not None and (not isinstance(road_name, str) or not 1 <= len(road_name.strip()) <= 200):
        return "`mapping.road_name` must be null or 1-200 characters."
    radius = mapping.get("radius_m", 75)
    if not _number(radius) or not 25 <= radius <= 500:
        return "`mapping.radius_m` must be 25 to 500 metres."
    edge_ids = mapping.get("edge_ids")
    if edge_ids is not None and (
        not isinstance(edge_ids, list)
        or len(edge_ids) > MAX_EDGE_IDS
        or not all(isinstance(e, str) and EDGE_ID.match(e) for e in edge_ids)
    ):
        return f"`mapping.edge_ids` must be null or at most {MAX_EDGE_IDS} 'osm-way:<way>:<segment>[:f|r]' ids."
    return None


def validate_review(data: object) -> str | None:
    if not isinstance(data, dict) or "review_status" not in data:
        return "Body must include `review_status`."
    unknown = set(data) - {"review_status", "reviewer", "reviewer_note", "mapping"}
    if unknown:
        return f"Unknown keys: {', '.join(sorted(unknown))}."
    if data["review_status"] not in REVIEW_STATUSES:
        return f"`review_status` must be one of {sorted(REVIEW_STATUSES)}."
    if not _optional_text(data.get("reviewer"), 80):
        return "`reviewer` must be null or at most 80 characters."
    if not _optional_text(data.get("reviewer_note"), 600):
        return "`reviewer_note` must be null or at most 600 characters."
    if data.get("mapping") is not None:
        return validate_mapping(data["mapping"])
    return None


def _stripped(value: str | None) -> str | None:
    return (value.strip() or None) if isinstance(value, str) else None


@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([IntelThrottle])
def intel_candidate_review(request, event_id: str):
    """The planner gate: confirm (with a mapping for road types), reject or reset a candidate."""
    data, failure = _read_json(request, MAX_SMALL_BODY_BYTES)
    if failure:
        return failure
    problem = validate_review(data)
    if problem:
        return _error(400, "invalid_request", problem)
    try:
        collection = get_database()[CANDIDATES]
        candidate = collection.find_one({"_id": event_id}, {"type": 1, "target": 1, "feed": 1})
    except (PyMongoError, ValueError):
        return _db_error()
    if candidate is None:
        return _error(404, "not_found", "No candidate with that id.")

    raw_mapping = data.get("mapping")
    status = data["review_status"]
    if status == "confirmed" and candidate["type"] in ROAD_INTEL_TYPES and raw_mapping is None:
        return _error(400, "invalid_request", "Confirming a road event requires `mapping.point`.")
    mapping = None
    if raw_mapping is not None:
        point = [float(raw_mapping["point"][0]), float(raw_mapping["point"][1])]
        road_name = _stripped(raw_mapping.get("road_name")) or (candidate.get("target") or {}).get("road_name")
        if status == "confirmed" and candidate["type"] in ROAD_INTEL_TYPES and not road_name:
            return _error(400, "invalid_request", "Confirming a road event requires a road name.")
        mapping = {
            "road_name": road_name,
            "point": point,
            "radius_m": raw_mapping.get("radius_m", 75),
            "edge_ids": raw_mapping.get("edge_ids"),
        }
    changes = {
        "review_status": status,
        "reviewer": _stripped(data.get("reviewer")),
        "reviewer_note": _stripped(data.get("reviewer_note")),
        "reviewed_at": _now(),
    }
    # A feed candidate's geometry comes from its source; review without a mapping must not erase it.
    if mapping or not candidate.get("feed"):
        changes.update(
            mapping=mapping,
            geometry={"type": "Point", "coordinates": mapping["point"]} if mapping else None,
            geocode_method="planner_mapped" if mapping else "unresolved",
        )
    try:
        updated = collection.find_one_and_update(
            {"_id": event_id},
            {"$set": changes},
            projection={"_id": 0},
            return_document=ReturnDocument.AFTER,
        )
    except (PyMongoError, ValueError):
        return _db_error()
    if updated is None:
        return _error(404, "not_found", "No candidate with that id.")
    return _ok(updated)
