"""The landing-page scene's data side (scripts/landing_scene/srtm.py and layout.py): no Blender, no network.

Run from the repo root:
    python -m unittest discover -s tests -v
"""
import struct
import sys
import tempfile
import unittest
import zlib
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "landing_scene"))
import layout as L  # noqa: E402
import srtm  # noqa: E402

TILES = ROOT / "scripts" / "landing_scene" / "srtm_tiles"
POINTS = ROOT / "site" / "public" / "data" / "portugal" / "points" / "2017.csv"
SERIES = ROOT / "site" / "public" / "data" / "portugal" / "series.json"


def write_tiff(path, a, tile=4, compression=8, bits=16, predictor=1, sample_format=2):
    """A little-endian, tiled, deflate GeoTIFF-like file holding the int16 array `a` (what OpenTopography serves)."""
    h, w = a.shape
    blocks = []
    for r in range(0, h, tile):
        for c in range(0, w, tile):
            block = np.full((tile, tile), -1, dtype="<i2")
            part = a[r:r + tile, c:c + tile]
            block[: part.shape[0], : part.shape[1]] = part
            blocks.append(zlib.compress(block.tobytes()))
    n = len(blocks)
    entries = [(256, 3, 1, w), (257, 3, 1, h), (258, 3, 1, bits), (259, 3, 1, compression), (317, 3, 1, predictor),
               (322, 3, 1, tile), (323, 3, 1, tile), (324, 4, n, None), (325, 4, n, None)]
    if sample_format is not None:
        entries.append((339, 3, 1, sample_format))
    ifd_at = 8
    after = ifd_at + 2 + 12 * len(entries) + 4
    offsets_at, counts_at = after, after + 4 * n
    data_at = counts_at + 4 * n
    offsets, at = [], data_at
    for b in blocks:
        offsets.append(at)
        at += len(b)
    out = bytearray(b"II*\x00" + struct.pack("<I", ifd_at) + struct.pack("<H", len(entries)))
    for tag, typ, count, value in entries:
        if tag == 324:
            value = offsets_at if n > 1 else offsets[0]
        elif tag == 325:
            value = counts_at if n > 1 else len(blocks[0])
        out += struct.pack("<HHI", tag, typ, count)
        out += struct.pack("<I", value) if typ == 4 or count > 1 else struct.pack("<HH", value, 0)
    out += struct.pack("<I", 0)
    out += struct.pack(f"<{n}I", *offsets) + struct.pack(f"<{n}I", *(len(b) for b in blocks))
    for b in blocks:
        out += b
    Path(path).write_bytes(bytes(out))


class TiffReader(unittest.TestCase):
    def test_reads_a_tiled_deflate_tile_with_partial_edge_blocks(self):
        a = (np.arange(11 * 10, dtype=np.int16).reshape(11, 10) - 30).astype(np.int16)
        with tempfile.TemporaryDirectory() as d:
            write_tiff(Path(d) / "t.tif", a)
            got = srtm.read_tile(Path(d) / "t.tif")
        self.assertEqual(got.dtype, np.int16)
        np.testing.assert_array_equal(got, a)

    def test_refuses_formats_it_does_not_decode(self):
        a = np.zeros((4, 4), dtype=np.int16)
        with tempfile.TemporaryDirectory() as d:
            for name, kw in (("lzw", {"compression": 5}), ("bits", {"bits": 8}), ("pred", {"predictor": 2}),
                             ("unsigned", {"sample_format": 1}), ("no sample format", {"sample_format": None})):
                write_tiff(Path(d) / f"{name}.tif", a, **kw)
                with self.assertRaises(ValueError, msg=name):
                    srtm.read_tile(Path(d) / f"{name}.tif")
            (Path(d) / "big.tif").write_bytes(b"MM\x00*" + b"\x00" * 20)
            with self.assertRaises(ValueError):
                srtm.read_tile(Path(d) / "big.tif")

    def test_tile_names(self):
        self.assertEqual(srtm.tile_name(39, -9), "N39W009")
        self.assertEqual(srtm.tile_name(-1, 12), "S01E012")


@unittest.skipUnless(all((TILES / f"{n}.tif").exists() for n in ("N39W009", "N39W008", "N40W009", "N40W008")),
                     "SRTM tiles not present")
