"""Similar past situations for the dispatcher, by Atlas Vector Search (`dispatch_situations`).

Every journalled decision also stores the situation it was made in as a vector (situation.py)
with the orders the agent gave. When that run's outcome arrives (dispatch_runs.run_outcome) the
situations are marked with it. Before each decision, `$vectorSearch` finds the closest
situations from other finished runs, on any road network, best one per run, and the agent sees
them as `<similar_situations>`: what that situation looked like, what was ordered and how the
run ended. Earlier simulated runs, labelled so; never facts about this run.

The search index (`situation_vector`, type vectorSearch) is created on first use, or with
`python manage.py dispatch_vector_index`. It needs MongoDB Atlas (or Atlas local); elsewhere the
search fails and the agent decides without it. A failure turns the search off for
COOLDOWN_SECONDS so a missing index never costs every decision a timeout. See
docs/adr/0032-atlas-situation-search.md.
"""

import logging
import time
from datetime import UTC, datetime
from threading import Lock

from pymongo.errors import OperationFailure, PyMongoError
from pymongo.operations import SearchIndexModel

from . import situation
from .mongodb import get_database

logger = logging.getLogger(__name__)

COLLECTION = "dispatch_situations"
INDEX_NAME = "situation_vector"
INDEX_DEFINITION = {
    "fields": [
        {"type": "vector", "path": "vector", "numDimensions": situation.DIMENSIONS, "similarity": "cosine"},
        {"type": "filter", "path": "has_outcome"},
        {"type": "filter", "path": "session_id"},
        {"type": "filter", "path": "version"},
    ]
}
# Atlas reports cosine as (1 + cos) / 2; below this a "match" is not similar enough to show.
MIN_SCORE = 0.9
SHOWN = 3
CANDIDATES = 150
SEARCH_LIMIT = 20
COOLDOWN_SECONDS = 60
MAX_ORDERS = 12

_lock = Lock()
_index_ready = False
_disabled_until = 0.0


def _collection():
    return get_database()[COLLECTION]


def ensure_index() -> str:
    """Create the vector index if it is missing; returns its status. Raises on database errors."""
    db = get_database()
    if COLLECTION not in db.list_collection_names():
        db.create_collection(COLLECTION)
    collection = db[COLLECTION]
    existing = list(collection.list_search_indexes(INDEX_NAME))
    if not existing:
        collection.create_search_index(SearchIndexModel(INDEX_DEFINITION, name=INDEX_NAME, type="vectorSearch"))
        return "created (building)"
    index = existing[0]
    if index.get("latestDefinition") != INDEX_DEFINITION:
        collection.update_search_index(INDEX_NAME, INDEX_DEFINITION)
        return "updated (rebuilding)"
    return str(index.get("status", "unknown")).lower()


def _available() -> bool:
    global _index_ready, _disabled_until
    with _lock:
        if time.monotonic() < _disabled_until:
            return False
        if _index_ready:
            return True
    try:
        ensure_index()
    except (PyMongoError, ValueError):
        logger.warning("Atlas vector index unavailable; similar situations off for a while", exc_info=True)
        _back_off()
        return False
    with _lock:
        _index_ready = True
    return True


def _back_off() -> None:
    global _disabled_until
    with _lock:
        _disabled_until = time.monotonic() + COOLDOWN_SECONDS


def record(session_id: str, area_id: str, area_name: str, obs: dict, orders: list[str], summary: str) -> None:
    """Store the decision's situation; never raises."""
    named = situation.features(obs)
    clock = obs.get("clock") if isinstance(obs.get("clock"), dict) else {}
    try:
        _collection().insert_one(
            {
                "session_id": session_id,
                "area_id": area_id,
                "area_name": area_name,
                "minute": clock.get("minute"),
                "version": situation.VERSION,
                "vector": situation.vector(named),
                "situation": situation.summary(obs),
                "orders": orders[:MAX_ORDERS],
                "summary": summary,
                "has_outcome": False,
                "outcome": None,
                "evidence_class": "simulated",
                "at": datetime.now(UTC),
            }
        )
    except (PyMongoError, ValueError):
        logger.warning("Could not store a dispatch situation", exc_info=True)


def mark_outcome(session_id: str, outcome: dict) -> None:
    """Attach a run's outcome to its situations so they become searchable; never raises."""
    try:
        _collection().update_many({"session_id": session_id}, {"$set": {"has_outcome": True, "outcome": outcome}})
    except (PyMongoError, ValueError):
        logger.warning("Could not mark dispatch situations with their outcome", exc_info=True)


def pipeline(query: list[float], session_id: str) -> list[dict]:
    return [
        {
            "$vectorSearch": {
                "index": INDEX_NAME,
                "path": "vector",
                "queryVector": query,
                "numCandidates": CANDIDATES,
                "limit": SEARCH_LIMIT,
                "filter": {
                    "has_outcome": True,
                    "version": situation.VERSION,
                    "session_id": {"$ne": session_id},
                },
            }
        },
        {"$set": {"score": {"$meta": "vectorSearchScore"}}},
        {"$match": {"score": {"$gte": MIN_SCORE}}},
        # Best match per earlier run, so one run's many decisions do not crowd out the rest.
        {"$sort": {"score": -1}},
        {"$group": {"_id": "$session_id", "best": {"$first": "$$ROOT"}}},
        {"$replaceRoot": {"newRoot": "$best"}},
        {"$sort": {"score": -1}},
        {"$limit": SHOWN},
        {"$project": {"_id": 0, "vector": 0, "has_outcome": 0, "session_id": 0, "version": 0, "at": 0}},
    ]


def similar(session_id: str, obs: dict) -> list[dict]:
    """The closest situations from other finished runs, best first; [] when none or unavailable."""
    if not _available():
        return []
    area = obs.get("area") if isinstance(obs.get("area"), dict) else {}
    try:
        docs = list(_collection().aggregate(pipeline(situation.vector(situation.features(obs)), session_id)))
    except OperationFailure:
        # Index missing or still building; check it again after the cooldown.
        global _index_ready
        with _lock:
            _index_ready = False
        _back_off()
        logger.warning("Atlas vector search failed", exc_info=True)
        return []
    except (PyMongoError, ValueError):
        _back_off()
        logger.warning("Atlas vector search failed", exc_info=True)
        return []
    return [
        {
            "similarity": round(doc.get("score", 0.0), 3),
            "same_road_network": doc.get("area_id") == area.get("id"),
            "area_name": doc.get("area_name", ""),
            "situation": doc.get("situation", {}),
            "orders_given": doc.get("orders", []),
            "summary": doc.get("summary", ""),
            "run_outcome": doc.get("outcome"),
            "evidence_class": "simulated",
        }
        for doc in docs
    ]
