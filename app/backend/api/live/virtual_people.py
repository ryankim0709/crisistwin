"""Simulated people ("virtual phones") on the server: storage, ticking and endpoints (docs/app-integration.md
"Simulated people"). The behaviour itself is pure and lives in ``livecore.virtual_people``.

- ``POST incidents/{id}/virtual-people`` ``{count, seed?}`` adds simulated households (controller);
- ``GET`` lists them; ``DELETE`` removes them (their reports are withdrawn, check-ins and choices deleted);
- ``list_participants(incident_id)`` is what the App integration participants endpoint merges in.

Each person is a civilian device marked ``simulated`` (token derived from the server secret), so everything it
does goes through the very view functions a phone calls (``views.checkins``, ``views.incident_reports``,
``views.my_destination``, ``views.my_report``): same validation, rate limits, comms-outage refusals and storage,
labelled ``evidence_class: simulated`` / ``simulated: true`` by the device flag.

Ticking: ``tick(incident_id)`` advances every person one drill minute at a time up to the drill clock's current
minute. It runs whenever the drill is read by the console (``GET command``), by ``GET virtual-people`` and by
``list_participants``, and from ``manage.py live_virtual_people`` for a headless drill. A lease on the incident's
run document makes it safe under concurrent requests: one request ticks, the others return at once, and each
drill minute is processed once per person (``state.ticked_to``). A drill reset or restart (the clock does not
continue) puts everyone back home and starts a new ``epoch`` (fresh report ids).
"""

from __future__ import annotations

import bisect
import hashlib
import hmac
import json
import logging
import threading
import uuid
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from typing import Any

from django.conf import settings
from django.test import RequestFactory
from pymongo import ReturnDocument, UpdateOne

from livecore import drill as drillmod
from livecore import routing
from livecore import virtual_people as vp
from livecore.fire import estimate_fire
from livecore.geo import haversine_m, simplify_line

from . import injects as injects_mod
from . import twin_service
from .auth import CIVILIAN_TOKEN_TTL, Principal, live_view, token_hash
from .common import col, error, iso, json_body, ok, wall_now
from .drillcache import get_index
from .state import clock_from, drill_doc, load_snapshot

log = logging.getLogger(__name__)

PEOPLE = "live_virtual_people"
RUNS = "live_virtual_runs"
MAX_PEOPLE = 200
"""At most this many simulated people per incident (one POST adds 1-200)."""
DEFAULT_SEED = 20181108
PROFILE = "grounded"
"""``sim/behavior_params.json`` profile the households draw from (docs/people-data.md "Behaviour evidence")."""
NO_VEHICLE_SHARE = 0.0608
"""SOURCED: Butte County households with no vehicle, ACS 2018-2022 B25044 (docs/people-data.md; also
``tools/people_behavior.json``). Used for every zone so a person's draw does not depend on the twin being loaded."""
LEASE_S = 60
REMOTE_ADDR = "virtual-people"
"""The client address simulated phones present to the rate limiter (one network for all of them)."""
TWIN_LOCK_TIMEOUT_S = 2.0
LONG_QUEUE_S = 900
"""``sim.twin.LONG_QUEUE_S``: 15+ min waiting on one edge is a long queue."""
LABEL = ("Simulated people (virtual phones): synthetic households with drawn behaviour, acting on the drill "
         "clock through the phone API. Positions are estimates. Planning experiment, not observed data.")
TOKEN_KEY = "virtual-people"
ROUTE_TOLERANCE_M, ROUTE_MAX_POINTS = 30.0, 80
RETRY_CODES = (429, 503)
"""Rate-limited or no signal (comms outage): kept in the person's outbox and sent on a later tick, as a phone would."""

_rf = RequestFactory()


# ---- identities ----------------------------------------------------------------------------------------------


def _party_key(incident_id: str, seed: int, n: int) -> str:
    digest = hashlib.sha256(f"{TOKEN_KEY}:{incident_id}:{seed}:{n}".encode()).hexdigest()[:16]
    return f"sim_{digest}"


def _token(incident_id: str, party_key: str) -> str:
    key = (getattr(settings, "SECRET_KEY", "") or "crisistwin").encode()
    return hmac.new(key, f"{TOKEN_KEY}:{incident_id}:{party_key}".encode(), hashlib.sha256).hexdigest()


