import json
import unittest
from pathlib import Path

from tools import camp_add_layers as layers
from tools.build_camp_evacuation import SourceError, encoded_json
from tools.camp_extracts import polygon_intersects_bbox
from tools.camp_terrain import lzw_decode, undo_float_predictor


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "data" / "incidents" / "camp-2018-evacuation" / "17e67cfe5669fe50"


def table(name: str) -> dict:
    return json.loads(layers.TABLES[name].read_bytes())


def lzw_encode(data: bytes) -> bytes:
    """Minimal TIFF-style LZW encoder (MSB-first, early change) for decoder tests."""
    table_map = {bytes([i]): i for i in range(256)}
    codes, width, bits, nbits, out = [256], 9, 0, 0, bytearray()
    widths = [9]
    next_code, current = 258, b""
    for byte in data:
        candidate = current + bytes([byte])
        if candidate in table_map:
            current = candidate
            continue
        codes.append(table_map[current])
        widths.append(width)
        table_map[candidate] = next_code
        next_code += 1
        # The decoder's table lags the encoder by one entry, so it widens when next_code reaches 2**width.
        if next_code >= (1 << width) and width < 12:
            width += 1
        current = bytes([byte])
    codes.append(table_map[current])
    widths.append(width)
    if next_code + 1 >= (1 << width) and width < 12:  # decoder adds one more entry before reading EOI
        width += 1
    codes.append(257)
    widths.append(width)
    for code, size in zip(codes, widths):
        bits = (bits << size) | code
        nbits += size
        while nbits >= 8:
            nbits -= 8
            out.append((bits >> nbits) & 0xFF)
    if nbits:
        out.append((bits << (8 - nbits)) & 0xFF)
    return bytes(out)


class ZoneRequestTests(unittest.TestCase):
    def test_table11_self_check_and_event_links(self):
        zones, events = layers.normalize_zone_requests(layers.TABLES["curated/nist-zone-requests-table.json"].read_bytes())
        by_id = {event["event_id"]: event for event in events}
        order = by_id["nist-tn2252:t11:3:order-request"]
        self.assertEqual(order["type"], "evacuation_order")
        self.assertEqual(order["occurred_at"], "2018-11-08T15:46:00Z")
        self.assertEqual(order["target"], {"zone_ids": ["paradise-2017-zone-3"]})
        # 26:55 local is the next calendar day.
        self.assertEqual(by_id["nist-tn2252:t11:n-pines:first-fire"]["occurred_at"], "2018-11-09T10:55:00Z")
        self.assertIn(order["event_id"], {z["id"]: z for z in zones["features"]}["paradise-2017-zone-3"]["properties"]["event_ids"])
        self.assertTrue(all(feature["geometry"] is None for feature in zones["features"]))

    def test_transcription_error_is_rejected(self):
        bad = table("curated/nist-zone-requests-table.json")
        bad["table_11"]["rows"][2]["order_request"] = "07:47"
        with self.assertRaises(SourceError):
            layers.normalize_zone_requests(json.dumps(bad).encode())


class ShelterAndBurnoverTests(unittest.TestCase):
    def test_private_parcel_rounding_and_multi_day_periods(self):
        shelters, events = layers.normalize_shelters(layers.TABLES["curated/nist-tra-shelters-table.json"].read_bytes())
        by_id = {f["id"]: f for f in shelters["features"]}
        self.assertEqual(by_id["nist-tra:H"]["geometry"]["coordinates"], [-121.576, 39.766])
        self.assertEqual(by_id["nist-tra:H"]["properties"]["evidence_class"], "derived")
        self.assertEqual(by_id["nist-tra:AA"]["properties"]["active_periods_utc"],
                         [["2018-11-09T03:00:00Z", "2018-11-09T12:00:00Z"]])
        self.assertEqual(len(by_id["nist-tra:U"]["properties"]["active_periods_utc"]), 2)
        self.assertIsNone(by_id["nist-tra:A"]["properties"]["capacity_persons"])
        self.assertEqual(sum(e["type"] == "shelter_opened" for e in events), 32)

    def test_burnover_dates_and_blank_fatalities(self):
        events = {e["burnover_id"]: e for e in layers.normalize_burnovers(
            layers.TABLES["curated/nist-burnovers-table.json"].read_bytes())}
        self.assertEqual(events[16]["occurred_at"], "2018-11-09T08:00:00Z")
        self.assertIsNone(events[1]["fatalities_count"])
        self.assertEqual(events[21]["fatalities_count"], 5)
        self.assertIsNone(events[3]["duration_min"])


class GeometryAndDecoderTests(unittest.TestCase):
    def test_bbox_intersection(self):
        square = [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]]
        self.assertTrue(polygon_intersects_bbox(square, (0.5, 0.5, 2, 2)))
        self.assertTrue(polygon_intersects_bbox(square, (0.2, 0.2, 0.3, 0.3)))  # bbox inside polygon
        self.assertFalse(polygon_intersects_bbox(square, (2, 2, 3, 3)))

    def test_lzw_and_float_predictor_round_trip(self):
        raw = bytes(range(256)) * 40 + b"abcabcabcabc" * 500
        self.assertEqual(lzw_decode(lzw_encode(raw)), raw)
        # Two float32 samples [1.0, 2.0] encoded with predictor 3 (byte planes, then byte differencing).
        planes = bytes([0x3F, 0x40, 0x80, 0x00, 0, 0, 0, 0])
        encoded = bytes([planes[0]] + [(planes[i] - planes[i - 1]) & 0xFF for i in range(1, 8)])
        self.assertEqual(undo_float_predictor(encoded, 2, 1), [1.0, 2.0])


@unittest.skipUnless(PACKAGE.exists(), "Camp layers package not present")
class PackageTests(unittest.TestCase):
    def test_offline_verify_and_terrain_sanity(self):
        result = layers.verify(PACKAGE)
        self.assertEqual(result["population_units"], 142)
        grid = json.loads((PACKAGE / "normalized/terrain_grid.json").read_bytes())
        col = int((-121.6219 - grid["origin_lon"]) / grid["cell_deg"])
        row = int((39.7596 - grid["origin_lat"]) / grid["cell_deg_lat"])
        self.assertTrue(450 < grid["elevation_m"][row * grid["ncols"] + col] < 650)  # Paradise is ~540 m

    def test_population_has_no_silent_defaults(self):
        units = json.loads((PACKAGE / "normalized/population_units.geojson").read_bytes())["features"]
        for unit in units:
            props = unit["properties"]
            for key, value in props.items():
                if value is None:
                    self.assertEqual(props[f"{key}_status"], "unknown")
            self.assertGreaterEqual(props["population"], 0)

    def test_fire_observation_dates_are_corrected_and_text_excluded(self):
        data = (PACKAGE / "normalized/fire_observations_reconstructed.geojson").read_bytes()
        features = json.loads(data)["features"]
        self.assertTrue(all(f["properties"].get("observed_at") is None
                            or f["properties"]["observed_at"].startswith("2018-11-") for f in features))
        self.assertNotIn(b"Fire Behavior", data)
        self.assertEqual(encoded_json(json.loads(data)), data)


if __name__ == "__main__":
    unittest.main()
