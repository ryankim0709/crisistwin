"""Tests for the sourced firefighting resource data (tools/suppression_data.py)."""

from __future__ import annotations

import copy
import unittest

from tools import suppression_data as sd


# tools/ca_fire_bases.json is not in git (the CAL FIRE layer states no open licence); build it
# locally with `python -m tools.suppression_data --refresh-bases` to run these.
BASES_SKIP = "tools/ca_fire_bases.json not built (python -m tools.suppression_data --refresh-bases)"


class ResourcesSchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.data = sd.load_resources()

    def test_file_validates(self) -> None:
        self.assertEqual(sd.validate_resources(self.data), [])

    def test_every_leaf_is_sourced_or_flagged(self) -> None:
        sources = self.data["sources"]
        leaves = list(sd.iter_leaves(self.data))
        self.assertGreater(len(leaves), 200)
        for path, leaf in leaves:
            self.assertTrue(leaf["unit"], path)
            if leaf.get("assumption"):
                self.assertGreaterEqual(len(leaf["reason"]), 20, path)
                self.assertNotIn("source_id", leaf, path)
            else:
                self.assertIn(leaf["source_id"], sources, path)
                self.assertTrue(leaf["page"], path)

    def test_validator_catches_problems(self) -> None:
        broken = copy.deepcopy(self.data)
        broken["engines"]["typing"]["3"]["tank_min_gal"].pop("page")
        broken["engines"]["typing"]["4"]["tank_min_gal"]["source_id"] = "nope"
        broken["road_access"]["max_grade_paved_pct"]["engine_t3"].pop("reason")
        broken["stray"] = {"count": 3}
        problems = "\n".join(sd.validate_resources(broken))
        self.assertIn("engines.typing.3.tank_min_gal: sourced value without page", problems)
        self.assertIn("unknown source_id 'nope'", problems)
        self.assertIn("assumption without a reason", problems)
        self.assertIn("stray.count: number outside a leaf", problems)

    def test_sources_have_licence_and_access(self) -> None:
        for sid, src in self.data["sources"].items():
            for field in ("title", "url", "access", "licence"):
                self.assertTrue(src[field], f"{sid}.{field}")
            self.assertTrue(src["url"].startswith("https://"), sid)

    def test_unverified_sources_are_flagged(self) -> None:
        for sid in ("nfpa_1710", "calfire_web_snippet"):
            self.assertIs(self.data["sources"][sid]["verified"], False)


class UnitsAndPhysicsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.data = sd.load_resources()

    def v(self, *path: str):
        node = self.data
        for key in path:
            node = node[key]
        return node["value"]

    def test_conversions(self) -> None:
        self.assertAlmostEqual(sd.chains_per_hour_to_m_per_hour(1), 20.1168)
        self.assertAlmostEqual(sd.feet_to_m(10), 3.048)
        self.assertAlmostEqual(sd.knots_to_kmh(100), 185.2)
        self.assertAlmostEqual(sd.pounds_to_tonnes(40000), 18.1437, places=3)

    def test_engine_typing_matches_pms200(self) -> None:
        tanks = [self.v("engines", "typing", str(t), "tank_min_gal") for t in range(1, 8)]
        self.assertEqual(tanks, [300, 300, 500, 750, 400, 150, 50])
        pumps = [self.v("engines", "typing", str(t), "pump_min_flow_gpm") for t in range(1, 8)]
        self.assertEqual(pumps, [1000, 500, 150, 50, 50, 50, 10])
        crews = [self.v("engines", "typing", str(t), "personnel_min") for t in range(1, 8)]
        self.assertEqual(crews, [4, 3, 3, 2, 2, 2, 2])
        self.assertEqual(self.v("engines", "typing", "6", "max_gvwr_lb"), 19500)
        # Types 1 and 2 are structure engines and are not pump-and-roll.
        self.assertFalse(self.v("engines", "typing", "1", "pump_and_roll_required"))
        self.assertTrue(self.v("engines", "typing", "3", "pump_and_roll_required"))

    def test_tender_typing(self) -> None:
        self.assertEqual(self.v("water_tenders", "typing", "support_1", "tank_gal"), 4000)
        self.assertEqual(self.v("water_tenders", "typing", "tactical_2", "tank_gal"), 1000)
        self.assertIsNone(self.v("water_tenders", "typing", "tactical_1", "max_refill_time_min"))

    def test_helicopter_and_airtanker_typing_ordered(self) -> None:
        gal = [self.v("helicopters", "typing", f"type{i}", "water_or_retardant_gal_min") for i in (1, 2, 3)]
        self.assertEqual(gal, [700, 300, 100])
        self.assertEqual(gal, sorted(gal, reverse=True))
        for plane in self.v("airtankers", "aircraft"):
            self.assertGreater(plane["cruise_kt"], 100)
            gallons = plane["max_gal"] if isinstance(plane["max_gal"], int) else max(plane["max_gal"])
            self.assertGreater(gallons, 0)
        s2t = next(p for p in self.v("airtankers", "aircraft") if "S-2T" in p["model"])
        self.assertEqual((s2t["max_gal"], s2t["cruise_kt"]), (1200, 230))

    def test_line_length_table_shape_and_monotonic(self) -> None:
        table = self.v("airtankers", "line_length_ft_by_gallons_and_coverage")
        levels = table["columns_coverage_level"]
        previous = None
        for gallons, row in sorted(table["rows"].items(), key=lambda kv: int(kv[0])):
            self.assertEqual(len(row), len(levels))
            self.assertEqual(row, sorted(row, reverse=True), "line shortens as coverage level rises")
            if previous:
                self.assertTrue(all(a >= b for a, b in zip(row, previous)), "more gallons never shortens line")
            previous = row

    def test_dozer_table_shape(self) -> None:
        table = self.v("dozers", "production_single_pass")
        self.assertEqual(len(table["columns"]), 6)
        for size, rows in table["rows_by_dozer_size_then_fuel_model"].items():
            for label, values in rows.items():
                self.assertEqual(len(values), 6, f"{size} {label}")
                self.assertTrue(all(x > 0 for x in values))
        # Larger dozers are never slower than small ones in grass on gentle upslope.
        rows = table["rows_by_dozer_size_then_fuel_model"]
        self.assertGreaterEqual(rows["large_type1"]["1,2,3"][0], rows["small_type3"]["1,2,3"][0])
        # Upslope is slower than downslope at every class for the medium dozer.
        for values in rows["medium_type2"].values():
            self.assertLessEqual(values[0], values[1])
            self.assertLessEqual(values[2], values[3] + 1)

    def test_hand_crew_rates(self) -> None:
        direct = self.v("hand_crews", "production_sustained_2011_direct")
        indirect = self.v("hand_crews", "production_sustained_2011_indirect")
        for table in (direct, indirect):
            self.assertEqual(len(table["type1"]["chains_per_hour"]), len(table["columns"]))
            for t in ("type1", "type2"):
                for rate, (low, high) in zip(table[t]["chains_per_hour"], table[t]["range"]):
                    self.assertLessEqual(low, rate)
                    self.assertLessEqual(rate, high)
        for a, b in zip(direct["type1"]["chains_per_hour"], indirect["type1"]["chains_per_hour"]):
            self.assertGreater(a, b, "direct line is faster than indirect")
        self.assertAlmostEqual(sd.crew_line_rate_m_per_h(self.data, 1, "grass"), 17 * 20.1168)
        self.assertAlmostEqual(sd.crew_line_rate_m_per_h(self.data, 2, "timber", "indirect"), 5.7 * 20.1168)

    def test_dozer_rate_helper(self) -> None:
        rate = sd.dozer_line_rate_m_per_h(self.data, "medium_type2", 5, 20, True)
        self.assertAlmostEqual(rate, 88 * 20.1168)
        self.assertAlmostEqual(sd.dozer_line_rate_m_per_h(self.data, "large_type1", 10, 30, False), 34 * 20.1168)
        self.assertIsNone(sd.dozer_line_rate_m_per_h(self.data, "large_type1", 1, 60, True))

    def test_ground_standards_metric_matches_feet(self) -> None:
        std = self.data["ground_constraints"]["design_standards_14_ccr_1273"]
        ra = self.data["road_access"]
        self.assertAlmostEqual(ra["min_lane_width_m"]["value"], std["two_way_min_lane_width_ft"]["value"] * 0.3048, places=2)
        self.assertAlmostEqual(ra["two_way_min_width_m"]["value"], 2 * 10 * 0.3048, places=1)
        self.assertAlmostEqual(ra["driveway_clear_width_m"]["value"], std["driveway_horizontal_clearance_ft"]["value"] * 0.3048, places=2)
        self.assertAlmostEqual(ra["min_vertical_clearance_m"]["value"], std["vertical_clearance_ft"]["value"] * 0.3048, places=2)
        self.assertAlmostEqual(ra["min_inside_curve_radius_m"]["value"], std["min_inside_curve_radius_ft"]["value"] * 0.3048, places=2)
        self.assertAlmostEqual(ra["turnaround_radius_m"]["value"], std["turnaround_min_radius_ft"]["value"] * 0.3048, places=2)
        self.assertEqual(std["max_grade_pct"]["value"], 16)
        self.assertEqual(std["max_grade_with_local_approval_pct"]["value"], 20)

    def test_aviation_windows_and_limits(self) -> None:
        av = self.data["aviation_constraints"]
        self.assertEqual(av["helicopter_daylight_limit_min"]["value"], {"before_sunrise": 30, "after_sunset": 30})
        wind = av["wind_drop_effectiveness_kt"]["value"]
        self.assertLess(wind["evaluate_at"], wind["generally_not_effective_at_or_above"])
        self.assertLess(wind["generally_not_effective_at_or_above"], av["hard_flight_wind_limit_kt"]["value"])
        self.assertEqual(av["flame_length_limit_ft"]["value"], 8)

    def test_response_times_non_negative_and_ordered(self) -> None:
        rt = self.data["response_times"]
        for key, leaf in rt.items():
            values = leaf["value"] if isinstance(leaf["value"], list) else [leaf["value"]]
            self.assertTrue(all(x >= 0 for x in values), key)
        self.assertLess(rt["turnout_s"]["value"], rt["wildland_turnout_s"]["value"])
        self.assertLess(rt["hand_crew_mobilization_min"]["value"], rt["dozer_mobilization_min"]["value"])

    @unittest.skipUnless(sd.BASES_PATH.exists(), BASES_SKIP)
    def test_engines_per_station_estimate_is_consistent(self) -> None:
        bases = sd.load_bases()["bases"]
        state = [b for b in bases if b["owner"] == "STATE" and b["type"] in ("FSA", "FSB", "FSAB")]
        engines = self.data["deployment"]["calfire_engines_2019"]["value"]["year_round_engines"]
        self.assertAlmostEqual(engines / len(state), self.data["deployment"]["engines_per_station_estimate"]["value"], delta=0.06)


class RoadAccessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.data = sd.load_resources()

    def access(self, tags, grade, vehicle, **kw):
        return sd.road_access(self.data, tags, grade, vehicle, **kw)

    def test_paved_residential_open_to_everyone(self) -> None:
        for vehicle in self.data["road_access"]["vehicle_classes"]:
            result = self.access({"highway": "residential", "surface": "asphalt"}, 5, vehicle)
            self.assertTrue(result["passable"], vehicle)
            self.assertEqual(result["rule"], "R11")
            self.assertLessEqual(result["speed_kmh"], 35)

    def test_foot_only_ways_closed(self) -> None:
        self.assertEqual(self.access({"highway": "path"}, 0, "engine_t4_t7")["rule"], "R01")

    def test_unpaved_track_by_vehicle(self) -> None:
        track = {"highway": "track", "tracktype": "grade3", "width": "3.6"}
        self.assertFalse(self.access(track, 8, "engine_t1_t2")["passable"])
        self.assertFalse(self.access(track, 8, "tender_support")["passable"])
        self.assertTrue(self.access(track, 8, "engine_t3")["passable"])
        self.assertTrue(self.access(track, 8, "engine_t4_t7")["passable"])

    def test_soft_track_only_light_awd(self) -> None:
        track = {"highway": "track", "tracktype": "grade4", "width": "3.6"}
        self.assertTrue(self.access(track, 5, "engine_t4_t7")["passable"])
        self.assertFalse(self.access(track, 5, "engine_t3")["passable"])
        self.assertFalse(self.access({"highway": "track", "tracktype": "grade5", "width": "3.6"}, 5, "engine_t4_t7")["passable"])

    def test_grade_limits(self) -> None:
        road = {"highway": "residential"}
        self.assertTrue(self.access(road, 16, "engine_t1_t2")["passable"])
        self.assertEqual(self.access(road, 18, "engine_t1_t2")["rule"], "R05")
        self.assertTrue(self.access(road, 18, "engine_t3")["passable"])
        self.assertEqual(self.access({"highway": "track", "tracktype": "grade2", "width": "3.6"}, 30, "engine_t4_t7")["rule"], "R06")
        # Downhill grade is the same magnitude.
        self.assertEqual(self.access(road, -18, "engine_t1_t2")["rule"], "R05")

    def test_width_and_clearance(self) -> None:
        self.assertEqual(self.access({"highway": "track", "tracktype": "grade2", "width": "2.5"}, 0, "engine_t4_t7")["rule"], "R07")
        self.assertEqual(self.access({"highway": "residential", "maxheight": "3.5"}, 0, "engine_t1_t2")["rule"], "R08")
        self.assertTrue(self.access({"highway": "residential", "maxheight": "13'6\""}, 0, "engine_t1_t2")["passable"])

    def test_bridge_weight(self) -> None:
        heavy = {"highway": "residential", "bridge": "yes", "maxweight": "20"}
        self.assertEqual(self.access(heavy, 0, "tender_support")["rule"], "R09")
        self.assertTrue(self.access(heavy, 0, "engine_t3")["passable"])
        # Unmarked bridge on a public paved road is assumed adequate; on a track it is not for heavy rigs.
        self.assertTrue(self.access({"highway": "residential", "bridge": "yes"}, 0, "tender_support")["passable"])
        track = {"highway": "track", "tracktype": "grade1", "surface": "asphalt", "width": "3.6", "bridge": "yes"}
        self.assertEqual(self.access({**track, "highway": "service"}, 0, "tender_tactical")["rule"], "R09")

    def test_dead_end_turnaround(self) -> None:
        road = {"highway": "residential"}
        self.assertEqual(self.access(road, 0, "engine_t1_t2", dead_end=True, has_turnaround=False)["rule"], "R10")
        self.assertTrue(self.access(road, 0, "engine_t3", dead_end=True, has_turnaround=False)["passable"])
        self.assertTrue(self.access(road, 0, "engine_t1_t2", dead_end=True, has_turnaround=True)["passable"])

    def test_speed_is_capped_by_maxspeed_and_grade(self) -> None:
        flat = self.access({"highway": "primary", "maxspeed": "40"}, 0, "engine_t1_t2")["speed_kmh"]
        steep = self.access({"highway": "primary", "maxspeed": "40"}, 14, "engine_t1_t2")["speed_kmh"]
        self.assertEqual(flat, 40)
        self.assertLess(steep, flat)

    def test_untagged_track_is_not_rejected_for_width(self) -> None:
        result = self.access({"highway": "track"}, 5, "engine_t3")
        self.assertTrue(result["passable"])
        self.assertTrue(any("tracktype inferred" in n for n in result["notes"]))


