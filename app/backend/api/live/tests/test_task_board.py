"""ADR 0041 over the API: board questions from priority, board privacy, answers, expiry, passive
reports and their validation, rate limits. Same harness as test_live_api (MongoDB *_test database,
frozen drill clock at 16:30Z)."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta
from unittest import mock

from api.live import board
from api.live.common import col
from api.live.drillcache import get_index
from api.live.state import load_snapshot
from api.live.tests import test_live_api as base
from api.live.tests.test_live_api import BASE, CONTROLLER, INCIDENT, iso

BOARD_ITEM_KEYS = {"task_id", "rank", "question", "place", "expires_at"}
BOARD_PLACE_KEYS = {"kind", "segment_id", "destination_id", "name", "coord", "line", "free_flow_kph"}


class TaskBoardTest(base.LiveApiTest):
    def refresh(self, now: datetime | None = None):
        return board.refresh(load_snapshot(INCIDENT, now or datetime.now(UTC)))

    def board_items(self, token):
        r = self.call("GET", f"{BASE}/board", token=token)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def with_board(self):
        self.publish_initial_guidance()
        items = self.refresh()
        open_tasks = list(col("live_tasks").find({"created_by": "priority", "status": "open"}))
        self.assertTrue(open_tasks, "published routes must yield board questions")
        return items, open_tasks

    def passive(self, token, segment_id, kind="road_passable", speed_class="free", **extra):
        body = {"client_id": str(uuid.uuid4()), "kind": kind, "method": "passive", "segment_id": segment_id,
                "speed_class": speed_class, "observed_at": iso(datetime.now(UTC) - timedelta(minutes=1))}
        body.update(extra)
        return self.call("POST", f"{BASE}/reports", body, token)

    # -- priority and auto-created questions

    def test_refresh_creates_rate_limited_deduplicated_questions(self):
        items, open_tasks = self.with_board()
        self.assertLessEqual(len(open_tasks), board.BOARD_CREATE_PER_REFRESH)
        self.assertEqual(items, sorted(items, key=lambda i: (-i.priority, i.id)))
        kinds = {i.kind for i in items}
        self.assertIn("segment", kinds)
        for t in open_tasks:
            self.assertEqual((t["kind"], t["assignee"], t["created_by"]), ("verify", None, "priority"))
            self.assertIn(t["question"], ("road_status", "shelter_full"))
            self.assertEqual(t["expires_at"].replace(tzinfo=UTC) - t["created_at"].replace(tzinfo=UTC),
                             timedelta(seconds=board.PASSIVE_TTL_S))
            p = t["priority"]
            self.assertAlmostEqual(p["priority"], p["impact"] * p["p_change"] * p["staleness"], places=2)
        places = [t["place_id"] for t in open_tasks]
        self.assertEqual(len(places), len(set(places)))
        # Repeated refreshes add at most BOARD_CREATE_PER_REFRESH each, never a duplicate place,
        # and stop at BOARD_MAX_OPEN.
        for _ in range(5):
            self.refresh()
        open_tasks = list(col("live_tasks").find({"created_by": "priority", "status": "open"}))
        self.assertLessEqual(len(open_tasks), board.BOARD_MAX_OPEN)
        places = [t["place_id"] for t in open_tasks]
        self.assertEqual(len(places), len(set(places)))

    def test_refresh_is_claimed_once_per_interval(self):
        self.publish_initial_guidance()
        snap = load_snapshot(INCIDENT, datetime.now(UTC))
        with mock.patch.object(board, "refresh") as refresh:
            self.assertTrue(board.maybe_refresh(snap))
            self.assertFalse(board.maybe_refresh(snap))
            later = load_snapshot(INCIDENT, datetime.now(UTC) + timedelta(seconds=board.BOARD_REFRESH_S + 1))
            self.assertTrue(board.maybe_refresh(later))
        self.assertEqual(refresh.call_count, 2)

    def test_command_lists_stale_critical_and_task_answers(self):
        self.with_board()
        cmd = self.call("GET", f"{BASE}/command", token=CONTROLLER).json()
        self.assertTrue(cmd["stale_critical"])
        self.assertIsNotNone(cmd["board_computed_at"])
        first = cmd["stale_critical"][0]
        for key in ("priority", "impact", "p_change", "staleness", "kind", "coord", "reason", "half_life_s"):
            self.assertIn(key, first)
        board_tasks = [t for t in cmd["tasks"] if t.get("created_by") == "priority"]
        self.assertTrue(board_tasks)
        self.assertEqual(board_tasks[0]["answers"]["total"], 0)
        self.assertNotIn("place_id", board_tasks[0])

    # -- the public board

    def test_board_is_questions_only(self):
        _, open_tasks = self.with_board()
        civ = self.civilian()
        # People data that must never reach the board: a help request with a location, a help
        # report, a responder with a location and an assist task.
        zone = next(iter(get_index().zones))
        self.call("POST", f"{BASE}/checkins", {"status": "need_help", "zone_id": zone, "coord": [-121.6, 39.76]}, civ)
        self.report(civ, (-121.6, 39.76), kind="help_needed", severity=None)
        rsp = self.responder()
        self.call("POST", "/api/live/me/location", {"coord": [-121.61, 39.75], "accuracy_m": 5}, rsp["token"])
        self.call("POST", f"{BASE}/tasks", {"assignee": rsp["party_key"], "kind": "assist",
                                             "target": {"coord": [-121.6, 39.76]}}, CONTROLLER)
        body = self.board_items(civ)
        self.assertEqual(set(body), {"incident_id", "generated_at", "limits", "items"})
        self.assertEqual(body["limits"]["max_questions"], board.MAX_PASSIVE_QUESTIONS)
        self.assertTrue(body["items"])
        board_ids = {t["id"] for t in col("live_tasks").find({"created_by": "priority"})}  # the GET may refresh
        for item in body["items"]:
            self.assertEqual(set(item), BOARD_ITEM_KEYS)
            self.assertEqual(set(item["place"]), BOARD_PLACE_KEYS)
            self.assertIn(item["task_id"], board_ids)
        text = json.dumps(body)
        for leak in ("rsp_", "dev_", "chk_", "rpt_", "help", "assignee", "-121.61, 39.75", "priority", "report"):
            self.assertNotIn(leak, text)
        self.assertEqual([i["rank"] for i in body["items"]], list(range(1, len(body["items"]) + 1)))

    def test_board_questions_are_not_responder_tasks(self):
        self.with_board()
        rsp = self.responder()
        tasks = self.call("GET", "/api/live/me/tasks", token=rsp["token"]).json()["tasks"]
        self.assertFalse([t for t in tasks if t.get("created_by") == "priority"])
        self.assertFalse([t for t in self.situation(rsp["token"], zones=False)["tasks"]
                          if t.get("created_by") == "priority"])

    def test_questions_expire(self):
        _, open_tasks = self.with_board()
        answered, unanswered = open_tasks[0], open_tasks[1:]
        civ = self.civilian()
        coord = answered["target"]["coord"]
        kind = "road_passable" if answered["question"] == "road_status" else "shelter_full"
        extra = {"destination_id": answered["target"]["destination_id"]} if kind == "shelter_full" else {}
        r = self.report(civ, coord, kind=kind, severity=None, task_id=answered["id"], minutes_ago=0, **extra)
        self.assertEqual(r.status_code, 201, r.content)
        later = datetime.now(UTC) + timedelta(seconds=board.PASSIVE_TTL_S + 5)
        self.assertEqual(board.board_json(load_snapshot(INCIDENT, later))["items"], [])
        board.expire_tasks(INCIDENT, later)
        self.assertEqual(col("live_tasks").find_one({"id": answered["id"]})["status"], "done")
        for t in unanswered:
            doc = col("live_tasks").find_one({"id": t["id"]})
            self.assertEqual((doc["status"], doc["note"]), ("cancelled", "Expired"))
        # A closed question takes no more answers, and the place cools down before a new one.
        late = self.report(civ, coord, kind=kind, severity=None, task_id=answered["id"], minutes_ago=0, **extra)
        self.assertEqual(late.status_code, 409, late.content)
        created = board.create_tasks(load_snapshot(INCIDENT, later), self.refresh(later))
        self.assertNotIn(answered["place_id"], {t["place_id"] for t in created})

    # -- answers

    def test_civilian_answers_a_board_question(self):
        _, open_tasks = self.with_board()
        task = next(t for t in open_tasks if t["question"] == "road_status")
        civ = self.civilian()
        far = [-121.70, 39.70]  # an explicit answer is placed on the question's segment, not snapped
        r = self.report(civ, far, kind="road_blocked", task_id=task["id"], minutes_ago=0)
        self.assertEqual(r.status_code, 201, r.content)
        report = r.json()["report"]
        self.assertEqual(report["road_ref"]["segment_id"], task["target"]["segment_id"])
        self.assertEqual(report["method"], "explicit")
        self.assertEqual(col("live_tasks").find_one({"id": task["id"]})["status"], "open")  # answers accumulate
        wrong = self.report(civ, far, kind="fire_seen", task_id=task["id"], minutes_ago=0)
        self.assertEqual(wrong.status_code, 400, wrong.content)
        cmd = self.call("GET", f"{BASE}/command", token=CONTROLLER).json()
        answers = next(t for t in cmd["tasks"] if t["id"] == task["id"])["answers"]
        self.assertEqual((answers["road_blocked"], answers["total"], answers["passive"]), (1, 1, 0))
        self.assertIsNotNone(answers["last_at"])

    def test_civilian_cannot_answer_a_dispatched_task(self):
        seg = next(iter(get_index().segment_lines))
        t = self.call("POST", f"{BASE}/tasks", {"assignee": None, "target": {"segment_id": seg}}, CONTROLLER)
        civ = self.civilian()
        line = get_index().segment_lines[seg]
        r = self.report(civ, line[0], kind="road_passable", severity=None, task_id=t.json()["task"]["id"])
        self.assertEqual(r.status_code, 403, r.content)

    # -- passive observations

    def test_passive_report_is_placed_on_the_segment_without_a_position(self):
        _, open_tasks = self.with_board()
        task = next(t for t in open_tasks if t["question"] == "road_status")
        seg = task["target"]["segment_id"]
        civ = self.civilian()
        r = self.passive(civ, seg, task_id=task["id"])
        self.assertEqual(r.status_code, 201, r.content)
        rep = r.json()["report"]
        line = get_index().segment_lines[seg]
        mid = line[len(line) // 2]
        self.assertEqual(rep["location"], {"coord": [mid[0], mid[1]], "accuracy_m": None})
        self.assertEqual((rep["method"], rep["speed_class"], rep["road_ref"]["segment_id"]), ("passive", "free", seg))
        self.assertIsNone(rep["heading_deg"])
        slow = self.passive(civ, seg, kind="heavy_traffic", speed_class="slow", severity="slow", task_id=task["id"])
        self.assertEqual(slow.status_code, 201, slow.content)
        cmd = self.call("GET", f"{BASE}/command", token=CONTROLLER).json()
        answers = next(t for t in cmd["tasks"] if t["id"] == task["id"])["answers"]
        self.assertEqual((answers["passive"], answers["road_passable"], answers["heavy_traffic"]), (2, 1, 1))
        state = next(s for s in cmd["road_state"] if s["segment_id"] == seg)
        self.assertEqual(state["passive_parties"], 1)

    def test_passive_report_validation(self):
        seg = next(iter(get_index().segment_lines))
        civ = self.civilian()
        cases = [
            {"location": {"coord": [-121.6, 39.76], "accuracy_m": 5}},  # no position
            {"heading_deg": 90},
            {"note": "hi"},
            {"kind": "road_blocked"},  # never a block
            {"kind": "fire_seen"},
            {"kind": "heavy_traffic", "speed_class": "free"},
            {"speed_class": "fast"},
            {"segment_id": "nope"},
            {"method": "sneaky"},
        ]
        for extra in cases:
            body = {"segment_id": seg, **extra}
            r = self.passive(civ, body.pop("segment_id"), **body)
            self.assertEqual(r.status_code, 400, (extra, r.content))
        explicit_with_speed = self.report(civ, (-121.6, 39.76), speed_class="free")
        self.assertEqual(explicit_with_speed.status_code, 400, explicit_with_speed.content)
        ok = self.passive(civ, seg)
        self.assertEqual(ok.status_code, 201, ok.content)

    def test_passive_reports_share_the_civilian_rate_limit(self):
        seg = next(iter(get_index().segment_lines))
        civ = self.civilian()
        codes = [self.passive(civ, seg).status_code for _ in range(8)]
        self.assertIn(429, codes)


# base.LiveApiTest's own tests run in their module; hide the inherited ones here (the loader skips non-callables).
for _name in [n for n in vars(base.LiveApiTest) if n.startswith("test_") and n not in vars(TaskBoardTest)]:
    setattr(TaskBoardTest, _name, None)
