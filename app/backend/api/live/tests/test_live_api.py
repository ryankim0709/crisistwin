"""Smoke tests of the live API contract (docs/live-reports.md v2) against a local MongoDB.

Run with MONGODB_URI=mongodb://127.0.0.1:27017 MONGODB_DATABASE=crisistwin_live_test. Every test
starts from empty live_* collections and a frozen drill clock (speed 0) at 16:30Z drill time.
"""

from __future__ import annotations

import json
import os
import uuid
from datetime import UTC, datetime, timedelta

from django.core.cache import cache
from django.test import SimpleTestCase, override_settings

from api.live import schema
from api.live.common import col
from api.mongodb import get_database

INCIDENT = "camp-2018-drill"
BASE = f"/api/live/incidents/{INCIDENT}"
CONTROLLER = "dev-controller"
INVITE = "DRILL"
REPLAY_START = "2018-11-08T16:30:00Z"


def iso(t: datetime) -> str:
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


@override_settings(LIVE_CONTROLLER_TOKEN=CONTROLLER, LIVE_INVITE_CODE=INVITE)
class LiveApiTest(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        db = get_database()
        if not db.name.endswith("_test"):
            raise RuntimeError(f"Refusing to wipe database {db.name!r}; use a *_test database.")
        schema.apply(db, drop_drill_data=True)

    def setUp(self):
        cache.clear()
        db = get_database()
        for name in [n for n in db.list_collection_names() if n.startswith("live_")]:
            db[name].delete_many({})
        self.ctl = self.call("POST", f"{BASE}/drill", {"action": "start", "replay_start": REPLAY_START, "speed": 0},
                             CONTROLLER)
        self.assertEqual(self.ctl.status_code, 200, self.ctl.content)

    # -- helpers
    def call(self, method, path, body=None, token=None):
        extra = {"HTTP_AUTHORIZATION": f"Bearer {token}"} if token else {}
        fn = getattr(self.client, method.lower())
        if method in ("GET", "DELETE"):
            return fn(path, **extra)
        return fn(path, data=json.dumps(body if body is not None else {}), content_type="application/json", **extra)

    def civilian(self):
        r = self.call("POST", "/api/live/devices")
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()["token"]

    def responder(self):
        r = self.call("POST", f"{BASE}/join", {"invite_code": INVITE})
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()

    def report(self, token, coord, kind="road_blocked", minutes_ago=10, **extra):
        body = {
            "client_id": str(uuid.uuid4()), "incident_id": INCIDENT, "kind": kind, "severity": "full",
            "location": {"coord": list(coord), "accuracy_m": 10}, "heading_deg": None, "destination_id": None,
            "task_id": None, "observed_at": iso(datetime.now(UTC) - timedelta(minutes=minutes_ago)), "note": None,
        }
        body.update(extra)
        return self.call("POST", f"{BASE}/reports", body, token)

    def situation(self, token, zones=True):
        r = self.call("GET", f"{BASE}/situation" + ("" if zones else "?zones=0"), token=token)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def guidance_by_zone(self, token):
        return {g["zone_id"]: g for g in self.situation(token, zones=False)["guidance"]}

    def publish_initial_guidance(self):
        r = self.call("POST", f"{BASE}/replan", {}, CONTROLLER)
        self.assertEqual(r.status_code, 201, r.content)
        pid = r.json()["proposal"]["id"]
        a = self.call("POST", f"/api/live/proposals/{pid}/approve", {}, CONTROLLER)
        self.assertEqual(a.status_code, 200, a.content)
        return a.json()

    def road_point_on_a_route(self, civ):
        for g in self.guidance_by_zone(civ).values():
            line = (g.get("route") or {}).get("line") or []
            if g["level"] == "evacuate_now" and len(line) >= 4:
                return g["zone_id"], line[len(line) // 2]
        self.fail("no routed evacuate_now zone to block")

    # -- tests
    def test_auth_failures(self):
        self.assertEqual(self.call("GET", f"{BASE}/situation").status_code, 401)
        self.assertEqual(self.call("GET", f"{BASE}/situation", token="nope").status_code, 401)
        civ = self.civilian()
        self.assertEqual(self.call("GET", f"{BASE}/command", token=civ).status_code, 403)
        self.assertEqual(self.call("POST", f"{BASE}/replan", {}, civ).status_code, 403)
        self.assertEqual(self.call("GET", f"{BASE}/road-state", token=civ).status_code, 403)
        self.assertEqual(self.call("POST", f"{BASE}/join", {"invite_code": "WRONG"}).status_code, 403)
        self.assertEqual(self.call("GET", "/api/live/incidents/nope/situation", token=civ).status_code, 404)
        self.assertEqual(self.call("GET", f"{BASE}/command", token=CONTROLLER).status_code, 200)

    def test_situation_shape(self):
        civ = self.civilian()
        s = self.situation(civ)
        self.assertEqual(len(s["zones"]), 43)
        self.assertEqual(s["fire"]["method"], "model_nowcast")
        self.assertIn("replay_now", s["drill"])
        self.assertIn("label", s["drill"])
        self.assertEqual(s["tasks"], [])
        self.assertIsNone(s["my_checkin"])
        self.assertIsNone(self.situation(civ, zones=False)["zones"])

    def test_report_is_idempotent_and_listed(self):
        civ = self.civilian()
        first = self.report(civ, (-121.6219, 39.7596), minutes_ago=5)
        self.assertEqual(first.status_code, 201, first.content)
        cid = first.json()["report"]["client_id"]
        again = self.report(civ, (-121.6219, 39.7596), client_id=cid.upper())
        self.assertEqual(again.json()["report"]["id"], first.json()["report"]["id"])
        mine = self.call("GET", "/api/live/me/reports", token=civ).json()["reports"]
        self.assertEqual(len(mine), 1)
        self.assertEqual(mine[0]["status"], "unverified")
        self.assertEqual(self.report(civ, (200, 0)).status_code, 400)

    def test_three_independent_reports_make_a_public_block(self):
        parties = [self.civilian() for _ in range(3)]
        point = (-121.6219, 39.7596)
        for i, tok in enumerate(parties):
            r = self.report(tok, point, minutes_ago=24 - 6 * i)
            self.assertEqual(r.status_code, 201, r.content)
            # Independence compares server receipt time; spread it like three real people.
            col("live_reports").update_one(
                {"id": r.json()["report"]["id"]},
                {"$set": {"received_at": datetime.now(UTC) - timedelta(minutes=24 - 6 * i)}},
            )
            cache.clear()
        before = self.call("GET", f"{BASE}/public-map", token=parties[0]).json()["items"]
        items = [x for x in before if x["kind"] == "road_blocked"]
        self.assertEqual(len(items), 1, before)
        self.assertEqual(items[0]["independent_parties"], 3)
        state = self.call("GET", f"{BASE}/road-state", token=CONTROLLER).json()["items"]
        self.assertTrue(any(s["status"] == "blocked" and s["public"] for s in state))
        self.assertEqual(len(self.situation(parties[0])["hazards"]), 1)

    def test_one_civilian_report_is_not_public_and_help_needed_never(self):
        civ = self.civilian()
        self.assertEqual(self.report(civ, (-121.6219, 39.7596)).status_code, 201)
        self.assertEqual(self.report(civ, (-121.62, 39.76), kind="help_needed", severity=None).status_code, 201)
        self.assertEqual(self.call("GET", f"{BASE}/public-map", token=civ).json()["items"], [])

    def test_replan_approve_then_confirmed_block_auto_reroutes(self):
        civ = self.civilian()
        published = self.publish_initial_guidance()
        self.assertTrue(published["guidance"])
        before = self.guidance_by_zone(civ)
        self.assertTrue(all(g["version"] == 1 for g in before.values()))
        evac = [g for g in before.values() if g["level"] == "evacuate_now"]
        self.assertTrue(evac)
        self.assertTrue(all(g["approved_by"] == "controller" for g in before.values()))
        zone_id, point = self.road_point_on_a_route(civ)
        rpt = self.report(civ, point, minutes_ago=2)
        self.assertEqual(rpt.status_code, 201, rpt.content)
        rid = rpt.json()["report"]["id"]
        self.assertEqual(self.call("POST", f"/api/live/reports/{rid}/triage", {"action": "confirm"}, "bad").status_code, 401)
        self.assertEqual(self.call("POST", f"/api/live/reports/{rid}/triage", {"action": "confirm"}, civ).status_code, 403)
        t = self.call("POST", f"/api/live/reports/{rid}/triage", {"action": "confirm"}, CONTROLLER)
        self.assertEqual(t.status_code, 200, t.content)
        self.assertEqual(t.json()["report"]["status"], "confirmed")
        auto = t.json()["replan"]["auto_approved"]
        self.assertIsNotNone(auto, "a confirmed block that changes only routes must auto-approve")
        self.assertEqual(auto["status"], "auto_approved")
        self.assertEqual(auto["policy"], "auto_reroute")
        self.assertTrue(all(c["kind"] == "reroute" for c in auto["changes"]))
        after = self.guidance_by_zone(civ)
        self.assertGreater(after[zone_id]["version"], before[zone_id]["version"])
        self.assertEqual(after[zone_id]["approved_by"], "auto_policy")
        hazards = self.situation(civ)["hazards"]
        self.assertTrue(any(h["controller_confirmed"] for h in hazards))
        # the proposal log reaches the controller
        cmd = self.call("GET", f"{BASE}/command", token=CONTROLLER).json()
        self.assertTrue(any(p["status"] == "auto_approved" for p in cmd["proposals"]))

    def test_manual_replan_is_pending_and_reject_conflicts_once_decided(self):
        r = self.call("POST", f"{BASE}/replan", {}, CONTROLLER)
        self.assertEqual(r.status_code, 201)
        proposal = r.json()["proposal"]
        self.assertEqual(proposal["status"], "pending")
        self.assertEqual(proposal["policy"], "needs_controller")
        rej = self.call("POST", f"/api/live/proposals/{proposal['id']}/reject", {"note": "test"}, CONTROLLER)
        self.assertEqual(rej.status_code, 200)
        self.assertEqual(rej.json()["proposal"]["status"], "rejected")
        self.assertEqual(self.call("POST", f"/api/live/proposals/{proposal['id']}/approve", {}, CONTROLLER).status_code, 409)

    def test_responder_join_task_accept_and_location(self):
        rsp = self.responder()
        self.assertEqual(rsp["role"], "responder")
        other = self.responder()
        civ = self.civilian()
        t = self.call("POST", f"{BASE}/tasks", {"assignee": None, "target": {"coord": [-121.6219, 39.7596]},
                                                  "report_ids": [], "note": "Check Skyway"}, CONTROLLER)
        self.assertEqual(t.status_code, 201, t.content)
        task_id = t.json()["task"]["id"]
        mine = self.call("GET", "/api/live/me/tasks", token=rsp["token"]).json()["tasks"]
        self.assertEqual([x["id"] for x in mine], [task_id])
        self.assertEqual(self.call("GET", "/api/live/me/tasks", token=civ).status_code, 403)
        ok = self.call("POST", f"/api/live/tasks/{task_id}", {"status": "accepted"}, rsp["token"])
        self.assertEqual(ok.status_code, 200, ok.content)
        self.assertEqual(ok.json()["task"]["assignee"], rsp["party_key"])
        self.assertEqual(self.call("POST", f"/api/live/tasks/{task_id}", {"status": "accepted"}, other["token"]).status_code, 409)
        self.assertEqual(self.call("POST", f"/api/live/tasks/{task_id}", {"status": "accepted"}, civ).status_code, 403)
        loc = {"coord": [-121.6, 39.76], "accuracy_m": 15, "at": iso(datetime.now(UTC))}
        self.assertEqual(self.call("POST", "/api/live/me/location", loc, civ).status_code, 403)
        self.assertEqual(self.call("POST", "/api/live/me/location", loc, rsp["token"]).status_code, 204)
        cmd = self.call("GET", f"{BASE}/command", token=CONTROLLER).json()
        self.assertEqual([r["party_key"] for r in cmd["responders"]], [rsp["party_key"]])
        self.assertEqual(self.call("DELETE", "/api/live/me/location", token=rsp["token"]).status_code, 204)
        self.assertEqual(self.call("GET", f"{BASE}/command", token=CONTROLLER).json()["responders"], [])

    def test_checkins_keep_location_only_for_need_help(self):
        civ = self.civilian()
        zone = self.situation(civ)["zones"][0]["id"]
        bad = self.call("POST", f"{BASE}/checkins", {"status": "out", "zone_id": zone, "coord": [-121.6, 39.76]}, civ)
        self.assertEqual(bad.status_code, 400)
        need = self.call("POST", f"{BASE}/checkins", {"status": "need_help", "zone_id": zone, "coord": [-121.6, 39.76]}, civ)
        self.assertEqual(need.status_code, 200, need.content)
        self.assertEqual(need.json()["checkin"]["coord"], [-121.6, 39.76])
        cmd = self.call("GET", f"{BASE}/command", token=CONTROLLER).json()
        self.assertEqual(len(cmd["checkins"]["need_help"]), 1)
        out = self.call("POST", f"{BASE}/checkins", {"status": "out", "zone_id": zone}, civ)
        self.assertIsNone(out.json()["checkin"]["coord"])
        self.assertEqual(self.call("GET", f"{BASE}/command", token=CONTROLLER).json()["checkins"]["need_help"], [])
        self.assertEqual(self.situation(civ)["my_checkin"]["status"], "out")