@unittest.skipUnless(sd.BASES_PATH.exists(), BASES_SKIP)
class BasesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.bases = sd.load_bases()

    def test_file_validates(self) -> None:
        self.assertEqual(sd.validate_bases(self.bases), [])

    def test_licence_and_checksum_recorded(self) -> None:
        source = self.bases["meta"]["source"]
        self.assertEqual(len(source["raw_sha256"]), 64)
        self.assertGreater(source["raw_bytes"], 100_000)
        self.assertIn("No open licence", source["licence"])

    def test_air_and_helitack_bases_present(self) -> None:
        by_type = {}
        for record in self.bases["bases"]:
            by_type.setdefault(record["type"], []).append(record)
        self.assertEqual(len(by_type["AAB"]), 16)
        self.assertGreaterEqual(len(by_type["HB"]), 15)
        names = {r["name"] for r in by_type["AAB"]}
        self.assertIn("Hemet Ryan AAB", names)
        self.assertIn("Columbia AAB", names)
        columbia = next(r for r in by_type["AAB"] if r["name"] == "Columbia AAB")
        self.assertAlmostEqual(columbia["lat"], 38.03639, places=3)
        self.assertAlmostEqual(columbia["lon"], -120.41016, places=3)

    def test_planned_c130_bases_flagged(self) -> None:
        flagged = [r["name"] for r in self.bases["bases"] if r.get("planned_c130_airtanker_2019")]
        self.assertGreaterEqual(len(flagged), 4)

    def test_build_bases_filters_and_hashes(self) -> None:
        import json

        raw = json.dumps({"features": [
            {"geometry": {"coordinates": [-122.0, 38.0]}, "properties": {"OBJECTID": 1, "TYPE": "FSB", "FACILITY_STATUS": "Active", "NAME": "A", "UNIT": "LNU", "OWNER": "STATE", "FUNDING": "B"}},
            {"geometry": {"coordinates": [-122.0, 38.0]}, "properties": {"OBJECTID": 2, "TYPE": "FSB", "FACILITY_STATUS": "Decommissioned", "NAME": "B", "UNIT": "LNU"}},
            {"geometry": {"coordinates": [-122.0, 38.0]}, "properties": {"OBJECTID": 3, "TYPE": "NUR", "FACILITY_STATUS": "Active", "NAME": "C", "UNIT": "LNU"}},
            {"geometry": None, "properties": {"OBJECTID": 4, "TYPE": "FSB", "FACILITY_STATUS": "Active", "NAME": "D", "UNIT": "LNU"}},
        ]}).encode()
        built = sd.build_bases(raw, "2026-01-01")
        self.assertEqual([b["name"] for b in built["bases"]], ["A"])
        self.assertEqual(built["bases"][0]["agency"], "CAL FIRE (state-owned)")
        self.assertEqual(built["meta"]["source"]["raw_bytes"], len(raw))
        self.assertEqual(sd.validate_bases(built), [])


if __name__ == "__main__":
    unittest.main()
