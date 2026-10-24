"""Tests for tools/people_data.py, its fixtures and tools/people_behavior.json. No network is used."""

import copy
import io
import json
import socket
import struct
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from sim import behavior, demand
from tools import people_data as pd

ROOT = Path(__file__).resolve().parents[1]
ACS_FIXTURE = ROOT / "tools" / "people_acs_butte_fixture.json"
FAC_FIXTURE = ROOT / "tools" / "people_facilities_butte_fixture.json"
# The facilities fixture is not in git: CDPH/CDSS/CDE state no open licence. Rebuild it locally
# with tools/people_data.py (see docs/people-data.md) to run these tests.
FAC_SKIP = "tools/people_facilities_butte_fixture.json not built (licence: local-only)"
BEHAVIOR = ROOT / "tools" / "people_behavior.json"


def setUpModule():
    patcher = mock.patch.object(socket.socket, "connect", side_effect=AssertionError("tests must not use the network"))
    patcher.start()
    unittest.addModuleCleanup(patcher.stop)


def load(path: Path) -> dict:
    return json.loads(path.read_text())


def make_dbf(rows: list[dict[str, str]], widths: dict[str, int]) -> bytes:
    names = list(widths)
    record_len = 1 + sum(widths.values())
    header_len = 32 + 32 * len(names) + 1
    head = struct.pack("<BBBBIHH20x", 3, 24, 1, 1, len(rows), header_len, record_len)
    desc = b"".join(n.encode().ljust(11, b"\x00") + b"C" + b"\x00" * 4 + bytes([widths[n]]) + b"\x00" * 15 for n in names)
    body = b"".join(b" " + b"".join(r[n].ljust(widths[n]).encode() for n in names) for r in rows)
    return head + desc + b"\r" + body


def make_tiger_zip(rows: list[dict[str, str]]) -> bytes:
    widths = {"GEOID": 12, "COUNTYFP": 3, "INTPTLAT": 11, "INTPTLON": 12}
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("tl_2022_06_bg.dbf", make_dbf(rows, widths))
    return buf.getvalue()


TIGER_ROWS = [
    {"GEOID": "060070001001", "COUNTYFP": "007", "INTPTLAT": "+39.7500000", "INTPTLON": "-121.8000000"},
    {"GEOID": "060070001002", "COUNTYFP": "007", "INTPTLAT": "+39.9000000", "INTPTLON": "-121.5000000"},
    {"GEOID": "060890001001", "COUNTYFP": "089", "INTPTLAT": "+40.5000000", "INTPTLON": "-122.3000000"},
]


def cells_for(**over: int | None) -> dict[str, int | None]:
    """Normalised cells for one block group; every cell 1 unless overridden by 'T_E003'-style names."""
    cells: dict[str, int | None] = {}
    for table, numbers in pd.TABLE_CELLS.items():
        for n in numbers:
            cells[f"{table}_E{n:03d}"] = 1
            cells[f"{table}_M{n:03d}"] = 2
    cells.update({k: v for k, v in over.items()})
    return cells


