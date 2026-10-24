import json
import re
import unittest
from datetime import datetime
from pathlib import Path

from tools import ground_stats_other_fires as gs


ITEM_KEYS = {"fire", "metric", "value", "unit", "period_start", "period_end", "time_zone_source",
             "source_id", "source_url", "page", "quote_sha12", "evidence_class", "note"}
HEADER_KEYS = {"dataset", "source_url", "source_sha256", "sources", "unavailable_sources", "time_zone",
               "source_time_zone", "generator", "page_basis", "items"}
UTC_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
UNITS = {"calls", "calls_per_day", "contacts", "alerts", "events", "dispatchers", "supervisors", "persons",
         "fraction", "responses_per_year", "engines", "services"}


def doc() -> dict:
    return json.loads(gs.OUTPUT_PATH.read_text())


def parse(ts: str) -> datetime:
    return datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ")


class SchemaTests(unittest.TestCase):
    def test_header(self):
        d = doc()
        self.assertTrue(HEADER_KEYS <= set(d))
        self.assertEqual(d["time_zone"], "UTC")
        self.assertEqual(set(d["source_sha256"]), {s["source_id"] for s in d["sources"]})
        for s in d["sources"]:
            self.assertRegex(s["sha256"], r"^[0-9a-f]{64}$")
            self.assertGreater(s["bytes"], 0)
            self.assertEqual(s["sha256"], gs.SOURCES[s["source_id"]]["sha256"])

    def test_items(self):
        d = doc()
        ids = {s["source_id"]: s for s in d["sources"]}
        self.assertGreaterEqual({i["fire"] for i in d["items"]}, {"marshall", "woolsey", "kincade"})
        for it in d["items"]:
            self.assertEqual(set(it), ITEM_KEYS, it["metric"])
            self.assertEqual(it["evidence_class"], "reported")
            self.assertIn(it["source_id"], ids)
            self.assertEqual(it["source_url"], ids[it["source_id"]]["url"])
            self.assertIsInstance(it["page"], int)
            self.assertTrue(1 <= it["page"] <= ids[it["source_id"]]["pages"])
            self.assertRegex(it["quote_sha12"], r"^[0-9a-f]{12}$")
            self.assertEqual(it["time_zone_source"], gs.TZ[it["fire"]])
            self.assertTrue(it["note"] and len(it["note"]) < 300)


class UnitTests(unittest.TestCase):
    def test_values_and_units(self):
        for it in doc()["items"]:
            self.assertIn(it["unit"], UNITS, it["metric"])
            self.assertIsInstance(it["value"], (int, float))
            self.assertGreaterEqual(it["value"], 0)
            if it["unit"] in {"calls", "contacts", "persons", "dispatchers", "supervisors", "engines"}:
                self.assertIsInstance(it["value"], int, it["metric"])
            if it["unit"] == "fraction":
                self.assertLessEqual(it["value"], 1)

    def test_everbridge_contacts_total(self):
        rows = [i for i in doc()["items"] if i["metric"].startswith("everbridge_")]
        self.assertEqual(len(rows), 9)
        self.assertEqual(sum(i["value"] for i in rows), 24289)

    def test_woolsey_call_figures(self):
        by = {i["metric"]: i["value"] for i in doc()["items"] if i["fire"] == "woolsey"}
        self.assertEqual(by["la_county_fire_additional_calls_for_help"], 1800)
        self.assertEqual(by["la_county_fire_normal_911_calls_per_day"], 1100)


class TimeTests(unittest.TestCase):
    def test_periods_are_utc_and_ordered(self):
        for it in doc()["items"]:
            s, e = it["period_start"], it["period_end"]
            self.assertEqual(s is None, e is None, it["metric"])
            if s is None:
                continue
            self.assertRegex(s, UTC_ISO)
            self.assertRegex(e, UTC_ISO)
            self.assertLessEqual(parse(s), parse(e))

    def test_marshall_mst_offset(self):
        # 11:47:52 MST on 2021-12-30 is 18:47:52Z (UTC-7)
        first = next(i for i in doc()["items"] if i["metric"] == "everbridge_order_contacts" and i["value"] == 215)
        self.assertEqual(first["period_start"], "2021-12-30T18:47:52Z")
        psap = next(i for i in doc()["items"] if i["metric"] == "psap_overload_event")
        self.assertEqual(psap["period_start"], "2021-12-30T19:41:00Z")

    def test_woolsey_day_is_pst(self):
        it = next(i for i in doc()["items"] if i["metric"] == "la_county_fire_additional_calls_for_help")
        self.assertEqual((it["period_start"], it["period_end"]), ("2018-11-09T08:00:00Z", "2018-11-10T08:00:00Z"))


class QuoteTests(unittest.TestCase):
    def test_anchors_are_short_and_hashes_match_spec(self):
        hashes = {gs.quote_hash(row[8]) for row in gs.SPEC}
        for row in gs.SPEC:
            self.assertLessEqual(len(row[8].split()), 25, row[1])
        self.assertEqual({i["quote_sha12"] for i in doc()["items"]}, hashes)

    def test_committed_json_has_no_quote_field(self):
        text = gs.OUTPUT_PATH.read_text()
        self.assertNotIn('"quote"', text)


if __name__ == "__main__":
    unittest.main()
