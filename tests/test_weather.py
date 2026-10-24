"""Tests for sim.weather and sim.weather_forecast_error. No network: every fetch is served from
``tests/fixtures/weather`` through an injected ``http_get`` and a temporary cache directory.

The fixtures are real archive responses trimmed to the Camp Fire day (2018-11-08, UTC):
Chico (KCIC) and Oroville (KOVE) ASOS from the IEM ASOS archive, Jarbo Gap and Pike County
Lookout RAWS from the IEM HADS archive, an NWS Sacramento Fire Weather Planning Forecast issued
2018-11-08 13:56Z (excerpt), and a gridpoint forecast document (fixture, 2026-10-24).
"""

import hashlib
import json
import tempfile
import unittest
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sim import weather as W
from sim import weather_forecast_error as FE

FIX = Path(__file__).resolve().parent / "fixtures" / "weather"
UTC = timezone.utc


def fixture_text(name: str) -> str:
    return (FIX / name).read_text()


def load_fixture_catalog() -> list:
    return W.parse_station_geojson(fixture_text("catalog_CA_ASOS.geojson"), "CA_ASOS") + W.parse_station_geojson(
        fixture_text("catalog_CA_DCP.geojson"), "CA_DCP"
    )


CAMP_FILES = {
    "CIC": "camp_cic_asos.csv",
    "OVE": "camp_ove_asos.csv",
    "JBGC1": "camp_jbgc1_hads.csv",
    "PKCC1": "camp_pkcc1_hads.csv",
}


class FakeHttp:
    """Serves the Camp fixtures by station id; counts calls."""

    def __init__(self, extra=None):
        self.calls = []
        self.extra = extra or {}

    def __call__(self, url, headers=None):
        self.calls.append(url)
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        sid = (qs.get("station") or qs.get("stations") or [None])[0]
        if sid in self.extra:
            return self.extra[sid](url)
        if sid in CAMP_FILES:
            return (FIX / CAMP_FILES[sid]).read_bytes()
        raise W.WeatherError(f"no fixture for {url}")


CAMP_LON, CAMP_LAT = -121.6, 39.81


class UnitsAndTime(unittest.TestCase):
    def test_conversions(self):
        self.assertAlmostEqual(10 * W.KNOT_MS, 5.144444, places=5)
        self.assertAlmostEqual(10 * W.MPH_MS, 4.4704, places=6)
        self.assertAlmostEqual(36 * W.KMH_MS, 10.0, places=9)
        self.assertAlmostEqual(W.f_to_c(68.0), 20.0, places=9)
        self.assertAlmostEqual(W.f_to_c(-40.0), -40.0, places=9)

    def test_naive_datetime_rejected(self):
        with self.assertRaises(ValueError):
            W.require_utc(datetime(2018, 11, 8, 12))
        with self.assertRaises(ValueError):
            W.require_utc("2018-11-08T12:00:00")

    def test_offsets_normalised_to_utc(self):
        t = W.require_utc("2018-11-08T06:29:00-08:00")  # Camp ignition, local PST
        self.assertEqual(t, datetime(2018, 11, 8, 14, 29, tzinfo=UTC))
        self.assertEqual(W.require_utc("2018-11-08T14:29:00Z"), t)
        self.assertEqual(W.iso_z(t), "2018-11-08T14:29:00Z")

    def test_angle_diff_wraps(self):
        self.assertEqual(W.angle_diff(10, 350), 20)
        self.assertEqual(W.angle_diff(350, 10), -20)
        self.assertEqual(W.angle_diff(180, 0), 180)
        self.assertEqual(W.norm_deg(-90), 270)