class ParsingTests(unittest.TestCase):
    def test_estimate_sentinels_are_none(self):
        self.assertEqual(pd.parse_estimate("12"), 12)
        self.assertEqual(pd.parse_estimate("12.0"), 12)
        for bad in ("", None, "-666666666", "-222222222", "N", "(X)"):
            self.assertIsNone(pd.parse_estimate(bad))

    def test_derive_record_sums_cells_and_moe(self):
        cells = cells_for(B25044_E001=100, B25044_E003=5, B25044_E010=7, B25044_M003=3, B25044_M010=4)
        rec = pd.derive_record("060070001001", cells)
        self.assertEqual(rec["households"], 100)
        self.assertEqual(rec["hh_no_vehicle"], 12)
        self.assertEqual(rec["hh_3plus_vehicle"], 6)  # cells 6, 7, 8, 13, 14, 15 of 1 each
        self.assertEqual(rec["pop_65plus"], 12)  # six male and six female age cells
        self.assertEqual(rec["moe90"]["hh_no_vehicle"], 5)  # sqrt(3^2 + 4^2)

    def test_derive_record_keeps_missing_as_none(self):
        rec = pd.derive_record("060070001001", cells_for(B25044_E003=None))
        self.assertIsNone(rec["hh_no_vehicle"])
        self.assertIsNone(pd.shares(rec)["no_vehicle"])

    def test_shares_handle_zero_denominators(self):
        rec = pd.derive_record("060070001001", cells_for(B25044_E001=0, B25044_E003=0, B25044_E010=0))
        self.assertIsNone(pd.shares(rec)["no_vehicle"])
        rec = pd.derive_record("060070001001", cells_for(B25044_E001=50, B25044_E003=5, B25044_E010=5))
        self.assertEqual(pd.shares(rec)["no_vehicle"], 0.2)

    def test_api_url_has_no_key_unless_given(self):
        url = pd.api_url(2022, "B25044", "007", None)
        self.assertNotIn("key=", url)
        self.assertIn("for=block%20group:*", url)
        self.assertIn("in=state:06%20county:007", url)
        self.assertIn("key=ABC", pd.api_url(2022, "B25044", "007", "ABC"))
        self.assertIn("for=tract:*", pd.api_url(2022, "B18101", "007", None))

    def test_api_table_parse_and_missing_key(self):
        header = ["NAME", "B25044_001E", "B25044_001M", "B25044_003E", "state", "county", "tract", "block group"]
        body = json.dumps([header, ["BG 1", "100", "10", "-666666666", "06", "007", "000100", "1"]]).encode()
        out = pd.parse_api_table("B25044", body)
        self.assertEqual(out["060070001001"]["B25044_E001"], 100)
        self.assertEqual(out["060070001001"]["B25044_M001"], 10)
        self.assertIsNone(out["060070001001"]["B25044_E003"])
        with self.assertRaises(pd.SourceError) as ctx:
            pd.parse_api_table("B25044", b"<html><title>Missing Key</title></html>")
        self.assertIn("CENSUS_API_KEY", str(ctx.exception))

    def test_bulk_lines_stop_after_prefix_run(self):
        head = "GEO_ID|" + "|".join(f"C16002_{k}{n:03d}" for n in pd.TABLE_CELLS["C16002"] for k in "EM")
        row = lambda gid, v: gid + "|" + "|".join(str(v) for _ in pd.TABLE_CELLS["C16002"] for _ in "EM")  # noqa: E731
        lines = iter([head, row("1400000US06007000100", 1), row("1500000US060070001001", 5),
                      row("1500000US060070001002", 6), row("1500000US060090001001", 7), row("1500000US999", 9)])
        rows, early = pd.parse_bulk_lines("C16002", lines, "1500000US06007")
        self.assertEqual(sorted(rows), ["060070001001", "060070001002"])
        self.assertTrue(early)
        self.assertEqual(rows["060070001001"]["C16002_E004"], 5)

    def test_dbf_and_tiger_selection(self):
        points = pd.parse_tiger_bg_zip(make_tiger_zip(TIGER_ROWS))
        self.assertEqual(points["060070001001"], {"county": "007", "lat": 39.75, "lon": -121.8})
        self.assertEqual(sorted(pd.select_block_groups(points, ["007"], None)), ["060070001001", "060070001002"])
        in_box = pd.select_block_groups(points, None, (-122.0, 39.5, -121.7, 40.0))
        self.assertEqual(sorted(in_box), ["060070001001"])
        both = pd.select_block_groups(points, ["089"], (-122.0, 39.5, -121.0, 40.0))
        self.assertEqual(both, {})


