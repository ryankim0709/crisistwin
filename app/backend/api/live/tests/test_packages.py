"""Studio drill packages: ``livecore.package`` and ``/api/live/packages`` (ADR 0037).

No network: the dispatch area is a small fixture and ``dispatch_area.get_area_gzip`` is patched.
No MongoDB access (controller auth by token compare). Run with e.g.
``MONGODB_URI=mongodb://localhost:27017 MONGODB_DATABASE=crisistwin_pkg_test``.
"""

from __future__ import annotations

import copy
import gzip
import json
import math
import tempfile
from datetime import timedelta
from pathlib import Path
from unittest import mock

from django.test import SimpleTestCase, override_settings

from api import dispatch_area
from api.live import drillcache, packages
from api.live.common import ApiError
from livecore.fire import estimate_fire
from livecore.geo import point_in_multipolygon
from livecore.package import (
    PackageError,
    area_box,
    build_package,
    in_california,
    lonlat_to_mercator,
    mercator_to_lonlat,
    package_summary,
    parse_run,
)
from livecore.package import load_package as load_package_drill

IGNITION = (-122.60, 38.50)
"""Near Santa Rosa, California. ``(lon, lat)``."""
CELL_M = 100.0
"""Mercator metres per fixture cell."""
N = 41
RATE_M_PER_MIN = 20.0
"""Fixture fire: a circle growing at this rate in Mercator metres, ignited at T+0."""
CONTROLLER = "pkg-controller"


