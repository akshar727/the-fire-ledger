import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import model  # noqa: E402  (nothing runs at import)

RID = "synthetic"
THROUGH = "2025-12-31"
YEARS = list(range(2001, 2026))
AQUA_START = pd.Timestamp("2002-07-04")


def synthetic_grid():
    rng = np.random.default_rng(42)
    rows = []
    for lat, lon, scale in ((38.25, -8.5, 3.0), (39.75, -7.25, 1.5)):
        for yr, wk in model.kept_weeks(THROUGH):
            date = model.week_start(yr, wk) + pd.Timedelta(days=3)
            season = 1 + np.sin(2 * np.pi * (wk - 13) / 52)
            for dn, f in (("D", 1.0), ("N", 0.4)):
                lam = scale * f * (0.2 + season)
                terra = int(rng.poisson(lam))
                aqua = int(rng.poisson(lam)) if date >= AQUA_START else 0
                viirs = int(rng.poisson(2.5 * (terra + aqua) + 0.1)) if date >= model.VIIRS_START else 0
                if terra + aqua + viirs == 0:
                    continue
                rows.append((date.strftime("%Y-%m-%d"), lat, lon, dn, terra, aqua, viirs,
                             round(rng.uniform(5, 40), 1) if terra else None,
                             round(rng.uniform(5, 40), 1) if aqua else None,
                             round(rng.uniform(2, 10), 1) if viirs else None))
    return pd.DataFrame(rows, columns=["date", "lat", "lon", "daynight", "terra_n", "aqua_n", "viirs_n",
                                       "terra_frp_mean", "aqua_frp_mean", "viirs_frp_mean"])


def synthetic_points(points_dir):
    os.makedirs(points_dir)
    for yr in range(2013, 2026):
        terra = "0830" if yr == 2024 else "0930"
        rows = [f"{yr}-06-01,{terra},40.0,15.0,Terra,80,10.0,D", f"{yr}-06-01,1230,40.0,15.0,Aqua,80,10.0,D",
                f"{yr}-06-01,2330,40.0,15.0,Terra,80,10.0,N"]
        with open(os.path.join(points_dir, f"{yr}.csv"), "w", encoding="utf-8", newline="\n") as f:
            f.write("date,time_utc,lat,lon,satellite,confidence,frp_mw,daynight\n" + "\n".join(rows) + "\n")


def reject_constant(name):
    raise ValueError(f"non-finite JSON constant {name}")


def load_strict(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f, parse_constant=reject_constant)