def _ensure_device(incident_id: str, party_key: str, name: str, now: datetime) -> str:
    """The person's civilian device (``simulated: true``, display name and kind as ``POST me/profile`` sets
    them), written as ``auth.issue_token`` writes one. It has no ``location``: positions are estimates and are
    served only by ``list_participants`` (``position_source: estimated``)."""
    tok = _token(incident_id, party_key)
    col("live_devices").update_one(
        {"party_key": party_key},
        {"$set": {"token_hash": token_hash(tok), "role": "civilian", "incident_id": incident_id, "simulated": True,
                  "name": name, "kind": "resident", "last_seen_at": now, "expires_at": now + CIVILIAN_TOKEN_TTL},
         "$setOnInsert": {"party_key": party_key, "created_at": now}},
        upsert=True,
    )
    return tok


def _call(view, method: str, token: str, body: dict[str, Any] | None = None, **kwargs) -> tuple[int, Any]:
    """Call a phone endpoint's view in-process with the person's token (the same code a phone's request runs)."""
    make = getattr(_rf, method.lower())
    data = json.dumps(body) if body is not None else ""
    request = make("/api/live/virtual-people", data=data, content_type="application/json",
                   HTTP_AUTHORIZATION=f"Bearer {token}", REMOTE_ADDR=REMOTE_ADDR)
    response = view(request, **kwargs)
    return response.status_code, getattr(response, "data", None)


# ---- drawing people ------------------------------------------------------------------------------------------


def _sim_behavior():
    twin_service._import_sim()  # puts the repo root on sys.path
    from sim import behavior

    return behavior


def _new_person(incident_id: str, index, seed: int, n: int, active_from: datetime) -> dict[str, Any]:
    behavior = _sim_behavior()
    zone_id = vp.pick_zone(seed, n, [(z.id, z.households) for z in index.drill.zones])
    party_key = _party_key(incident_id, seed, n)
    home = vp.home_point(seed, party_key, index.zones[zone_id].geometry)
    has_vehicle = vp._rng(seed, party_key, "no_vehicle").random() >= NO_VEHICLE_SHARE
    ctx = behavior.HouseholdContext(has_vehicle=has_vehicle, ordered=True)
    choices = behavior.draw_household_choices(seed, party_key, PROFILE, ctx)
    shadow = behavior.draw_household_choices(seed, party_key, PROFILE,
                                             behavior.HouseholdContext(has_vehicle=has_vehicle, ordered=False))
    stored = {k: v for k, v in choices.to_dict().items() if k not in ("sources", "narrative", "household_key")}
    stored["evidence"] = {k: sorted({s["label"] for s in v}) for k, v in sorted(choices.sources.items())}
    return {
        "incident_id": incident_id, "id": party_key, "n": n, "seed": seed, "name": f"Simulated {n}",
        "party_key": party_key, "zone_id": zone_id, "home": [home[0], home[1]], "has_vehicle": has_vehicle,
        "choices": stored, "narrative": choices.narrative(), "shadow_leaves": shadow.evacuates,
        "draws": vp.draw_extras(seed, party_key), "active_from": active_from, "created_at": wall_now(),
        "state": vp.initial_state(home),
    }


# ---- inputs per drill minute ---------------------------------------------------------------------------------


def _minute(t: datetime) -> datetime:
    return t.replace(second=0, microsecond=0)


def _aware(t: datetime | None) -> datetime | None:
    return t.replace(tzinfo=UTC) if t is not None and t.tzinfo is None else t


def _option(alt_or_doc: dict[str, Any], recommended: bool) -> vp.RouteOption | None:
    dest, route = alt_or_doc.get("destination") or {}, alt_or_doc.get("route") or {}
    line = route.get("line") or []
    if not dest.get("id") or not line:
        return None
    line = simplify_line([(p[0], p[1]) for p in line], ROUTE_TOLERANCE_M, ROUTE_MAX_POINTS)
    return vp.RouteOption(dest["id"], dest.get("name") or dest["id"], tuple(line), float(route.get("eta_min") or 0),
                          route.get("safety") or alt_or_doc.get("safety"), recommended)


def _guidance_view(doc: dict[str, Any]) -> vp.GuidanceView:
    options: list[vp.RouteOption] = []
    if doc.get("level") != "none" and not doc.get("no_route"):
        for alt in doc.get("alternatives") or []:
            o = _option(alt, bool(alt.get("recommended")))
            if o is not None:
                options.append(o)
        if not options:
            o = _option(doc, True)
            if o is not None:
                options.append(o)
    return vp.GuidanceView(doc.get("level") or "none", int(doc.get("version") or 0), tuple(options))


