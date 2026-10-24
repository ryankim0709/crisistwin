"""``POST incidents/{id}/join`` with ``simulated: true`` (ADR 0038-simulated-responders): the flag
is stored on the device and the command's ``responders`` list returns it. Local MongoDB, *_test database.
"""

from __future__ import annotations

import json
from unittest import mock

from django.core.cache import cache
from django.test import SimpleTestCase, override_settings

from api.live import schema, twin_service
from api.mongodb import get_database

INCIDENT = "camp-2018-drill"
BASE = f"/api/live/incidents/{INCIDENT}"
CONTROLLER = "dev-controller"
INVITE = "DRILL"


@override_settings(LIVE_CONTROLLER_TOKEN=CONTROLLER, LIVE_INVITE_CODE=INVITE)
class SimulatedJoinTest(SimpleTestCase):
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
        patcher = mock.patch.object(twin_service, "warm", lambda: "idle")
        patcher.start()
        self.addCleanup(patcher.stop)

    def post(self, path, body, token=None):
        extra = {"HTTP_AUTHORIZATION": f"Bearer {token}"} if token else {}
        return self.client.post(path, data=json.dumps(body), content_type="application/json", **extra)

    def share(self, token):
        r = self.post("/api/live/me/location", {"coord": [-121.75, 39.74], "accuracy_m": 5}, token)
        self.assertEqual(r.status_code, 204, r.content)

    def responders(self):
        r = self.client.get(f"{BASE}/command", HTTP_AUTHORIZATION=f"Bearer {CONTROLLER}")
        self.assertEqual(r.status_code, 200, r.content)
        return {x["party_key"]: x for x in r.json()["responders"]}

    def test_simulated_flag_is_stored_and_returned(self):
        r = self.post(f"{BASE}/join", {"invite_code": INVITE, "simulated": True})
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertIs(body["simulated"], True)
        self.assertIs(get_database()["live_devices"].find_one({"party_key": body["party_key"]})["simulated"], True)
        self.share(body["token"])
        self.assertIs(self.responders()[body["party_key"]]["simulated"], True)

    def test_plain_join_is_not_simulated(self):
        r = self.post(f"{BASE}/join", {"invite_code": INVITE})
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertNotIn("simulated", body)
        self.share(body["token"])
        self.assertIs(self.responders()[body["party_key"]]["simulated"], False)

    def test_flag_must_be_a_boolean(self):
        r = self.post(f"{BASE}/join", {"invite_code": INVITE, "simulated": "yes"})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(get_database()["live_devices"].count_documents({}), 0)

    def test_bad_invite_still_403(self):
        self.assertEqual(self.post(f"{BASE}/join", {"invite_code": "nope", "simulated": True}).status_code, 403)
