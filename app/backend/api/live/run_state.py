"""Live board run state: per-zone status counts and per-household stand-in states (all simulated).

The Live board simulation runs in the controller's browser (``app/src/demo/model.ts``, zone/cohort
based) and PUTs its per-zone household status counts here. The API keeps only the *current* state
of the incident's *current* run: one ``live_run_state`` document per incident, and one
``live_household_state`` document per snapshot household, allocated from the zone counts by
``livecore.household_states`` (a deterministic stand-in: which household is "safe" is an
allocation, not an observation). Contract: docs/live-reports.md "Run state".

Writes to the household collection run in a per-incident background thread (an Atlas free tier
wrote about 250 documents a second when measured, so a run's first 20k households take ~80 s): the
PUT stores the summary, queues the counts, waits a few seconds for the writer, then answers with
what was written so far. The writer coalesces PUTs (it always applies the newest counts) and writes
only documents that changed, in batches of ``WRITE_BATCH``.
"""

from __future__ import annotations

import json
import logging
import math
import threading
import time
from datetime import timedelta
from typing import Any

import pymongo
from pymongo import InsertOne, UpdateOne
from pymongo.errors import BulkWriteError, DuplicateKeyError, PyMongoError

from livecore.household_states import STATUSES, State, assign_all, changed, stable_key

from . import board_guidance, incidents
from .auth import Principal, live_view
from .common import ApiError, col, error, iso, ok, parse_iso, wall_now

log = logging.getLogger(__name__)

RUNS = "live_run_state"
HOUSEHOLDS = "live_household_state"
SNAPSHOTS = "scenario_snapshots"
SNAPSHOT_HOUSEHOLDS = "snapshot_households"
CODE = "invalid_run_state"
ORDER_STATUSES = ("none", "scheduled", "leaving", "done", "overrun")
ORDER_ISSUERS = (None, "ai_agent", "controller")
ROUTE_SAFETY = ("clear", "passes_near_fire", "passes_fire")
MAX_ROUTE_POINTS = 400
MAX_ROUTE_VIA = 5
MAX_ZONES = 2000
MAX_BODY_BYTES = 1_000_000
MAX_COUNT = 10_000_000
WRITE_BATCH = 1000
SYNC_WAIT_S = 5.0
"""How long a PUT waits for the writer before answering with ``materialization: "writing"``."""
LIMIT_DEFAULT = LIMIT_MAX = 5000
POLL_OVERLAP = timedelta(seconds=30)
"""``as_of`` lags the server clock so a batch being written while a GET runs is not missed."""
LONG_OP_S = 180
"""Local ``pymongo.timeout`` for whole-run reads, batch writes and deletes (global budget is 15 s)."""
SNAPSHOT_CACHE_MAX = 3
STALE_WRITER_S = 30
"""ASSUMPTION: a console that has not saved for 30 s is closed or idle, so another may take over."""
EVIDENCE_CLASS = "simulated"
_index_ready = False


# ---- validation ----

def _err(detail: str) -> ApiError:
    return ApiError(400, CODE, detail)


def _text(value: Any, field: str, max_len: int = 80) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > max_len:
        raise _err(f"`{field}` must be a non-empty string of at most {max_len} characters.")
    return value.strip()


def _minute(value: Any, field: str, nullable: bool = False) -> float | None:
    if value is None and nullable:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise _err(f"`{field}` must be a finite number >= 0{' or null' if nullable else ''}.")
    return float(value)


def _counts(value: Any, field: str, nullable: bool = False) -> dict[str, int] | None:
    if value is None and nullable:
        return None
    if not isinstance(value, dict):
        raise _err(f"`{field}` must be an object of status -> count{' or null' if nullable else ''}.")
    out = {}
    for status, count in value.items():
        if status not in STATUSES:
            raise _err(f"`{field}.{status}`: unknown status; use one of {', '.join(STATUSES)}.")
        if isinstance(count, float) and count.is_integer():
            count = int(count)
        if isinstance(count, bool) or not isinstance(count, int) or not 0 <= count <= MAX_COUNT:
            raise _err(f"`{field}.{status}` must be an integer in 0..{MAX_COUNT}.")
        out[status] = count
    return out


