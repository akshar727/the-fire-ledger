import json
import sys
import tempfile
import unittest
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import peaks  # noqa: E402

COLS = ["date", "lat", "lon", "daynight", "terra_n", "aqua_n", "viirs_n", "n20_n"]


def row(date, terra=0, aqua=0, viirs=0, n20=0, lat=40.0, lon=-8.0, dn="D"):
    return [date, lat, lon, dn, terra, aqua, viirs, n20]


def build(rows, archive="2020-06-10", n20_end="2020-06-15"):
    return peaks.build_peaks("x", pd.DataFrame(rows, columns=COLS), archive, n20_end)


def month(res, m):
    return next(x for x in res["months"] if x["month"] == m)


def entry(res, m, i=0):
    day, count, s = month(res, m)["top3"][i]
    return day, count, res["sensors"][s]


class PeakTests(unittest.TestCase):
    def test_sum_over_cells_and_daynight_and_order(self):
        res = build([row("2005-03-04", 1, 1), row("2005-03-04", 2, 0, lat=41.0, dn="N"), row("2005-03-04", 0, 3, lon=-7.0),
                     row("2005-03-10", 5), row("2005-03-20", 1), row("2005-03-21", 2), row("2005-03-22", 1, 1)])
        self.assertEqual([entry(res, "2005-03", i) for i in range(3)],
                         [(4, 7, "modis"), (10, 5, "modis"), (21, 2, "modis")])
        self.assertEqual(month(res, "2005-03")["peak"], month(res, "2005-03")["top3"][0])
        self.assertEqual(len(month(res, "2005-03")["top3"]), 3)
        self.assertEqual(res["sensors"], ["modis", "snpp", "noaa20"])
        self.assertIn("not harmonized", res["counts"])
        self.assertEqual(res["start"], "2001-01")
        self.assertEqual((res["snpp_from"], res["snpp_through"], res["noaa20_through"]),
                         ("2012-01-20", "2020-06-10", "2020-06-15"))
        self.assertIn("2012-01-20", res["counts"])
        self.assertIn("2020-06-10", res["counts"])
        self.assertIn("two transition months", res["counts"])
        self.assertIn("ranked against each other", res["counts"])

    def test_tie_earliest_date(self):
        res = build([row("2005-03-09", 3), row("2005-03-02", 2, 1), row("2005-03-05", 3)])
        self.assertEqual([t[0] for t in month(res, "2005-03")["top3"]], [2, 5, 9])

    def test_january_2012_sensor_switch(self):
        res = build([row("2012-01-19", terra=9, aqua=1, viirs=99), row("2012-01-20", terra=50, viirs=4),
                     row("2012-01-25", viirs=6)])
        self.assertEqual([entry(res, "2012-01", i) for i in range(3)],
                         [(19, 10, "modis"), (25, 6, "snpp"), (20, 4, "snpp")])

    def test_noaa20_after_archive_through(self):
        res = build([row("2020-06-10", viirs=5, n20=1), row("2020-06-11", viirs=99, n20=3), row("2020-06-12", viirs=7)])
        self.assertEqual([entry(res, "2020-06", i) for i in range(2)], [(10, 5, "snpp"), (11, 3, "noaa20")])
        self.assertEqual(len(month(res, "2020-06")["top3"]), 2)

    def test_n20_ends_before_archive_keeps_snpp_days(self):
        res = build([row("2020-06-08", viirs=50)], archive="2020-06-10", n20_end="2020-06-06")
        self.assertEqual(entry(res, "2020-06"), (8, 50, "snpp"))
        self.assertEqual(res["last_day"], "2020-06-10")
        self.assertIsNone(res["noaa20_through"])

    def test_no_noaa20(self):
        res = peaks.build_peaks("x", pd.DataFrame([row("2020-06-08", viirs=5)], columns=COLS), "2020-06-10", None)
        self.assertEqual(res["last_day"], "2020-06-10")
        self.assertIsNone(res["noaa20_through"])
        self.assertEqual(entry(res, "2020-06"), (8, 5, "snpp"))

    def test_zero_month_and_no_holes(self):
        res = build([row("2005-03-04", 1)])
        z = month(res, "2005-04")
        self.assertIsNone(z["peak"])
        self.assertEqual(z["top3"], [])
        names = [m["month"] for m in res["months"]]
        self.assertEqual(names, [str(p) for p in pd.period_range("2001-01", "2020-06", freq="M")])

    def test_partial_last_month(self):
        res = build([row("2020-06-12", n20=2)])
        self.assertEqual(res["partial_months"], ["2020-06"])
        self.assertEqual(res["last_day"], "2020-06-15")
        self.assertEqual(build([row("2020-06-12", n20=2)], n20_end="2020-06-30")["partial_months"], [])

    def test_manifest_without_n20_or_null_data_through(self):
        for sensors in ({}, {"n20": {"first_date": None, "data_through": None}}):
            with tempfile.TemporaryDirectory() as t:
                grid, out = Path(t) / "grid", Path(t) / "out"
                grid.mkdir()
                pd.DataFrame([row("2020-06-08", viirs=5)], columns=COLS).to_csv(grid / "fire_grid_daily_x.csv", index=False)
                (grid / "manifest.json").write_text(json.dumps({"x": {"archive_through": "2020-06-10", "sensors": sensors}}))
                path, _ = peaks.run("x", grid, out)
                res = json.loads(path.read_text())
                self.assertEqual(res["last_day"], "2020-06-10")
                self.assertIsNone(res["noaa20_through"])

    def test_json_clean(self):
        with tempfile.TemporaryDirectory() as t:
            grid, out = Path(t) / "grid", Path(t) / "out"
            grid.mkdir()
            pd.DataFrame([row("2005-03-04", 1, dn="N"), row("2020-06-12", n20=2)],
                         columns=COLS).to_csv(grid / "fire_grid_daily_x.csv", index=False)
            (grid / "manifest.json").write_text(json.dumps(
                {"x": {"archive_through": "2020-06-10",
                           "sensors": {"n20": {"last_date": "2020-06-13", "data_through": "2020-06-15"}}}}))
            path, n = peaks.run("x", grid, out)
            raw = path.read_bytes()
            self.assertNotIn(b"\r", raw)
            self.assertTrue(raw.endswith(b"\n"))
            self.assertNotIn(b"NaN", raw)
            loaded = json.loads(raw)
            self.assertEqual(loaded["region"], "x")
            self.assertEqual(loaded["last_day"], "2020-06-15")
            for m in loaded["months"]:
                for day, count, sensor in m["top3"]:
                    self.assertIs(type(count), int)
                    self.assertIs(type(day), int)
                    self.assertIs(type(sensor), int)
            peaks.run("x", grid, out)
            self.assertEqual(path.read_bytes(), raw)
            self.assertFalse((out / "x" / "peaks.json.part").exists())


if __name__ == "__main__":
    unittest.main()