class _GuidanceTimeline:
    """Published guidance per zone over drill time: a version applies from when phones could have seen it, the
    later of the drill time it was planned for and the drill time it was published (under the current clock)."""

    def __init__(self, incident_id: str, clock) -> None:
        self.by_zone: dict[str, list[tuple[datetime, int, vp.GuidanceView]]] = defaultdict(list)
        for doc in col("live_guidance").find({"incident_id": incident_id}).sort([("zone_id", 1), ("version", 1)]):
            at = _aware(doc.get("replay_at")) or datetime.min.replace(tzinfo=UTC)
            published = _aware(doc.get("published_at"))
            if published is not None and clock.started_at is not None and published >= clock.started_at:
                at = max(at, drillmod.replay_now(clock.replay_start, clock.started_at, published, clock.speed))
            self.by_zone[doc["zone_id"]].append((at, int(doc["version"]), _guidance_view(doc)))
        for rows in self.by_zone.values():
            rows.sort(key=lambda r: (r[0], r[1]))
        self.keys = {z: [r[0] for r in rows] for z, rows in self.by_zone.items()}

    def at(self, zone_id: str, t: datetime) -> vp.GuidanceView | None:
        rows = self.by_zone.get(zone_id)
        if not rows:
            return None
        k = bisect.bisect_right(self.keys[zone_id], t)
        return rows[k - 1][2] if k else None


class _Fire:
    """Fire estimate per drill minute (``estimate_fire`` with the drill's fire-jump injects), cached by source."""

    def __init__(self, drill, injects: list[dict[str, Any]]) -> None:
        self.drill, self.injects = drill, injects
        self.home_m: dict[tuple, float | None] = {}

    def at(self, t: datetime):
        est = estimate_fire(self.drill, t, (), injects_mod.rules.spots_due(self.injects, t))
        key = (est.as_of, est.method, est.label)
        return key, est.geometry

    def home_distance(self, key: tuple, geometry, person: dict[str, Any]) -> float | None:
        k = (key, person["id"])
        if k not in self.home_m:
            self.home_m[k] = vp.home_fire_distance(tuple(person["home"]), geometry)
        return self.home_m[k]


def _zone_motion(snapshot) -> dict[str, vp.ZoneMotion] | None:
    """Per zone, the synced twin's en-route vehicles by state (as ``sim.twin_people`` counts them). None when the
    twin is warming, failed or busy: persons then move at free-flow speed."""

    def run(sess, twin, twinmod):
        states = twin.vehicle_states(LONG_QUEUE_S)
        acc: dict[str, list[int]] = defaultdict(lambda: [0, 0, 0, 0])  # moving, queued, long_queue, blocked
        for row in states["edges"]:
            for z, c in row["moving_veh"].items():
                acc[z][0] += c
            for z, c in row["queued_veh"].items():
                acc[z][1 if row["block"] is None else 3] += c
            for z, c in row["long_queue_veh"].items():
                acc[z][2] += c
        for o in states["origins"]:
            for z, c in o["veh"].items():
                acc[z][3 if o["block"] else 1] += c
        for r in states["returning"]:
            for z, c in r["veh"].items():
                acc[z][3] += c
        return {z: vp.ZoneMotion(sum(v), v[0], v[1], v[2], v[3]) for z, v in acc.items()}

    try:
        return twin_service._with_twin(snapshot, run, TWIN_LOCK_TIMEOUT_S)
    except twin_service.TwinUnavailable:
        return None
    except Exception as exc:  # noqa: BLE001 - a twin error must not stop the people; they fall back to free flow
        if twin_service.is_twin_error(exc):
            return None
        raise


def _nearest_exit(index, home: list[float]) -> tuple[str, str, tuple[float, float]] | None:
    """The nearest exit the planner can route to (``routing`` keeps destinations with a road node nearby)."""
    routable = routing._index(index.drill).destination_nodes
    dests = [d for d in index.destinations.values() if d.id in routable] or list(index.destinations.values())
    exits = [d for d in dests if d.kind == "exit"] or dests
    if not exits:
        return None
    d = min(exits, key=lambda d: (haversine_m(tuple(home), d.coord), d.id))
    return d.id, d.name, d.coord


