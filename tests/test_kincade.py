"""Focused offline tests for the Kincade package normalizers (stdlib unittest)."""

from __future__ import annotations

import io
import json
import os
import unittest
import zipfile
from datetime import datetime
from pathlib import Path

from tools import kincade_events, kincade_fire, kincade_population, kincade_traffic
from tools.kincade_common import SourceError, gunzip_checked, gzip_bytes, local_to_utc, sha256, utc_text

TOOLS = Path(__file__).resolve().parents[1] / "tools"
PACKAGE_ROOT = Path(__file__).resolve().parents[1] / "data" / "incidents" / "kincade-2019-evacuation"


class TimeConversionTest(unittest.TestCase):
    def test_pdt_before_and_pst_after_dst_end(self):
        self.assertEqual(utc_text(local_to_utc(datetime(2019, 10, 23, 21, 27))), "2019-10-24T04:27:00Z")
        self.assertEqual(utc_text(local_to_utc(datetime(2019, 11, 3, 15, 0))), "2019-11-03T23:00:00Z")
        self.assertEqual(utc_text(local_to_utc(datetime(2019, 11, 6, 19, 0))), "2019-11-07T03:00:00Z")

    def test_ambiguous_fall_back_hour_rejected(self):
        with self.assertRaises(SourceError):
            local_to_utc(datetime(2019, 11, 3, 1, 30))

    def test_gzip_round_trip_checks_digest(self):
        data = b'{"a":1}\n'
        self.assertEqual(gunzip_checked(gzip_bytes(data), sha256(data), "x"), data)
        with self.assertRaises(SourceError):
            gunzip_checked(gzip_bytes(data), sha256(b"other"), "x")


class MatrixEventTest(unittest.TestCase):
    def setUp(self):
        self.table = json.loads((TOOLS / "kincade_events_table.json").read_bytes())
        self.events = kincade_events.matrix_events(self.table)

    def test_first_zone_orders_and_split_inheritance(self):
        first = next(e for e in self.events if e["event_id"] == "kincade-matrix-r02-order")
        self.assertEqual(first["occurred_at"], "2019-10-26T17:00:00Z")
        self.assertEqual(first["target"]["zone_ids"], ["kincade-zone-1", "kincade-zone-2", "kincade-zone-3"])
        split = next(e for e in self.events if e["event_id"] == "kincade-matrix-r06-order")
        self.assertEqual(split["zone_transitions"],
                         [{"zone_id": "kincade-zone-8a", "from": "order", "to": "order", "via_split_of": "kincade-zone-8"}])
        self.assertIn("kincade-zone-8", split["zone_ids_no_longer_listed"])
        downgrade = next(e for e in self.events if e["event_id"] == "kincade-matrix-r06-warning")
        self.assertIn({"zone_id": "kincade-zone-7", "from": "order", "to": "warning", "via_split_of": None},
                      downgrade["zone_transitions"])

    def test_every_event_is_utc_and_sourced(self):
        for event in self.events:
            self.assertTrue(event["occurred_at"].endswith("Z"))
            self.assertEqual(event["evidence_class"], "observed")
            self.assertIn("#page=", event["source_locator"])

    def test_curated_day_precision_window(self):
        events = kincade_events.curated_events(self.table)
        shelter = next(e for e in events if e["event_id"] == "kincade-aar-shelters-opened-20191026")
        self.assertEqual((shelter["occurred_from"], shelter["occurred_to"]), ("2019-10-26T07:00:00Z", "2019-10-27T06:59:59Z"))
        reopen = next(e for e in events if e["event_id"] == "kincade-us101-reopen-nb-477-482")
        self.assertEqual(reopen["occurred_at"], "2019-10-28T12:00:00Z")


def tiny_workbook(rows: list[list]) -> bytes:
    header = list(kincade_traffic.HEADER)
    strings = header + ["L1N", "Routine"]
    index = {s: i for i, s in enumerate(strings)}

    def cell(col, value):
        if isinstance(value, str):
            return f'<c r="{col}" t="s"><v>{index[value]}</v></c>'
        return "" if value is None else f'<c r="{col}"><v>{value}</v></c>'

    body = []
    for n, values in enumerate([header] + rows, 1):
        cells = "".join(cell(f"{c}{n}", v) for c, v in zip(kincade_traffic.COLUMNS, values))
        body.append(f'<row r="{n}">{cells}</row>')
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("xl/sharedStrings.xml", f"<sst {ns}>" + "".join(f"<si><t>{s}</t></si>" for s in strings) + "</sst>")
        z.writestr("xl/worksheets/sheet1.xml", f"<worksheet {ns}><sheetData>{''.join(body)}</sheetData></worksheet>")
    return buf.getvalue()