def fake_api_fetch(url: str) -> bytes:
    if url.startswith("https://www2.census.gov/geo/tiger/"):
        return make_tiger_zip(TIGER_ROWS)
    table = next(t for t in pd.TABLE_CELLS if f"get=NAME,{t}_" in url)
    geo_tract = "for=tract" in url
    variables = [f"{table}_{n:03d}{k}" for n in pd.TABLE_CELLS[table] for k in "EM"]
    header = ["NAME", *variables, "state", "county", "tract"] + ([] if geo_tract else ["block group"])
    rows = []
    for geoid in ("060070001001", "060070001002"):
        if geo_tract and geoid.endswith("2"):
            continue
        vals = [str(10) if v.endswith("E") else str(3) for v in variables]
        rows.append(["x", *vals, "06", "007", "000100"] + ([] if geo_tract else [geoid[-1]]))
    return json.dumps([header, *rows]).encode()


class RunCensusTests(unittest.TestCase):
    def test_api_source_builds_extract_with_provenance(self):
        doc = pd.run_census(["007"], None, source="api", fetch=fake_api_fetch)
        self.assertEqual([r["geoid"] for r in doc["records"]], ["060070001001", "060070001002"])
        self.assertTrue(all(s["sha256"] and s["bytes"] and s["url"] for s in doc["sources"]))
        self.assertEqual(len(doc["sources"]), 1 + len(pd.TABLE_CELLS))  # one TIGER file, one call per table
        self.assertTrue(doc["notes"]["keyless"])
        self.assertEqual(doc["records"][0]["households"], 10)
        self.assertEqual(doc["records"][0]["disab_universe"], 10)  # tract row copied to both block groups
        self.assertFalse([p for p in pd.validate_census_extract(doc) if "geoid" in p or "bounds" in p])

    def test_bulk_source_uses_stream(self):
        calls = []

        def stream(url, prefix, table):
            calls.append((table, prefix))
            rows = {g: {f"{table}_{k}{n:03d}": 4 for n in pd.TABLE_CELLS[table] for k in "EM"}
                    for g in (("06007000100",) if prefix.startswith("14") else ("060070001001", "060070001002"))}
            return rows, {"url": url, "bytes_read": 10, "bytes_total": 20, "sha256_of_bytes_read": "ab" * 32,
                          "stopped_early": True, "retrieved_at": "2026-10-24T00:00:00Z"}

        doc = pd.run_census(["007"], None, source="bulk", fetch=fake_api_fetch, stream=stream)
        self.assertEqual(dict(calls)["B18101"], "1400000US06")
        self.assertEqual(dict(calls)["B25044"], "1500000US06")
        self.assertEqual(doc["records"][1]["households"], 4)
        self.assertFalse([p for p in pd.validate_census_extract(doc) if "geoid" in p or "bounds" in p])

    def test_requires_counties_or_bbox(self):
        with self.assertRaises(pd.SourceError):
            pd.run_census(None, None, fetch=fake_api_fetch)

    def test_no_match_is_an_error(self):
        with self.assertRaises(pd.SourceError):
            pd.run_census(["999"], None, fetch=fake_api_fetch)


