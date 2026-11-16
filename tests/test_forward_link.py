import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import forward_link as fl  # noqa: E402
import model  # noqa: E402

THROUGH, FWD = pd.Timestamp("2025-11-02"), pd.Timestamp("2025-11-20")


def series(seed=0, snpp_out=(), n20_out=(), n21_out=()):
    rng = np.random.default_rng(seed)
    rows = []
    for day in pd.date_range("2018-01-01", FWD):
        rate = 40 * (1.2 + np.sin(2 * np.pi * (day.dayofyear - 100) / 365))
        for dn, f in (("D", 1.0), ("N", 0.5)):
            r = rate * f
            v = rng.poisson(0.9 * r) if day <= THROUGH and day.strftime("%Y-%m-%d") not in snpp_out else 0
            a = rng.poisson(r) if day >= fl.N20_START and day.strftime("%Y-%m-%d") not in n20_out else 0
            b = rng.poisson(r / 1.2) if day >= fl.N21_START and day.strftime("%Y-%m-%d") not in n21_out else 0
            rows.append((day, dn, v, a, b))
    return pd.DataFrame(rows, columns=["date", "daynight", "viirs_n", "n20_n", "n21_n"])


class ForwardLinkTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.d = series(snpp_out=("2022-08-01", "2022-08-02"), n20_out=("2025-11-10",), n21_out=("2025-11-12",))
        cls.f = fl.run_forward(cls.d, THROUGH, FWD, 50, np.random.default_rng(1))

    def test_nothing_to_forward(self):
        self.assertIsNone(fl.run_forward(self.d, THROUGH, THROUGH, 5, np.random.default_rng(0)))

    def test_recovers_ratio_and_scale(self):
        s = self.f["score"]
        self.assertAlmostEqual(s["ratio_day"], 0.9, delta=0.02)
        self.assertAlmostEqual(s["ratio_night"], 0.9, delta=0.03)
        self.assertAlmostEqual(s["n21_scale_day"], 1.2, delta=0.03)
        self.assertLess(s["mape_month"], 5)
        self.assertGreaterEqual(s["coverage_month"], 0.8 * s["n_month"])
        self.assertEqual((s["n_year"], s["coverage_year"]), (1, 1))

    def test_forward_days_and_band(self):
        f = self.f
        self.assertEqual(list(f["dates"]), list(pd.date_range("2025-11-03", FWD)))
        self.assertEqual(f["pred"].shape, (18,))
        self.assertEqual(f["draws"].shape, (50, 18))
        lo, hi = np.percentile(f["draws"], [5, 95], axis=0)
        self.assertTrue(np.all(lo <= f["pred"]) and np.all(f["pred"] <= hi))
        g = self.d[self.d.date > THROUGH].groupby("date").n20_n.sum().values
        self.assertAlmostEqual(f["pred"].sum() / g.sum(), 0.9, delta=0.08)

    def test_outages(self):
        s, f = self.f["score"], self.f
        self.assertEqual(s["outage_days_forward"], ["2025-11-10", "2025-11-12"])
        i10, i12 = [(pd.Timestamp(t) - pd.Timestamp("2025-11-03")).days for t in ("2025-11-10", "2025-11-12")]
        self.assertGreater(f["pred"][i10], 20)
        self.assertGreater(f["pred"][i12], 20)
        g = fl.region_days(self.d, FWD)
        sn, n20, n21 = fl.outages(g, THROUGH)
        self.assertEqual(sorted(set(g.date[sn].dt.strftime("%Y-%m-%d"))), ["2022-08-01", "2022-08-02"])
        self.assertEqual(sorted(set(g.date[n20].dt.strftime("%Y-%m-%d"))), ["2025-11-10"])
        self.assertEqual(sorted(set(g.date[n21].dt.strftime("%Y-%m-%d"))), ["2025-11-12"])

    def test_exposure_averages_from_2024(self):
        g = fl.region_days(self.d, FWD)
        x, k, _ = fl.exposure(g, THROUGH, FWD)
        pre = (g.date < fl.N21_START).values
        np.testing.assert_array_equal(x[pre], g.n20_n.values[pre])
        i = np.flatnonzero((g.date == "2025-06-01").values & (g.daynight == "D").values)[0]
        self.assertAlmostEqual(x[i], (g.n20_n[i] + k["D"] * g.n21_n[i]) / 2)

    def test_forward_through(self):
        s = {"n20": {"data_through": "2026-11-14"}, "n21": {"data_through": "2026-11-12"}}
        self.assertEqual(model.forward_through(s, "2026-11-02"), pd.Timestamp("2026-11-12"))
        self.assertIsNone(model.forward_through(s, "2026-11-14"))
        self.assertIsNone(model.forward_through({}, "2026-11-02"))


if __name__ == "__main__":
    unittest.main()
