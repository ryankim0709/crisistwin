"""Open live feeds as incident-intelligence candidates: NWS alerts, Caltrans LCS, WFIGS fires.

Contract: docs/incident-intel.md ("Live feeds"); decision: docs/adr/0032-open-live-feeds.md.
This module is pure adapters: it fetches (stdlib `urllib` only) and turns a response body
into candidate documents. It never touches the database and never sets `confirmed`; storage
and the HTTP views live in `intel_feeds_api.py`. Every candidate is `evidence_class:
"reported"`, `review_status: "unconfirmed"`, carries the source URL and the fetch time.
Feed content is untrusted data, never instructions.

Units: UTC `YYYY-MM-DDTHH:MM:SSZ`; WGS84 [longitude, latitude]; acres as published.
"""

import hashlib
import json
import math
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime
from typing import Any

from django.conf import settings

FEED_TYPES = ("weather_alert", "road_closure", "fire_incident")

NWS = "nws"
CALTRANS = "caltrans"
WFIGS = "wfigs"
FEEDS: dict[str, dict[str, Any]] = {
    NWS: {
        "label": "NWS alerts",
        "source_id": "nws-alerts",
        "type": "weather_alert",
        # Floors keep a "Poll now" button from hammering a free public service.
        "min_interval_s": 60,
    },
    CALTRANS: {
        "label": "Caltrans lane closures",
        "source_id": "caltrans-lcs",
        "type": "road_closure",
        "min_interval_s": 300,  # the files refresh every five minutes
    },
    WFIGS: {
        "label": "WFIGS fire incidents",
        "source_id": "wfigs-incidents",
        "type": "fire_incident",
        "min_interval_s": 300,
    },
}

NWS_ALERTS_URL = "https://api.weather.gov/alerts/active"
CALTRANS_LCS_URL = "https://cwwp2.dot.ca.gov/data/d{district}/lcs/lcsStatusD{district:02d}.json"
WFIGS_BASE = "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services"
WFIGS_INCIDENTS_URL = f"{WFIGS_BASE}/WFIGS_Incident_Locations_Current/FeatureServer/0/query"
WFIGS_PERIMETERS_URL = f"{WFIGS_BASE}/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query"

NWS_EVENTS = ("Red Flag Warning", "Fire Weather Watch")
WFIGS_CATEGORIES = ("WF", "CX")  # wildfire and complex; prescribed fire (RX) is not an incident
CALTRANS_DISTRICTS = tuple(range(1, 13))

FETCH_TIMEOUT_S = 20
MAX_RESPONSE_BYTES = 8_000_000
MAX_CANDIDATES = 500
MAX_TEXT = 400
LOS_ANGELES = "America/Los_Angeles"


class FeedError(Exception):
    """A feed could not be fetched or parsed; `code` and `detail` go to the client as-is."""

    def __init__(self, code: str, detail: str, status: int = 503):
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.status = status


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _iso(epoch_s: float) -> str:
    return datetime.fromtimestamp(epoch_s, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _iso_ms(epoch_ms: object) -> str | None:
    if isinstance(epoch_ms, bool) or not isinstance(epoch_ms, (int, float)) or not math.isfinite(epoch_ms):
        return None
    return _iso(epoch_ms / 1000)


def _parse_time(value: object) -> str | None:
    """An ISO-8601 time with offset -> UTC string; None when absent or unparseable."""
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _text(value: object, limit: int = MAX_TEXT) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = re.sub(r"\s+", " ", value).strip()
    return cleaned[:limit] or None


def _float(value: object) -> float | None:
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def contact() -> str:
    return (getattr(settings, "INTEL_FEEDS_CONTACT", "") or "").strip() or "contact-not-set"


def user_agent() -> str:
    return f"CrisisTwin/0.1 (wildfire evacuation planning research; contact: {contact()})"


def parse_bbox(value: object) -> list[float] | None:
    """[west, south, east, north] in degrees, or None when not a valid box."""
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    box = [_float(v) for v in value]
    if any(v is None for v in box):
        return None
    west, south, east, north = box  # type: ignore[misc]
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        return None
    return [west, south, east, north]


def in_bbox(lon: float, lat: float, bbox: list[float] | None) -> bool:
    return bbox is None or (bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3])


