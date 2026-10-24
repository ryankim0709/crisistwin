import json
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase
from django.urls import reverse
from pymongo.errors import ConnectionFailure

from api import dispatch_runs
from api.dispatch import SYSTEM_PROMPT, build_user_message, validate_request

SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e"
OBS = {
    "area": {"id": "osm-37.86,-122.25", "name": "Berkeley Hills"},
    "clock": {"minute": 42, "horizon_minutes": 180},
    "monitor": {"woke_because": ["Planner closed Grizzly Peak Blvd at T+40; routes avoid it from now on."]},
    "fire": {"wind_from_degrees": 45, "wind_speed_mph": 20},
    "fires": [{"id": "F1", "name": "Tilden"}],
    "roads": {"planner_closed": [{"road": "Grizzly Peak Blvd", "bridge": False, "since_minute": 40}]},
    "totals": {"homes": 100, "not_ordered": 50, "waiting": 20, "en_route": 10, "out": 20, "exposed": 0},
    "zones": [],
    "exits": [],
    "units": [],
}
ORDERS = [{"type": "order_evacuation", "zone_id": "Z1", "exit_id": "E2", "reason": "detour"}]
OUTCOME = {
    "area_id": OBS["area"]["id"],
    "minute": 180,
    "horizon_minutes": 180,
    "finished": True,
    "totals": {"homes": 100, "not_ordered": 40, "waiting": 0, "en_route": 0, "out": 58, "exposed": 2},
    "no_action_exposed": 31,
}


class RunJournalTests(SimpleTestCase):
    def setUp(self):
        dispatch_runs._recalled.clear()
        dispatch_runs._indexed = True

    @patch("api.dispatch_runs.get_database")
    def test_decision_is_appended_to_the_session_journal(self, get_database):
        dispatch_runs.record_decision(SESSION, OBS, ORDERS, 1, "Redirected Z1 around the closure.", "m")
        collection = get_database.return_value[dispatch_runs.COLLECTION]
        query, update = collection.update_one.call_args.args
        self.assertEqual(query, {"_id": SESSION, "area_id": OBS["area"]["id"]})
        self.assertTrue(collection.update_one.call_args.kwargs["upsert"])
        decision = update["$push"]["decisions"]["$each"][0]
        self.assertEqual(decision["orders"], ["evacuate Z1 via E2"])
        self.assertEqual(decision["planner_closed"], ["Grizzly Peak Blvd"])
        self.assertEqual(decision["rejected"], 1)
        self.assertEqual(update["$setOnInsert"]["scenario"]["fires"], ["Tilden"])
        self.assertEqual(update["$setOnInsert"]["evidence_class"], "simulated")

    @patch("api.dispatch_runs.get_database")
    def test_journal_failure_never_raises(self, get_database):
        get_database.return_value[dispatch_runs.COLLECTION].update_one.side_effect = ConnectionFailure("x")
        dispatch_runs.record_decision(SESSION, OBS, ORDERS, 0, "s", "m")

    @patch("api.dispatch_runs.get_database")
    def test_recall_reads_finished_runs_on_the_same_area_once_per_session(self, get_database):
        doc = {
            "_id": "other",
            "started_at": datetime(2026, 10, 24, 9, 0, tzinfo=UTC),
            "scenario": {"fires": ["Tilden"]},
            "decisions": [
                {"orders": ["evacuate Z1 via E1"], "planner_closed": [], "summary": "First wave."},
                {"orders": ["evacuate Z2 via E1"], "planner_closed": ["Grizzly Peak Blvd"], "summary": "E1 jams."},
            ],
            "outcome": OUTCOME,
        }
        find = get_database.return_value[dispatch_runs.COLLECTION].find
        find.return_value.sort.return_value.limit.return_value = [doc]
        runs = dispatch_runs.recall(SESSION, OBS)
        self.assertEqual(find.call_args.args[0]["area_id"], OBS["area"]["id"])
        self.assertEqual(find.call_args.args[0]["_id"], {"$ne": SESSION})
        self.assertEqual(runs[0]["first_orders"], ["evacuate Z1 via E1", "evacuate Z2 via E1"])
        self.assertEqual(runs[0]["planner_closed_roads"], ["Grizzly Peak Blvd"])
        self.assertEqual(runs[0]["last_summaries"], ["First wave.", "E1 jams."])
        self.assertEqual(runs[0]["evidence_class"], "simulated")
        dispatch_runs.recall(SESSION, OBS)
        self.assertEqual(find.call_count, 1)

    @patch("api.dispatch_runs.get_database")
    def test_recall_without_database_is_empty_and_not_retried(self, get_database):
        find = get_database.return_value[dispatch_runs.COLLECTION].find
        find.side_effect = ConnectionFailure("x")
        self.assertEqual(dispatch_runs.recall(SESSION, OBS), [])
        self.assertEqual(dispatch_runs.recall(SESSION, OBS), [])
        self.assertEqual(find.call_count, 1)


