"""Controller event stream and actor attribution (docs/live-reports.md "Event stream", "Actor attribution").

Same setup as test_live_api: a *_test MongoDB, empty live_* collections, a frozen drill at 16:30Z.
Run with LIVE_CONTROLLER=rule so replans do not build the traffic twin.
"""

from __future__ import annotations

import json
from unittest import mock

from api.live import events
from api.live.common import col
from api.live.tests import test_live_api as base

BASE, CONTROLLER, INCIDENT = base.BASE, base.CONTROLLER, base.INCIDENT
POINT = (-121.6219, 39.7596)


class EventStreamTest(base.LiveApiTest):
    """Reuses LiveApiTest's setup and helpers; its own tests are switched off below."""

    def as_agent(self, method, path, body=None, actor="agent:test-bot"):
        extra = {"HTTP_AUTHORIZATION": f"Bearer {CONTROLLER}", "HTTP_X_CRISISTWIN_ACTOR": actor}
        fn = getattr(self.client, method.lower())
        if method == "GET":
            return fn(path, **extra)
        return fn(path, data=json.dumps(body or {}), content_type="application/json", **extra)

    def events(self, since=None, limit=None, token=CONTROLLER):
        params = []
        if since is not None:
            params.append(f"since={since}")
        if limit is not None:
            params.append(f"limit={limit}")
        r = self.call("GET", f"{BASE}/events" + ("?" + "&".join(params) if params else ""), token=token)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_auth_and_cursor_validation(self):
        civ = self.civilian()
        self.assertEqual(self.call("GET", f"{BASE}/events", token=civ).status_code, 403)
        self.assertEqual(self.call("GET", f"{BASE}/events?since=abc", token=CONTROLLER).status_code, 400)
        self.assertEqual(self.call("GET", f"{BASE}/events?limit=0", token=CONTROLLER).status_code, 400)
        now = self.events(since="now")
        self.assertEqual(now["events"], [])
        self.assertRegex(now["next_cursor"], r"^\d+:$")

    def test_report_triage_and_decision_events_in_time_order(self):
        start = self.events()  # from the beginning: the drill_start decision of setUp
        self.assertEqual([e["action"] for e in start["events"] if e["type"] == "decision"], ["drill_start"])
        civ = self.civilian()
        r = self.report(civ, POINT, minutes_ago=2)
        self.assertEqual(r.status_code, 201, r.content)
        rid = r.json()["report"]["id"]
        t = self.as_agent("POST", f"/api/live/reports/{rid}/triage", {"action": "dismiss", "note": "dup"})
        self.assertEqual(t.status_code, 200, t.content)
        page = self.events(since=start["next_cursor"])
        types = [(e["type"], e.get("change") or e.get("action")) for e in page["events"]]
        # The report is listed once, in its current (dismissed) state, at its last change.
        self.assertIn(("report", "updated"), types)
        self.assertIn(("decision", "dismiss"), types)
        report_event = next(e for e in page["events"] if e["type"] == "report")
        self.assertEqual(report_event["id"], rid)
        self.assertEqual(report_event["status"], "dismissed")
        self.assertEqual(report_event["replay_at"], "2018-11-08T16:30:00Z")
        decision = next(e for e in page["events"] if e["type"] == "decision" and e["action"] == "dismiss")
        self.assertEqual(decision["actor"], "agent:test-bot")
        self.assertEqual(decision["report_ids"], [rid])
        keys = [(e["at"], e["key"]) for e in page["events"]]
        self.assertEqual(keys, sorted(keys))
        for e in page["events"]:
            self.assertEqual(set(e) >= {"key", "at", "replay_at", "type", "id"}, True, e)
        # Within the settle window the cursor holds back: the same events come again, same keys.
        again = self.events(since=page["next_cursor"])
        self.assertEqual({e["key"] for e in again["events"]}, {e["key"] for e in page["events"]})
        with mock.patch.object(events, "EVENT_SETTLE_MS", 0):
            settled = self.events(since=start["next_cursor"])
            self.assertEqual(self.events(since=settled["next_cursor"])["events"], [])

    def test_proposal_guidance_checkin_help_and_task_events(self):
        cursor = self.events(since="now")["next_cursor"]
        r = self.as_agent("POST", f"{BASE}/replan")
        self.assertEqual(r.status_code, 201, r.content)
        pid = r.json()["proposal"]["id"]
        a = self.as_agent("POST", f"/api/live/proposals/{pid}/approve")
        self.assertEqual(a.status_code, 200, a.content)
        civ = self.civilian()
        c = self.call("POST", f"{BASE}/checkins", {"status": "need_help", "coord": list(POINT)}, civ)
        self.assertEqual(c.status_code, 200, c.content)
        chk = c.json()["checkin"]["id"]
        h = self.as_agent("POST", f"/api/live/checkins/{chk}/help", {"action": "assign", "assignee": None})
        self.assertEqual(h.status_code, 200, h.content)
        with mock.patch.object(events, "EVENT_SETTLE_MS", 0):
            got = self.events(since=cursor)["events"]
        by_type: dict[str, list] = {}
        for e in got:
            by_type.setdefault(e["type"], []).append(e)
        created = [e for e in by_type["proposal"] if e["change"] == "created"]
        self.assertEqual(created[0]["id"], pid)
        self.assertGreater(created[0]["n_changes"], 0)
        self.assertIn("to_level", created[0]["changes"][0])
        self.assertIn("approved", {e["status"] for e in by_type["proposal"] if e["change"] == "decided"})
        guidance = by_type["guidance"]
        self.assertEqual(len(guidance), len(a.json()["guidance"]))
        self.assertTrue(all(g["approved_by"] == "controller" and g["version"] == 1 for g in guidance))
        self.assertEqual(by_type["checkin"][0]["id"], chk)
        self.assertEqual(by_type["checkin"][0]["status"], "need_help")
        task = by_type["task"][0]
        self.assertEqual((task["kind"], task["change"], task["checkin_id"]), ("assist", "created", chk))
        actors = {e["action"]: e["actor"] for e in by_type["decision"]}
        self.assertEqual(actors["replan"], "agent:test-bot")
        self.assertEqual(actors["approve"], "agent:test-bot")
        self.assertEqual(actors["help_assign"], "agent:test-bot")

    def test_paging_advances_on_a_full_page(self):
        civ = self.civilian()
        for i in range(3):
            self.assertEqual(self.report(civ, (POINT[0] + 0.01 * i, POINT[1]), kind="fire_seen").status_code, 201)
        first = self.events(limit=2)
        self.assertTrue(first["more"])
        self.assertEqual(len(first["events"]), 2)
        second = self.events(since=first["next_cursor"], limit=2)
        self.assertFalse({e["key"] for e in first["events"]} & {e["key"] for e in second["events"]})


