"""MongoDB indexes and ``$jsonSchema`` validators for the live collections (docs/live-reports.md "MongoDB plan").

Applied idempotently by ``python manage.py live_init_db``; request paths never create indexes.
"""

from __future__ import annotations

from typing import Any

from pymongo import ASCENDING, DESCENDING, IndexModel
from pymongo.database import Database
from pymongo.errors import CollectionInvalid

DATE = {"bsonType": "date"}
STR = {"bsonType": "string"}
NUM = {"bsonType": ["double", "int", "long"]}
NULLABLE_STR = {"bsonType": ["string", "null"]}
COORD = {"bsonType": "array", "minItems": 2, "maxItems": 2, "items": NUM}
NULLABLE_COORD = {"bsonType": ["array", "null"], "minItems": 2, "maxItems": 2, "items": NUM}
NULLABLE_DATE = {"bsonType": ["date", "null"]}


def _enum(*values: Any) -> dict[str, Any]:
    return {"enum": list(values)}


def _schema(required: list[str], properties: dict[str, Any]) -> dict[str, Any]:
    return {"$jsonSchema": {"bsonType": "object", "required": required, "properties": properties}}


VALIDATORS: dict[str, dict[str, Any]] = {
    "live_devices": _schema(
        ["token_hash", "role", "party_key", "created_at", "expires_at"],
        {
            "token_hash": STR,
            "role": _enum("civilian", "responder"),
            "party_key": STR,
            "incident_id": NULLABLE_STR,
            "created_at": DATE,
            "last_seen_at": DATE,
            "expires_at": DATE,
        },
    ),
    "live_reports": _schema(
        ["id", "client_id", "incident_id", "reporter", "kind", "location", "observed_at", "received_at", "status",
         "evidence_class", "updated_at"],
        {
            "id": STR,
            "client_id": STR,
            "incident_id": STR,
            "reporter": {
                "bsonType": "object",
                "required": ["role", "party_key"],
                "properties": {"role": _enum("civilian", "responder", "controller"), "party_key": STR},
            },
            "kind": _enum("road_blocked", "road_passable", "heavy_traffic", "fire_seen", "heavy_smoke",
                          "hazard_down", "shelter_full", "help_needed"),
            "severity": _enum("full", "partial", "slow", None),
            "location": {
                "bsonType": "object",
                "required": ["coord"],
                "properties": {"coord": COORD, "accuracy_m": {"bsonType": ["double", "int", "long", "null"],
                                                               "minimum": 0}},
            },
            "observed_at": DATE,
            "received_at": DATE,
            "updated_at": DATE,
            "replay_at": NULLABLE_DATE,
            "status": _enum("unverified", "corroborated", "responder_confirmed", "confirmed", "dismissed", "resolved"),
            "evidence_class": _enum("field_report", "drill_fixture", "historical_record"),
        },
    ),
    "live_tasks": _schema(
        ["id", "incident_id", "kind", "target", "status", "created_at"],
        {
            "id": STR,
            "incident_id": STR,
            "assignee": NULLABLE_STR,
            "kind": _enum("verify", "assist"),
            "checkin_id": NULLABLE_STR,
            "status": _enum("open", "accepted", "done", "cancelled"),
            "created_at": DATE,
            "accepted_at": NULLABLE_DATE,
        },
    ),
    "live_decisions": _schema(
        ["incident_id", "at", "actor", "action"],
        {"incident_id": STR, "at": DATE, "actor": STR, "action": STR, "report_ids": {"bsonType": "array"}},
    ),
    "live_drills": _schema(
        ["incident_id"],
        {
            "incident_id": STR,
            "replay_start": DATE,
            "started_at": NULLABLE_DATE,
            "speed": {"bsonType": ["double", "int", "long"], "minimum": 0, "maximum": 60},
        },
    ),
    "live_guidance": _schema(
        ["incident_id", "zone_id", "level", "no_route", "version", "published_at", "approved_by", "proposal_id"],
        {
            "incident_id": STR,
            "zone_id": STR,
            "level": _enum("evacuate_now", "be_ready", "none"),
            "no_route": {"bsonType": "bool"},
            "version": {"bsonType": ["int", "long"], "minimum": 1},
            "published_at": DATE,
            "replay_at": DATE,
            "approved_by": _enum("auto_policy", "controller"),
            "proposal_id": STR,
        },
    ),
    "live_proposals": _schema(
        ["id", "incident_id", "created_at", "status", "policy", "causes", "changes", "tasks", "rationale"],
        {
            "id": STR,
            "incident_id": STR,
            "created_at": DATE,
            "replay_at": DATE,
            "status": _enum("pending", "approved", "rejected", "auto_approved", "superseded"),
            "policy": _enum("auto_reroute", "needs_controller"),
            "causes": {"bsonType": "array", "items": _enum("road_block", "road_report", "fire", "shelter_full", "manual")},
            "changes": {"bsonType": "array"},
            "tasks": {"bsonType": "array"},
            "decided_at": NULLABLE_DATE,
        },
    ),
    "live_checkins": _schema(
        ["id", "incident_id", "party_key", "status", "at"],
        {
            "id": STR,
            "incident_id": STR,
            "party_key": STR,
            "status": _enum("out", "need_help", "staying"),
            "zone_id": NULLABLE_STR,
            "coord": NULLABLE_COORD,
            "at": DATE,
            "replay_at": NULLABLE_DATE,
            "help": {
                "bsonType": ["object", "null"],
                "properties": {
                    "status": _enum("open", "acknowledged", "assigned", "resolved"),
                    "assignee": NULLABLE_STR,
                    "task_id": NULLABLE_STR,
                },
            },
        },
    ),
    "live_destination_choices": _schema(
        ["incident_id", "party_key", "zone_id", "destination_id", "at", "expires_at"],
        {
            "incident_id": STR,
            "party_key": STR,
            "zone_id": STR,
            "destination_id": STR,
            "guidance_version": {"bsonType": ["int", "long"], "minimum": 1},
            "at": DATE,
            "expires_at": DATE,
        },
    ),
    "live_plan_routes": _schema(
        ["incident_id", "zone_id", "destination_id", "via_key", "edge_ids"],
        {
            "incident_id": STR,
            "zone_id": STR,
            "destination_id": STR,
            "via_key": STR,
            "via": {"bsonType": "array", "items": STR},
            "edge_ids": {"bsonType": "array", "items": STR},
            "planned_at": DATE,
            "replay_at": NULLABLE_DATE,
        },
    ),
    "live_responder_locations": _schema(
        ["incident_id", "party_key", "coord", "at", "expires_at"],
        {
            "incident_id": STR,
            "party_key": STR,
            "coord": COORD,
            "accuracy_m": {"bsonType": ["double", "int", "long", "null"], "minimum": 0},
            "at": DATE,
            "expires_at": DATE,
        },
    ),
}