def fetch(url: str, accept: str = "application/json") -> tuple[bytes, int]:
    """GET `url`; returns (body, http_status). Raises FeedError on any network or HTTP failure."""
    request = urllib.request.Request(url, headers={"User-Agent": user_agent(), "Accept": accept})
    try:
        with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT_S) as response:  # noqa: S310
            body = response.read(MAX_RESPONSE_BYTES + 1)
            status = response.status
    except urllib.error.HTTPError as exc:
        raise FeedError("feed_unavailable", f"The feed answered HTTP {exc.code}.") from exc
    except TimeoutError as exc:
        raise FeedError("feed_timeout", "The feed did not answer in time.", 504) from exc
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise FeedError("feed_unreachable", "The feed could not be reached.") from exc
    if len(body) > MAX_RESPONSE_BYTES:
        raise FeedError("feed_too_large", f"The feed response exceeds {MAX_RESPONSE_BYTES} bytes.", 502)
    return body, status


def load_json(body: bytes) -> Any:
    try:
        return json.loads(body)
    except (ValueError, UnicodeDecodeError) as exc:
        raise FeedError("feed_invalid", "The feed returned invalid JSON.", 502) from exc


def raw_record(feed: str, url: str, body: bytes, status: int, fetched_at: str) -> dict:
    """Metadata of a raw response (the caller decides what to cache); `sha256` is of the bytes."""
    digest = hashlib.sha256(body).hexdigest()
    return {
        "_id": "raw-" + digest[:16],
        "feed": feed,
        "url": url,
        "fetched_at": fetched_at,
        "http_status": status,
        "size": len(body),
        "sha256": digest,
    }


# -- candidate construction ---------------------------------------------------------------


def event_id(feed: str, source_key: str) -> str:
    """Stable per source record, so re-polls update instead of duplicating. Matches the review route."""
    return "intel-" + hashlib.sha256(f"{feed}:{source_key}".encode()).hexdigest()[:16]


def _candidate(
    *,
    feed: str,
    source_key: str,
    incident: str,
    occurred_at: str,
    occurred_to: str | None,
    description: str,
    quote: str,
    target: dict,
    geometry: dict | None,
    details: dict,
    source_url: str,
    raw: dict,
    fetched_at: str,
    source_updated_at: str | None = None,
) -> dict:
    meta = FEEDS[feed]
    return {
        "event_id": event_id(feed, source_key),
        "incident": incident,
        "type": meta["type"],
        "feed": feed,
        "source_key": source_key,
        "occurred_at": occurred_at,
        "occurred_from": occurred_at,
        "occurred_to": occurred_to,
        "time_precision": "minute",
        "time_role": "as_written",
        "observation_window_min": None,
        "available_at": fetched_at,
        "available_at_status": "fetched_upper_bound",
        "available_at_reason": "Feed fetch time; the agency may have published it earlier.",
        "local_time_as_written": None,
        "target": target,
        "geometry": geometry,
        "geocode_method": "source_provided" if geometry else "unresolved",
        "description": description,
        "quote": quote,
        "action_status": None,
        "source_time_method": "feed_field",
        "source_number": None,
        "evidence_class": "reported",
        "source_id": meta["source_id"],
        "source_url": source_url,
        "source_locator": f"{source_url}; fetched {fetched_at}; sha256 {raw['sha256'][:16]}",
        "document_id": raw["_id"],
        "mode": "live",
        "review_status": "unconfirmed",
        "reviewer": None,
        "reviewer_note": None,
        "reviewed_at": None,
        "mapping": None,
        "flags": [],
        "extraction": None,
        "fetched_at": fetched_at,
        "source_updated_at": source_updated_at,
        "details": details,
    }


# -- NWS ------------------------------------------------------------------------------------


def nws_url(bbox: list[float] | None, area: str) -> str:
    if bbox:
        lon = round((bbox[0] + bbox[2]) / 2, 4)
        lat = round((bbox[1] + bbox[3]) / 2, 4)
        return f"{NWS_ALERTS_URL}?{urllib.parse.urlencode({'point': f'{lat},{lon}'})}"
    return f"{NWS_ALERTS_URL}?{urllib.parse.urlencode({'area': area})}"


