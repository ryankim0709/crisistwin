"""Event timeline for the Kincade package (curated table -> events.jsonl)."""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone

from tools.kincade_common import SourceError, load_json, local_to_utc, utc_text

STATUS_TYPES = {"order": "evacuation_order", "warning": "evacuation_warning", "open": "evacuation_order_lifted"}
CALFIRE_SOURCE_ID = "calfire-incident-api-2019"
CALFIRE_URL = "https://incidents.fire.ca.gov/umbraco/api/IncidentApi/List?inactive=true&year=2019"
EVENT_TYPES = {
    "fire_ignition", "fire_contained", "evacuation_order", "evacuation_warning",
    "evacuation_order_lifted", "road_closed", "road_reopened", "shelter_opened",
    "shelter_occupancy_reported", "infrastructure_failure", "infrastructure_restored",
}


def zone_id(label: str) -> str:
    return f"kincade-zone-{label.lower()}"


def _unknown_availability() -> dict:
    return {"available_at": None, "available_at_status": "unknown",
            "available_at_reason": "retrospective source; public release time of each notice not established"}


def matrix_events(table: dict) -> list[dict]:
    source = table["matrix_source"]
    parent_of = {child: parent for parent, children in table["zone_splits"].items() for child in children}
    previous: dict[str, str] = {}
    events = []
    last_local = None
    for row in table["matrix_rows"]:
        local = datetime.fromisoformat(row["local"])
        if last_local is not None and local <= last_local:
            raise SourceError(f"matrix row {row['row']} is not in time order")
        last_local = local
        current: dict[str, str] = {}
        for status in ("order", "warning", "open"):
            group = row.get(status)
            for label in (group or {}).get("zones", []):
                if label in current:
                    raise SourceError(f"matrix row {row['row']}: zone {label} listed twice")
                current[label] = status
        superseded = sorted(zone_id(z) for z in previous if z not in current)
        occurred = utc_text(local_to_utc(local))
        for status in ("order", "warning", "open"):
            group = row.get(status)
            if not group:
                continue
            changed = [z for z in group["zones"] if previous.get(z) != status]
            place = group.get("place_name")
            if not changed and not place:
                continue
            transitions = []
            for z in changed:
                parent = parent_of.get(z) if z not in previous else None
                inherited = parent is not None and parent in previous
                transitions.append({
                    "zone_id": zone_id(z),
                    "from": previous[parent] if inherited else previous.get(z, "not_listed"),
                    "to": status,
                    "via_split_of": zone_id(parent) if inherited else None,
                })
            events.append({
                "event_id": f"kincade-matrix-r{row['row']:02d}-{status}",
                "type": STATUS_TYPES[status],
                "occurred_at": occurred, "occurred_from": occurred, "occurred_to": occurred,
                "time_precision": "minute",
                "time_role": "zone status in force from this time as listed in the official order matrix",
                **_unknown_availability(),
                "local_time_as_written": row["as_written"],
                "target": {"zone_ids": [zone_id(z) for z in changed] if changed else [],
                           "place_name": place},
                "zone_transitions": transitions,
                "zone_ids_in_status_after": [zone_id(z) for z in group["zones"]],
                "zone_status_after": status,
                "population_in_status_group": group.get("population"),
                "population_basis": "matrix total for all zones in this status at this time (not per zone)",
                "zone_ids_no_longer_listed": superseded,
                "geometry": None,
                "geocode_method": "zone_polygon_lookup" if changed else "unresolved",
                "description": (f"{place}: mandatory evacuation" if place else
                                f"Zones {', '.join(changed)} {'opened' if status == 'open' else 'under ' + ('mandatory evacuation' if status == 'order' else 'evacuation warning')}"),
                "quote": None,
                "note_as_written": row.get("note_as_written"),
                "evidence_class": "observed",
                "source_id": source["source_id"],
                "source_locator": f"{source['url']}#page={row['table_page']}; table row {row['row']}; map p. {row['map_page']}",
            })
        previous = current
    return events