def _route(value: Any, field: str) -> dict[str, Any] | None:
    """Optional ``order.route``: the board's route option for the order (board_guidance.py publishes it)."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise _err(f"`{field}` must be an object or null.")
    via = value.get("via")
    if not isinstance(via, list) or len(via) > MAX_ROUTE_VIA or not all(isinstance(v, str) and len(v) <= 120 for v in via):
        raise _err(f"`{field}.via` must be a list of at most {MAX_ROUTE_VIA} road names.")
    if value.get("safety") not in ROUTE_SAFETY:
        raise _err(f"`{field}.safety` must be one of {', '.join(ROUTE_SAFETY)}.")
    line = value.get("line")
    if not isinstance(line, list) or not 2 <= len(line) <= MAX_ROUTE_POINTS:
        raise _err(f"`{field}.line` must be a list of 2..{MAX_ROUTE_POINTS} [lon, lat] points.")
    points = []
    for p in line:
        if (not isinstance(p, list) or len(p) != 2 or any(isinstance(c, bool) or not isinstance(c, (int, float))
                                                          or not math.isfinite(c) for c in p)
                or not (-180 <= p[0] <= 180 and -90 <= p[1] <= 90)):
            raise _err(f"`{field}.line` points must be finite [lon, lat] pairs.")
        points.append([float(p[0]), float(p[1])])
    return {
        "via": [v.strip() for v in via if v.strip()],
        "eta_min": _minute(value.get("eta_min"), f"{field}.eta_min"),
        "distance_m": _minute(value.get("distance_m"), f"{field}.distance_m"),
        "safety": value["safety"],
        "line": points,
    }


def validate(body: dict[str, Any]) -> dict[str, Any]:
    zones_in = body.get("zones")
    if not isinstance(zones_in, list) or len(zones_in) > MAX_ZONES:
        raise _err(f"`zones` must be a list of at most {MAX_ZONES} zones.")
    zones, seen, routes = [], set(), {}
    for i, zone in enumerate(zones_in):
        if not isinstance(zone, dict):
            raise _err(f"`zones[{i}]` must be an object.")
        zone_id = _text(zone.get("zone_id"), f"zones[{i}].zone_id")
        if zone_id in seen:
            raise _err(f"Duplicate zone `{zone_id}`.")
        seen.add(zone_id)
        order = zone.get("order")
        if not isinstance(order, dict):
            raise _err(f"`zones[{i}].order` must be an object.")
        if order.get("status") not in ORDER_STATUSES:
            raise _err(f"`zones[{i}].order.status` must be one of {', '.join(ORDER_STATUSES)}.")
        destination = order.get("destination_id")
        if destination is not None:
            destination = _text(destination, f"zones[{i}].order.destination_id")
        issued_by = order.get("issued_by")
        if issued_by not in ORDER_ISSUERS:
            raise _err(f"`zones[{i}].order.issued_by` must be ai_agent, controller or null.")
        route = _route(order.get("route"), f"zones[{i}].order.route")
        if route is not None:
            routes[zone_id] = route
        zones.append({
            "zone_id": zone_id,
            "households": _counts(zone.get("households"), f"zones[{i}].households"),
            "people": _counts(zone.get("people"), f"zones[{i}].people", nullable=True),
            "order": {
                "status": order["status"],
                "start_minute": _minute(order.get("start_minute"), f"zones[{i}].order.start_minute", nullable=True),
                "destination_id": destination,
                "issued_by": issued_by,
            },
        })
    totals = body.get("totals")
    if not isinstance(totals, dict):
        raise _err("`totals` must be an object with `households` and `people`.")
    previous = body.get("previous_run_id")
    return {
        "run_id": _text(body.get("run_id"), "run_id"),
        "previous_run_id": None if previous is None else _text(previous, "previous_run_id"),
        "board_minute": _minute(body.get("board_minute"), "board_minute"),
        "zones": zones,
        "routes": routes,
        "totals": {
            "households": _counts(totals.get("households"), "totals.households"),
            "people": _counts(totals.get("people"), "totals.people", nullable=True),
        },
    }


def _body(request) -> dict[str, Any]:
    raw = request.body
    if len(raw) > MAX_BODY_BYTES:
        raise ApiError(413, "too_large", f"Request body exceeds {MAX_BODY_BYTES} bytes.")
    try:
        data = json.loads(raw or b"{}")
    except (ValueError, UnicodeDecodeError) as exc:
        raise _err("Body must be valid JSON.") from exc
    if not isinstance(data, dict):
        raise _err("Body must be a JSON object.")
    return data


# ---- MongoDB ----

# A ``live_household_state`` document, short-keyed to fit the free tier (about 140 B instead of 290 B):
# {_id: "<incident_id>:<household_id>", z: zone_id, x: lon, y: lat, o: occupants, v: vehicles,
#  s: status, m: since_minute, u: updated_at}. The run is the incident's ``live_run_state.run_id``
# (a new run deletes the previous run's documents first), so documents carry no run id.
INDEX_KEYS = [("u", 1)]
"""The one index besides ``_id``: ``changed_since`` polling. Everything else pages the ``_id`` prefix."""


def _households():
    global _index_ready
    states = col(HOUSEHOLDS)
    if not _index_ready:
        # Best effort: index changes are writes; a write-blocked cluster must not break reads.
        try:
            states.create_index(INDEX_KEYS)
            for name in states.index_information():
                if name not in ("_id_", "u_1"):
                    states.drop_index(name)  # the long-keyed design's (incident_id, ...) indexes
            _index_ready = True
        except PyMongoError:
            log.warning("run state: cannot create the household state index")
    return states


def _snapshot_id(incident_id: str) -> str | None:
    doc = col(SNAPSHOTS).find_one({"incident_id": incident_id}, {"_id": 0, "snapshot_id": 1})
    return doc["snapshot_id"] if doc else None


def _id_range(incident_id: str, after: str | None = None) -> dict[str, str]:
    """``_id`` is ``f"{incident_id}:{household_id}"``; ``;`` sorts right after ``:``."""
    return {"$gt": f"{incident_id}:{after or ''}", "$lt": f"{incident_id};"}


def _incident_docs(incident_id: str) -> dict[str, Any]:
    return {"_id": _id_range(incident_id)}


class _Snapshot:
    """A snapshot's households, as the allocation needs them (immutable per ``snapshot_id``)."""

    def __init__(self, snapshot_id: str, rows: list[dict[str, Any]]) -> None:
        self.snapshot_id = snapshot_id
        self.zones: dict[str, list[tuple[str, bool]]] = {}
        self.static: dict[str, dict[str, Any]] = {}
        for row in sorted(rows, key=lambda r: r["household_id"]):
            hid = row["household_id"]
            coords = (row.get("location") or {}).get("coordinates") or [None, None]
            occupants = (row.get("occupants") or {}).get("value")
            vehicles = (row.get("vehicles") or {}).get("value")
            self.zones.setdefault(str(row["zone_id"]), []).append((hid, vehicles == 0))
            self.static[hid] = {"z": str(row["zone_id"]), "x": coords[0], "y": coords[1], "o": occupants,
                                "v": vehicles}


