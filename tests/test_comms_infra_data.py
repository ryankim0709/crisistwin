import copy
import json
import re
import unittest
import zipfile
import tempfile
from pathlib import Path

from tools import comms_infra_data as ci

FIX = ci.FIXTURE_DIR


def load(name):
    return json.loads((FIX / name).read_text(encoding="utf-8"))


def params():
    return json.loads(ci.PARAMS_PATH.read_text(encoding="utf-8"))


def leaves(node, path=()):
    if isinstance(node, dict) and "provenance" in node:
        yield ".".join(path), node
    elif isinstance(node, dict):
        for k, v in node.items():
            if k not in ("sources", "meta"):
                yield from leaves(v, path + (k,))


class ParameterFileTests(unittest.TestCase):
    def test_parameter_file_validates(self):
        self.assertEqual(ci.validate_degradation(params()), [])

    def test_every_assumption_is_labelled_and_explained(self):
        found = [(p, n) for p, n in leaves(params()) if n["provenance"] == "ASSUMPTION"]
        self.assertGreaterEqual(len(found), 5)
        for path, node in found:
            self.assertTrue(node["rationale"], path)

    def test_validator_rejects_unsourced_and_bad_values(self):
        doc = copy.deepcopy(params())
        doc["alerting"]["codered_recall_success_mean"]["source_ids"] = ["nope"]
        doc["alerting"]["codered_initial_call_success_mean"]["value"] = 1.4
        doc["backup_power"]["pre_2020_battery_hours"].pop("rationale")
        doc["e911"]["paradise_pd_dispatch_consoles"]["provenance"] = "guess"
        doc["recovery"]["fire_damaged_sites_repaired_share_by_day_2"].pop("unit")
        errors = "\n".join(ci.validate_degradation(doc))
        for needle in ("unknown source id nope", "share above 1", "needs rationale", "bad provenance", "missing unit"):
            self.assertIn(needle, errors)

    def test_validator_rejects_negative_and_inverted_ranges(self):
        doc = copy.deepcopy(params())
        doc["power"]["power_site_outage_daily_remaining_ratio"].update(low=0.9, high=0.1)
        doc["cell_sites"]["butte_sites_served_dirs_2019"]["value"] = -1
        errors = "\n".join(ci.validate_degradation(doc))
        self.assertIn("low > high", errors)
        self.assertIn("negative", errors)

    def test_derived_values_match_their_arithmetic(self):
        p = params()
        fire, power = p["fire_damage_to_sites"], p["power"]
        self.assertAlmostEqual(fire["camp_butte_first_day_share_of_sites"]["value"], 17 / 174, places=3)
        self.assertAlmostEqual(fire["camp_butte_cumulative_share_of_sites"]["value"], 66 / 174, places=3)
        self.assertAlmostEqual(fire["failure_cause_share_damage"]["value"], 24 / 476, places=3)
        self.assertAlmostEqual(fire["failure_cause_share_transport"]["value"], 83 / 476, places=3)
        self.assertAlmostEqual(fire["failure_cause_share_power"]["value"], 351 / 476, places=3)
        self.assertAlmostEqual(power["psps_butte_site_outage_share_2019_10_30"]["value"], 7 / 174, places=2)
        self.assertAlmostEqual(power["power_site_outage_daily_remaining_ratio"]["low"], 5.2 / 35.4, places=2)
        self.assertAlmostEqual(power["power_site_outage_daily_remaining_ratio"]["high"], 0.165 / 0.224, places=2)
        self.assertAlmostEqual(p["alerting"]["evacuees_receiving_alerts_share"]["value"], 7000 / 52000, places=3)
        causes = sum(fire[k]["value"] for k in ("failure_cause_share_damage", "failure_cause_share_transport", "failure_cause_share_power"))
        self.assertAlmostEqual(causes, 0.96, delta=0.05)  # about 4 % of sites out had no listed cause bucket in rounding

    def test_telephone_status_shares_sum_to_one(self):
        a = params()["alerting"]
        total = sum(a[k]["value"] for k in ("ca_adults_wireless_only", "ca_adults_wireless_mostly", "ca_adults_dual_use",
                                            "ca_adults_landline_mostly", "ca_adults_landline_only", "ca_adults_no_telephone"))
        self.assertAlmostEqual(total, 1.0, delta=0.002)
        self.assertAlmostEqual(a["ca_adults_reachable_only_by_landline"]["value"],
                               a["ca_adults_landline_only"]["value"] + a["ca_adults_landline_mostly"]["value"], places=3)

    def test_observed_series_is_consistent(self):
        p = params()
        for row in p["observed_series"]["rows"]:
            self.assertLessEqual(0, row["out"])
            self.assertLessEqual(row["out"], row["served"])
            for sid in row["source_ids"]:
                self.assertIn(sid, p["sources"])

    def test_sources_have_citations_and_urls(self):
        for sid, s in params()["sources"].items():
            self.assertTrue(re.search(r"https?://|tools/comms_fixtures/", s["citation"]), sid)


