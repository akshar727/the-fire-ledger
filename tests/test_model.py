"""Regression test for model.run() on a small synthetic grid (no network, about 10 s).

Two cells, 2001-2025, day and night rows, MODIS counts drawn at random and VIIRS about 2.5 x MODIS from
VIIRS_START on. Checks the shape and consistency of annual.json and series.json, not the fitted numbers.

Run from the repo root:
    python -m unittest discover -s tests -v
"""
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
    """One row per cell x day/night x week (mid-week date), in the grid CSV schema build.py writes."""
    rng = np.random.default_rng(42)
    rows = []
    for lat, lon, scale in ((38.25, -8.5, 3.0), (39.75, -7.25, 1.5)):   # two cells in different 1-degree bands
        for yr, wk in model.kept_weeks(THROUGH):
            date = model.week_start(yr, wk) + pd.Timedelta(days=3)
            season = 1 + np.sin(2 * np.pi * (wk - 13) / 52)               # summer peak, zero in early spring
            for dn, f in (("D", 1.0), ("N", 0.4)):
                lam = scale * f * (0.2 + season)
                terra = int(rng.poisson(lam))
                aqua = int(rng.poisson(lam)) if date >= AQUA_START else 0
                viirs = int(rng.poisson(2.5 * (terra + aqua) + 0.1)) if date >= model.VIIRS_START else 0
                if terra + aqua + viirs == 0:
                    continue   # the grid is sparse: no row means no detections
                rows.append((date.strftime("%Y-%m-%d"), lat, lon, dn, terra, aqua, viirs,
                             round(rng.uniform(5, 40), 1) if terra else None,
                             round(rng.uniform(5, 40), 1) if aqua else None,
                             round(rng.uniform(2, 10), 1) if viirs else None))
    return pd.DataFrame(rows, columns=["date", "lat", "lon", "daynight", "terra_n", "aqua_n", "viirs_n",
                                       "terra_frp_mean", "aqua_frp_mean", "viirs_frp_mean"])