def _help_status(incident_id: str, party_keys: list[str]) -> dict[str, str]:
    out = {}
    for d in col("live_checkins").find({"incident_id": incident_id, "party_key": {"$in": party_keys},
                                        "status": "need_help"}, {"party_key": 1, "help": 1}):
        out[d["party_key"]] = (d.get("help") or {}).get("status", "open")
    return out


# ---- ticking -------------------------------------------------------------------------------------------------


def _continues(run: dict[str, Any], clock, drill) -> bool:
    """True while the drill clock continues the one the run last ticked under (pause and speed changes do; a
    reset, a restart or a move back do not)."""
    if run.get("clock_replay_start") is None:
        return True
    old_rs, old_sa, old_speed = _aware(run["clock_replay_start"]), _aware(run.get("clock_started_at")), \
        float(run.get("clock_speed") or 0)
    if (clock.replay_start, clock.started_at) == (old_rs, old_sa):
        return True
    at = clock.started_at or clock.replay_start
    expected = drillmod.replay_now(old_rs, old_sa, at, old_speed, drill.clock_end) if old_sa else old_rs
    return abs((clock.replay_start - expected).total_seconds()) <= 1.0


def _wall_at(clock, t: datetime, now: datetime) -> datetime:
    """Wall time at drill time ``t`` under the current clock (for a report's ``observed_at``), at most now."""
    if clock.started_at is None or clock.speed <= 0:
        return now
    wall = clock.started_at + timedelta(seconds=(t - clock.replay_start).total_seconds() / clock.speed)
    return min(now, max(wall, now - timedelta(hours=12)))


def _send(incident_id: str, seed: int, epoch: int, person: dict[str, Any], event: dict[str, Any], clock,
          now: datetime) -> int:
    """Send one queued event through the phone endpoint's view. Returns the HTTP status."""
    from . import views  # local: views imports this module for the command hook

    token = _token(incident_id, person["party_key"])
    typ = event["type"]
    if typ == "checkin":
        body: dict[str, Any] = {"status": event["status"], "zone_id": person["zone_id"]}
        if event.get("coord") is not None:
            body["coord"] = event["coord"]
        return _call(views.checkins, "POST", token, body, incident_id=incident_id)[0]
    if typ == "destination":
        return _call(views.my_destination, "POST", token,
                     {"zone_id": person["zone_id"], "destination_id": event["destination_id"]})[0]
    client_id = str(uuid.uuid5(uuid.NAMESPACE_URL,
                               f"crisistwin:{TOKEN_KEY}:{incident_id}:{seed}:{epoch}:{person['id']}:{event['key']}"))
    body = {"client_id": client_id, "kind": event["kind"], "severity": event.get("severity"),
            "location": {"coord": event["coord"], "accuracy_m": 25},
            "observed_at": iso(_wall_at(clock, _aware(event["at"]), now)),
            "note": f"{event.get('note') or ''} ({person['name']}, simulated)".strip()}
    return _call(views.incident_reports, "POST", token, body, incident_id=incident_id)[0]


def tick(incident_id: str, snapshot=None) -> dict[str, Any] | None:
    """Advance the incident's simulated people to the drill clock's current minute. Cheap when nothing is due;
    returns a small summary when it ticked, None otherwise. Never raises for a twin problem."""
    runs = col(RUNS)
    run = runs.find_one({"incident_id": incident_id})
    if run is None:
        return None
    now = wall_now()
    index = get_index(incident_id)
    clock = snapshot.clock if snapshot is not None else clock_from(drill_doc(incident_id), index, now)
    target = _minute(clock.replay_now)
    ticked_to = _aware(run.get("ticked_to"))
    restart = not _continues(run, clock, index.drill) or (ticked_to is not None and target < ticked_to)
    if not restart and ticked_to == target:
        return None
    run = runs.find_one_and_update(
        {"incident_id": incident_id, "$or": [{"lease_until": None}, {"lease_until": {"$lt": now}}]},
        {"$set": {"lease_until": now + timedelta(seconds=LEASE_S)}}, return_document=ReturnDocument.AFTER)
    if run is None:
        return None  # another request is ticking
    try:
        return _tick_locked(incident_id, run, index, clock, target, restart, snapshot, now)
    finally:
        runs.update_one({"incident_id": incident_id}, {"$set": {"lease_until": None}})