def git_status():
    try:
        out = subprocess.run(["git", "-C", str(ROOT), "status", "--porcelain", "-z", "--untracked-files=all"],
                             capture_output=True, check=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout


class ModelRunTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="test_model_")
        cls.grid_dir = os.path.join(cls.tmp, "grid")
        cls.out_dir = os.path.join(cls.tmp, "out")
        cls.points_dir = os.path.join(cls.tmp, "points")
        cls.cwd_dir = os.path.join(cls.tmp, "cwd")
        for d in (cls.grid_dir, cls.cwd_dir):
            os.makedirs(d)
        synthetic_points(cls.points_dir)
        synthetic_grid().to_csv(os.path.join(cls.grid_dir, f"fire_grid_daily_{RID}.csv"), index=False)
        with open(os.path.join(cls.grid_dir, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump({RID: {"archive_through": THROUGH}}, f)

        cls.status_before = git_status()
        old_cwd = os.getcwd()
        os.chdir(cls.cwd_dir)
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                cls.res = model.run(RID, nboot=5, grid_dir=cls.grid_dir, out_dir=cls.out_dir,
                                    points_dir=cls.points_dir)
        finally:
            os.chdir(old_cwd)
        cls.status_after = git_status()
        cls.annual = load_strict(os.path.join(cls.out_dir, RID, "annual.json"))
        cls.series = load_strict(os.path.join(cls.out_dir, RID, "series.json"))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_writes_only_the_two_outputs(self):
        self.assertEqual(sorted(os.listdir(self.out_dir)), [RID])
        self.assertEqual(sorted(os.listdir(os.path.join(self.out_dir, RID))), ["annual.json", "series.json"])
        self.assertEqual(sorted(os.listdir(self.grid_dir)), ["fire_grid_daily_synthetic.csv", "manifest.json"])
        self.assertEqual(os.listdir(self.cwd_dir), [])
        if self.status_before is None:
            self.skipTest("git not available: repo check skipped")
        self.assertEqual(self.status_after, self.status_before, "model.run changed files in the repo")

    def test_json_is_plain_lf(self):
        for name in ("annual.json", "series.json"):
            raw = Path(self.out_dir, RID, name).read_bytes()
            self.assertNotIn(b"\r", raw)
            self.assertTrue(raw.endswith(b"}\n"))
            for token in (b"NaN", b"Infinity"):
                self.assertNotIn(token, raw)

    def test_annual_keys_and_lengths(self):
        a = self.annual
        self.assertEqual(list(a), ["years", "modis", "viirs", "pred", "lo", "hi", "score", "partial", "data_through",
                                   "harmonized", "viirs_partial", "overpass", "obs_over_pred", "drifted",
                                   "forward_through", "source", "trend"])
        self.assertEqual(a["years"], YEARS)
        for k in ("modis", "viirs", "pred", "lo", "hi", "partial", "harmonized", "viirs_partial", "obs_over_pred",
                  "drifted", "source"):
            self.assertEqual(len(a[k]), 25, k)
        self.assertEqual(list(a["overpass"]), ["terra", "aqua", "snpp"])
        for k, v in a["overpass"].items():
            self.assertEqual(len(v), 25, k)
        self.assertEqual(list(a["score"]), ["mape_model", "mape_ratio", "coverage", "n_hold", "ratio", "alpha",
                                            "weekly_r", "sigma_year", "forward"])
        self.assertEqual(a["score"]["n_hold"], 6)
        self.assertIsNone(a["score"]["forward"])
        self.assertTrue(all(np.isfinite(v) for k, v in a["score"].items() if k != "forward"))
        self.assertEqual(a["partial"], [0] * 25)
        self.assertEqual(a["data_through"], THROUGH)
        self.assertIsNone(a["forward_through"])
        self.assertEqual(a["source"], ["backcast"] * 11 + ["observed"] * 14)

    def test_trend(self):
        t = self.annual["trend"]
        self.assertEqual((t["years"], t["n_years"]), ([2001, 2025], 25))
        self.assertGreater(t["stitched"]["slope_pct"], 3)
        self.assertLess(t["stitched"]["p"], 0.01)
        h = t["harmonized"]
        self.assertLess(abs(h["slope_pct"]), abs(t["stitched"]["slope_pct"]) / 2)
        self.assertLessEqual(h["lo_pct"], h["slope_pct"])
        self.assertLessEqual(h["slope_pct"], h["hi_pct"])
        self.assertLessEqual(h["boot_lo_pct"], h["boot_hi_pct"])
        for rec in ("stitched", "harmonized"):
            self.assertTrue(all(len(v) == 12 for v in t["monthly"][rec].values()), rec)

    def test_viirs_null_only_before_2012(self):
        a = self.annual
        self.assertEqual([y for y, v in zip(a["years"], a["viirs"]) if v is None], list(range(2001, 2012)))
        m, w = self.series["monthly"], self.series["weekly"]
        self.assertEqual([i for i, v in enumerate(m["viirs"]) if v is None], list(range(133)))
        self.assertEqual([i for i, v in enumerate(w["viirs"]) if v is None], list(range(11 * 52 + 3)))

    def test_harmonized_blends_2012(self):
        a, w = self.annual, self.series["weekly"]
        i12 = YEARS.index(2012)
        self.assertEqual(a["viirs_partial"], [int(y == 2012) for y in YEARS])
        for i, yr in enumerate(YEARS):
            want = a["pred"][i] if yr < 2012 else a["viirs"][i]
            if yr != 2012:
                self.assertAlmostEqual(a["harmonized"][i], want, delta=0.05 if yr < 2012 else 1e-9, msg=str(yr))
        wk = slice(i12 * 52, (i12 + 1) * 52)
        self.assertEqual([i for i, v in enumerate(w["viirs"][wk]) if v is None], [0, 1, 2])
        blended = sum(w["pred"][wk][:3]) + sum(w["viirs"][wk][3:])
        self.assertAlmostEqual(a["harmonized"][i12], blended, delta=0.5)
        self.assertNotAlmostEqual(a["harmonized"][i12], a["viirs"][i12], delta=1)

    def test_overpass_and_drift(self):
        ov, a = self.annual["overpass"], self.annual
        for i, yr in enumerate(YEARS):
            has = yr >= 2013
            self.assertEqual(ov["terra"][i], (9.5 if yr == 2024 else 10.5) if has else None, yr)
            self.assertEqual(ov["aqua"][i], 13.5 if has else None, yr)
            self.assertIsNone(ov["snpp"][i], yr)
        self.assertEqual(a["drifted"], [int(y == 2024) for y in YEARS])

    def test_obs_over_pred(self):
        a, w = self.annual, self.series["weekly"]
        for i, yr in enumerate(YEARS):
            r = a["obs_over_pred"][i]
            if yr < 2012:
                self.assertIsNone(r, yr)
                continue
            wk = slice(i * 52, (i + 1) * 52)
            vs = [(v, p) for v, p in zip(w["viirs"][wk], w["pred"][wk]) if v is not None]
            want = sum(v for v, _ in vs) / sum(p for _, p in vs)
            self.assertAlmostEqual(r, want, delta=2e-3, msg=str(yr))
            if yr > 2012:
                self.assertAlmostEqual(r, a["viirs"][i] / a["pred"][i], delta=2e-3, msg=str(yr))

    def test_bands_ordered(self):
        for name, d in (("annual", self.annual), ("monthly", self.series["monthly"]),
                        ("weekly", self.series["weekly"])):
            bad = [i for i, (lo, hi) in enumerate(zip(d["lo"], d["hi"])) if not lo <= hi]
            self.assertEqual(bad, [], f"{name}: lo > hi at {bad[:5]}")
            self.assertTrue(all(np.isfinite(v) for k in ("modis", "pred", "lo", "hi") for v in d[k]), name)

    def test_series_keys_and_lengths(self):
        s = self.series
        self.assertEqual(list(s), ["schema", "region", "monthly", "weekly", "calendar"])
        self.assertEqual((s["schema"], s["region"]), (1, RID))
        self.assertEqual(list(s["monthly"]), ["start_year", "bucketing", "modis", "viirs", "pred", "lo", "hi",
                                              "source", "last_month_days"])
        self.assertEqual(list(s["weekly"]), ["start_year", "weeks_per_year", "modis", "viirs", "pred", "lo", "hi",
                                             "source", "last_week_days"])
        self.assertEqual(s["weekly"]["last_week_days"], 8)
        self.assertEqual(s["monthly"]["last_month_days"], 31)
        for k in ("modis", "viirs", "pred", "lo", "hi", "source"):
            self.assertEqual(len(s["monthly"][k]), 300, k)
            self.assertEqual(len(s["weekly"][k]), 1300, k)
        for name, d in (("monthly", s["monthly"]), ("weekly", s["weekly"])):
            self.assertEqual(d["source"], ["backcast" if v is None else "observed" for v in d["viirs"]], name)
        c = s["calendar"]
        self.assertEqual(list(c), ["baseline_years", "month_median", "month_p25", "month_p75", "anomaly", "flag"])
        self.assertEqual((len(c["anomaly"]), len(c["flag"]), len(c["month_median"])), (300, 300, 12))

    def test_monthly_and_weekly_sum_to_annual(self):
        a, m, w = self.annual, self.series["monthly"], self.series["weekly"]
        for k in ("modis", "viirs", "pred"):
            for i, yr in enumerate(YEARS):
                if a[k][i] is None:
                    continue
                for name, vals, n in (("monthly", m[k], 12), ("weekly", w[k], 52)):
                    chunk = vals[i * n:(i + 1) * n]
                    if None in chunk:
                        continue
                    tol = 0.5 if k != "pred" else (n + 1) * 0.05
                    self.assertAlmostEqual(sum(chunk), a[k][i], delta=tol, msg=f"{name} {k} {yr}")

    def test_run_return_matches_files(self):
        r = self.res
        self.assertEqual(len(r["weeks"]), 1300)
        self.assertEqual(r["draws"].shape, (5, 1300))
        np.testing.assert_allclose(np.round(r["pred"], 1), self.series["weekly"]["pred"], atol=1e-9)
        self.assertEqual(r["score"], self.annual["score"])


class PartialYearRunTests(unittest.TestCase):
    THROUGH = "2025-11-02"

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="test_model_partial_")
        grid_dir, cls.out_dir = os.path.join(cls.tmp, "grid"), os.path.join(cls.tmp, "out")
        os.makedirs(grid_dir)
        g = synthetic_grid()
        g[g.date <= cls.THROUGH].to_csv(os.path.join(grid_dir, f"fire_grid_daily_{RID}.csv"), index=False)
        with open(os.path.join(grid_dir, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump({RID: {"archive_through": cls.THROUGH}}, f)
        with contextlib.redirect_stdout(io.StringIO()):
            cls.res = model.run(RID, nboot=5, grid_dir=grid_dir, out_dir=cls.out_dir)
        cls.annual = load_strict(os.path.join(cls.out_dir, RID, "annual.json"))
        cls.series = load_strict(os.path.join(cls.out_dir, RID, "series.json"))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_annual_partial_year(self):
        a = self.annual
        self.assertEqual(a["data_through"], self.THROUGH)
        self.assertEqual(a["partial"], [0] * 24 + [1])
        self.assertEqual(a["score"]["n_hold"], 5)
        self.assertEqual((a["trend"]["years"], a["trend"]["n_years"]), ([2001, 2024], 24))

    def test_series_reaches_last_whole_month(self):
        m, w = self.series["monthly"], self.series["weekly"]
        self.assertEqual(len(m["modis"]), 24 * 12 + 10)
        self.assertEqual(len(w["modis"]), 24 * 52 + 44)
        self.assertEqual(w["last_week_days"], 5)
        self.assertEqual(len(self.series["calendar"]["flag"]), 24 * 12 + 10)
        self.assertEqual(self.series["calendar"]["baseline_years"], [2001, 2025])


def with_noaa(g, through, fwd_through, rng):
    g = g[g.date <= through].copy()
    dt = pd.to_datetime(g.date)
    rate = 2.5 * (g.terra_n + g.aqua_n) + 0.1
    g["n20_n"] = np.where(dt >= "2018-04-01", rng.poisson(rate / 0.95), 0)
    g["n21_n"] = np.where(dt >= "2024-01-01", rng.poisson(rate / 0.95 / 1.1), 0)
    g["n20_frp_mean"] = g["n21_frp_mean"] = None
    extra = []
    for day in pd.date_range(pd.Timestamp(through) + pd.Timedelta(days=1), fwd_through):
        if day.dayofweek not in (1, 5):
            continue
        for lat, lon in ((38.25, -8.5), (39.75, -7.25)):
            for dn in ("D", "N"):
                extra.append((day.strftime("%Y-%m-%d"), lat, lon, dn, 0, 0, 0, None, None, None,
                              int(rng.poisson(6)), int(rng.poisson(5)), None, None))
    return pd.concat([g, pd.DataFrame(extra, columns=g.columns)], ignore_index=True)


class ForwardRunTests(unittest.TestCase):
    THROUGH, FWD = "2025-11-02", "2025-11-20"
    NW, NM = 24 * 52 + 43, 24 * 12 + 10

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="test_model_forward_")
        out = {}
        g = synthetic_grid()
        for name, grid, sensors in (
                ("base", g[g.date <= cls.THROUGH], {}),
                ("fwd", with_noaa(g, cls.THROUGH, cls.FWD, np.random.default_rng(7)),
                 {"n20": {"data_through": cls.FWD}, "n21": {"data_through": cls.FWD}})):
            grid_dir, out_dir = os.path.join(cls.tmp, name, "grid"), os.path.join(cls.tmp, name, "out")
            os.makedirs(grid_dir)
            grid.to_csv(os.path.join(grid_dir, f"fire_grid_daily_{RID}.csv"), index=False)
            with open(os.path.join(grid_dir, "manifest.json"), "w", encoding="utf-8") as f:
                json.dump({RID: {"archive_through": cls.THROUGH, "sensors": sensors}}, f)
            with contextlib.redirect_stdout(io.StringIO()):
                model.run(RID, nboot=5, grid_dir=grid_dir, out_dir=out_dir)
            out[name] = (load_strict(os.path.join(out_dir, RID, "annual.json")),
                         load_strict(os.path.join(out_dir, RID, "series.json")))
        (cls.a0, cls.s0), (cls.a, cls.s) = out["base"], out["fwd"]

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_backcast_part_unchanged(self):
        for k in ("modis", "viirs", "pred", "lo", "hi", "harmonized", "obs_over_pred", "viirs_partial", "drifted"):
            self.assertEqual(self.a[k][:24], self.a0[k][:24], k)
        for k in ("modis", "viirs"):
            self.assertEqual(self.a[k], self.a0[k], k)
        self.assertEqual(self.a["obs_over_pred"], self.a0["obs_over_pred"])
        self.assertEqual(self.a["trend"], self.a0["trend"])
        self.assertEqual({k: v for k, v in self.a["score"].items() if k != "forward"},
                         {k: v for k, v in self.a0["score"].items() if k != "forward"})
        for k in ("modis", "viirs", "pred", "lo", "hi"):
            self.assertEqual(self.s["monthly"][k][:self.NM], self.s0["monthly"][k][:self.NM], k)
            self.assertEqual(self.s["weekly"][k][:self.NW], self.s0["weekly"][k][:self.NW], k)
        for k in ("modis",):
            self.assertEqual(self.s["weekly"][k][self.NW], self.s0["weekly"][k][self.NW])
        c, c0 = self.s["calendar"], self.s0["calendar"]
        self.assertEqual(c["month_median"], c0["month_median"])
        self.assertEqual(c["anomaly"][:self.NM], c0["anomaly"])

    def test_record_runs_to_the_noaa_end(self):
        a, m, w = self.a, self.s["monthly"], self.s["weekly"]
        self.assertEqual((a["data_through"], a["forward_through"]), (self.THROUGH, self.FWD))
        self.assertEqual(len(m["pred"]), self.NM + 1)
        self.assertEqual(m["last_month_days"], 20)
        self.assertEqual(len(w["pred"]), self.NW + 4)
        self.assertEqual(w["last_week_days"], 2)
        self.assertEqual(len(self.s["calendar"]["anomaly"]), self.NM + 1)
        self.assertIsNone(self.s["calendar"]["anomaly"][-1])
        self.assertEqual(self.s["calendar"]["flag"][-1], 0)

    def test_source(self):
        a, m, w = self.a, self.s["monthly"], self.s["weekly"]
        self.assertEqual(a["source"], ["backcast"] * 11 + ["observed"] * 13 + ["forward"])
        self.assertEqual(m["source"][self.NM - 1:], ["observed", "forward"])
        self.assertEqual(w["source"][self.NW - 1:], ["observed"] + ["forward"] * 4)
        for d in (m, w):
            self.assertEqual([v for v, s in zip(d["viirs"], d["source"]) if s == "forward"], [None] * (
                d["source"].count("forward")))
            self.assertEqual(d["source"][:133], ["backcast"] * 133)

    def test_forward_adds_to_pred(self):
        a, m, w = self.a, self.s["monthly"], self.s["weekly"]
        self.assertGreater(w["pred"][self.NW], self.s0["weekly"]["viirs"][self.NW])
        self.assertTrue(all(p > 0 for p in w["pred"][self.NW:self.NW + 3]))
        self.assertEqual(w["pred"][-1], 0)
        self.assertTrue(all(lo <= p <= hi or hi - lo < 1 for lo, p, hi in
                            zip(w["lo"][self.NW:], w["pred"][self.NW:], w["hi"][self.NW:])))
        wk = w["pred"][24 * 52:]
        w0 = self.s0["weekly"]
        self.assertAlmostEqual(a["pred"][-1], sum(wk) + w0["pred"][self.NW] - w0["viirs"][self.NW], delta=53 * 0.05)
        har = sum(v if s == "observed" else p for v, p, s in
                  zip(w["viirs"][24 * 52:], wk, w["source"][24 * 52:]))
        self.assertAlmostEqual(a["harmonized"][-1], har, delta=53 * 0.05)
        self.assertAlmostEqual(sum(m["pred"][24 * 12:]), a["pred"][-1] - (w0["pred"][self.NW] - w0["viirs"][self.NW]) * 2 / 5,
                               delta=12 * 0.05 + 0.5)

    def test_transition_periods_use_observed_snpp(self):
        w, m, w0 = self.s["weekly"], self.s["monthly"], self.s0["weekly"]
        obs, bc = w0["viirs"][self.NW], w0["pred"][self.NW]
        self.assertGreater(abs(obs - bc), 1)
        self.assertAlmostEqual(sum(w["pred"][self.NW:]) - m["pred"][-1], obs * 3 / 5, delta=0.5)
        self.assertGreaterEqual(w["pred"][self.NW], obs)
        self.assertGreaterEqual(w["lo"][self.NW], obs - 0.05)
        self.assertLessEqual(w["lo"][self.NW], w["pred"][self.NW])
        self.assertGreaterEqual(w["hi"][self.NW], w["pred"][self.NW])
        self.assertGreater(w["hi"][self.NW], w["lo"][self.NW])
        self.assertAlmostEqual(self.a["harmonized"][-1] - self.a["viirs"][-1],
                               sum(w["pred"][self.NW:]) - obs, delta=53 * 0.05)

    def test_forward_score(self):
        f = self.a["score"]["forward"]
        self.assertEqual(f["sensors"], ["noaa20", "noaa21"])
        self.assertEqual((f["hold"], f["forward"]), (["2024-01-01", self.THROUGH], ["2025-11-03", self.FWD]))
        self.assertAlmostEqual(f["ratio_day"], 0.95, delta=0.05)
        self.assertAlmostEqual(f["n21_scale_day"], 1.1, delta=0.08)
        self.assertEqual(f["n_year"], 1)
        self.assertLess(f["mape_year"], 10)
        for k in ("mape_month", "mape_ratio_month", "alpha", "sigma_month"):
            self.assertTrue(f[k] is None or np.isfinite(f[k]), k)


if __name__ == "__main__":
    unittest.main()