class CodeRedParseTests(unittest.TestCase):
    SAMPLE = """
                         Table D-2. Statistics of CodeRED alert messages: attempted contacts and outcomes of initial message attempts.
      07:13        29       15      6      0          24        10         5    25%     17%     25%       8%     25%       6       4       6       2          6      67%       45
D-5
      09:09        —        —      —      —           —         —         —     15%     20%     53%       1%     11%      —       —       —       —       —           —        —
      25:18        61      318     53      0         611        55       263     2%      7%     86%       0%      5%      12      43    525        0      31         17%      169
              Table D-3. Statistics of CodeRED alert messages: attempted contacts and outcomes of phone re-call message attempts.
      08:32      08:40      1878         3999       274      1604     4%      3%     80%       1%     12%     160     120   3199       40    480          15%      274
D-7   16:12      16:19       699         1597         7       692     0%      0%     82%       0%     18%       0       0   1310        0    287           1%        7
Appendix E. Traffic Progression Maps
"""

    def test_parses_rows_dashes_and_page_markers(self):
        t = ci.parse_codered_tables(self.SAMPLE)
        self.assertEqual([r["initial_time"] for r in t["initial"]], ["07:13", "09:09", "25:18"])
        self.assertEqual(t["initial"][0]["phone_calls"], 15)
        self.assertAlmostEqual(t["initial"][0]["call_success"], 0.67)
        self.assertIsNone(t["initial"][1]["phone_calls"])
        self.assertAlmostEqual(t["initial"][1]["outcome_fraction"]["intercept"], 0.53)
        self.assertEqual(t["initial"][2]["initial_minutes"], 25 * 60 + 18)
        self.assertEqual([r["recall_delay_min"] for r in t["recalls"]], [8, 7])
        self.assertEqual(t["recalls"][1]["reached"], 7)

    def test_rejects_malformed_row(self):
        with self.assertRaises(ValueError):
            ci.parse_codered_tables(self.SAMPLE.replace("      07:13        29       15", "      07:13        29"))

    def test_missing_tables_fail(self):
        with self.assertRaises(ValueError):
            ci.parse_codered_tables("nothing here")

    def test_fixture_matches_nist_narrative(self):
        d = load("codered_delivery_table.json")
        self.assertEqual(len(d["initial"]), 29)
        self.assertEqual(len(d["recalls"]), 15)
        s = d["summary"]
        self.assertAlmostEqual(s["initial_success_unweighted_mean"], 0.55, delta=0.01)  # NIST: 55 %
        self.assertAlmostEqual(s["recall_success_unweighted_mean"], 0.07, delta=0.01)   # NIST: 7 %
        for r in d["initial"]:
            if r["phone_calls"] is not None:
                self.assertLessEqual(r["reached"], r["phone_calls"])
                self.assertEqual(r["reached"] + r["not_reached"], r["phone_calls"])
        for r in d["recalls"]:
            self.assertEqual(r["reached"] + r["not_reached"], r["phone_calls"])
            self.assertGreater(r["recall_delay_min"], 0)

    def test_fixture_agrees_with_existing_table_d1(self):
        d1 = json.loads((ci.ROOT / "tools" / "camp_codedred_table.json").read_text(encoding="utf-8"))
        self.assertEqual([r["initial_time"] for r in d1["rows"]], [r["initial_time"] for r in load("codered_delivery_table.json")["initial"]])


