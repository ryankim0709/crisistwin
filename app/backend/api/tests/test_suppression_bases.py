import json
import os
import tempfile
from pathlib import Path
from unittest import mock

from django.test import SimpleTestCase


def base(i, kind, lon, lat, **extra):
    return {
        "id": f"b{i}", "name": f"Base {i}", "type": kind, "unit": "XYZ", "agency": "CAL FIRE",
        "owner": "STATE", "lon": lon, "lat": lat, **extra,
    }


BASES = (
    [base(i, "FSA", -121.0 + i * 0.01, 38.0) for i in range(45)]  # 45 stations, nearest first
    + [base(100 + i, "CC", -121.0, 38.1 + i * 0.01) for i in range(12)]
    + [
        base(200, "HB", -121.2, 38.0),
        base(201, "AAB", -121.1, 38.0),
        base(202, "HB", -110.0, 38.0),  # far outside the radius
        base(203, "ECC", -121.0, 38.0),  # skipped type
    ]
)
FILE = {
    "meta": {"source": {"attribution": "Test attribution", "licence": "Test licence", "retrieved": "2026-10-24"}},
    "bases": BASES,
}


class SuppressionBasesTests(SimpleTestCase):
    def get(self, query, path):
        with mock.patch.dict(os.environ, {"SUPPRESSION_BASES_PATH": str(path)}):
            return self.client.get(f"/api/suppression/bases{query}")

    def write(self, directory):
        path = Path(directory) / "bases.json"
        path.write_text(json.dumps(FILE))
        return path

    def test_caps_and_ordering(self):
        with tempfile.TemporaryDirectory() as tmp:
            response = self.get("?lon=-121.0&lat=38.0", self.write(tmp))
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["available"])
        self.assertEqual(body["attribution"], "Test attribution")
        self.assertEqual(body["licence"], "Test licence")
        self.assertEqual(body["retrieved"], "2026-10-24")
        rows = body["bases"]
        types = [r["type"] for r in rows]
        self.assertEqual(types.count("FSA"), 40)
        self.assertEqual(types.count("CC"), 10)
        self.assertEqual(sorted(r["id"] for r in rows if r["type"] in ("HB", "AAB")), ["b200", "b201"])
        self.assertNotIn("ECC", types)
        distances = [r["distanceKm"] for r in rows]
        self.assertEqual(distances, sorted(distances))
        self.assertEqual(set(rows[0]), {"id", "name", "type", "agency", "unit", "lon", "lat", "distanceKm"})
        # 0.01 deg of longitude at 38 N is about 0.877 km.
        station = next(r for r in rows if r["id"] == "b9")
        self.assertAlmostEqual(station["distanceKm"], 9 * 0.877, delta=0.2)

    def test_radius_limits_results(self):
        with tempfile.TemporaryDirectory() as tmp:
            body = self.get("?lon=-121.0&lat=38.0&radius_km=5", self.write(tmp)).json()
        self.assertTrue(all(r["distanceKm"] <= 5 for r in body["bases"]))
        self.assertNotIn("b200", [r["id"] for r in body["bases"]])  # about 17 km away

    def test_missing_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            response = self.get("?lon=-121.0&lat=38.0", Path(tmp) / "absent.json")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertFalse(body["available"])
        self.assertEqual(body["bases"], [])
        self.assertIn("local-only", body["detail"])

    def test_bad_params(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self.write(tmp)
            for query in (
                "", "?lon=-121.0", "?lat=38.0", "?lon=x&lat=38", "?lon=200&lat=38", "?lon=-121&lat=95",
                "?lon=-121&lat=38&radius_km=601", "?lon=-121&lat=38&radius_km=0", "?lon=-121&lat=38&radius_km=nan",
            ):
                with self.subTest(query=query):
                    response = self.get(query, path)
                    self.assertEqual(response.status_code, 400)
                    self.assertIn("error", response.json())
