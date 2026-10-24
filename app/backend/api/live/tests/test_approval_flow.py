"""Approval flow of the live controller (docs/live-reports.md "Proposals and the approval policy").

Same setup as test_live_api: a *_test MongoDB, empty live_* collections, a frozen drill at 16:30Z.
"""

from __future__ import annotations

import dataclasses
from datetime import timedelta
from unittest import mock

from api.live import controller
from api.live.common import col, wall_now
from api.live.state import load_snapshot
from api.live.tests import test_live_api as base

BASE, CONTROLLER, INCIDENT = base.BASE, base.CONTROLLER, base.INCIDENT


class _InlineThread:
    """Runs a background replan inline so the test can observe its result."""

    def __init__(self, target, args=(), **_kwargs):
        self._target, self._args = target, args

    def start(self):
        self._target(*self._args)


class ApprovalFlowTest(base.LiveApiTest):
    """Reuses LiveApiTest's setup and helpers; its own tests are switched off below."""

    def pending(self):
        docs = list(col("live_proposals").find({"incident_id": INCIDENT, "status": "pending"}, {"_id": 0}))
        self.assertLessEqual(len(docs), 1, docs)
        return docs[0] if docs else None

    def test_subset_approve_publishes_only_those_zones(self):
        civ = self.civilian()
        r = self.call("POST", f"{BASE}/replan", {}, CONTROLLER)
        self.assertEqual(r.status_code, 201, r.content)
        proposal = r.json()["proposal"]
        evac = [c["zone_id"] for c in proposal["changes"] if c["to"]["level"] == "evacuate_now"]
        rest = [c["zone_id"] for c in proposal["changes"] if c["to"]["level"] != "evacuate_now"]
        self.assertTrue(evac and rest, "need two groups at 16:30Z")
        url = f"/api/live/proposals/{proposal['id']}/approve"
        self.assertEqual(self.call("POST", url, {"zone_ids": []}, CONTROLLER).status_code, 400)
        self.assertEqual(self.call("POST", url, {"zone_ids": ["bg:not-in-proposal"]}, CONTROLLER).status_code, 400)
        a = self.call("POST", url, {"zone_ids": evac}, CONTROLLER)
        self.assertEqual(a.status_code, 200, a.content)
        part = a.json()["proposal"]
        self.assertEqual(part["status"], "approved")
        self.assertEqual(part["parent_id"], proposal["id"])
        self.assertEqual(sorted(g["zone_id"] for g in a.json()["guidance"]), sorted(evac))
        self.assertEqual(sorted(self.guidance_by_zone(civ)), sorted(evac))
        original = self.pending()
        self.assertEqual(original["id"], proposal["id"])
        self.assertEqual(sorted(c["zone_id"] for c in original["changes"]), sorted(rest))
        # zones already approved are no longer part of the pending proposal
        self.assertEqual(self.call("POST", url, {"zone_ids": evac[:1]}, CONTROLLER).status_code, 400)
        last = self.call("POST", url, {"zone_ids": rest}, CONTROLLER)
        self.assertEqual(last.status_code, 200, last.content)
        self.assertIsNone(self.pending())
        self.assertEqual(sorted(self.guidance_by_zone(civ)), sorted(evac + rest))
        self.assertEqual(self.call("POST", url, {}, CONTROLLER).status_code, 409)

    def crowd_block(self, point):
        """Three independent civilians report ``point`` blocked (public, crowd-only)."""
        for i in range(3):
            r = self.report(self.civilian(), point, minutes_ago=24 - 6 * i)
            self.assertEqual(r.status_code, 201, r.content)
            # Received minutes apart, so the three parties count as independent (not one person).
            col("live_reports").update_one(
                {"id": r.json()["report"]["id"]}, {"$set": {"received_at": wall_now() - timedelta(minutes=24 - 6 * i)}}
            )

    def test_civilian_only_block_waits_for_controller(self):
        civ = self.civilian()
        self.publish_initial_guidance()
        zone_id, point = self.road_point_on_a_route(civ)
        self.crowd_block(point)
        with mock.patch.object(controller.threading, "Thread", _InlineThread):
            self.situation(civ, zones=False)
        statuses = [p["status"] for p in col("live_proposals").find({"incident_id": INCIDENT}, {"status": 1})]
        self.assertNotIn("auto_approved", statuses)
        pending = self.pending()
        self.assertIsNotNone(pending, "a crowd-only block that changes routes must wait for the controller")
        self.assertEqual(pending["causes"], ["road_report"])
        self.assertIn(zone_id, {c["zone_id"] for c in pending["changes"]})
        self.assertEqual(self.guidance_by_zone(civ)[zone_id]["version"], 1)

    def test_confirming_another_block_does_not_publish_crowd_reroutes(self):
        civ = self.civilian()
        self.publish_initial_guidance()
        zone_id, point = self.road_point_on_a_route(civ)
        self.crowd_block(point)
        with mock.patch.object(controller.threading, "Thread", _InlineThread):
            self.situation(civ, zones=False)
        crowd_zones = {c["zone_id"] for c in self.pending()["changes"]}
        self.assertIn(zone_id, crowd_zones)
        # The controller confirms one civilian report on a road that none of those zones use.
        other = next(
            (g, g["route"]["line"][len(g["route"]["line"]) // 2])
            for g in self.guidance_by_zone(civ).values()
            if g["zone_id"] not in crowd_zones and len((g.get("route") or {}).get("line") or []) >= 4
            and point not in g["route"]["line"]
        )
        rpt = self.report(self.civilian(), other[1], minutes_ago=2)
        self.assertEqual(rpt.status_code, 201, rpt.content)
        t = self.call("POST", f"/api/live/reports/{rpt.json()['report']['id']}/triage", {"action": "confirm"}, CONTROLLER)
        self.assertEqual(t.status_code, 200, t.content)
        for doc in col("live_proposals").find({"incident_id": INCIDENT, "status": "auto_approved"}):
            self.assertFalse(crowd_zones & {c["zone_id"] for c in doc["changes"]}, "crowd-driven reroute auto-published")
        after = self.guidance_by_zone(civ)
        self.assertTrue(all(after[z]["version"] == 1 for z in crowd_zones if z in after))
        pending = self.pending()
        self.assertTrue(crowd_zones <= {c["zone_id"] for c in pending["changes"]})
        self.assertIn("road_report", pending["causes"])

    def test_no_route_flip_is_route_lost_and_pending(self):
        civ = self.civilian()
        self.publish_initial_guidance()
        routed = next(g for g in self.guidance_by_zone(civ).values() if g["route"] and not g["no_route"])
        real = controller.controllers.active()

        class LosesRoute:
            """The real controller, except that one routed zone now has no open route."""

            def propose(self, snapshot, published):
                plan = real.propose(snapshot, published)
                guidance = [
                    dataclasses.replace(g, no_route=True, route=None, destination_id=None)
                    if g.zone_id == routed["zone_id"]
                    else g
                    for g in plan.guidance
                ]
                return dataclasses.replace(plan, guidance=guidance)

        with mock.patch.object(controller.controllers, "active", lambda: LosesRoute()):
            pending, auto = controller.replan(load_snapshot(INCIDENT, wall_now()), ["fire"])
        self.assertIsNotNone(pending)
        lost = [c for c in pending["changes"] if c["zone_id"] == routed["zone_id"]]
        self.assertEqual([c["kind"] for c in lost], ["route_lost"])
        self.assertEqual(pending["status"], "pending")
        self.assertTrue(auto is None or all(c["zone_id"] != routed["zone_id"] for c in auto["changes"]))

    def test_shelter_full_on_an_exit_is_rejected(self):
        civ = self.civilian()
        dests = self.call("GET", f"{BASE}/command", token=CONTROLLER).json()["destinations"]
        exit_id = next(d["id"] for d in dests if d["kind"] == "exit")
        r = self.report(civ, (-121.6219, 39.7596), kind="shelter_full", severity=None, destination_id=exit_id)
        self.assertEqual(r.status_code, 400, r.content)
        shelter = next((d["id"] for d in dests if d["kind"] in ("shelter", "temporary_refuge")), None)
        if shelter:
            ok = self.report(civ, (-121.6219, 39.7596), kind="shelter_full", severity=None, destination_id=shelter)
            self.assertEqual(ok.status_code, 201, ok.content)


for _name in dir(base.LiveApiTest):
    if _name.startswith("test_"):
        setattr(ApprovalFlowTest, _name, None)  # run in test_live_api, not twice
