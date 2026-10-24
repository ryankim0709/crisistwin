"""Run a batch scenario spec's generators against the live drill, on its clock (``live_run_scenario``).

Docs: docs/live-scenario-runner.md. Design: docs/adr/0030-scenario-engine.md §2. The spec format is the
batch runner's (``batch.load_spec``; docs/batch-runner.md) plus an optional ``live`` block; the world
(bundle, twin inputs with the spec's people behaviour, comms parameters) is built by ``batch.build_world``
and the generators are the batch runner's, so a scenario means the same thing headless and live.

Every tick (``interval_s`` wall seconds) the runner reads the drill clock of the active incident and
advances the generators to its drill time (never past ``window.end``):

- **twin**: the runner's own copy of the traffic twin (same inputs and seed rule as the batch runner),
  stepped minute by minute; published live guidance becomes ``order_zone``/``reroute_zone`` commands and
  the live road state becomes closures, so simulated residents react to what the console publishes;
- **residents** (``sim/gen_residents.py``) post reports, check-ins (out, staying, need_help, transport),
  destination choices (only among the live guidance's offered destinations) and board answers over the
  HTTP API with per-household civilian tokens marked ``simulated`` (stored ``evidence_class: simulated``);
- **comms** (``sim/gen_comms.py``): generated 911/radio/rescue items enter the review queue through
  ``groundrecord.materialize_simulated`` (``simulated``, controller-only points, count for nothing until
  confirmed); a ``psap_reroute`` inject drops 911;
- **noise** (``sim/gen_noise.py``, profile clean/typical/hostile) is applied per drill minute to the
  residents' events and the comms items, and the hidden truth goes to ``sim_truth`` (``simtruth``);
- **responders** run as ``live_sim_responders`` (``livecore/responders_sim.Fleet``, joined with the invite
  code, flagged simulated);
- **injects**: the spec's injects and the tower-failure model's ``comms_outage`` injects
  (``sim/comms_towers.py``) are posted through the controller inject API when the clock reaches them.
  A ``comms_outage`` makes the server refuse phone traffic of its zones (503 ``no_signal``); the runner
  keeps those events in the phone's outbox and resends them after the outage, as a phone would.

Restart-safe: identities and ids derive from (seed, index): household tokens are derived from the seed
and party key, report ``client_id`` values are seeded UUIDs, comms ``client_id`` values are
``simcomms:<seed>:<item id>``; a restarted runner replays from ``window.start`` and the server dedupes.
Times are UTC drill times unless named ``wall``. Nothing here contacts anyone outside the drill.
"""

from __future__ import annotations

import dataclasses
import hashlib
import heapq
import hmac
import json
import logging
import urllib.error
import urllib.request
from collections import Counter
from collections.abc import Callable, Mapping
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

from django.conf import settings
from livecore import public
from livecore.responders_sim import Fleet

from . import batch, groundrecord, incidents, simtruth
from . import injects as injects_mod
from .auth import CIVILIAN_TOKEN_TTL, token_hash
from .common import col, iso, wall_now
from .drillcache import get_index
from .state import clock_from, current_guidance, drill_doc, load_public, offered_destination_ids

log = logging.getLogger(__name__)

LABEL = ("Simulated drill activity (live_run_scenario): generated residents, calls, responders and injects on "
         "the drill clock. Planning experiment; not observed data.")
TICK_STEP_S = 60
"""The generators' drill cadence: one twin observation per drill minute (gen_residents.OBSERVE_EVERY_S)."""
NOISE_PROFILES = ("clean", "typical", "hostile")
DEFAULT_NOISE_PROFILE = "typical"
INJECT_ACTOR_SPEC = "scenario"
INJECT_ACTOR_TOWERS = "comms_towers"
MAX_RETRIES = 30
"""Rate-limited (429) events are retried on later ticks this many times, then counted as dropped."""
RESIDENT_RUN_KEY = "live-run-scenario"


def _t(value: str | datetime) -> datetime:
    return batch._t(value)


def _minute_floor(t: datetime) -> datetime:
    return t.replace(second=0, microsecond=0)


