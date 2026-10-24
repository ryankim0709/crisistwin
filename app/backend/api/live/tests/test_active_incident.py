"""The active incident (docs/adr/0047-active-incident.md): switching, per-incident drill indexes,
views keyed by incident, and a Studio package incident's command, situation and twin.

Needs a local MongoDB (a ``*_test`` database) and the Camp bundle, e.g.
``MONGODB_URI=mongodb://localhost:27017 MONGODB_DATABASE=crisistwin_active_test``. No network: the
package's dispatch area is the ``test_packages`` fixture.
"""

from __future__ import annotations

import gzip
import json
import tempfile
from unittest import mock

from django.core.cache import cache
from django.test import SimpleTestCase, override_settings

from api import dispatch_area
from api.live import drillcache, incidents, schema, twin_service
from api.live.common import col
from api.mongodb import get_database

from .test_packages import fixture_area, fixture_run

CAMP = "camp-2018-drill"
CONTROLLER = "active-controller"


@override_settings(LIVE_CONTROLLER_TOKEN=CONTROLLER, LIVE_INVITE_CODE="DRILL")
class ActiveIncidentTest(SimpleTestCase):
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
        incidents.clear_cache()
        self.addCleanup(incidents.clear_cache)
        self.addCleanup(lambda: col("live_active").delete_many({}))  # leave Camp active for other tests
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        override = override_settings(LIVE_PACKAGES_DIR=self.tmp.name)
        override.enable()
        self.addCleanup(override.disable)
        gz = gzip.compress(json.dumps(fixture_area()).encode())
        patcher = mock.patch.object(dispatch_area, "get_area_gzip", return_value=gz)
        patcher.start()
        self.addCleanup(patcher.stop)
        res = self.call("POST", "/api/live/packages", fixture_run())
        self.assertEqual(res.status_code, 201, res.content)
        self.pkg = res.json()
        self.inc = self.pkg["incident_id"]
        # Background twin builds would outlive this test's package directory: they do nothing here,
        # and test_package_twin builds synchronously with the real function.
        self.build_inputs = twin_service._build_inputs
        patcher = mock.patch.object(twin_service, "_build_inputs", lambda incident_id: None)
        patcher.start()
        self.addCleanup(patcher.stop)
        twin_service._inputs.pop(self.inc, None)
        twin_service._sessions.pop(self.inc, None)

    def call(self, method, path, body=None, token=CONTROLLER):
        extra = {"HTTP_AUTHORIZATION": f"Bearer {token}"} if token else {}
        if method == "GET":
            return self.client.get(path, **extra)
        return self.client.post(path, data=json.dumps(body if body is not None else {}),
                                content_type="application/json", **extra)

    def activate(self, **body):
        with mock.patch.object(twin_service, "warm", return_value="warming"):  # no background build here
            return self.call("POST", "/api/live/active", body)

    def test_default_is_camp_and_switching_follows(self):
        active = self.client.get("/api/live/active").json()
        self.assertEqual((active["incident_id"], active["source"], active["package_id"]), (CAMP, "bundle", None))

        res = self.activate(package_id=self.pkg["package_id"])
        self.assertEqual(res.status_code, 200, res.content)
        self.assertTrue(res.json()["changed"])
        active = self.client.get("/api/live/active").json()
        self.assertEqual((active["incident_id"], active["source"]), (self.inc, "package"))
        self.assertEqual(active["package_id"], self.pkg["package_id"])
        self.assertIn("Not a real incident", active["label"])
        self.assertIsNotNone(active["activated_at"])
        doc = col("live_active").find_one({"_id": "active"})
        self.assertEqual((doc["incident_id"], doc["actor"]), (self.inc, "controller"))
        self.assertEqual(col("live_decisions").count_documents({"incident_id": self.inc,
                                                                "action": "incident_activated"}), 1)

        self.assertFalse(self.activate(package_id=self.pkg["package_id"]).json()["changed"])
        back = self.activate(incident_id=CAMP)
        self.assertEqual(back.status_code, 200, back.content)
        self.assertEqual(self.client.get("/api/live/active").json()["incident_id"], CAMP)

    def test_switch_validation(self):
        self.assertEqual(self.call("POST", "/api/live/active", {"incident_id": CAMP}, token="wrong").status_code, 401)
        self.assertEqual(self.activate().status_code, 400)
        self.assertEqual(self.activate(package_id=self.pkg["package_id"], incident_id=CAMP).status_code, 400)
        self.assertEqual(self.activate(package_id="pkg_000000000000").status_code, 404)
        self.assertEqual(self.activate(package_id="../etc").status_code, 404)
        self.assertEqual(self.activate(incident_id="studio-000000000000").status_code, 404)
        self.assertEqual(self.activate(incident_id="other").status_code, 404)
        self.assertEqual(self.client.get("/api/live/active").json()["incident_id"], CAMP)

    def test_per_incident_index_cache(self):
        camp = drillcache.get_index(CAMP)
        pkg = drillcache.get_index(self.inc)
        self.assertEqual(camp.drill.incident_id, CAMP)
        self.assertEqual(pkg.drill.incident_id, self.inc)
        self.assertIs(drillcache.get_index(self.inc), pkg)
        self.assertIs(drillcache.get_index(CAMP), camp)
        self.assertEqual(set(pkg.zones), {"Z01", "Z02"})
        self.assertIn("Studio", pkg.drill.label)
        self.assertIs(drillcache.get_index(), camp)  # no request incident: the active one
        self.activate(package_id=self.pkg["package_id"])
        self.assertIs(drillcache.get_index(), pkg)

    def test_views_keyed_by_incident_and_unknown_is_404(self):
        # A stored package that is not active is not served.
        self.assertEqual(self.call("GET", f"/api/live/incidents/{self.inc}/command").status_code, 404)
        self.assertEqual(self.call("GET", "/api/live/incidents/nope/command").status_code, 404)
        self.activate(package_id=self.pkg["package_id"])
        civ = self.call("POST", "/api/live/devices", token=None).json()["token"]
        pkg = self.call("GET", f"/api/live/incidents/{self.inc}/situation", token=civ)
        self.assertEqual(pkg.status_code, 200, pkg.content)
        self.assertEqual(pkg.json()["incident"]["id"], self.inc)
        self.assertEqual({z["id"] for z in pkg.json()["zones"]}, {"Z01", "Z02"})
        camp = self.call("GET", f"/api/live/incidents/{CAMP}/situation", token=civ)
        self.assertEqual(camp.status_code, 200)
        self.assertEqual(camp.json()["incident"]["id"], CAMP)
        self.assertGreater(len(camp.json()["zones"]), 2)
        self.assertEqual(self.call("GET", "/api/live/incidents/studio-000000000000/situation", token=civ).status_code,
                         404)
        # A zone of one incident is unknown in the other.
        res = self.call("POST", f"/api/live/incidents/{CAMP}/checkins", {"status": "out", "zone_id": "Z01"}, token=civ)
        self.assertEqual(res.status_code, 400)
        res = self.call("POST", f"/api/live/incidents/{self.inc}/checkins", {"status": "out", "zone_id": "Z01"},
                        token=civ)
        self.assertEqual(res.status_code, 200, res.content)

    def test_package_incident_command_and_drill(self):
        self.activate(package_id=self.pkg["package_id"])
        base = f"/api/live/incidents/{self.inc}"
        drill = self.call("POST", f"{base}/drill", {"action": "start", "speed": 0})
        self.assertEqual(drill.status_code, 200, drill.content)
        self.assertEqual(drill.json()["drill"]["replay_start"], "2026-10-24T20:00:00Z")  # package T+0
        with mock.patch.object(twin_service, "warm", return_value="warming"):
            cmd = self.call("GET", f"{base}/command")
        self.assertEqual(cmd.status_code, 200, cmd.content)
        body = cmd.json()
        self.assertEqual(body["incident"]["id"], self.inc)
        self.assertEqual({d["id"] for d in body["destinations"]}, {"X01", "X02"})
        self.assertFalse(body["ground_record"]["available"])  # the 2018 record is Camp's
        self.assertEqual(body["response_record"], [])
        replan = self.call("POST", f"{base}/replan", {})
        self.assertIn(replan.status_code, (200, 201), replan.content)
        reset = self.call("POST", f"{base}/drill", {"action": "reset"})
        self.assertEqual(reset.json()["drill"]["replay_start"], "2026-10-24T20:00:00Z")

    def test_package_twin(self):
        self.activate(package_id=self.pkg["package_id"])
        inputs = twin_service.build_package_inputs(self.inc)
        zones = {z.id: z for z in inputs.scenario["zones"]}
        self.assertEqual(set(zones), {"Z01", "Z02"})
        self.assertEqual(sum(z.vehicles for z in zones.values()), 195)  # the package's synthetic vehicles
        self.assertTrue(all(z.origin_nodes for z in zones.values()))
        self.assertEqual({d.id for d in inputs.scenario["destinations"]}, {"X01", "X02"})
        self.build_inputs(self.inc)
        self.assertEqual(twin_service.status(self.inc)["status"], "ready", twin_service.status(self.inc))
        base = f"/api/live/incidents/{self.inc}"
        self.call("POST", f"{base}/drill", {"action": "start", "speed": 0})
        res = self.call("GET", f"{base}/twin")
        self.assertEqual(res.status_code, 200, res.content)
        mon = res.json()
        self.assertEqual(mon["incident_id"], self.inc)
        self.assertTrue(mon["conserved"])
        self.assertEqual(mon["totals"]["total_veh"], 195)
        self.assertTrue(any("synthetic" in x.lower() for x in mon["limitations"]))
        what = self.call("POST", f"{base}/twin/whatif", {
            "action_sets": [[{"type": "order_zone", "target": {"zone_id": "Z01"}, "params": {},
                              "actor": {"kind": "controller", "id": "test"}, "rationale": "test"}]],
            "horizon_min": 60})
        self.assertEqual(what.status_code, 200, what.content)