class FacilityParserTests(unittest.TestCase):
    CDPH_CSV = (
        "FACID,FAC_STATUS_TYPE_CODE,FACNAME,FAC_FDR,CAPACITY,ZIP,CITY,COUNTY_NAME,LATITUDE,LONGITUDE,"
        "LICENSE_STATUS_DESCRIPTION,DATA_DATE,FACADMIN,CONTACT_EMAIL,CONTACT_PHONE_NUMBER,ADDRESS\n"
        "230000013,OPEN,ENLOE HEALTH,GENERAL ACUTE CARE HOSPITAL,268,95926,CHICO,BUTTE,39.74216,-121.85029,ACTIVE,10/16/2026,DOE JANE,a@b.c,(530) 1,1 MAIN ST\n"
        "230000025,OPEN,CHICO TERRACE,SKILLED NURSING FACILITY,76,95926,CHICO,BUTTE,39.75044,-121.85275,ACTIVE,10/16/2026,X,y@z.c,(530) 2,2 MAIN ST\n"
        "230000099,OPEN,A CLINIC,PRIMARY CARE CLINIC,5,95926,CHICO,BUTTE,39.7,-121.8,ACTIVE,10/16/2026,X,y@z.c,(530) 3,3 MAIN ST\n"
        "230000098,CLOSED,OLD SNF,SKILLED NURSING FACILITY,50,95926,CHICO,BUTTE,39.7,-121.8,ACTIVE,10/16/2026,X,y@z.c,(530) 4,4 MAIN ST\n"
        "010000001,OPEN,ELSEWHERE,SKILLED NURSING FACILITY,50,94000,OAKLAND,ALAMEDA,37.8,-122.2,ACTIVE,10/16/2026,X,y@z.c,(510) 5,5 MAIN ST\n"
        "230000097,OPEN,NO COORDS,SKILLED NURSING FACILITY,50,95926,CHICO,BUTTE,,,ACTIVE,10/16/2026,X,y@z.c,(530) 6,6 MAIN ST\n"
    )

    def test_cdph_keeps_open_bed_facilities_and_drops_contacts(self):
        rows = pd.parse_cdph(self.CDPH_CSV, ["Butte"])
        self.assertEqual([r["kind"] for r in rows], ["hospital", "skilled_nursing"])
        self.assertEqual(rows[0]["capacity"], 268)
        self.assertEqual(rows[0]["name"], "Enloe Health")
        text = json.dumps(rows).lower()
        for leak in ("doe jane", "a@b.c", "(530)", "main st"):
            self.assertNotIn(leak, text)

    def test_ccl_is_deidentified_and_rounded(self):
        feats = [
            {"attributes": {"FAC_NBR": 1, "TYPE": 740, "STATUS": 3, "CAPACITY": 6, "FAC_LATITUDE": "39.123456",
                            "FAC_LONGITUDE": "-121.654321", "RES_CITY": "PARADISE   ", "RES_ZIP_CODE": 95969,
                            "NAME": "SMITH HOME", "RES_STREET_ADDR": "1 OAK ST"}},
            {"attributes": {"FAC_NBR": 2, "TYPE": 403, "STATUS": 3, "CAPACITY": 6, "FAC_LATITUDE": "39.1",
                            "FAC_LONGITUDE": "-121.6"}},  # resource family home: excluded
            {"attributes": {"FAC_NBR": 3, "TYPE": 740, "STATUS": 6, "CAPACITY": 6, "FAC_LATITUDE": "39.1",
                            "FAC_LONGITUDE": "-121.6"}},  # not in the kept status
        ]
        rows = pd.parse_ccl(feats)
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["lat"], rows[0]["lon"]), (39.123, -121.654))
        self.assertIsNone(rows[0]["name"])
        self.assertNotIn("smith", json.dumps(rows).lower())
        self.assertNotIn("oak st", json.dumps(rows).lower())

    def test_cde_keeps_active_schools_with_enrolment_as_proxy(self):
        feats = [
            {"attributes": {"CDSCode": "04100410114991", "SchoolName": "Paradise Senior High", "Status": "Active",
                            "City": "PARADISE", "Zip": "95969", "GradeLow": "9", "GradeHigh": "12", "EnrollTotal": 700,
                            "Latitude": 39.76, "Longitude": -121.62, "Year": "2025-26"}},
            {"attributes": {"CDSCode": "2", "SchoolName": "Closed", "Status": "Closed", "Latitude": 39.7, "Longitude": -121.6}},
            {"attributes": {"CDSCode": "3", "SchoolName": "No point", "Status": "Active", "Latitude": None, "Longitude": None}},
        ]
        rows = pd.parse_cde(feats)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["capacity"], 700)
        self.assertIn("not building capacity", rows[0]["capacity_unit"])

    def test_county_numbers_follow_ccld_order(self):
        self.assertEqual(pd.county_number("Butte"), 4)
        self.assertEqual(pd.county_number("yuba"), 58)
        self.assertEqual(len(pd.CA_COUNTIES), 58)
        with self.assertRaises(pd.SourceError):
            pd.county_number("Atlantis")

    def test_run_facilities_with_fake_fetch_records_sources(self):
        ccl = json.dumps({"features": [{"attributes": {"FAC_NBR": 9, "TYPE": 740, "STATUS": 3, "CAPACITY": 12,
                                                       "COUNTY": "Butte County", "FAC_LATITUDE": "39.7",
                                                       "FAC_LONGITUDE": "-121.8", "RES_CITY": "CHICO",
                                                       "RES_ZIP_CODE": 95926}}]}).encode()
        cde = json.dumps({"features": [{"attributes": {"CDSCode": "1", "SchoolName": "S", "Status": "Active",
                                                       "City": "CHICO", "Zip": "95926", "GradeLow": "K", "GradeHigh": "5",
                                                       "EnrollTotal": 300, "Latitude": 39.7, "Longitude": -121.8,
                                                       "Year": "2025-26"}}]}).encode()

        def fetch(url):
            if url.startswith(pd.CDPH_URL):
                return self.CDPH_CSV.encode()
            return ccl if url.startswith(pd.CCL_LAYER) else cde

        doc = pd.run_facilities(["Butte"], fetch=fetch)
        self.assertEqual(doc["counts_by_kind"], {"hospital": 1, "rcfe": 1, "school": 1, "skilled_nursing": 1})
        self.assertEqual(pd.validate_facilities(doc), [])


