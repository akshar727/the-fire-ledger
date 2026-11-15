"""ML-023: whole-country code in model.py (coarse cells, ratio method, labels), globe.py and run_countries.py.
No network; about 30 s (two small model fits on the synthetic grid from test_model.py).

Run from the repo root:
    python -m unittest discover -s tests -v
"""
import contextlib
import datetime
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
sys.path.insert(0, str(Path(__file__).resolve().parent))
import globe  # noqa: E402
import model  # noqa: E402
import run_countries  # noqa: E402
from test_model import THROUGH, YEARS, load_strict, synthetic_grid  # noqa: E402

CID = "testland"
COUNTRY_KEYS = ["tier", "cell_deg", "method", "ship", "caveat", "model_score"]


def quiet(f, *a, **k):
    with contextlib.redirect_stdout(io.StringIO()):
        return f(*a, **k)


def write_grid(grid_dir, cid, df, **man):
    os.makedirs(grid_dir, exist_ok=True)
    df.to_csv(os.path.join(grid_dir, f"fire_grid_daily_{cid}.csv"), index=False)
    p = os.path.join(grid_dir, "manifest.json")
    m = json.loads(Path(p).read_text(encoding="utf-8")) if os.path.exists(p) else {}
    m[cid] = {"archive_through": THROUGH, "tier": "country", **man}
    with open(p, "w", encoding="utf-8") as f:
        json.dump(m, f)


class HelperTests(unittest.TestCase):
    def test_coarsen_sums_counts_and_weights_frp(self):
        d = pd.DataFrame({"date": ["2015-06-01"] * 3, "lat": [10.0, 10.25, 11.0], "lon": [20.0, 20.5, 20.0],
                          "daynight": ["D"] * 3, "terra_n": [1, 3, 2], "aqua_n": [0, 0, 1], "viirs_n": [5, 0, 4],
                          "terra_frp_mean": [10.0, 30.0, 7.0], "aqua_frp_mean": [None, None, 9.0],
                          "viirs_frp_mean": [2.0, None, 3.0]})
        g = model.coarsen(d, 1.0).set_index(["lat", "lon"])
        self.assertEqual(len(g), 2)
        a = g.loc[(10.0, 20.0)]
        self.assertEqual((a.terra_n, a.aqua_n, a.viirs_n), (4, 0, 5))
        self.assertAlmostEqual(a.terra_frp_mean, (10 + 90) / 4)   # n * mean is the exact sum
        self.assertTrue(np.isnan(a.aqua_frp_mean))                 # no detections: no mean, as build.py writes
        self.assertEqual(g.loc[(11.0, 20.0)].viirs_n, 4)
        self.assertEqual(model.coarsen(d, 1.0).terra_n.sum(), d.terra_n.sum())

    def test_pick_cell_deg(self):
        lat = np.repeat(np.arange(0, 10, 0.25), 40)
        lon = np.tile(np.arange(0, 10, 0.25), 40)
        d = pd.DataFrame({"lat": lat, "lon": lon, "terra_n": 1, "aqua_n": 0, "viirs_n": 0})   # 1,600 small cells
        cell, counts = model.pick_cell_deg(d)                         # first size with <= 400 burning cells
        self.assertEqual((cell, counts), (0.5, {0.25: 1600, 0.5: 400}))
        cell, counts = model.pick_cell_deg(d, max_cells=100)
        self.assertEqual((cell, counts), (1.0, {0.25: 1600, 0.5: 400, 1.0: 100}))
        self.assertEqual(model.pick_cell_deg(d, steps=(0.25, 0.5), max_cells=10)[0], 0.5)   # none fit: the largest
        self.assertEqual(model.burning_cells(d.assign(terra_n=0), 1.0), 0)

    def test_ship_rule(self):
        s = lambda mm, mr, cov: {"mape_model": mm, "mape_ratio": mr, "coverage": cov, "n_hold": 6}
        self.assertEqual(model.ship_rule(s(5, 8, 5), "model", False), "model")
        self.assertEqual(model.ship_rule(s(5, 8, 4), "model", False), "model")
        self.assertEqual(model.ship_rule(s(5, 8, 3), "model", False), "caveat")
        self.assertEqual(model.ship_rule(s(9, 8, 6), "model", False), "ratio")
        self.assertEqual(model.ship_rule(s(5, 8, 6), "ratio", False), "ratio")
        self.assertEqual(model.ship_rule(s(5, 8, 6), "model", True), "sparse")
        self.assertEqual(model.ship_rule(s(None, 8, 6), "model", False), "sparse")

    def test_mape_and_corr_never_nan(self):
        self.assertAlmostEqual(model.mape([110, 5], [100, 0]), 10.0)   # the zero year is left out
        self.assertIsNone(model.mape([1, 2], [0, 0]))
        self.assertIsNone(model.corr([1, 1, 1], [1, 2, 3]))
        self.assertAlmostEqual(model.corr([1, 2, 3], [2, 4, 6]), 1.0)

    def test_country_caveat(self):
        ann = pd.DataFrame({"harmonized": [100.0] * 25, "modis_n": [10.0] * 25}, index=YEARS)
        sc = {"mape_model": 5.0, "mape_ratio": 8.0, "coverage": 2, "n_hold": 6}
        self.assertIsNone(model.country_caveat("model", sc, None, ann, []))
        self.assertIn("Only 2 of the 6", model.country_caveat("caveat", sc, None, ann, []))
        self.assertIn("8.0% vs 5.0%", model.country_caveat("ratio", sc, sc, ann, []))
        self.assertIsNone(model.country_caveat("ratio", sc, None, ann, []))   # ratio asked for: nothing to explain
        self.assertIn("Too little fire", model.country_caveat("sparse", sc, None, ann, []))
        early = ann.assign(harmonized=[300.0] + [100.0] * 24)
        self.assertIn("2001-2002", model.country_caveat("model", sc, None, early, []))
        # Terra-only years have half the MODIS detections: that alone is no warning
        terra_only = ann.assign(modis_n=[5.0, 5.0] + [10.0] * 23)
        self.assertIsNone(model.country_caveat("model", sc, None, terra_only, []))
        m = model.country_caveat("model", sc, None, ann, ["modis_2000_Testland.csv", "viirs-snpp_2013_Testland.csv"])
        self.assertIn("2 sensor-year(s) (2000, 2013)", m)


class CountryRunTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="test_world_")
        cls.grid = os.path.join(cls.tmp, "grid")
        cls.out = os.path.join(cls.tmp, "out")
        g = synthetic_grid()
        write_grid(cls.grid, CID, g, missing_files=["viirs-snpp_2013_Testland.csv"])
        # sparse: a handful of fires a year, VIIRS in only some years
        rng = np.random.default_rng(3)
        sp = g.sample(400, random_state=1).assign(viirs_n=lambda x: rng.integers(0, 2, len(x)) * (x.viirs_n > 0))
        write_grid(cls.grid, "tiny", sp)
        write_grid(cls.grid, "empty", g.assign(viirs_n=0))
        cls.ratio = quiet(model.run, CID, 5, grid_dir=cls.grid, out_dir=cls.out, method="ratio", tier="country")
        cls.a_ratio = load_strict(os.path.join(cls.out, CID, "annual.json"))
        cls.s_ratio = load_strict(os.path.join(cls.out, CID, "series.json"))
        quiet(model.run, CID, 5, grid_dir=cls.grid, out_dir=os.path.join(cls.tmp, "m"), cell_deg=1.0,
              method="model", tier="country")
        cls.a_model = load_strict(os.path.join(cls.tmp, "m", CID, "annual.json"))
        quiet(model.run, "tiny", 5, grid_dir=cls.grid, out_dir=cls.out, cell_deg=1.0, method="model", tier="country")
        cls.a_tiny = load_strict(os.path.join(cls.out, "tiny", "annual.json"))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_ratio_has_country_fields_and_full_record(self):
        a = self.a_ratio
        self.assertEqual([k for k in a if k in COUNTRY_KEYS], COUNTRY_KEYS)
        self.assertEqual((a["tier"], a["method"], a["ship"], a["cell_deg"]), ("country", "ratio", "ratio", None))
        self.assertIsNone(a["model_score"])
        self.assertIn("2013", a["caveat"])          # the missing file is named
        self.assertEqual(a["years"], YEARS)
        self.assertEqual(len(a["harmonized"]), 25)
        self.assertTrue(all(v > 0 for v in a["harmonized"]))
        self.assertTrue(all(lo <= p <= hi for lo, p, hi in zip(a["lo"], a["pred"], a["hi"])))
        self.assertEqual(a["score"]["n_hold"], 6)
        self.assertIsNone(a["score"]["alpha"])
        for k in ("tier", "cell_deg", "method", "ship"):
            self.assertEqual(self.s_ratio[k], a[k])

    def test_ratio_backcast_is_modis_times_ratio(self):
        # synthetic VIIRS is ~2.5 x MODIS: the ratio back-cast lands near 2.5 x MODIS in the Aqua years
        a = self.a_ratio
        for i, yr in enumerate(YEARS):
            if 2003 <= yr <= 2011:
                self.assertAlmostEqual(a["pred"][i] / a["modis"][i], 2.5, delta=0.25, msg=str(yr))

    def test_model_label(self):
        a = self.a_model
        self.assertEqual(a["tier"], "country")
        self.assertIn(a["ship"], ("model", "caveat", "ratio"))
        if a["ship"] == "ratio":   # the model lost to the ratio: published as ratio, the model's score kept
            self.assertEqual((a["method"], a["cell_deg"]), ("ratio", None))
            self.assertIsNotNone(a["model_score"])
        else:
            self.assertEqual((a["method"], a["cell_deg"]), ("model", 1.0))
            self.assertLess(a["score"]["mape_model"], a["score"]["mape_ratio"])

    def test_sparse(self):
        a = self.a_tiny
        self.assertEqual((a["ship"], a["method"]), ("sparse", "ratio"))
        self.assertIn("Too little fire", a["caveat"])
        self.assertEqual(len(a["harmonized"]), 25)

    def test_no_viirs_at_all_stops(self):
        with self.assertRaises(SystemExit):
            quiet(model.run, "empty", 5, grid_dir=self.grid, out_dir=self.out, method="ratio", tier="country")

    def test_regions_unchanged_without_tier(self):
        # tier=None (the 3 deep dives): none of the country keys
        out = os.path.join(self.tmp, "r")
        quiet(model.run, CID, 5, grid_dir=self.grid, out_dir=out, method="ratio")
        a = load_strict(os.path.join(out, CID, "annual.json"))
        self.assertFalse(set(COUNTRY_KEYS) & set(a))


class GlobeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="test_globe_")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def annual(self, rid, n=25, partial_last=False, **extra):
        yrs = list(range(2001, 2001 + n))
        a = {"years": yrs, "harmonized": [100.04 + i for i in range(n)], "lo": [90.0] * n, "hi": [110.0] * n,
             "partial": [0] * (n - 1) + [int(partial_last)],
             "trend": {"harmonized": {"slope_pct": 1.5, "lo_pct": 0.5, "hi_pct": 2.5, "p": 0.01, "x": 9}},
             "score": {"mape_model": 5.0, "mape_ratio": 7.0, "coverage": 5, "n_hold": 6, "ratio": 2.0}, **extra}
        os.makedirs(os.path.join(self.tmp, rid))
        with open(os.path.join(self.tmp, rid, "annual.json"), "w", encoding="utf-8") as f:
            json.dump(a, f)

    def test_build(self):
        self.annual("portugal", n=26, partial_last=True)
        self.annual("brazil", tier="country", method="ratio", ship="ratio", cell_deg=None, caveat="c")
        self.annual("andorra", n=24, partial_last=True, tier="country", method="ratio", ship="sparse")
        index = {"schema": 1, "regions": [
            {"id": "portugal", "name": "Portugal", "bbox": [1, 2, 3, 4], "tier": "region"},
            {"id": "brazil", "name": "Brazil", "bbox": [5, 6, 7, 8], "tier": "country"},
            {"id": "nofile", "name": "No file", "tier": "country"},
            {"id": "andorra", "name": "Andorra", "tier": "country"}]}
        with open(os.path.join(self.tmp, "index.json"), "w", encoding="utf-8") as f:
            json.dump(index, f)
        cpath = os.path.join(self.tmp, "countries.json")
        with open(cpath, "w", encoding="utf-8") as f:
            json.dump([{"id": "brazil", "iso_a3": "BRA"}], f)
        g = globe.write(self.tmp, cpath)
        self.assertEqual(g["years"], list(range(2001, 2026)))          # the partial year is left out
        self.assertEqual([r["id"] for r in g["regions"]], ["portugal", "brazil", "andorra"])
        p, b, s = g["regions"]
        self.assertEqual((p["tier"], p["iso_a3"], p["bbox"], p["ship"], p["cell_deg"]),
                         ("region", None, [1, 2, 3, 4], None, 0.25))
        self.assertEqual((b["tier"], b["iso_a3"], b["bbox"], b["ship"], b["method"], b["caveat"]),
                         ("country", "BRA", None, "ratio", "ratio", "c"))
        self.assertEqual(len(b["harmonized"]), 25)
        self.assertEqual(len(s["harmonized"]), 25)                       # a short record is padded, not cutting 2025
        self.assertEqual(s["harmonized"][-2:], [None, None])
        self.assertEqual(s["harmonized"][0], 100.0)
        self.assertEqual(b["harmonized"][0], 100.0)
        self.assertEqual(b["lo"][10], 90.0)
        self.assertIsNone(b["lo"][11])                                  # bands only before 2012
        self.assertEqual(b["trend"], {"slope_pct": 1.5, "lo_pct": 0.5, "hi_pct": 2.5, "p": 0.01})
        self.assertEqual(set(b["score"]), {"mape_model", "mape_ratio", "coverage", "n_hold"})
        self.assertIsNone(b["score"]["mape_model"])                     # ratio tier: no model error to show
        self.assertEqual(p["score"]["mape_model"], 5.0)
        raw = Path(self.tmp, "globe.json").read_bytes()
        self.assertNotIn(b"\r", raw)
        self.assertEqual(json.loads(raw), g)


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="test_runner_")
        self.grid, self.out = os.path.join(self.tmp, "grid"), os.path.join(self.tmp, "out")
        os.makedirs(self.grid)
        man = {}
        for cid in ("a", "b", "c", "d"):
            if cid != "d":   # d has a manifest entry but no grid file
                Path(self.grid, f"fire_grid_daily_{cid}.csv").write_text("x\n")
            man[cid] = {}
        Path(self.grid, "manifest.json").write_text(json.dumps(man))
        for cid, ann in (("a", {"method": "ratio", "ship": "ratio"}), ("c", {"method": "ratio", "ship": "sparse"}),
                         ("b", {"method": "ratio", "ship": "ratio", "model_score": {"mape_model": 9}})):
            os.makedirs(os.path.join(self.out, cid))
            Path(self.out, cid, "annual.json").write_text(json.dumps(ann))
        self.countries = [{"id": i} for i in ("c", "b", "a", "d", "e")]

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def ids(self, method, **k):
        return [c["id"] for c in run_countries.todo(self.countries, method, self.grid, self.out, **k)]

    def test_todo_order_and_resume(self):
        self.assertEqual(self.ids("ratio"), [])                    # a, b and c all have a record
        self.assertEqual(self.ids("model"), ["a"])                 # b's model lost, c is sparse: both done
        self.assertEqual(self.ids("ratio", redo=True), ["c", "b", "a"])
        self.assertEqual(self.ids("model", only=["a"]), ["a"])

    def test_published(self):
        self.assertEqual(run_countries.published("a", self.out), ("ratio", "ratio"))
        self.assertEqual(run_countries.published("b", self.out), ("model", "ratio"))
        self.assertEqual(run_countries.published("c", self.out), ("model", "sparse"))
        self.assertEqual(run_countries.published("e", self.out), (None, None))

    def test_deadline_and_past(self):
        utc = datetime.timezone.utc
        late = datetime.datetime(2026, 11, 15, 22, 0, tzinfo=utc)          # started the evening before
        stop = run_countries.deadline("04:00", late)
        self.assertEqual(stop, datetime.datetime(2026, 11, 16, 4, 0, tzinfo=utc))
        self.assertFalse(run_countries.past(stop, late))
        self.assertFalse(run_countries.past(stop, stop - datetime.timedelta(minutes=1)))
        self.assertTrue(run_countries.past(stop, stop))
        early = datetime.datetime(2026, 11, 16, 1, 0, tzinfo=utc)          # same day
        self.assertEqual(run_countries.deadline("04:00", early), stop)
        self.assertIsNone(run_countries.deadline(None, late))
        self.assertFalse(run_countries.past(None, late))

    def test_log_row(self):
        log = os.path.join(self.tmp, "data", "runs.csv")
        Path(self.out, "a", "annual.json").write_text(json.dumps(
            {"method": "model", "ship": "model", "cell_deg": 1.0,
             "score": {"mape_model": 4.123, "mape_ratio": 6.0, "coverage": 5, "n_hold": 6}}))
        r = run_countries.log_row({"id": "a"}, "model", 12, "", self.out, log)
        self.assertEqual((r["ship"], r["cell_deg"], r["mape_model"]), ("model", 1.0, 4.12))
        Path(self.out, "c", "annual.json").write_text(json.dumps(
            {"method": "ratio", "ship": "ratio", "score": {"mape_model": 3.0, "mape_ratio": 6.0, "coverage": 6},
             "model_score": {"mape_model": 7.5, "coverage": 2}}))
        r = run_countries.log_row({"id": "c"}, "model", 5, "", self.out, log)
        self.assertEqual((r["method"], r["mape_model"], r["mape_ratio"], r["coverage"]), ("ratio", 7.5, 6.0, 2))
        run_countries.log_row({"id": "e"}, "model", 3, "boom", self.out, log)
        rows = pd.read_csv(log)
        self.assertEqual(list(rows.id), ["a", "c", "e"])
        self.assertEqual(rows.error.fillna("").tolist(), ["", "", "boom"])


class ScriptTests(unittest.TestCase):
    def test_scripts_run_from_another_folder(self):
        # ML-014: main() reads regions.json / countries.json relative to the repo, not the caller's folder
        with tempfile.TemporaryDirectory() as d:
            for script in ("model.py", "run_countries.py"):
                p = subprocess.run([sys.executable, str(ROOT / script), "--help"], cwd=d, capture_output=True,
                                   text=True, timeout=120)
                self.assertEqual(p.returncode, 0, p.stderr)
                self.assertEqual(os.listdir(d), [])


if __name__ == "__main__":
    unittest.main()