def fixture_run(ignition=IGNITION, horizon=60) -> dict:
    """A small Studio run export: 41 x 41 cells of 100 Mercator m, circular fire."""
    cx, cy = lonlat_to_mercator(*ignition)
    origin_x = cx - (N // 2) * CELL_M
    origin_y = cy + (N // 2) * CELL_M
    arrival = []
    for row in range(N):
        for col in range(N):
            d = math.hypot((col - N // 2) * CELL_M, (row - N // 2) * CELL_M)
            minute = d / RATE_M_PER_MIN
            arrival.append(round(minute * 60) if minute <= horizon else None)
    frames = []
    for minute in range(0, horizon + 1, 15):
        if minute == 0:
            frames.append({"minute": 0, "geometry": None, "area_m2": 0})
            continue
        radius = minute * RATE_M_PER_MIN
        ring = [
            list(mercator_to_lonlat(cx + radius * math.cos(a / 16 * 2 * math.pi),
                                    cy + radius * math.sin(a / 16 * 2 * math.pi)))
            for a in range(16)
        ]
        ring.append(ring[0])
        frames.append({"minute": minute, "geometry": {"type": "Polygon", "coordinates": [ring]},
                       "area_m2": math.pi * radius**2 * math.cos(math.radians(ignition[1])) ** 2})
    return {
        "kind": "crisistwin_studio_run",
        "schema_version": 1,
        "scenario": {"id": "scn-1", "name": "Fixture fire"},
        "region_id": None,
        "ignition_time": "2026-10-24T20:00:00Z",
        "ignitions": [{"id": "ig-1", "name": "F1", "coord": list(ignition), "start_minute": 0}],
        "assumptions": {
            "wind_20ft_mph": 20, "wind_from_deg": 45,
            "moisture": {"dead1h": 0.03, "dead10h": 0.04, "dead100h": 0.05, "liveHerb": 0.3, "liveWoody": 0.6},
            "midflame_adjustment": 0.4, "horizon_min": horizon, "spotting": None, "structure_spread": None,
        },
        "model": {"id": "rothermel-1972-mtt", "version": "4.1.0"},
        "landscape": {"cell_m": 30, "resampling": "native", "elevation_complete": True},
        "arrival_grid": {
            "crs": "EPSG:3857", "order": "row_major_north_first", "origin_x": origin_x, "origin_y": origin_y,
            "cell_x": CELL_M, "cell_y": -CELL_M, "ground_cell_m": CELL_M * math.cos(math.radians(ignition[1])),
            "ncols": N, "nrows": N, "arrival_s": arrival,
        },
        "frames": frames,
    }


def fixture_area(box=(-122.66, 38.45, -122.54, 38.55)) -> dict:
    """A 3 x 3 road grid with two exits, two zones (one degenerate) and one station."""
    w, s, e, n = box
    xs = [w + (e - w) * k / 4 for k in (1, 2, 3)]
    ys = [s + (n - s) * k / 4 for k in (1, 2, 3)]
    nodes = [[round(x, 6), round(y, 6)] for y in ys for x in xs]
    edges = []

    def add(a, b, cls=2, kph=48.0, cap=1000, oneway=0):
        length = math.hypot((nodes[a][0] - nodes[b][0]) * 87_000, (nodes[a][1] - nodes[b][1]) * 111_000)
        edges.append([a, b, round(length, 1), cls, kph, cap, oneway, 0, [], 0])

    for r in range(3):
        for c in range(2):
            add(r * 3 + c, r * 3 + c + 1, cls=11, kph=32.0, cap=600)
    for c in range(3):
        for r in range(2):
            add(r * 3 + c, (r + 1) * 3 + c)
    add(4, 0, cls=0, kph=100.0, cap=3800, oneway=1)
    return {
        "kind": "crisistwin_dispatch_area", "schemaVersion": 2, "id": "osm-fixture", "name": "Fixture area",
        "bbox": list(box), "generatedAt": "2026-10-24T00:00:00Z", "builder": "dispatch-area/3",
        "sources": {"osm": {"timestamp": None, "attribution": "fixture"}},
        "assumptions": {
            "homesPerKm": 50, "homesPerKmApplied": 50, "vehiclesPerHome": 1.6,
            "capacityPerLaneVph": {"motorway": 1900, "secondary": 1000, "other": 600},
            "notes": ["Homes are synthetic (fixture)."],
        },
        "classes": list(dispatch_area.ROAD_CLASSES),
        "names": ["Fixture Rd"],
        "nodes": nodes,
        "edges": edges,
        "zones": [
            {"id": "Z01", "name": "Z01 · near Fixture", "node": 4, "homes": 120, "vehicles": 192,
             "centroid": nodes[4], "polygon": [nodes[0], nodes[2], nodes[8], nodes[6]]},
            {"id": "Z02", "name": "Z02 · near Fixture", "node": 1, "homes": 2, "vehicles": 3,
             "centroid": nodes[1], "polygon": [nodes[1], nodes[2]]},
        ],
        "homes": [],
        "exits": [{"id": "X01", "name": "Fixture Rd (west)", "node": 3, "road": "Fixture Rd", "side": "west"},
                  {"id": "X02", "name": "Fixture Rd (east)", "node": 5, "road": "Fixture Rd", "side": "east"}],
        "stations": [{"id": "S01", "name": "Station 1", "node": 7, "location": nodes[7], "approachMeters": 20,
                      "units": [{"id": "E01", "type": "engine"}]}],
    }


class PackageBuildTests(SimpleTestCase):
    def test_round_trip_loads_as_a_drill(self):
        run = fixture_run()
        package = build_package(run, fixture_area())
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "pkg.json"
            path.write_text(json.dumps(package), encoding="utf-8")
            drill = load_package_drill(path)
            index = drillcache._build(drill)
            self.assertEqual(drillcache._response_record(drill, path), ())
        self.assertEqual(len(index.command_zones_json), 2)
        self.assertIsNotNone(drillcache.snap_to_segment(index, tuple(package["roads"]["edges"][0]["coords"][0])))

        self.assertTrue(drill.incident_id.startswith("studio-"))
        self.assertIn("Not a real incident", drill.label)
        self.assertNotIn("Camp", drill.label)
        # Zones: synthetic, counts kept, degenerate hull became a square.
        self.assertEqual([z.id for z in drill.zones], ["Z01", "Z02"])
        self.assertEqual((drill.zones[0].households, drill.zones[0].vehicles), (120, 192))
        self.assertEqual(len(drill.zones[1].geometry[0][0]), 5)
        self.assertTrue(all(f["synthetic"] for f in package["zones"]["features"]))
        # Roads: 12 two-way rows -> 24 edges, 1 one-way motorway -> 1 edge; 13 segments.
        self.assertEqual(len(drill.roads.edges), 25)
        self.assertEqual(len(drill.roads.segment_edges), 13)
        fwd, rev = drill.roads.edges["e0f"], drill.roads.edges["e0r"]
        self.assertEqual(fwd.coords, rev.coords[::-1])
        self.assertEqual(fwd.segment_id, rev.segment_id)
        self.assertEqual(drill.roads.edges["e12f"].lanes, 2)  # 3800 vph / 1900 per lane
        # Destinations are the exits; stations are their own layer.
        self.assertEqual([d.kind for d in drill.destinations], ["exit", "exit"])
        self.assertEqual(package["stations"]["features"][0]["id"], "S01")
        # Fire: simulated fronts only, ascending, inside the clock; no observed data.
        self.assertEqual(drill.perimeters, ())
        self.assertEqual(drill.observations, ())
        self.assertEqual(len(drill.fronts), 4)  # minute 0 is empty
        self.assertEqual([f.evidence_class for f in drill.fronts], ["simulated"] * 4)
        self.assertEqual(drill.fronts[0].at - drill.clock_start, timedelta(minutes=15))
        self.assertLess(drill.fronts[-1].at, drill.clock_end)
        self.assertEqual(drill.fire_model, "rothermel-1972-mtt")
        self.assertEqual(package["events"], [])
        est = estimate_fire(drill, drill.clock_start + timedelta(minutes=40))
        self.assertEqual(est.method, "model_nowcast")
        self.assertTrue(point_in_multipolygon(IGNITION, est.geometry))
        self.assertEqual(estimate_fire(drill, drill.clock_start).method, "none")
        # Labels.
        text = " ".join(package["assumptions"])
        self.assertIn("Assumed wind: 20 mph", text)
        self.assertIn("from 45 deg", text)
        self.assertIn("synthetic", text.lower())
        self.assertTrue(any("Simulated fire" in s for s in package["limitations"]))

    def test_arrival_grid_is_resampled_to_bundle_shape(self):
        grid = build_package(fixture_run(), fixture_area())["fire_simulated"]["arrival_grid"]
        self.assertEqual(len(grid["minutes"]), grid["ncols"] * grid["nrows"])
        self.assertGreaterEqual(grid["cell_m"], 100)
        lon, lat = IGNITION
        col = math.floor((lon - grid["origin_lon"]) * grid["m_per_deg_lon"] / grid["cell_m"])
        row = math.floor((lat - grid["origin_lat"]) * grid["m_per_deg_lat"] / grid["cell_m"])
        self.assertLessEqual(grid["minutes"][row * grid["ncols"] + col], 5)

    def test_summary_and_deterministic_id(self):
        a = build_package(fixture_run(), fixture_area())
        b = build_package(fixture_run(), fixture_area())
        self.assertEqual(a["drill_package"]["package_id"], b["drill_package"]["package_id"])
        summary = package_summary(a)
        self.assertEqual((summary["zones"], summary["homes"], summary["exits"], summary["stations"]), (2, 122, 2, 1))
        self.assertEqual(summary["homes_label"], "synthetic")

    def test_california_check(self):
        self.assertTrue(in_california(-121.6, 39.76))  # Paradise
        self.assertTrue(in_california(-116.5, 33.8))  # Palm Springs
        self.assertFalse(in_california(-119.8, 39.5))  # Reno, NV
        self.assertFalse(in_california(-114.0, 36.0))  # Lake Mead, NV/AZ
        self.assertFalse(in_california(-123.0, 44.0))  # Oregon
        with self.assertRaises(PackageError) as ctx:
            area_box(parse_run(fixture_run(ignition=(-119.80, 39.53))))
        self.assertEqual(ctx.exception.code, "outside_california")

    def test_area_box_contains_fire_and_fits_dispatch_limits(self):
        box = area_box(parse_run(fixture_run())).bbox
        self.assertTrue(box[0] < IGNITION[0] < box[2] and box[1] < IGNITION[1] < box[3])
        self.assertIsNotNone(dispatch_area.parse_bbox(",".join(map(str, box))))

    def test_strict_validation(self):
        cases = {
            "kind": lambda r: r.update(kind="other"),
            "crs": lambda r: r["arrival_grid"].update(crs="EPSG:4326"),
            "length": lambda r: r["arrival_grid"]["arrival_s"].pop(),
            "negative": lambda r: r["arrival_grid"]["arrival_s"].__setitem__(0, -5),
            "after horizon": lambda r: r["arrival_grid"]["arrival_s"].__setitem__(0, 99_999),
            "wind": lambda r: r["assumptions"].update(wind_20ft_mph=500),
            "moisture": lambda r: r["assumptions"]["moisture"].pop("dead1h"),
            "horizon": lambda r: r["assumptions"].update(horizon_min=61),
            "time": lambda r: r.update(ignition_time="2026-10-24T20:00:00"),
            "order": lambda r: r["frames"].reverse(),
            "swapped coords": lambda r: r["frames"][1]["geometry"]["coordinates"][0].__setitem__(
                0, [38.5, -122.6]),
            "ignition off grid": lambda r: r["ignitions"][0].update(coord=[-121.0, 38.5]),
            "no fire": lambda r: [f.update(geometry=None) for f in r["frames"]],
        }
        for name, mutate in cases.items():
            run = copy.deepcopy(fixture_run())
            mutate(run)
            with self.subTest(name), self.assertRaises(PackageError):
                parse_run(run)

    def test_bad_area_is_rejected(self):
        area = fixture_area()
        area["edges"][0][0] = 999
        with self.assertRaises(PackageError):
            build_package(fixture_run(), area)
        area = fixture_area()
        area["exits"] = []
        with self.assertRaises(PackageError) as ctx:
            build_package(fixture_run(), area)
        self.assertEqual(ctx.exception.code, "no_exits")


@override_settings(LIVE_CONTROLLER_TOKEN=CONTROLLER)
class PackageApiTests(SimpleTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        override = override_settings(LIVE_PACKAGES_DIR=self.tmp.name)
        override.enable()
        self.addCleanup(override.disable)
        gz = gzip.compress(json.dumps(fixture_area()).encode())
        patcher = mock.patch.object(dispatch_area, "get_area_gzip", return_value=gz)
        self.get_area = patcher.start()
        self.addCleanup(patcher.stop)

    def post(self, body, token=CONTROLLER):
        headers = {"HTTP_AUTHORIZATION": f"Bearer {token}"} if token else {}
        return self.client.post("/api/live/packages", data=json.dumps(body), content_type="application/json",
                                 **headers)

    def test_create_list_and_activate_preview(self):
        res = self.post(fixture_run())
        self.assertEqual(res.status_code, 201, res.content)
        body = res.json()
        self.assertRegex(body["package_id"], r"^pkg_[0-9a-f]{12}$")
        self.assertTrue(body["incident_id"].startswith("studio-"))
        self.assertEqual(body["summary"]["zones"], 2)
        self.assertEqual(body["summary"]["homes"], 122)
        self.assertTrue((Path(self.tmp.name) / f"{body['package_id']}.json").exists())
        box = self.get_area.call_args.args[0]
        self.assertTrue(box[0] < IGNITION[0] < box[2])

        again = self.post(fixture_run())
        self.assertEqual(again.status_code, 200)
        self.assertEqual(again.json()["package_id"], body["package_id"])

        listed = self.client.get("/api/live/packages", HTTP_AUTHORIZATION=f"Bearer {CONTROLLER}").json()
        self.assertEqual([p["package_id"] for p in listed["packages"]], [body["package_id"]])

        preview = packages.activate(body["package_id"])
        self.assertFalse(preview["applied"])
        self.assertEqual(preview["would_change"]["incident_id"]["to"], body["incident_id"])

    def test_errors(self):
        self.assertEqual(self.post(fixture_run(), token="wrong").status_code, 401)
        bad = fixture_run()
        bad["kind"] = "nope"
        res = self.post(bad)
        self.assertEqual((res.status_code, res.json()["error"]), (400, "invalid_run"))
        res = self.post(fixture_run(ignition=(-119.80, 39.53)))
        self.assertEqual((res.status_code, res.json()["error"]), (422, "outside_california"))
        self.get_area.side_effect = dispatch_area.UpstreamUnavailable
        self.assertEqual(self.post(fixture_run()).status_code, 502)
        res = self.client.post("/api/live/packages", data="{", content_type="application/json",
                               HTTP_AUTHORIZATION=f"Bearer {CONTROLLER}")
        self.assertEqual(res.status_code, 400)
        with self.assertRaises(ApiError):
            packages.activate("pkg_000000000000")

    def test_body_over_django_upload_limit_is_accepted(self):
        run = fixture_run()
        run["scenario"]["name"] = "Big fixture"
        run["landscape"]["padding"] = "x" * 3_000_000  # over DATA_UPLOAD_MAX_MEMORY_SIZE (2.5 MB)
        self.assertEqual(self.post(run).status_code, 201)
