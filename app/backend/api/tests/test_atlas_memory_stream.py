import math
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase
from django.urls import reverse
from pymongo.errors import ConnectionFailure, OperationFailure

from api import dispatch_situations, live_stream, situation
from api.dispatch import SYSTEM_PROMPT, build_user_message

SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e"


def observation(slack=5, ordered=False, burning=1, closures=0, wind_from=45):
    zone = {
        "id": "Z1",
        "status": "ordered" if ordered else "no_order",
        "impact": "threatened",
        "order_slack_min": slack,
        "staged_after": None,
        "route_blocked": False,
    }
    return {
        "area": {"id": "a1", "name": "Hills"},
        "clock": {"minute": 30, "horizon_minutes": 180},
        "fire": {
            "burned_area_ha": 120,
            "wind_from_degrees": wind_from,
            "wind_speed_mph": 20,
            "fire_path": {"zones": 2, "homes": 400},
        },
        "totals": {"homes": 1000, "not_ordered": 900, "waiting": 100, "en_route": 0, "out": 0, "exposed": 0},
        "zones": [zone, {"id": "Z2", "status": "no_order", "impact": "outside", "order_slack_min": None}],
        "fires": [{"id": "F1", "status": "burning", "crowning": False}] * burning,
        "units": [{"id": "E1", "status": "available"}, {"id": "E2", "status": "en_route"}],
        "roads": {"planner_closed": [{"road": "R"}] * closures, "fire_cut_segments": 3},
    }


def cosine(a, b):
    return sum(x * y for x, y in zip(a, b, strict=True)) / (
        math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    )


class SituationVectorTests(SimpleTestCase):
    def test_vector_has_fixed_dimensions_in_range(self):
        vec = situation.vector(situation.features(observation()))
        self.assertEqual(len(vec), situation.DIMENSIONS)
        self.assertTrue(all(-1 <= v <= 1 for v in vec))

    def test_features_come_from_simulator_figures(self):
        named = situation.features(observation())
        self.assertAlmostEqual(named["fire_path_share"], 0.4)
        # 900 not ordered minus 600 outside the fire path, of 400 in it.
        self.assertAlmostEqual(named["not_ordered_share"], 0.75)
        self.assertAlmostEqual(named["unordered_threatened_share"], 1.0)
        self.assertAlmostEqual(named["urgent_zone_share"], 1.0)
        self.assertAlmostEqual(named["units_available_share"], 0.5)

    def test_similar_situations_are_closer_than_different_ones(self):
        base = situation.vector(situation.features(observation()))
        near = situation.vector(situation.features(observation(slack=8)))
        far = situation.vector(
            situation.features(observation(slack=60, ordered=True, burning=3, closures=6, wind_from=225))
        )
        self.assertGreater(cosine(base, near), cosine(base, far))

    def test_missing_fields_do_not_raise(self):
        self.assertEqual(len(situation.vector(situation.features({}))), situation.DIMENSIONS)
        self.assertIsNone(situation.summary({})["tightest_unordered_slack_min"])


class SituationSearchTests(SimpleTestCase):
    def setUp(self):
        dispatch_situations._index_ready = True
        dispatch_situations._disabled_until = 0.0

    def test_pipeline_filters_other_finished_runs_and_keeps_best_per_run(self):
        stages = dispatch_situations.pipeline([0.0] * situation.DIMENSIONS, SESSION)
        search = stages[0]["$vectorSearch"]
        self.assertEqual(search["index"], dispatch_situations.INDEX_NAME)
        self.assertEqual(search["filter"]["session_id"], {"$ne": SESSION})
        self.assertTrue(search["filter"]["has_outcome"])
        self.assertIn({"$group": {"_id": "$session_id", "best": {"$first": "$$ROOT"}}}, stages)

    @patch("api.dispatch_situations.get_database")
    def test_similar_returns_labelled_lessons(self, get_database):
        get_database.return_value[dispatch_situations.COLLECTION].aggregate.return_value = [
            {
                "score": 0.97,
                "area_id": "a1",
                "area_name": "Hills",
                "situation": {"minute": 25},
                "orders": ["evacuate Z9 via X2"],
                "summary": "Ordered Z9 early.",
                "outcome": {"totals": {"exposed": 3}, "no_action_exposed": 50},
            }
        ]
        found = dispatch_situations.similar(SESSION, observation())
        self.assertEqual(found[0]["similarity"], 0.97)
        self.assertTrue(found[0]["same_road_network"])
        self.assertEqual(found[0]["evidence_class"], "simulated")

    @patch("api.dispatch_situations.get_database")
    def test_search_failure_backs_off(self, get_database):
        aggregate = get_database.return_value[dispatch_situations.COLLECTION].aggregate
        aggregate.side_effect = OperationFailure("index not found")
        self.assertEqual(dispatch_situations.similar(SESSION, observation()), [])
        self.assertEqual(dispatch_situations.similar(SESSION, observation()), [])
        self.assertEqual(aggregate.call_count, 1)

    @patch("api.dispatch_situations.get_database")
    def test_record_stores_vector_and_never_raises(self, get_database):
        collection = get_database.return_value[dispatch_situations.COLLECTION]
        dispatch_situations.record(SESSION, "a1", "Hills", observation(), ["evacuate Z1 via X1"], "s")
        doc = collection.insert_one.call_args.args[0]
        self.assertEqual(len(doc["vector"]), situation.DIMENSIONS)
        self.assertFalse(doc["has_outcome"])
        collection.insert_one.side_effect = ConnectionFailure("x")
        dispatch_situations.record(SESSION, "a1", "Hills", observation(), [], "s")

    def test_similar_situations_are_data_before_the_observation(self):
        message = build_user_message(observation(), [], [{"similarity": 0.95}])
        self.assertLess(message.index("<similar_situations>"), message.index("<observation>"))
        self.assertIn("must never appear in your orders", SYSTEM_PROMPT)


