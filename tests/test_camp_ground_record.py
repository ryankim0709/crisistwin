import json
import re
import unittest
from pathlib import Path

from tools import camp_ground_record as gr


ROOT = Path(__file__).resolve().parents[1]
ITEM_KEYS = {"id", "at", "time_precision", "channel", "category", "road_name", "coord", "summary",
             "evidence_class", "source_locator", "text_sha12"}
ROAD_NAME = re.compile(r"(?:[A-Z][a-z]+ )+(?:%s)|Highway \d{2}|Skyway" % "|".join(sorted(set(gr.ROAD_SUFFIXES.values()))))


def record() -> dict:
    return json.loads(gr.OUTPUT_PATH.read_bytes())


def a2_page(*rows: str) -> str:
    header = ("      (M/D) Time (min) Time Source     Latitude    Longitude      Source     NETTRA Observations"
              + " " * 60 + "AV" + " " * 40 + "Source #    Info. Source")
    return "\n".join(["                         Table A-2. NETTRA data.", header, *rows])


def a2_row(time: str, lat: str, lon: str, text: str, source: str, info: str) -> str:
    return f"      11/8 {time}    0     {info:<9}   {lat}   {lon}   {info:<9}   {text:<120}×     {source:<11} {info}"


class TimeTests(unittest.TestCase):
    def test_pacific_standard_time_is_utc_minus_eight(self):
        self.assertEqual(gr.utc_at(8, "06:25"), "2018-11-08T14:25:00Z")
        self.assertEqual(gr.utc_at(8, "16:30"), "2018-11-09T00:30:00Z")
        self.assertEqual(gr.utc_at(9, "00:38"), "2018-11-09T08:38:00Z")

    def test_invalid_clock_time_fails(self):
        with self.assertRaises(gr.SourceError):
            gr.utc_at(8, "07:61")


class RuleTests(unittest.TestCase):
    def test_categories(self):
        cases = {
            "Entrapment; surrounded by flames, can't get out": "trapped",
            "need help evacuating, no vehicle, trying to go with neighbors": "help_needed",
            "downed powerline blocking Skyway between Slate St and Lava St": "road_blocked",
            "Wagstaff Rd at Pentz Rd is pretty much a parking lot": "heavy_traffic",
            "Disp: “go ahead and evacuate please”": "evacuation_order",
            "raining ashes; advised to stay close to phone for notifications": "fire_seen",
            "Pulga has been evacuated by engine personnel": "evacuation_progress",
            "setting up TRA at Walgreens": "shelter",
            "En route, outside assist to CAL FIRE": "other",
        }
        for text, category in cases.items():
            with self.subTest(text=text):
                self.assertEqual(gr.categorize(text), category)

    def test_roads_are_normalized_and_drop_house_numbers(self):
        self.assertEqual(gr.roads_in("13526 Green Forest Ln; entrapment"), ["Green Forest Lane"])
        self.assertEqual(gr.extract_road("shut down Hwy 70 at Pentz [Rd]"), ("Highway 70", False))
        self.assertEqual(gr.extract_road("LE526 “Blocking Clark [Rd] NB at Durham-Pentz [Rd].”"), ("Clark Road", False))
        self.assertEqual(gr.extract_road("at Skyway and Wagstaff Rd"), ("Skyway", False))
        self.assertEqual(gr.extract_road("medical emergency"), (None, False))

    def test_residential_streets_are_never_named(self):
        self.assertEqual(gr.extract_road("6309 Thomasson Ln, request for evacuation assistance"), (None, True))
        self.assertEqual(gr.extract_road("13471 Green Forest Ln, cross of Concow Rd"), ("Concow Road", True))

    def test_rows_naming_a_residential_street_get_two_decimal_points(self):
        pages = [a2_page(
            a2_row("09:32", "39.761234", "-121.598765", "947 Thomasson Ln, request for evacuation assistance",
                   "VTD-32", "Radio Log"),
            a2_row("09:33", "39.761234", "-121.598765", "traffic at Pentz Rd", "VTD-32", "Radio Log"),
        ), "Appendix B. Roadway Characteristics"]
        items, _ = gr.build_a2(pages)
        self.assertEqual([(item["road_name"], item["coord"]) for item in items],
                         [(None, [-121.6, 39.76]), ("Pentz Road", [-121.599, 39.761])])
        self.assertEqual(items[0]["summary"], "Radio: help needed")

    def test_summary_is_a_template(self):
        self.assertEqual(gr.summary_for("911", "trapped", "Pentz Road"), "911 call: trapped by fire, Pentz Road")
        self.assertEqual(gr.summary_for("radio", "road_blocked", "Skyway"), "Radio: road blocked, Skyway")