class RunOutcomeEndpointTests(SimpleTestCase):
    def setUp(self):
        dispatch_runs._indexed = True

    def post(self, body, session=SESSION):
        return self.client.post(
            reverse("dispatch-run-outcome", kwargs={"session_id": session}),
            data=json.dumps(body),
            content_type="application/json",
        )

    @patch("api.dispatch_runs.get_database")
    def test_outcome_is_stored_on_an_existing_journal(self, get_database):
        collection = get_database.return_value[dispatch_runs.COLLECTION]
        collection.update_one.return_value = MagicMock(matched_count=1)
        self.assertEqual(self.post(OUTCOME).status_code, 204)
        query, update = collection.update_one.call_args.args
        self.assertEqual(query, {"_id": SESSION, "area_id": OUTCOME["area_id"]})
        self.assertEqual(update["$set"]["outcome"]["totals"]["exposed"], 2)
        self.assertNotIn("upsert", collection.update_one.call_args.kwargs)

    @patch("api.dispatch_runs.get_database")
    def test_outcome_without_journal_is_not_found(self, get_database):
        get_database.return_value[dispatch_runs.COLLECTION].update_one.return_value = MagicMock(matched_count=0)
        self.assertEqual(self.post(OUTCOME).status_code, 404)

    def test_outcome_validation(self):
        self.assertEqual(self.post({**OUTCOME, "minute": -1}).status_code, 400)
        self.assertEqual(self.post({**OUTCOME, "totals": {"homes": 1}}).status_code, 400)
        self.assertEqual(self.post({**OUTCOME, "finished": "yes"}).status_code, 400)
        self.assertEqual(self.post(OUTCOME, session="-" * 36).status_code, 400)

    @patch("api.dispatch_runs.get_database")
    def test_database_failure_is_unavailable(self, get_database):
        get_database.return_value[dispatch_runs.COLLECTION].update_one.side_effect = ConnectionFailure("secret")
        response = self.post(OUTCOME)
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("secret", response.content.decode())


class DecideRequestMemoryTests(SimpleTestCase):
    def test_session_id_is_optional_and_checked(self):
        self.assertIsInstance(validate_request({"observation": OBS}), dict)
        self.assertIsInstance(validate_request({"observation": OBS, "session_id": SESSION}), dict)
        self.assertIsInstance(validate_request({"observation": OBS, "session_id": "x"}), str)
        self.assertIsInstance(validate_request({"observation": OBS, "other": 1}), str)

    def test_past_runs_precede_the_observation_as_data(self):
        message = build_user_message(OBS, [{"outcome": OUTCOME, "evidence_class": "simulated"}])
        self.assertLess(message.index("<past_runs>"), message.index("<observation>"))
        self.assertNotIn("<past_runs>", build_user_message(OBS, []))

    def test_prompt_covers_closures_and_memory(self):
        self.assertIn("planner can close or reopen a road", SYSTEM_PROMPT)
        self.assertIn("never as facts about this run", SYSTEM_PROMPT)
