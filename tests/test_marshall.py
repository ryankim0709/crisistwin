"""Focused tests for the Marshall Fire (2021) acquisition and normalization tools."""

from __future__ import annotations

import json
import struct
import unittest
from pathlib import Path

from tools import marshall_build as mb
from tools import marshall_extract as mx


ROOT = Path(__file__).resolve().parents[1]
PACKAGES = ROOT / "data" / "incidents" / mb.INCIDENT_ID


class EventTableTests(unittest.TestCase):
    def setUp(self) -> None:
        self.table = json.loads((ROOT / "tools" / "marshall_events_table.json").read_bytes())
        self.events = mb.normalize_events(self.table)

    def test_everbridge_rows_become_issue_and_send_events(self) -> None:
        sent = [e for e in self.events if e["type"] == "alert_sent"]
        issued = [e for e in self.events if e["source_id"] == "boco-everbridge-2022-01-06" and e["type"] != "alert_sent"]
        self.assertEqual(len(sent), 9)
        self.assertEqual(len(issued), 9)
        self.assertEqual(sum(e["count_contacts"] for e in sent), 24289)
        first = next(e for e in sent if e["event_id"] == "boco-everbridge:01:sent")
        self.assertEqual(first["occurred_at"], "2021-12-30T18:47:52Z")  # 11:47:52 MST
        self.assertEqual(first["target"]["zone_ids"], ["boco-everbridge-2021-marshall-1"])
        self.assertEqual(first["evidence_class"], "observed")

    def test_events_sorted_with_bounded_quotes_and_known_classes(self) -> None:
        keys = [(e["occurred_at"], e["event_id"]) for e in self.events]
        self.assertEqual(keys, sorted(keys))
        for event in self.events:
            self.assertIn(event["evidence_class"], ("observed", "reported"))
            if event["quote"]:
                self.assertLessEqual(len(event["quote"].split()), 25)
            self.assertTrue(event["occurred_at"].endswith("Z"))

    def test_untimed_and_bound_rows_are_not_presented_as_instants(self) -> None:
        day = [e for e in self.events if e["time_precision"] == "day"]
        self.assertTrue(day)
        for event in day:
            self.assertEqual(event["occurred_from"], "2021-12-30T07:00:00Z")
            self.assertEqual(event["occurred_to"], "2021-12-31T07:00:00Z")
        ignition = next(e for e in self.events if e["type"] == "fire_ignition")
        self.assertIsNone(ignition["occurred_from"])
        self.assertEqual(ignition["occurred_to"], "2021-12-30T18:05:00Z")

    def test_zone_ids_referenced_by_events_exist(self) -> None:
        zones = {f["id"] for f in mb.normalize_zones(self.table)["features"]}
        referenced = {z for e in self.events for z in e["target"].get("zone_ids", [])}
        self.assertLessEqual(referenced, zones)


class TrafficTests(unittest.TestCase):
    def test_hourly_counts_parse_thousands_and_local_hours(self) -> None:
        stations = json.dumps([{"stationId": "000004", "route": "036B", "begRef": 43.198, "endRef": 45.3,
                                "desc": "ON SH 36", "city": "Superior", "county": "Boulder",
                                "continuous": True}]).encode()
        row = {"dir": "P", "continuous": True, **{f"h{h}": "0" for h in range(24)}}
        row["h13"] = "1,254"
        files = {"raw/cdot-otis/stations-013.json": stations,
                 "raw/cdot-otis/daily/000004-2021-12-30.json": json.dumps([row]).encode(),
                 "raw/cdot-otis/daily/000004-2021-12-29.json": b"[]"}
        _, observations = mb.normalize_traffic(files, {"cdot_stations": {"000004": "test"}})
        hour13 = next(o for o in observations if o.get("interval_start_local", "").startswith("2021-12-30T13"))
        self.assertEqual(hour13["flow_veh"], 1254)
        self.assertEqual(hour13["interval_start"], "2021-12-30T20:00:00Z")
        self.assertTrue(any(o.get("status") == "missing" for o in observations))


