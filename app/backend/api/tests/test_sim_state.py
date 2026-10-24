import json
import re
from unittest.mock import patch

from django.core.cache import cache
from django.test import SimpleTestCase
from pymongo.errors import ConnectionFailure

from api import sim_state
from api.sim_state import haversine_m


def _get(doc, path):
    for part in path.split("."):
        doc = doc.get(part) if isinstance(doc, dict) else None
    return doc


def _matches(doc, flt):
    for key, cond in flt.items():
        value = _get(doc, key)
        if isinstance(cond, dict):
            for op, arg in cond.items():
                if op == "$lt" and not (value is not None and value < arg):
                    return False
                if op == "$gte" and not (value is not None and value >= arg):
                    return False
                if op == "$in" and value not in arg:
                    return False
                if op == "$regex" and not re.search(arg, value or ""):
                    return False
                if op == "$nearSphere":
                    point = arg["$geometry"]["coordinates"]
                    if haversine_m(point, value["coordinates"]) > arg["$maxDistance"]:
                        return False
        elif value != cond:
            return False
    return True


class FakeCursor:
    def __init__(self, docs, point=None):
        self.docs = docs

    def sort(self, spec):
        for key, direction in reversed(spec):
            self.docs.sort(key=lambda d: _get(d, key), reverse=direction == -1)
        return self

    def skip(self, n):
        self.docs = self.docs[n:]
        return self

    def limit(self, n):
        self.docs = self.docs[:n]
        return self

    def __iter__(self):
        return iter(self.docs)


class FakeCollection:
    """The subset of pymongo Collection the sim-state API uses, in memory."""

    def __init__(self):
        self.docs = []

    def create_index(self, *args, **kwargs):
        return "idx"

    def insert_many(self, docs, ordered=True):
        self.docs.extend(dict(d) for d in docs)

    def insert_one(self, doc):
        self.docs.append(dict(doc))

    def _select(self, flt):
        return [d for d in self.docs if _matches(d, flt)]

    def find(self, flt=None, projection=None, sort=None):
        docs = self._select(flt or {})
        if any("$nearSphere" in (c or {}) for c in (flt or {}).values() if isinstance(c, dict)):
            near = next(c["$nearSphere"] for c in flt.values() if isinstance(c, dict) and "$nearSphere" in c)
            point = near["$geometry"]["coordinates"]
            docs.sort(key=lambda d: haversine_m(point, d["location"]["coordinates"]))
        cursor = FakeCursor(docs)
        return cursor.sort(sort) if sort else cursor

    def find_one(self, flt=None, projection=None, sort=None):
        return next(iter(self.find(flt, sort=sort)), None)

    def _apply(self, doc, fields):
        for path, value in fields.items():
            *parents, last = path.split(".")
            target = doc
            for part in parents:
                target = target.setdefault(part, {})
            target[last] = value

    def update_many(self, flt, update):
        for doc in self._select(flt):
            self._apply(doc, update["$set"])

    def update_one(self, flt, update):
        for doc in self._select(flt)[:1]:
            self._apply(doc, update["$set"])

    def delete_many(self, flt):
        self.docs = [d for d in self.docs if not _matches(d, flt)]


class FakeDatabase(dict):
    def __missing__(self, name):
        self[name] = FakeCollection()
        return self[name]


def run_body(**over):
    body = {
        "label": "Studio run",
        "area": {"id": "osm-1", "name": "Paradise", "bbox": [-121.7, 39.7, -121.5, 39.8]},
        "horizon_minutes": 360,
        "order_minute": 15,
        "zones": [
            {"zone_id": "z1", "name": "Zone 1", "centroid": [-121.61, 39.76], "homes": 3},
            {"zone_id": "z2", "name": "Zone 2", "centroid": [-121.60, 39.75], "homes": 1},
        ],
        "homes": [
            {"home_id": "h0", "zone_id": "z1", "rank": 0, "coord": [-121.6100, 39.7600], "address": "10 Pentz Rd"},
            {"home_id": "h1", "zone_id": "z1", "rank": 1, "coord": [-121.6101, 39.7601], "address": "12 Pentz Rd"},
            {"home_id": "h2", "zone_id": "z1", "rank": 2, "coord": [-121.6102, 39.7602], "address": "14 Pentz Rd"},
            {"home_id": "h3", "zone_id": "z2", "rank": 0, "coord": [-121.5000, 39.7000], "address": "5 Skyway"},
        ],
    }
    body.update(over)
    return body


