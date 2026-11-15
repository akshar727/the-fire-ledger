"""build_country.py (DP-011): per-year streaming gives the same grid as build.grid on all rows; filters; manifest
(no forward link for a country); --delete-raw; failures; and on real data, Portugal's country files reproduce the
committed Portugal grid.

Run from the repo root:
    python -m unittest tests.test_build_country -v
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

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import build  # noqa: E402
import build_country as bc  # noqa: E402
import model  # noqa: E402

SRC = {"modis": range(2019, 2021), "viirs-snpp": range(2019, 2021), "viirs-jpss1": range(2020, 2021)}


def det(lat, lon, date, sat="Terra", frp=1.0, dn="D", typ=0):
    return dict(latitude=lat, longitude=lon, acq_date=date, acq_time="1200", satellite=sat,
                confidence="50", frp=frp, daynight=dn, type=typ)


# one file per archive and year, as FIRMS publishes them (a file holds only its own year)
FILES = {
    ("modis", 2019): [det(1.1, 2.1, "2019-03-01"), det(1.2, 2.2, "2019-03-01", frp=3.0),
                      det(1.1, 2.1, "2019-03-01", sat="Aqua", dn="N"), det(9.9, 9.9, "2019-12-31", typ=2)],
    ("viirs-snpp", 2019): [det(1.1, 2.1, "2019-03-01", sat="N", frp=1), det(1.1, 2.1, "2019-03-01", sat="N", frp=2),
                           det(1.1, 2.1, "2019-03-01", sat="N", frp=2), det(5.0, 5.0, "2019-06-01", sat="N")],
    ("modis", 2020): [det(1.1, 2.1, "2020-01-05"), det(-3.0, 40.0, "2020-12-30", sat="Aqua"),
                      det(6.0, 3.0, "2020-02-02"), det(3.0, 6.0, "2020-02-02")],   # last two: on the east/north edge
    ("viirs-snpp", 2020): [det(1.1, 2.1, "2020-01-05", sat="N"), det(1.1, 2.1, "2020-01-05", sat="N", dn="N")],
    ("viirs-jpss1", 2020): [det(7.7, 7.7, "2020-01-05", sat="N20", frp=2.0)],   # must not be read for a country
}


def stub_fetch(files, log):
    def fetch(url, path):
        archive, year = url.split("/")[-3], int(url.split("/")[-2])
        pd.DataFrame(files.get((archive, year), []), columns=build.COLS).to_csv(path, index=False)
        log.append(path)
    return fetch


def run(c, raw, out, files=FILES, fetch=None, **kw):
    log = []
    with mock.patch.object(build, "SRC", SRC), contextlib.redirect_stdout(io.StringIO()):
        entry = bc.build_country(c, raw=raw, out_dir=out, fetch=fetch or stub_fetch(files, log), **kw)
    grid = pd.read_csv(Path(out, f"fire_grid_daily_{c['id']}.csv"), dtype={"date": str})
    return grid, entry, log


def expected(files, bbox=None):
    """build.grid on every type-0 row of the model's archives at once (the reference the streaming must match)."""
    rows = pd.DataFrame([r for (a, _), v in files.items() if a in bc.ARCHIVES for r in v])
    rows = rows[rows.type == 0]
    if bbox:
        x0, y0, x1, y1 = bbox
        rows = rows[rows.longitude.between(x0, x1, inclusive="left") & rows.latitude.between(y0, y1, inclusive="left")]
    with tempfile.TemporaryDirectory() as d:   # same CSV round trip as the streamed file
        p = Path(d, "g.csv")
        build.grid(rows)[bc.COLUMNS].to_csv(p, index=False, lineterminator="\n")
        return pd.read_csv(p, dtype={"date": str})


C = {"id": "x", "name": "X", "country": "X", "fire_type": "test"}
BOX = [0.0, 0.0, 6.0, 6.0]


