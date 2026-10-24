"""build_area with a fixed, synthetic Overpass answer (no network)."""

import json
from unittest import mock

from django.test import SimpleTestCase

from api import dispatch_area

BOX = (-122.01, 37.00, -122.00, 37.01)

NODES = {
    100: (-122.0150, 37.005),  # outside, west
    1: (-122.0090, 37.005),
    2: (-122.0050, 37.005),
    3: (-122.0010, 37.005),
    101: (-121.9950, 37.005),  # outside, east
    5: (-122.0050, 37.0065),
    6: (-122.0050, 37.008),
    7: (-122.0050, 37.003),
    8: (-122.0050, 37.001),
    102: (-122.0050, 36.995),  # outside, south
    9: (-122.0040, 37.0085),
    20: (-122.0080, 37.002),  # detached track
    21: (-122.0070, 37.002),
    30: (-122.0030, 37.0095),  # driveway
}


def _way(way_id, nodes, **tags):
    return {"type": "way", "id": way_id, "nodes": nodes, "tags": tags}


PUBLIC_WAYS = [
    _way(1, [100, 1, 2, 3, 101], highway="secondary", name="Main Rd", lanes="2"),
    _way(2, [2, 5, 6], highway="residential", name="Oak Ln"),
]
ACCESS_WAYS = [
    _way(3, [2, 7, 8, 102], highway="track", tracktype="grade2", surface="gravel", name="Ridge Track"),
    _way(4, [6, 9], highway="service", service="alley", maxweight="5"),
    _way(5, [20, 21], highway="track", tracktype="grade4"),
    _way(6, [6, 30], highway="service", service="driveway"),
]
STATION = {
    "type": "node", "id": 900, "lon": NODES[8][0], "lat": NODES[8][1],
    "tags": {"amenity": "fire_station", "name": "Ridge Station"},
}
TURNING = {
    "type": "node", "id": 9, "lon": NODES[9][0], "lat": NODES[9][1], "tags": {"highway": "turning_circle"},
}


def overpass_answer(ways):
    elements = list(ways)
    elements += [{"type": "node", "id": i, "lon": lon, "lat": lat} for i, (lon, lat) in NODES.items()]
    elements += [STATION, TURNING]
    return {"elements": elements, "osm3s": {"timestamp_osm_base": "2026-10-24T00:00:00Z"}}


def build(ways):
    with mock.patch.object(dispatch_area, "overpass", return_value=overpass_answer(ways)) as patched:
        area = dispatch_area.build_area(BOX)
    return area, patched.call_args.args[0]