def parse_nws(body: Any, *, incident: str, raw: dict, url: str, fetched_at: str) -> tuple[list[dict], dict]:
    """Red Flag Warnings and Fire Weather Watches -> `weather_alert` candidates.

    Returns (candidates, stats). Alerts of other events are counted, not stored.
    """
    features = body.get("features") if isinstance(body, dict) else None
    if not isinstance(features, list):
        raise FeedError("feed_invalid", "The NWS response has no alert list.", 502)
    candidates: list[dict] = []
    skipped = 0
    for feature in features:
        props = feature.get("properties") if isinstance(feature, dict) else None
        if not isinstance(props, dict) or props.get("event") not in NWS_EVENTS:
            skipped += 1
            continue
        alert_id = _text(props.get("id") or feature.get("id"), 300)
        if not alert_id:
            skipped += 1
            continue
        geometry = feature.get("geometry")
        if not (isinstance(geometry, dict) and geometry.get("type") in ("Polygon", "MultiPolygon")):
            geometry = None
        onset = _parse_time(props.get("onset")) or _parse_time(props.get("effective")) or _parse_time(props.get("sent"))
        ends = _parse_time(props.get("ends")) or _parse_time(props.get("expires"))
        event = props["event"]
        area = _text(props.get("areaDesc"), 300)
        headline = _text(props.get("headline"), 600) or event
        candidates.append(
            _candidate(
                feed=NWS,
                source_key=alert_id,
                incident=incident,
                occurred_at=onset or fetched_at,
                occurred_to=ends,
                description=f"{event}" + (f": {area}" if area else ""),
                quote=headline,
                target={"place_name": area},
                geometry=geometry,
                details={
                    "event": event,
                    "severity": _text(props.get("severity"), 40),
                    "certainty": _text(props.get("certainty"), 40),
                    "urgency": _text(props.get("urgency"), 40),
                    "sender_name": _text(props.get("senderName"), 120),
                    "expires": _parse_time(props.get("expires")),
                    "ends": _parse_time(props.get("ends")),
                    "message_type": _text(props.get("messageType"), 40),
                    "zones": [z for z in (props.get("geocode") or {}).get("UGC", []) if isinstance(z, str)][:60],
                    "instruction": _text(props.get("instruction")),
                    "geometry_note": None if geometry else "No polygon given; the alert applies to the named zones.",
                },
                source_url=url,
                raw=raw,
                fetched_at=fetched_at,
                source_updated_at=_parse_time(props.get("sent")),
            )
        )
    return candidates[:MAX_CANDIDATES], {"received": len(features), "skipped": skipped}


# -- Caltrans LCS --------------------------------------------------------------------------


def caltrans_url(district: int) -> str:
    return CALTRANS_LCS_URL.format(district=district)


def _lcs_point(loc: dict, prefix: str) -> list[float] | None:
    lon = _float(loc.get(f"{prefix}Longitude"))
    lat = _float(loc.get(f"{prefix}Latitude"))
    if lon is None or lat is None or not (-180 <= lon <= 180 and -90 <= lat <= 90) or (lon == 0 and lat == 0):
        return None
    return [lon, lat]


def _epoch(value: object) -> int | None:
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return None