class Http:
    """Minimal JSON client for the live API (the same paths phones and the console use)."""

    def __init__(self, base: str, controller_token: str | None) -> None:
        self.base = base.rstrip("/") + "/api/live/"
        self.controller_token = controller_token

    def call(self, method: str, path: str, token: str | None = None, body: Any = None) -> tuple[int, dict]:
        headers = {"Accept": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                code, raw = resp.status, resp.read()
        except urllib.error.HTTPError as exc:
            code, raw = exc.code, exc.read()
        try:
            payload = json.loads(raw) if raw else {}
        except ValueError:
            payload = {"raw": raw[:200].decode(errors="replace")}
        return code, payload

    def controller(self, method: str, path: str, body: Any = None) -> tuple[int, dict]:
        return self.call(method, path, self.controller_token, body)


class ResidentDevices:
    """One civilian device per simulated household (party key ``sim_...`` from the generator).

    The device document is written the way ``auth.issue_token`` writes one, with ``simulated: true`` and
    the household's own party key; its token is derived from the server secret, the incident, the seed
    and the party key, so a restarted runner gets the same identities (idempotent check-ins)."""

    def __init__(self, incident_id: str, seed: int) -> None:
        self.incident_id, self.seed = incident_id, seed
        self.tokens: dict[str, str] = {}
        self._key = (getattr(settings, "SECRET_KEY", "") or "crisistwin").encode()

    def token(self, party_key: str) -> str:
        tok = self.tokens.get(party_key)
        if tok is None:
            tok = hmac.new(self._key, f"{RESIDENT_RUN_KEY}:{self.incident_id}:{self.seed}:{party_key}".encode(),
                           hashlib.sha256).hexdigest()
            now = wall_now()
            col("live_devices").update_one(
                {"party_key": party_key},
                {"$set": {"token_hash": token_hash(tok), "role": "civilian", "incident_id": None, "simulated": True,
                          "last_seen_at": now, "expires_at": now + CIVILIAN_TOKEN_TTL},
                 "$setOnInsert": {"party_key": party_key, "created_at": now}},
                upsert=True)
            self.tokens[party_key] = tok
        return tok


def _responders_command():
    """``live_sim_responders`` with its HTTP tick, counting the calls it makes (reused, not forked)."""
    from django.core.management.base import OutputWrapper

    from api.management.commands.live_sim_responders import Command

    class Counting(Command):
        def __init__(self, counts: Counter, out) -> None:
            super().__init__(stdout=out, stderr=out)
            self.counts = counts
            self.locations = 0

        def apply(self, fleet, tokens, call, invite):
            self.counts[f"responder:{call['op']}"] += 1
            return super().apply(fleet, tokens, call, invite)

    return Counting, OutputWrapper


class LiveScenarioRunner:
    def __init__(self, spec: batch.ScenarioSpec, raw: Mapping[str, Any], *, base: str, seed: int | None = None,
                 incident_id: str | None = None, invite: str = "", controller_token: str | None = None,
                 noise_profile: str | None = None, progress: Callable[[str], None] = print) -> None:
        if spec.package["kind"] != "camp_bundle":
            raise ValueError("live_run_scenario needs a camp_bundle package (the twin, residents and comms run on "
                             "the Camp bundle only; docs/batch-runner.md)")
        self.spec, self.live = spec, dict(raw.get("live") or {})
        self.progress = progress
        self.incident_id = incident_id or incidents.active_incident_id()
        _, self.evaluation, self.gen_comms, self.gen_residents, _ = batch._sim()
        self.seed = seed if seed is not None else spec.seed_list(self.evaluation)[0]
        profile = noise_profile or self.live.get("noise_profile") or DEFAULT_NOISE_PROFILE
        if profile not in NOISE_PROFILES:
            raise ValueError(f"noise profile must be one of {NOISE_PROFILES}")
        self.noise_profile = profile
        self.http = Http(base, controller_token)
        self.invite = invite
        # The world, exactly as the batch runner builds it; the 2018 record is the server's own (groundrecord).
        self.world = batch.build_world(dataclasses.replace(spec, record_2018=False), progress)
        if self.world.index.drill.incident_id != self.incident_id:
            raise ValueError(f"the spec's package is {self.world.index.drill.incident_id}, the active incident is "
                             f"{self.incident_id}; activate it first (POST /api/live/active)")
        self.index = get_index(self.incident_id)
        self.counts: Counter = Counter()
        self.devices = ResidentDevices(self.incident_id, self.seed)
        self.comms_all = self.world.comms_items(self.seed)
        self.comms_params_hash = (self.comms_all[0].get("params_hash") if self.comms_all else None)
        self.tower_injects = self._tower_injects()
        self.spec_injects = [dict(i) for i in spec.injects]
        Counting, OutputWrapper = _responders_command()
        self._responder_cmd_cls, self._out = Counting, OutputWrapper(_ProgressStream(progress))
        self.fleet = None
        self.responder_cmd = None
        self.responder_tokens: dict[str, str] = {}
        self._reset_generators()

    # -- setup ---------------------------------------------------------------------------------------------

    def _tower_injects(self) -> list[dict[str, Any]]:
        cfg = {"enabled": True, **(self.live.get("comms_towers") or {})}
        if not cfg["enabled"] or self.world.bundle is None:
            return []
        from sim import comms_towers

        zones = [comms_towers.TowerZone(id=z.id, fire_arrival_at=z.fire_arrival_at, households=z.households)
                 for z in self.gen_comms.zones_from_bundle(self.world.bundle)]
        scenario_date = date.fromisoformat(cfg.get("scenario_date") or self.spec.start.date().isoformat())
        out = comms_towers.schedule_outages(zones, (self.spec.start, self.spec.end), comms_towers.params_from_file(),
                                            self.evaluation.derive_seed(self.seed, "comms_towers"), scenario_date)
        self.progress(f"tower model: {comms_towers.summary(out)}")
        return out

    def _reset_generators(self) -> None:
        """Fresh twin and generators at ``window.start`` (start, and after a drill reset)."""
        twinmod = batch._sim()[0]
        twin_seed = self.evaluation.derive_seed(self.seed, "twin") % (2**31 - 1)
        inputs = self.world.twin_inputs(twin_seed)
        self.twin = twinmod.Twin.from_inputs(inputs, start_at=iso(self.spec.start), session_id=f"live-run:{self.seed}")
        self.residents = None
        if self.spec.residents.get("enabled"):
            params = batch.resident_params(self.spec, self.evaluation.derive_seed(self.seed, "residents"))
            self.residents = self.gen_residents.ResidentGenerator(
                self.twin, params, incident_id=self.incident_id, offered=self._offered, board=self._board)
            self.population = self.residents.population_summary()
        self.twin_t = self.spec.start
        self.twin_ordered: set[str] = set()
        self.twin_dest: dict[str, str | None] = {}
        self.twin_closed: set[str] = set()
        self.comms_i = 0
        self.block_events: list[dict[str, Any]] = []
        self.pending: list[tuple[str, int, dict[str, Any]]] = []  # (upload at ISO, seq, event)
        self.seq = 0
        self.retry: list[tuple[int, dict[str, Any]]] = []
        self.outbox: list[dict[str, Any]] = []  # held by a comms outage (no signal)
        self.comms_done: set[str] = set()
        self.posted_injects: set[tuple] = set()
        self.last_t: datetime | None = None
        self._guidance: dict[str, dict[str, Any]] | None = None
        self._board_items: list[dict[str, Any]] | None = None
        self._clock = None

    # -- live reads used by the generators ------------------------------------------------------------------

    def _guidance_by_zone(self) -> dict[str, dict[str, Any]]:
        if self._guidance is None:
            self._guidance = {d["zone_id"]: d for d in current_guidance(self.incident_id, self.index)}
        return self._guidance

    def _offered(self, zone_id: str, at: str) -> list[str]:
        doc = self._guidance_by_zone().get(zone_id)
        return offered_destination_ids(doc) if doc else []

    def _board(self, at: str) -> list[dict[str, Any]]:
        if self._board_items is None:
            party = next((h.party_key for z in self.residents.pops for h in z.households if h.has_app), None)
            self._board_items = []
            if party:
                code, body = self.http.call("GET", f"incidents/{self.incident_id}/board", self.devices.token(party))
                if code == 200:
                    self._board_items = body.get("items") or []
        return self._board_items

    # -- the twin mirrors published guidance and road state --------------------------------------------------

    def _twin_apply(self, action: dict[str, Any]) -> None:
        twinmod = batch._sim()[0]
        try:
            self.twin.apply({**action, "id": f"live-run-{self.seq}"})
            self.seq += 1
            self.counts[f"twin:{action['type']}"] += 1
        except twinmod.ActionError as exc:
            if exc.code not in ("already_ordered", "not_closed"):
                self.counts["twin:error"] += 1

    def _sync_twin(self, wall: datetime) -> None:
        actor = {"kind": "controller", "id": "live-run-scenario:guidance"}
        for zid, g in sorted(self._guidance_by_zone().items()):
            if zid not in {z.id for z in self.twin.engine.s.zone_list}:
                continue
            if g.get("level") == "evacuate_now" and zid not in self.twin_ordered:
                self.twin_ordered.add(zid)
                self._twin_apply({"type": "order_zone", "target": {"zone_id": zid}, "params": {}, "actor": actor,
                                  "rationale": f"Published live guidance v{g.get('version')}"})
            dest = (g.get("destination") or {}).get("id") if g.get("level") != "none" and not g.get("no_route") else None
            if dest != self.twin_dest.get(zid) and (dest is not None or zid in self.twin_dest):
                self.twin_dest[zid] = dest
                self._twin_apply({"type": "reroute_zone", "target": {"zone_id": zid},
                                  "params": {"destination_id": dest}, "actor": actor,
                                  "rationale": f"Published live guidance v{g.get('version')}"})
        _, _, _, state = load_public(self.incident_id, wall, self.index)
        want = set(public.guidance_blocked_segments(state)) | set(public.controller_blocked_segments(state))
        want |= {i["params"]["segment_id"] for i in injects_mod.load(self.incident_id)
                 if i["type"] == "silent_closure" and i["at"] <= self.twin_t}
        edges = self.index.drill.roads.segment_edges
        road_actor = {"kind": "field_report", "id": "live-run-scenario:road-state"}
        for seg in sorted(want - self.twin_closed):
            if edges.get(seg):
                self._twin_apply({"type": "close_road", "target": {"edge_ids": list(edges[seg])},
                                  "params": {"mode": "hard"}, "actor": road_actor, "rationale": "live road state"})
            self.twin_closed.add(seg)
        for seg in sorted(self.twin_closed - want):
            if edges.get(seg):
                self._twin_apply({"type": "reopen_road", "target": {"edge_ids": list(edges[seg])}, "params": {},
                                  "actor": road_actor, "rationale": "live road state"})
            self.twin_closed.discard(seg)

    # -- injects -----------------------------------------------------------------------------------------------

    def _post_due_injects(self, t: datetime) -> None:
        existing = {(d["type"], iso(d["at"]), d.get("actor"), json.dumps(_jsonable(d["params"]), sort_keys=True))
                    for d in injects_mod.load(self.incident_id)}
        for source, actor, rows in (("spec", INJECT_ACTOR_SPEC, self.spec_injects),
                                    ("towers", INJECT_ACTOR_TOWERS, self.tower_injects)):
            for inj in rows:
                at = _t(inj["at"])
                if at > t:
                    continue
                params = {k: v for k, v in (inj.get("params") or {}).items()}
                key = (inj["type"], iso(at), actor, json.dumps(params, sort_keys=True))
                if key in self.posted_injects or key in existing:
                    continue
                self.posted_injects.add(key)
                code, body = self.http.controller("POST", f"incidents/{self.incident_id}/injects",
                                                  {"type": inj["type"], "at": iso(at), "params": params, "actor": actor})
                self.counts[f"inject:{source}:{inj['type']}" if code == 201 else f"inject_rejected:{code}"] += 1
                if code != 201:
                    self.progress(f"inject refused ({code}): {body}")

    # -- events ------------------------------------------------------------------------------------------------

    def _step_generators(self, t: datetime, wall: datetime) -> None:
        """Advance twin and generators minute by minute to ``t``; close each drill minute as one noise block."""
        while self.twin_t + timedelta(seconds=TICK_STEP_S) <= t:
            nxt = self.twin_t + timedelta(seconds=TICK_STEP_S)
            self._sync_twin(wall)
            self.twin.step_to(iso(nxt))
            block = list(self.residents.observe()) if self.residents is not None else []
            while self.comms_i < len(self.comms_all) and _t(self.comms_all[self.comms_i]["at"]) < nxt:
                block.append(self.comms_all[self.comms_i])
                self.comms_i += 1
            self._noise_block(self.twin_t, nxt, block, wall)
            self.twin_t = nxt

    def _noise_block(self, start: datetime, end: datetime, events: list[dict[str, Any]], wall: datetime) -> None:
        gn = simtruth._gen_noise()
        block_seed = gn.seed_int(self.seed, "live-block", iso(start))
        out, truth = gn.apply_noise(events, self.noise_profile, block_seed,
                                    gn.NoiseOptions(window=(start, end), incident_id=self.incident_id))
        if truth:
            simtruth.write_truth(self.incident_id, truth, wall, profile=self.noise_profile, seed=block_seed)
            self.counts["truth_entries"] += len(truth)
        for ev in out:
            heapq.heappush(self.pending, (ev["at"], self.seq, ev))
            self.seq += 1

    def _deliver(self, t: datetime, wall: datetime, clock) -> None:
        mapper = simtruth.drill_wall_mapper(clock.replay_start, clock.started_at or wall, clock.speed)
        due_comms: list[dict[str, Any]] = []
        due: list[dict[str, Any]] = [ev for _, ev in sorted(self.retry, key=lambda r: r[0])] + self.outbox
        self.retry, self.outbox = [], []
        while self.pending and _t(self.pending[0][0]) <= t:
            ev = heapq.heappop(self.pending)[2]
            (due_comms if simtruth._gen_noise().source_of(ev) == "comms" else due).append(ev)
        if due_comms:
            injects = injects_mod.load(self.incident_id)
            res = groundrecord.materialize_simulated(
                self.index, self.incident_id, sorted(due_comms, key=lambda i: i["at"]), clock, wall, injects,
                seed=self.seed, params_hash=self.comms_params_hash, run_label=f"{self.spec.scenario_id}:{self.seed}",
                done=self.comms_done)
            for k, v in res.items():
                self.counts[f"comms_{k}"] += v
            for item in due_comms:
                self.counts[f"comms:{item['channel']}:{item['category']}"] += 1
        for ev in due:
            self._post_resident(ev, mapper, wall)

    def _post_resident(self, ev: dict[str, Any], mapper, wall: datetime) -> None:
        body = dict(ev["body"])
        typ = ev["type"]
        if typ == "report" and body.get("observed_at"):
            obs = mapper(_t(body["observed_at"]))
            body["observed_at"] = iso(min(obs, wall))
        path = ev["path"].replace("{incident_id}", self.incident_id)
        code, resp = self.http.call("POST", path, self.devices.token(ev["party_key"]), body)
        label = f"resident:{typ}:{body.get('kind') or body.get('status') or 'choice'}"
        if typ == "report" and body.get("task_id"):
            label += ":board_answer"
        if code in (200, 201):
            if typ == "report" and code == 200:
                self.counts["resident:report_existing"] += 1  # same client_id already stored (a restart)
            else:
                self.counts[label + (":after_outage" if ev.get("_queued") else "")] += 1
            if ev.get("_tries"):
                self.counts["resident:delivered_after_rate_limit"] += 1
        elif code == 503 and "no_signal" in json.dumps(resp):
            if not ev.get("_queued"):
                self.counts["resident:held_no_signal"] += 1
            ev["_queued"] = True
            self.outbox.append(ev)
        elif code == 429:
            tries = ev.get("_tries", 0) + 1
            if tries > MAX_RETRIES:
                self.counts["resident:dropped_rate_limited"] += 1
            else:
                if tries == 1:
                    self.counts["resident:rate_limited_429"] += 1  # events delayed by the server's rate limit
                ev["_tries"] = tries
                self.retry.append((self.seq, ev))
                self.seq += 1
        else:
            self.counts[f"resident:rejected:{typ}:{code}"] += 1

    # -- responders --------------------------------------------------------------------------------------------

    def _tick_responders(self) -> None:
        cfg = self.spec.responders
        if not cfg.get("enabled"):
            return
        if self.fleet is None:
            if not self.invite:
                self.progress("responders skipped: no invite code (LIVE_INVITE_CODE)")
                self.spec = dataclasses.replace(self.spec, responders={**cfg, "enabled": False})
                return
            self.fleet = Fleet(self.index.drill, int(cfg.get("units", batch.DEFAULT_RESPONDER_UNITS)),
                               seed=self.evaluation.derive_seed(self.seed, "responders"), incident_id=self.incident_id,
                               tempo=float(cfg.get("tempo", 1.0)))
            self.responder_cmd = self._responder_cmd_cls(self.counts, self._out)
            self.responder_cmd.base = self.http.base
            code, dev = self.http.call("POST", "devices", None, {})
            if code != 201:
                raise RuntimeError(f"could not get a clock token: {code} {dev}")
            self.responder_cmd.clock_token = dev["token"]
        try:
            self.responder_cmd.tick(self.fleet, self.responder_tokens, self.index.drill, self.incident_id, self.invite)
        except Exception as exc:  # noqa: BLE001 - one bad tick must not stop the drill's other generators
            self.counts["responder:tick_error"] += 1
            self.progress(f"responder tick skipped: {exc}")

    def stop(self) -> None:
        for token in self.responder_tokens.values():
            self.http.call("DELETE", "me/location", token)

    # -- the loop ----------------------------------------------------------------------------------------------

    def tick(self) -> dict[str, Any]:
        """One wall tick. Returns ``{"t": drill time or None, "done": bool}``."""
        wall = wall_now()
        clock = clock_from(drill_doc(self.incident_id), self.index, wall)
        self._guidance = self._board_items = None
        if clock.started_at is None or clock.replay_now < self.spec.start:
            return {"t": iso(clock.replay_now), "done": False, "waiting": "drill clock before window.start or stopped"}
        t = min(clock.replay_now, self.spec.end)
        if self.last_t is not None and t < self.last_t - timedelta(minutes=1):
            self.progress(f"drill clock went back ({iso(self.last_t)} -> {iso(t)}): restarting the generators")
            self._reset_generators()
        self.last_t = t
        self._post_due_injects(t)
        self._step_generators(t, wall)
        self._deliver(t, wall, clock)
        self._tick_responders()
        return {"t": iso(t), "done": t >= self.spec.end}

    def summary(self) -> dict[str, Any]:
        return {"label": LABEL, "scenario_id": self.spec.scenario_id, "incident_id": self.incident_id,
                "seed": self.seed, "noise_profile": self.noise_profile, "twin_at": iso(self.twin_t),
                "population": getattr(self, "population", None),
                "people_behavior": dataclasses.asdict(batch.people_behavior(self.spec)),
                "counts": dict(sorted(self.counts.items())),
                "pending": {"events": len(self.pending), "retry": len(self.retry), "outbox": len(self.outbox)},
                "tower_injects_scheduled": len(self.tower_injects)}


class _ProgressStream:
    def __init__(self, progress: Callable[[str], None]) -> None:
        self.progress = progress

    def write(self, s: str) -> None:
        if s.strip():
            self.progress(s.rstrip())

    def flush(self) -> None:
        pass


def _jsonable(v: Any) -> Any:
    if isinstance(v, datetime):
        return iso(v)
    if isinstance(v, dict):
        return {k: _jsonable(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_jsonable(x) for x in v]
    return v


def load(path: str | Path) -> tuple[batch.ScenarioSpec, dict[str, Any]]:
    raw = json.loads(Path(path).read_text())
    live = raw.get("live") or {}
    if live.get("noise_profile") not in (None, *NOISE_PROFILES):
        raise ValueError(f"live.noise_profile must be one of {NOISE_PROFILES}")
    return batch.spec_from_dict(raw), raw


__all__ = ["LiveScenarioRunner", "load", "LABEL", "UTC"]