class Parsing(unittest.TestCase):
    def test_asos_csv_units_and_utc(self):
        obs = W.parse_asos_csv(fixture_text("camp_cic_asos.csv"))
        first = [o for o in obs if o.t == datetime(2018, 11, 8, 0, 47, tzinfo=UTC)][0]
        self.assertAlmostEqual(first.speed_ms, 10 * W.KNOT_MS, places=6)
        self.assertEqual(first.from_deg, 300.0)
        self.assertAlmostEqual(first.temp_c, 20.0, places=6)  # 68 F
        self.assertAlmostEqual(first.rh_pct, 6.38, places=2)
        self.assertIsNone(first.gust_ms)  # 'M' is missing, not zero
        # METAR calm (000 at 0 kt): direction is not meaningful
        calm = [o for o in obs if o.speed_ms == 0]
        self.assertTrue(calm)
        self.assertTrue(all(o.from_deg is None for o in calm))

    def test_hads_csv_mph_and_shef_columns(self):
        obs = W.parse_hads_csv(fixture_text("camp_jbgc1_hads.csv"))
        first = obs[0]
        self.assertEqual(first.t, datetime(2018, 11, 8, 0, 13, tzinfo=UTC))
        self.assertAlmostEqual(first.speed_ms, 4 * W.MPH_MS, places=6)
        self.assertEqual(first.from_deg, 236.0)
        self.assertAlmostEqual(first.gust_ms, 7 * W.MPH_MS, places=6)
        self.assertAlmostEqual(first.temp_c, W.f_to_c(62.0), places=6)
        self.assertEqual(first.rh_pct, 21.0)
        # rows that carry only precipitation have no wind and are dropped
        self.assertTrue(all(o.speed_ms is not None or o.from_deg is not None for o in obs))

    def test_zero_direction_with_wind_is_not_guessed(self):
        csv_text = "station,valid,tmpf,relh,drct,sknt,gust\nXXX,2018-11-08 01:00,50,20,0,8,M\n"
        self.assertIsNone(W.parse_asos_csv(csv_text)[0].from_deg)

    def test_station_geojson_filters_dcp_to_raws(self):
        cat = load_fixture_catalog()
        ids = {s.id for s in cat}
        self.assertIn("JBGC1", ids)  # "JARBO GAP RAWS"
        self.assertIn("CIC", ids)
        self.assertNotIn("PDEC1", ids)  # "PARADISE": hydrologic DCP, not RAWS


class HourlyBinning(unittest.TestCase):
    def obs(self, minute_of_day, speed, deg):
        t = datetime(2018, 11, 8, 0, 0, tzinfo=UTC) + timedelta(minutes=minute_of_day)
        return W.RawObs(t, speed, deg, None, None, None)

    def test_nearest_hour_binning_in_utc(self):
        # 00:47 and 01:13 both belong to the 01:00 bin; 00:29 belongs to 00:00
        s = W.hourly_series(
            [self.obs(29, 2.0, 90.0), self.obs(47, 4.0, 90.0), self.obs(73, 6.0, 90.0)],
            datetime(2018, 11, 8, 0, tzinfo=UTC),
            datetime(2018, 11, 8, 2, tzinfo=UTC),
        )
        self.assertEqual([x.t_utc for x in s], ["2018-11-08T00:00:00Z", "2018-11-08T01:00:00Z", "2018-11-08T02:00:00Z"])
        self.assertAlmostEqual(s[0].speed_ms, 2.0)
        self.assertAlmostEqual(s[1].speed_ms, 5.0)
        self.assertEqual(s[1].n_obs, 2)
        self.assertIsNone(s[2].speed_ms)  # a gap stays a gap

    def test_vector_mean_direction(self):
        # 350 and 10 degrees average to north, not to 180
        s = W.hourly_series(
            [self.obs(55, 5.0, 350.0), self.obs(65, 5.0, 10.0)],
            datetime(2018, 11, 8, 1, tzinfo=UTC),
            datetime(2018, 11, 8, 1, tzinfo=UTC),
        )
        self.assertLess(abs(W.angle_diff(s[0].from_deg, 0.0)), 1e-6)

    def test_opposed_winds_have_no_direction(self):
        s = W.hourly_series(
            [self.obs(55, 5.0, 90.0), self.obs(65, 5.0, 270.0)],
            datetime(2018, 11, 8, 1, tzinfo=UTC),
            datetime(2018, 11, 8, 1, tzinfo=UTC),
        )
        self.assertIsNone(s[0].from_deg)

    def test_camp_day_jarbo_gap_observed_wind(self):
        http = FakeHttp()
        st = [s for s in load_fixture_catalog() if s.id == "JBGC1"][0]
        with tempfile.TemporaryDirectory() as d:
            series = W.fetch_history(
                st, datetime(2018, 11, 8, tzinfo=UTC), datetime(2018, 11, 9, tzinfo=UTC),
                http_get=http, cache_dir=Path(d),
            )
        self.assertEqual(series.evidence_class, W.OBSERVED)
        self.assertEqual(len(series.samples), 25)
        peak = max(series.samples, key=lambda s: s.speed_ms)
        self.assertEqual(peak.t_utc, "2018-11-08T12:00:00Z")  # 04:00 PST, before ignition
        self.assertAlmostEqual(peak.speed_ms, 14.3, delta=0.1)
        self.assertLess(abs(W.angle_diff(peak.from_deg, 38.0)), 3.0)  # north-northeast
        self.assertGreater(max(s.gust_ms for s in series.samples), 23.0)