def tick_zone(zone_id, advice, departed, at_home, order_minute=15, exit_id="exit-a"):
    return {"zone_id": zone_id, "advice": advice, "order_minute": order_minute, "departed": departed,
            "at_home": at_home, "exit_id": exit_id}


class SimStateTests(SimpleTestCase):
    def setUp(self):
        cache.clear()
        sim_state._indexes_ready = False
        self.db = FakeDatabase()
        patcher = patch("api.sim_state.get_database", return_value=self.db)
        patcher.start()
        self.addCleanup(patcher.stop)

    def post(self, path, body):
        data = body if isinstance(body, str | bytes) else json.dumps(body)
        return self.client.post(f"/api/sim-state/{path}", data, content_type="application/json")

    def publish(self, **over):
        response = self.post("runs", run_body(**over))
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        return response.json()["run_id"]

    def tick(self, run_id, minute, zones):
        return self.post(f"runs/{run_id}/tick", {"minute": minute, "zones": zones})

    # publish
    def test_publish_validation(self):
        bad = {
            "label": run_body(label="x" * 121),
            "nan coord": '{"label":"a"}',
            "out of range": run_body(homes=[{**run_body()["homes"][0], "coord": [-200, 39]}]),
            "unknown zone": run_body(homes=[{**run_body()["homes"][0], "zone_id": "nope"}]),
            "rank gap": run_body(homes=[{**h, "rank": h["rank"] + 1} if h["home_id"] == "h2" else h
                                        for h in run_body()["homes"]]),
            "duplicate home": run_body(homes=run_body()["homes"] + [run_body()["homes"][0]]),
            "long address": run_body(homes=[{**run_body()["homes"][0], "address": "a" * 121}]
                                     + run_body()["homes"][1:]),
            "bool horizon": run_body(horizon_minutes=True),
            "too many zones": run_body(zones=[{"zone_id": f"z{i}", "name": "n", "centroid": [0, 0], "homes": 0}
                                              for i in range(501)]),
            "not an object": "[1]",
        }
        for name, body in bad.items():
            cache.clear()  # publish is throttled to 10/min per IP
            response = self.post("runs", body)
            self.assertEqual(response.status_code, 400, name)
            self.assertEqual(response.json()["error"], "invalid_run", name)
        cache.clear()
        nan = json.dumps(run_body()).replace('"horizon_minutes": 360', '"horizon_minutes": NaN')
        self.assertEqual(self.post("runs", nan).status_code, 400)
        self.assertEqual(self.db["sim_runs"].docs, [])

    def test_publish_rejects_oversize_body(self):
        response = self.post("runs", " " * (8 * 1024 * 1024 + 1))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "invalid_run")

    def test_publish_stores_unknown_advice(self):
        run_id = self.publish()
        self.assertEqual({h["advice"] for h in self.db["sim_homes"].docs}, {"unknown"})
        self.assertEqual(self.db["sim_homes"].docs[0]["address_lc"], "10 pentz rd")
        self.assertEqual(self.db["sim_runs"].docs[0]["run_id"], run_id)
        response = self.client.get("/api/sim-state/advice?home_id=h0")
        self.assertEqual(response.json()["advice"], "unknown")
        self.assertIsNone(response.json()["minute"])

    def test_retention_keeps_three_runs(self):
        ids = [self.publish(label=f"run {i}") for i in range(5)]
        kept = [r["run_id"] for r in self.db["sim_runs"].docs]
        self.assertEqual(sorted(kept), sorted(ids[2:]))
        self.assertEqual({h["run_id"] for h in self.db["sim_homes"].docs}, set(ids[2:]))
        self.assertEqual(self.client.get("/api/sim-state/latest").json()["run"]["run_id"], ids[-1])

    # tick
    def test_tick_sets_left_by_rank_and_zone_advice(self):
        run_id = self.publish()
        response = self.tick(run_id, 47, [tick_zone("z1", "leave_now", 2, 1), tick_zone("z2", "leave_later", 0, 1, 60)])
        self.assertEqual(response.json(), {"run_id": run_id, "minute": 47, "changed_zones": 2})
        advice = {h: self.client.get(f"/api/sim-state/advice?home_id={h}").json() for h in ("h0", "h1", "h2", "h3")}
        self.assertEqual([advice[h]["advice"] for h in ("h0", "h1", "h2")], ["left", "left", "leave_now"])
        self.assertEqual(advice["h2"]["exit_id"], "exit-a")
        self.assertEqual(advice["h3"]["advice"], "leave_later")
        self.assertEqual(advice["h3"]["order_minute"], 60)
        self.assertEqual(advice["h3"]["minutes_until_order"], 13)
        self.assertIsNone(advice["h2"]["minutes_until_order"])
        self.assertEqual(advice["h2"]["minute"], 47)
        self.assertEqual(advice["h2"]["evidence_class"], "simulated")
        self.assertEqual(advice["h2"]["notice"], sim_state.NOTICE)

    def test_tick_unchanged_zone_is_not_rewritten_and_can_go_backward(self):
        run_id = self.publish()
        self.tick(run_id, 47, [tick_zone("z1", "leave_now", 1, 2)])
        response = self.tick(run_id, 40, [tick_zone("z1", "leave_now", 1, 2)])
        self.assertEqual(response.json()["changed_zones"], 0)
        self.assertEqual(self.client.get("/api/sim-state/latest").json()["minute"], 40)
        response = self.tick(run_id, 10, [tick_zone("z1", "leave_later", 0, 3)])
        self.assertEqual(response.json()["changed_zones"], 1)
        self.assertEqual(self.client.get("/api/sim-state/advice?home_id=h0").json()["advice"], "leave_later")

    def test_empty_tick_only_moves_the_clock(self):
        run_id = self.publish()
        response = self.tick(run_id, 12, [])
        self.assertEqual(response.json(), {"run_id": run_id, "minute": 12, "changed_zones": 0})
        latest = self.client.get("/api/sim-state/latest").json()
        self.assertEqual(latest["minute"], 12)
        self.assertEqual(latest["zones"][0]["advice"], "unknown")

    def test_zone_ids_are_not_assumed_lowercase(self):
        zones = [{"zone_id": "Z01", "name": "Zone 1", "centroid": [0, 0], "homes": 1}]
        homes = [{"home_id": "h0", "zone_id": "Z01", "rank": 0, "coord": [0, 0], "address": "1 A St"}]
        run_id = self.publish(zones=zones, homes=homes)
        self.assertEqual(self.tick(run_id, 1, [tick_zone("Z01", "leave_now", 0, 1)]).status_code, 200)

    def test_cleared_zone_homes_all_left(self):
        run_id = self.publish()
        self.tick(run_id, 90, [tick_zone("z1", "cleared", 3, 0)])
        for home in ("h0", "h1", "h2"):
            self.assertEqual(self.client.get(f"/api/sim-state/advice?home_id={home}").json()["advice"], "left")

    def test_tick_errors(self):
        run_id = self.publish()
        self.assertEqual(self.tick("missing", 1, []).status_code, 404)
        self.assertEqual(self.tick("missing", 1, []).json()["error"], "unknown_run")
        for body in (
            {"minute": 361, "zones": []},
            {"minute": 1.5, "zones": []},
            {"minute": 1, "zones": [tick_zone("zz", "leave_now", 0, 0)]},
            {"minute": 1, "zones": [tick_zone("z1", "left", 0, 3)]},
            {"minute": 1, "zones": [tick_zone("z1", "leave_now", 4, 0)]},
            {"minute": 1, "zones": [tick_zone("z1", "leave_now", 0, 3), tick_zone("z1", "leave_now", 0, 3)]},
        ):
            response = self.post(f"runs/{run_id}/tick", body)
            self.assertEqual((response.status_code, response.json()["error"]), (400, "invalid_tick"), body)

    # reads
    def test_latest(self):
        self.assertEqual(self.client.get("/api/sim-state/latest").status_code, 404)
        self.assertEqual(self.client.get("/api/sim-state/latest").json()["error"], "no_simulation")
        run_id = self.publish()
        body = self.client.get("/api/sim-state/latest").json()
        self.assertEqual((body["run"]["run_id"], body["run"]["zone_count"], body["run"]["home_count"]), (run_id, 2, 4))
        self.assertIsNone(body["minute"])
        self.assertEqual(body["evidence_class"], "simulated")
        self.tick(run_id, 47, [tick_zone("z1", "leave_now", 1, 2)])
        response = self.client.get("/api/sim-state/latest")
        body = response.json()
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(body["minute"], 47)
        self.assertTrue(body["updated_at"].endswith("Z"))
        z1 = body["zones"][0]
        self.assertEqual((z1["advice"], z1["departed"], z1["at_home"], z1["exit_id"]), ("leave_now", 1, 2, "exit-a"))

    def test_advice_by_location(self):
        run_id = self.publish()
        self.tick(run_id, 5, [tick_zone("z1", "leave_now", 0, 3)])
        body = self.client.get("/api/sim-state/advice?lon=-121.61001&lat=39.76001").json()
        self.assertEqual(body["home"]["home_id"], "h0")
        self.assertLess(body["home"]["distance_m"], 10)
        self.assertEqual(body["home"]["zone_name"], "Zone 1")
        self.assertEqual(body["advice"], "leave_now")
        far = self.client.get("/api/sim-state/advice?lon=-121.0&lat=39.0")
        self.assertEqual((far.status_code, far.json()["error"]), (404, "no_home_nearby"))

    def test_advice_errors(self):
        self.assertEqual(self.client.get("/api/sim-state/advice?home_id=h0").json()["error"], "no_simulation")
        self.publish()
        for query in ("", "lon=1", "lon=a&lat=1", "lon=200&lat=1", "lon=nan&lat=1", "home_id=h0&lon=1&lat=1", "home_id="):
            response = self.client.get(f"/api/sim-state/advice?{query}")
            self.assertEqual((response.status_code, response.json()["error"]), (400, "invalid_query"), query)
        response = self.client.get("/api/sim-state/advice?home_id=nope")
        self.assertEqual((response.status_code, response.json()["error"]), (404, "unknown_home"))

    def test_homes_search(self):
        self.publish()
        body = self.client.get("/api/sim-state/homes?q=PENTZ&limit=2").json()
        self.assertEqual([h["home_id"] for h in body["homes"]], ["h0", "h1"])
        self.assertEqual(body["homes"][0]["advice"], "unknown")
        self.assertEqual(body["evidence_class"], "simulated")
        self.assertEqual(self.client.get("/api/sim-state/homes?q=sky.").json()["homes"], [])
        for query in ("q=a", "", "q=pentz&limit=0", "q=pentz&limit=51", "q=pentz&limit=x"):
            self.assertEqual(self.client.get(f"/api/sim-state/homes?{query}").status_code, 400, query)

    def test_database_failure_is_503_without_details(self):
        with patch("api.sim_state.get_database", side_effect=ConnectionFailure("secret host")):
            for response in (self.client.get("/api/sim-state/latest"), self.post("runs", run_body())):
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.json()["error"], "database_unavailable")
                self.assertNotIn("secret", response.content.decode())
