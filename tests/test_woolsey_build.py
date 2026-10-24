"""Offline tests for the Woolsey Fire package builder."""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from tools import woolsey_build as wb


ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = ROOT / "data" / "incidents" / wb.INCIDENT_ID


def tables() -> tuple[dict, dict, dict, dict]:
    return tuple(json.loads(path.read_bytes()) for path in wb.CURATED.values())  # type: ignore[return-value]


def osm(elements: list[dict]) -> bytes:
    return json.dumps({"osm3s": {"timestamp_osm_base": "2018-11-08T00:00:00Z"}, "elements": elements}).encode()


class CuratedTableTests(unittest.TestCase):
    def test_citygate_times_convert_from_pst(self) -> None:
        citygate = tables()[0]
        events = {e["event_id"]: e for e in wb.citygate_events(citygate)}
        self.assertEqual(events["woolsey-cg-se009"]["occurred_at"], "2018-11-08T22:24:00Z")
        self.assertEqual(events["woolsey-cg-se046"]["occurred_at"], "2018-11-09T09:20:00Z")
        self.assertEqual(events["woolsey-cg-se088"]["type"], "contraflow_started")
        approx = events["woolsey-cg-se056a"]
        self.assertEqual((approx["time_precision"], approx["occurred_from"]), ("approximate", None))
        day = events["woolsey-cg-shelter-taft"]
        self.assertEqual((day["occurred_from"], day["occurred_to"]), ("2018-11-08T08:00:00Z", "2018-11-09T08:00:00Z"))
        untimed = events["woolsey-cg-se124"]
        self.assertEqual((untimed["occurred_from"], untimed["occurred_to"]), ("2018-11-11T19:40:00Z", "2018-11-11T22:20:00Z"))
        self.assertEqual(events["woolsey-cg-se050"]["available_at"], "2018-11-09T09:46:00Z")
        self.assertIsNone(events["woolsey-cg-se053"]["available_at"])

    def test_quotes_are_short_and_ids_unique(self) -> None:
        citygate, bulletins, shelters, facts = tables()
        events = wb.citygate_events(citygate) + wb.bulletin_events(bulletins) + wb.facts_events(facts)
        ids = [e["event_id"] for e in events]
        self.assertEqual(len(ids), len(set(ids)))
        for event in events:
            if event["quote"] is not None:
                self.assertLessEqual(len(event["quote"].split()), 25, event["event_id"])
            self.assertIn(event["evidence_class"], ("observed", "reported", "reconstructed", "derived"))

    def test_bulletin_reopening_is_announced_not_observed(self) -> None:
        events = {e["event_id"]: e for e in wb.bulletin_events(tables()[1])}
        nb = events["woolsey-b1112pm-reopen-101-nb"]
        self.assertEqual(nb["occurred_at"], "2018-11-13T05:00:00Z")
        self.assertIn("announced time", nb["time_role"])
        closure = events["woolsey-b1110pm-road-101"]
        self.assertEqual(closure["occurred_at"], "2018-11-11T03:00:00Z")
        self.assertIn("onset unknown", closure["time_role"])

    def test_calibration_targets_cite_sources(self) -> None:
        facts = tables()[3]
        for target in facts["calibration_targets"]:
            self.assertIn(target["source_id"], facts["sources"])
            self.assertTrue(target["source_locator"])


class RoadTests(unittest.TestCase):
    def test_tiles_merge_and_two_way_roads_split(self) -> None:
        nodes = [{"type": "node", "id": i, "lon": lon, "lat": 34.1} for i, lon in ((1, -118.9), (2, -118.8), (3, -119.10))]
        way = {"type": "way", "id": 10, "nodes": [3, 1, 2], "tags": {"highway": "motorway", "ref": "US 101", "oneway": "no"}}
        nodes_out, edges, exits, quality = wb.normalize_roads([osm(nodes + [way]), osm(nodes[:2] + [way])])
        self.assertEqual(quality["selected_way_count"], 1)
        self.assertEqual(len(edges["features"]), 2)
        self.assertEqual(quality["largest_strongly_connected_component_nodes"], 2)
        self.assertEqual(exits["exits"][0]["destination_name"], "US 101 toward Camarillo / Oxnard")

    def test_conflicting_tile_node_is_rejected(self) -> None:
        a = [{"type": "node", "id": 1, "lon": -118.9, "lat": 34.1}]
        b = [{"type": "node", "id": 1, "lon": -118.8, "lat": 34.1}]
        with self.assertRaises(wb.SourceError):
            wb.merge_osm([osm(a), osm(b)])

    def test_query_text_is_stable(self) -> None:
        self.assertIn("(33.98,-119.05,34.14,-118.80)", wb.road_tile_query(wb.TILES[0]))
        self.assertIn('[date:"2018-11-08T00:00:00Z"]', wb.road_tile_query(wb.TILES[0]))


class PopulationTests(unittest.TestCase):
    def test_vehicle_and_age_aggregation(self) -> None:
        b01001 = ["0"] * 49
        b01001[0] = "100"
        b01001[19], b01001[48] = "3", "4"
        b25044 = ["40", "30", "1", "10", "10", "5", "3", "1", "10", "2", "4", "3", "1", "0", "0"]
        acs = {"block_groups": {"060371": {"estimate": {"B01001": b01001, "B01003": ["100"], "B11001": ["40"] + ["0"] * 8,
                                                         "B25044": b25044, "B25046": ["70", "60", "10"]},
                                            "moe": {"B01001": ["1"] * 49, "B01003": ["9"], "B11001": ["5"] * 9,
                                                    "B25044": ["2"] * 15, "B25046": ["8", "1", "1"]}}}}
        tiger = {"features": [{"id": "060371", "geometry": {"type": "MultiPolygon", "coordinates": []},
                               "properties": {"COUNTYFP": "037", "ALAND": "10", "AWATER": "0"}}]}
        unit = wb.normalize_population(json.dumps(acs).encode(), json.dumps(tiger).encode())["features"][0]["properties"]
        self.assertEqual(unit["households_no_vehicle"], 3)
        self.assertEqual(unit["households_by_vehicles_available"]["1"], 14)
        self.assertEqual(unit["population_65_plus"], 7)
        self.assertEqual(unit["vehicles_available_total"], 70)

    def test_ring_orientation_helpers(self) -> None:
        clockwise = [[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]
        self.assertLess(wb.ring_area(clockwise), 0)
        self.assertTrue(wb.bbox_contains(wb.ring_bbox(clockwise), (0.2, 0.2, 0.8, 0.8)))


class PackageTests(unittest.TestCase):
    def test_committed_packages_verify_offline(self) -> None:
        packages = sorted(p for p in PACKAGE_ROOT.glob("*") if (p / "manifest.json").exists())
        if not packages:
            self.skipTest("no Woolsey package built")
        for package in packages:
            result = wb.verify(package)
            self.assertEqual(result["package_version"], package.name)
            self.assertEqual(result["layers"]["roads"], "present")


if __name__ == "__main__":
    unittest.main()