class Stations(unittest.TestCase):
    def test_nearest_order_and_distance(self):
        near = W.nearest_stations(CAMP_LON, CAMP_LAT, 3, catalog=load_fixture_catalog())
        self.assertEqual([s.id for s in near], ["JBGC1", "CSTC1", "CIC"])
        self.assertTrue(all(a.distance_km <= b.distance_km for a, b in zip(near, near[1:])))
        self.assertAlmostEqual(near[0].distance_km, 12.6, delta=0.3)

    def test_source_filter_and_k(self):
        cat = load_fixture_catalog()
        asos = W.nearest_stations(CAMP_LON, CAMP_LAT, 2, catalog=cat, sources=["iem_asos"])
        self.assertEqual([s.id for s in asos], ["CIC", "OVE"])
        self.assertEqual(len(W.nearest_stations(CAMP_LON, CAMP_LAT, 50, catalog=cat)), len(cat))

    def test_archive_window_excludes_stations(self):
        cat = load_fixture_catalog()
        old = W.nearest_stations(CAMP_LON, CAMP_LAT, 20, catalog=cat, at=datetime(2005, 1, 1, tzinfo=UTC))
        ids = {s.id for s in old}
        self.assertNotIn("JBGC1", ids)  # RAWS archive starts 2010-12
        self.assertIn("OVE", ids)  # OVE archive starts 1998
        older = W.nearest_stations(CAMP_LON, CAMP_LAT, 20, catalog=cat, at=datetime(1990, 1, 1, tzinfo=UTC))
        self.assertEqual({s.id for s in older} - {"CIC", "RBL", "STS", "APC"}, set())

    def test_coordinates_are_lon_lat(self):
        with self.assertRaises(ValueError):
            W.nearest_stations(39.8, -121.6, 1, catalog=load_fixture_catalog())  # (lat, lon) swapped


class DiskCache(unittest.TestCase):
    def test_cache_records_size_sha_and_reuses(self):
        http = FakeHttp()
        st = [s for s in load_fixture_catalog() if s.id == "CIC"][0]
        with tempfile.TemporaryDirectory() as d:
            kw = dict(http_get=http, cache_dir=Path(d))
            a = W.fetch_history(st, datetime(2018, 11, 8, tzinfo=UTC), datetime(2018, 11, 9, tzinfo=UTC), **kw)
            b = W.fetch_history(st, datetime(2018, 11, 8, tzinfo=UTC), datetime(2018, 11, 9, tzinfo=UTC), **kw)
            self.assertEqual(len(http.calls), 1)
            raw = a.provenance["raw"]
            body = (FIX / "camp_cic_asos.csv").read_bytes()
            self.assertEqual(raw["bytes"], len(body))
            self.assertEqual(raw["sha256"], hashlib.sha256(body).hexdigest())
            self.assertFalse(raw["from_cache"])
            self.assertTrue(b.provenance["raw"]["from_cache"])
            # corrupt the cached file: size/hash no longer match, so it is fetched again
            (Path(d) / raw["file"]).write_bytes(b"garbage")
            W.fetch_history(st, datetime(2018, 11, 8, tzinfo=UTC), datetime(2018, 11, 9, tzinfo=UTC), **kw)
            self.assertEqual(len(http.calls), 2)
            index = json.loads((Path(d) / "index.json").read_text())
            self.assertEqual(index[raw["file"]]["sha256"], raw["sha256"])

    def test_default_cache_is_outside_repo(self):
        repo = Path(__file__).resolve().parents[1]
        self.assertNotIn(repo, W.default_cache_dir().resolve().parents)