class FixtureTests(unittest.TestCase):
    def test_fixtures_are_small(self):
        for path in (ACS_FIXTURE, FAC_FIXTURE):
            if not path.exists():
                continue
            self.assertLess(path.stat().st_size, 200_000, path.name)

    def test_acs_fixture_validates_and_is_butte(self):
        doc = load(ACS_FIXTURE)
        self.assertEqual(pd.validate_census_extract(doc), [])
        self.assertGreater(len(doc["records"]), 150)
        self.assertTrue(all(r["geoid"].startswith("06007") for r in doc["records"]))
        self.assertEqual(doc["evidence_class"], "observed")
        self.assertIn("public domain", doc["licence"])
        self.assertTrue(all(s.get("url") and (s.get("sha256") or s.get("sha256_of_bytes_read")) for s in doc["sources"]))

    def test_acs_fixture_vehicle_classes_sum_to_households(self):
        for r in load(ACS_FIXTURE)["records"]:
            if r["households"] is not None:
                self.assertEqual(r["hh_no_vehicle"] + r["hh_1_vehicle"] + r["hh_2_vehicle"] + r["hh_3plus_vehicle"],
                                 r["households"], r["geoid"])

    @unittest.skipUnless(FAC_FIXTURE.exists(), FAC_SKIP)
    def test_facility_fixture_validates_and_has_licences(self):
        doc = load(FAC_FIXTURE)
        self.assertEqual(pd.validate_facilities(doc), [])
        for source in ("cdph", "cdss", "cde"):
            self.assertTrue(doc["licences"][source]["licence"])
            self.assertTrue(doc["licences"][source]["url"].startswith("https://"))
        kinds = doc["counts_by_kind"]
        for kind in ("hospital", "skilled_nursing", "rcfe", "school"):
            self.assertGreater(kinds.get(kind, 0), 0, kind)
        self.assertEqual(sum(kinds.values()), len(doc["facilities"]))

    @unittest.skipUnless(FAC_FIXTURE.exists(), FAC_SKIP)
    def test_facility_fixture_has_no_resident_identifying_fields(self):
        doc = load(FAC_FIXTURE)
        for f in doc["facilities"]:
            if f["source"] == "cdss":
                self.assertIsNone(f["name"])
        text = json.dumps(doc["facilities"]).lower()
        self.assertNotRegex(text, r"[\w.]+@[\w.]+\.\w+")
        self.assertNotRegex(text, r"\(\d{3}\) \d{3}-\d{4}")


