"""The real-time traffic twin (ADR 0013, docs/twin-api.md) inside the live API process.

One ``sim.twin.Twin`` per incident per process, built from the incident's inputs (Camp: the
packages the drill bundle was built from; a Studio drill package: its own roads, synthetic
zones and simulated fire, ``sim.twin.package_inputs``) at the drill's ``replay_start`` and advanced to ``replay_now`` whenever it is read.
Before each read the twin is synced with the drill's decisions, as labeled simulated
commands (history is never altered):

- a road block guidance avoids (public, ``guidance_blocked_segments``) or a controller
  confirmed -> ``close_road`` (``mode: hard``, actor ``field_report``); when the segment
  leaves that set -> ``reopen_road``. What-if forks start from the synced session, so they
  see the same closures;
- a published ``evacuate_now`` level -> ``order_zone``;
- a published destination -> ``reroute_zone`` (cleared guidance -> ``reroute_zone`` null).

Each command is applied at the drill time it was published or confirmed, or at the twin's
next step when that time has already passed. The session is rebuilt from ``replay_start``
when the drill restarts (its ``started_at`` or ``replay_start`` changes) or its clock moves
back. The inputs (history, scenario, fire timeline) are built once per process in a
background thread on first use, per incident; until then reads raise ``TwinUnavailable("warming")``.
Destinations use the planner's road nodes (``livecore.routing``: an exit node without
in-edges is snapped to the nearest reachable node), so the twin routes to the same nodes
the published guidance does. Twin calls are serialized by a per-incident lock.
"""

from __future__ import annotations

import dataclasses
import logging
import os
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from django.conf import settings
from livecore import drill as drillmod
from livecore import routing
from livecore.geo import simplify_line
from livecore.drill import INCIDENT_ID
from livecore.public import controller_blocked_segments

from . import incidents
from .common import iso
from .drillcache import get_index
from .state import Snapshot, current_guidance

log = logging.getLogger(__name__)

REPO_ROOT = Path(os.environ.get("CRISISTWIN_REPO_ROOT") or Path(settings.BASE_DIR).resolve().parent.parent)
"""Holds ``sim/``, ``tools/`` and ``data/``. Docker mounts them under ``/repo`` (only ``app/backend`` is ``/app``)."""
CAMP_PACKAGE = "data/incidents/camp-2018-paradise-slice/a6d2cc03f525ed65"
CAMP_ROADS_PACKAGE = "data/incidents/camp-2018-evacuation/17e67cfe5669fe50"
"""The packages ``app/public/replays/camp-2018.json`` was built from (its ``generated_by``)."""
TWIN_DEMAND = "auto"
TWIN_SEED = 7
"""The bundle's ``traffic.model.seed`` (``TrafficParams.seed``)."""
LOCK_TIMEOUT_S = 20.0
"""A read waits at most this long for another twin call (e.g. a what-if) before ``busy``."""
TOP_EDGES = 15
TRAFFIC_EDGES = 2500
"""``traffic`` lists at most this many occupied edges, most vehicles first."""
API_MAX_HORIZON_MIN = 120
"""HTTP what-ifs are capped below the twin's own limit to bound request time."""
BLOCK_ACTOR = {"kind": "field_report", "id": "controller-confirmed"}
PUBLIC_BLOCK_ACTOR = {"kind": "field_report", "id": "public-block"}
GUIDANCE_ACTOR_ID = "live-guidance"