class ScenarioWindHistorical(unittest.TestCase):
    def test_historical_replay_picks_nearest_adequate_station(self):
        with tempfile.TemporaryDirectory() as d:
            r = W.scenario_wind(
                CAMP_LON, CAMP_LAT, "2018-11-08T00:00:00Z", 24, "historical_replay",
                catalog=load_fixture_catalog(), http_get=FakeHttp(), cache_dir=Path(d),
            )
        self.assertEqual(r["evidence_class"], "observed")
        self.assertEqual(r["station"]["id"], "JBGC1")
        self.assertEqual(r["summary"]["missing_speed_samples"], 0)
        self.assertEqual(len(r["samples"]), 25)
        self.assertEqual(r["units"]["time"], "UTC, hourly bin centre")
        self.assertIn("terms", r["provenance"])
        self.assertEqual(r["provenance"]["candidates"][0]["station"], "JBGC1")

    def test_falls_back_when_nearest_has_no_data(self):
        empty = lambda url: b"station,utc_valid,PCIRGZ\n"  # RAWS relayed nothing for the window
        with tempfile.TemporaryDirectory() as d:
            r = W.scenario_wind(
                CAMP_LON, CAMP_LAT, "2018-11-08T00:00:00Z", 24, "historical_replay",
                catalog=load_fixture_catalog(), http_get=FakeHttp({"JBGC1": empty, "CSTC1": empty}),
                cache_dir=Path(d), k=3,
            )
        self.assertEqual(r["station"]["id"], "CIC")
        cands = r["provenance"]["candidates"]
        self.assertEqual([c["station"] for c in cands], ["JBGC1", "CSTC1", "CIC"])
        self.assertEqual(cands[0]["coverage"], 0.0)

    def test_requires_aware_start_and_known_mode(self):
        with self.assertRaises(ValueError):
            W.scenario_wind(CAMP_LON, CAMP_LAT, datetime(2018, 11, 8), 24, "historical_replay")
        with self.assertRaises(ValueError):
            W.scenario_wind(CAMP_LON, CAMP_LAT, "2018-11-08T00:00:00Z", 24, "persistence")


class Climatology(unittest.TestCase):
    def sample(self, speed, deg):
        return W.HourlySample("2018-11-08T00:00:00Z", speed, deg, None, None, None)

    def test_nearest_rank_percentile(self):
        vals = list(range(1, 21))  # 1..20
        self.assertEqual(W.percentile_nearest_rank(vals, 95), 19)
        self.assertEqual(W.percentile_nearest_rank(vals, 100), 20)
        self.assertEqual(W.percentile_nearest_rank(vals, 50), 10)
        self.assertEqual(W.percentile_nearest_rank([7.0], 95), 7.0)
        with self.assertRaises(ValueError):
            W.percentile_nearest_rank([], 95)
        with self.assertRaises(ValueError):
            W.percentile_nearest_rank(vals, 0)

    def test_sector_wraps_through_north(self):
        self.assertTrue(W.in_sector(350.0, (315.0, 90.0)))
        self.assertTrue(W.in_sector(45.0, (315.0, 90.0)))
        self.assertFalse(W.in_sector(180.0, (315.0, 90.0)))
        self.assertFalse(W.in_sector(None, (315.0, 90.0)))
        self.assertTrue(W.in_sector(100.0, (90.0, 180.0)))  # non-wrapping arc

    def test_find_episodes(self):
        # 8 h north wind peaking at 9, a 2 h blip (too short), 7 h northeast peaking at 12
        s = [self.sample(6, 0)] * 3 + [self.sample(9, 0)] + [self.sample(6, 0)] * 4
        s += [self.sample(1, 0)] * 3  # calm gap
        s += [self.sample(7, 0)] * 2
        s += [self.sample(1, 0)] * 3
        s += [self.sample(8, 45)] * 3 + [self.sample(12, 45)] + [self.sample(8, 45)] * 3
        s += [self.sample(20, 200)] * 10  # strong but from the south: not an offshore event
        eps = W.find_episodes(s)
        self.assertEqual([(e[0], e[1], e[2]) for e in eps], [(0, 8, 9), (16, 7, 12)])

    def test_select_percentile_episode_is_a_real_episode(self):
        eps = [(0, 8, 6.0), (30, 9, 7.0), (60, 7, 8.0), (90, 6, 9.0), (120, 12, 15.0)]
        # nearest-rank P95 of 5 peaks is the 5th (largest); P50 is the 3rd
        self.assertEqual(W.select_percentile_episode(eps, 95), (120, 12, 15.0))
        self.assertEqual(W.select_percentile_episode(eps, 50), (60, 7, 8.0))
        with self.assertRaises(W.WeatherError):
            W.select_percentile_episode([], 95)

    def test_end_to_end_derived_analog(self):
        """Five synthetic Novembers; the strongest event (2016) is the P95 analog."""

        def year_csv(year, peak_kt):
            rows = ["station,valid,tmpf,relh,drct,sknt,gust"]
            for h in range(10):
                kt = peak_kt - abs(h - 4)  # rises then falls, peak at hour 4
                rows.append(f"CIC,{year}-11-05 {h:02d}:53,60,15,360,{kt},M")
            return "\n".join(rows) + "\n"

        def serve(url):
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
            year = int(qs["sts"][0][:4])
            return year_csv(year, 12 + (year - 2012) * 2).encode()

        with tempfile.TemporaryDirectory() as d:
            r = W.scenario_wind(
                CAMP_LON, CAMP_LAT, "2030-11-06T00:00:00Z", 12, "climatology_percentile",
                catalog=load_fixture_catalog(), http_get=FakeHttp({"CIC": serve}), cache_dir=Path(d),
            )
        self.assertEqual(r["evidence_class"], "derived")
        self.assertEqual(r["provenance"]["analog"]["year"], 2025)  # default window ends 2025; strongest
        self.assertEqual(r["samples"][0]["t_utc"], "2030-11-06T00:00:00Z")  # relabelled to start
        self.assertAlmostEqual(r["summary"]["max_speed_ms"], (12 + 13 * 2) * W.KNOT_MS, places=6)
        self.assertEqual(r["provenance"]["n_episodes"], 13)  # 2012 peaks too low to count as an event
        self.assertIn("chosen statistically", r["provenance"]["analog"]["note"])


