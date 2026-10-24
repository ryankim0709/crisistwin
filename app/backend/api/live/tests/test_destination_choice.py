"""D1 destination choice and the D2 fire caveat through the API (docs/live-reports.md
"Zones and guidance" -> "Additive fields"). Local MongoDB, *_test database, rule controller,
frozen drill clock at 18:00Z, when some zones have only through-fire routes.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime

from django.core.cache import cache
from django.test import SimpleTestCase, override_settings

from api.live import schema
from api.live.common import col
from api.live.controller import refresh_published
from api.live.drillcache import get_index
from api.live.state import ALTERNATIVE_LINE_MAX_POINTS, current_guidance, load_snapshot
from api.mongodb import get_database
from livecore.geo import point_in_multipolygon, polyline_distance_m
from livecore.planner import NEAR_FIRE_CAVEAT, THROUGH_FIRE_CAVEAT, destination_loads, plan, with_alternatives
from livecore.routing import REFUGE_FIRE_BUFFER_M

INCIDENT = "camp-2018-drill"
BASE = f"/api/live/incidents/{INCIDENT}"
CONTROLLER = "dev-controller"
REPLAY_START = "2018-11-08T18:00:00Z"
SAFETIES = {"clear", "passes_near_fire", "passes_fire"}
RANK = {"clear": 0, "passes_near_fire": 1, "passes_fire": 2}


@override_settings(LIVE_CONTROLLER_TOKEN=CONTROLLER, LIVE_INVITE_CODE="DRILL", LIVE_CONTROLLER="rule")
class DestinationChoiceTest(SimpleTestCase):
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
        r = self.call("POST", f"{BASE}/drill", {"action": "start", "replay_start": REPLAY_START, "speed": 0},
                      CONTROLLER)
        self.assertEqual(r.status_code, 200, r.content)
        r = self.call("POST", f"{BASE}/replan", {}, CONTROLLER)
        self.assertEqual(r.status_code, 201, r.content)
        self.proposal = r.json()["proposal"]
        a = self.call("POST", f"/api/live/proposals/{self.proposal['id']}/approve", {}, CONTROLLER)
        self.assertEqual(a.status_code, 200, a.content)

    def call(self, method, path, body=None, token=None):
        extra = {"HTTP_AUTHORIZATION": f"Bearer {token}"} if token else {}
        fn = getattr(self.client, method.lower())
        if method == "GET":
            return fn(path, **extra)
        return fn(path, data=json.dumps(body if body is not None else {}), content_type="application/json", **extra)

    def civilian(self):
        r = self.call("POST", "/api/live/devices")
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()["token"]

    def guidance(self, token):
        r = self.call("GET", f"{BASE}/situation?zones=0", token=token)
        self.assertEqual(r.status_code, 200, r.content)
        return {g["zone_id"]: g for g in r.json()["guidance"]}

    def zone_with_choice(self, guidance):
        return next(g for g in guidance.values() if len(g.get("alternatives") or []) >= 2)

    def test_alternatives_present_and_safe(self):
        civ = self.civilian()
        guidance = self.guidance(civ)
        snapshot = load_snapshot(INCIDENT, datetime.now(UTC))
        fire = snapshot.fire.geometry
        self.assertIsNotNone(fire)
        dests = get_index().destinations
        with_choice = 0
        for g in guidance.values():
            moving = g["level"] != "none" and not g["no_route"]
            if not moving:
                self.assertEqual(g["alternatives"], [])
                self.assertIsNone(g["caveat"])
                continue
            self.assertIn(g["route"]["safety"], SAFETIES)
            alts = g["alternatives"]
            if not alts:
                continue
            with_choice += 1
            self.assertLessEqual(len(alts), 4)
            self.assertTrue(alts[0]["recommended"])
            self.assertEqual(alts[0]["destination"]["id"], g["destination"]["id"])
            self.assertEqual(sum(a["recommended"] for a in alts), 1)
            self.assertEqual(len({a["destination"]["id"] for a in alts}), len(alts))
            for a in alts:
                self.assertIn(a["safety"], SAFETIES)
                self.assertEqual(a["route"]["safety"], a["safety"])
                self.assertLessEqual(RANK[a["safety"]], RANK[alts[0]["safety"]], g["zone_id"])
                self.assertTrue(a["load"] is None or 0.0 <= a["load"] <= 1.0)
                self.assertGreaterEqual(a["route"]["eta_min"], 1)
                self.assertGreaterEqual(len(a["route"]["line"]), 2)
                self.assertLessEqual(len(a["route"]["line"]), ALTERNATIVE_LINE_MAX_POINTS)
                dest = dests[a["destination"]["id"]]
                self.assertFalse(point_in_multipolygon(dest.coord, fire), dest.id)
                if dest.kind == "temporary_refuge":
                    self.assertGreater(polyline_distance_m((dest.coord,), fire, REFUGE_FIRE_BUFFER_M),
                                       REFUGE_FIRE_BUFFER_M, dest.id)
        self.assertGreater(with_choice, 10)

    def test_caveat_serialized_with_route_safety(self):
        civ = self.civilian()
        guidance = self.guidance(civ)
        exposed = [g for g in guidance.values() if g.get("route") and g["route"]["safety"] != "clear"]
        self.assertTrue(exposed, "18:00Z should have zones whose every route passes the fire")
        for g in guidance.values():
            if not g.get("route"):
                continue
            want = {"clear": None, "passes_near_fire": NEAR_FIRE_CAVEAT,
                    "passes_fire": THROUGH_FIRE_CAVEAT}[g["route"]["safety"]]
            self.assertEqual(g["caveat"], want, g["zone_id"])
        # The proposal the controller approved carried the same fields.
        change = next(c for c in self.proposal["changes"] if c["to"]["route"])
        self.assertIn("safety", change["to"]["route"])
        self.assertIn("caveat", change["to"])
        self.assertIn("alternatives", change["to"])

    def test_destination_post_stored_validated_counted(self):
        civ = self.civilian()
        g = self.zone_with_choice(self.guidance(civ))
        zone_id, alt = g["zone_id"], g["alternatives"][1]["destination"]["id"]
        path = "/api/live/me/destination"
        r = self.call("POST", path, {"zone_id": zone_id, "destination_id": alt}, civ)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual((body["zone_id"], body["destination_id"]), (zone_id, alt))
        self.assertTrue(body["expires_at"].endswith("Z"))
        # One per device and zone: a second choice replaces the first.
        rec = g["alternatives"][0]["destination"]["id"]
        self.assertEqual(self.call("POST", path, {"zone_id": zone_id, "destination_id": rec}, civ).status_code, 200)
        docs = list(col("live_destination_choices").find({"zone_id": zone_id}))
        self.assertEqual(len(docs), 1)
        self.assertEqual(docs[0]["destination_id"], rec)
        self.assertNotIn("coord", docs[0])
        self.assertGreater(docs[0]["expires_at"], docs[0]["at"])
        other = self.civilian()
        self.assertEqual(self.call("POST", path, {"zone_id": zone_id, "destination_id": alt}, other).status_code, 200)
        # Not offered, unknown zone, missing fields, no token, controller token.
        offered = {a["destination"]["id"] for a in g["alternatives"]}
        not_offered = next(d for d in get_index().destinations if d not in offered)
        for bad in ({"zone_id": zone_id, "destination_id": not_offered}, {"zone_id": "bg:nope", "destination_id": alt},
                    {"zone_id": zone_id}):
            self.assertEqual(self.call("POST", path, bad, civ).status_code, 400, bad)
        self.assertEqual(self.call("POST", path, {"zone_id": zone_id, "destination_id": alt}).status_code, 401)
        self.assertEqual(self.call("POST", path, {"zone_id": zone_id, "destination_id": alt}, CONTROLLER).status_code,
                         403)
        # The controller sees the counts.
        cmd = self.call("GET", f"{BASE}/command", token=CONTROLLER)
        self.assertEqual(cmd.status_code, 200, cmd.content)
        prefs = {(p["zone_id"], p["destination_id"]): p["count"] for p in cmd.json()["destination_preferences"]}
        self.assertEqual(prefs, {(zone_id, rec): 1, (zone_id, alt): 1})
        # Reset clears them.
        self.call("POST", f"{BASE}/drill", {"action": "reset"}, CONTROLLER)
        self.assertEqual(col("live_destination_choices").count_documents({}), 0)

    def test_preferences_feed_load_but_not_the_pick(self):
        snapshot = load_snapshot(INCIDENT, datetime.now(UTC))
        drill = snapshot.index.drill
        base = plan(drill, snapshot.clock.replay_now, snapshot.fire, snapshot.blocked, snapshot.full_destinations)
        plain = with_alternatives(drill, base, snapshot.blocked, snapshot.fire.geometry, snapshot.full_destinations)
        g = next(x for x in plain if len(x.alternatives) >= 2 and x.alternatives[1].load is not None)
        target = g.alternatives[1].destination_id
        crowd = with_alternatives(drill, base, snapshot.blocked, snapshot.fire.geometry, snapshot.full_destinations,
                                  {(g.zone_id, target): 500})
        after = next(x for x in crowd if x.zone_id == g.zone_id)
        self.assertEqual(after.destination_id, g.destination_id)  # load never changes the recommended pick
        self.assertGreater(destination_loads(drill, base, {target: 500})[target], g.alternatives[1].load)
        # A heavily chosen destination ranks no earlier than before.
        before_rank = [a.destination_id for a in g.alternatives].index(target)
        after_ids = [a.destination_id for a in after.alternatives]
        self.assertTrue(target not in after_ids or after_ids.index(target) >= before_rank)

    def test_refresh_drops_destinations_no_longer_offered(self):
        doc = next(d for d in current_guidance(INCIDENT) if len(d.get("alternatives") or []) >= 2)
        dropped = doc["alternatives"][1]["destination"]["id"]
        snapshot = load_snapshot(INCIDENT, datetime.now(UTC))
        drill = snapshot.index.drill
        full = snapshot.full_destinations | {dropped}
        base = plan(drill, snapshot.clock.replay_now, snapshot.fire, snapshot.blocked, full)
        guidance = with_alternatives(drill, base, snapshot.blocked, snapshot.fire.geometry, full)
        self.assertGreaterEqual(refresh_published(snapshot.index, current_guidance(INCIDENT), guidance,
                                                  snapshot.fire.geometry), 1)
        fresh = next(d for d in current_guidance(INCIDENT) if d["zone_id"] == doc["zone_id"])
        self.assertEqual(fresh["version"], doc["version"])
        self.assertNotIn(dropped, [a["destination"]["id"] for a in fresh.get("alternatives") or []])
        civ = self.civilian()
        r = self.call("POST", "/api/live/me/destination", {"zone_id": doc["zone_id"], "destination_id": dropped}, civ)
        self.assertEqual(r.status_code, 400, r.content)
