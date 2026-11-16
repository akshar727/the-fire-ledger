import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import referee  # noqa: E402

N_MONTHS = 25 * 12 + 10


def series(factor_after=4.0, backcast_bias=1.0):
    ha = burned_ha()
    modis = [float(v) for v in ha]
    viirs = [None if i < 133 else factor_after * v for i, v in enumerate(modis)]
    pred = [factor_after * v * backcast_bias for v in modis]
    return {"monthly": {"start_year": 2001, "modis": modis, "viirs": viirs, "pred": pred}}


def burned_ha():
    i = np.arange(N_MONTHS)
    return 100 + 50 * np.sin(2 * np.pi * i / 12) + i % 7


def burned_frame(last_year=2022):
    ha = burned_ha()
    rows = [(2001 + i // 12, i % 12 + 1, ha[i]) for i in range(N_MONTHS) if 2001 + i // 12 <= last_year]
    return pd.DataFrame(rows, columns=["year", "month", "burned_ha"])


class GridTests(unittest.TestCase):
    def test_cell_index_matches_mcd64cmq_grid(self):
        self.assertEqual(tuple(map(int, referee.cell_index(89.75, -180.0))), (0, 0))
        self.assertEqual(tuple(map(int, referee.cell_index(-90.0, 179.75))), (719, 1439))
        r, c = referee.cell_index([10.0, 38.25], [0.25, -8.5])
        self.assertEqual((r.tolist(), c.tolist()), ([319, 206], [721, 686]))

    def test_file_month(self):
        self.assertEqual(referee.file_month("x/MCD64CMQ.A2017213.006.2018149175211.hdf"), (2017, 8, "6"))
        self.assertEqual(referee.file_month("MCD64CMQ.A2004061.006.2018150010746.hdf"), (2004, 3, "6"))
        self.assertEqual(referee.file_month("MCD64CMQ.A2024336.061.2025041120000.hdf"), (2024, 12, "6.1"))
        with self.assertRaises(ValueError):
            referee.file_month("MCD64A1.A2017213.h00v08.hdf")


class CheckTests(unittest.TestCase):
    def test_perfect_backcast_is_level_and_stitched_jumps(self):
        r = referee.region_check(burned_frame(), series(factor_after=4.0))
        self.assertAlmostEqual(r["stitched"]["step"], 4.0, places=3)
        self.assertAlmostEqual(r["harmonized"]["step"], 1.0, places=3)
        self.assertAlmostEqual(r["harmonized"]["per_1000km2_before"], 400000.0, delta=0.1)
        self.assertAlmostEqual(r["harmonized"]["monthly_r_before"], 1.0, places=6)

    def test_biased_backcast_shows_in_step(self):
        r = referee.region_check(burned_frame(), series(factor_after=4.0, backcast_bias=1.25))
        self.assertAlmostEqual(r["harmonized"]["step"], 0.8, places=3)

    def test_only_years_with_burned_area_and_all_12_months(self):
        r = referee.region_check(burned_frame(last_year=2022), series())
        self.assertEqual(r["yearly"]["years"], list(range(2001, 2023)))
        self.assertEqual(len(r["yearly"]["burned_km2"]), 22)
        r = referee.region_check(burned_frame(last_year=2030), series())
        self.assertEqual(r["yearly"]["years"][-1], 2025)

    def test_after_window_is_the_shortest_region(self):
        with tempfile.TemporaryDirectory() as d:
            for rid in ("aa", "bb"):
                os.makedirs(os.path.join(d, rid))
                with open(os.path.join(d, rid, "series.json"), "w", encoding="utf-8") as f:
                    json.dump(series(), f)
            pd.concat([burned_frame(2020).assign(region="aa"), burned_frame(2022).assign(region="bb")]).to_csv(
                os.path.join(d, "ba.csv"), index=False)
            with open(os.path.join(d, "regions.json"), "w", encoding="utf-8") as f:
                json.dump([{"id": "aa"}, {"id": "bb"}], f)
            import contextlib, io
            with contextlib.redirect_stdout(io.StringIO()):
                res = referee.run(os.path.join(d, "ba.csv"), d, os.path.join(d, "regions.json"),
                                  os.path.join(d, "referee.json"))
        self.assertEqual(res["after"], [2013, 2020])
        self.assertEqual(res["regions"]["bb"]["yearly"]["years"][-1], 2022)

    def test_no_complete_year_is_a_clear_error(self):
        with self.assertRaises(SystemExit):
            referee.last_full_year(burned_frame().query("month < 12"))

    def test_run_writes_strict_json(self):
        with tempfile.TemporaryDirectory() as d:
            for rid in ("aa", "bb"):
                os.makedirs(os.path.join(d, rid))
                with open(os.path.join(d, rid, "series.json"), "w", encoding="utf-8") as f:
                    json.dump(series(), f)
            b = burned_frame()
            pd.concat([b.assign(region=r) for r in ("aa", "bb")]).to_csv(os.path.join(d, "ba.csv"), index=False)
            with open(os.path.join(d, "regions.json"), "w", encoding="utf-8") as f:
                json.dump([{"id": "aa"}, {"id": "bb"}], f)
            out = os.path.join(d, "referee.json")
            import contextlib, io
            with contextlib.redirect_stdout(io.StringIO()):
                referee.run(os.path.join(d, "ba.csv"), d, os.path.join(d, "regions.json"), out)
            raw = Path(out).read_bytes()
            self.assertNotIn(b"\r\n", raw)
            res = json.loads(raw, parse_constant=lambda c: self.fail(f"non-finite {c}"))
        self.assertEqual(list(res["regions"]), ["aa", "bb"])
        self.assertEqual((res["before"], res["after"]), ([2003, 2011], [2013, 2022]))
        self.assertIn("Collection 6 ", res["product"])
        self.assertEqual(res["product_short"], "MCD64CMQ Collection 6")


if __name__ == "__main__":
    unittest.main()