def curated_events(table: dict) -> list[dict]:
    events = []
    for row in table["other_events"]:
        precision = row["time_precision"]
        if precision == "day":
            day = date.fromisoformat(row["local"])
            start = local_to_utc(datetime.combine(day, datetime.min.time()))
            end = local_to_utc(datetime.combine(day + timedelta(days=1), datetime.min.time())) - timedelta(seconds=1)
            occurred, frm, to = utc_text(start), utc_text(start), utc_text(end)
        elif precision == "minute":
            occurred = frm = to = utc_text(local_to_utc(datetime.fromisoformat(row["local"])))
        else:
            raise SourceError(f"unsupported precision for {row['event_id']}")
        event = {
            "event_id": row["event_id"], "type": row["type"],
            "occurred_at": occurred, "occurred_from": frm, "occurred_to": to,
            "time_precision": precision,
            "time_role": "date only; occurred_at is local midnight" if precision == "day" else "time as written in source",
            **_unknown_availability(),
            "local_time_as_written": row["local_time_as_written"],
            "target": row["target"], "geometry": None, "geocode_method": "unresolved",
            "description": row["description"], "quote": row.get("quote"),
            "evidence_class": row["evidence_class"], "source_id": row["source_id"],
            "source_locator": row["source_locator"],
        }
        for extra in ("infrastructure", "count_persons", "count_kind"):
            if extra in row:
                event[extra] = row[extra]
        events.append(event)
    return events


def calfire_events(api_bytes: bytes) -> list[dict]:
    rows = load_json(api_bytes, "CAL FIRE incident API")
    matches = [r for r in rows if isinstance(r, dict) and r.get("Name") == "Kincade Fire"
               and r.get("UniqueId") == "809d101c-8aa3-4a53-bf20-f38ae7ec7941"]
    if len(matches) != 1:
        raise SourceError("CAL FIRE API response lacks exactly one Kincade Fire record")
    rec = matches[0]
    started = datetime.fromisoformat(rec["Started"].replace("Z", "+00:00"))
    ended = datetime.fromisoformat(rec["ExtinguishedDate"].replace("Z", "+00:00"))
    point = [rec["Longitude"], rec["Latitude"]]
    base = {**_unknown_availability(), "evidence_class": "observed", "source_id": CALFIRE_SOURCE_ID,
            "quote": None, "time_precision": "minute"}
    return [
        {**base, "event_id": "kincade-calfire-ignition", "type": "fire_ignition",
         "occurred_at": utc_text(started), "occurred_from": utc_text(started), "occurred_to": utc_text(started),
         "time_role": "CAL FIRE reported start time",
         "local_time_as_written": started.astimezone(timezone(timedelta(hours=-7))).strftime("%Y-%m-%d %H:%M PDT"),
         "target": {"place_name": rec["Location"]},
         "geometry": {"type": "Point", "coordinates": point}, "geocode_method": "source_coordinates",
         "description": f"Kincade Fire reported start ({rec['AdminUnit']}).",
         "source_locator": f"{CALFIRE_URL} record UniqueId {rec['UniqueId']} field Started; page {rec['Url']}"},
        {**base, "event_id": "kincade-calfire-containment", "type": "fire_contained",
         "occurred_at": utc_text(ended), "occurred_from": utc_text(ended), "occurred_to": utc_text(ended),
         "time_role": "CAL FIRE 100% containment time (field ExtinguishedDate)",
         "local_time_as_written": ended.astimezone(timezone(timedelta(hours=-8))).strftime("%Y-%m-%d %H:%M PST"),
         "target": {"place_name": rec["Location"]}, "geometry": None, "geocode_method": "unresolved",
         "description": f"Fire 100% contained; {rec['AcresBurned']:.0f} acres burned (final).",
         "source_locator": f"{CALFIRE_URL} record UniqueId {rec['UniqueId']} field ExtinguishedDate"},
    ]


def normalize_events(table_bytes: bytes, calfire_bytes: bytes, known_zone_ids: set[str]) -> list[dict]:
    table = json.loads(table_bytes)
    events = calfire_events(calfire_bytes) + matrix_events(table) + curated_events(table)
    ids = set()
    for event in events:
        if event["event_id"] in ids or event["type"] not in EVENT_TYPES:
            raise SourceError(f"duplicate or unknown event {event['event_id']}")
        ids.add(event["event_id"])
        for zid in event["target"].get("zone_ids") or []:
            if zid not in known_zone_ids:
                raise SourceError(f"{event['event_id']}: zone {zid} has no polygon in evacuation_zones")
    events.sort(key=lambda e: (e["occurred_at"], e["event_id"]))
    return events
