"""Drill injects: rules, endpoints, effects of each type (docs/live-reports.md "Injects").

The API tests need MongoDB (``MONGODB_DATABASE=crisistwin_inject_test``) and the drill bundle; the
twin tests build the Camp twin inputs and are skipped when those are unavailable.
"""

from __future__ import annotations

import json
import tempfile
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from django.core.cache import cache
from django.test import SimpleTestCase, override_settings

from api.live import groundrecord, schema, twin_service
from api.live.common import col
from api.live.drillcache import get_index
from api.live.state import Clock
from api.mongodb import get_database
from livecore import injects as rules
from livecore import routing
from livecore.fire import estimate_fire
from livecore.geo import point_in_multipolygon

INCIDENT = "camp-2018-drill"
BASE = f"/api/live/incidents/{INCIDENT}"
CONTROLLER = "dev-controller"
T0 = datetime(2018, 11, 8, 16, 30, tzinfo=UTC)
START = "2018-11-08T16:30:00Z"


def iso(t: datetime) -> str:
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def inside_point(zone) -> list[float]:
    for polygon in zone.geometry:
        for lon, lat in polygon[0]:
            p = (round(lon, 3), round(lat, 3))
            if point_in_multipolygon(p, zone.geometry):
                return list(p)
    raise AssertionError("no point inside the zone")


class InjectRulesTest(SimpleTestCase):
    def parse(self, value, field):
        return datetime.fromisoformat(value.replace("Z", "+00:00"))

    def norm(self, kind, params, at=T0):
        return rules.normalize_params(kind, params, at, zones={"z1", "z2"}, destinations={"s1": "shelter", "x1": "exit"},
                                      segments={"seg"}, parse_time=self.parse)

    def test_validation(self):
        self.assertEqual(self.norm("psap_reroute", {"zone_ids": ["z1", "z1"], "to": " Chico "})["zone_ids"], ["z1"])
        self.assertEqual(self.norm("comms_outage", {"zone_ids": ["z2"], "until": "2018-11-08T17:00:00Z"})["until"],
                         datetime(2018, 11, 8, 17, tzinfo=UTC))
        for kind, params in [
            ("nope", {}), ("psap_reroute", {"zone_ids": []}), ("psap_reroute", {"zone_ids": ["zz"]}),
            ("comms_outage", {"zone_ids": ["z1"]}),
            ("comms_outage", {"zone_ids": ["z1"], "until": "2018-11-08T16:00:00Z"}),
            ("silent_closure", {"segment_id": "other"}), ("shelter_full", {"destination_id": "x1"}),
            ("fire_jump", {"coord": [0, 100]}), ("fire_jump", {"coord": [-121.6, 39.7], "radius_m": 5}),
        ]:
            with self.assertRaises(rules.InjectError, msg=(kind, params)):
                self.norm(kind, params)

    def test_status_follows_the_clock(self):
        p = {"until": T0 + timedelta(hours=1)}
        self.assertEqual(rules.status_at("comms_outage", T0, p, T0 - timedelta(seconds=1)), "scheduled")
        self.assertEqual(rules.status_at("comms_outage", T0, p, T0), "active")
        self.assertEqual(rules.status_at("comms_outage", T0, p, T0 + timedelta(hours=1)), "ended")
        self.assertEqual(rules.status_at("silent_closure", T0, {}, T0 + timedelta(days=1)), "active")

    def test_fire_jump_overlay_is_labeled_and_simulated(self):
        drill = get_index().drill
        plain = estimate_fire(drill, T0)
        spot = estimate_fire(drill, T0, spots=[(T0, (-121.6, 39.76), 150.0)])
        self.assertEqual(len(spot.geometry), len(plain.geometry or ()) + 1)
        self.assertIn("injected spot fire (simulated)", spot.label)
        self.assertEqual(spot.evidence_class, "simulated")
        self.assertEqual(rules.spots_due([{"type": "fire_jump", "at": T0 + timedelta(minutes=1),
                                           "params": {"coord": [1, 2], "radius_m": 50}}], T0), [])


