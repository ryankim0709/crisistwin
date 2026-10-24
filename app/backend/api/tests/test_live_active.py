from django.test import SimpleTestCase, override_settings
from django.urls import reverse


class LiveActiveTests(SimpleTestCase):
    def test_defaults_to_the_camp_drill_without_auth(self):
        with override_settings(LIVE_INVITE_CODE="", LIVE_CONTROLLER_TOKEN="secret"):
            response = self.client.get(reverse("live-active"))
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["incident_id"], "camp-2018-drill")
        self.assertEqual(body["mode"], "drill")
        self.assertIn("Not a real incident", body["label"])
        self.assertEqual(body["join"], {"invite_required": False})
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    @override_settings(LIVE_INVITE_CODE="DRILLCODE")
    def test_invite_required_never_leaks_the_code(self):
        response = self.client.get("/api/live/active")
        self.assertEqual(response.json()["join"], {"invite_required": True})
        self.assertNotIn("DRILLCODE", response.content.decode())

    @override_settings(LIVE_ACTIVE_INCIDENT_ID="other-drill", LIVE_ACTIVE_NAME="Other", LIVE_ACTIVE_MODE="bogus")
    def test_configurable_and_unknown_mode_falls_back(self):
        body = self.client.get("/api/live/active").json()
        self.assertEqual((body["incident_id"], body["name"], body["mode"]), ("other-drill", "Other", "drill"))

    @override_settings(LIVE_CONTROLLER_TOKEN="secret")
    def test_switching_needs_the_controller(self):
        # Switching is tested in api/live/tests/test_active_incident.py.
        self.assertEqual(self.client.post("/api/live/active", {}).status_code, 401)
        self.assertEqual(self.client.put("/api/live/active", {}).status_code, 405)