def synthetic_points(points_dir):
    """Day passes in points/<year>.csv (ML-016): Terra at 10:30 local solar time, 9:30 in 2024 (drifted); Aqua at
    13:30; one night row that must be ignored. lon 15 E = UTC + 1 h, so 0930 UTC -> 10:30."""
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
    """Porcelain status of the primary repo, or None if git isn't available."""
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
        cls.cwd_dir = os.path.join(cls.tmp, "cwd")   # run from an empty folder: catches writes to relative paths
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
                                   "harmonized", "viirs_partial", "overpass", "obs_over_pred", "drifted", "trend"])
        self.assertEqual(a["years"], YEARS)
        for k in ("modis", "viirs", "pred", "lo", "hi", "partial", "harmonized", "viirs_partial", "obs_over_pred",
                  "drifted"):
            self.assertEqual(len(a[k]), 25, k)
        self.assertEqual(list(a["overpass"]), ["terra", "aqua", "snpp"])
        for k, v in a["overpass"].items():
            self.assertEqual(len(v), 25, k)
        self.assertEqual(list(a["score"]), ["mape_model", "mape_ratio", "coverage", "n_hold", "ratio", "alpha",
                                            "weekly_r", "sigma_year"])
        self.assertEqual(a["score"]["n_hold"], 6)
        self.assertTrue(all(np.isfinite(v) for v in a["score"].values()))
        self.assertEqual(a["partial"], [0] * 25)
        self.assertEqual(a["data_through"], THROUGH)

    def test_trend(self):
        # ML-020: the synthetic record has no trend, but VIIRS is ~2.5x MODIS, so the stitched record jumps in 2012
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
        self.assertEqual([i for i, v in enumerate(m["viirs"]) if v is None], list(range(133)))   # to Jan 2012
        self.assertEqual([i for i, v in enumerate(w["viirs"]) if v is None], list(range(11 * 52 + 3)))

    def test_harmonized_blends_2012(self):
        # ML-009: harmonized = pred before 2012, observed VIIRS weeks from 20 Jan 2012 + model weeks 0-2 in 2012,
        # observed VIIRS after; only 2012 is flagged as blended
        a, w = self.annual, self.series["weekly"]
        i12 = YEARS.index(2012)
        self.assertEqual(a["viirs_partial"], [int(y == 2012) for y in YEARS])
        for i, yr in enumerate(YEARS):
            want = a["pred"][i] if yr < 2012 else a["viirs"][i]
            if yr != 2012:
                self.assertAlmostEqual(a["harmonized"][i], want, delta=0.05 if yr < 2012 else 1e-9, msg=str(yr))
        # weeks 0-2 start before 20 Jan: model for the whole week (week 2's 20-21 Jan observations are dropped on
        # purpose, as in training and series.json); weekly viirs is null there, observed from week 3
        wk = slice(i12 * 52, (i12 + 1) * 52)
        self.assertEqual([i for i, v in enumerate(w["viirs"][wk]) if v is None], [0, 1, 2])
        blended = sum(w["pred"][wk][:3]) + sum(w["viirs"][wk][3:])
        self.assertAlmostEqual(a["harmonized"][i12], blended, delta=0.5)
        self.assertNotAlmostEqual(a["harmonized"][i12], a["viirs"][i12], delta=1)   # 2012 is not the raw total

    def test_overpass_and_drift(self):
        # ML-016: points only for 2013-2025 -> null before; Terra 10:30 (9:30 in 2024), Aqua 13:30, no SNPP rows
        ov, a = self.annual["overpass"], self.annual
        for i, yr in enumerate(YEARS):
            has = yr >= 2013
            self.assertEqual(ov["terra"][i], (9.5 if yr == 2024 else 10.5) if has else None, yr)
            self.assertEqual(ov["aqua"][i], 13.5 if has else None, yr)
            self.assertIsNone(ov["snpp"][i], yr)
        self.assertEqual(a["drifted"], [int(y == 2024) for y in YEARS])

    def test_obs_over_pred(self):
        # ML-016: VIIRS / pred over VIIRS-covered weeks; null before 2012; 2012 uses weeks 3-51 only (weekly sums)
        a, w = self.annual, self.series["weekly"]
        for i, yr in enumerate(YEARS):
            r = a["obs_over_pred"][i]
            if yr < 2012:
                self.assertIsNone(r, yr)
                continue
            wk = slice(i * 52, (i + 1) * 52)
            vs = [(v, p) for v, p in zip(w["viirs"][wk], w["pred"][wk]) if v is not None]
            want = sum(v for v, _ in vs) / sum(p for _, p in vs)
            self.assertAlmostEqual(r, want, delta=2e-3, msg=str(yr))   # weekly pred is rounded to 1 dp
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
        self.assertEqual(list(s["monthly"]), ["start_year", "bucketing", "modis", "viirs", "pred", "lo", "hi"])
        self.assertEqual(list(s["weekly"]), ["start_year", "weeks_per_year", "modis", "viirs", "pred", "lo", "hi",
                                             "last_week_days"])
        self.assertEqual(s["weekly"]["last_week_days"], 8)   # whole year: week 51 of 2025 is 24-31 Dec
        for k in ("modis", "viirs", "pred", "lo", "hi"):
            self.assertEqual(len(s["monthly"][k]), 300, k)
            self.assertEqual(len(s["weekly"][k]), 1300, k)
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
                        continue   # 2012: series viirs is null before 20 January, annual viirs is the raw total
                    # raw counts are whole numbers, so 0.5 is plenty; pred is rounded to 1 dp in every value, so n
                    # rounded parts can drift from the rounded total by up to (n + 1) x 0.05 (0.4 seen here)
                    tol = 0.5 if k != "pred" else (n + 1) * 0.05
                    self.assertAlmostEqual(sum(chunk), a[k][i], delta=tol, msg=f"{name} {k} {yr}")

    def test_run_return_matches_files(self):
        r = self.res
        self.assertEqual(len(r["weeks"]), 1300)
        self.assertEqual(r["draws"].shape, (5, 1300))
        np.testing.assert_allclose(np.round(r["pred"], 1), self.series["weekly"]["pred"], atol=1e-9)
        self.assertEqual(r["score"], self.annual["score"])


class PartialYearRunTests(unittest.TestCase):
    """ML-010: archive ends mid-week (Sun 2 Nov 2025, inside week 43 = 29 Oct-4 Nov). The partial week is kept,
    monthly reaches October, data_through is the archive end, and the partial year is not scored."""
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
        self.assertEqual(a["score"]["n_hold"], 5)   # 2020-2024; partial 2025 is not scored
        self.assertEqual((a["trend"]["years"], a["trend"]["n_years"]), ([2001, 2024], 24))   # ML-020: nor trended

    def test_series_reaches_last_whole_month(self):
        m, w = self.series["monthly"], self.series["weekly"]
        self.assertEqual(len(m["modis"]), 24 * 12 + 10)   # through October 2025
        self.assertEqual(len(w["modis"]), 24 * 52 + 44)   # weeks 0-43 of 2025, the last one partial
        self.assertEqual(w["last_week_days"], 5)
        self.assertEqual(len(self.series["calendar"]["flag"]), 24 * 12 + 10)
        self.assertEqual(self.series["calendar"]["baseline_years"], [2001, 2025])


if __name__ == "__main__":
    unittest.main()