class FixtureTests(unittest.TestCase):
    def test_asr_fixture_is_butte_only_and_free_of_personal_fields(self):
        d = load("butte_asr_structures.json")
        self.assertIn("FIXTURE", d["label"])
        self.assertEqual(d["count"], len(d["rows"]))
        self.assertGreater(d["count"], 50)
        allowed = {"registration_number", "structure_status_code", "application_status_code", "dismantled", "site_description",
                   "city", "structure_type", "height_m", "ground_elevation_m", "lat", "lon"}
        for r in d["rows"]:
            self.assertEqual(set(r), allowed)
            self.assertTrue(ci.in_bbox(r["lat"], r["lon"]), r)
        self.assertRegex(d["source_sha256"], r"^[0-9a-f]{64}$")

    def test_uls_fixture_is_active_butte_cellular(self):
        d = load("butte_uls_cellular_sites.json")
        self.assertIn("FIXTURE", d["label"])
        self.assertEqual(d["count"], len(d["rows"]))
        self.assertTrue(any(r["city"] == "Paradise" for r in d["rows"]))
        for r in d["rows"]:
            self.assertTrue(ci.in_bbox(r["lat"], r["lon"]), r)
        self.assertRegex(d["source_sha256"], r"^[0-9a-f]{64}$")

    def test_manifest_records_size_and_hash_or_unavailable(self):
        m = load("source_manifest.json")
        ids = {s["id"] for s in m["sources"]}
        self.assertEqual(ids, {s["id"] for s in ci.SOURCES})
        for s in m["sources"]:
            if s["status"] == "downloaded":
                self.assertRegex(s["sha256"], r"^[0-9a-f]{64}$")
                self.assertGreater(s["bytes"], 0)
            else:
                self.assertEqual(s["status"], "unavailable")
        blocked = {s["id"] for s in m["sources"] if s["status"] == "unavailable"}
        self.assertTrue({"opencellid", "hifld-cellular-towers"} <= blocked)

    def test_every_source_has_licence_and_decision(self):
        for s in ci.SOURCES:
            self.assertTrue(s["licence"] and s["note"], s["id"])
            self.assertIn(s["status"], {"used", "cited", "secondary", "unavailable"})


class ParserUnitTests(unittest.TestCase):
    def test_dms(self):
        self.assertAlmostEqual(ci.dms_to_deg("39", "44", "53.6", "N"), 39.748222, places=5)
        self.assertAlmostEqual(ci.dms_to_deg("121", "38", "12.5", "W"), -121.636806, places=5)

    def _zip(self, files):
        tmp = tempfile.mkdtemp()
        path = Path(tmp) / "x.zip"
        with zipfile.ZipFile(path, "w") as zf:
            for name, text in files.items():
                zf.writestr(name, text)
        return path

    def test_extract_asr_filters_county_joins_coordinates_and_drops_contacts(self):
        ra = ("RA|REG|A1|1001|9|AU|AU|I|C|d|d|d|d||d|C||Jane||Doe||Boss|Y|5075 CLARK RD|PARADISE|CA|06007|95969|49.2|464.5|49.2|513.7|TOWER|d|x\n"
              "RA|REG|A2|1002|9|AU|AU|I|C|d|d|d|d||d|C||Jim||Poe||Boss|Y|ELSEWHERE|LOS GATOS|CA|06085|95037|61.0|1097.3|61.0|1158.3|TOWER|d|x\n")
        co = ("CO|REG|A1|1001|9|T|39|44|0.0|N|0|121|36|0.0|W|0||\n"
              "CO|REG|A2|1002|9|T|37|13|0.0|N|0|121|57|0.0|W|0||\n")
        rows = ci.extract_asr(self._zip({"RA.dat": ra, "CO.dat": co}))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["city"], "Paradise")
        self.assertAlmostEqual(rows[0]["lat"], 39.733333, places=5)
        self.assertNotIn("Jane", json.dumps(rows))

    def test_extract_uls_keeps_only_active_butte(self):
        hd = "HD|1|||KNKA1|A|CL\nHD|2|||KNKA2|T|CL\nHD|3|||KNKA3|A|CL\n"
        lo = ("LO|1|||KNKA1||F|T|1|||55 A ST|Paradise|BUTTE|CA|||||39|44|53.6|N|121|38|12.5|W|||TOWER\n"
              "LO|2|||KNKA2||F|T|1|||55 A ST|Paradise|BUTTE|CA|||||39|44|53.6|N|121|38|12.5|W|||TOWER\n"
              "LO|3|||KNKA3||F|T|1|||9 B ST|Reno|WASHOE|NV|||||39|44|53.6|N|121|38|12.5|W|||TOWER\n")
        rows = ci.extract_uls_cellular(self._zip({"HD.dat": hd, "LO.dat": lo}))
        self.assertEqual([r["call_sign"] for r in rows], ["KNKA1"])


if __name__ == "__main__":
    unittest.main()