class Terrain(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dem = srtm.mosaic(TILES, download=False)

    def test_mosaic_is_georeferenced(self):
        dem = self.dem
        self.assertEqual(dem.shape, (2401, 2401))
        self.assertGreaterEqual(float(dem.min()), 0.0)
        # Torre, Serra da Estrela: mainland Portugal's highest point, 1,993 m at 40.3217 N, 7.6130 W
        r, c = np.unravel_index(dem.argmax(), dem.shape)
        self.assertAlmostEqual(41 - r / 1200, 40.3217, delta=0.01)
        self.assertAlmostEqual(-9 + c / 1200, -7.6130, delta=0.01)
        self.assertAlmostEqual(float(dem.max()), 1993, delta=10)
        self.assertEqual(float(dem[1200, 0]), 0.0)  # 40 N, 9 W is the Atlantic

    def test_height_lookup_matches_the_grid_and_is_zero_outside(self):
        x, y = L.project(40.3217, -7.6125)
        self.assertAlmostEqual(float(L.height_km(self.dem, x, y)), float(self.dem.max()) / 1000 * L.EXAG, delta=0.05)
        self.assertEqual(float(L.height_km(self.dem, 500.0, 0.0)), 0.0)
        mid = L.height_km(self.dem, *L.project(40.0 - 0.5 / 1200, -8.0))  # half-way between two samples
        self.assertAlmostEqual(float(mid), (self.dem[1200, 1200] + self.dem[1201, 1200]) / 2000 * L.EXAG, places=6)

    def test_camera_stays_above_the_ground_and_ends_looking_straight_down(self):
        last = 0.0
        for f in np.arange(0, L.STORY_ANCHORS[-1] + 1, 0.5):  # story time
            c = L.camera(self.dem, f)
            eye = c["eye"]
            self.assertTrue(all(np.isfinite(eye)) and all(np.isfinite(c["target"])), f)
            above = eye[2] - float(L.height_km(self.dem, eye[0], eye[1]))
            self.assertGreater(above, 0.003, f"frame {f}: eye {above * 1000:.1f} m above the ground")
            self.assertGreaterEqual(eye[2], last - 1e-6, f"frame {f}: the flight only climbs")
            last = eye[2]
        for f in (72, 108, 144, 179):
            c = L.camera(self.dem, f)
            self.assertLess(np.hypot(c["eye"][0] - c["target"][0], c["eye"][1] - c["target"][1]), 1.0)

    def test_surface_is_the_drawn_mesh(self):
        d = self.dem[::2, ::2]
        for r, c in ((600, 700), (601, 699), (300, 950)):  # grid nodes: the vertex heights scene.py writes
            x, y = L.project(srtm.LAT1 - r * 2 / 1200, srtm.LON0 + c * 2 / 1200)
            self.assertAlmostEqual(float(L.surface_km(self.dem, x, y)), d[r, c] / 1000 * L.EXAG, places=6)
        # inside a grid square: flat on each of its two triangles, which meet on the diagonal
        r, c = 600, 700
        z = d[r:r + 2, c:c + 2].astype(float) / 1000 * L.EXAG
        at = lambda fr, fc: float(L.surface_km(self.dem, *L.project(srtm.LAT1 - (r + fr) * 2 / 1200, srtm.LON0 + (c + fc) * 2 / 1200)))  # noqa: E731
        self.assertAlmostEqual(at(0.5, 0.5), (z[0, 0] + z[1, 1]) / 2, places=6)
        self.assertAlmostEqual(at(0.75, 0.25), z[0, 0] + 0.75 * (z[1, 0] - z[0, 0]) + 0.25 * (z[1, 1] - z[1, 0]), places=6)
        self.assertAlmostEqual(at(0.25, 0.75), z[0, 0] + 0.75 * (z[0, 1] - z[0, 0]) + 0.25 * (z[1, 1] - z[0, 1]), places=6)
        self.assertEqual(float(L.surface_km(self.dem, 500.0, 0.0)), 0.0)
        faces = L.mesh_faces(3, 4)
        self.assertEqual(faces.shape, (2 * 2 * 3, 3))
        self.assertTrue(any(list(f) == [0, 4, 5] for f in faces) and any(list(f) == [0, 5, 1] for f in faces))

    def test_the_opening_viewpoint_sees_the_fire(self):
        p = L.load_points(POINTS)
        (x, y), seen, total = L.viewpoint(self.dem, p, L.CLOCK[0][1])
        self.assertEqual((x, y), L.EYE)
        self.assertGreater(seen, 150)
        self.assertGreater(total, seen)


class Detections(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.p = L.load_points(POINTS)
        cls.on = L.on_frames(cls.p)
        cls.n = len(cls.on)

    def test_points_are_the_published_ones_inside_the_tiles_in_time_order(self):
        p = self.p
        self.assertEqual(self.n, 16906)
        self.assertTrue(np.all(np.diff(p["t"]) >= 0))
        self.assertEqual(int(p["modis"].sum()), sum(s in ("Terra", "Aqua") for s in p["satellite"]))
        self.assertLessEqual(float(np.abs(p["x"]).max()), L.KM_LON + 1e-6)
        self.assertLessEqual(float(np.abs(p["y"]).max()), L.KM_LAT + 1e-6)
        self.assertEqual(L.minute_of_year("2017-01-01", "0000"), 0)
        self.assertEqual(L.minute_of_year("2017-06-18", "1253"), (168 * 24 + 12) * 60 + 53)
        self.assertEqual(L.minute_of_year("2017-03-01", "5"), 59 * 1440 + 5)

    def test_everything_switches_on_by_frame_108_in_date_order(self):
        p, on = self.p, self.on
        self.assertLessEqual(float(on.max()), 108.0)
        self.assertEqual(int((on <= 108).sum()), self.n)
        in_pass = np.zeros(self.n, dtype=bool)
        for ps in L.PASSES:
            t0, t1 = L._m(L.STORY_DAY, ps["from"]), L._m(L.STORY_DAY, ps["to"])
            sel = np.array([s == ps["satellite"] for s in p["satellite"]]) & (p["t"] >= t0) & (p["t"] <= t1)
            self.assertGreater(int(sel.sum()), 30, ps["satellite"])
            self.assertTrue(np.all((on[sel] >= ps["frames"][0]) & (on[sel] <= ps["frames"][1])), ps["satellite"])
            along = L.along_track(p["x"][sel], p["y"][sel])
            self.assertGreater(float(along.min()), ps["track"][0][1], "the scan line starts south of every detection")
            self.assertLess(float(along.max()), ps["track"][-1][1], "and ends north of every one")
            in_pass |= sel
        self.assertTrue(np.all(np.diff(on[~in_pass]) >= 0), "outside the two scan-line passes, later means later")
        before = p["t"] < L.CLOCK[0][1]
        self.assertTrue(np.all(on[before] < 0) and np.all(on[~before] >= 0))
        counts = [int((on <= f).sum()) for f in range(0, 109)]
        self.assertTrue(all(b >= a for a, b in zip(counts, counts[1:])))

    def test_the_scan_line_crosses_once_per_pass_and_reaches_each_square_as_it_lights(self):
        self.assertIsNone(L.scan_line(0))
        self.assertIsNone(L.scan_line(100))
        for ps in L.PASSES:
            f0, f1 = ps["frames"]
            got = L.scan_line((f0 + f1) / 2)
            self.assertIs(got[0], ps)
            kf, km = zip(*ps["track"])
            self.assertEqual((kf[0], kf[-1]), (f0, f1))
            self.assertTrue(np.all(np.diff(kf) > 0) and np.all(np.diff(km) > 0), "northbound, never backing up")
            self.assertAlmostEqual(L.scan_line(f0)[1], km[0])
            self.assertAlmostEqual(L.scan_line(f1)[1], km[-1])
            # slowest over the fire: km per frame there is a fraction of the speed it enters and leaves at
            speed = np.diff(km) / np.diff(kf)
            fire = float(L.along_track(*L.FIRE))
            self.assertTrue(km[1] < fire < km[2])
            self.assertLess(speed[1] * 3, min(speed[0], speed[2]), ps["satellite"])
            sel = np.array([s == ps["satellite"] for s in self.p["satellite"]]) & (self.on >= f0) & (self.on <= f1) \
                & (self.p["t"] >= L._m(L.STORY_DAY, ps["from"])) & (self.p["t"] <= L._m(L.STORY_DAY, ps["to"]))
            for i in np.where(sel)[0][::17]:
                at = L.scan_line(self.on[i])[1]
                self.assertAlmostEqual(at, float(L.along_track(self.p["x"][i], self.p["y"][i])), places=6)
        # one satellite at a time, in the order they flew over, both done by the chapter-3 frame
        a, b = L.PASSES
        self.assertEqual((a["satellite"], b["satellite"]), ("Aqua", "SNPP"))
        self.assertLess(a["frames"][1], b["frames"][0])
        self.assertLessEqual(b["frames"][1], L.STORY_ANCHORS[2])
        # the 375 m re-scan crosses the fire more slowly than Aqua's 1 km scan
        crawl = lambda ps: (ps["track"][2][0] - ps["track"][1][0]) / (ps["track"][2][1] - ps["track"][1][1])  # noqa: E731
        self.assertGreater(crawl(b), crawl(a) * 1.5)
        self.assertIsNone(L.scan_line((a["frames"][1] + b["frames"][0]) / 2))

    def test_heat_is_zero_until_on_and_between_0_and_1_after(self):
        for f in (0, 30, 60, 72, 90, 108, 130, 179):
            h = L.heat(self.p, self.on, f)
            self.assertTrue(np.all((h >= 0) & (h <= 1)), f)
            if f < 108:
                self.assertTrue(np.all(h[self.on > f] == 0), f)
            self.assertTrue(np.all(h[self.on <= f] >= 0.2), f)
        self.assertTrue(np.all(L.heat(self.p, self.on, 179) >= 0.8))

    def test_timeline_is_a_daily_histogram_with_one_slot_per_square(self):
        p = self.p
        x, y = L.timeline_slots(p["day"])
        self.assertEqual(len(set(zip(np.round(x, 5), np.round(y, 5)))), self.n)
        self.assertGreaterEqual(float(x.min()), L.HIST["x0"])
        self.assertLessEqual(float(x.max()), L.HIST["x1"])
        pitch_day = (L.HIST["x1"] - L.HIST["x0"]) / 365
        np.testing.assert_array_equal(np.floor((x - L.HIST["x0"]) / pitch_day).astype(int), p["day"])
        pitch = pitch_day * (1 - L.HIST["gap"]) / L.HIST["sub"]
        rows = np.rint((y - L.HIST["y0"]) / pitch - 0.5).astype(int)
        for day in (167, 168, 288):  # 17 and 18 June, 16 October
            k = int((p["day"] == day).sum())
            self.assertEqual(int(rows[p["day"] == day].max()), (k - 1) // L.HIST["sub"], day)
        busiest = int(np.bincount(p["day"]).argmax())
        self.assertEqual(busiest, 288)
        self.assertLess(float(y.max()), 55.0, "the tallest column stays in the picture")

    def test_shares_add_up_and_follow_the_values(self):
        np.testing.assert_array_equal(L.shares(np.array([1.0, 1.0, 2.0]), 8), [2, 2, 4])
        got = L.shares(np.array([0.0, 5.0, 0.0, 5.0, 1e-9]), 7)
        self.assertEqual(int(got.sum()), 7)
        self.assertEqual(int(got[0]), 0)
        self.assertLessEqual(abs(int(got[1]) - int(got[3])), 1)
        with self.assertRaises(ValueError):
            L.shares(np.zeros(4), 5)

    def test_calendar_cells_hold_squares_in_proportion_to_the_harmonized_months(self):
        start, v = L.monthly_harmonized(SERIES)
        self.assertEqual(start, 2001)
        self.assertGreaterEqual(len(v), 300)  # 2001 to at least 2025
        self.assertLessEqual(len(v), L.GRID["years"] * L.GRID["months"], "a 27th year needs GRID['years'] raised")
        self.assertTrue(np.all(v >= 0) and v.sum() > 0)
        with self.assertRaises(ValueError):
            L.calendar_slots(np.ones(L.GRID["years"] * L.GRID["months"] + 1), 100)
        x, y, cell = L.calendar_slots(v, self.n)
        self.assertEqual(len(set(zip(np.round(x, 5), np.round(y, 5)))), self.n)
        full = np.zeros(L.GRID["years"] * L.GRID["months"])
        full[: len(v)] = v
        count = np.bincount(cell, minlength=len(full))
        np.testing.assert_array_equal(count, L.shares(full, self.n))
        self.assertTrue(np.all(np.abs(count - full / full.sum() * self.n) < 1.0))
        # every square sits inside its own cell
        year, month = cell // 12, cell % 12
        cx = (year - (L.GRID["years"] - 1) / 2) * L.GRID["pitch"]
        cy = ((L.GRID["months"] - 1) / 2 - month) * L.GRID["pitch"]
        self.assertLessEqual(float(np.abs(x - cx).max()), L.GRID["inner"] / 2)
        self.assertLessEqual(float(np.abs(y - cy).max()), L.GRID["inner"] / 2)
        self.assertEqual(int(count.argmax()), int(full.argmax()))
        self.assertTrue(np.all(cell[np.argsort(cell, kind="stable")] == cell), "squares are dealt out cell by cell")

    def test_squares_are_on_the_ground_then_on_the_timeline_then_in_the_calendar(self):
        p, on, n = self.p, self.on, self.n
        z = np.linspace(0.1, 2.0, n)
        st = L.timeline_slots(p["day"])
        sc = L.calendar_slots(L.monthly_harmonized(SERIES)[1], n)[:2]
        pos, size, heat = L.squares(p, z, on, st, sc, 72)
        np.testing.assert_allclose(pos[:, 0], p["x"])
        np.testing.assert_allclose(pos[:, 1], p["y"])
        self.assertTrue(np.all(pos[:, 2] > z) and np.all(pos[:, 2] < z + 0.06))
        np.testing.assert_allclose(size, np.where(p["modis"], 1.0, 0.375))
        self.assertTrue(np.all(pos[p["modis"], 2] - z[p["modis"]] < pos[~p["modis"], 2].min() - z[~p["modis"]].min() + 1e-9))
        pos, size, _ = L.squares(p, z, on, st, sc, 144)
        np.testing.assert_allclose(pos[:, 0], st[0])
        np.testing.assert_allclose(pos[:, 1], st[1])
        np.testing.assert_allclose(pos[:, 2], L.Z_PLANE)
        np.testing.assert_allclose(size, L.SIZE_HIST)
        pos, size, heat = L.squares(p, z, on, st, sc, 179)
        np.testing.assert_allclose(pos[:, 0], sc[0])
        np.testing.assert_allclose(pos[:, 1], sc[1])
        np.testing.assert_allclose(pos[:, 2], L.Z_PLANE, atol=1e-9)
        np.testing.assert_allclose(size, L.SIZE_GRID)
        self.assertTrue(np.all(np.isfinite(pos)))
        for f in np.arange(0, L.STORY_ANCHORS[-1] + 1, 3.5):
            pos, size, heat = L.squares(p, z, on, st, sc, f)
            self.assertTrue(np.all(np.isfinite(pos)) and np.all(size > 0), f)

    def test_clock_and_frames(self):
        self.assertEqual(L.FRAMES, 360)
        self.assertEqual(L.ANCHORS, (0, 72, 144, 216, 288, 359))
        self.assertEqual(L.ANCHORS[-1], L.FRAMES - 1)
        for frame, t in zip(L.ANCHORS, L.STORY_ANCHORS):
            self.assertEqual(L.story_time(frame), t)
        self.assertEqual(L.story_time(36), 18)
        ts = [L.story_time(f) for f in range(L.FRAMES)]
        self.assertTrue(all(b > a for a, b in zip(ts, ts[1:])), "every rendered frame is a new moment")
        ts = [L.clock(f) for f in range(0, 180)]
        self.assertTrue(all(b >= a for a, b in zip(ts, ts[1:])))
        self.assertEqual(L.clock(150), L.clock(108))
        self.assertAlmostEqual(L.clock(108), L.minute_of_year("2017-12-31", "2359"))


if __name__ == "__main__":
    unittest.main()
