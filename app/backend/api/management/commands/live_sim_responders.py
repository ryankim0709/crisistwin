"""Run simulated responder units against a live drill API (ADR 0038-simulated-responders).

Joins ``--units`` responders with the invite code (flagged ``simulated``), then loops in real
time: reads the drill clock, open tasks and road state over HTTP, steps the pure
``livecore.responders_sim.Fleet`` and POSTs the calls it returns with each unit's own token.
The units show on the console (tagged "sim") and on phones. Stop with Ctrl-C (or ``--duration``);
their locations are removed on exit.

    python manage.py live_sim_responders --units 4 --speed-up 1 --base http://127.0.0.1:8000
"""

import json
import os
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime

from django.core.management.base import BaseCommand, CommandError

from api.live.drillcache import get_index
from livecore.drill import INCIDENT_ID, parse_time
from livecore.fire import estimate_fire
from livecore.responders_sim import Fleet, World


class Command(BaseCommand):
    help = "Join simulated responders and drive them through the live drill's tasks (all labelled simulated)."

    def add_arguments(self, parser):
        parser.add_argument("--units", type=int, default=4)
        parser.add_argument("--speed-up", type=float, default=1.0,
                            help="Units drive and work this many times faster than the assumption table (demo knob).")
        parser.add_argument("--base", default="http://127.0.0.1:8000", help="Server origin.")
        parser.add_argument("--incident", default=INCIDENT_ID)
        parser.add_argument("--invite", default=os.environ.get("LIVE_INVITE_CODE", ""), help="Invite code.")
        parser.add_argument("--interval", type=float, default=2.0, help="Wall seconds between ticks.")
        parser.add_argument("--duration", type=float, default=0.0, help="Stop after this many wall seconds (0 = run until Ctrl-C).")
        parser.add_argument("--seed", type=int, default=0)

    # -- http -----------------------------------------------------------------------------

    def http(self, method, path, token=None, body=None, ok=(200, 201, 204, 409)):
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
        except urllib.error.URLError as exc:
            raise CommandError(f"{self.base} unreachable: {exc.reason}") from exc
        if code not in ok:
            raise CommandError(f"{method} {path} returned {code}: {raw[:200]!r}")
        return code, (json.loads(raw) if raw else {})

    # -- loop -----------------------------------------------------------------------------

    def handle(self, *args, **opts):
        if not opts["invite"]:
            raise CommandError("Give --invite or set LIVE_INVITE_CODE.")
        self.base = opts["base"].rstrip("/") + "/api/live/"
        inc = opts["incident"]
        drill = get_index(inc).drill
        fleet = Fleet(drill, opts["units"], seed=opts["seed"], incident_id=inc, tempo=opts["speed_up"])
        tokens: dict[str, str] = {}
        self.locations = 0
        _, dev = self.http("POST", "devices", None, {}, ok=(200, 201))
        self.clock_token = dev["token"]  # a civilian token only reads the drill clock
        started = time.monotonic()
        self.stdout.write(f"{len(fleet.units)} simulated units, drill {inc}, base {self.base}")
        try:
            while True:
                try:
                    self.tick(fleet, tokens, drill, inc, opts["invite"])
                except CommandError as exc:
                    if not tokens:
                        raise  # could not even join: a real configuration error
                    self.stderr.write(f"tick skipped: {exc}")
                if opts["duration"] and time.monotonic() - started >= opts["duration"]:
                    break
                time.sleep(opts["interval"])
        except KeyboardInterrupt:
            pass
        finally:
            for token in tokens.values():
                try:
                    self.http("DELETE", "me/location", token)
                except CommandError:
                    pass
            self.stdout.write(f"stopped; {self.locations} location updates sent, locations removed")

    def tick(self, fleet, tokens, drill, inc, invite):
        any_token = next(iter(tokens.values()), None)
        _, sit = self.http("GET", f"incidents/{inc}/situation?zones=0", self.clock_token)
        at = parse_time(sit["drill"]["replay_now"])
        tasks, blocked = {}, set()
        for token in tokens.values():
            _, body = self.http("GET", "me/tasks", token)
            for t in body.get("tasks", []):
                tasks[t["id"]] = t
        if any_token:
            _, rs = self.http("GET", f"incidents/{inc}/road-state", any_token)
            blocked = {s["segment_id"] for s in rs.get("segments", rs.get("items", [])) if s.get("status") == "blocked"}
        fire = estimate_fire(drill, at).geometry
        world = World(known_blocked=frozenset(blocked), truth_blocked=frozenset(blocked), fire=fire)
        for call in fleet.tick(at, tasks.values(), world):
            self.apply(fleet, tokens, call, invite)

    def apply(self, fleet, tokens, call, invite):
        uid, op, body = call["unit"], call["op"], dict(call["body"])
        if op == "join":
            _, resp = self.http("POST", call["path"], None, {**body, "invite_code": invite}, ok=(201,))
            tokens[uid] = resp["token"]
            fleet.bind(uid, resp["party_key"])
            self.stdout.write(f"{uid} joined as {resp['party_key']} (simulated={resp.get('simulated')})")
            return
        if op == "report":
            body["observed_at"] = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        code, _ = self.http(call["method"], call["path"], tokens[uid], body, ok=(200, 201, 204, 400, 409))
        if op == "accept" and code != 200:
            fleet.accept_failed(uid, call["path"].rsplit("/", 1)[1])
        elif op == "location":
            self.locations += code == 204
        else:
            self.stdout.write(f"{call['at']} {uid} {op} {call['path']} -> {code}")
