"""Tests for weather.py (DP-014): unit tests on synthetic data (no network), plus sanity checks on the
committed site/public/data/<id>/weather.json files (skipped if a file is missing)."""
import json, os, sys, tempfile, unittest, urllib.error
from pathlib import Path
import numpy as np, pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import weather as W

DATA = ROOT / "site" / "public" / "data"


def power_csv(days, start="2000-12-01", fill_tail=0, t=30.0, rh=50.0, rain=0.0, ws=2.0, gw=0.3):
    d0 = pd.Timestamp(start)
    lines = ["-BEGIN HEADER-", "NASA/POWER test", "-END HEADER-", "YEAR,DOY," + ",".join(W.PARAMS)]
    for i in range(days):
        d = d0 + pd.Timedelta(days=i)
        vals = [t, rh, rain, ws, gw] if i < days - fill_tail else [-999.0] * 5
        lines.append(f"{d.year},{d.dayofyear}," + ",".join(str(v) for v in vals))
    return "\n".join(lines) + "\n"


class Formula(unittest.TestCase):
    def test_vpd_known_value(self):
        # es(30 C) = 0.6108 * exp(17.27*30/267.3) = 4.243 kPa; RH 50% -> 2.122
        self.assertAlmostEqual(float(W.vpd_kpa(30.0, 50.0)), 2.1216, places=3)
        self.assertEqual(float(W.vpd_kpa(20.0, 100.0)), 0.0)
        self.assertEqual(float(W.vpd_kpa(20.0, 105.0)), 0.0)   # never negative

    def test_rain_halves_index(self):
        d = W.parse(power_csv(40, rain=0.0))
        d.loc[:, "PRECTOTCORR"] = 0.0
        d.iloc[35, d.columns.get_loc("PRECTOTCORR")] = W.RAIN_HALF_MM
        out = W.daily_index(d)
        self.assertTrue(out["index"].iloc[:29].isna().all())          # no full rain window yet
        dry, wet = out["index"].iloc[34], out["index"].iloc[36]
        self.assertAlmostEqual(wet, dry / 2, places=9)
        self.assertAlmostEqual(dry, float(W.vpd_kpa(30.0, 50.0)) * 2.0, places=9)

    def test_peak7_is_worst_week_ending_in_month(self):
        idx = pd.date_range("2003-07-01", "2003-08-31")
        vpd = pd.Series(1.0, idx)
        vpd["2003-08-01":"2003-08-07"] = 4.0
        p = W.peak7(pd.DataFrame({"vpd": vpd}))
        self.assertAlmostEqual(p[(2003, 8)], 4.0)
        self.assertAlmostEqual(p[(2003, 7)], 1.0)
        # a missing day inside a spell must not let a 7-row window span 8 days
        gap = vpd["2003-08-01":"2003-08-08"].drop(pd.Timestamp("2003-08-04"))   # 7 rows over 8 days
        self.assertEqual(len(W.peak7(pd.DataFrame({"vpd": gap}))), 0)


class Parse(unittest.TestCase):
    def test_fill_becomes_nan_and_dates(self):
        d = W.parse(power_csv(3, start="2024-02-28", fill_tail=1, t=-5.0))
        self.assertEqual(list(d.index.strftime("%Y-%m-%d")), ["2024-02-28", "2024-02-29", "2024-03-01"])
        self.assertEqual(d.T2M_MAX.iloc[0], -5.0)        # negative temperatures are real values
        self.assertTrue(d.iloc[2].isna().all())

    def test_missing_column_fails(self):
        with self.assertRaises(W.FetchError):
            W.parse("-END HEADER-\nYEAR,DOY,T2M_MAX\n2024,1,3\n")


class Lattice(unittest.TestCase):
    def test_weighted_centres_and_empty_tiles(self):
        cells = pd.DataFrame({"lat": [0.0, 0.0, 2.0, 5.0], "lon": [0.0, 0.25, 0.0, 5.0], "n": [1, 3, 0, 4]})
        pts = W.lattice([0, 0, 6, 6], cells)
        self.assertEqual(len(pts), 2)                    # the n=0 cell's tile is dropped
        self.assertAlmostEqual(sum(p["weight"] for p in pts), 1.0)
        sw = pts[0]
        self.assertAlmostEqual(sw["lon"], round((0.125 * 1 + 0.375 * 3) / 4, 2))
        self.assertAlmostEqual(sw["weight"], 0.5)
        self.assertEqual((pts[1]["lat"], pts[1]["lon"]), (5.12, 5.12))

    def test_outside_bbox_ignored_and_no_fire_fails(self):
        cells = pd.DataFrame({"lat": [10.0], "lon": [10.0], "n": [5]})
        with self.assertRaises(SystemExit):
            W.lattice([0, 0, 6, 6], cells)


