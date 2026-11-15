"""fetch_recent.py and build.load_recent without network or a real key (stdlib unittest).
Run: python -m unittest discover -s tests"""
import io, json, os, shutil, sys, tempfile, unittest, urllib.error
from datetime import date, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import fetch_recent as F

KEY = "abcdef0123456789abcdef0123456789"
HDR = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight"


def put(path, text):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def body(rows, type_col=True):
    h = HDR + (",type" if type_col else "")
    return h + "\n" + "".join(r + "\n" for r in rows)


class Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class KeyHandling(unittest.TestCase):
    def test_missing_and_malformed_key(self):
        with self.assertRaises(F.FetchError):
            F.get_key({})
        with self.assertRaises(F.FetchError) as c:
            F.get_key({"FIRMS_MAP_KEY": "not a key!"})
        self.assertNotIn("not a key", str(c.exception))
        self.assertEqual(F.get_key({"FIRMS_MAP_KEY": f"  {KEY}\n"}), KEY)

    def test_http_error_never_carries_url_or_key(self):
        url = f"{F.API}/area/csv/{KEY}/MODIS_SP/0,0,1,1/5/2026-01-01"
        def opener(u, timeout):
            raise urllib.error.HTTPError(u, 403, f"Forbidden {u}", {}, None)
        with self.assertRaises(F.FetchError) as c:
            F.http_get(url, KEY, opener=opener)
        e = c.exception
        self.assertNotIn(KEY, str(e))
        self.assertIsNone(e.__context__)          # raised outside the except: no HTTPError (which holds the URL) attached
        self.assertIsNone(e.__cause__)

    def test_network_error_retries_then_reports_class_only(self):
        calls = []
        def opener(u, timeout):
            calls.append(1)
            raise urllib.error.URLError(f"reset while reading {u}")
        orig = F.time.sleep
        F.time.sleep = lambda s: None
        try:
            with self.assertRaises(F.FetchError) as c:
                F.http_get(f"https://x/{KEY}", KEY, opener=opener)
        finally:
            F.time.sleep = orig
        self.assertEqual(len(calls), 3)
        self.assertNotIn(KEY, str(c.exception))
        self.assertIsNone(c.exception.__context__)

    def test_non_csv_answer_is_scrubbed(self):
        with self.assertRaises(F.FetchError) as c:
            F.check_body(f"Invalid MAP_KEY {KEY}.", KEY)
        self.assertNotIn(KEY, str(c.exception))

    def test_key_echoed_in_body_is_not_saved(self):
        with self.assertRaises(F.FetchError) as c:
            F.check_body(body([f"1,2,3,4,5,2026-01-01,0100,N,VIIRS,n,{KEY},6,7,D"], type_col=False), KEY)
        self.assertNotIn(KEY, str(c.exception))

    def test_header_only_and_blank_lines(self):
        self.assertEqual(F.check_body(HDR, KEY), 0)                     # quiet days, no final newline
        self.assertEqual(F.check_body(body(["1,2,3,4,5,2026-01-01,0100,N,VIIRS,n,2,6,7,D"], type_col=False) + "\n\n", KEY), 1)
        # the real API: no newline after the last row
        self.assertEqual(F.check_body(body(["1,2,3,4,5,2026-01-01,0100,N,VIIRS,n,2,6,7,D"], type_col=False).rstrip("\n"), KEY), 1)

    def test_cut_after_last_comma_is_truncation(self):
        with self.assertRaises(F.FetchError):
            F.check_body(HDR + "\n1,2,3,4,5,2026-01-01,0100,N,VIIRS,n,2,6,7,", KEY)

    def test_bad_availability_dates(self):
        with self.assertRaises(F.FetchError) as c:
            F.availability(KEY, get=lambda u, k: "data_id,min_date,max_date\nMODIS_SP,2000-11-01,not-a-date\n")
        self.assertIsNone(c.exception.__context__)

    def test_short_last_row_is_truncation(self):
        with self.assertRaises(F.FetchError):
            F.check_body(HDR + "\n1,2,3,4,5,2026-01-01,0100,N,VIIRS,n,2,6,7,D\n1,2,3,4,5,2026-01", KEY)

    def test_success_returns_text(self):
        self.assertEqual(F.http_get("u", KEY, opener=lambda u, timeout: Resp(b"\xef\xbb\xbfa\n")), "a\n")