_snapshots: dict[str, _Snapshot] = {}
_snapshots_lock = threading.Lock()


def _load_snapshot(incident_id: str, snapshot_id: str) -> _Snapshot:
    with _snapshots_lock:
        cached = _snapshots.get(snapshot_id)
    if cached is not None:
        return cached
    started = time.monotonic()
    with pymongo.timeout(LONG_OP_S):
        rows = list(col(SNAPSHOT_HOUSEHOLDS).find(
            {"snapshot_id": snapshot_id},
            {"_id": 0, "household_id": 1, "zone_id": 1, "location.coordinates": 1, "occupants.value": 1,
             "vehicles.value": 1},
        ).batch_size(5000))
    snap = _Snapshot(snapshot_id, rows)
    log.info("run state: loaded %d snapshot households of %s in %.1f s", len(rows), incident_id,
             time.monotonic() - started)
    with _snapshots_lock:
        while len(_snapshots) >= SNAPSHOT_CACHE_MAX:
            _snapshots.pop(next(iter(_snapshots)))
        _snapshots[snapshot_id] = snap
    return snap


# ---- per-incident writer ----

class _Writer:
    """Applies the newest PUT of one incident and writes the changed household documents."""

    def __init__(self, incident_id: str) -> None:
        self.incident_id = incident_id
        self.lock = threading.Condition()
        self.write_lock = threading.Lock()
        """Held while a batch or a delete is in flight, so a reset never races a batch."""
        self.epoch = 0
        self.gen = 0
        self.job: dict[str, Any] | None = None
        self.thread: threading.Thread | None = None
        self.run_id: str | None = None
        self.snapshot: _Snapshot | None = None
        self.keys: dict[str, bytes] = {}
        self.target: dict[str, State] = {}
        self.written: dict[str, State] | None = None
        """What MongoDB holds for ``run_id``; None = unknown (reload before writing)."""
        self.dirty: set[str] = set()
        self.run_doc_updated_at = None
        self.result = {"gen": 0, "applied_gen": 0, "changed": None, "written": 0, "pending": None,
                       "state": "idle", "snapshot": None}

    # -- called from requests --

    def submit(self, job: dict[str, Any], prev_updated_at, new_updated_at) -> int:
        with self.lock:
            if self.run_doc_updated_at is not None and prev_updated_at != self.run_doc_updated_at:
                self.written = None  # another process wrote this run: reload before trusting memory
            self.run_doc_updated_at = new_updated_at
            if self.job is not None:
                job["run_changed"] = job["run_changed"] or self.job["run_changed"]
            self.gen += 1
            job["gen"] = self.gen
            job["epoch"] = self.epoch
            self.job = job
            if self.thread is None:
                self.thread = threading.Thread(target=self._loop, name=f"run-state-{self.incident_id}", daemon=True)
                self.thread.start()
            return self.gen

    def wait(self, gen: int, timeout: float) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        with self.lock:
            while self.result["gen"] < gen and self.thread is not None:
                left = deadline - time.monotonic()
                if left <= 0:
                    break
                self.lock.wait(left)
            return dict(self.result)

    def pending(self) -> int | None:
        with self.lock:
            return len(self.dirty) if self.written is not None else None

    def clear(self) -> int:
        """Forget memory and delete the incident's household states."""
        self.reset_memory()
        return self.delete()

    def reset_memory(self) -> None:
        """Cancel queued and in-flight work: the writer drops anything of an older epoch."""
        with self.lock:
            self.epoch += 1
            self.job = None
            self.run_id, self.target, self.written, self.dirty = None, {}, None, set()
            self.run_doc_updated_at = None
            self.result = {**self.result, "state": "cleared"}
            self.lock.notify_all()

    def delete(self) -> int:
        """Delete every household state of the incident. Memory is then unknown, so a run that started
        meanwhile reloads (and rewrites what this deleted) on its next PUT."""
        with self.write_lock, pymongo.timeout(LONG_OP_S):
            deleted = _households().delete_many(_incident_docs(self.incident_id)).deleted_count
        with self.lock:
            self.written, self.dirty = None, set()
        return deleted

    # -- the writer thread --

    def _loop(self) -> None:
        while True:
            with self.lock:
                job, self.job = self.job, None
                if job is None and (not self.dirty or self.written is None):
                    self.thread = None
                    self.lock.notify_all()
                    return
            try:
                if job is not None:
                    self._apply(job)
                self._flush()
            except Exception:  # noqa: BLE001 - the thread must report, not die silently
                log.exception("run state: materialization failed for %s", self.incident_id)
                with self.lock:
                    self.written = None
                    self.dirty = set()
                    self.result = {**self.result, "gen": self.gen, "state": "failed"}
                    self.thread = None
                    self.lock.notify_all()
                return

    def _set_result(self, **fields: Any) -> None:
        with self.lock:
            self.result = {**self.result, **fields}
            self.lock.notify_all()

    def _apply(self, job: dict[str, Any]) -> None:
        epoch = job["epoch"]
        if epoch != self.epoch:
            return
        run_id = job["run_id"]
        if job["run_changed"] or (self.run_id is not None and self.run_id != run_id):
            with self.write_lock, pymongo.timeout(LONG_OP_S):
                _households().delete_many(_incident_docs(self.incident_id))  # the previous run's
                _gc_other_incidents()
            with self.lock:
                if epoch != self.epoch:
                    return
                self.run_id, self.target, self.written, self.dirty, self.keys = run_id, {}, {}, set(), {}
        snapshot_id = _snapshot_id(self.incident_id)
        if snapshot_id is None:
            with self.lock:
                if epoch != self.epoch:
                    return
                self.run_id, self.snapshot, self.target, self.written, self.dirty = run_id, None, {}, {}, set()
            self._set_result(gen=job["gen"], applied_gen=job["gen"], changed=0, written=0, pending=0,
                             state="no_snapshot", snapshot=False)
            return
        self._set_result(state="loading", snapshot=True)
        snapshot = _load_snapshot(self.incident_id, snapshot_id)
        if self.snapshot is not None and self.snapshot.snapshot_id != snapshot_id:
            self.written = None  # the snapshot was re-seeded: household ids may differ
        if self.written is None or self.run_id != run_id:
            if not self._reload(run_id, snapshot, epoch):
                return
        if not self.keys:
            self.keys = {hid: stable_key(run_id, hid) for hid in snapshot.static}
        counts = {z["zone_id"]: z["households"] for z in job["zones"]}
        target = assign_all(snapshot.zones, counts, self.target, job["board_minute"], self.keys)
        moved = changed(self.target, target)
        with self.lock:
            if job["epoch"] != self.epoch:
                return
            self.run_id, self.snapshot, self.target = run_id, snapshot, target
            self.dirty = set(changed(self.written or {}, target))
            self.result = {**self.result, "applied_gen": job["gen"], "changed": len(moved), "written": 0,
                           "pending": len(self.dirty), "state": "writing", "snapshot": True}
            self.lock.notify_all()

    def _reload(self, run_id: str, snapshot: _Snapshot, epoch: int) -> bool:
        """Read what MongoDB holds for the incident (after a restart, another process or a failure).

        False when a reset (``reset_memory``) happened meanwhile: what was read may be deleted by now."""
        prefix = f"{self.incident_id}:"
        with pymongo.timeout(LONG_OP_S):
            docs = list(_households().find(_incident_docs(self.incident_id), {"_id": 1, "s": 1, "m": 1})
                        .batch_size(5000))
        written: dict[str, State] = {}
        stale: list[str] = []
        for d in docs:
            hid = d["_id"][len(prefix):]
            if hid in snapshot.static and d.get("s") in STATUSES and d.get("m") is not None:
                written[hid] = (d["s"], float(d["m"]))
            else:
                stale.append(d["_id"])  # a household the snapshot no longer has, or an older format
        for i in range(0, len(stale), WRITE_BATCH):
            with self.write_lock, pymongo.timeout(LONG_OP_S):
                _households().delete_many({"_id": {"$in": stale[i:i + WRITE_BATCH]}})
        with self.lock:
            if epoch != self.epoch:
                return False
            self.written = written
            self.target = dict(written)
            self.run_id = run_id
            self.keys = {}
        return True

    def _op(self, hid: str, state: State, static: dict[str, Any], now, insert: bool):
        status, since = state
        if insert:
            return InsertOne({"_id": f"{self.incident_id}:{hid}", **static[hid], "s": status, "m": since, "u": now})
        return UpdateOne(
            {"_id": f"{self.incident_id}:{hid}"},
            {"$set": {"s": status, "m": since, "u": now}, "$setOnInsert": static[hid]},
            upsert=True,
        )

    def _flush(self) -> None:
        epoch = self.epoch
        while True:
            with self.lock:
                if self.job is not None or epoch != self.epoch or self.snapshot is None or self.written is None:
                    return
                if not self.dirty:
                    self.result = {**self.result, "gen": max(self.result["gen"], self.result["applied_gen"]),
                                   "pending": 0, "state": "done"}
                    self.lock.notify_all()
                    return
                batch = sorted(self.dirty)[:WRITE_BATCH]
                states = {hid: self.target[hid] for hid in batch}
                static = self.snapshot.static
            with self.write_lock:
                if epoch != self.epoch:
                    return
                now = wall_now()
                known = set(self.written or ())
                ops = [self._op(hid, state, static, now, insert=hid not in known)
                       for hid, state in states.items()]
                with pymongo.timeout(LONG_OP_S):
                    try:
                        _households().bulk_write(ops, ordered=False)
                    except BulkWriteError as exc:
                        # A document this process did not know of exists (another process wrote it):
                        # retry those as upserts; anything else is a real failure.
                        errors = exc.details.get("writeErrors", [])
                        if not errors or any(e.get("code") != 11000 for e in errors):
                            raise
                        retry = [list(states)[e["index"]] for e in errors]
                        _households().bulk_write([self._op(hid, states[hid], static, now, insert=False)
                                                  for hid in retry], ordered=False)
            with self.lock:
                if epoch != self.epoch or self.written is None:
                    return
                for hid, state in states.items():
                    self.written[hid] = state
                    if self.target.get(hid) == state:
                        self.dirty.discard(hid)
                self.result = {**self.result, "written": self.result["written"] + len(ops),
                               "pending": len(self.dirty)}