def _tick_locked(incident_id, run, index, clock, target, restart, snapshot, now) -> dict[str, Any]:
    people = col(PEOPLE)
    seed, epoch = int(run["seed"]), int(run.get("epoch") or 0)
    if restart:
        epoch += 1
        start = _minute(clock.replay_start)
        for p in people.find({"incident_id": incident_id}, {"id": 1, "home": 1}):
            people.update_one({"_id": p["_id"]}, {"$set": {"state": vp.initial_state(tuple(p["home"])),
                                                           "active_from": start}})
        log.info("virtual people %s: drill reset or restarted; back home from %s (epoch %d)", incident_id,
                 iso(start), epoch)
    persons = list(people.find({"incident_id": incident_id}).sort("n", 1))
    timeline = _GuidanceTimeline(incident_id, clock)
    injects = snapshot.injects if snapshot is not None else injects_mod.load(incident_id)
    fire = _Fire(index.drill, injects)
    help_status = _help_status(incident_id, [p["party_key"] for p in persons])
    motion_cache: dict[str, Any] = {}

    def motion() -> dict[str, vp.ZoneMotion] | None:
        if "m" not in motion_cache:
            snap = snapshot if snapshot is not None else load_snapshot(incident_id, wall_now())
            motion_cache["m"] = _zone_motion(snap)
        return motion_cache["m"]

    fallbacks: dict[str, Any] = {}
    stepped = 0
    minutes: dict[datetime, tuple] = {}
    for p in persons:
        state = p["state"]
        start = max(_minute(_aware(p["active_from"])),
                    _aware(state["ticked_to"]) + timedelta(minutes=1) if state.get("ticked_to") else datetime.min.replace(tzinfo=UTC))
        t = start
        while t <= target:
            if t not in minutes:
                minutes[t] = fire.at(t)
            fkey, geometry = minutes[t]
            moving = state["phase"] in ("packing", "trip", "en_route")
            if p["id"] not in fallbacks:
                fallbacks[p["id"]] = _nearest_exit(index, p["home"])
            ctx = vp.MinuteContext(
                t=t, guidance=timeline.at(p["zone_id"], t), home_fire_m=fire.home_distance(fkey, geometry, p),
                motion=(motion() or {}).get(p["zone_id"]) if moving else None,
                help_status=help_status.get(p["party_key"]), fallback=fallbacks[p["id"]])
            vp.step(p, state, ctx)
            stepped += 1
            t += timedelta(minutes=1)
        state["seen_at"] = now

    # Send what the phones would send, oldest first.
    queue = sorted(((ev["at"], p["n"], k, p) for p in persons for k, ev in enumerate(p["state"]["outbox"])),
                   key=lambda r: (r[0], r[1], r[2]))
    sent: dict[str, int] = defaultdict(int)
    keep: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for _, _, k, p in queue:
        event = p["state"]["outbox"][k]
        code = _send(incident_id, seed, epoch, p, event, clock, now)
        sent[f"{event['type']}:{code}"] += 1
        if code in RETRY_CODES:
            keep[p["id"]].append(event)
        elif code >= 400:
            log.info("virtual people %s: %s %s refused (%s)", incident_id, p["id"], event["key"], code)
    for p in persons:
        p["state"]["outbox"] = keep.get(p["id"], [])
    if persons:
        people.bulk_write([UpdateOne({"_id": p["_id"]}, {"$set": {"state": p["state"]}}) for p in persons])
    twin = "not_needed" if "m" not in motion_cache else ("ready" if motion_cache["m"] is not None else "unavailable")
    col(RUNS).update_one({"incident_id": incident_id}, {"$set": {
        "ticked_to": target, "epoch": epoch, "clock_replay_start": clock.replay_start,
        "clock_started_at": clock.started_at, "clock_speed": clock.speed, "ticked_at": now, "twin": twin}})
    return {"ticked_to": iso(target), "person_minutes": stepped, "sent": dict(sent), "twin": twin}


def tick_quietly(incident_id: str, snapshot=None) -> None:
    """``tick`` for read paths (the command poll, the participants list): a failure is logged, never raised."""
    try:
        tick(incident_id, snapshot)
    except Exception:  # noqa: BLE001 - simulated people must never break the console's poll
        log.exception("virtual people %s: tick failed", incident_id)