class Planning(unittest.TestCase):
    def test_sp_then_nrt_no_gap_no_overlap(self):
        avail = {"MODIS_SP": (date(2000, 11, 1), date(2026, 6, 30)), "MODIS_NRT": (date(2026, 6, 1), date(2026, 11, 14)),
                 "VIIRS_SNPP_SP": (date(2012, 1, 20), date(2026, 3, 31)), "VIIRS_SNPP_NRT": (date(2026, 3, 1), date(2026, 11, 2))}
        chunks, through = F.plan(avail)
        self.assertEqual(through, date(2026, 11, 2))
        for sp, nrt in F.SENSORS.values():
            mine = [c for c in chunks if c[0] in (sp, nrt)]
            d = F.START
            for src, first, last in mine:
                self.assertEqual(first, d)                         # contiguous
                self.assertLessEqual((last - first).days + 1, F.DAYS)
                self.assertTrue(last <= avail[sp][1] if src == sp else first > avail[sp][1])
                d = last + timedelta(days=1)
            self.assertEqual(d, through + timedelta(days=1))

    def test_through_is_common_end(self):
        avail = {"MODIS_NRT": (date(2026, 1, 1), date(2026, 11, 14)), "VIIRS_SNPP_NRT": (date(2026, 1, 1), date(2026, 9, 9))}
        _, through = F.plan(avail)
        self.assertEqual(through, date(2026, 9, 9))

    def test_gap_between_sp_and_nrt_stops(self):
        avail = {"MODIS_SP": (date(2000, 1, 1), date(2026, 3, 31)), "MODIS_NRT": (date(2026, 5, 1), date(2026, 11, 14)),
                 "VIIRS_SNPP_SP": (date(2012, 1, 1), date(2026, 3, 31)), "VIIRS_SNPP_NRT": (date(2026, 4, 1), date(2026, 11, 2))}
        with self.assertRaises(F.FetchError):
            F.plan(avail)

    def test_nothing_available(self):
        with self.assertRaises(F.FetchError):
            F.plan({})


