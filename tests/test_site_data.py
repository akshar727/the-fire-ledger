"""Validate every data file the website reads against the registered contracts.

Stdlib-only. Run from the repo root:
    python -m unittest discover -s tests -v

Env var SITE_DATA_DIR points the suite at another copy of the data (e.g. for
manual negative experiments); its basename must be "data". Default is
site/public/data. The secret scan covers the parent of that root.
Files that are not produced yet (series, cells, points) are skipped, not failed.
"""
import json
import os
import re
import sys
import unittest
from datetime import date
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DATA = Path(os.environ.get("SITE_DATA_DIR") or REPO / "site/public/data")
if os.environ.get("SITE_DATA_DIR"):
    if DATA.name != "data":
        raise RuntimeError(f"SITE_DATA_DIR must end in 'data', got {DATA}")
    print(f"test_site_data: data root = {DATA}", file=sys.stderr)
PUBLIC = DATA.parent
MAX_POINT_FILE_BYTES = 50 * 1024 * 1024
# Regions the site must always ship (the MVP demo region). Git drops empty folders, so a
# deleted annual.json would otherwise look like "not modelled yet" and silently pass.
REQUIRED_REGIONS = ("portugal",)
POINT_HEADER = "date,time_utc,lat,lon,satellite,confidence,frp_mw,daynight"
HEX32 = re.compile(rb"(?<![0-9A-Fa-f])[0-9A-Fa-f]{32,}(?![0-9A-Fa-f])")
HEX_TAIL = re.compile(rb"[0-9A-Fa-f]*$")
ID_RE = re.compile(r"^[a-z0-9-]+$")


def _bad_const(name):
    raise AssertionError("non-finite JSON constant " + name)


def load_json(path):
    raw = path.read_bytes()
    if b"\r" in raw:
        raise AssertionError(f"{path}: contains CR (must be LF only)")
    return json.loads(raw.decode("utf-8"), parse_constant=_bad_const)


def modelled(d):
    """A region folder holding only points/ is not modelled yet."""
    return d.is_dir() and any(x.name != "points" for x in d.iterdir())