_writers: dict[str, _Writer] = {}
_writers_lock = threading.Lock()


def _writer(incident_id: str) -> _Writer:
    with _writers_lock:
        return _writers.setdefault(incident_id, _Writer(incident_id))


def _gc_other_incidents() -> None:
    """A new run starts: drop the state of incidents the live API no longer serves (budget)."""
    keep = sorted({incidents.INCIDENT_ID, incidents.active_incident_id()})
    _households().delete_many({"$nor": [_incident_docs(k) for k in keep]})
    col(RUNS).delete_many({"_id": {"$nin": keep}})


def forget(incident_id: str) -> None:
    """Drill reset: delete the incident's run state, the households in the background (best effort; a
    new run's first PUT deletes any leftovers anyway, and one that starts meanwhile rewrites what the
    delete removed on its next PUT, see ``_Writer.delete``)."""
    writer = _writer(incident_id)
    writer.reset_memory()
    try:
        doc = col(RUNS).find_one_and_delete({"_id": incident_id}, {"run_id": 1})
    except PyMongoError:
        log.warning("run state: cannot clear %s on drill reset", incident_id)
        return
    if doc is None:
        return

    def run() -> None:
        try:
            writer.delete()
        except PyMongoError:
            log.warning("run state: cannot delete household states of %s on drill reset", incident_id)

    threading.Thread(target=run, name=f"run-state-clear-{incident_id}", daemon=True).start()