class ValidatorTests(unittest.TestCase):
    def test_census_validator_catches_problems(self):
        base = load(ACS_FIXTURE)
        for mutate, needle in (
            (lambda d: d["records"][0].__setitem__("hh_no_vehicle", d["records"][0]["households"] + 1), "exceeds"),
            (lambda d: d["records"][0].__setitem__("pop", -5), "non-negative"),
            (lambda d: d["records"][0].__setitem__("geoid", "123"), "bad geoid"),
            (lambda d: d["records"][0].__setitem__("lat", 10.0), "outside bounds"),
            (lambda d: d["records"].append(copy.deepcopy(d["records"][0])), "duplicate"),
            (lambda d: d.__setitem__("licence", ""), "missing licence"),
            (lambda d: d["records"][0].__setitem__("hh_1_vehicle", d["records"][0]["hh_1_vehicle"] + 3), "vehicle classes"),
        ):
            doc = copy.deepcopy(base)
            mutate(doc)
            self.assertTrue(any(needle in p for p in pd.validate_census_extract(doc)), needle)

    @unittest.skipUnless(FAC_FIXTURE.exists(), FAC_SKIP)
    def test_facility_validator_catches_problems(self):
        base = load(FAC_FIXTURE)
        cdss = next(i for i, f in enumerate(base["facilities"]) if f["source"] == "cdss")
        for mutate, needle in (
            (lambda d: d["facilities"][0].__setitem__("capacity", -1), "capacity"),
            (lambda d: d["facilities"][cdss].__setitem__("name", "Smith Home"), "must not carry a name"),
            (lambda d: d["facilities"][cdss].__setitem__("lat", 39.12345), "rounded"),
            (lambda d: d["facilities"][0].__setitem__("phone", "5551212"), "identifying"),
            (lambda d: d["facilities"].append(copy.deepcopy(d["facilities"][0])), "duplicate"),
            (lambda d: d["licences"]["cde"].__setitem__("licence", ""), "licence record incomplete"),
            (lambda d: d["facilities"][0].__setitem__("lon", 0.0), "outside bounds"),
        ):
            doc = copy.deepcopy(base)
            mutate(doc)
            self.assertTrue(any(needle in p for p in pd.validate_facilities(doc)), needle)


class BehaviorFileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = load(BEHAVIOR)
        cls.params = {p["id"]: p for p in cls.doc["parameters"]}

    def test_every_parameter_is_sourced_or_flagged(self):
        sources = self.doc["sources"]
        for pid, p in self.params.items():
            self.assertIn(p["status"], {"sourced", "derived", "assumption", "gap"}, pid)
            for s in p["sources"]:
                self.assertIn(s, sources, pid)
            if p["status"] in ("sourced", "derived"):
                self.assertTrue(p["sources"] and p["locator"], pid)
                self.assertNotIn("assumption", p["sources"], pid)
            if p["status"] == "assumption":
                self.assertEqual(p["sources"], ["assumption"], pid)
            if p["status"] == "gap":
                self.assertIsNone(p["value"], pid)
            self.assertTrue(p["comparison"], pid)

    def test_suggested_values_inside_ranges_and_flagged(self):
        for pid, p in self.params.items():
            if "suggested" in p:
                self.assertEqual(p["suggested"]["status"], "assumption", pid)
                lo, hi = p["range"]
                self.assertTrue(lo <= p["suggested"]["value"] <= hi, pid)

    def test_ranges_match_per_event_values(self):
        for pid, p in self.params.items():
            if "range" in p and "per_event" in p:
                values = [v for k, v in p["per_event"].items() if not k.startswith("kincade")]
                self.assertEqual((min(values), max(values)), tuple(p["range"]), pid)
            if "range" in p:
                self.assertTrue(0 <= p["range"][0] <= p["range"][1] <= 1, pid)

    def test_sim_values_match_current_model_constants(self):
        defaults = behavior.BehaviorParams()
        self.assertEqual(self.params["wait_and_see_stay_and_defend_intent"]["sim_value"], defaults.wait_for_fire_share)
        self.assertEqual(self.params["stay_reason_protect_property"]["sim_value"], defaults.wait_for_fire_share)
        self.assertEqual(self.params["pet_extra_preparation"]["sim_value"], defaults.prep_median_min)
        self.assertEqual(self.params["return_during_closure"]["sim_value"], defaults.turn_back_prob)
        self.assertEqual(self.params["vehicles_per_evacuating_household"]["sim_value"], demand.VEHICLES_TAKEN_CAP)
        self.assertEqual(self.params["order_compliance"]["sim_value"], demand.EVACUATION_PARTICIPATION)
        self.assertEqual(self.params["overall_evacuation_rate_survey"]["sim_value"], demand.EVACUATION_PARTICIPATION)

    def test_quoted_sim_delay_means_follow_behavior_defaults(self):
        import math
        d = behavior.BehaviorParams()
        prep_mean = d.prep_median_min * math.exp(d.prep_sigma ** 2 / 2)
        order = 60 / d.order_hazard_per_h + prep_mean
        warning = 60 / d.warning_hazard_per_h + prep_mean
        fire = 60 / d.fire_cue_hazard_per_h + prep_mean
        text = self.params["camp_awareness_departure_timing"]["sim_value"]
        for value, label in ((order, "order"), (warning, "warning"), (fire, "fire")):
            self.assertIn(f"about {round(value)} min", text, label)

    def test_derived_shares_match_acs_fixture(self):
        recs = load(ACS_FIXTURE)["records"]
        tot = lambda k: sum(r[k] for r in recs)  # noqa: E731
        tracts = {r["geoid"][:11]: (r["disab_total"], r["disab_universe"]) for r in recs}
        checks = {
            "no_vehicle_households_butte": tot("hh_no_vehicle") / tot("households"),
            "age_65plus_butte": tot("pop_65plus") / tot("pop"),
            "limited_english_butte": tot("lep_households") / tot("lep_universe"),
            "disability_butte": sum(a for a, _ in tracts.values()) / sum(b for _, b in tracts.values()),
        }
        for pid, expected in checks.items():
            self.assertAlmostEqual(self.params[pid]["value"], expected, places=3, msg=pid)

    def test_mean_vehicles_derivation_matches_wong_shares(self):
        v = self.params["vehicles_per_evacuating_household"]["value"]
        for key, (full, capped) in {"oct2017_norcal": (1.72, 1.58), "dec2017_socal": (1.61, 1.52),
                                     "carr2018": (1.82, 1.65)}.items():
            one, two, more = v[key]["one"], v[key]["two"], v[key]["more_than_two"]
            total = one + two + more
            self.assertAlmostEqual((one + 2 * two + 3 * more) / total, full, places=2)
            self.assertAlmostEqual((one + 2 * two + 2 * more) / total, capped, places=2)
        text = self.params["vehicles_per_evacuating_household"]["comparison"]
        recs = load(ACS_FIXTURE)["records"]
        h1, h2, h3 = (sum(r[k] for r in recs) for k in ("hh_1_vehicle", "hh_2_vehicle", "hh_3plus_vehicle"))
        self.assertIn(f"{h1:,} / {h2:,} / {h3:,}", text)
        self.assertIn(f"{(h1 + 2 * (h2 + h3)) / (h1 + h2 + h3):.2f}", text)

    def test_departure_hour_distributions_sum_to_one(self):
        for event, dist in self.params["departure_hour_distribution"]["value"].items():
            self.assertAlmostEqual(sum(dist.values()), 1.0, delta=0.002, msg=event)

    def test_gaps_listed(self):
        self.assertTrue(self.doc["gaps"])


if __name__ == "__main__":
    unittest.main()