_background: dict[str, threading.Thread] = {}
_background_lock = threading.Lock()


def tick_in_background(incident_id: str, snapshot=None) -> None:
    """``tick_quietly`` on a background thread (one per incident per process), for the console's command poll:
    a tick may sync the traffic twin for seconds, and the poll must not wait for it. Its results show on the
    next poll. Does nothing when the incident has no simulated people."""
    if col(RUNS).find_one({"incident_id": incident_id}, {"_id": 1}) is None:
        return
    with _background_lock:
        running = _background.get(incident_id)
        if running is not None and running.is_alive():
            return
        thread = threading.Thread(target=tick_quietly, args=(incident_id, snapshot), daemon=True,
                                  name=f"virtual-people-{incident_id}")
        _background[incident_id] = thread
        thread.start()


# ---- listing -------------------------------------------------------------------------------------------------


def _participant(p: dict[str, Any], t: datetime, fire_geometry, help_status: str | None) -> dict[str, Any]:
    state = p["state"]
    status, flags = vp.describe(p, state, t, fire_geometry, help_status)
    return {
        "id": p["id"],
        "kind": "simulated",
        "role": "resident",
        "name": p["name"],
        "zone_id": p["zone_id"],
        "position": [round(state["position"][0], 5), round(state["position"][1], 5)],
        "position_source": "estimated",
        "status": status,
        "flags": flags,
        "last_seen": iso(_aware(state.get("seen_at"))),
        "behaviour": {"narrative": list(p.get("narrative") or []), "choices": p["choices"]},
        "evidence_class": "simulated",
    }


def _list(incident_id: str) -> list[dict[str, Any]]:
    persons = list(col(PEOPLE).find({"incident_id": incident_id}).sort("n", 1))
    if not persons:
        return []
    run = col(RUNS).find_one({"incident_id": incident_id}) or {}
    index = get_index(incident_id)
    t = _aware(run.get("ticked_to")) or _minute(clock_from(drill_doc(incident_id), index, wall_now()).replay_now)
    est = estimate_fire(index.drill, t, (), injects_mod.rules.spots_due(injects_mod.load(incident_id), t))
    helps = _help_status(incident_id, [p["party_key"] for p in persons])
    return [_participant(p, t, est.geometry, helps.get(p["party_key"])) for p in persons]


def find_participant(incident_id: str, participant_id: str) -> dict[str, Any] | None:
    """One simulated person in the participants shape (after a tick), or None. ``participant_id`` is the
    person's ``id``, which is also its device's ``party_key``."""
    if col(PEOPLE).find_one({"incident_id": incident_id, "id": participant_id}, {"_id": 1}) is None:
        return None
    tick_quietly(incident_id)
    return next((p for p in _list(incident_id) if p["id"] == participant_id), None)


def list_participants(incident_id: str) -> list[dict[str, Any]]:
    """The incident's simulated people in the participants shape (docs/app-integration.md "Simulated people"),
    after advancing them to the drill clock. ``[]`` when there are none."""
    tick_quietly(incident_id)
    return _list(incident_id)


# ---- endpoints -----------------------------------------------------------------------------------------------


def _summary(people: list[dict[str, Any]]) -> dict[str, Any]:
    by_status: dict[str, int] = defaultdict(int)
    by_flag: dict[str, int] = defaultdict(int)
    for p in people:
        by_status[p["status"].split(",")[0]] += 1
        for f in p["flags"]:
            by_flag[f] += 1
    return {"by_status": dict(sorted(by_status.items())), "by_flag": {f: by_flag[f] for f in vp.FLAGS if by_flag[f]}}


def _run_json(incident_id: str, people: list[dict[str, Any]]) -> dict[str, Any]:
    run = col(RUNS).find_one({"incident_id": incident_id}) or {}
    return {"incident_id": incident_id, "label": LABEL, "seed": run.get("seed"), "profile": PROFILE,
            "epoch": run.get("epoch", 0), "count": len(people), "ticked_to": iso(_aware(run.get("ticked_to"))),
            "twin": run.get("twin"), "summary": _summary(people), "people": people}