class ExtractTests(unittest.TestCase):
    def test_bbox_intersection_and_orientation(self) -> None:
        clockwise = [(-105.2, 39.95), (-105.2, 39.96), (-105.1, 39.96), (-105.1, 39.95), (-105.2, 39.95)]
        self.assertTrue(mx.polygon_intersects_bbox([clockwise]))
        far = [(x - 5, y) for x, y in clockwise]
        self.assertFalse(mx.polygon_intersects_bbox([far]))
        geometry = mx.rings_to_geometry([clockwise])
        self.assertGreater(mx.ring_area([tuple(c) for c in geometry["coordinates"][0]]), 0)

    def test_dbf_reader(self) -> None:
        header = struct.pack("<BBBBIHH20x", 3, 21, 1, 1, 1, 32 + 32 + 1, 1 + 4)
        field = b"GEOID".ljust(11, b"\0") + b"C" + b"\0" * 4 + bytes([4, 0]) + b"\0" * 14
        record = b" " + b"0801"
        rows = mx.read_dbf(header + field + b"\r" + record + b"\x1a")
        self.assertEqual(rows, [{"GEOID": "0801"}])

    def test_firms_subset_filters_bbox_and_date(self) -> None:
        import tempfile
        lines = ("latitude,longitude,acq_date,acq_time\n"
                 "39.95,-105.2,2021-12-30,2013\n"
                 "39.95,-105.2,2021-12-20,2013\n"
                 "38.0,-105.2,2021-12-30,2013\n")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "f.csv"
            path.write_text(lines)
            self.assertEqual(mx.extract_firms(path).decode().count("\n"), 2)


class GeometryTests(unittest.TestCase):
    def test_lambert_round_trip_colorado_north(self) -> None:
        from tools.marshall_geopdf import LambertConic, US_FOOT_M
        projection = LambertConic(39.71666666666667, 40.78333333333333, 39.33333333333334, -105.5,
                                  3000000.000316083 * US_FOOT_M, 999999.999996 * US_FOOT_M)
        x, y = projection.forward(-105.2, 39.95)
        lon, lat = projection.inverse(x, y)
        self.assertAlmostEqual(lon, -105.2, places=8)
        self.assertAlmostEqual(lat, 39.95, places=8)

    def test_scanline_crosswalk_shares(self) -> None:
        square = {"type": "Polygon", "coordinates": [[[-105.2, 39.95], [-105.19, 39.95], [-105.19, 39.96],
                                                      [-105.2, 39.96], [-105.2, 39.95]]]}
        left_half = {"type": "Polygon", "coordinates": [[[-105.2, 39.94], [-105.195, 39.94], [-105.195, 39.97],
                                                         [-105.2, 39.97], [-105.2, 39.94]]]}
        zones = {"features": [{"id": "z", "geometry": left_half}]}
        population = {"features": [{"id": "g", "geometry": square,
                                    "properties": {"population": 100, "households": 40}}]}
        unit = mb.normalize_crosswalk(zones, population)["zones"][0]["units"][0]
        self.assertAlmostEqual(unit["share_of_unit_area"], 0.5, delta=0.01)
        self.assertAlmostEqual(unit["population_weighted"], 50, delta=1)


@unittest.skipUnless(PACKAGES.exists() and any(PACKAGES.iterdir()), "no Marshall package built")
class PackageTests(unittest.TestCase):
    def test_latest_package_verifies_offline(self) -> None:
        for package in sorted(p for p in PACKAGES.iterdir() if p.is_dir()):
            result = mb.verify(package)
            self.assertEqual(result["package_version"], package.name)
            self.assertGreater(result["roads"]["directed_edge_count"], 0)


if __name__ == "__main__":
    unittest.main()
