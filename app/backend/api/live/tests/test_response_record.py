"""Command ``response_record`` (docs/live-reports.md "Command"): the historical 2018 record from the
bundle, never simulated events, never after the drill clock."""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime

from django.core.cache import cache
from django.test import SimpleTestCase, override_settings

from api.live import drillcache, schema
from api.live.drillcache import get_index, response_record_until
from api.mongodb import get_database

BASE = "/api/live/incidents/camp-2018-drill"
CONTROLLER = "dev-controller"


class ResponseRecordIndexTest(SimpleTestCase):
    def test_excludes_simulated_and_hides_future(self):
        index = get_index()
        with open(drillcache.bundle_path(), encoding="utf-8") as fh:
            events = json.load(fh)["events"]
        historical = [e for e in events if e.get("evidence_class") != "simulated"]
        self.assertTrue(0 < len(historical) < len(events))
        self.assertEqual(len(index.response_record), len(historical))
        self.assertTrue({e["id"] for e in events if e.get("evidence_class") == "simulated"}.isdisjoint(
            {item["id"] for _, item in index.response_record}))

        until = datetime(2018, 11, 8, 16, 30, tzinfo=UTC)
        items = response_record_until(index, until)
        self.assertTrue(items)
        self.assertLessEqual(len(items), 100)
        self.assertTrue(all(i["at"] <= "2018-11-08T16:30:00Z" for i in items))
        self.assertEqual([i["at"] for i in items], sorted((i["at"] for i in items), reverse=True))
        future = [e for e in historical if e["at"] > "2018-11-08T16:30:00Z"]
        self.assertTrue(future)
        self.assertTrue({e["id"] for e in future}.isdisjoint({i["id"] for i in items}))
        self.assertEqual(set(items[0]), {"id", "at", "type", "label", "evidence_class", "source_id", "source_url",
                                         "time_precision", "zone_ids", "segment_ids"})


@override_settings(LIVE_CONTROLLER_TOKEN=CONTROLLER, LIVE_INVITE_CODE="DRILL")
class ResponseRecordCommandTest(SimpleTestCase):
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

    def command_at(self, replay_start):
        body = {"action": "start", "replay_start": replay_start, "speed": 0}
        r = self.client.post(f"{BASE}/drill", data=json.dumps(body), content_type="application/json",
                             HTTP_AUTHORIZATION=f"Bearer {CONTROLLER}")
        self.assertEqual(r.status_code, 200, r.content)
        r = self.client.get(f"{BASE}/command", HTTP_AUTHORIZATION=f"Bearer {CONTROLLER}")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_command_returns_only_past_historical_events(self):
        early = self.command_at("2018-11-08T14:30:00Z")["response_record"]
        late = self.command_at("2018-11-08T16:30:00Z")["response_record"]
        self.assertTrue(all(i["at"] <= "2018-11-08T14:30:00Z" for i in early))
        self.assertTrue(all(i["at"] <= "2018-11-08T16:30:00Z" for i in late))
        self.assertGreater(len(late), len(early))
        self.assertNotIn("simulated", {i["evidence_class"] for i in late})