class StreamingGrid(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.raw, self.out = (Path(self.tmp.name, n) for n in ("raw", "out"))
        self.raw.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def test_same_as_gridding_everything_at_once(self):
        grid, _, _ = run(C, self.raw, self.out)
        pd.testing.assert_frame_equal(grid, expected(FILES))
        self.assertEqual(list(grid.columns), bc.COLUMNS)

    def test_rounding_and_chunked_reads(self):
        with mock.patch.object(bc, "CHUNK", 2):   # every file is read in pieces of 2 rows
            grid, entry, _ = run(C, self.raw, self.out)
        pd.testing.assert_frame_equal(grid, expected(FILES))
        self.assertEqual(entry["archive_through"], "2020-12-30")
        row = grid[(grid.date == "2019-03-01") & (grid.lat == 1.0) & (grid.daynight == "D")].iloc[0]
        self.assertEqual(row.viirs_frp_mean, 1.67)   # mean of 1, 2, 2 rounded like build.grid

    def test_bbox_edges_and_type(self):
        grid, entry, _ = run({**C, "bbox": BOX}, self.raw, self.out)
        pd.testing.assert_frame_equal(grid, expected(FILES, BOX))
        self.assertNotIn(-3.0, set(grid.lat))          # outside the bbox
        self.assertNotIn(6.0, set(grid.lat))           # on the north edge: excluded (half-open)
        self.assertNotIn(6.0, set(grid.lon))           # on the east edge: excluded
        self.assertNotIn(9.75, set(grid.lat))          # type 2 (not vegetation)
        self.assertEqual(entry["sensors"]["aqua"]["detections"], 1)

    def test_noaa_files_are_not_read(self):
        grid, entry, log = run(C, self.raw, self.out)
        self.assertFalse(any("jpss1" in p for p in log))
        self.assertNotIn(7.5, set(grid.lat))
        self.assertTrue((grid[["n20_n", "n21_n"]] == 0).all().all())
        self.assertEqual(set(entry["sensors"]), {"terra", "aqua", "viirs"})

    def test_manifest_fields_and_no_forward_link(self):
        _, e, _ = run({**C, "bbox": BOX}, self.raw, self.out)
        # archive_through: latest day in any MODIS / S-NPP file before filtering (the 2020-12-30 Aqua row is outside)
        self.assertEqual(e["archive_through"], "2020-12-30")
        self.assertEqual({v["data_through"] for v in e["sensors"].values()}, {"2020-12-30"})
        self.assertEqual(e["sensors"]["terra"]["first_date"], "2019-03-01")
        self.assertEqual(e["sensors"]["viirs"]["detections"], 6)
        self.assertEqual(e["tier"], "country")
        self.assertIsNone(model.forward_through(e["sensors"], e["archive_through"]))
        man = json.loads(Path(self.out, "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(man["x"], e)

    def test_header_only_and_empty_years(self):
        files = {k: ([] if k[1] == 2020 else v) for k, v in FILES.items()}   # 2020: header-only files
        grid, e, _ = run(C, self.raw, self.out, files=files)
        pd.testing.assert_frame_equal(grid, expected(files))
        self.assertEqual(e["archive_through"], "2019-12-31")
        empty = {k: [] for k in FILES}
        grid, e, _ = run({**C, "id": "y", "country": "Y"}, self.raw, self.out, files=empty)
        self.assertEqual((len(grid), list(grid.columns), e["archive_through"]), (0, bc.COLUMNS, None))

    def test_delete_raw_removes_only_downloaded_files(self):
        mine = Path(self.raw, "modis_2019_X.csv")
        pd.DataFrame(FILES[("modis", 2019)], columns=build.COLS).to_csv(mine, index=False)
        _, _, log = run(C, self.raw, self.out, delete_raw=True)
        self.assertTrue(mine.exists())                  # was there before the run: kept
        self.assertEqual(len(log), 3)
        self.assertEqual(sorted(os.listdir(self.raw)), ["modis_2019_X.csv"])

    def test_failed_download_keeps_old_output_and_files(self):
        run(C, self.raw, self.out)
        before = Path(self.out, "fire_grid_daily_x.csv").read_bytes()
        log = []
        ok = stub_fetch(FILES, log)
        def flaky(url, path):
            if "/2020/" in url:
                raise SystemExit("network down")
            ok(url, path)
        for p in self.raw.iterdir():
            p.unlink()
        with self.assertRaises(SystemExit):
            run(C, self.raw, self.out, fetch=flaky, delete_raw=True)
        self.assertEqual(Path(self.out, "fire_grid_daily_x.csv").read_bytes(), before)
        self.assertFalse(Path(self.out, "fire_grid_daily_x.csv.part").exists())
        self.assertEqual(len(log), 2)                   # 2019 gridded, then its downloads deleted
        self.assertEqual(os.listdir(self.raw), [])

    def test_file_from_another_year_is_refused(self):
        files = {**FILES, ("modis", 2020): [det(1.1, 2.1, "2019-03-01")]}
        with self.assertRaises(SystemExit):
            run(C, self.raw, self.out, files=files)

    def test_bad_countries_file(self):
        with self.assertRaises(SystemExit):
            bc.check_countries([{"id": "Bad Id", "name": "a", "country": "a", "fire_type": "a"}])
        with self.assertRaises(SystemExit):
            bc.check_countries([{"id": "a", "name": "a", "country": "a"}])
        bc.check_countries(json.loads((ROOT / "countries.json").read_text(encoding="utf-8")))


@unittest.skipUnless((ROOT / "data/raw/modis_2010_Portugal.csv").exists(), "Portugal raw files not present")
class RealPortugal(unittest.TestCase):
    def test_reproduces_committed_portugal_grid(self):
        """Same files, same bbox as regions.json: every archive day matches data/grid (terra, aqua, viirs)."""
        region = next(r for r in json.loads((ROOT / "regions.json").read_text(encoding="utf-8")) if r["id"] == "portugal")
        c = {"id": "portugal", "name": "Portugal", "country": "Portugal", "fire_type": "-", "bbox": region["bbox"]}
        def no_download(url, path):
            raise AssertionError(f"tried to download {url}")
        with tempfile.TemporaryDirectory() as out, contextlib.redirect_stdout(io.StringIO()):
            entry = bc.build_country(c, raw=str(ROOT / "data/raw"), out_dir=out, fetch=no_download)
            got = pd.read_csv(Path(out, "fire_grid_daily_portugal.csv"))
        ref = pd.read_csv(ROOT / "data/grid/fire_grid_daily_portugal.csv")
        cols = ["date", "lat", "lon", "daynight", "terra_n", "aqua_n", "viirs_n",
                "terra_frp_mean", "aqua_frp_mean", "viirs_frp_mean"]
        def norm(d):
            d = d[d.date <= entry["archive_through"]][cols]
            d = d[(d[["terra_n", "aqua_n", "viirs_n"]] > 0).any(axis=1)]   # drop NOAA-only rows of the reference
            return d.sort_values(cols[:4]).reset_index(drop=True)
        want = norm(ref)
        self.assertGreater(len(want), 30000)
        pd.testing.assert_frame_equal(norm(got), want, check_dtype=False)
        self.assertEqual(len(got), len(norm(got)))   # the country grid has no NOAA-only rows


if __name__ == "__main__":
    unittest.main()
