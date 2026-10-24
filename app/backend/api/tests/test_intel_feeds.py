"""Open live feeds (docs/adr/0032-open-live-feeds.md). Recorded fixtures only; no network.

Fixtures under tests/fixtures/ are trimmed or synthetic: the NWS file is hand-written in the
API's shape, the Caltrans file is a trimmed D03 export with positions moved into Butte County,
the WFIGS files are trimmed public records. Needs MongoDB (MONGODB_URI) like the other intel code.
"""

import json
import urllib.error
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from django.core.cache import cache
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import SimpleTestCase
from rest_framework.test import APIClient

from api import intel_feeds as feeds
from api.intel_feeds_api import CANDIDATES, FEED_RAW, FEED_STATE
from api.mongodb import get_database

FIXTURES = Path(__file__).parent / "fixtures"
NOW = "2026-10-24T14:33:20Z"  # inside the Caltrans fixture's "active" closure
BUTTE = [-122.1, 39.3, -121.0, 40.2]


def fixture_bytes(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def route(mapping: dict[str, bytes]):
    """A stand-in for `intel_feeds.fetch`: picks a recorded body by URL substring."""

    def fake(url: str, accept: str = "application/json"):
        for needle, body in mapping.items():
            if needle in url:
                return body, 200
        raise AssertionError(f"unexpected fetch {url}")

    return fake


class FeedTestCase(SimpleTestCase):
    databases = set()

    def setUp(self):
        cache.clear()
        db = get_database()
        for name in (CANDIDATES, FEED_STATE, FEED_RAW):
            db[name].delete_many({})
        self.client = APIClient()
        guard = patch("urllib.request.urlopen", side_effect=AssertionError("network call in test"))
        guard.start()
        self.addCleanup(guard.stop)
        clock = patch("api.intel_feeds_api._now", return_value=NOW)
        clock.start()
        self.addCleanup(clock.stop)

    def poll(self, feed: str, body: dict | None = None):
        return self.client.post(f"/api/intel/feeds/{feed}/poll", body or {}, format="json")

    def stored(self, feed: str) -> list[dict]:
        return list(get_database()[CANDIDATES].find({"feed": feed}).sort("event_id", 1))


class ParserTests(SimpleTestCase):
    raw = {"_id": "raw-0123456789abcdef", "sha256": "0" * 64}

    def test_nws_keeps_red_flag_and_fire_weather_watch(self):
        body = json.loads(fixture_bytes("nws_alerts.json"))
        found, stats = feeds.parse_nws(body, incident="x", raw=self.raw, url="https://u", fetched_at=NOW)
        self.assertEqual(stats, {"received": 3, "skipped": 1})
        self.assertEqual({c["details"]["event"] for c in found}, {"Red Flag Warning", "Fire Weather Watch"})
        red = next(c for c in found if c["details"]["event"] == "Red Flag Warning")
        self.assertEqual(red["type"], "weather_alert")
        self.assertEqual(red["geometry"]["type"], "Polygon")
        self.assertEqual(red["geocode_method"], "source_provided")
        self.assertEqual(red["occurred_at"], "2026-10-24T18:00:00Z")
        self.assertEqual(red["occurred_to"], "2026-10-25T12:00:00Z")
        watch = next(c for c in found if c["details"]["event"] == "Fire Weather Watch")
        self.assertIsNone(watch["geometry"])
        self.assertEqual(watch["geocode_method"], "unresolved")

    def test_every_candidate_is_reported_and_unconfirmed(self):
        body = json.loads(fixture_bytes("nws_alerts.json"))
        found, _ = feeds.parse_nws(body, incident="x", raw=self.raw, url="https://u", fetched_at=NOW)
        for candidate in found:
            self.assertEqual(candidate["evidence_class"], "reported")
            self.assertEqual(candidate["review_status"], "unconfirmed")
            self.assertEqual(candidate["fetched_at"], NOW)
            self.assertEqual(candidate["source_url"], "https://u")
            self.assertRegex(candidate["event_id"], r"^intel-[0-9a-f]{16}$")

    def test_caltrans_full_closures_in_effect_only(self):
        body = json.loads(fixture_bytes("caltrans_lcs_d03.json"))
        found, stats = feeds.parse_caltrans(
            body, incident="x", raw=self.raw, url="https://u", fetched_at=NOW, bbox=BUTTE
        )
        self.assertEqual(len(found), 2)
        self.assertEqual(
            {k: stats[k] for k in ("not_full", "planned", "ended", "outside_bbox")},
            {"not_full": 1, "planned": 1, "ended": 2, "outside_bbox": 1},
        )
        self.assertTrue(all(c["type"] == "road_closure" and c["geometry"] for c in found))
        indefinite = next(c for c in found if c["details"]["closure_end_indefinite"])
        self.assertIsNone(indefinite["occurred_to"])
        self.assertEqual(indefinite["target"]["osm_way_ids_status"], "unresolved")

    def test_caltrans_without_bbox_includes_outside_closure(self):
        body = json.loads(fixture_bytes("caltrans_lcs_d03.json"))
        found, _ = feeds.parse_caltrans(
            body, incident="x", raw=self.raw, url="https://u", fetched_at=NOW, bbox=None
        )
        self.assertEqual(len(found), 3)

    def test_wfigs_acres_containment_perimeter_and_rx_skipped(self):
        found, stats = feeds.parse_wfigs(
            json.loads(fixture_bytes("wfigs_incidents.json")),
            json.loads(fixture_bytes("wfigs_perimeters.json")),
            incident="x",
            raw=self.raw,
            url="https://u",
            fetched_at=NOW,
            bbox=[-125, 32, -114, 42.1],
        )
        self.assertEqual(stats["not_wildfire"], 1)
        self.assertEqual(len(found), 2)
        withp = next(c for c in found if c["details"]["perimeter"])
        self.assertEqual(withp["type"], "fire_incident")
        self.assertEqual(withp["details"]["perimeter"]["type"], "Polygon")
        self.assertIsNotNone(withp["details"]["acres"])
        self.assertIn("acres", withp["description"])
        self.assertEqual(withp["geometry"]["type"], "Point")

    def test_invalid_shapes_are_feed_errors(self):
        with self.assertRaises(feeds.FeedError):
            feeds.parse_nws({"nope": 1}, incident="x", raw=self.raw, url="u", fetched_at=NOW)
        with self.assertRaises(feeds.FeedError):
            feeds.parse_caltrans([], incident="x", raw=self.raw, url="u", fetched_at=NOW, bbox=None)

    def test_user_agent_names_app_and_contact(self):
        with self.settings(INTEL_FEEDS_CONTACT="ops@example.org"):
            self.assertIn("CrisisTwin", feeds.user_agent())
            self.assertIn("ops@example.org", feeds.user_agent())

    def test_fetch_maps_network_failures(self):
        with patch("urllib.request.urlopen", side_effect=urllib.error.URLError("down")):
            with self.assertRaises(feeds.FeedError) as caught:
                feeds.fetch("https://example.invalid/")
        self.assertEqual((caught.exception.code, caught.exception.status), ("feed_unreachable", 503))
        with patch("urllib.request.urlopen", side_effect=TimeoutError()):
            with self.assertRaises(feeds.FeedError) as caught:
                feeds.fetch("https://example.invalid/")
        self.assertEqual(caught.exception.status, 504)


class PollTests(FeedTestCase):
    def test_nws_poll_stores_candidates_and_is_idempotent(self):
        fake = route({"api.weather.gov": fixture_bytes("nws_alerts.json")})
        with patch("api.intel_feeds.fetch", fake):
            first = self.poll("nws", {"bbox": BUTTE, "incident": "butte-live"})
            self.assertEqual(first.status_code, 200)
            self.assertEqual((first.json()["created"], first.json()["updated"]), (2, 0))
            self.assertIn("point=39.75", first.json()["raw"][0]["url"])
            get_database()[FEED_STATE].update_one({"_id": "nws"}, {"$set": {"last_success_at": "2020-01-01T00:00:00Z"}})
            second = self.poll("nws", {"bbox": BUTTE, "incident": "butte-live"})
        self.assertEqual((second.json()["created"], second.json()["updated"]), (0, 2))
        rows = self.stored("nws")
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(r["seen_count"] == 2 and r["review_status"] == "unconfirmed" for r in rows))
        raw = get_database()[FEED_RAW].find_one({})
        self.assertEqual(raw["size"], len(fixture_bytes("nws_alerts.json")))
        self.assertEqual(len(raw["sha256"]), 64)
        self.assertEqual(raw["seen_count"], 2)

    def test_reviewed_candidates_are_not_overwritten(self):
        fake = route({"api.weather.gov": fixture_bytes("nws_alerts.json")})
        with patch("api.intel_feeds.fetch", fake):
            self.poll("nws", {"bbox": BUTTE})
            row = self.stored("nws")[0]
            review = self.client.post(
                f"/api/intel/candidates/{row['event_id']}/review",
                {"review_status": "confirmed", "reviewer": "pat", "reviewer_note": None, "mapping": None},
                format="json",
            )
            self.assertEqual(review.status_code, 200)
            # Review without a mapping keeps the source geometry.
            self.assertEqual(review.json()["geometry"], row["geometry"])
            get_database()[CANDIDATES].update_one({"_id": row["event_id"]}, {"$set": {"description": "edited"}})
            get_database()[FEED_STATE].update_one({"_id": "nws"}, {"$set": {"last_success_at": "2020-01-01T00:00:00Z"}})
            again = self.poll("nws", {"bbox": BUTTE})
        self.assertEqual((again.json()["updated"], again.json()["unchanged"]), (1, 1))
        after = get_database()[CANDIDATES].find_one({"_id": row["event_id"]})
        self.assertEqual((after["review_status"], after["description"]), ("confirmed", "edited"))

    def test_caltrans_poll(self):
        fake = route({"lcsStatusD03": fixture_bytes("caltrans_lcs_d03.json")})
        with patch("api.intel_feeds.fetch", fake):
            response = self.poll("caltrans", {"bbox": BUTTE, "districts": [3]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["created"], 2)
        self.assertEqual({r["type"] for r in self.stored("caltrans")}, {"road_closure"})

    def test_wfigs_poll_needs_bbox_and_stores_perimeter(self):
        self.assertEqual(self.poll("wfigs").status_code, 400)
        fake = route(
            {
                "Perimeters_Current": fixture_bytes("wfigs_perimeters.json"),
                "Incident_Locations_Current": fixture_bytes("wfigs_incidents.json"),
            }
        )
        with patch("api.intel_feeds.fetch", fake):
            response = self.poll("wfigs", {"bbox": [-125, 32, -114, 42.1]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["raw"]), 2)
        self.assertTrue(any(r["details"]["perimeter"] for r in self.stored("wfigs")))

    def test_network_failure_is_503_with_detail_and_recorded(self):
        with patch("urllib.request.urlopen", side_effect=urllib.error.URLError("boom")):
            response = self.poll("nws", {"bbox": BUTTE})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["error"], "feed_unreachable")
        self.assertTrue(response.json()["detail"])
        listing = self.client.get("/api/intel/feeds").json()["feeds"]
        nws = next(f for f in listing if f["feed"] == "nws")
        self.assertEqual((nws["status"], nws["error"]["code"]), ("error", "feed_unreachable"))

    def test_bad_json_is_502(self):
        with patch("api.intel_feeds.fetch", route({"api.weather.gov": b"<html>"})):
            self.assertEqual(self.poll("nws", {"bbox": BUTTE}).status_code, 502)

    def test_validation_and_unknown_feed(self):
        self.assertEqual(self.poll("nope").status_code, 404)
        self.assertEqual(self.poll("nws", {"bbox": [1, 2, 3]}).status_code, 400)
        self.assertEqual(self.poll("nws", {"incident": "Bad Slug"}).status_code, 400)
        self.assertEqual(self.poll("caltrans", {"districts": [99]}).status_code, 400)
        self.assertEqual(self.poll("nws", {"surprise": 1}).status_code, 400)

    def test_minimum_interval_floor(self):
        from api.intel import _now as real_now

        get_database()[FEED_STATE].insert_one({"_id": "nws", "last_success_at": real_now()})
        response = self.poll("nws", {"bbox": BUTTE})
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.json()["error"], "polled_recently")

    def test_feeds_status_and_candidate_types_filter(self):
        fake = route({"api.weather.gov": fixture_bytes("nws_alerts.json")})
        with patch("api.intel_feeds.fetch", fake):
            self.poll("nws", {"bbox": BUTTE, "incident": "butte-live"})
        listing = self.client.get("/api/intel/feeds").json()["feeds"]
        by = {f["feed"]: f for f in listing}
        self.assertEqual(by["nws"]["status"], "ok")
        self.assertEqual(by["nws"]["counts"]["unconfirmed"], 2)
        self.assertEqual(by["caltrans"]["status"], "never")
        found = self.client.get("/api/intel/candidates?incident=butte-live&types=weather_alert").json()
        self.assertEqual(found["count"], 2)
        self.assertEqual(self.client.get("/api/intel/candidates?incident=butte-live&types=bogus").status_code, 400)


class CommandTests(FeedTestCase):
    def test_command_polls_requested_feeds(self):
        out = StringIO()
        fake = route({"api.weather.gov": fixture_bytes("nws_alerts.json")})
        with patch("api.intel_feeds.fetch", fake):
            call_command("intel_poll_feeds", "--feed", "nws", "--bbox", "-122.1", "39.3", "-121.0", "40.2", stdout=out)
        self.assertIn("nws: ok, 2 candidates", out.getvalue())
        self.assertEqual(len(self.stored("nws")), 2)

    def test_command_reports_failures(self):
        with patch("urllib.request.urlopen", side_effect=urllib.error.URLError("down")):
            with self.assertRaises(CommandError):
                call_command("intel_poll_feeds", "--feed", "nws", stdout=StringIO(), stderr=StringIO())
