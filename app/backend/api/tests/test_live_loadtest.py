"""Stats maths of the load-test command, the guidance render/cache, and the rate-limit switch.

No MongoDB needed: everything here is pure or mocked.
"""

from __future__ import annotations

from datetime import UTC, datetime
from unittest import mock

from django.core.cache import cache
from django.core.management.base import CommandError
from django.test import SimpleTestCase, override_settings

from api.live import auth, state
from api.management.commands import live_loadtest as lt


class StatsTest(SimpleTestCase):
    def test_percentile_interpolates(self):
        data = [10.0, 20.0, 30.0, 40.0, 50.0]
        self.assertEqual(lt.percentile(data, 0), 10.0)
        self.assertEqual(lt.percentile(data, 50), 30.0)
        self.assertEqual(lt.percentile(data, 100), 50.0)
        self.assertAlmostEqual(lt.percentile(data, 95), 48.0)
        self.assertAlmostEqual(lt.percentile(data, 25), 20.0)
        self.assertAlmostEqual(lt.percentile([0.0, 10.0], 99), 9.9)

    def test_percentile_edge_cases(self):
        self.assertEqual(lt.percentile([], 95), 0.0)
        self.assertEqual(lt.percentile([7.0], 99), 7.0)
        self.assertEqual(lt.percentile([5.0, 1.0, 3.0], 50), 3.0)  # unsorted input

    def test_summarize_counts_errors_and_rates(self):
        samples = [("200", 10.0)] * 90 + [("429", 100.0)] * 5 + [("timeout", 2000.0)] * 5
        s = lt.summarize(samples, seconds=10.0)
        self.assertEqual(s["n"], 100)
        self.assertEqual(s["rps"], 10.0)
        self.assertEqual(s["status"], {"200": 90, "429": 5, "timeout": 5})
        self.assertEqual(s["error_rate"], 0.1)
        self.assertEqual(s["p50_ms"], 10.0)
        self.assertEqual(s["max_ms"], 2000.0)
        self.assertGreater(s["p99_ms"], s["p95_ms"])

    def test_summarize_empty(self):
        s = lt.summarize([], seconds=5.0)
        self.assertEqual((s["n"], s["rps"], s["error_rate"], s["p95_ms"]), (0, 0.0, 0.0, 0.0))

    def test_is_error(self):
        self.assertFalse(lt.is_error("200"))
        self.assertFalse(lt.is_error("204"))
        self.assertTrue(lt.is_error("400"))
        self.assertTrue(lt.is_error("503"))
        self.assertTrue(lt.is_error("error"))

    def test_ramp(self):
        self.assertEqual(lt.default_ramp(200), [10, 50, 100, 200])
        self.assertEqual(lt.default_ramp(1), [1])
        self.assertEqual(lt.parse_ramp("10, 50,100"), [10, 50, 100])
        for bad in ("", "a,b", "50,10", "0,5"):
            with self.assertRaises(CommandError):
                lt.parse_ramp(bad)

    def test_should_stop(self):
        ok = {"p95_ms": 1999.0, "error_rate": 0.01}
        self.assertIsNone(lt.should_stop(ok, 2000.0, 0.01))
        self.assertIn("p95", lt.should_stop({"p95_ms": 2001.0, "error_rate": 0.0}, 2000.0, 0.01))
        self.assertIn("error rate", lt.should_stop({"p95_ms": 5.0, "error_rate": 0.02}, 2000.0, 0.01))

    def test_endpoint_name_drops_incident_and_keeps_query(self):
        self.assertEqual(lt.endpoint_name("GET", "incidents/camp-2018-drill/situation?zones=0"), "GET situation?zones=0")
        self.assertEqual(lt.endpoint_name("GET", "incidents/camp-2018-drill/situation"), "GET situation")
        self.assertEqual(lt.endpoint_name("POST", "me/location"), "POST me/location")

    def test_recorder_keys_by_stage(self):
        rec = lt.Recorder()
        rec.stage = 1
        rec.add("GET x", "200", 5.0)
        rec.stage = 2
        rec.add("GET x", "200", 7.0)
        self.assertEqual(rec.samples[1]["GET x"], [("200", 5.0)])
        self.assertEqual(rec.samples[2]["GET x"], [("200", 7.0)])


class RateLimitSwitchTest(SimpleTestCase):
    def setUp(self):
        cache.clear()

    def test_limits_apply_by_default(self):
        self.assertFalse(auth.rate_limited("t-default", 1, 60))
        self.assertTrue(auth.rate_limited("t-default", 1, 60))

    @override_settings(LIVE_LOADTEST_RELAX_LIMITS=True)
    def test_relaxed_for_load_tests(self):
        for _ in range(50):
            self.assertFalse(auth.rate_limited("t-relaxed", 1, 60))


class GuidanceRenderTest(SimpleTestCase):
    def setUp(self):
        state.invalidate_guidance()

    def test_render_matches_the_documented_conversion(self):
        at = datetime(2018, 11, 8, 16, 30, tzinfo=UTC)
        doc = {"_id": 1, "a": at, "b": (1.5, 2), "c": [{"d": at, "e": None, "f": True}], "g": "x"}
        self.assertEqual(
            state.render(doc),
            {"a": "2018-11-08T16:30:00Z", "b": [1.5, 2], "c": [{"d": "2018-11-08T16:30:00Z", "e": None, "f": True}], "g": "x"},
        )
        # Only the top level drops keys.
        self.assertEqual(state.render({"x": {"_id": 2}}, drop=("x",)), {})
        self.assertEqual(state.render({"x": {"_id": 2}}), {"x": {"_id": 2}})

    def test_guidance_cache_hits_then_expires_and_invalidates(self):
        docs = [{"_id": 1, "incident_id": "i", "zone_id": "z1", "version": 1}]
        with mock.patch.object(state, "current_guidance", return_value=docs) as read:
            first = state.rendered_guidance("i", mock.sentinel.index)
            self.assertEqual(state.rendered_guidance("i", mock.sentinel.index), first)
            self.assertEqual(read.call_count, 1)
            self.assertEqual(first, [{"zone_id": "z1", "version": 1, "caveat": None, "alternatives": []}])
            state.invalidate_guidance("i")
            state.rendered_guidance("i", mock.sentinel.index)
            self.assertEqual(read.call_count, 2)
            with mock.patch.object(state.time, "monotonic", return_value=state.time.monotonic() + 5):
                state.rendered_guidance("i", mock.sentinel.index)
            self.assertEqual(read.call_count, 3)

    @override_settings(LIVE_GUIDANCE_CACHE_TTL_S=0)
    def test_cache_can_be_turned_off(self):
        with mock.patch.object(state, "current_guidance", return_value=[]) as read:
            state.rendered_guidance("i", mock.sentinel.index)
            state.rendered_guidance("i", mock.sentinel.index)
            self.assertEqual(read.call_count, 2)