class Forecast(unittest.TestCase):
    def test_gridpoint_units_and_hour_expansion(self):
        doc = json.loads(fixture_text("nws_gridpoint_STO_47_121.json"))
        s = W.parse_gridpoint(doc, datetime(2026, 10, 24, 3, tzinfo=UTC), 6)
        self.assertEqual(len(s), 7)
        # 12.964 km/h valid for PT3H from 03:00Z covers 03, 04 and 05
        for i in range(3):
            self.assertAlmostEqual(s[i].speed_ms, 12.964 / 3.6, places=6)
        self.assertAlmostEqual(s[0].gust_ms, 24.076 / 3.6, places=6)
        self.assertEqual(s[0].from_deg, 30.0)  # already a "from" bearing, no flip
        self.assertEqual(s[0].rh_pct, 38.0)
        self.assertAlmostEqual(s[0].temp_c, 14.4444, places=3)  # already Celsius
        self.assertAlmostEqual(s[3].speed_ms, 11.112 / 3.6, places=6)  # 06:00Z, PT1H

    def test_iso_durations(self):
        self.assertEqual(W.parse_iso_duration("PT3H"), timedelta(hours=3))
        self.assertEqual(W.parse_iso_duration("P1DT6H"), timedelta(days=1, hours=6))
        with self.assertRaises(W.WeatherError):
            W.parse_iso_duration("3 hours")

    def test_forecast_mode_is_labelled_and_not_cached(self):
        points = json.dumps(
            {"properties": {"forecastGridData": "https://api.weather.gov/gridpoints/STO/47,121"}}
        ).encode()
        grid = (FIX / "nws_gridpoint_STO_47_121.json").read_bytes()
        calls = []

        def http(url, headers=None):
            calls.append((url, headers))
            return points if "/points/" in url else grid

        r = W.scenario_wind(CAMP_LON, 39.76, "2026-10-24T03:00:00Z", 6, "forecast", http_get=http)
        self.assertEqual(r["evidence_class"], "forecast")
        self.assertIsNone(r["station"])
        self.assertEqual(r["provenance"]["sha256"], hashlib.sha256(grid).hexdigest())
        self.assertIn("39.7600", calls[0][0])
        self.assertEqual(calls[0][0].split("/points/")[1], "39.7600,-121.6000")


