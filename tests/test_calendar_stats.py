import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np  # noqa: E402
from calendar_stats import calendar_block  # noqa: E402

NAN = float("nan")


def years(*rows):
    out = []
    for r in rows:
        out.extend(r)
    return out


def const(v):
    return [v] * 12


class CalendarTests(unittest.TestCase):
    def test_hand_computed_stats(self):
        h = years([m * 10 for m in range(1, 13)], [m * 20 for m in range(1, 13)],
                  [m * 30 for m in range(1, 13)])
        c = calendar_block(h, 2001, (2001, 2003))
        self.assertEqual(c["baseline_years"], [2001, 2003])
        for m in range(12):
            k = m + 1
            self.assertEqual(c["month_median"][m], 20 * k)
            self.assertEqual(c["month_p25"][m], 15 * k)
            self.assertEqual(c["month_p75"][m], 25 * k)
        self.assertEqual(c["anomaly"][:2], [0.5, 0.5])
        self.assertEqual(c["anomaly"][24], 1.5)

    def test_lengths_and_lists(self):
        c = calendar_block(const(5) * 3, 2001)
        self.assertEqual(set(c), {"baseline_years", "month_median", "month_p25",
                                  "month_p75", "anomaly", "flag"})
        for k in ("month_median", "month_p25", "month_p75"):
            self.assertEqual(len(c[k]), 12)
        self.assertEqual(len(c["anomaly"]), 36)
        self.assertEqual(len(c["flag"]), 36)

    def test_zero_median_month(self):
        h = const(0) * 3 + [25] + [0] * 11
        c = calendar_block(h, 2001, (2001, 2003))
        self.assertEqual(c["month_median"][0], 0)
        self.assertIsNone(c["anomaly"][0])
        self.assertEqual(c["flag"][0], 0)
        self.assertIsNone(c["anomaly"][36])
        self.assertEqual(c["flag"][36], 1)

    def test_partial_trailing_year(self):
        h = const(10) * 2 + [10, 10, 100, 1]
        c = calendar_block(h, 2001, (2001, 2025))
        self.assertEqual(c["month_median"], [10.0] * 12)
        self.assertEqual(len(c["anomaly"]), 28)
        self.assertEqual(c["anomaly"][26], 10.0)
        self.assertEqual(c["flag"][24:], [0, 0, 1, 0])
        self.assertEqual(c["anomaly"][27], 0.1)

    def test_partial_year_excluded_from_baseline(self):
        h = const(10) + [1000] * 5
        c = calendar_block(h, 2001)
        self.assertEqual(c["month_median"], [10.0] * 12)

    def test_outside_baseline_excluded_but_scored(self):
        h = const(1000) + const(10) + const(10) + const(100)
        c = calendar_block(h, 2000, (2001, 2002))
        self.assertEqual(c["month_median"], [10.0] * 12)
        self.assertEqual(c["flag"][:12], [1] * 12)
        self.assertEqual(c["flag"][36:], [1] * 12)
        self.assertEqual(c["anomaly"][36], 10.0)

    def test_missing_makes_year_incomplete(self):
        bad = const(500)
        bad[3] = None
        bad2 = const(500)
        bad2[7] = NAN
        for b in (bad, bad2):
            c = calendar_block(const(10) + b, 2001)
            self.assertEqual(c["month_median"], [10.0] * 12)
        h = const(10) + bad
        c = calendar_block(h, 2001)
        self.assertIsNone(c["anomaly"][12 + 3])
        self.assertEqual(c["flag"][12 + 3], 0)
        self.assertEqual(c["flag"][12], 1)

    def test_all_years_incomplete_raises(self):
        with self.assertRaises(ValueError):
            calendar_block(const(1)[:11], 2001)
        with self.assertRaises(ValueError):
            calendar_block([None] + [1] * 11, 2001)
        with self.assertRaises(ValueError):
            calendar_block(const(1), 2001, (2005, 2010))

    def _flag(self, base, v):
        h = []
        for b in base:
            h += const(b)
        h += [v]
        return calendar_block(h, 2001, (2001, 2000 + len(base)))["flag"][-1]

    def test_high_flag_boundaries(self):
        base = [80, 100, 120, 140, 100]
        self.assertEqual(self._flag(base, 200), 1)
        self.assertEqual(self._flag(base, 199.9), 0)
        self.assertEqual(self._flag([10] * 3, 30), 1)
        self.assertEqual(self._flag([10] * 3, 29.9), 0)
        self.assertEqual(self._flag([0] * 3, 20), 1)
        self.assertEqual(self._flag([0] * 3, 19.9), 0)

    def test_low_flag_boundaries(self):
        base = [60, 100, 100, 100, 140]
        self.assertEqual(self._flag(base, 50), -1)
        self.assertEqual(self._flag(base, 50.1), 0)
        self.assertEqual(self._flag([30] * 3, 10), -1)
        self.assertEqual(self._flag([30] * 3, 10.1), 0)
        self.assertEqual(self._flag([100] * 3, 50.1), 0)

    def test_plain_json_types(self):
        h = [float(i % 7) * 3 for i in range(40)]
        h[5] = NAN
        h[30] = None
        c = calendar_block(h, 2001, (2001, 2003))
        json.dumps(c, allow_nan=False)

        def walk(x):
            if isinstance(x, list):
                for y in x:
                    walk(y)
            else:
                self.assertIn(type(x), (int, float, type(None)))
        walk(list(c.values()))
        self.assertTrue(all(type(x) is int for x in c["flag"]))
        self.assertTrue(all(type(x) is int for x in c["baseline_years"]))
        self.assertEqual(c["flag"][5], 0)

    def test_rounding(self):
        c = calendar_block([1 / 3] * 12 + [1] * 12, 2001, (2001, 2001))
        self.assertEqual(c["month_median"][0], 0.333)
        self.assertEqual(c["anomaly"][12], 3.003)
        c = calendar_block([3.0] * 12 + [1.0] * 12, 2001, (2001, 2001))
        self.assertEqual(c["anomaly"][12], 0.3333)

    def test_self_consistent_after_rounding(self):
        c = calendar_block([0.0004] * 12 + [5.0] * 12, 2001, (2001, 2001))
        self.assertEqual(c["month_median"][0], 0.0)
        self.assertIsNone(c["anomaly"][12])
        json.dumps(c, allow_nan=False)

    def test_percentile_linear(self):
        h = []
        for v in (1, 2, 3, 10):
            h += const(v)
        c = calendar_block(h, 2001, (2001, 2004))
        self.assertEqual(c["month_p25"][0], 1.75)
        self.assertEqual(c["month_median"][0], 2.5)
        self.assertEqual(c["month_p75"][0], 4.75)

    def test_p75_alone_decides_high(self):
        base = [0, 0, 100, 100]
        self.assertEqual(self._flag(base, 100), 0)
        self.assertEqual(self._flag(base, 100.1), 1)

    def test_p25_alone_decides_low(self):
        base = [40, 40, 100, 100, 100]
        self.assertEqual(self._flag(base, 40), 0)
        self.assertEqual(self._flag(base, 39.9), -1)

    def test_numpy_input_plain_types(self):
        f32 = np.array([float(i % 5) for i in range(24)], dtype=np.float32)
        obj = np.array([float(i % 5) for i in range(24)], dtype=object)
        obj[3] = None
        for a in (f32, obj):
            c = calendar_block(a, 2001, (2001, 2002))
            json.dumps(c, allow_nan=False)
            for k in ("month_median", "month_p25", "month_p75", "anomaly"):
                self.assertTrue(all(type(x) in (float, type(None)) for x in c[k]), k)
            self.assertTrue(all(type(x) is int for x in c["flag"]))

    def test_start_year_after_baseline_raises(self):
        with self.assertRaises(ValueError):
            calendar_block(const(1) * 2, 2030, (2001, 2025))

    def test_invalid_values_raise(self):
        for bad in (-1.0, float("inf"), float("-inf")):
            h = const(1)
            h[4] = bad
            with self.assertRaises(ValueError):
                calendar_block(h, 2001)


if __name__ == "__main__":
    unittest.main()