@override_settings(LIVE_CONTROLLER_TOKEN=CONTROLLER, LIVE_INVITE_CODE="DRILL")
class InjectApiTest(SimpleTestCase):
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
        groundrecord._record = None
        groundrecord._materialized.clear()
        self.addCleanup(setattr, groundrecord, "_record", None)
        self.addCleanup(groundrecord._materialized.clear)
        self.index = get_index()
        self.assertEqual(self.call("POST", f"{BASE}/drill", {"action": "start", "replay_start": START, "speed": 0},
                                   CONTROLLER).status_code, 200)

    def call(self, method, path, body=None, token=None):
        extra = {"HTTP_AUTHORIZATION": f"Bearer {token}"} if token else {}
        fn = getattr(self.client, method.lower())
        if method in ("GET", "DELETE"):
            return fn(path, **extra)
        return fn(path, data=json.dumps(body if body is not None else {}), content_type="application/json", **extra)

    def inject(self, kind, params, at=None, **extra):
        body = {"type": kind, "params": params, **({"at": at} if at else {}), **extra}
        return self.call("POST", f"{BASE}/injects", body, CONTROLLER)

    def injects(self):
        return self.call("GET", f"{BASE}/injects", token=CONTROLLER).json()["injects"]

    def command(self):
        return self.call("GET", f"{BASE}/command", token=CONTROLLER).json()

    def actions(self):
        return [d["action"] for d in col("live_decisions").find({"incident_id": INCIDENT}).sort("at", 1)
                if d["action"].startswith("inject_")]

    def civilian(self):
        return self.call("POST", "/api/live/devices").json()["token"]

    # -- endpoints
    def test_controller_only_and_validation(self):
        civ = self.civilian()
        self.assertEqual(self.call("GET", f"{BASE}/injects", token=civ).status_code, 403)
        self.assertEqual(self.call("GET", f"{BASE}/injects").status_code, 401)
        zone = next(iter(self.index.zones))
        for body in [{"type": "x", "params": {}}, {"type": "shelter_full", "params": {"destination_id": "nope"}},
                     {"type": "comms_outage", "params": {"zone_ids": [zone]}},
                     {"type": "psap_reroute", "params": {"zone_ids": [zone]}, "at": "2000-01-01T00:00:00Z"},
                     {"type": "psap_reroute", "params": {"zone_ids": [zone]}, "at": "not a time"}]:
            r = self.call("POST", f"{BASE}/injects", body, CONTROLLER)
            self.assertEqual((r.status_code, r.json()["error"]), (400, "invalid_inject"), body)

    def test_list_offers_road_choices(self):
        body = self.call("GET", f"{BASE}/injects", token=CONTROLLER).json()
        segments = body["choices"]["segments"]
        self.assertTrue(segments)
        self.assertTrue(set(segments[0]) == {"id", "name", "length_m"})
        r = self.inject("silent_closure", {"segment_id": segments[0]["id"]}, at="2018-11-08T16:40:00Z")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(len(r.json()["inject"]["coord"]), 2)

    def test_status_follows_the_drill_clock_and_logs_once(self):
        zone = next(iter(self.index.zones))
        later = self.inject("comms_outage", {"zone_ids": [zone], "until": "2018-11-08T18:00:00Z"},
                            at="2018-11-08T17:00:00Z")
        self.assertEqual(later.status_code, 201, later.content)
        self.assertEqual(later.json()["inject"]["status"], "scheduled")
        now = self.inject("psap_reroute", {"zone_ids": [zone], "to": "Chico PSAP"}, actor="script:demo")
        self.assertEqual(now.status_code, 201, now.content)
        body = now.json()["inject"]
        self.assertEqual((body["status"], body["at"], body["actor"]), ("active", START, "script:demo"))
        self.assertEqual(body["evidence_class"], "simulated")
        self.assertIn("Injected (simulated)", body["label"])
        for _ in range(3):  # idempotent polls
            self.command()
        self.assertEqual(self.actions().count("inject_started"), 1)
        # Jump the clock past the outage: it ends, and logs the start and the end once.
        self.call("POST", f"{BASE}/drill", {"action": "start", "replay_start": "2018-11-08T19:00:00Z", "speed": 0},
                  CONTROLLER)
        by_type = {i["type"]: i for i in self.injects()}
        self.assertEqual(by_type["comms_outage"]["status"], "ended")
        self.assertEqual(by_type["psap_reroute"]["status"], "active")
        self.injects()
        self.assertEqual(sorted(self.actions()), sorted(["inject_created", "inject_created", "inject_started",
                                                         "inject_started", "inject_ended"]))
        # A reset puts them back to scheduled; deleting removes one.
        self.call("POST", f"{BASE}/drill", {"action": "reset"}, CONTROLLER)
        self.assertEqual({i["status"] for i in self.injects()}, {"scheduled"})  # the default start is before both
        r = self.call("DELETE", f"{BASE}/injects/{body['id']}", token=CONTROLLER)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(self.injects()), 1)
        self.assertEqual(self.call("DELETE", f"{BASE}/injects?id={later.json()['inject']['id']}",
                                   token=CONTROLLER).status_code, 200)
        self.assertEqual(self.injects(), [])
        self.assertEqual(self.call("DELETE", f"{BASE}/injects/gone", token=CONTROLLER).status_code, 404)
        self.assertEqual(self.actions().count("inject_deleted"), 2)

    # -- psap_reroute
    def test_psap_reroute_drops_911_of_its_zones_from_its_time(self):
        zone_a, zone_b = list(self.index.zones.values())[:2]
        pa, pb = inside_point(zone_a), inside_point(zone_b)

        def item(n, at, channel, coord):
            return {"id": f"t-{n}", "at": at, "time_precision": "minute", "channel": channel, "category": "help_needed",
                    "road_name": None, "coord": coord, "summary": f"{channel}", "evidence_class": "reported",
                    "source_locator": "x", "text_sha12": "0" * 12}

        items = [item(1, "2018-11-08T16:00:00Z", "911", pa),   # before the inject
                 item(2, "2018-11-08T16:10:00Z", "911", pa),   # dropped
                 item(3, "2018-11-08T16:11:00Z", "radio", pa),  # radio stays
                 item(4, "2018-11-08T16:12:00Z", "911", pb)]   # other zone stays
        tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump({"items": items}, tmp)
        tmp.close()
        self.addCleanup(Path(tmp.name).unlink)
        with override_settings(LIVE_GROUND_RECORD=tmp.name):
            r = self.inject("psap_reroute", {"zone_ids": [zone_a.id], "to": "Chico PSAP"}, at="2018-11-08T16:05:00Z")
            self.assertEqual(r.status_code, 201, r.content)
            cmd = self.command()
            self.command()
            queued = sorted(x["record"]["id"] for x in cmd["reports"] if x["evidence_class"] == "historical_record")
            self.assertEqual(queued, ["t-1", "t-3", "t-4"])
            self.assertEqual(sorted(i["id"] for i in cmd["ground_record"]["items"]), ["t-1", "t-3", "t-4"])
            self.assertEqual(cmd["ground_record"]["totals"]["911"], 2)

    # -- comms_outage
    def test_comms_outage_refuses_civilian_reports_and_checkins_from_the_zone(self):
        zone_a, zone_b = list(self.index.zones.values())[:2]
        civ = self.civilian()
        r = self.inject("comms_outage", {"zone_ids": [zone_a.id], "until": "2018-11-08T17:00:00Z"})
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(self.command()["no_signal_zone_ids"], [zone_a.id])
        post = lambda coord: self.call("POST", f"{BASE}/reports", {  # noqa: E731
            "client_id": str(uuid.uuid4()), "incident_id": INCIDENT, "kind": "fire_seen", "severity": None,
            "location": {"coord": coord, "accuracy_m": 10}, "heading_deg": None, "destination_id": None,
            "task_id": None, "observed_at": iso(datetime.now(UTC)), "note": None}, civ)
        refused = post(inside_point(zone_a))
        self.assertEqual((refused.status_code, refused.json()["error"]), (503, "no_signal"))
        self.assertTrue(refused["Retry-After"])
        self.assertEqual(post(inside_point(zone_b)).status_code, 201)
        out = self.call("POST", f"{BASE}/checkins", {"status": "out", "zone_id": zone_a.id}, civ)
        self.assertEqual((out.status_code, out.json()["error"]), (503, "no_signal"))
        self.assertEqual(self.call("POST", f"{BASE}/checkins", {"status": "out", "zone_id": zone_b.id}, civ).status_code,
                         200)
        # Responders keep their radio; the outage ends with the clock.
        rsp = self.call("POST", f"{BASE}/join", {"invite_code": "DRILL"}).json()["token"]
        self.assertEqual(self.call("POST", f"{BASE}/checkins", {"status": "out", "zone_id": zone_a.id}, rsp).status_code,
                         200)
        self.call("POST", f"{BASE}/drill", {"action": "start", "replay_start": "2018-11-08T17:00:00Z", "speed": 0},
                  CONTROLLER)
        self.assertEqual(self.command()["no_signal_zone_ids"], [])
        self.assertEqual(self.call("POST", f"{BASE}/checkins", {"status": "out", "zone_id": zone_a.id}, civ).status_code,
                         200)

    # -- fire_jump
    def test_fire_jump_adds_a_labeled_spot_to_the_fire_estimate(self):
        before = self.command()["fire"]
        r = self.inject("fire_jump", {"coord": [-121.6, 39.76], "radius_m": 200}, at="2018-11-08T16:20:00Z")
        self.assertEqual(r.status_code, 201, r.content)
        fire = self.command()["fire"]
        self.assertEqual(len(fire["geometry"]["coordinates"]), len((before["geometry"] or {"coordinates": []})["coordinates"]) + 1)
        self.assertIn("injected spot fire (simulated)", fire["label"])
        self.assertEqual(fire["evidence_class"], "simulated")
        self.assertEqual(r.json()["inject"]["coord"], [-121.6, 39.76])