class TwinUnavailable(Exception):
    """``code``: warming | failed | finished | busy."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


def _import_sim():
    root = str(REPO_ROOT)
    if root not in sys.path:
        sys.path.append(root)
    # Never fetch package artifacts from MONGODB_URI here: that is the live database, not Atlas.
    os.environ.setdefault("CRISISTWIN_DATA_SOURCE", "local")
    from sim import twin as twinmod

    return twinmod


def _package(name: str, default: str) -> Path:
    value = (getattr(settings, name, "") or "").strip() or default
    path = Path(value)
    return path if path.is_absolute() else REPO_ROOT / path


# ---- inputs (built once per incident per process) ----

_inputs_lock = threading.Lock()
_inputs: dict[str, dict[str, Any]] = {}
"""Incident id -> ``{status: idle|warming|ready|failed, error, inputs, seconds}``."""


FAILED_RETRY_S = 300.0
"""A failed build is retried by the next read after this long."""


def _state(incident_id: str) -> dict[str, Any]:
    return _inputs.setdefault(incident_id, {"status": "idle", "error": None, "inputs": None, "seconds": None})


def _planner_destinations(inputs, twinmod, destination_nodes) -> tuple[Any, dict[str, tuple[str, str]]]:
    """``inputs`` with each destination on the planner's node (``routing._index(drill).destination_nodes``).

    Returns the new inputs (fresh cache, recomputed fingerprint) and ``{dest id: (old, new)}``
    for the destinations that moved; the inputs unchanged when none did."""
    net_nodes = inputs.scenario["network"].nodes
    moved: dict[str, tuple[str, str]] = {}
    dests = []
    for d in inputs.scenario["destinations"]:
        node = destination_nodes.get(d.id)
        if node and node != d.node_id and node in net_nodes:
            moved[d.id] = (d.node_id, node)
            d = dataclasses.replace(d, node_id=node)
        dests.append(d)
    if not moved:
        return inputs, moved
    scenario = {**inputs.scenario, "destinations": dests}
    fingerprint = twinmod.inputs_fingerprint(scenario, inputs.params, inputs.start, inputs.end,
                                             inputs.fire_model_meta)
    return dataclasses.replace(inputs, scenario=scenario, fingerprint=fingerprint, cache={}), moved


def build_camp_inputs(seed: int = TWIN_SEED):
    """The Camp twin inputs the live drill uses (destinations on the planner's road nodes), built
    synchronously. ``seed``: ``TrafficParams.seed``. Used by the background warm-up and by
    headless experiments (``live_compare_record``)."""
    twinmod = _import_sim()
    inputs = twinmod.camp_inputs(
        _package("LIVE_TWIN_PACKAGE", CAMP_PACKAGE),
        _package("LIVE_TWIN_ROADS_PACKAGE", CAMP_ROADS_PACKAGE),
        TWIN_DEMAND,
        seed,
    )
    return _finish_inputs(inputs, twinmod, INCIDENT_ID)


def build_package_inputs(incident_id: str, seed: int = TWIN_SEED):
    """Twin inputs of a Studio drill package incident (``sim.twin.package_inputs``), built synchronously."""
    source = incidents.source_for(incident_id)
    if source is None or source.kind != "package":
        raise ValueError(f"no twin source for incident {incident_id}")
    twinmod = _import_sim()
    return _finish_inputs(twinmod.package_inputs(source.path, seed), twinmod, incident_id)


def build_inputs(incident_id: str, seed: int = TWIN_SEED):
    return build_camp_inputs(seed) if incident_id == INCIDENT_ID else build_package_inputs(incident_id, seed)


def _finish_inputs(inputs, twinmod, incident_id: str):
    inputs, moved = _planner_destinations(inputs, twinmod, routing._index(get_index(incident_id).drill).destination_nodes)
    if moved:
        log.info("live twin: %d destinations moved to the planner's road node: %s", len(moved),
                 ", ".join(f"{k} {a}->{b}" for k, (a, b) in sorted(moved.items())))
    twinmod._template(inputs)  # engine at the scenario start + the shared FireTimeline (the slow part)
    return inputs


def _build_inputs(incident_id: str) -> None:
    t0 = time.perf_counter()
    try:
        inputs = build_inputs(incident_id)
    except Exception as exc:  # noqa: BLE001 - any failure means "no twin"; the rule controller takes over
        log.exception("live twin: building the twin inputs of %s failed", incident_id)
        with _inputs_lock:
            _state(incident_id).update(status="failed", error=f"{type(exc).__name__}: {exc}",
                                       failed_at=time.monotonic())
        return
    seconds = round(time.perf_counter() - t0, 1)
    with _inputs_lock:
        _state(incident_id).update(status="ready", inputs=inputs, seconds=seconds)
    log.info("live twin: %s inputs ready in %.1f s (fingerprint %s)", incident_id, seconds, inputs.fingerprint)


def warm(incident_id: str | None = None) -> str:
    """Start building the incident's inputs in the background (once). Returns the current status.

    ``incident_id`` defaults to the request's incident, else the active one."""
    incident_id = incident_id or incidents.request_incident()
    with _inputs_lock:
        state = _state(incident_id)
        if state["status"] == "failed" and time.monotonic() - state.get("failed_at", 0.0) > FAILED_RETRY_S:
            state["status"] = "idle"  # e.g. a package written after a failed first build
        if state["status"] == "idle":
            state["status"] = "warming"
            threading.Thread(target=_build_inputs, args=(incident_id,), name=f"live-twin-warm-{incident_id}",
                             daemon=True).start()
        return state["status"]


def status(incident_id: str | None = None) -> dict[str, Any]:
    incident_id = incident_id or incidents.request_incident()
    with _inputs_lock:
        state = _state(incident_id)
        return {"status": state["status"], "error": state["error"], "build_s": state["seconds"]}


def _ready_inputs(incident_id: str):
    state = warm(incident_id)
    if state == "warming":
        raise TwinUnavailable("warming", "The twin is loading its inputs; retry in a few seconds.")
    if state == "failed":
        raise TwinUnavailable("failed", f"The twin could not be built: {_inputs[incident_id]['error']}")
    return _inputs[incident_id]["inputs"]


# ---- per-incident session ----


@dataclass
class _Session:
    lock: threading.Lock = field(default_factory=threading.Lock)
    twin: Any = None
    built_from: str | None = None
    started_at: datetime | None = None
    replay_start: datetime | None = None
    speed: float = 0.0
    """The drill clock (doc ``started_at`` / ``replay_start`` / ``speed``) the session follows.
    A change that does not continue it (``_restarted``) means a reset or restart: rebuild."""
    zone_version: dict[str, int] = field(default_factory=dict)
    """Zone id -> latest guidance version handled; a lower or missing version means a reset."""
    blocks: dict[str, str] = field(default_factory=dict)
    """Segment id -> action id of the twin closure in effect."""
    zone_dest: dict[str, str | None] = field(default_factory=dict)
    """Zone id -> destination last commanded (None = cleared)."""
    guidance_seen: set[tuple[str, int, str | None]] = field(default_factory=set)
    """(zone id, guidance version, published_at ISO) already turned into commands; versions
    restart at 1 after a drill reset, so the version alone is not unique."""
    injects: dict[str, dict[str, str]] = field(default_factory=dict)
    """Inject id -> ``{type, segment_id?}`` of the drill injects already commanded (``inject:`` keys)."""
    errors: list[dict[str, Any]] = field(default_factory=list)
    """Recent rejected commands, newest last (bounded)."""
    seq: int = 0


_sessions: dict[str, _Session] = {}
_sessions_lock = threading.Lock()
MAX_ERRORS_KEPT = 20


def _session(incident_id: str) -> _Session:
    with _sessions_lock:
        return _sessions.setdefault(incident_id, _Session())


def _replay_time(snapshot: Snapshot, wall: datetime | None) -> datetime:
    """Drill time at wall time ``wall`` under the current clock (``replay_start`` when unknown or earlier)."""
    clock = snapshot.clock
    if wall is None or clock.started_at is None or wall < clock.started_at:
        return clock.replay_start
    if wall.tzinfo is None:
        wall = wall.replace(tzinfo=clock.replay_start.tzinfo)
    return drillmod.replay_now(clock.replay_start, clock.started_at, wall, clock.speed, snapshot.index.drill.clock_end)


def _new_id(sess: _Session, prefix: str) -> str:
    sess.seq += 1
    return f"{prefix}{sess.seq}"


def _guidance_key(doc: dict[str, Any]) -> tuple[str, int, str | None]:
    return (doc["zone_id"], int(doc["version"]), iso(doc.get("published_at")))


def _closed_segments(snapshot: Snapshot) -> tuple[frozenset[str], frozenset[str]]:
    """(segments the twin closes, the controller-confirmed subset): every block guidance avoids
    (``Snapshot.blocked``, public ``guidance_blocked_segments``) plus controller-confirmed ones."""
    confirmed = controller_blocked_segments(snapshot.road_state)
    return frozenset(snapshot.blocked) | confirmed, confirmed


def _desired_commands(sess: _Session, snapshot: Snapshot) -> list[tuple[datetime, str, dict[str, Any], Any]]:
    """(drill time, key, action, guidance key) not yet applied, from road blocks and published guidance.

    An entry with an empty action marks a guidance version (its guidance key) as handled."""
    index = snapshot.index
    out: list[tuple[datetime, str, dict[str, Any], Any]] = []
    closed, confirmed = _closed_segments(snapshot)
    status_by_segment = {s.segment_id: s for s in snapshot.road_state}
    for seg in sorted(closed - set(sess.blocks)):
        edge_ids = list(index.drill.roads.segment_edges.get(seg, ()))
        if not edge_ids:
            continue
        name = index.segment_names.get(seg) or "unnamed road"
        status = status_by_segment.get(seg)
        if seg in confirmed:
            actor, why = BLOCK_ACTOR, f"Controller confirmed {name} blocked"
        else:
            actor, why = PUBLIC_BLOCK_ACTOR, f"Public road block: {name}"
        out.append((
            _replay_time(snapshot, status.last_observed_at if status else None),
            f"block:{seg}",
            {"type": "close_road", "target": {"edge_ids": edge_ids}, "params": {"mode": "hard"},
             "actor": dict(actor), "rationale": why},
            None,
        ))
    for seg in sorted(set(sess.blocks) - closed):
        edge_ids = list(index.drill.roads.segment_edges.get(seg, ()))
        out.append((
            snapshot.clock.replay_now,
            f"reopen:{seg}",
            {"type": "reopen_road", "target": {"edge_ids": edge_ids}, "params": {},
             "actor": dict(BLOCK_ACTOR), "rationale": "Block no longer in effect"},
            None,
        ))
    out.extend(_inject_commands(sess, snapshot))
    for doc in current_guidance(snapshot.incident_id, index):
        gkey = _guidance_key(doc)
        if gkey in sess.guidance_seen:
            continue
        zone_id = doc["zone_id"]
        when = _replay_time(snapshot, doc.get("published_at"))
        actor = {"kind": "controller", "id": f"{GUIDANCE_ACTOR_ID}:{doc.get('approved_by') or 'controller'}"}
        why = f"Published guidance v{doc['version']} ({doc.get('proposal_id')})"
        if doc["level"] == "evacuate_now":
            out.append((when, f"order:{zone_id}:{doc['version']}",
                        {"type": "order_zone", "target": {"zone_id": zone_id}, "params": {}, "actor": actor,
                         "rationale": why}, None))
        dest = (doc.get("destination") or {}).get("id") if doc["level"] != "none" and not doc.get("no_route") else None
        if dest != sess.zone_dest.get(zone_id) and (dest is not None or zone_id in sess.zone_dest):
            out.append((when, f"route:{zone_id}:{doc['version']}",
                        {"type": "reroute_zone", "target": {"zone_id": zone_id}, "params": {"destination_id": dest},
                         "actor": actor, "rationale": why}, None))
        out.append((when, f"seen:{zone_id}:{doc['version']}", {}, gkey))
    out.sort(key=lambda c: (c[0], c[1]))
    return out


def _inject_commands(sess: _Session, snapshot: Snapshot) -> list[tuple[datetime, str, dict[str, Any], Any]]:
    """Twin commands of drill injects (``api.live.injects``): a silent closure closes the road and a
    full shelter fills the destination, from the inject's drill time. Operator commands labeled
    ``Injected``; no report is created, so guidance and the public map do not know. A deleted
    silent closure reopens its road; a full shelter cannot be undone (until the drill restarts)."""
    index = snapshot.index
    out: list[tuple[datetime, str, dict[str, Any], Any]] = []
    due = {
        d["id"]: d for d in getattr(snapshot, "injects", ())
        if d["type"] in ("silent_closure", "shelter_full") and d["at"] <= snapshot.clock.replay_now
    }
    names = {d.id: d.name for d in index.drill.destinations}
    for inj_id, doc in sorted(due.items()):
        if inj_id in sess.injects:
            continue
        actor = {"kind": "operator", "id": f"inject:{inj_id}"}
        if doc["type"] == "silent_closure":
            seg = doc["params"]["segment_id"]
            edge_ids = list(index.drill.roads.segment_edges.get(seg, ()))
            if not edge_ids:
                continue
            name = index.segment_names.get(seg) or "unnamed road"
            action = {"type": "close_road", "target": {"edge_ids": edge_ids}, "params": {"mode": "hard"},
                      "actor": actor, "rationale": f"Injected (simulated): {name} closed, no report"}
        else:
            dest = doc["params"]["destination_id"]
            action = {"type": "fill_destination", "target": {"destination_id": dest}, "params": {},
                      "actor": actor, "rationale": f"Injected (simulated): {names.get(dest, dest)} full"}
        out.append((doc["at"], f"inject:{inj_id}", action, None))
    for inj_id, info in sorted(sess.injects.items()):
        if inj_id not in due and info["type"] == "silent_closure":
            edge_ids = list(index.drill.roads.segment_edges.get(info["segment_id"], ()))
            out.append((snapshot.clock.replay_now, f"injectoff:{inj_id}",
                        {"type": "reopen_road", "target": {"edge_ids": edge_ids}, "params": {},
                         "actor": {"kind": "operator", "id": f"inject:{inj_id}"},
                         "rationale": "Injected (simulated): closure removed"}, None))
    return out


CLOCK_CONTINUITY_S = 1.0


def _restarted(sess: _Session, snapshot: Snapshot) -> str | None:
    """Why the session no longer follows the drill (a reset or restart), or None.

    ``set_speed`` also rewrites ``started_at`` and ``replay_start``, but continues the drill
    time: the new ``replay_start`` equals the old clock's drill time at the new ``started_at``.
    Any other change of either field is a restart. A reset also deletes published guidance,
    so a zone whose latest version went down (or vanished) means a reset even when the new
    clock happens to continue the old one."""
    clock = snapshot.clock
    if (clock.started_at, clock.replay_start) != (sess.started_at, sess.replay_start):
        if clock.started_at is None or sess.replay_start is None:
            return "drill reset"
        expected = drillmod.replay_now(sess.replay_start, sess.started_at, clock.started_at, sess.speed,
                                       snapshot.index.drill.clock_end)
        if abs((clock.replay_start - expected).total_seconds()) > CLOCK_CONTINUITY_S:
            return "drill restarted"
    if sess.zone_version:
        current = {d["zone_id"]: int(d["version"]) for d in current_guidance(snapshot.incident_id, snapshot.index)}
        if any(current.get(z, 0) < v for z, v in sess.zone_version.items()):
            return "published guidance was reset"
    return None


def _sync(sess: _Session, snapshot: Snapshot, twinmod) -> None:
    """Advance the twin to the drill's ``replay_now``, applying new commands at their drill times."""
    inputs = _ready_inputs(snapshot.incident_id)
    clock = snapshot.clock
    target = min(clock.replay_now, inputs.end)
    if sess.twin is not None:
        why = _restarted(sess, snapshot)
        if why:
            log.info("live twin: %s (replay_start %s); rebuilding", why, iso(clock.replay_start))
            sess.twin = None
    if sess.twin is not None and twinmod.parse_utc(sess.twin.now) > target:
        log.info("live twin: drill clock moved back to %s; rebuilding", iso(target))
        sess.twin = None
    if sess.twin is None:
        twin_zones = {z.id for z in inputs.scenario["zones"]}
        twin_dests = {d.id for d in inputs.scenario["destinations"]}
        if twin_zones != set(snapshot.index.zones) or not set(snapshot.index.destinations) <= twin_dests:
            raise TwinUnavailable("failed", "The twin inputs do not match the drill bundle's zones and destinations.")
        start = max(min(clock.replay_start, target), inputs.start)
        sess.twin = twinmod.Twin.from_inputs(inputs, start_at=iso(start), session_id=f"{snapshot.incident_id}:live")
        sess.built_from = iso(start)
        sess.blocks.clear()
        sess.injects.clear()
        sess.zone_dest.clear()
        sess.guidance_seen.clear()
        sess.zone_version.clear()
        sess.errors.clear()
        sess.seq = 0
    sess.started_at, sess.replay_start, sess.speed = clock.started_at, clock.replay_start, clock.speed
    twin = sess.twin
    for when, key, action, gkey in _desired_commands(sess, snapshot):
        if twin.finished:
            break
        if not action:  # guidance version fully handled
            sess.guidance_seen.add(gkey)
            sess.zone_version[gkey[0]] = max(gkey[1], sess.zone_version.get(gkey[0], 0))
            continue
        when = min(max(when, twinmod.parse_utc(twin.now)), target)
        twin.step_to(iso(when))
        action = {**action, "id": _new_id(sess, "live-")}
        try:
            record = twin.apply(action)["action"]
        except twinmod.ActionError as exc:
            if exc.code in ("already_ordered", "not_closed", "fire_closed_not_reopenable", "already_full"):
                record = None  # the state the command asks for already holds
            else:
                sess.errors = (sess.errors + [{"key": key, **exc.to_dict(), "at": twin.now}])[-MAX_ERRORS_KEPT:]
                log.warning("live twin: %s rejected: %s", key, exc)
                continue  # retried on the next sync (e.g. limit_exceeded)
        kind, rest = key.split(":", 1)
        if kind == "block":
            sess.blocks[rest] = record["id"] if record else ""
        elif kind == "reopen":
            sess.blocks.pop(rest, None)
        elif kind == "inject":
            doc = next(d for d in getattr(snapshot, "injects", ()) if d["id"] == rest)
            sess.injects[rest] = {"type": doc["type"], "segment_id": doc["params"].get("segment_id", "")}
        elif kind == "injectoff":
            sess.injects.pop(rest, None)
        elif kind == "route":
            sess.zone_dest[rest.rsplit(":", 1)[0]] = action["params"]["destination_id"]
    if not twin.finished:
        twin.step_to(iso(target))


def _with_twin(snapshot: Snapshot, fn, lock_timeout_s: float = LOCK_TIMEOUT_S):
    twinmod = _import_sim()
    sess = _session(snapshot.incident_id)
    if not sess.lock.acquire(timeout=lock_timeout_s):
        raise TwinUnavailable("busy", "The twin is busy with another request; retry shortly.")
    try:
        _sync(sess, snapshot, twinmod)
        return fn(sess, sess.twin, twinmod)
    finally:
        sess.lock.release()


# ---- public API ----


def ensure_ready(incident_id: str | None = None) -> bool:
    """True when the incident's inputs are built (starts warming otherwise)."""
    return warm(incident_id) == "ready"


def whatif(snapshot: Snapshot, action_sets: list, horizon_min: float, fire_ahead: str,
           labels: list | None = None) -> dict[str, Any]:
    """``Twin.whatif`` on the synced session; raises ``TwinUnavailable`` or ``sim.twin.TwinError``."""

    def run(sess, twin, twinmod):
        if twin.finished:
            raise TwinUnavailable("finished", "The drill clock has reached the end of the replay.")
        return twin.whatif(action_sets, horizon_min=horizon_min, fire_ahead=fire_ahead, labels=labels)

    return _with_twin(snapshot, run)


def whatif_with_zones(snapshot: Snapshot, action_sets: list, horizon_min: float, fire_ahead: str,
                      labels: list | None = None) -> tuple[dict[str, Any], dict[str, int]]:
    """``whatif`` plus each zone's vehicles not yet arrived at the fork (one locked call, same state)."""

    def run(sess, twin, twinmod):
        if twin.finished:
            raise TwinUnavailable("finished", "The drill clock has reached the end of the replay.")
        zones = {z["id"]: int(z["not_departed_veh"]) + int(z["en_route_veh"])
                 for z in twin.snapshot(detail="full")["zones"]}
        report = twin.whatif(action_sets, horizon_min=horizon_min, fire_ahead=fire_ahead, labels=labels)
        return report, zones

    return _with_twin(snapshot, run)


def twin_closed_segments(snapshot: Snapshot) -> frozenset[str]:
    """Segments the synced twin closes: every block guidance avoids plus controller-confirmed ones."""
    return _closed_segments(snapshot)[0]


def validate_each(snapshot: Snapshot, actions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The actions the synced twin would accept now (each checked alone)."""

    def run(sess, twin, twinmod):
        ok = []
        for a in actions:
            try:
                twin.validate(a)
                ok.append(a)
            except twinmod.ActionError:
                pass
        return ok

    return _with_twin(snapshot, run)


def is_twin_error(exc: BaseException) -> bool:
    return isinstance(exc, _import_sim().TwinError)


def _unreachable_published(snapshot: Snapshot, zones: list[dict[str, Any]], dest_names: dict[str, str],
                           at: str) -> list[dict[str, Any]]:
    """``command_errors``-style entries for zones whose published destination the twin cannot reach
    (assignment status ``fallback_unreachable``): the twin then routes them to the nearest open exit."""
    published = {
        d["zone_id"]: (d.get("destination") or {}).get("id")
        for d in current_guidance(snapshot.incident_id, snapshot.index)
        if d["level"] != "none" and not d.get("no_route")
    }
    out = []
    for z in zones:
        a = z["assignment"]
        if not a or a["status"] != "fallback_unreachable" or published.get(z["id"]) != a["destination_id"]:
            continue
        zone = snapshot.index.zones.get(z["id"])
        name = getattr(zone, "name", None) or z["id"]
        dest = dest_names.get(a["destination_id"]) or a["destination_id"]
        out.append({
            "key": f"unreachable:{z['id']}", "error": "destination_unreachable", "code": "fallback_unreachable",
            "detail": f"{name}: published destination {dest} is unreachable in the twin; "
                      "it routes to the nearest open exit instead",
            "action_id": a["action_id"], "at": at,
        })
    return out


def edge_speeds(snapshot: Snapshot, lock_timeout_s: float = 2.0) -> dict[str, tuple[int, float, float]]:
    """Directed edge id -> (vehicles, mean speed kph, free-flow kph) for the occupied edges of the
    synced twin at the drill's ``replay_now``. Simulated. Raises ``TwinUnavailable`` (warming,
    failed, busy) or ``sim.twin.TwinError``; waits at most ``lock_timeout_s`` for the lock."""

    return _with_twin(snapshot, lambda sess, twin, twinmod: edge_speed_rows(twin), lock_timeout_s)


def edge_speeds_at(snapshot: Snapshot, lock_timeout_s: float = 2.0) -> tuple[str, dict[str, tuple[int, float, float]]]:
    """``(twin clock ISO, edge_speeds)`` from one locked read: the simulated drill time the speeds
    describe, for the planner's ``inputs.congestion`` label. Same errors as ``edge_speeds``."""

    return _with_twin(snapshot, lambda sess, twin, twinmod: (twin.now, edge_speed_rows(twin)), lock_timeout_s)


def destination_arrivals(snapshot: Snapshot, lock_timeout_s: float = 2.0) -> dict[str, tuple[int, int]]:
    """Destination id -> (arrived vehicles, arrived in the last 10 simulated minutes) from the synced
    twin's summary snapshot. Simulated. Same errors as ``edge_speeds``."""

    def run(sess, twin, twinmod):
        return {d["id"]: (int(d["arrived_veh"]), int(d["arrived_last_10_min_veh"]))
                for d in twin.snapshot(detail="summary")["destinations"]}

    return _with_twin(snapshot, run, lock_timeout_s)


def edge_speed_rows(twin) -> dict[str, tuple[int, float, float]]:
    """Directed edge id -> (vehicles, mean speed kph, free-flow kph) for the occupied edges of
    ``twin`` (a ``sim.twin.Twin``) at its ``now``. Simulated."""
    engine = twin.engine
    edges = engine.s.edges
    return {edges[i].id: (n, speed, edges[i].speed_kph) for i, n, speed, _ in engine.edge_rows(engine.now_s or 0)}


def monitor(snapshot: Snapshot) -> dict[str, Any]:
    """Compact snapshot for the monitoring page (docs/twin-api.md "HTTP adapter")."""

    def run(sess, twin, twinmod):
        snap = twin.snapshot(detail="full")
        index = snapshot.index
        edges = twin.engine.s.edges
        rows = snap["edges"]["rows"]
        congested = sorted((r for r in rows if r[3] > 0), key=lambda r: (-r[3], -r[1], r[0]))[:TOP_EDGES]
        top = []
        for i, veh, speed, queued in congested:
            e = edges[i]
            mid = e.coords[len(e.coords) // 2]
            top.append({
                "edge_index": i, "edge_id": e.id, "segment_id": e.segment_id,
                "name": index.segment_names.get(e.segment_id) or e.name or None,
                "veh": veh, "queued_veh": queued, "speed_kph": speed, "free_flow_kph": e.speed_kph,
                "coord": [mid[0], mid[1]],
            })
        # Where the simulated vehicles are: every occupied directed edge, so the map draws the
        # stream itself (it grows as zones depart and drains as vehicles arrive). Simulated.
        occupied = sorted((r for r in rows if r[1] > 0), key=lambda r: (-r[1], r[0]))[:TRAFFIC_EDGES]
        traffic = [
            {
                "line": [[round(x, 5), round(y, 5)] for x, y in simplify_line(edges[i].coords, 12.0, 12)],
                "veh": veh,
                "queued_veh": queued,
                "speed_kph": speed,
                "free_flow_kph": edges[i].speed_kph,
            }
            for i, veh, speed, queued in occupied
        ]
        totals = snap["totals"]
        conserved = totals["not_departed_veh"] + totals["en_route_veh"] + totals["arrived_veh"] == totals["total_veh"]
        assigned: dict[str, int] = {}
        for z in snap["zones"]:
            if z["assignment"]:
                assigned[z["assignment"]["destination_id"]] = assigned.get(z["assignment"]["destination_id"], 0) + 1
        destinations = [
            {**{k: d[k] for k in ("id", "name", "kind", "status", "arrived_veh", "capacity_veh",
                                  "remaining_capacity_veh", "arrived_last_10_min_veh", "full_at")},
             "assigned_zones": assigned.get(d["id"], 0)}
            for d in snap["destinations"]
            if d["arrived_veh"] > 0 or assigned.get(d["id"]) or d["kind"] != "exit" and d["status"] != "closed"
        ]
        destinations.sort(key=lambda d: (-d["arrived_veh"], -d["assigned_zones"], d["id"]))
        dest_names = {d["id"]: d["name"] for d in snap["destinations"]}
        unreachable = _unreachable_published(snapshot, snap["zones"], dest_names, twin.now)
        return {
            "kind": "crisistwin_live_twin",
            "incident_id": snapshot.incident_id,
            "evidence_class": "simulated",
            "label": "Simulated traffic twin of the exercise. Planning experiment, not observations.",
            "drill_replay_now": iso(snapshot.clock.replay_now),
            "clock": snap["clock"],
            "model": snap["model"],
            "built_from": sess.built_from,
            "totals": totals,
            "conserved": conserved,
            "zones": [
                {k: z[k] for k in ("id", "vehicles", "ordered_at", "not_departed_veh", "en_route_veh", "arrived_veh",
                                   "blocked_veh", "exposed_veh", "exposed_at_origin_veh", "assignment")}
                for z in snap["zones"]
            ],
            "congested_edges": top,
            "traffic": traffic,
            "destinations": destinations,
            "closed_edges": len(snap["closed"]["rows"]),
            "commands": [
                {**{k: a.get(k) for k in ("id", "type", "label", "effective_at", "status", "actor", "rationale")},
                 **({"label": a["rationale"]} if str(a["actor"].get("id", "")).startswith("inject:") else {})}
                for a in twin.action_log()
            ],
            "command_errors": list(sess.errors) + unreachable,
            "limitations": [
                "Simulated by an uncalibrated meso traffic model on the replay's demand; not observed traffic.",
                "Drill decisions enter as labeled simulated commands; historical events are unchanged.",
                # A Studio package's twin states its synthetic-demand assumptions (sim.twin.PACKAGE_ASSUMPTIONS).
                *(twin.inputs.scenario.get("notes") or [] if snapshot.incident_id != INCIDENT_ID else []),
            ],
        }

    return _with_twin(snapshot, run)
