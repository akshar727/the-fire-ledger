"""Tests for cells.py / model.run(write_cells=True) (ML-018): per-cell monthly totals in cells.json.

1. Synthetic grid (from test_model): every cell's months sum back to series.json monthly modis / viirs / pred.
2. month_shares matches model.series_bundle's week -> month split, also for a `through` in mid-month.
3. The committed site/public/data/<region>/cells.json (if present) sums back to that region's series.json.

Run from the repo root:
    python -m unittest tests.test_cells -v
"""
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))
import cells  # noqa: E402
import model  # noqa: E402
from test_model import RID, THROUGH, synthetic_grid  # noqa: E402

DATA = ROOT / "site" / "public" / "data"


def cell_sums(c):
    """{key: per-month totals over all cells} from a cells.json dict."""
    nm = c["n_months"]
    return {k: np.asarray(c[k], float).reshape(-1, nm).sum(axis=0) / c["scale"] for k in ("modis", "viirs", "pred")}


def check_against_series(test, c, s):
    """Cell sums match series.json monthly (1 dp) within series rounding + n_cells x half a stored unit."""
    nm, nc = c["n_months"], len(c["lat"])
    test.assertEqual(len(c["lon"]), nc)
    for k in ("modis", "viirs", "pred"):
        test.assertEqual(len(c[k]), nc * nm, k)
        test.assertTrue(all(isinstance(v, int) and v >= 0 for v in c[k]), k)
    m = s["monthly"]
    test.assertGreaterEqual(len(m["pred"]), nm)
    src = m.get("source", ["backcast"] * len(m["pred"]))
    tol = 0.05 + nc * 0.5 / c["scale"] + 1e-6
    sums = cell_sums(c)
    for k in ("modis", "viirs", "pred"):
        for i in range(nm):
            want = m[k][i]
            if k == "viirs" and i < c["viirs_from"]:
                test.assertIsNone(want, f"{k}[{i}]")
                test.assertEqual(sums[k][i], 0)
                continue
            if src[i] == "forward":
                continue   # forward months add the region-level NOAA link, which has no per-cell values
            test.assertLessEqual(abs(sums[k][i] - want), tol, f"{k}[{i}]: cells {sums[k][i]}, series {want}")


class SyntheticCellsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="test_cells_")
        grid_dir, cls.out_dir = os.path.join(cls.tmp, "grid"), os.path.join(cls.tmp, "out")
        os.makedirs(grid_dir)
        synthetic_grid().to_csv(os.path.join(grid_dir, f"fire_grid_daily_{RID}.csv"), index=False)
        with open(os.path.join(grid_dir, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump({RID: {"archive_through": THROUGH}}, f)
        with contextlib.redirect_stdout(io.StringIO()):
            cls.res = model.run(RID, nboot=5, grid_dir=grid_dir, out_dir=cls.out_dir,
                                points_dir=os.path.join(cls.tmp, "none"), write_cells=True)
        load = lambda n: json.loads(Path(cls.out_dir, RID, n).read_text(encoding="utf-8"))
        cls.cells, cls.series, cls.annual = load("cells.json"), load("series.json"), load("annual.json")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_header(self):
        c = self.cells
        self.assertEqual(c["schema"], 2)
        self.assertEqual((c["region"], c["cell_deg"], c["scale"], c["start_year"]), (RID, 0.25, 100, 2001))
        self.assertEqual(c["n_months"], 25 * 12)
        self.assertEqual(c["viirs_from"], 11 * 12 + 1)                 # Feb 2012: Jan 2012 starts before VIIRS_START
        self.assertEqual(c["data_through"], THROUGH)
        self.assertEqual((c["lat"], c["lon"]), ([38.25, 39.75], [-8.5, -7.25]))   # sorted by lat, then lon
        self.assertEqual(c["alpha"], self.annual["score"]["alpha"])
        self.assertEqual(c["sigma_year"], self.annual["score"]["sigma_year"])

    def test_sums_match_series(self):
        check_against_series(self, self.cells, self.series)

    def test_plain_lf_json(self):
        raw = Path(self.out_dir, RID, "cells.json").read_bytes()
        self.assertNotIn(b"\r", raw)
        self.assertTrue(raw.endswith(b"}\n"))

    def test_off_by_default(self):
        tmp = tempfile.mkdtemp(prefix="test_cells_off_")
        try:
            grid_dir = os.path.join(tmp, "grid")
            os.makedirs(grid_dir)
            synthetic_grid().to_csv(os.path.join(grid_dir, f"fire_grid_daily_{RID}.csv"), index=False)
            with open(os.path.join(grid_dir, "manifest.json"), "w", encoding="utf-8") as f:
                json.dump({RID: {"archive_through": THROUGH}}, f)
            with contextlib.redirect_stdout(io.StringIO()):
                model.run(RID, nboot=1, grid_dir=grid_dir, out_dir=os.path.join(tmp, "out"),
                          points_dir=os.path.join(tmp, "none"))
            self.assertEqual(sorted(os.listdir(os.path.join(tmp, "out", RID))), ["annual.json", "series.json"])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class ForwardCellsTests(unittest.TestCase):
    """S-NPP ends mid-month (2 Nov 2025) and NOAA continues (ML-017): cells stop at the last whole back-cast month
    (Oct 2025), series.json runs on to the forward month, and the shared months still sum back."""
    THROUGH, FWD = "2025-11-02", "2025-11-20"

    def test_forward_run(self):
        from test_model import with_noaa
        tmp = tempfile.mkdtemp(prefix="test_cells_fwd_")
        try:
            grid_dir, out_dir = os.path.join(tmp, "grid"), os.path.join(tmp, "out")
            os.makedirs(grid_dir)
            with_noaa(synthetic_grid(), self.THROUGH, self.FWD, np.random.default_rng(7)).to_csv(
                os.path.join(grid_dir, f"fire_grid_daily_{RID}.csv"), index=False)
            with open(os.path.join(grid_dir, "manifest.json"), "w", encoding="utf-8") as f:
                json.dump({RID: {"archive_through": self.THROUGH,
                                 "sensors": {"n20": {"data_through": self.FWD}, "n21": {"data_through": self.FWD}}}}, f)
            with contextlib.redirect_stdout(io.StringIO()):
                model.run(RID, nboot=2, grid_dir=grid_dir, out_dir=out_dir, points_dir=os.path.join(tmp, "none"),
                          write_cells=True)
            load = lambda n: json.loads(Path(out_dir, RID, n).read_text(encoding="utf-8"))
            c, s = load("cells.json"), load("series.json")
            self.assertEqual(c["n_months"], 24 * 12 + 10)                  # Jan 2001 .. Oct 2025
            self.assertEqual(len(s["monthly"]["pred"]), c["n_months"] + 1)  # + forward Nov 2025
            self.assertEqual(s["monthly"]["source"][c["n_months"]], "forward")
            self.assertEqual(c["data_through"], self.THROUGH)
            check_against_series(self, c, s)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class MonthSharesTests(unittest.TestCase):
    def test_matches_series_bundle(self):
        rng = np.random.default_rng(3)
        for through in ("2025-12-31", "2025-11-14", "2024-02-29", "2023-03-01"):
            weeks = model.kept_weeks(through)
            nw = len(weeks)
            wk = {k: rng.uniform(0, 50, nw) for k in ("modis", "viirs", "pred")}
            b = model.series_bundle("x", weeks, wk, np.zeros((3, nw)), through)
            nm = len(b["monthly"]["pred"])
            S = cells.month_shares(weeks, through, nm)
            self.assertTrue(np.all(S.sum(axis=1) <= 1 + 1e-9))
            got = np.round(wk["pred"] @ S, 1)
            np.testing.assert_allclose(got, b["monthly"]["pred"], atol=0.051, err_msg=through)


class CommittedCellsTests(unittest.TestCase):
    def test_committed_files_sum_to_series(self):
        found = [p for p in sorted(DATA.glob("*/cells.json"))]
        if not found:
            self.skipTest("no committed cells.json")
        for p in found:
            with self.subTest(region=p.parent.name):
                c = json.loads(p.read_text(encoding="utf-8"))
                s = json.loads((p.parent / "series.json").read_text(encoding="utf-8"))
                a = json.loads((p.parent / "annual.json").read_text(encoding="utf-8"))
                self.assertEqual(c["region"], p.parent.name)
                self.assertAlmostEqual(c["alpha"], a["score"]["alpha"], places=9)
                self.assertAlmostEqual(c["sigma_year"], a["score"]["sigma_year"], places=9)
                check_against_series(self, c, s)


if __name__ == "__main__":
    unittest.main()