# ---- views ----

def _stale(doc: dict[str, Any], now) -> bool:
    return (now - doc["updated_at"]).total_seconds() > STALE_WRITER_S


def _owned(doc: dict[str, Any]):
    minute = doc.get("board_minute") or 0
    return ok({
        "error": "run_state_owned",
        "detail": f"Another Live console is saving this run's state (since T+{minute:.0f}).",
        "run_id": doc["run_id"], "board_minute": doc.get("board_minute"), "updated_at": iso(doc.get("updated_at")),
    }, status=409)


def _run_json(doc: dict[str, Any]) -> dict[str, Any]:
    out = {k: v for k, v in doc.items() if k != "_id"}
    out["updated_at"] = iso(doc.get("updated_at"))
    return out


@live_view(["GET", "PUT", "DELETE"])
def run_state(request, incident_id: str, principal: Principal):
    if request.method == "GET":
        doc = col(RUNS).find_one({"_id": incident_id})
        if doc is None:
            raise ApiError(404, "not_found", "No run state yet.")
        return ok(_run_json(doc))
    if principal.role != "controller":
        raise ApiError(403, "forbidden", "Only the controller can change the run state.")
    if request.method == "DELETE":
        run_id = request.query_params.get("run_id")
        if not run_id:
            raise ApiError(400, "invalid_request", "`run_id` (the run being reset) is required.")
        old = col(RUNS).find_one({"_id": incident_id}, {"run_id": 1, "board_minute": 1, "updated_at": 1})
        if old is not None and old["run_id"] != run_id and not _stale(old, wall_now()):
            return _owned(old)
        if old is not None and col(RUNS).delete_one({"_id": incident_id, "run_id": old["run_id"]}).deleted_count == 0:
            raise ApiError(409, "conflict", "The run state changed meanwhile; retry.")
        return ok({"deleted_households": _writer(incident_id).clear()})
    fields = validate(_body(request))
    previous_run_id = fields.pop("previous_run_id")
    routes = fields.pop("routes")  # published as resident guidance, not stored with the run
    now = wall_now()
    runs = col(RUNS)
    doc = {"_id": incident_id, "incident_id": incident_id, **fields, "updated_at": now,
           "evidence_class": EVIDENCE_CLASS}
    old = runs.find_one({"_id": incident_id}, {"run_id": 1, "board_minute": 1, "updated_at": 1})
    if old is None:
        try:
            runs.insert_one(doc)
        except DuplicateKeyError as exc:
            raise ApiError(409, "conflict", "Another console started a run at the same moment; retry.") from exc
    else:
        # Single writer: a different run takes over only from the same console (previous_run_id)
        # or from a console that stopped saving (STALE_WRITER_S).
        if old["run_id"] != fields["run_id"] and previous_run_id != old["run_id"] and not _stale(old, now):
            return _owned(old)
        guard = {"_id": incident_id, "run_id": old["run_id"], "updated_at": old["updated_at"]}
        if runs.replace_one(guard, doc).matched_count == 0:
            latest = runs.find_one({"_id": incident_id}, {"run_id": 1, "board_minute": 1, "updated_at": 1})
            if latest is None or latest["run_id"] != fields["run_id"]:
                return _owned(latest) if latest else error(409, "conflict", "The run state was reset meanwhile.")
            old = latest  # the same run saved meanwhile (two requests in flight): last one wins
            runs.replace_one({"_id": incident_id}, doc)
    # This console holds the lease: what its board orders tell residents (board_guidance.py).
    try:
        guidance_published = board_guidance.sync(incident_id, fields["run_id"], fields["board_minute"],
                                                 fields["zones"], routes, now)
    except Exception:  # noqa: BLE001 - guidance must never fail the run-state save; logged
        log.exception("run state: publishing board guidance failed for %s", incident_id)
        guidance_published = None
    writer = _writer(incident_id)
    gen = writer.submit(
        {"run_id": fields["run_id"], "board_minute": fields["board_minute"], "zones": fields["zones"],
         "run_changed": old is not None and old.get("run_id") != fields["run_id"]},
        old.get("updated_at") if old else None, now,
    )
    result = writer.wait(gen, SYNC_WAIT_S)
    current = result["applied_gen"] >= gen
    snapshot = result["snapshot"] if current else _snapshot_id(incident_id) is not None
    state = result["state"] if result["gen"] >= gen or current else "loading"
    return ok({
        "run_id": fields["run_id"],
        "board_minute": fields["board_minute"],
        "households_written": result["written"] if current else 0,
        "households_changed": result["changed"] if current else None,
        "households_pending": result["pending"] if current else None,
        "materialization": state if snapshot else "no_snapshot",
        "snapshot": snapshot,
        "guidance_published": guidance_published,
    })