class ActorAttributionTest(base.LiveApiTest):
    """``X-CrisisTwin-Actor: agent:<name>`` on a controller request is recorded as the decision actor."""

    def triage_with(self, actor_header):
        civ = self.civilian()
        rid = self.report(civ, POINT).json()["report"]["id"]
        extra = {"HTTP_AUTHORIZATION": f"Bearer {CONTROLLER}"}
        if actor_header is not None:
            extra["HTTP_X_CRISISTWIN_ACTOR"] = actor_header
        r = self.client.post(f"/api/live/reports/{rid}/triage", data=json.dumps({"action": "dismiss"}),
                             content_type="application/json", **extra)
        self.assertEqual(r.status_code, 200, r.content)
        return col("live_decisions").find_one({"incident_id": INCIDENT, "action": "dismiss"})["actor"]

    def test_agent_header_is_recorded(self):
        self.assertEqual(self.triage_with("agent:orchestrator-a"), "agent:orchestrator-a")

    def test_missing_or_invalid_header_is_controller(self):
        self.assertEqual(self.triage_with(None), "controller")

    def test_invalid_header_is_ignored(self):
        self.assertEqual(self.triage_with("controller; drop"), "controller")

    def test_drill_action_records_agent(self):
        r = self.client.post(f"{BASE}/drill", data=json.dumps({"action": "set_speed", "speed": 0}),
                             content_type="application/json", HTTP_AUTHORIZATION=f"Bearer {CONTROLLER}",
                             HTTP_X_CRISISTWIN_ACTOR="agent:clock-bot")
        self.assertEqual(r.status_code, 200, r.content)
        doc = col("live_decisions").find_one({"action": "drill_set_speed"})
        self.assertEqual(doc["actor"], "agent:clock-bot")


for _cls in (EventStreamTest, ActorAttributionTest):
    for _name in dir(base.LiveApiTest):
        if _name.startswith("test_"):
            setattr(_cls, _name, None)  # run in test_live_api, not again here
