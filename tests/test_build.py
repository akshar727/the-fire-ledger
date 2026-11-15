"""Gridding and point export in build.py (small hand-made tables, temp folders, no network).

Run from the repo root:
    python -m unittest discover -s tests -v
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build  # noqa: E402  (nothing runs at import)

HEADER = ",".join(build.COLS)
POINT_HEADER = "date,time_utc,lat,lon,satellite,confidence,frp_mw,daynight"


def det(lat, lon, date="2020-01-01", time="1200", sat="Terra", conf="50", frp=1.0, dn="D", typ=0):
    return dict(latitude=lat, longitude=lon, acq_date=date, acq_time=time, satellite=sat,
                confidence=conf, frp=frp, daynight=dn, type=typ)


def frame(rows):
    return pd.DataFrame(rows, columns=build.COLS)


def write_raw(folder, name, rows):
    with open(os.path.join(folder, name), "w", encoding="utf-8", newline="\n") as f:
        f.write(HEADER + "\n")
        for r in rows:
            f.write(",".join(str(r[c]) for c in build.COLS) + "\n")


def read_text(path):
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()


def quiet(fn, *a, **k):
    with contextlib.redirect_stdout(io.StringIO()):
        return fn(*a, **k)


def fail_download(*a, **k):
    raise AssertionError("network download attempted")


class GridTests(unittest.TestCase):
    def setUp(self):
        self.out = build.grid(frame([
            det(-0.1, -8.0, sat="Terra", frp=1.0, dn="D"),
            det(-0.1, -8.0, sat="Terra", frp=2.234, dn="D"),
            det(-0.1, -8.0, sat="Terra", frp=10.0, dn="D"),
            det(-0.2, -7.9, sat="Aqua", frp=5.0, dn="D"),
            det(-0.15, -7.76, sat="N", frp=7.0, dn="N"),
            det(0.24, 41.999, date="2020-01-01", sat="Aqua", frp=3.0, dn="D"),
            det(0.0, 0.0, date="2020-01-02", sat="Terra", frp=4.0, dn="D"),
        ]))

    def test_columns_and_row_order(self):
        self.assertEqual(list(self.out.columns), [
            "date", "lat", "lon", "daynight", "terra_n", "aqua_n", "viirs_n",
            "terra_frp_mean", "aqua_frp_mean", "viirs_frp_mean",
            "n20_n", "n21_n", "n20_frp_mean", "n21_frp_mean"])   # DP-013: NOAA columns appended, model's unchanged
        keys = list(zip(self.out.date, self.out.lat, self.out.lon, self.out.daynight))
        self.assertEqual(keys, [
            ("2020-01-01", -0.25, -8.0, "D"),
            ("2020-01-01", -0.25, -8.0, "N"),
            ("2020-01-01", 0.0, 41.75, "D"),
            ("2020-01-02", 0.0, 0.0, "D"),
        ])

    def test_cell_is_south_west_corner(self):
        # -0.1 -> -0.25, -8.0 stays, 0.24 -> 0.0, 41.999 -> 41.75
        self.assertEqual(self.out.lat.tolist(), [-0.25, -0.25, 0.0, 0.0])
        self.assertEqual(self.out.lon.tolist(), [-8.0, -8.0, 41.75, 0.0])

    def test_counts_per_satellite_and_day_night_split(self):
        r = self.out
        self.assertEqual(r.terra_n.tolist(), [3, 0, 0, 1])
        self.assertEqual(r.aqua_n.tolist(), [1, 0, 1, 0])
        self.assertEqual(r.viirs_n.tolist(), [0, 1, 0, 0])
        self.assertEqual(r.daynight.tolist(), ["D", "N", "D", "D"])

    def test_mean_frp_empty_when_no_detections_and_two_decimals(self):
        r = self.out
        self.assertEqual(r.terra_frp_mean[0], 4.41)  # mean(1.0, 2.234, 10.0) = 4.411; median would be 2.23
        self.assertEqual(r.aqua_frp_mean[0], 5.0)
        self.assertTrue(pd.isna(r.viirs_frp_mean[0]))
        self.assertTrue(pd.isna(r.terra_frp_mean[1]))
        self.assertEqual(r.viirs_frp_mean[1], 7.0)
        self.assertTrue(pd.isna(r.terra_frp_mean[2]))

    def test_dtypes(self):
        for c in ("terra_n", "aqua_n", "viirs_n", "n20_n", "n21_n"):
            self.assertTrue(pd.api.types.is_integer_dtype(self.out[c]), c)
        for c in ("lat", "lon", "terra_frp_mean", "aqua_frp_mean", "viirs_frp_mean", "n20_frp_mean", "n21_frp_mean"):
            self.assertEqual(self.out[c].dtype, np.float64, c)

    def test_empty_frp_written_blank_in_csv(self):
        text = self.out.to_csv(index=False, lineterminator="\n").splitlines()
        self.assertEqual(text[2], "2020-01-01,-0.25,-8.0,N,0,0,1,,,7.0,0,0,,")

    def test_noaa_counts_get_own_columns_and_rows(self):
        out = build.grid(frame([det(-0.1, -8.0, sat="N", frp=2.0), det(-0.1, -8.0, sat="N20", frp=4.0),
                                det(-0.1, -8.0, sat="N20", frp=6.0), det(1.1, 1.1, date="2026-11-10", sat="N21", frp=1.5)]))
        self.assertEqual(out.viirs_n.tolist(), [1, 0])
        self.assertEqual(out.n20_n.tolist(), [2, 0])
        self.assertEqual(out.n21_n.tolist(), [0, 1])
        self.assertEqual(out.n20_frp_mean[0], 5.0)
        self.assertEqual(out.viirs_frp_mean[0], 2.0)            # S-NPP values untouched by NOAA rows in the same cell
        self.assertEqual(out.n21_frp_mean[1], 1.5)
        self.assertEqual((out.terra_n[1], out.aqua_n[1], out.viirs_n[1]), (0, 0, 0))   # NOAA-only row

    def test_noaa_rows_never_change_model_columns(self):
        base = [det(-0.1, -8.0, sat="Terra", frp=1.0), det(-0.1, -8.0, sat="N", frp=2.0, dn="N"),
                det(0.3, 0.3, date="2020-01-03", sat="Aqua")]
        noaa = [det(-0.1, -8.0, sat="N20"), det(-0.1, -8.0, sat="N21", dn="N"), det(5.0, 5.0, sat="N20")]
        legacy = list(build.grid(frame(base)).columns[:10])
        a = build.grid(frame(base))[legacy]
        b = build.grid(frame(base + noaa))
        b = b[(b.terra_n + b.aqua_n + b.viirs_n) > 0][legacy].reset_index(drop=True)
        pd.testing.assert_frame_equal(a, b)

    def test_check_model_cells(self):
        base = [det(-0.1, -8.0, sat="Terra"), det(0.3, 0.3, date="2020-01-03", sat="Aqua")]
        build.check_model_cells(build.grid(frame(base + [det(0.3, 0.3, date="2020-01-05", sat="N20")])), "x")   # fine
        with self.assertRaises(SystemExit):   # a cell only NOAA saw
            build.check_model_cells(build.grid(frame(base + [det(5.0, 5.0, sat="N21")])), "x")
        with self.assertRaises(SystemExit):   # NOAA brings a cell forward: model.py's cell order would change
            build.check_model_cells(build.grid(frame(base + [det(0.3, 0.3, date="2019-12-31", sat="N20")])), "x")

    def test_input_not_modified(self):
        df = frame([det(-0.1, -8.0)])
        before = df.copy()
        build.grid(df)
        pd.testing.assert_frame_equal(df, before)


class RawDirCase(unittest.TestCase):
    """Temp RAW dir, fake region 'XX', SRC limited to 2020, downloads forbidden."""
    BBOX = [-8.0, 36.0, -6.0, 38.0]

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = tmp.name
        self.raw = os.path.join(self.tmp, "raw")
        os.makedirs(self.raw)
        self.region = {"id": "xx", "name": "X", "country": "XX", "bbox": self.BBOX, "fire_type": "wildfire"}
        for patcher in (
            mock.patch.object(build, "RAW", self.raw),
            mock.patch.object(build, "SRC", {"modis": range(2020, 2021), "viirs-snpp": range(2020, 2021)}),
            mock.patch.object(build, "download", fail_download),
            mock.patch.object(build.urllib.request, "urlopen", fail_download),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def load(self, modis, viirs=()):
        write_raw(self.raw, "modis_2020_XX.csv", modis)
        write_raw(self.raw, "viirs-snpp_2020_XX.csv", viirs)
        return quiet(build.load_region, self.region)


class LoadRegionTests(RawDirCase):
    def test_noaa20_archive_read_but_archive_through_from_modis_and_snpp_only(self):
        write_raw(self.raw, "viirs-jpss1_2020_XX.csv", [det(37, -7, sat="N20", date="2020-12-31")])
        ends = {}
        with mock.patch.object(build, "SRC", {"modis": range(2020, 2021), "viirs-snpp": range(2020, 2021),
                                              "viirs-jpss1": range(2020, 2021)}):
            write_raw(self.raw, "modis_2020_XX.csv", [det(37, -7, date="2020-06-01")])
            write_raw(self.raw, "viirs-snpp_2020_XX.csv", [det(37, -7, sat="N", date="2020-06-02")])
            df, through = quiet(build.load_region, self.region, ends)
        self.assertEqual(sorted(df.satellite), ["N", "N20", "Terra"])
        self.assertEqual(through, "2020-06-02")              # NOAA-20 reaching further does not move it
        self.assertEqual(ends, {"terra": "2020-06-01", "aqua": "2020-06-01", "viirs": "2020-06-02", "n20": "2020-12-31"})

    def test_type_filter_drops_non_zero(self):
        df, _ = self.load([det(37, -7, time="0001", typ=0), det(37, -7, time="0002", typ=1),
                           det(37, -7, time="0003", typ=2), det(37, -7, time="0004", typ=3)])
        self.assertEqual(df.acq_time.tolist(), ["0001"])

    def test_bbox_edges_west_south_inclusive_east_north_exclusive(self):
        rows = [
            det(37, -8.0, time="0001"),     # on west edge: kept
            det(37, -8.001, time="0002"),   # just west: dropped
            det(37, -7.999, time="0003"),   # just inside west: kept
            det(37, -6.0, time="0004"),     # on east edge: dropped
            det(37, -6.001, time="0005"),   # just inside east: kept
            det(37, -5.999, time="0006"),   # just east: dropped
            det(36.0, -7, time="0007"),     # on south edge: kept
            det(35.999, -7, time="0008"),   # just south: dropped
            det(36.001, -7, time="0009"),   # just inside south: kept
            det(38.0, -7, time="0010"),     # on north edge: dropped
            det(37.999, -7, time="0011"),   # just inside north: kept
            det(38.001, -7, time="0012"),   # just north: dropped
        ]
        df, _ = self.load(rows)
        self.assertEqual(sorted(df.acq_time), ["0001", "0003", "0005", "0007", "0009", "0011"])

    def test_unknown_satellite_raises_naming_it(self):
        with self.assertRaises(ValueError) as cm:
            self.load([det(37, -7)], [det(37, -7, sat="1")])
        self.assertIn("'1'", str(cm.exception))

    def test_unknown_satellite_outside_bbox_is_ignored(self):
        df, _ = self.load([det(37, -7)], [det(50, 10, sat="1")])
        self.assertEqual(len(df), 1)

    def test_known_satellites_and_acq_time_kept_as_text(self):
        df, through = self.load(
            [det(37, -7, sat="Terra", time="0905", date="2020-03-01"),
             det(37, -7, sat="Aqua", date="2020-02-01")],
            [det(37, -7, sat="N", date="2020-05-09"), det(50, 10, sat="N", date="2020-06-01")])
        self.assertEqual(sorted(df.satellite), ["Aqua", "N", "Terra"])
        self.assertIn("0905", df.acq_time.tolist())
        self.assertEqual(through, "2020-06-01")  # latest date before the bbox filter

    def test_existing_files_never_downloaded(self):
        # fail_download is patched in setUp; reaching here without AssertionError proves no download
        self.load([det(37, -7)])
        self.assertEqual(sorted(os.listdir(self.raw)), ["modis_2020_XX.csv", "viirs-snpp_2020_XX.csv"])

    def test_empty_satellite_raises_naming_nan(self):
        with self.assertRaises(ValueError) as cm:
            self.load([det(37, -7, sat="")])
        self.assertIn("NaN", str(cm.exception))


class ProbeTests(RawDirCase):
    """The early probe fetches the first year SRC lists, nothing else."""

    def run_load(self, src, files=()):
        for name in files:
            write_raw(self.raw, name, [])
        buf = io.StringIO()
        with mock.patch.object(build, "SRC", src), contextlib.redirect_stdout(buf):
            build.load_region(self.region)
        return buf.getvalue()

    def probe_line(self, out):
        return next(ln for ln in out.splitlines() if ln.startswith("probe "))

    def test_probe_is_first_sensor_first_year(self):
        out = self.run_load({"viirs-snpp": range(2020, 2021), "modis": range(2019, 2020)},
                            ["viirs-snpp_2020_XX.csv", "modis_2019_XX.csv"])
        self.assertIn("viirs-snpp_2020_XX.csv", self.probe_line(out))
        self.assertNotIn("modis", self.probe_line(out))
        # printed before anything else the loop prints, with the full path
        self.assertTrue(out.splitlines()[0].startswith(f"probe {build.RAW}/viirs-snpp_2020_XX.csv: "), out.splitlines()[0])
        self.assertEqual(sorted(os.listdir(self.raw)), ["modis_2019_XX.csv", "viirs-snpp_2020_XX.csv"])

    def test_probe_accepts_any_iterable_of_years(self):
        # a set (or list/tuple) of years works too; the probe is the loop's first year
        out = self.run_load({"viirs-snpp": {2020}, "modis": [2019]}, ["viirs-snpp_2020_XX.csv", "modis_2019_XX.csv"])
        self.assertIn("viirs-snpp_2020_XX.csv", self.probe_line(out))

    def test_probe_download_target_is_first_listed(self):
        calls = []

        def record(url, path, attempts=3):
            calls.append(os.path.basename(path))
            raise SystemExit("x")

        with mock.patch.object(build, "download", record), self.assertRaises(SystemExit):
            quiet(self.run_load, {"viirs-snpp": range(2020, 2021), "modis": range(2019, 2020)})
        self.assertEqual(calls, ["viirs-snpp_2020_XX.csv"])

    def test_probe_uses_first_year_of_range(self):
        out = self.run_load({"modis": range(2018, 2021)},
                            [f"modis_{y}_XX.csv" for y in (2018, 2019, 2020)])
        self.assertIn("modis_2018_XX.csv", self.probe_line(out))

    def test_empty_first_range_is_skipped(self):
        out = self.run_load({"modis": range(0), "viirs-snpp": range(2020, 2021)},
                            ["viirs-snpp_2020_XX.csv"])
        self.assertIn("viirs-snpp_2020_XX.csv", self.probe_line(out))

    def test_all_ranges_empty_raises_clear_message(self):
        with self.assertRaises(SystemExit) as cm:
            self.run_load({"modis": range(0), "viirs-snpp": range(5, 5)})
        self.assertIn("SRC lists no years", str(cm.exception))
        self.assertEqual(os.listdir(self.raw), [])

    def test_missing_probe_fails_before_any_other_file(self):
        calls = []

        def record(url, path, attempts=3):
            calls.append(os.path.basename(path))
            raise SystemExit("x")

        write_raw(self.raw, "modis_2020_XX.csv", [])  # present, but must not be reached
        with mock.patch.object(build, "download", record), self.assertRaises(SystemExit):
            quiet(self.run_load, {"viirs-snpp": range(2020, 2021), "modis": range(2020, 2021)})
        self.assertEqual(calls, ["viirs-snpp_2020_XX.csv"])  # exactly one attempt
        self.assertEqual(os.listdir(self.raw), ["modis_2020_XX.csv"])


class WritePointsTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.folder = os.path.join(tmp.name, "xx", "points")
        p = mock.patch.object(build, "POINTS", os.path.join(tmp.name, "{id}", "points"))
        p.start()
        self.addCleanup(p.stop)
        self.region = {"id": "xx", "bbox": [-8.0, -1.0, -6.0, 1.0]}

    def write(self, rows):
        return build.write_points(self.region, frame(rows))

    def lines(self, year):
        return read_text(os.path.join(self.folder, f"{year}.csv")).split("\n")

    def test_header_lf_zero_pad_negative_zero(self):
        years, n = self.write([det(-0.00001, -7.0, time="905", frp=-0.04, conf="85")])
        self.assertEqual((years, n), ([2020], 1))
        text = read_text(os.path.join(self.folder, "2020.csv"))
        self.assertNotIn("\r", text)
        self.assertTrue(text.endswith("\n"))
        lines = text.split("\n")
        self.assertEqual(lines[0], POINT_HEADER)
        self.assertEqual(lines[1], "2020-01-01,0905,0.0000,-7.0000,Terra,85,0.0,D")

    def test_negative_zero_lon_written_as_zero(self):
        self.region = {"id": "xx", "bbox": [-1.0, -1.0, 1.0, 1.0]}
        self.write([det(0.5, -0.00001)])
        self.assertEqual(self.lines(2020)[1], "2020-01-01,1200,0.5000,0.0000,Terra,50,1.0,D")

    def test_confidence_whitespace_stripped(self):
        self.write([det(0, -7, conf=" 85")])
        self.assertEqual(self.lines(2020)[1].split(",")[5], "85")

    def test_same_date_and_time_sorted_by_satellite_then_lat(self):
        self.write([
            det(0.5, -7, sat="Terra"), det(0.2, -7, sat="Terra"),
            det(0.9, -7, sat="Aqua"), det(0.1, -7, sat="Aqua"),
        ])
        got = [tuple(ln.split(",")[2:5]) for ln in self.lines(2020)[1:5]]
        self.assertEqual(got, [("0.1000", "-7.0000", "Aqua"), ("0.9000", "-7.0000", "Aqua"),
                               ("0.2000", "-7.0000", "Terra"), ("0.5000", "-7.0000", "Terra")])

    def test_rounding_onto_east_north_edge_is_clamped(self):
        self.write([det(0.99999, -6.00001)])  # both round to the excluded edge
        self.assertEqual(self.lines(2020)[1], "2020-01-01,1200,0.9999,-6.0001,Terra,50,1.0,D")

    def test_satellite_names_in_output(self):
        self.write([det(0, -7, time="0001", sat="Terra"), det(0, -7, time="0002", sat="Aqua"),
                    det(0, -7, time="0003", sat="N")])
        sats = [ln.split(",")[4] for ln in self.lines(2020)[1:4]]
        self.assertEqual(sats, ["Terra", "Aqua", "SNPP"])

    def test_noaa_satellite_names_in_output(self):
        self.write([det(0, -7, time="0001", sat="N20"), det(0, -7, time="0002", sat="N21")])
        self.assertEqual([ln.split(",")[4] for ln in self.lines(2020)[1:3]], ["NOAA20", "NOAA21"])

    def test_sorted_by_date_then_time_and_split_by_year(self):
        years, n = self.write([
            det(0, -7, date="2021-01-01", time="0100"),
            det(0, -7, date="2020-01-02", time="0100"),
            det(0, -7, date="2020-01-01", time="1300"),
            det(0, -7, date="2020-01-01", time="0200"),
        ])
        self.assertEqual((years, n), ([2020, 2021], 4))
        rows = [ln.split(",")[:2] for ln in self.lines(2020)[1:4]]
        self.assertEqual(rows, [["2020-01-01", "0200"], ["2020-01-01", "1300"], ["2020-01-02", "0100"]])
        self.assertEqual(len(self.lines(2021)), 3)  # header, one row, trailing empty

    def test_stale_year_files_removed_other_files_kept(self):
        os.makedirs(self.folder)
        for name in ("2019.csv", "2018.csv.part", "notes.txt", "20x.csv", "2019.csv.bak"):
            with open(os.path.join(self.folder, name), "w", encoding="utf-8") as f:
                f.write("old\n")
        self.write([det(0, -7)])
        self.assertEqual(sorted(os.listdir(self.folder)), ["2019.csv.bak", "2020.csv", "20x.csv", "notes.txt"])

    def test_missing_acq_date_raises(self):
        with self.assertRaises(ValueError):
            self.write([det(0, -7, date=None)])


class WriteIndexTests(unittest.TestCase):
    def test_other_regions_keep_point_years_and_rows(self):
        regions = [{"id": "a", "name": "A", "bbox": [0, 0, 1, 1], "fire_type": "w"},
                   {"id": "b", "name": "B", "bbox": [2, 2, 3, 3], "fire_type": "w"},
                   {"id": "c", "name": "C", "bbox": [4, 4, 5, 5], "fire_type": "w"}]
        sens = {s: {"first_date": None, "last_date": None, "detections": 0} for s in ("terra", "aqua", "viirs")}
        manifest = {r["id"]: {"archive_through": "2020-12-31", "sensors": sens} for r in regions[:2]}
        with tempfile.TemporaryDirectory() as tmp:
            index = os.path.join(tmp, "sub", "index.json")
            with mock.patch.object(build, "INDEX", index):
                build.write_index(regions, manifest, {"a": ([2019, 2020], 10), "b": ([2020], 5)})
                build.write_index(regions, manifest, {"a": ([2021], 3)})  # only a rebuilt
            text = read_text(index)
        self.assertNotIn("\r", text)
        data = json.loads(text)
        by_id = {e["id"]: e for e in data["regions"]}
        self.assertEqual(sorted(by_id), ["a", "b"])  # c has no manifest entry
        self.assertEqual((by_id["a"]["point_years"], by_id["a"]["point_rows"]), ([2021], 3))
        self.assertEqual((by_id["b"]["point_years"], by_id["b"]["point_rows"]), ([2020], 5))
        self.assertEqual(by_id["b"]["data_through"], "2020-12-31")
        self.assertEqual(set(by_id["b"]["sensors"]["terra"]), {"first_date", "last_date", "data_through"})

    def test_new_region_without_history_gets_empty_points(self):
        r = [{"id": "a", "name": "A", "bbox": [0, 0, 1, 1], "fire_type": "w"}]
        m = {"a": {"archive_through": None, "sensors": {}}}
        with tempfile.TemporaryDirectory() as tmp:
            index = os.path.join(tmp, "index.json")
            with mock.patch.object(build, "INDEX", index):
                build.write_index(r, m)
            e = json.loads(read_text(index))["regions"][0]
        self.assertEqual((e["point_years"], e["point_rows"]), ([], 0))


class EndToEndTests(RawDirCase):
    def test_grid_totals_equal_point_rows(self):
        modis = [det(37, -7, sat="Terra", time="0905"),
                 det(37, -7, sat="Terra", time="0906", frp=3.0, date="2020-01-05"),
                 det(37.1, -7.1, sat="Aqua", dn="N", time="2200"),
                 det(37, -7, typ=1),                       # dropped: type
                 det(40, -7)]                              # dropped: outside bbox
        viirs = [det(36.0, -8.0, sat="N", date="2020-02-02", time="0030"),
                 det(37.9, -6.1, sat="N", date="2020-02-02", time="0031")]
        df, through = self.load(modis, viirs)
        out = build.grid(df)
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(build, "POINTS", os.path.join(tmp, "{id}", "points")):
            years, rows = build.write_points(self.region, df)
            files = os.listdir(os.path.join(tmp, "xx", "points"))
        total = int(out.terra_n.sum() + out.aqua_n.sum() + out.viirs_n.sum())
        self.assertEqual(total, 5)
        self.assertEqual(rows, total)
        self.assertEqual((years, files), ([2020], ["2020.csv"]))
        cov = build.coverage(df, out, through)
        self.assertEqual(cov["sensors"], {
            "terra": {"first_date": "2020-01-01", "last_date": "2020-01-05", "detections": 2, "data_through": "2020-02-02"},
            "aqua": {"first_date": "2020-01-01", "last_date": "2020-01-01", "detections": 1, "data_through": "2020-02-02"},
            "viirs": {"first_date": "2020-02-02", "last_date": "2020-02-02", "detections": 2, "data_through": "2020-02-02"},
            "n20": {"first_date": None, "last_date": None, "detections": 0, "data_through": None},
            "n21": {"first_date": None, "last_date": None, "detections": 0, "data_through": None},
        })
        self.assertEqual(cov["grid_rows"], len(out))
        cov = build.coverage(df, out, through, {"n20": "2026-11-14", "terra": "2020-03-01"})
        self.assertEqual(cov["sensors"]["n20"]["data_through"], "2026-11-14")
        self.assertEqual(cov["sensors"]["terra"]["data_through"], "2020-03-01")
        self.assertIsNone(cov["sensors"]["n21"]["data_through"])
        self.assertEqual(cov["archive_through"], "2020-02-02")


if __name__ == "__main__":
    unittest.main()
