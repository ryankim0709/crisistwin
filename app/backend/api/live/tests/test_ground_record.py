"""Command ``ground_record``: the de-identified 2018 911/radio record, by zone, never after the drill clock."""

from __future__ import annotations

import json
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from django.test import SimpleTestCase, override_settings

from api.live import groundrecord
from api.live.drillcache import get_index
from livecore.geo import point_in_multipolygon


def _item(n: int, at: str, channel: str, category: str, coord) -> dict:
    return {"id": f"t-{n}", "at": at, "time_precision": "minute", "channel": channel, "category": category,
            "road_name": None, "coord": coord, "summary": f"{channel}: {category}", "evidence_class": "reported",
            "source_locator": "https://example.org/x.pdf#page=1; Table A-2", "text_sha12": "0" * 12}


class GroundRecordTest(SimpleTestCase):
    def setUp(self):
        groundrecord._record = None
        self.addCleanup(setattr, groundrecord, "_record", None)

    def _with(self, items):
        tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump({"items": items}, tmp)
        tmp.close()
        self.addCleanup(Path(tmp.name).unlink)
        return override_settings(LIVE_GROUND_RECORD=tmp.name)

    def test_missing_file_is_unavailable(self):
        with override_settings(LIVE_GROUND_RECORD="/nonexistent/ground.json"):
            out = groundrecord.ground_record_json(get_index(), datetime(2018, 11, 8, 16, tzinfo=UTC))
        self.assertFalse(out["available"])
        self.assertEqual(out["items"], [])

    def test_zone_placement_window_and_future(self):
        index = get_index()
        zone = next(iter(index.zones.values()))
        inside = None
        for polygon in zone.geometry:
            for lon, lat in polygon[0]:
                p = (round(lon, 3), round(lat, 3))
                if point_in_multipolygon(p, zone.geometry):
                    inside = list(p)
                    break
            if inside:
                break
        self.assertIsNotNone(inside)
        items = [
            _item(1, "2018-11-08T15:00:00Z", "911", "trapped", inside),  # before the window
            _item(2, "2018-11-08T15:50:00Z", "911", "help_needed", inside),
            _item(3, "2018-11-08T15:55:00Z", "radio", "fire_seen", inside),
            _item(4, "2018-11-08T16:30:00Z", "911", "trapped", inside),  # after the drill clock
            _item(5, "2018-11-08T15:58:00Z", "rescue", "other", None),
        ]
        with self._with(items):
            out = groundrecord.ground_record_json(index, datetime(2018, 11, 8, 16, tzinfo=UTC))
        self.assertTrue(out["available"])
        self.assertEqual([i["id"] for i in out["items"]], ["t-5", "t-3", "t-2", "t-1"])
        self.assertEqual(out["totals"]["911"], 2)
        self.assertEqual(out["window"], {"911": 1, "radio": 1, "rescue": 1, "notification": 0, "evacuation": 0})
        self.assertEqual(out["zones"], [{"zone_id": zone.id, "items": 2, "help": 1, "fire": 1}])
        for item in out["items"]:
            self.assertNotIn("coord", item)
            self.assertNotIn("text_sha12", item)


@override_settings(LIVE_CONTROLLER_TOKEN="dev-controller", LIVE_INVITE_CODE="DRILL")
class GroundRecordQueueTest(SimpleTestCase):
    """Record entries enter the review queue at their drill time and count only once confirmed."""

    BASE = "/api/live/incidents/camp-2018-drill"
    AUTH = {"HTTP_AUTHORIZATION": "Bearer dev-controller"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from api.live import schema
        from api.mongodb import get_database

        db = get_database()
        if not db.name.endswith("_test"):
            raise RuntimeError(f"Refusing to wipe database {db.name!r}; use a *_test database.")
        schema.apply(db, drop_drill_data=True)

    def setUp(self):
        from django.core.cache import cache

        from api.mongodb import get_database

        cache.clear()
        db = get_database()
        for name in [n for n in db.list_collection_names() if n.startswith("live_")]:
            db[name].delete_many({})
        groundrecord._record = None
        groundrecord._materialized.clear()
        self.addCleanup(setattr, groundrecord, "_record", None)
        self.addCleanup(groundrecord._materialized.clear)

    def _start(self, at):
        r = self.client.post(f"{self.BASE}/drill", data=json.dumps({"action": "start", "replay_start": at, "speed": 0}),
                             content_type="application/json", **self.AUTH)
        self.assertEqual(r.status_code, 200, r.content)

    def test_due_entries_queue_unverified_and_count_only_when_confirmed(self):
        index = get_index()
        segment_id, line = next((s, l) for s, l in index.segment_lines.items() if len(l) >= 2 and index.segment_names.get(s))
        on_road = [round(line[0][0], 5), round(line[0][1], 5)]
        items = [
            _item(1, "2018-11-08T15:10:00Z", "radio", "road_blocked", on_road),
            _item(2, "2018-11-08T15:20:00Z", "911", "trapped", on_road),
            _item(3, "2018-11-08T17:00:00Z", "911", "fire_seen", on_road),  # after the clock
            _item(4, "2018-11-08T15:15:00Z", "notification", "other", on_road),  # panel only
        ]
        tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump({"items": items}, tmp)
        tmp.close()
        self.addCleanup(Path(tmp.name).unlink)
        with override_settings(LIVE_GROUND_RECORD=tmp.name):
            self._start("2018-11-08T16:00:00Z")
            cmd = self.client.get(f"{self.BASE}/command", **self.AUTH).json()
            again = self.client.get(f"{self.BASE}/command", **self.AUTH).json()  # idempotent
            records = [r for r in cmd["reports"] if r["evidence_class"] == "historical_record"]
            self.assertEqual(sorted(r["kind"] for r in records), ["help_needed", "road_blocked"])
            self.assertEqual(len([r for r in again["reports"] if r["evidence_class"] == "historical_record"]), 2)
            self.assertTrue(all(r["status"] == "unverified" for r in records))
            self.assertEqual(cmd["public_items"], [])  # nothing counts before confirmation

            # Phones never list them.
            token = self.client.post("/api/live/incidents/camp-2018-drill/join", data=json.dumps({"invite_code": "DRILL"}),
                                     content_type="application/json").json()["token"]
            listed = self.client.get(f"{self.BASE}/reports", HTTP_AUTHORIZATION=f"Bearer {token}").json()["reports"]
            self.assertFalse([r for r in listed if r["evidence_class"] == "historical_record"])

            block = next(r for r in records if r["kind"] == "road_blocked")
            r = self.client.post(f"/api/live/reports/{block['id']}/triage", data=json.dumps({"action": "confirm"}),
                                 content_type="application/json", **self.AUTH)
            self.assertEqual(r.status_code, 200, r.content)
            cmd = self.client.get(f"{self.BASE}/command", **self.AUTH).json()
            self.assertTrue(any(i["kind"] == "road_blocked" and i["controller_confirmed"] for i in cmd["public_items"]))

            # A reset clears them; the clock passing again brings them back.
            r = self.client.post(f"{self.BASE}/drill", data=json.dumps({"action": "reset"}),
                                 content_type="application/json", **self.AUTH)
            self.assertEqual(r.status_code, 200, r.content)
            from api.live.common import col

            self.assertEqual(col("live_reports").count_documents({"evidence_class": "historical_record"}), 0)