class Percentile(unittest.TestCase):
    def test_within_month_ties_and_incomplete(self):
        vals = [1.0, 5.0, 2.0, 5.0, 3.0, 9.0]
        months = [1, 2, 1, 2, 1, 2]
        complete = [True, True, True, True, True, False]
        p = W.percentile_within_month(vals, months, complete)
        self.assertEqual(p[:5], [16.7, 50.0, 50.0, 50.0, 83.3])
        self.assertEqual(p[5], 100.0)                     # partial month ranked against complete ones
        self.assertIsNone(W.percentile_within_month([np.nan], [1], [True])[0])


class Monthly(unittest.TestCase):
    def test_partial_last_month_and_lengths(self):
        text = power_csv(31 + 31 + 28 + 10 + 3, fill_tail=3)   # Dec 2000 .. 10 Mar 2001, 3 fill days
        d = W.daily_index(W.parse(text))
        pts = [{"lat": 0, "lon": 0, "weight": 0.25}, {"lat": 1, "lon": 1, "weight": 0.75}]
        m, through, complete, months = W.monthly(W.regional(pts, [d, d]))
        self.assertEqual(through, pd.Timestamp("2001-03-10"))
        self.assertEqual(list(complete), [True, True, False])
        b = W.bundle("x", pts, m, through, complete, months)
        mo = b["monthly"]
        for k in ["t2m_max_c", "index", "pctl", "vpd_peak7_kpa", "pctl_peak7", "precip_mm"]:
            self.assertEqual(len(mo[k]), 3, k)
        self.assertEqual((mo["last_month_days"], mo["last_month_complete"]), (10, False))
        self.assertEqual(mo["t2m_max_c"][0], 30.0)
        json.dumps(b, allow_nan=False)

    def test_day_missing_at_one_point_is_dropped(self):
        raw = W.parse(power_csv(31 + 31 + 28))
        a = W.daily_index(raw)
        raw.loc["2001-02-28", "T2M_MAX"] = np.nan
        b = W.daily_index(raw)
        reg = W.regional([{"weight": .5}, {"weight": .5}], [a, b])
        self.assertTrue(np.isnan(reg.loc["2001-02-28", "T2M_MAX"]))
        _, through, complete, _ = W.monthly(reg)
        self.assertEqual(through, pd.Timestamp("2001-02-27"))
        self.assertEqual(list(complete), [True, False])