INDEXES: dict[str, list[IndexModel]] = {
    "live_devices": [
        IndexModel([("token_hash", ASCENDING)], unique=True),
        IndexModel([("party_key", ASCENDING)]),
        IndexModel([("expires_at", ASCENDING)], expireAfterSeconds=0),
    ],
    "live_reports": [
        IndexModel([("id", ASCENDING)], unique=True),
        IndexModel([("incident_id", ASCENDING), ("client_id", ASCENDING)], unique=True),
        IndexModel([("incident_id", ASCENDING), ("received_at", DESCENDING)]),
        IndexModel([("incident_id", ASCENDING), ("updated_at", ASCENDING), ("id", ASCENDING)]),
        IndexModel([("reporter.party_key", ASCENDING), ("received_at", DESCENDING)]),
    ],
    "live_tasks": [
        IndexModel([("id", ASCENDING)], unique=True),
        IndexModel([("incident_id", ASCENDING), ("status", ASCENDING)]),
        IndexModel([("assignee", ASCENDING), ("status", ASCENDING)]),
    ],
    "live_decisions": [IndexModel([("incident_id", ASCENDING), ("at", DESCENDING)])],
    "live_drills": [IndexModel([("incident_id", ASCENDING)], unique=True)],
    "live_guidance": [
        IndexModel([("incident_id", ASCENDING), ("zone_id", ASCENDING), ("version", DESCENDING)], unique=True),
        IndexModel([("incident_id", ASCENDING), ("published_at", DESCENDING)]),
    ],
    "live_proposals": [
        IndexModel([("id", ASCENDING)], unique=True),
        IndexModel([("incident_id", ASCENDING), ("status", ASCENDING), ("created_at", DESCENDING)]),
    ],
    "live_checkins": [
        IndexModel([("incident_id", ASCENDING), ("party_key", ASCENDING)], unique=True),
        IndexModel([("incident_id", ASCENDING), ("zone_id", ASCENDING), ("status", ASCENDING)]),
    ],
    "live_destination_choices": [
        IndexModel([("incident_id", ASCENDING), ("party_key", ASCENDING), ("zone_id", ASCENDING)], unique=True),
        IndexModel([("incident_id", ASCENDING), ("zone_id", ASCENDING), ("destination_id", ASCENDING)]),
        IndexModel([("expires_at", ASCENDING)], expireAfterSeconds=0),
    ],
    "live_plan_routes": [
        IndexModel([("incident_id", ASCENDING), ("zone_id", ASCENDING), ("destination_id", ASCENDING),
                    ("via_key", ASCENDING)], unique=True),
    ],
    "live_responder_locations": [
        IndexModel([("incident_id", ASCENDING), ("party_key", ASCENDING)], unique=True),
        IndexModel([("expires_at", ASCENDING)], expireAfterSeconds=0),
    ],
}

DRILL_DATA_COLLECTIONS = (
    "live_reports",
    "live_tasks",
    "live_decisions",
    "live_drills",
    "live_guidance",
    "live_proposals",
    "live_checkins",
    "live_destination_choices",
    "live_plan_routes",
    "live_responder_locations",
)
"""Dropped by ``live_init_db --drop-drill-data`` (devices are kept so tokens stay valid)."""


def apply(db: Database, drop_drill_data: bool = False) -> list[str]:
    """Create or update collections, validators and indexes. Returns log lines."""
    lines = []
    if drop_drill_data:
        for name in DRILL_DATA_COLLECTIONS:
            db.drop_collection(name)
            lines.append(f"dropped {name}")
    existing = set(db.list_collection_names())
    for name, validator in VALIDATORS.items():
        if name in existing:
            db.command("collMod", name, validator=validator, validationLevel="strict", validationAction="error")
            lines.append(f"updated validator {name}")
        else:
            try:
                db.create_collection(name, validator=validator, validationLevel="strict", validationAction="error")
                lines.append(f"created {name}")
            except CollectionInvalid:
                # A background thread (auto-replan, twin warm-up) wrote to it since the listing,
                # which creates it implicitly; apply the validator instead.
                db.command("collMod", name, validator=validator, validationLevel="strict", validationAction="error")
                lines.append(f"updated validator {name}")
        created = db[name].create_indexes(INDEXES[name])
        lines.append(f"  indexes {name}: {', '.join(created)}")
    return lines