class ForecastError(unittest.TestCase):
    ISSUED = datetime(2018, 11, 8, 13, 56, tzinfo=UTC)

    def parsed(self):
        return FE.parse_fwf(fixture_text("fwf_sto_20181108_1356_excerpt.txt"), self.ISSUED)

    def test_parse_valley_zone(self):
        rows = [r for r in self.parsed() if r.zone == "CAZ216" and r.period == "TODAY"]
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual(r.from_deg, 315.0)
        self.assertAlmostEqual(r.speed_lo_ms, 16 * W.MPH_MS, places=6)
        self.assertAlmostEqual(r.speed_hi_ms, 28 * W.MPH_MS, places=6)
        self.assertAlmostEqual(r.gust_ms, 50 * W.MPH_MS, places=6)
        self.assertFalse(r.multi_phase)

    def test_period_windows_in_utc(self):
        r = [x for x in self.parsed() if x.zone == "CAZ216"]
        by = {x.period: x for x in r}
        # issued 05:56 PST: TODAY runs to 18:00 PST = 02:00Z next day; TONIGHT to 06:00 PST = 14:00Z
        self.assertEqual(by["TODAY"].window_start_utc, "2018-11-08T13:56:00Z")
        self.assertEqual(by["TODAY"].window_end_utc, "2018-11-09T02:00:00Z")
        self.assertEqual(by["TONIGHT"].window_end_utc, "2018-11-09T14:00:00Z")
        self.assertEqual(by["FRIDAY"].window_end_utc, "2018-11-10T02:00:00Z")

    def test_ridge_and_valley_subareas_and_multiphase(self):
        rows = {(r.period, r.sub_area): r for r in self.parsed() if r.zone == "CAZ266"}
        today = rows[("TODAY", "ridge")]
        self.assertEqual(today.from_deg, 45.0)
        self.assertTrue(today.multi_phase)  # "decreasing to 13 to 19 mph ... in the afternoon"
        tonight = rows[("TONIGHT", "ridge")]
        self.assertEqual(tonight.from_deg, 45.0)
        self.assertAlmostEqual(tonight.speed_hi_ms, 19 * W.MPH_MS, places=6)
        self.assertEqual(rows[("TONIGHT", "valley")].from_deg, 45.0)

    def test_compare_chico_against_valley_forecast(self):
        st = [s for s in load_fixture_catalog() if s.id == "CIC"][0]
        obs = W.parse_asos_csv(fixture_text("camp_cic_asos.csv"))
        series = W.series_from_obs(st, obs, datetime(2018, 11, 8, tzinfo=UTC), datetime(2018, 11, 9, tzinfo=UTC), None)
        fc = [r for r in self.parsed() if r.zone == "CAZ216" and r.period == "TODAY"][0]
        row = FE.compare(fc, series, self.ISSUED, datetime(2018, 11, 8, 14, 29, tzinfo=UTC))
        self.assertTrue(row["window_contains_ignition"])
        # Chico observed north-westerly, well below the zone range's midpoint
        self.assertLess(abs(row["dir_error_deg"]), 30)
        self.assertLess(row["speed_ratio"], 1.0)
        self.assertEqual(row["lead_h"], 0.0)

    def test_summarise_excludes_multiphase_and_light_wind_direction(self):
        base = {"multi_phase": False, "dir_valid": True, "dir_error_deg": 10, "speed_error_ms": -1.0,
                "speed_ratio": 0.5, "hours_in_forecast_range": 0.2, "gust_ratio": None}
        rows = [
            dict(base),
            dict(base, dir_error_deg=-30, speed_error_ms=-3.0, speed_ratio=0.25),
            dict(base, multi_phase=True, dir_error_deg=170),
            dict(base, dir_valid=False, dir_error_deg=100),  # light wind: direction is noise
        ]
        s = FE.summarise(rows)
        self.assertEqual(s["n_excluded_multi_phase"], 1)
        self.assertEqual(s["n_direction_comparisons"], 2)
        self.assertEqual(s["dir_error_deg"]["mean_signed"], -10.0)
        self.assertEqual(s["dir_error_deg"]["mean_abs"], 20.0)


if __name__ == "__main__":
    unittest.main()