def parse_caltrans(
    body: Any,
    *,
    incident: str,
    raw: dict,
    url: str,
    fetched_at: str,
    bbox: list[float] | None,
    now: str | None = None,
) -> tuple[list[dict], dict]:
    """Full closures in effect now -> `road_closure` candidates with coordinates.

    Lane, one-way, alternating and moving closures are not road closures and are only counted.
    Planned (not yet started), ended, and completed (code 1098) records are counted and dropped.
    """
    rows = body.get("data") if isinstance(body, dict) else None
    if not isinstance(rows, list):
        raise FeedError("feed_invalid", "The Caltrans response has no closure list.", 502)
    now_epoch = datetime.strptime(now or fetched_at, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC).timestamp()
    candidates: list[dict] = []
    stats = {"received": len(rows), "not_full": 0, "planned": 0, "ended": 0, "outside_bbox": 0, "invalid": 0}
    for row in rows:
        lcs = row.get("lcs") if isinstance(row, dict) else None
        if not isinstance(lcs, dict) or not isinstance(lcs.get("closure"), dict):
            stats["invalid"] += 1
            continue
        closure, location = lcs["closure"], lcs.get("location") or {}
        begin, end = location.get("begin") or {}, location.get("end") or {}
        key = _text(lcs.get("index"), 120)
        if not key:
            stats["invalid"] += 1
            continue
        if closure.get("typeOfClosure") != "Full":
            stats["not_full"] += 1
            continue
        times = closure.get("closureTimestamp") or {}
        start, stop = _epoch(times.get("closureStartEpoch")), _epoch(times.get("closureEndEpoch"))
        indefinite = str(times.get("isClosureEndIndefinite")).lower() == "true"
        if start is None or (stop is None and not indefinite):
            stats["invalid"] += 1
            continue
        if start > now_epoch:
            stats["planned"] += 1
            continue
        finished = str((closure.get("code1098") or {}).get("isCode1098")).lower() == "true"
        if finished or (not indefinite and stop is not None and stop < now_epoch):
            stats["ended"] += 1
            continue
        first, last = _lcs_point(begin, "begin"), _lcs_point(end, "end")
        anchor = first or last
        if anchor is None:
            stats["invalid"] += 1
            continue
        if bbox and not (in_bbox(*anchor, bbox) or (last and in_bbox(*last, bbox))):
            stats["outside_bbox"] += 1
            continue
        geometry = (
            {"type": "LineString", "coordinates": [first, last]}
            if first and last and first != last
            else {"type": "Point", "coordinates": anchor}
        )
        route = " ".join(
            part for part in (_text(begin.get("beginRoute"), 20), _text(begin.get("beginRouteSuffix"), 10)) if part
        ) or None
        from_desc = _text(begin.get("beginLocationName"), 200)
        to_desc = _text(end.get("endLocationName"), 200)
        facility = _text(closure.get("facility"), 60)
        county = _text(begin.get("beginCounty"), 60)
        place = _text(begin.get("beginNearbyPlace"), 100)
        description = f"Full closure of {route or 'a road'}" + (f" ({facility})" if facility else "")
        if from_desc:
            description += f" at {from_desc}" + (f" to {to_desc}" if to_desc and to_desc != from_desc else "")
        if place or county:
            description += f", near {place or county}"
        candidates.append(
            _candidate(
                feed=CALTRANS,
                source_key=key,
                incident=incident,
                occurred_at=_iso(start),
                occurred_to=None if indefinite or stop is None else _iso(stop),
                description=description[:MAX_TEXT],
                quote=_text(
                    f"{closure.get('typeOfClosure')} closure, {facility or 'road'}, {closure.get('typeOfWork') or 'work not stated'}",
                    300,
                )
                or "Full closure",
                target={
                    "osm_way_ids": None,
                    "osm_way_ids_status": "unresolved",
                    "road_name": route,
                    "from_desc": from_desc,
                    "to_desc": to_desc,
                },
                geometry=geometry,
                details={
                    "closure_id": _text(closure.get("closureID"), 40),
                    "log_number": _text(closure.get("logNumber"), 10),
                    "facility": facility,
                    "type_of_work": _text(closure.get("typeOfWork"), 80),
                    "duration": _text(closure.get("durationOfClosure"), 40),
                    "direction": _text(location.get("travelFlowDirection"), 20),
                    "county": county,
                    "nearby_place": place,
                    "district": _text(begin.get("beginDistrict"), 4),
                    "closure_end_indefinite": indefinite,
                    "chp_on_scene_1097": str((closure.get("code1097") or {}).get("isCode1097")).lower() == "true",
                },
                source_url=url,
                raw=raw,
                fetched_at=fetched_at,
                source_updated_at=_iso(_epoch((lcs.get("recordTimestamp") or {}).get("recordEpoch")) or now_epoch),
            )
        )
    return candidates[:MAX_CANDIDATES], stats


# -- WFIGS ---------------------------------------------------------------------------------


def wfigs_query_url(base: str, bbox: list[float] | None, out_fields: str, extra: dict | None = None) -> str:
    params = {
        "where": "1=1",
        "outFields": out_fields,
        "outSR": "4326",
        "f": "geojson",
        "resultRecordCount": "2000",
        **(extra or {}),
    }
    if bbox:
        params.update(
            geometry=",".join(str(v) for v in bbox),
            geometryType="esriGeometryEnvelope",
            inSR="4326",
            spatialRel="esriSpatialRelIntersects",
        )
    return f"{base}?{urllib.parse.urlencode(params)}"


WFIGS_INCIDENT_FIELDS = (
    "IrwinID,IncidentName,IncidentSize,PercentContained,FireDiscoveryDateTime,ModifiedOnDateTime_dt,"
    "POOState,POOCounty,IncidentTypeCategory,FireCause,ContainmentDateTime,ControlDateTime"
)
WFIGS_PERIMETER_FIELDS = "poly_IRWINID,attr_IrwinID,poly_IncidentName,poly_GISAcres,poly_PolygonDateTime,poly_MapMethod"