@live_view(["GET"])
def household_state(request, incident_id: str, principal: Principal):
    params = request.query_params
    try:
        limit = int(params.get("limit") or LIMIT_DEFAULT)
    except ValueError as exc:
        raise ApiError(400, "invalid_request", "`limit` must be an integer.") from exc
    if not 1 <= limit <= LIMIT_MAX:
        raise ApiError(400, "invalid_request", f"`limit` must be 1..{LIMIT_MAX}.")
    status = params.get("status")
    if status and status not in STATUSES:
        raise ApiError(400, "invalid_request", f"`status` must be one of {', '.join(STATUSES)}.")
    changed_since = params.get("changed_since")
    since = parse_iso(changed_since, "changed_since", "invalid_request") if changed_since else None
    as_of = wall_now() - POLL_OVERLAP
    run = col(RUNS).find_one({"_id": incident_id}, {"run_id": 1, "board_minute": 1})
    if run is None:
        raise ApiError(404, "not_found", "No run state yet.")
    body: dict[str, Any] = {
        "incident_id": incident_id, "run_id": run["run_id"], "board_minute": run["board_minute"],
        "snapshot": True, "households": [], "next": None, "as_of": iso(as_of),
        "evidence_class": EVIDENCE_CLASS,
    }
    if _snapshot_id(incident_id) is None:
        body["snapshot"] = False
        body["reason"] = ("No resource snapshot for this incident, so the board's zone counts cannot be "
                          "allocated to households; run live_seed_snapshots.")
        return ok(body)
    # Status and zone filters run on the incident's _id range (at most one snapshot's households).
    query: dict[str, Any] = {"_id": _id_range(incident_id, params.get("after")), "s": {"$in": list(STATUSES)}}
    if status:
        query["s"] = status
    if params.get("zone_id"):
        query["z"] = params["zone_id"]
    if since is not None:
        query["u"] = {"$gt": since}
    with pymongo.timeout(60):
        docs = list(_households().find(query, {"u": 0}).sort("_id", 1).limit(limit + 1).batch_size(limit + 1))
    more = len(docs) > limit
    prefix = len(incident_id) + 1
    rows = [{"household_id": d["_id"][prefix:], "zone_id": d.get("z"), "lon": d.get("x"), "lat": d.get("y"),
             "status": d["s"], "since_minute": d.get("m"), "occupants": d.get("o"), "vehicles": d.get("v")}
            for d in docs[:limit]]
    body["households"] = rows
    body["next"] = rows[-1]["household_id"] if more else None
    body["households_pending"] = _writer(incident_id).pending()
    return ok(body)