def _add(request, incident_id: str) -> Any:
    body = json_body(request)
    count, seed = body.get("count"), body.get("seed")
    if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= MAX_PEOPLE:
        return error(400, "invalid_request", f"`count` must be an integer 1..{MAX_PEOPLE}.")
    if seed is not None and (not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed < 2**31):
        return error(400, "invalid_request", "`seed` must be an integer 0..2^31-1.")
    runs, people = col(RUNS), col(PEOPLE)
    run = runs.find_one({"incident_id": incident_id})
    if run is not None and seed is not None and seed != run["seed"]:
        return error(409, "conflict", f"Simulated people of this incident use seed {run['seed']}; remove them first "
                                      "(DELETE) to use another seed.")
    existing = people.count_documents({"incident_id": incident_id})
    if existing + count > MAX_PEOPLE:
        return error(400, "invalid_request", f"At most {MAX_PEOPLE} simulated people per incident "
                                             f"({existing} already).")
    now = wall_now()
    runs.update_one({"incident_id": incident_id},
                    {"$setOnInsert": {"incident_id": incident_id, "seed": seed if seed is not None else DEFAULT_SEED,
                                      "epoch": 0, "next_n": 1, "lease_until": None, "created_at": now}},
                    upsert=True)
    run = runs.find_one_and_update({"incident_id": incident_id}, {"$inc": {"next_n": count}},
                                   return_document=ReturnDocument.BEFORE)
    first, seed = int(run["next_n"]), int(run["seed"])
    index = get_index(incident_id)
    active_from = _minute(clock_from(drill_doc(incident_id), index, now).replay_now)
    added = [_new_person(incident_id, index, seed, n, active_from) for n in range(first, first + count)]
    for p in added:
        _ensure_device(incident_id, p["party_key"], p["name"], now)
    people.insert_many(added)
    runs.update_one({"incident_id": incident_id}, {"$set": {"ticked_to": None}})  # tick the new people now
    tick_quietly(incident_id)
    new_ids = {p["id"] for p in added}
    listed = [p for p in _list(incident_id) if p["id"] in new_ids]
    return ok({"added": len(added), "total": existing + len(added), "seed": seed, "label": LABEL,
               "people": listed}, status=201)


def _remove(incident_id: str) -> Any:
    """Remove every simulated person: withdraw their reports through the owner's withdraw path (reports a
    controller already acted on stay, labelled simulated), delete their check-ins (cancelling open assist tasks),
    destination choices and devices."""
    from . import views

    persons = list(col(PEOPLE).find({"incident_id": incident_id}, {"party_key": 1}))
    keys = [p["party_key"] for p in persons]
    withdrawn = kept = 0
    for doc in col("live_reports").find({"incident_id": incident_id, "reporter.party_key": {"$in": keys},
                                         "status": {"$ne": "withdrawn"}}, {"id": 1, "reporter": 1}):
        code, _ = _call(views.my_report, "DELETE", _token(incident_id, doc["reporter"]["party_key"]),
                        report_id=doc["id"])
        if code == 200:
            withdrawn += 1
        else:
            kept += 1
    now = wall_now()
    checkins = list(col("live_checkins").find({"incident_id": incident_id, "party_key": {"$in": keys}}))
    task_ids = [(d.get("help") or {}).get("task_id") for d in checkins]
    task_ids = [t for t in task_ids if t]
    if task_ids:
        col("live_tasks").update_many(
            {"id": {"$in": task_ids}, "status": {"$in": ["open", "accepted"]}},
            {"$set": {"status": "cancelled", "closed_at": now, "note": "Simulated person removed"}})
    col("live_checkins").delete_many({"incident_id": incident_id, "party_key": {"$in": keys}})
    col("live_destination_choices").delete_many({"incident_id": incident_id, "party_key": {"$in": keys}})
    col("live_devices").delete_many({"party_key": {"$in": keys}, "simulated": True})
    col(PEOPLE).delete_many({"incident_id": incident_id})
    col(RUNS).delete_one({"incident_id": incident_id})
    return ok({"removed": len(persons), "reports_withdrawn": withdrawn, "reports_kept": kept,
               "checkins_removed": len(checkins), "assist_tasks_cancelled": len(task_ids)})


@live_view(["GET", "POST", "DELETE"], roles=["controller"])
def virtual_people(request, incident_id: str, principal: Principal):
    if request.method == "POST":
        return _add(request, incident_id)
    if request.method == "DELETE":
        return _remove(incident_id)
    tick_quietly(incident_id)
    return ok(_run_json(incident_id, _list(incident_id)))