def _irwin(value: object) -> str | None:
    return value.strip("{}").lower() if isinstance(value, str) and value.strip("{} ") else None


def wfigs_features(body: Any, what: str) -> list[dict]:
    features = body.get("features") if isinstance(body, dict) else None
    if not isinstance(features, list):
        raise FeedError("feed_invalid", f"The WFIGS {what} response has no feature list.", 502)
    return [f for f in features if isinstance(f, dict)]


def parse_wfigs(
    incidents_body: Any,
    perimeters_body: Any,
    *,
    incident: str,
    raw: dict,
    url: str,
    fetched_at: str,
    bbox: list[float] | None,
) -> tuple[list[dict], dict]:
    """Current wildfire/complex points with acres, containment and (when mapped) the perimeter."""
    perimeters: dict[str, dict] = {}
    for feature in wfigs_features(perimeters_body, "perimeter"):
        props = feature.get("properties") or {}
        geometry = feature.get("geometry")
        key = _irwin(props.get("poly_IRWINID") or props.get("attr_IrwinID"))
        if key and isinstance(geometry, dict) and geometry.get("type") in ("Polygon", "MultiPolygon"):
            perimeters[key] = {
                "geometry": geometry,
                "gis_acres": _float(props.get("poly_GISAcres")),
                "mapped_at": _iso_ms(props.get("poly_PolygonDateTime")),
                "map_method": _text(props.get("poly_MapMethod"), 80),
            }
    features = wfigs_features(incidents_body, "incident")
    candidates: list[dict] = []
    stats = {"received": len(features), "not_wildfire": 0, "outside_bbox": 0, "invalid": 0, "with_perimeter": 0}
    for feature in features:
        props, geometry = feature.get("properties") or {}, feature.get("geometry") or {}
        key = _irwin(props.get("IrwinID"))
        coords = geometry.get("coordinates") if geometry.get("type") == "Point" else None
        lon = _float(coords[0]) if isinstance(coords, list) and len(coords) >= 2 else None
        lat = _float(coords[1]) if isinstance(coords, list) and len(coords) >= 2 else None
        if not key or lon is None or lat is None:
            stats["invalid"] += 1
            continue
        if props.get("IncidentTypeCategory") not in WFIGS_CATEGORIES:
            stats["not_wildfire"] += 1
            continue
        if not in_bbox(lon, lat, bbox) and key not in perimeters:
            stats["outside_bbox"] += 1
            continue
        perimeter = perimeters.get(key)
        stats["with_perimeter"] += 1 if perimeter else 0
        name = (_text(props.get("IncidentName"), 120) or "Unnamed incident").title()
        acres = _float(props.get("IncidentSize"))
        contained = _float(props.get("PercentContained"))
        discovered = _iso_ms(props.get("FireDiscoveryDateTime"))
        modified = _iso_ms(props.get("ModifiedOnDateTime_dt"))
        county, state = _text(props.get("POOCounty"), 60), _text(props.get("POOState"), 10)
        description = f"{name} fire"
        if county:
            description += f", {county} County"
        description += f": {acres:g} acres" if acres is not None else ": size not reported"
        description += f", {contained:g}% contained" if contained is not None else ", containment not reported"
        candidates.append(
            _candidate(
                feed=WFIGS,
                source_key=key,
                incident=incident,
                occurred_at=discovered or modified or fetched_at,
                occurred_to=None,
                description=description,
                quote=f"{name}; {acres if acres is not None else 'size n/a'} acres; "
                f"{contained if contained is not None else 'containment n/a'}% contained",
                target={"place_name": ", ".join(p for p in (county, state) if p) or None},
                geometry={"type": "Point", "coordinates": [lon, lat]},
                details={
                    "irwin_id": key,
                    "name": name,
                    "category": props.get("IncidentTypeCategory"),
                    "acres": acres,
                    "percent_contained": contained,
                    "discovered_at": discovered,
                    "cause": _text(props.get("FireCause"), 60),
                    "perimeter": perimeter["geometry"] if perimeter else None,
                    "perimeter_gis_acres": perimeter["gis_acres"] if perimeter else None,
                    "perimeter_mapped_at": perimeter["mapped_at"] if perimeter else None,
                    "perimeter_map_method": perimeter["map_method"] if perimeter else None,
                },
                source_url=url,
                raw=raw,
                fetched_at=fetched_at,
                source_updated_at=modified,
            )
        )
    return candidates[:MAX_CANDIDATES], stats
