import json
import shutil
import tempfile
import unittest
from pathlib import Path

from tools.build_camp_history import (
    INCIDENT_ID,
    SourceError,
    normalize_fire_perimeters,
    normalize_pages,
    verify_package,
)
from tools.replay_camp_history import frame_at, parse_utc


PACKAGE_ROOT = Path(__file__).resolve().parents[1] / "data" / "incidents" / INCIDENT_ID


def sample_feature(object_id: int, longitude: float = -121.635) -> dict:
    return {
        "attributes": {
            "OBJECTID": object_id,
            "GLOBALID": f"example-{object_id}",
            "DAMAGE": "No Damage",
            "INCIDENTNAME": "Camp",
            "INCIDENTNUM": "CABTU 016737",
            "INCIDENTSTARTDATE": 1541635200000,
            "STRUCTURECATEGORY": "Single Residence",
        },
        "geometry": {"x": longitude, "y": 39.735},
    }


def sample_page(*features: dict) -> dict:
    return {"spatialReference": {"wkid": 4326}, "features": list(features)}


class NormalizeTests(unittest.TestCase):
    def test_orders_records_and_does_not_invent_assessment_time(self):
        collection = normalize_pages([1, 2], [sample_page(sample_feature(2), sample_feature(1))])
        self.assertEqual([feature["properties"]["source_object_id"] for feature in collection["features"]], [1, 2])
        self.assertEqual(collection["features"][0]["properties"]["incident_start_date"], "2018-11-08")
        self.assertIsNone(collection["features"][0]["properties"]["assessment_at"])
        self.assertEqual(collection["features"][0]["properties"]["temporal_role"], "postfire_assessment")

    def test_flags_a_source_point_slightly_outside_query_box(self):
        collection = normalize_pages([1], [sample_page(sample_feature(1, -121.6401))])
        self.assertTrue(collection["features"][0]["properties"]["outside_requested_bbox"])
        self.assertEqual(collection["bbox"][0], -121.6401)

    def test_missing_duplicate_and_truncated_pages_fail(self):
        with self.assertRaisesRegex(SourceError, "missing 1 requested"):
            normalize_pages([1, 2], [sample_page(sample_feature(1))])
        with self.assertRaisesRegex(SourceError, "duplicate feature"):
            normalize_pages([1], [sample_page(sample_feature(1), sample_feature(1))])
        truncated = sample_page(sample_feature(1))
        truncated["exceededTransferLimit"] = True
        with self.assertRaisesRegex(SourceError, "transfer limit"):
            normalize_pages([1], [truncated])

    def test_wrong_incident_and_invalid_coordinate_fail(self):
        wrong = sample_feature(1)
        wrong["attributes"]["INCIDENTNUM"] = "OTHER"
        with self.assertRaisesRegex(SourceError, "unexpected incident"):
            normalize_pages([1], [sample_page(wrong)])
        with self.assertRaisesRegex(SourceError, "valid longitude/latitude"):
            normalize_pages([1], [sample_page(sample_feature(1, 200))])

    def test_fire_perimeter_uses_documented_local_snapshot_time(self):
        response = {
            "type": "FeatureCollection",
            "numberMatched": 1,
            "numberReturned": 1,
            "features": [{
                "type": "Feature",
                "id": 7,
                "properties": {
                    "ogc_fid": 7, "fireid": "F17028", "t": "2018-11-08T12:00:00",
                    "farea": 2.0, "n_newpixels": 3,
                },
                "geometry": {"type": "Polygon", "coordinates": [[
                    [-121.6, 39.7], [-121.5, 39.7], [-121.5, 39.8], [-121.6, 39.7]
                ]]},
            }],
        }
        normalized = normalize_fire_perimeters(response)
        self.assertEqual(normalized["features"][0]["properties"]["snapshot_at"], "2018-11-08T20:00:00Z")
        self.assertEqual(normalized["features"][0]["properties"]["evidence_class"], "reconstructed")
        response["numberMatched"] = 2
        with self.assertRaisesRegex(SourceError, "incomplete"):
            normalize_fire_perimeters(response)


class PackageTests(unittest.TestCase):
    def test_included_historical_package_rebuilds_offline(self):
        packages = list(PACKAGE_ROOT.iterdir())
        self.assertEqual(len(packages), 1)
        manifest = verify_package(packages[0])
        self.assertEqual(manifest["layers"]["damage_assessments"]["count"], 290)
        self.assertEqual(manifest["layers"]["damage_assessments"]["outside_requested_bbox_count"], 6)
        self.assertEqual(manifest["layers"]["fire_perimeters"]["count"], 45)

    def test_replay_uses_last_observed_perimeter_and_marks_staleness(self):
        package = next(PACKAGE_ROOT.iterdir())
        before = frame_at(package, parse_utc("2018-11-08T19:00:00Z"))
        self.assertEqual(before["features"], [])
        self.assertEqual(before["replay"]["coverage"], "before_first_observation")
        during = frame_at(package, parse_utc("2018-11-09T15:00:00Z"))
        self.assertEqual(during["replay"]["snapshot_at"], "2018-11-09T08:00:00Z")
        self.assertEqual(during["replay"]["snapshot_age_seconds"], 7 * 3600)
        self.assertEqual(len(during["features"]), 1)
        after = frame_at(package, parse_utc("2018-12-01T00:00:00Z"))
        self.assertEqual(after["replay"]["coverage"], "after_last_observation")
        self.assertEqual(after["replay"]["interpolation"], "none")

    def test_modified_artifact_is_rejected(self):
        package = next(PACKAGE_ROOT.iterdir())
        with tempfile.TemporaryDirectory() as directory:
            copied = Path(directory) / package.name
            shutil.copytree(package, copied)
            path = copied / "normalized/damage_assessments.geojson"
            value = json.loads(path.read_text())
            value["features"].pop()
            path.write_text(json.dumps(value))
            with self.assertRaisesRegex(SourceError, "modified"):
                verify_package(copied)


if __name__ == "__main__":
    unittest.main()