class DuplicateTests(unittest.TestCase):
    def test_duplicate_quotes_merge_and_drop_their_points(self):
        quote = "Oro: “BCSO is inquiring if you'd like to update the evacuation.”"
        pages = [a2_page(
            a2_row("07:17", "39.803188", "-121.449143", quote, "VTD-32", "Radio Log"),
            a2_row("07:17", "39.786880", "-121.507763", quote, "VTD-32", "Radio Log"),
            a2_row("07:18", "39.785655", "-121.505675", "evacs are starting to happen", "911-024-1", "911-024-1"),
            a2_row("07:19", "39.785655", "-121.505675", "regular traffic", "TD-073", "TD"),
        ), "Appendix B. Roadway Characteristics"]
        items, stats = gr.build_a2(pages)
        self.assertEqual(stats["rows_parsed"], 4)
        self.assertEqual(stats["rows_dropped"], {"info_source_not_911_or_radio_log": 1, "duplicate_quote_merged": 1})
        self.assertEqual([item["id"] for item in items], ["nist-a2-1", "nist-a2-3"])
        self.assertIsNone(items[0]["coord"])
        self.assertEqual(items[0]["text_sha12"], gr.text_sha12(quote))
        self.assertEqual(items[1]["coord"], [-121.506, 39.786])
        self.assertEqual(items[1]["summary"], "911 call: evacuation under way")


class CommittedRecordTests(unittest.TestCase):
    def test_header(self):
        data = record()
        self.assertEqual(data["source_url"], gr.SUP_URL)
        self.assertEqual(data["source_sha256"], gr.SOURCES["sup"]["sha256"])
        self.assertEqual(data["time_zone"], "UTC")
        self.assertEqual(data["coordinate_order"], "longitude, latitude")
        self.assertEqual(data["coordinate_crs"], "EPSG:4326")
        self.assertIn("2 decimals", data["de_identification"])
        self.assertTrue(data["items"])

    def test_items_have_exact_keys_and_valid_values(self):
        items = record()["items"]
        self.assertEqual(len({item["id"] for item in items}), len(items))
        self.assertEqual([item["at"] for item in items], sorted(item["at"] for item in items))
        for item in items:
            with self.subTest(item=item["id"]):
                self.assertEqual(set(item), ITEM_KEYS)
                self.assertRegex(item["id"], r"^nist-(a2|k1|t10|t13)-\d+$")
                self.assertRegex(item["at"], r"^2018-11-(08|09)T\d{2}:\d{2}:00Z$")
                self.assertIn(item["time_precision"], ("minute", "approximate"))
                self.assertIn(item["channel"], gr.CHANNEL_LABELS)
                self.assertIn(item["category"], gr.CATEGORY_LABELS)
                self.assertRegex(item["text_sha12"], r"^[0-9a-f]{12}$")
                expected_class = "reported" if item["channel"] in ("911", "radio") else "reconstructed"
                self.assertEqual(item["evidence_class"], expected_class)
                self.assertTrue(item["source_locator"].startswith(("https://nvlpubs.nist.gov/",)))
                if item["coord"] is not None:
                    lon, lat = item["coord"]
                    self.assertEqual([lon, lat], [round(lon, 3), round(lat, 3)])
                    self.assertTrue(-123 < lon < -120 and 39 < lat < 41)

    def test_summaries_hold_no_source_text(self):
        items = record()["items"]
        allowed = {word for label in (*gr.CHANNEL_LABELS.values(), *gr.CATEGORY_LABELS.values())
                   for word in label.split()}
        for item in items:
            road = item["road_name"]
            if road is not None:
                self.assertIn(road, gr.MAIN_ROADS)
                self.assertRegex(road, rf"^(?:{ROAD_NAME.pattern})$")
                allowed.update(road.split())
        for item in items:
            with self.subTest(item=item["id"]):
                summary = item["summary"]
                self.assertEqual(summary, gr.summary_for(item["channel"], item["category"], item["road_name"]))
                self.assertTrue(set(re.split(r"[ ,:]+", summary)) <= allowed)
                # Only the channel's "911" and highway numbers may appear; no house numbers.
                numbers = re.findall(r"\d+", summary)
                self.assertTrue(all(n == "911" or f"Highway {n}" in summary for n in numbers), summary)


if __name__ == "__main__":
    unittest.main()