class AccessOnlyEdgeTests(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.area, cls.query = build(PUBLIC_WAYS + ACCESS_WAYS)
        cls.public_only, _ = build(PUBLIC_WAYS)

    def test_query_asks_for_tracks_services_and_turning_nodes(self):
        self.assertIn("highway=track", self.query)
        self.assertIn("highway=service", self.query)
        self.assertIn("driveway|parking_aisle|drive-through", self.query)
        self.assertIn("turning_circle|turning_loop", self.query)

    def test_schema_and_classes_are_additive(self):
        area = self.area
        self.assertEqual(area["schemaVersion"], 2)
        self.assertEqual(area["builder"], "dispatch-area/4")
        self.assertEqual(area["classes"][: len(dispatch_area.ROAD_CLASSES)], list(dispatch_area.ROAD_CLASSES))
        self.assertEqual(area["classes"][-2:], ["service", "track"])
        self.assertEqual(area["assumptions"]["speedDefaultKph"]["service"], 25)
        self.assertEqual(area["assumptions"]["speedDefaultKph"]["track"], 15)

    def test_access_edges_are_kept_after_public_edges(self):
        area = self.area
        flags = [row[11] for row in area["edges"]]
        self.assertEqual(flags, sorted(flags))
        access = [row for row in area["edges"] if row[11] == 1]
        self.assertEqual(len(access), 2)  # track 2-8 and alley 6-9; detached track and driveway dropped
        by_class = {area["classes"][row[3]]: row for row in access}
        self.assertEqual(sorted(by_class), ["service", "track"])
        self.assertEqual(by_class["track"][4], 15)
        self.assertEqual(by_class["service"][4], 25)
        for row in access:
            self.assertEqual(row[5], dispatch_area.DEFAULT_CAPACITY_PER_LANE_VPH)
            self.assertEqual(len(row), 12)
        self.assertEqual(area["names"][by_class["track"][7]], "Ridge Track")
        self.assertEqual(area["edges"][0][11], 0)

    def test_detached_track_and_driveway_are_dropped(self):
        coords = {tuple(n) for n in self.area["nodes"]}
        self.assertNotIn(tuple(round(c, 6) for c in NODES[20]), coords)
        self.assertNotIn(tuple(round(c, 6) for c in NODES[30]), coords)

    def test_public_graph_is_unchanged_by_access_edges(self):
        area, base = self.area, self.public_only
        n_public = len(base["nodes"])
        self.assertEqual(area["nodes"][:n_public], base["nodes"])
        self.assertGreater(len(area["nodes"]), n_public)
        with_access = [r for r in area["edges"] if r[11] == 0]
        without = [r[:10] for r in base["edges"]]
        self.assertEqual([r[:10] for r in with_access], without)
        for key in ("zones", "homes", "exits"):
            self.assertEqual(area[key], base[key])
        self.assertEqual(
            [(s["node"], s["approachMeters"]) for s in area["stations"]],
            [(s["node"], s["approachMeters"]) for s in base["stations"]],
        )

    def test_zones_exits_and_stations_use_public_nodes_only(self):
        area = self.area
        public_nodes = {i for r in area["edges"] if r[11] == 0 for i in (r[0], r[1])}
        for zone in area["zones"]:
            self.assertIn(zone["node"], public_nodes)
        for item in area["exits"]:
            self.assertIn(item["node"], public_nodes)
        station = area["stations"][0]
        self.assertIn(station["node"], public_nodes)
        # The station stands on the track's node, so snapping to a public node is far.
        self.assertGreater(station["approachMeters"], 100)

    def test_tag_sets_are_deduplicated_and_indexed(self):
        area = self.area
        sets = area["tagSets"]
        self.assertEqual(len({json.dumps(t, sort_keys=True) for t in sets}), len(sets))
        for row in area["edges"]:
            tags = sets[row[10]]
            self.assertEqual(tags["highway"], area["classes"][row[3]])
            self.assertEqual(set(tags) - set(dispatch_area.TAG_KEYS), set())
        track = next(r for r in area["edges"] if area["classes"][r[3]] == "track")
        self.assertEqual(sets[track[10]], {"highway": "track", "surface": "gravel", "tracktype": "grade2"})
        alley = next(r for r in area["edges"] if area["classes"][r[3]] == "service")
        self.assertEqual(sets[alley[10]]["maxweight"], "5")
        self.assertEqual({r[10] for r in area["edges"]}, set(range(len(sets))))

    def test_identical_tags_share_one_tag_set(self):
        ways = [
            _way(1, [100, 1, 2, 3, 101], highway="secondary", name="Main Rd"),
            _way(2, [2, 5, 6], highway="residential"),
            _way(7, [6, 7], highway="residential"),
        ]
        area, _ = build(ways)
        residential = [r for r in area["edges"] if area["classes"][r[3]] == "residential"]
        self.assertEqual(len(residential), 2)
        self.assertEqual(residential[0][10], residential[1][10])

    def test_turning_and_boundary_nodes(self):
        area = self.area
        index = {tuple(n): i for i, n in enumerate(area["nodes"])}

        def at(ref):
            return index[tuple(round(c, 6) for c in NODES[ref])]

        self.assertEqual(area["turningNodes"], [at(9)])
        self.assertEqual(area["boundaryNodes"], sorted([at(1), at(3), at(8)]))
        # Track node 8 is a boundary node but never an exit (access-only roads cannot be exits).
        self.assertNotIn(at(8), [x["node"] for x in area["exits"]])

    def test_without_access_ways_the_new_tables_are_still_present(self):
        base = self.public_only
        self.assertEqual(base["turningNodes"], [])
        self.assertEqual(len(base["boundaryNodes"]), 2)
        self.assertTrue(all(r[11] == 0 for r in base["edges"]))