class TrafficTest(unittest.TestCase):
    def test_row_normalization(self):
        # 2019-09-28 00:05 local; L1 588 veh/h, L2 360 veh/h, no L3.
        row = [43736 + 5 / 1440, "L1N", "Routine", 100,
               7.0, 5.1, 588, 0.036, 114.6, 0, 7.5, 3.4, 360, 0.026, 104.8, 24,
               None, None, None, None, None, None, 7.25, 4.27, 474, 0.031, 110.9, 12]
        obs, quality = kincade_traffic.normalize_traffic(kincade_traffic.workbook_cells_csv(tiny_workbook([row])), (TOOLS / "kincade_traffic_stations.json").read_bytes())
        self.assertEqual(len(obs), 1)
        o = obs[0]
        self.assertEqual(o["interval_start"], "2019-09-28T07:05:00Z")
        self.assertEqual(o["flow_veh"], 79.0)
        self.assertEqual(o["lanes_reporting"], 2)
        self.assertAlmostEqual(o["occupancy_pct"], 3.1)
        self.assertIsNone(o["pct_observed"])

    def test_off_grid_time_rejected(self):
        row = [43736 + 3 / 1440, "L1N", "Routine", 100] + [1] * 24
        with self.assertRaises(SourceError):
            kincade_traffic.normalize_traffic(kincade_traffic.workbook_cells_csv(tiny_workbook([row])), (TOOLS / "kincade_traffic_stations.json").read_bytes())


class FireAndCensusTest(unittest.TestCase):
    def test_firms_subset_filters_bbox_and_dates(self):
        csv_text = ("latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight,type\n"
                    "38.70,-122.78,330,0.4,0.4,2019-10-24,0948,N,VIIRS,n,2,290,5.1,N,0\n"
                    "38.70,-122.78,330,0.4,0.4,2019-12-01,0948,N,VIIRS,n,2,290,5.1,N,0\n"
                    "36.00,-120.00,330,0.4,0.4,2019-10-24,0948,N,VIIRS,n,2,290,5.1,N,0\n")
        subset = kincade_fire.firms_subset(csv_text.encode())
        self.assertEqual(subset.decode().count("\n"), 2)
        fc, _ = kincade_fire.normalize_firms({"viirs-snpp": subset, "modis": subset.splitlines(True)[0]})
        self.assertEqual(fc["features"][0]["properties"]["acquired_at"], "2019-10-24T09:48:00Z")

    def test_dins_rejects_extra_fields(self):
        payload = {"spatialReference": {"wkid": 4326}, "features": [
            {"attributes": {**{f: None for f in kincade_fire.DINS_FIELDS}, "SITEADDRESS": "x"}, "geometry": {"x": -122.8, "y": 38.7}}]}
        with self.assertRaises(SourceError):
            kincade_fire.normalize_dins(json.dumps(payload).encode())

    def test_point_in_polygon_with_hole(self):
        square = {"type": "Polygon", "coordinates": [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
                                                    [[1, 1], [1, 3], [3, 3], [3, 1], [1, 1]]]}
        self.assertTrue(kincade_population._point_in_geometry(0.5, 0.5, square))
        self.assertFalse(kincade_population._point_in_geometry(2, 2, square))


@unittest.skipUnless(os.environ.get("KINCADE_VERIFY_PACKAGE"), "set KINCADE_VERIFY_PACKAGE=1 for the slow full rebuild")
class PackageVerifyTest(unittest.TestCase):
    def test_every_package_verifies_offline(self):
        from tools.kincade_build import verify
        packages = sorted(p for p in PACKAGE_ROOT.iterdir() if p.is_dir())
        self.assertTrue(packages)
        for package in packages:
            self.assertEqual(verify(package)["package_version"], package.name)


if __name__ == "__main__":
    unittest.main()