class Fetch(unittest.TestCase):
    def test_cache_used_and_written_lf(self):
        calls = []
        def get(url):
            calls.append(url)
            return power_csv(5).replace("\n", "\r\n")
        p = {"lat": 39.5, "lon": -8.0}
        with tempfile.TemporaryDirectory() as tmp:
            raw = os.path.join(tmp, "{id}")
            for _ in range(2):
                d = W.load_point("r", 0, p, pd.Timestamp("2000-12-05").date(), get=get, raw=raw, log=lambda *a: 0)
            self.assertEqual(len(calls), 1)
            self.assertIn("latitude=39.5", calls[0]); self.assertIn("start=20001201", calls[0])
            with open(os.path.join(tmp, "r", "p0_39.50_-8.00.csv"), "rb") as f:
                self.assertNotIn(b"\r", f.read())
            self.assertEqual(len(d), 5)
            W.load_point("r", 0, p, pd.Timestamp("2000-12-05").date(), refresh=True, get=get, raw=raw, log=lambda *a: 0)
            self.assertEqual(len(calls), 2)

    def test_bad_body_not_cached(self):
        with tempfile.TemporaryDirectory() as tmp:
            raw = os.path.join(tmp, "{id}")
            with self.assertRaises(W.FetchError):
                W.load_point("r", 0, {"lat": 1, "lon": 2}, None, get=lambda u: "oops", raw=raw, log=lambda *a: 0)
            self.assertFalse(os.path.exists(os.path.join(tmp, "r")))

    def test_http_4xx_fails_fast_and_truncation_retries(self):
        n = []
        def opener400(url, timeout):
            n.append(1)
            raise urllib.error.HTTPError(url, 422, "bad", {}, None)
        with self.assertRaises(W.FetchError):
            W.http_get("u", opener=opener400)
        self.assertEqual(len(n), 1)

        class Short:
            length = 10
            def read(self): return b"x"
            def __enter__(self): return self
            def __exit__(self, *a): return False
        class Incomplete(Short):
            def read(self): raise W.http.client.IncompleteRead(b"x", 9)
        calls = []
        def flaky(url, timeout):
            calls.append(1)
            return Incomplete() if len(calls) == 1 else Good()
        class Good(Short):
            length = 0
            def read(self): return b"ok"
        orig = W.time.sleep
        W.time.sleep = lambda s: None
        try:
            with self.assertRaises(W.FetchError):
                W.http_get("u", attempts=2, opener=lambda url, timeout: Short())
            self.assertEqual(W.http_get("u", attempts=2, opener=flaky), "ok")   # real short body is retried
            self.assertEqual(len(calls), 2)
        finally:
            W.time.sleep = orig

    def test_short_answer_not_cached(self):
        with tempfile.TemporaryDirectory() as tmp:
            raw = os.path.join(tmp, "{id}")
            end = pd.Timestamp("2001-03-01").date()
            for text in (power_csv(30), power_csv(5, start="2000-12-05")):   # ends early / starts late
                with self.assertRaises(W.FetchError):
                    W.load_point("r", 0, {"lat": 1, "lon": 2}, end, get=lambda u, t=text: t, raw=raw, log=lambda *a: 0)
            self.assertFalse(os.path.exists(os.path.join(tmp, "r")))


def load(rid):
    p = DATA / rid / "weather.json"
    if not p.is_file():
        raise unittest.SkipTest(f"{p} not built")
    return json.loads(p.read_text(encoding="utf-8"))


def at(m, key, year, month):
    return m[key][(year - m["start_year"]) * 12 + month - 1]


class CommittedData(unittest.TestCase):
    def test_shape(self):
        for rid in ["portugal", "ghana", "punjab"]:
            with self.subTest(rid):
                w = load(rid)
                self.assertEqual((w["schema"], w["region"]), (1, rid))
                m = w["monthly"]
                ty, tm = map(int, w["through"][:7].split("-"))
                n = (ty - m["start_year"]) * 12 + tm
                for k in ["t2m_max_c", "rh2m_pct", "precip_mm", "ws10m_ms", "gwettop", "vpd_kpa",
                          "index", "pctl", "vpd_peak7_kpa", "pctl_peak7"]:
                    self.assertEqual(len(m[k]), n, k)
                self.assertTrue(all(v is not None and 0 <= v <= 100 for v in m["pctl"]))
                self.assertAlmostEqual(sum(p["weight"] for p in w["points"]), 1.0, places=9)

    def test_portugal_known_fire_weather(self):
        m = load("portugal")["monthly"]
        self.assertGreaterEqual(at(m, "pctl", 2017, 10), 90)        # Ophelia winds, 15 Oct 2017 fires
        self.assertGreaterEqual(at(m, "pctl_peak7", 2017, 10), 90)
        self.assertGreaterEqual(at(m, "pctl_peak7", 2003, 8), 90)   # 1-14 Aug 2003 heat wave (calm: index is low)

    def test_punjab_fire_peaks_not_weather_driven(self):
        """Of NW India's 5 biggest fire Octobers and Novembers (2001-2025), at most 1 each is in the
        top weather decile on either measure (harvest timing, not weather, drives them)."""
        m = load("punjab")["monthly"]
        sp = DATA / "punjab" / "series.json"
        if not sp.is_file():
            self.skipTest("no series.json")
        s = json.loads(sp.read_text(encoding="utf-8"))["monthly"]
        for month in (10, 11):
            fire = []
            for y in range(2001, 2026):
                i = (y - s["start_year"]) * 12 + month - 1
                fire.append((s["viirs"][i] if s["viirs"][i] is not None else s["pred"][i], y))
            top = [y for _, y in sorted(fire, reverse=True)[:5]]
            for key in ("pctl", "pctl_peak7"):
                hot = [y for y in top if at(m, key, y, month) >= 90]
                self.assertLessEqual(len(hot), 1, f"month {month} {key}: {hot}")


if __name__ == "__main__":
    unittest.main()
