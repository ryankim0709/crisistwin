"""``GET /api/live/tasks/{task_id}/route`` (docs/live-reports.md "Tasks (v2 additions)") against a
local MongoDB. The twin is patched: unavailable, or a fake set of simulated edge speeds.
"""

from __future__ import annotations

import json
from unittest import mock

from django.core.cache import cache
from django.test import SimpleTestCase, override_settings

from api.live import responder_routing, schema, twin_service
from api.live.drillcache import get_index
from api.mongodb import get_database
from livecore.inbound import CONGESTION_MAX_FACTOR, inbound_route

INCIDENT = "camp-2018-drill"
BASE = f"/api/live/incidents/{INCIDENT}"
CONTROLLER = "dev-controller"
INVITE = "DRILL"
ORIGIN = [-121.75, 39.74]
TARGET = [-121.70, 39.73]
"""West of Paradise, outside the 16:30Z fire estimate; reachable over Honey Run / Skyway."""


@override_settings(LIVE_CONTROLLER_TOKEN=CONTROLLER, LIVE_INVITE_CODE=INVITE)
class TaskRouteTest(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        db = get_database()
        if not db.name.endswith("_test"):
            raise RuntimeError(f"Refusing to wipe database {db.name!r}; use a *_test database.")
        schema.apply(db, drop_drill_data=True)

    def setUp(self):
        cache.clear()
        responder_routing._congestion.clear()
        db = get_database()
        for name in [n for n in db.list_collection_names() if n.startswith("live_")]:
            db[name].delete_many({})
        r = self.call("POST", f"{BASE}/drill", {"action": "start", "replay_start": "2018-11-08T16:30:00Z", "speed": 0},
                      CONTROLLER)
        self.assertEqual(r.status_code, 200, r.content)
        self.rsp = self.call("POST", f"{BASE}/join", {"invite_code": INVITE}).json()
        self.task = self.create_task(self.rsp["party_key"])
        patcher = mock.patch.object(twin_service, "ensure_ready", lambda: False)
        patcher.start()
        self.addCleanup(patcher.stop)

    def call(self, method, path, body=None, token=None):
        extra = {"HTTP_AUTHORIZATION": f"Bearer {token}"} if token else {}
        if method == "GET":
            return self.client.get(path, **extra)
        return self.client.post(path, data=json.dumps(body or {}), content_type="application/json", **extra)

    def create_task(self, assignee, target=TARGET):
        r = self.call("POST", f"{BASE}/tasks", {"assignee": assignee, "target": {"coord": target}}, CONTROLLER)
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()["task"]

    def share_location(self, token, coord=ORIGIN):
        r = self.call("POST", "/api/live/me/location", {"coord": coord, "accuracy_m": 10}, token)
        self.assertEqual(r.status_code, 204, r.content)

    def route(self, task_id, token, query=""):
        return self.call("GET", f"/api/live/tasks/{task_id}/route{query}", token=token)

    def test_no_origin_until_location_is_shared(self):
        r = self.route(self.task["id"], self.rsp["token"])
        self.assertEqual(r.status_code, 409, r.content)
        body = r.json()
        self.assertEqual((body["reason"], body["route"], body["evidence_class"]), ("no_origin", None, "simulated"))
        self.assertEqual(body["as_of"], "2018-11-08T16:30:00Z")

    def test_responder_route_free_flow_when_twin_unavailable(self):
        self.share_location(self.rsp["token"])
        r = self.route(self.task["id"], self.rsp["token"])
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertIsNone(body["reason"], body)
        route = body["route"]
        self.assertEqual(route["congestion"], "unavailable")
        self.assertIn(route["exposure"], ("clear", "near_fire"))
        self.assertGreater(route["distance_m"], 1000)
        self.assertGreaterEqual(route["eta_min"], 1)
        self.assertGreaterEqual(len(route["line"]), 2)
        self.assertTrue(all(len(p) == 2 for p in route["line"]))

    def test_access_rules(self):
        other = self.call("POST", f"{BASE}/join", {"invite_code": INVITE}).json()
        self.assertEqual(self.route(self.task["id"], other["token"]).status_code, 404)
        civ = self.call("POST", "/api/live/devices").json()["token"]
        self.assertEqual(self.route(self.task["id"], civ).status_code, 403)
        self.assertEqual(self.route("tsk_missing", CONTROLLER).status_code, 404)
        # An unassigned open task is visible to any responder of the incident.
        open_task = self.create_task(None)
        self.share_location(other["token"])
        self.assertEqual(self.route(open_task["id"], other["token"]).status_code, 200)

    def test_controller_uses_assignee_location_or_from(self):
        self.assertEqual(self.route(self.task["id"], CONTROLLER).status_code, 409)
        r = self.route(self.task["id"], CONTROLLER, f"?from={ORIGIN[0]},{ORIGIN[1]}")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNotNone(r.json()["route"])
        self.assertEqual(self.route(self.task["id"], CONTROLLER, "?from=nope").status_code, 400)
        self.share_location(self.rsp["token"])
        self.assertEqual(r.json()["route"], self.route(self.task["id"], CONTROLLER).json()["route"])

    def test_unreachable_target_is_explicit(self):
        far = self.create_task(self.rsp["party_key"], target=[-71.4, 41.8])
        self.share_location(self.rsp["token"])
        r = self.route(far["id"], self.rsp["token"])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()["reason"], r.json()["route"]), ("unreachable", None))
        self.assertTrue(r.json()["detail"])

    def test_closed_task_has_no_route(self):
        self.call("POST", f"/api/live/tasks/{self.task['id']}", {"status": "cancelled"}, CONTROLLER)
        self.assertEqual(self.route(self.task["id"], CONTROLLER, "?from=-121.75,39.74").status_code, 409)

    def test_twin_congestion_slows_the_route(self):
        self.share_location(self.rsp["token"])
        free = inbound_route(get_index().drill, tuple(ORIGIN), tuple(TARGET), frozenset(), None)
        self.assertIsNone(free.reason)
        edges = get_index().drill.roads.edges
        jam = {free.route.edge_ids[0]: (20, 0.0, edges[free.route.edge_ids[0]].speed_kph)}
        with mock.patch.object(twin_service, "ensure_ready", lambda: True), \
                mock.patch.object(twin_service, "edge_speeds", lambda snapshot: jam):
            body = self.route(self.task["id"], self.rsp["token"]).json()
        self.assertEqual(body["route"]["congestion"], "twin")
        self.assertGreaterEqual(body["route"]["eta_min"], free.route.eta_min)
        self.assertEqual(responder_routing._congestion[INCIDENT][2], {free.route.edge_ids[0]: CONGESTION_MAX_FACTOR})