class FetchRegion(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.avail = {"MODIS_SP": (date(2000, 1, 1), date(2026, 1, 7)), "MODIS_NRT": (date(2026, 1, 1), date(2026, 1, 12)),
                      "VIIRS_SNPP_SP": (date(2012, 1, 1), date(2025, 12, 31)), "VIIRS_SNPP_NRT": (date(2026, 1, 1), date(2026, 1, 10))}
        self.region = {"id": "testland", "bbox": [-1.0, 4.5, 1.5, 6.0]}
        self.urls = []

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def get(self, url, key):
        self.urls.append(url)
        sp = "_SP/" in url
        return body(["5.1,0.2,300,1,1,2026-01-02,905,N,VIIRS,n,2.0NRT,290,3.4,D" + (",0" if sp else "")], type_col=sp).rstrip("\n")

    def test_probe(self):
        pts = os.path.join(self.tmp, "pts", "{id}")
        os.makedirs(pts.format(id="testland"))
        put(os.path.join(pts.format(id="testland"), "2025.csv"),
            "date,time_utc,lat,lon,satellite,confidence,frp_mw,daynight\n"
            + "".join(f"2025-08-1{d},0100,5.1,0.2,Terra,80,3.0,D\n" for d in range(5))
            + "2025-01-01,0100,5.1,0.2,SNPP,n,3.0,D\n")
        row = "5.1,0.2,300,1,1,2025-08-10,0100,Terra,MODIS,80,6.1,290,3.0,D,0"
        hdr = "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight,type"
        seen = []
        ok = lambda u, k: seen.append(u) or "\n".join([hdr] + [row] * 6)        # API sees more (whole bbox): fine
        F.probe(self.region, KEY, get=ok, points=pts, log=lambda *a: None)
        self.assertIn("/MODIS_SP/-1.0,4.5,1.5,6.0/5/2025-08-10", seen[0])
        with self.assertRaises(F.FetchError):
            F.probe(self.region, KEY, get=lambda u, k: hdr, points=pts, log=lambda *a: None)   # 0 vs 5: stop

    def test_bad_region_rejected_before_any_request(self):
        for bad in ({"id": "..", "bbox": [0, 0, 1, 1]}, {"id": "ok", "bbox": ["0", 0, 1, 1]}, {"id": "ok", "bbox": [1, 0, 0, 1]}):
            with self.assertRaises(F.FetchError):
                F.fetch_region(bad, KEY, self.avail, out=self.tmp, get=self.get, log=lambda *a: None)
        self.assertEqual(self.urls, [])

    def test_fetch_resume_and_coverage(self):
        through, rows = F.fetch_region(self.region, KEY, self.avail, out=self.tmp, get=self.get, log=lambda *a: None)
        self.assertEqual(through, date(2026, 1, 10))
        n = len(self.urls)
        self.assertEqual(rows, n)
        self.assertTrue(all("/-1.0,4.5,1.5,6.0/" in u for u in self.urls))
        folder = os.path.join(self.tmp, "testland")
        cov = json.loads(read(os.path.join(folder, "coverage.json")))
        self.assertEqual(cov["through"], "2026-01-10")
        for name in os.listdir(folder):                        # nothing written to disk holds the key
            self.assertNotIn(KEY, read(os.path.join(folder, name)))
        put(os.path.join(folder, "MODIS_NRT_2025-12-01_2025-12-05.csv"), body([]))   # stale chunk
        F.fetch_region(self.region, KEY, self.avail, out=self.tmp, get=self.get, log=lambda *a: None)
        self.assertEqual(len(self.urls), n)                    # resumed: no new requests
        self.assertFalse(os.path.exists(os.path.join(folder, "MODIS_NRT_2025-12-01_2025-12-05.csv")))


class LoadRecent(unittest.TestCase):
    def setUp(self):
        import build, pandas as pd
        self.build, self.pd = build, pd
        self.tmp = tempfile.mkdtemp()
        self.region = {"id": "testland", "bbox": [0.0, 0.0, 1.0, 1.0]}
        self.archive = pd.DataFrame({"latitude": [0.1], "longitude": [0.1], "acq_date": ["2025-05-01"], "acq_time": ["0100"],
                                     "satellite": ["Aqua"], "confidence": ["80"], "frp": [5.0], "daynight": ["D"], "type": [0]})
        f = os.path.join(self.tmp, "testland")
        os.makedirs(f)
        mh = "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight"
        sp = [mh + ",type",
              "0.10,0.10,300,1,1,2026-01-02,0105,Aqua,MODIS,80,6.1,290,4.0,D,0",     # kept
              "0.11,0.12,300,1,1,2026-01-02,0105,Aqua,MODIS,80,6.1,290,4.0,D,2",     # type 2: dropped
              "0.90,0.90,300,1,1,2026-01-03,0105,Terra,MODIS,80,6.1,290,4.0,N,0",    # cell not in archive: dropped
              "1.50,0.10,300,1,1,2026-01-03,0105,Terra,MODIS,80,6.1,290,4.0,N,0"]    # outside bbox: dropped
        nrt = [mh, "0.12,0.14,300,1,1,2026-01-06,905,Terra,MODIS,70,6.1NRT,290,2.0,D",   # NRT, no type: kept
               "0.12,0.14,300,1,1,2026-01-08,905,Terra,MODIS,70,6.1NRT,290,2.0,D"]       # after `through`: dropped
        put(os.path.join(f, "a.csv"), "\n".join(sp) + "\n")
        put(os.path.join(f, "b.csv"), "\n".join(nrt) + "\n")
        self.cov = {"start": "2026-01-01", "through": "2026-01-07",
                    "chunks": [{"source": "MODIS_SP", "first": "2026-01-01", "last": "2026-01-05", "rows": 4, "file": "a.csv"},
                               {"source": "MODIS_NRT", "first": "2026-01-06", "last": "2026-01-10", "rows": 2, "file": "b.csv"}]}
        self.write_cov()

    def write_cov(self):
        put(os.path.join(self.tmp, "testland", "coverage.json"), json.dumps(self.cov))

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_filters(self):
        df, through = self.build.load_recent(self.region, self.archive, root=self.tmp)
        self.assertEqual(through, "2026-01-07")
        self.assertEqual(sorted(df.acq_date), ["2026-01-02", "2026-01-06"])
        self.assertEqual(set(df.columns), set(self.archive.columns))
        g = self.build.grid(self.pd.concat([self.archive, df], ignore_index=True))   # same schema as the archive
        self.assertEqual(int(g.aqua_n.sum() + g.terra_n.sum()), 3)

    def test_empty_chunk_keeps_number_types_and_one_letter_sats(self):
        f = os.path.join(self.tmp, "testland")
        mh = "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight"
        put(os.path.join(f, "c.csv"), mh + "\n")                                         # quiet 5 days
        put(os.path.join(f, "b.csv"), mh + "\n0.12,0.14,300,1,1,2026-01-06,905,T,MODIS,70,6.1NRT,290,2.0,D\n")
        self.cov["chunks"] = [self.cov["chunks"][0],
                              {"source": "MODIS_NRT", "first": "2026-01-06", "last": "2026-01-06", "rows": 1, "file": "b.csv"},
                              {"source": "MODIS_NRT", "first": "2026-01-07", "last": "2026-01-07", "rows": 0, "file": "c.csv"}]
        self.write_cov()
        df, _ = self.build.load_recent(self.region, self.archive, root=self.tmp)
        both = self.pd.concat([self.archive, df], ignore_index=True)
        for col in ("latitude", "longitude", "frp", "type"):
            self.assertEqual(both[col].dtype, self.archive[col].dtype, col)
        self.assertIn("Terra", set(df.satellite))

    def test_border_mask_is_fine_grained(self):
        # same 0.25° cell as the archive point (0.1, 0.1) but a different 0.05° sub-cell: dropped
        f = os.path.join(self.tmp, "testland")
        mh = "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight,type"
        put(os.path.join(f, "a.csv"), mh + "\n0.10,0.10,300,1,1,2026-01-02,0105,Aqua,MODIS,80,6.1,290,4.0,D,0\n"
                                         "0.20,0.22,300,1,1,2026-01-02,0105,Aqua,MODIS,80,6.1,290,4.0,D,0\n")
        self.cov["chunks"] = [{"source": "MODIS_SP", "first": "2026-01-01", "last": "2026-01-05", "rows": 2, "file": "a.csv"}]
        self.write_cov()
        df, _ = self.build.load_recent(self.region, self.archive, root=self.tmp)
        self.assertEqual(list(df.latitude), [0.10])

    def test_overlap_with_archive_stops(self):
        late = self.archive.assign(acq_date=["2026-03-01"])
        with self.assertRaises(SystemExit):
            self.build.load_recent(self.region, late, root=self.tmp)

    def test_no_recent_folder(self):
        df, through = self.build.load_recent({"id": "elsewhere", "bbox": [0, 0, 1, 1]}, self.archive, root=self.tmp)
        self.assertIsNone(through)
        self.assertEqual(len(df), 0)

    def test_row_count_mismatch_stops(self):
        self.cov["chunks"][0]["rows"] = 99
        self.write_cov()
        with self.assertRaises(SystemExit):
            self.build.load_recent(self.region, self.archive, root=self.tmp)


if __name__ == "__main__":
    unittest.main()