class InjectTwinTest(SimpleTestCase):
    """Silent closure and full shelter reach the twin as labeled operator commands, with no report."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        try:
            cls.index = get_index()
            twinmod = twin_service._import_sim()
            raw = twinmod.camp_inputs(
                twin_service._package("LIVE_TWIN_PACKAGE", twin_service.CAMP_PACKAGE),
                twin_service._package("LIVE_TWIN_ROADS_PACKAGE", twin_service.CAMP_ROADS_PACKAGE),
                twin_service.TWIN_DEMAND, twin_service.TWIN_SEED)
        except Exception as exc:  # noqa: BLE001
            raise __import__("unittest").SkipTest(f"twin inputs unavailable: {type(exc).__name__}: {exc}")
        cls.inputs, _ = twin_service._planner_destinations(
            raw, twinmod, routing._index(cls.index.drill).destination_nodes)

    def setUp(self):
        for p in (mock.patch.object(twin_service, "_ready_inputs", lambda *_: self.inputs),
                  mock.patch.object(twin_service, "current_guidance", lambda *a, **k: []),
                  mock.patch.dict(twin_service._sessions, {}, clear=True)):
            p.start()
            self.addCleanup(p.stop)
        self.docs: list[dict] = []

    def snapshot(self, minutes):
        run = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
        clock = Clock(T0 - timedelta(minutes=30), run, 0.0, T0 + timedelta(minutes=minutes), False)
        return SimpleNamespace(incident_id="inject-twin", index=self.index, clock=clock, road_state=[],
                               blocked=frozenset(), injects=self.docs)

    def commands(self, snap):
        return twin_service._with_twin(snap, lambda s, t, m: (t.action_log(), t.snapshot(detail="full")))

    def doc(self, kind, params, at):
        d = {"id": f"inj_{len(self.docs)}", "type": kind, "params": params, "at": at}
        self.docs.append(d)
        return d

    def test_silent_closure_closes_in_the_twin_only_when_due_and_reopens_on_delete(self):
        seg = next(s for s in sorted(self.index.drill.roads.segment_edges) if self.index.segment_names.get(s))
        d = self.doc("silent_closure", {"segment_id": seg}, T0 + timedelta(minutes=5))
        log, _ = self.commands(self.snapshot(2))
        self.assertEqual(log, [])  # not due
        log, snap = self.commands(self.snapshot(6))
        self.assertEqual([a["type"] for a in log], ["close_road"])
        self.assertEqual(log[0]["actor"]["id"], f"inject:{d['id']}")
        self.assertTrue(log[0]["rationale"].startswith("Injected (simulated)"))
        self.assertEqual(log[0]["params"], {"mode": "hard"})
        self.assertGreater(len(snap["closed"]["rows"]), 0)
        log, _ = self.commands(self.snapshot(7))  # idempotent
        self.assertEqual(len(log), 1)
        self.docs.clear()  # deleted
        log, _ = self.commands(self.snapshot(8))
        self.assertEqual([a["type"] for a in log], ["close_road", "reopen_road"])

    def test_shelter_full_marks_the_destination_full(self):
        dest = next(d for d in self.index.drill.destinations if d.kind != "exit")
        self.doc("shelter_full", {"destination_id": dest.id}, T0 + timedelta(minutes=1))
        log, snap = self.commands(self.snapshot(3))
        self.assertEqual([a["type"] for a in log], ["fill_destination"])
        status = {d["id"]: d["status"] for d in snap["destinations"]}
        self.assertEqual(status[dest.id], "full")
        log, _ = self.commands(self.snapshot(4))
        self.assertEqual(len(log), 1)
