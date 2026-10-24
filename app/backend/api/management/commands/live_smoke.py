"""End-to-end check of the phone <-> /live loop over HTTP, without the iOS app or a browser.

Plays a civilian phone, a responder phone and the web controller against a running server:
report -> controller sees and confirms it -> phone sees the status -> replan and approve ->
phone gets guidance -> destination choice, check-ins, responder location -> controller sees
them -> need help acknowledged, assigned and closed by a responder -> verify task. It writes drill data (the report note says it is
synthetic); run `live_drill --reset` afterwards for a clean drill.
"""

import json
import os
import time
import urllib.error
import urllib.request
import uuid

from django.core.management.base import BaseCommand, CommandError
from livecore.drill import INCIDENT_ID

# Skyway in Paradise, where `live_drill --seed` puts its fixture block. [lon, lat].
REPORT_COORD = [-121.6012, 39.7593]
HELP_COORD = [-121.60, 39.76]
RESPONDER_COORD = [-121.61, 39.75]


class Command(BaseCommand):
    help = "Run the phone <-> /live loop against a running server (writes synthetic drill data)."

    def add_arguments(self, parser):
        parser.add_argument("--base", default="http://127.0.0.1:8000", help="Server origin.")
        parser.add_argument("--incident", default=INCIDENT_ID)

    def handle(self, *args, **options):
        controller = os.environ.get("LIVE_CONTROLLER_TOKEN")
        invite = os.environ.get("LIVE_INVITE_CODE")
        if not controller or not invite:
            raise CommandError("Set LIVE_CONTROLLER_TOKEN and LIVE_INVITE_CODE (same values as the server).")
        self.base = options["base"].rstrip("/") + "/api/live/"
        inc = options["incident"]
        self.fails = 0

        civilian = self.call("POST", "devices")["token"]
        responder = self.call("POST", f"incidents/{inc}/join", body={"invite_code": invite})["token"]

        sit = self.call("GET", f"incidents/{inc}/situation", civilian)
        self.expect("phone: situation has zones and a fire estimate", bool(sit["zones"]) and sit["fire"] is not None)

        report = self.call(
            "POST",
            f"incidents/{inc}/reports",
            civilian,
            {
                "client_id": str(uuid.uuid4()),
                "kind": "road_blocked",
                "severity": "full",
                "location": {"coord": REPORT_COORD, "accuracy_m": 10},
                "observed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "note": "live_smoke: synthetic test report",
            },
        )
        rid = report["report"]["id"]
        cmd = self.call("GET", f"incidents/{inc}/command", controller)
        self.expect("web: sees the phone's report", any(r["id"] == rid for r in cmd["reports"]))

        self.call("POST", f"reports/{rid}/triage", controller, {"action": "confirm"})
        mine = self.call("GET", "me/reports", civilian)
        status = next((r["status"] for r in mine["reports"] if r["id"] == rid), None)
        self.expect(f"phone: sees its report confirmed ({status})", status == "confirmed")

        self.call("POST", f"incidents/{inc}/replan", controller, {})
        cmd = self.call("GET", f"incidents/{inc}/command", controller)
        pending = [p for p in cmd["proposals"] if p["status"] == "pending"]
        self.expect("web: a guidance proposal is pending", bool(pending))
        for proposal in pending:
            self.call("POST", f"proposals/{proposal['id']}/approve", controller, {})

        sit = self.call("GET", f"incidents/{inc}/situation?zones=0", civilian)
        guidance = sit["guidance"]
        self.expect(f"phone: receives approved guidance ({len(guidance)} zones)", bool(guidance))
        if not guidance:
            raise CommandError(f"{self.fails} check(s) failed; no guidance to continue with.")
        g = guidance[0]
        zone = g["zone_id"]

        offered = [a["destination"]["id"] for a in g.get("alternatives") or []] or [g["destination"]["id"]]
        self.call("POST", "me/destination", civilian, {"zone_id": zone, "destination_id": offered[-1]})
        self.call("POST", f"incidents/{inc}/checkins", civilian, {"status": "out", "zone_id": zone})
        helper = self.call("POST", "devices")["token"]
        self.call("POST", f"incidents/{inc}/checkins", helper, {"status": "need_help", "zone_id": zone, "coord": HELP_COORD})
        self.call("POST", "me/location", responder, {"coord": RESPONDER_COORD, "accuracy_m": 8})

        cmd = self.call("GET", f"incidents/{inc}/command", controller)
        by_zone = {r["zone_id"]: r for r in cmd["checkins"]["by_zone"]}
        self.expect("web: sees check-ins", by_zone.get(zone, {}).get("out", 0) >= 1 and bool(cmd["checkins"]["need_help"]))
        self.expect("web: sees destination choices", bool(cmd.get("destination_preferences")))
        self.expect("web: sees the responder's position", bool(cmd["responders"]))

        help_id = next(h["id"] for h in cmd["checkins"]["need_help"])
        self.call("POST", f"checkins/{help_id}/help", controller, {"action": "acknowledge"})
        sit = self.call("GET", f"incidents/{inc}/situation?zones=0", helper)
        self.expect("phone: sees its help request acknowledged", (sit["my_checkin"]["help"] or {}).get("status") == "acknowledged")
        assigned = self.call("POST", f"checkins/{help_id}/help", controller, {"action": "assign", "assignee": None})
        assist_id = assigned["checkin"]["help"]["task_id"]
        tasks = self.call("GET", "me/tasks", responder)
        self.expect("phone: responder receives the assist task", any(t["id"] == assist_id and t["kind"] == "assist" for t in tasks["tasks"]))
        self.call("POST", f"tasks/{assist_id}", responder, {"status": "accepted"})
        self.call("POST", f"tasks/{assist_id}", responder, {"status": "done"})
        sit = self.call("GET", f"incidents/{inc}/situation?zones=0", helper)
        self.expect("phone: sees its help request resolved", (sit["my_checkin"]["help"] or {}).get("status") == "resolved")

        self.call(
            "POST",
            f"incidents/{inc}/tasks",
            controller,
            {"kind": "verify", "target": {"coord": REPORT_COORD}, "report_ids": [rid], "assignee": None},
        )
        tasks = self.call("GET", "me/tasks", responder)
        self.expect("phone: responder receives the check task", bool(tasks["tasks"]))

        if self.fails:
            raise CommandError(f"{self.fails} check(s) failed.")
        self.stdout.write(self.style.SUCCESS("live loop OK"))

    def call(self, method, path, token=None, body=None):
        headers = {"Accept": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if body is not None:
            headers["Content-Type"] = "application/json"
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        started = time.monotonic()
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                code, raw = response.status, response.read()
        except urllib.error.HTTPError as exc:
            code, raw = exc.code, exc.read()
        except urllib.error.URLError as exc:
            raise CommandError(f"{self.base} unreachable: {exc.reason}") from exc
        ms = (time.monotonic() - started) * 1000
        self.stdout.write(f"  {method:4} {path.split('?')[0]:48} {code} {ms:6.0f} ms")
        if code >= 300:
            raise CommandError(f"{method} {path} returned {code}: {raw[:300]!r}")
        return json.loads(raw) if raw else {}

    def expect(self, name, ok):
        self.stdout.write((self.style.SUCCESS("PASS ") if ok else self.style.ERROR("FAIL ")) + name)
        if not ok:
            self.fails += 1