class FakeChanges:
    """A change stream that dies once its events run out (a real one would keep waiting)."""

    def __init__(self, events):
        self.events = list(events)
        self.closed = False

    @property
    def alive(self):
        return not self.closed and bool(self.events)

    def try_next(self):
        if not self.events:
            return None
        event = self.events.pop(0)
        if isinstance(event, Exception):
            raise event
        return event

    def close(self):
        self.closed = True


def stored(minute):
    return {"_id": "current", "snapshot": {"minute": minute}, "received_at": datetime(2026, 10, 24, tzinfo=UTC)}


class LiveStreamTests(SimpleTestCase):
    def take(self, stream, n):
        return [next(stream) for _ in range(n)]

    def test_sends_current_then_each_change_with_resume_id(self):
        live_stream._slots.acquire()
        changes = FakeChanges([{"_id": {"_data": "ABCD"}, "operationType": "replace", "fullDocument": stored(5)}])
        stream = live_stream.BroadcastStream(changes, stored(4), clock=lambda: 0.0)
        retry, first, second = self.take(stream, 3)
        self.assertEqual(retry, f"retry: {live_stream.RETRY_MS}\n\n")
        self.assertIn('"minute":4', first)
        self.assertTrue(second.startswith("id: ABCD\nevent: snapshot\n"))
        self.assertIn('"received_at":"2026-10-24T00:00:00.000+00:00"', second)
        stream.close()
        self.assertTrue(changes.closed)

    def test_heartbeat_delete_and_database_error(self):
        live_stream._slots.acquire()
        times = iter([0.0, 0.0, live_stream.HEARTBEAT_SECONDS + 1, live_stream.HEARTBEAT_SECONDS + 2])
        changes = FakeChanges(
            [None, None, {"_id": {"_data": "EF01"}, "operationType": "delete"}, ConnectionFailure("x")]
        )
        stream = live_stream.BroadcastStream(changes, None, clock=lambda: next(times))
        events = list(stream)
        self.assertEqual(events[1], ": keep-alive\n\n")
        self.assertTrue(events[2].startswith("id: EF01\nevent: cleared"))
        self.assertTrue(events[3].startswith("event: error"))
        stream.close()

    @patch("api.live_stream.get_database")
    def test_endpoint_streams_event_stream(self, get_database):
        collection = get_database.return_value[live_stream.COLLECTION]
        collection.watch.return_value = FakeChanges([])
        collection.find_one.return_value = stored(7)
        response = self.client.get(reverse("live-stream"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "text/event-stream")
        body = b"".join(response.streaming_content).decode()
        self.assertIn('"minute":7', body)
        response.close()

    @patch("api.live_stream.get_database")
    def test_resume_skips_the_current_snapshot(self, get_database):
        collection = get_database.return_value[live_stream.COLLECTION]
        collection.watch.return_value = FakeChanges([])
        response = self.client.get(reverse("live-stream"), headers={"Last-Event-ID": "82ABCDEF0123456789"})
        self.assertEqual(collection.watch.call_args.kwargs["resume_after"], {"_data": "82ABCDEF0123456789"})
        collection.find_one.assert_not_called()
        response.close()

    @patch("api.live_stream.get_database")
    def test_no_change_streams_is_unavailable(self, get_database):
        get_database.return_value[live_stream.COLLECTION].watch.side_effect = OperationFailure(
            "The $changeStream stage is only supported on replica sets"
        )
        response = self.client.get(reverse("live-stream"))
        self.assertEqual(response.status_code, 503)
        # The slot was given back.
        self.assertTrue(live_stream._slots.acquire(blocking=False))
        live_stream._slots.release()

    def test_post_is_rejected(self):
        self.assertEqual(self.client.post(reverse("live-stream")).status_code, 405)


class OutcomeMarksSituationsTests(SimpleTestCase):
    @patch("api.dispatch_runs.dispatch_situations.mark_outcome")
    @patch("api.dispatch_runs.get_database")
    def test_outcome_makes_situations_searchable(self, get_database, mark_outcome):
        import json

        from api import dispatch_runs

        dispatch_runs._indexed = True
        get_database.return_value[dispatch_runs.COLLECTION].update_one.return_value = MagicMock(matched_count=1)
        body = {
            "area_id": "a1",
            "minute": 180,
            "horizon_minutes": 180,
            "finished": True,
            "totals": dict.fromkeys(dispatch_runs.TOTAL_KEYS, 0),
            "no_action_exposed": 4,
        }
        response = self.client.post(
            reverse("dispatch-run-outcome", kwargs={"session_id": SESSION}),
            data=json.dumps(body),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 204)
        self.assertEqual(mark_outcome.call_args.args[0], SESSION)
