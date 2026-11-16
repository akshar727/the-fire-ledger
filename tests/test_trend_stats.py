import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from trend_stats import slope_pct, trend, trend_block  # noqa: E402

YEARS = list(range(2001, 2026))


def line(pct, base=1000.0):
    return [base * (1 + pct / 100 * (y - 2013)) for y in YEARS]


class TrendTests(unittest.TestCase):
    def test_known_slope(self):
        t = trend(YEARS, line(2.0))
        self.assertEqual(t["slope_pct"], 2.0)
        self.assertEqual((t["lo_pct"], t["hi_pct"]), (2.0, 2.0))
        self.assertLess(t["p"], 1e-6)
        self.assertEqual(trend(YEARS, line(-3.0))["slope_pct"], -3.0)

    def test_robust_to_one_outlier(self):
        y = line(2.0)
        y[5] *= 10
        t = trend(YEARS, y)
        self.assertAlmostEqual(t["slope_pct"], 2.0, delta=0.2)
        self.assertLessEqual(t["lo_pct"], t["slope_pct"])
        self.assertGreaterEqual(t["hi_pct"], t["slope_pct"])

    def test_noise_without_trend_is_not_significant(self):
        rng = np.random.default_rng(1)
        t = trend(YEARS, rng.normal(1000, 100, len(YEARS)))
        self.assertGreater(t["p"], 0.1)
        self.assertLess(t["lo_pct"], 0)
        self.assertGreater(t["hi_pct"], 0)

    def test_step_looks_like_a_trend(self):
        y = [100.0 if yr < 2012 else 300.0 for yr in YEARS]
        y = [v + i % 3 for i, v in enumerate(y)]
        t = trend(YEARS, y)
        self.assertGreater(t["slope_pct"], 0)
        self.assertLess(t["p"], 0.01)

    def test_undefined_cases_are_null(self):
        null = {"slope_pct": None, "lo_pct": None, "hi_pct": None, "p": None}
        self.assertEqual(trend(YEARS, [0.0] * 25), null)
        self.assertEqual(trend(YEARS, [5.0] * 25), {"slope_pct": 0.0, "lo_pct": 0.0, "hi_pct": 0.0, "p": 1.0})
        self.assertEqual(trend([2001, 2002], [1.0, 2.0]), null)
        self.assertIsNone(slope_pct(YEARS, [0.0] * 25))


class TrendBlockTests(unittest.TestCase):
    def test_block(self):
        st, har = line(6.0), line(-1.0)
        boot = np.array([line(-1.0 + d) for d in np.linspace(-1, 1, 21)])
        monthly = [10.0 * (1 + 0.02 * (i // 12 - 12)) * (1 + (i % 12 == 9)) for i in range(25 * 12 + 10)]
        b = trend_block(YEARS, st, har, boot, monthly, monthly)
        self.assertEqual(list(b), ["method", "years", "n_years", "interval", "stitched", "harmonized", "monthly"])
        self.assertEqual((b["years"], b["n_years"], b["interval"]), ([2001, 2025], 25, 0.9))
        self.assertEqual(b["stitched"]["slope_pct"], 6.0)
        self.assertEqual(b["harmonized"]["slope_pct"], -1.0)
        self.assertAlmostEqual(b["harmonized"]["boot_lo_pct"], -1.9, places=6)
        self.assertAlmostEqual(b["harmonized"]["boot_hi_pct"], -0.1, places=6)
        for rec in ("stitched", "harmonized"):
            mo = b["monthly"][rec]
            self.assertEqual(list(mo), ["slope_pct", "lo_pct", "hi_pct", "p"])
            self.assertTrue(all(len(v) == 12 for v in mo.values()))
            self.assertEqual(mo["slope_pct"], [2.0] * 12)


if __name__ == "__main__":
    unittest.main()