def is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def iso(s):
    if not isinstance(s, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        return False
    try:
        date.fromisoformat(s)
        return True
    except ValueError:
        return False


class SiteDataTests(unittest.TestCase):
    def index(self):
        p = DATA / "index.json"
        if not p.exists():
            self.skipTest(f"{p} not produced yet")
        return load_json(p)

    def region_ids(self):
        return [r["id"] for r in self.index()["regions"]]

    def check_arrays(self, p, obj, keys, nulls=()):
        n = None
        for k in keys:
            self.assertTrue(k in obj, f"{p}: missing key {k}")
            a = obj[k]
            self.assertIsInstance(a, list, f"{p}: {k} not a list")
            n = len(a) if n is None else n
            self.assertEqual(len(a), n, f"{p}: {k} length {len(a)} != {n}")
            for i, v in enumerate(a):
                ok = is_num(v) or (v is None and k in nulls)
                self.assertTrue(ok, f"{p}: {k}[{i}]={v!r} invalid")
        return n

    def test_no_crlf_or_nonfinite_in_json(self):
        files = sorted(DATA.rglob("*.json")) if DATA.exists() else []
        if not files:
            self.skipTest("no JSON files yet")
        for p in files:
            with self.subTest(file=str(p)):
                load_json(p)

    def test_index(self):
        p = DATA / "index.json"
        d = self.index()
        self.assertEqual(d.get("schema"), 1, f"{p}: schema")
        self.assertIsInstance(d.get("regions"), list, f"{p}: regions")
        seen = set()
        for r in d["regions"]:
            with self.subTest(region=r.get("id")):
                rid = r.get("id")
                self.assertTrue(isinstance(rid, str) and ID_RE.match(rid), f"{p}: bad id {rid!r}")
                self.assertNotIn(rid, seen, f"{p}: duplicate id {rid}")
                seen.add(rid)
                self.assertTrue(isinstance(r.get("name"), str) and r["name"], f"{p}:{rid}: name")
                self.assertTrue(isinstance(r.get("fire_type"), str), f"{p}:{rid}: fire_type")
                b = r.get("bbox")
                self.assertTrue(isinstance(b, list) and len(b) == 4 and all(map(is_num, b)),
                                f"{p}:{rid}: bbox must be 4 numbers")
                w, s, e, n = b
                self.assertTrue(-180 <= w < e <= 180, f"{p}:{rid}: bbox lon {w},{e}")
                self.assertTrue(-90 <= s < n <= 90, f"{p}:{rid}: bbox lat {s},{n}")
                self.assertTrue(iso(r.get("data_through")), f"{p}:{rid}: data_through")
                for sen in ("terra", "aqua", "viirs"):
                    sd = r.get("sensors", {}).get(sen)
                    self.assertIsInstance(sd, dict, f"{p}:{rid}: sensors.{sen}")
                    fd = sd.get("first_date")
                    self.assertTrue(iso(fd) or (fd is None and sd.get("last_date") is None),
                                    f"{p}:{rid}: {sen}.first_date")
                    ld = sd.get("last_date")
                    self.assertTrue(ld is None or iso(ld), f"{p}:{rid}: {sen}.last_date")
                py = r.get("point_years")
                self.assertTrue(isinstance(py, list) and all(map(is_int, py)), f"{p}:{rid}: point_years")
                self.assertEqual(py, sorted(set(py)), f"{p}:{rid}: point_years not sorted unique")
                pr = r.get("point_rows")
                self.assertTrue(is_int(pr) and pr >= 0, f"{p}:{rid}: point_rows")
                if not py:
                    self.assertEqual(pr, 0, f"{p}:{rid}: point_rows must be 0 with no point_years")

    def test_folders_match_regions(self):
        ids = set(self.region_ids())
        for d in sorted(x for x in DATA.iterdir() if x.is_dir()):
            with self.subTest(folder=d.name):
                self.assertIn(d.name, ids, f"{d}: stray folder, not a region in index.json")
        for rid in REQUIRED_REGIONS:
            with self.subTest(required=rid):
                self.assertIn(rid, ids, f"required region {rid} missing from index.json")
                self.assertTrue((DATA / rid / "annual.json").is_file(),
                                f"{DATA / rid}/annual.json missing: required region (REQUIRED_REGIONS)")
        for rid in sorted(ids):
            with self.subTest(region=rid):
                if modelled(DATA / rid):
                    self.assertTrue((DATA / rid / "annual.json").is_file(),
                                    f"{DATA / rid}: folder exists but annual.json missing")

    def test_annual(self):
        ran = False
        for rid in self.region_ids():
            d = DATA / rid
            with self.subTest(region=rid):
                if not modelled(d):
                    self.skipTest(f"{rid}: not modelled yet (no data folder)")
                ran = True
                p = d / "annual.json"
                self.assertTrue(p.is_file(), f"{p}: annual.json missing")
                a = load_json(p)
                n = self.check_arrays(p, a, ["years", "modis", "viirs", "pred", "lo", "hi"],
                                      nulls=("viirs",))
                self.assertTrue(all(map(is_int, a["years"])), f"{p}: years must be ints")
                for i in range(1, n):
                    self.assertEqual(a["years"][i], a["years"][i - 1] + 1, f"{p}: years not consecutive at {i}")
                self.assertTrue("score" in a, f"{p}: missing key score")
                sc = a["score"]
                self.assertIsInstance(sc, dict, f"{p}: score")
                for k in ("mape_model", "mape_ratio", "coverage", "n_hold", "ratio", "alpha", "weekly_r"):
                    self.assertTrue(k in sc, f"{p}: score.{k} missing")
                    self.assertTrue(is_num(sc[k]), f"{p}: score.{k}={sc[k]!r} not a number")
                self.assertTrue(is_int(sc["coverage"]) and is_int(sc["n_hold"]), f"{p}: coverage/n_hold ints")
                self.assertTrue(0 <= sc["coverage"] <= sc["n_hold"], f"{p}: coverage out of range")
                if "partial" in a:
                    self.assertEqual(len(a["partial"]), n, f"{p}: partial length")
                    self.assertTrue(all(v in (0, 1) and is_int(v) for v in a["partial"]), f"{p}: partial values")
                if "data_through" in a:
                    self.assertTrue(iso(a["data_through"]), f"{p}: data_through")
        if not ran:
            self.skipTest("no region has data yet")

    def test_series(self):
        found = False
        for rid in self.region_ids():
            p = DATA / rid / "series.json"
            if not p.exists():
                continue
            found = True
            with self.subTest(file=str(p)):
                s = load_json(p)
                self.assertEqual(s.get("schema"), 1, f"{p}: schema")
                self.assertEqual(s.get("region"), rid, f"{p}: region != folder name")
                m = s.get("monthly")
                self.assertIsInstance(m, dict, f"{p}: monthly")
                self.assertTrue(is_int(m.get("start_year")), f"{p}: monthly.start_year")
                self.assertIsInstance(m.get("bucketing"), str, f"{p}: monthly.bucketing")
                keys = ["modis", "viirs", "pred", "lo", "hi"]
                nm = self.check_arrays(p, m, keys, nulls=("viirs",))
                if "weekly" in s:
                    w = s["weekly"]
                    self.assertTrue(is_int(w.get("start_year")), f"{p}: weekly.start_year")
                    self.assertEqual(w.get("weeks_per_year"), 52, f"{p}: weeks_per_year")
                    self.check_arrays(p, w, keys, nulls=("viirs",))
                self.assertTrue("calendar" in s, f"{p}: missing calendar block (model.py writes it, ML-005)")
                if "calendar" in s:
                    c = s["calendar"]
                    by = c.get("baseline_years")
                    self.assertTrue(isinstance(by, list) and len(by) == 2 and all(map(is_int, by)),
                                    f"{p}: calendar.baseline_years")
                    for k in ("month_median", "month_p25", "month_p75"):
                        self.assertTrue(isinstance(c.get(k), list) and len(c[k]) == 12
                                        and all(map(is_num, c[k])), f"{p}: calendar.{k} need 12 numbers")
                    an = c.get("anomaly")
                    self.assertTrue(isinstance(an, list) and len(an) == nm, f"{p}: calendar.anomaly length != {nm}")
                    self.assertTrue(all(v is None or is_num(v) for v in an), f"{p}: calendar.anomaly values")
                    fl = c.get("flag")
                    self.assertTrue(isinstance(fl, list) and len(fl) == nm, f"{p}: calendar.flag length != {nm}")
                    self.assertTrue(all(v in (-1, 0, 1) and is_int(v) for v in fl), f"{p}: calendar.flag values")
        if not found:
            self.skipTest("no series.json produced yet")

    def test_cells(self):
        found = False
        for rid in self.region_ids():
            p = DATA / rid / "cells.json"
            if not p.exists():
                continue
            found = True
            with self.subTest(file=str(p)):
                c = load_json(p)
                self.assertEqual(c.get("schema"), 1, f"{p}: schema")
                self.assertEqual(c.get("region"), rid, f"{p}: region != folder name")
                self.assertEqual(c.get("cell_deg"), 0.25, f"{p}: cell_deg")
                self.assertTrue(isinstance(c.get("years"), list) and all(map(is_int, c["years"])), f"{p}: years")
                lat, lon = c.get("lat"), c.get("lon")
                self.assertTrue(isinstance(lat, list) and isinstance(lon, list), f"{p}: lat/lon lists")
                self.assertEqual(len(lat), len(lon), f"{p}: len(lat) != len(lon)")
                self.assertTrue(all(map(is_num, lat + lon)), f"{p}: lat/lon numbers")
                want = len(lat) * len(c["years"])
                for k in ("modis", "viirs", "pred"):
                    self.assertIsInstance(c.get(k), list, f"{p}: {k}")
                    self.assertEqual(len(c[k]), want, f"{p}: {k} length {len(c[k])} != {want}")
        if not found:
            self.skipTest("no cells.json produced yet")

    def check_point_file(self, p, year):
        self.assertLessEqual(p.stat().st_size, MAX_POINT_FILE_BYTES, f"{p}: over size budget")
        rows, prev = 0, None
        with open(p, "rb") as f:
            head = f.readline()
            self.assertEqual(head.decode("utf-8"), POINT_HEADER + "\n", f"{p}: bad header")
            for ln, raw in enumerate(f, 2):
                self.assertNotIn(b"\r", raw, f"{p}:{ln}: CR found")
                self.assertTrue(raw.endswith(b"\n"), f"{p}:{ln}: missing final LF")
                row = raw[:-1].decode("utf-8")
                self.assertNotIn('"', row, f"{p}:{ln}: quotes not allowed")
                c = row.split(",")
                self.assertEqual(len(c), 8, f"{p}:{ln}: expected 8 fields, got {len(c)}")
                self.assertTrue(c[0].startswith(f"{year}-") and iso(c[0]), f"{p}:{ln}: date {c[0]!r} not in {year}")
                self.assertRegex(c[1], r"^([01]\d|2[0-3])[0-5]\d$",
                                 f"{p}:{ln}: time_utc must be zero-padded HHMM")
                key = (c[0], c[1])
                self.assertTrue(prev is None or prev <= key, f"{p}:{ln}: rows not sorted by (date, time_utc)")
                prev = key
                self.assertIn(c[4], ("Terra", "Aqua", "SNPP"), f"{p}:{ln}: satellite {c[4]!r}")
                self.assertIn(c[7], ("D", "N"), f"{p}:{ln}: daynight {c[7]!r}")
                rows += 1
        return rows

    def test_points(self):
        for r in self.index()["regions"]:
            rid = r["id"]
            pdir = DATA / rid / "points"
            on_disk = {}
            if pdir.is_dir():
                for f in pdir.glob("*.csv"):
                    self.assertRegex(f.stem, r"^\d{4}$", f"{f}: file name must be <year>.csv")
                    on_disk[int(f.stem)] = f
            with self.subTest(region=rid, check="years match index"):
                self.assertEqual(sorted(on_disk), r["point_years"],
                                 f"{rid}: point CSV years on disk vs point_years in index.json")
            total, clean = 0, True
            for y, f in sorted(on_disk.items()):
                clean = False
                with self.subTest(file=str(f)):
                    total += self.check_point_file(f, y)
                    clean = True
            if clean:  # skip the total when a file failed (avoids a confusing second error)
                with self.subTest(region=rid, check="point_rows"):
                    self.assertEqual(total, r["point_rows"], f"{rid}: counted rows vs point_rows in index.json")
        if not any(r["point_years"] for r in self.index()["regions"]):
            self.skipTest("no point files produced yet")

    def test_no_32_hex_secret_in_public(self):
        if not PUBLIC.exists():
            self.skipTest(f"{PUBLIC} missing")
        for p in sorted(x for x in PUBLIC.rglob("*") if x.is_file()):
            with self.subTest(file=str(p)):
                with open(p, "rb") as f:
                    tail, chunk = b"", f.read(1 << 20)
                    while chunk:
                        nxt = f.read(1 << 20)
                        buf = tail + chunk
                        for m in HEX32.finditer(buf):
                            if m.end() == len(buf) and nxt:
                                continue  # run may continue in the next chunk
                            self.fail(f"{p}: contains a hex run of 32+ chars (possible key)")
                        tail = HEX_TAIL.search(buf).group()
                        chunk = nxt


if __name__ == "__main__":
    unittest.main()
