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
        self.assertIsNone(e.__context__)
        self.assertIsNone(e.__cause__)

    def test_http_error_body_shown_scrubbed(self):
        url = f"{F.API}/area/csv/{KEY}/VIIRS_NOAA21_SP/0,0,1,1/5/2026-03-11"
        def opener(u, timeout):
            raise urllib.error.HTTPError(u, 400, "Bad", {}, io.BytesIO(
                f"<p>Exceeding allowed transaction limit for {KEY} at {u}</p>".encode()))
        with self.assertRaises(F.FetchError) as c:
            F.http_get(url, KEY, opener=opener)
        msg = str(c.exception)
        self.assertIn("Exceeding allowed transaction limit", msg)
        self.assertNotIn(KEY, msg)
        self.assertNotIn("firms.modaps", msg)
        self.assertIsNone(c.exception.__context__)

    def _http_error_msg(self, body, close_raises=False):
        url = f"{F.API}/area/csv/{KEY}/VIIRS_NOAA21_SP/0,0,1,1/5/2026-03-11"
        def opener(u, timeout):
            e = urllib.error.HTTPError(u, 400, "Bad", {}, io.BytesIO(body))
            if close_raises:
                def bad_close():
                    raise OSError("close failed")
                e.close = bad_close
            raise e
        with self.assertRaises(F.FetchError) as c:
            F.http_get(url, KEY, opener=opener)
        self.assertIsNone(c.exception.__context__)
        return str(c.exception)

    def test_http_error_key_cut_at_read_limit_not_shown(self):
        for pad in range(4000 - len(KEY) + 1, 4000):
            head = b"<i>" * ((pad - 8) // 3) + b" " * ((pad - 8) % 3) + b"bad key "
            msg = self._http_error_msg(head + KEY.encode())
            for n in range(6, len(KEY) + 1):
                self.assertNotIn(KEY[:n], msg)

    def test_http_error_key_any_case_or_split_by_tag_not_shown(self):
        half = len(KEY) // 2
        for body in (f"bad key {KEY.upper()}", f"bad key {KEY[:half]}<i>{KEY[half:]}</i>", f"key {KEY.lower()} x"):
            msg = self._http_error_msg(body.encode())
            self.assertNotIn(KEY.upper(), msg.upper())
            self.assertNotIn(KEY[:half].upper(), msg.upper())
            self.assertNotIn(KEY[half:].upper(), msg.upper())

    def test_http_error_close_failure_still_fetch_error(self):
        msg = self._http_error_msg(b"Invalid request", close_raises=True)
        self.assertIn("Invalid request", msg)

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
        self.assertEqual(F.check_body(HDR, KEY), 0)
        self.assertEqual(F.check_body(body(["1,2,3,4,5,2026-01-01,0100,N,VIIRS,n,2,6,7,D"], type_col=False) + "\n\n", KEY), 1)
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


TODAY = date(2026, 11, 15)
LEGACY = ("MODIS", "VIIRS_SNPP")
NOAA = {"VIIRS_NOAA20_SP": (date(2018, 1, 1), date(2026, 6, 30)), "VIIRS_NOAA20_NRT": (date(2026, 6, 1), date(2026, 11, 15)),
        "VIIRS_NOAA21_SP": (date(2024, 1, 17), date(2026, 6, 30)), "VIIRS_NOAA21_NRT": (date(2026, 6, 1), date(2026, 11, 15))}


class Planning(unittest.TestCase):
    def test_sp_then_nrt_no_gap_no_overlap(self):
        avail = {"MODIS_SP": (date(2000, 11, 1), date(2026, 6, 30)), "MODIS_NRT": (date(2026, 6, 1), date(2026, 11, 14)),
                 "VIIRS_SNPP_SP": (date(2012, 1, 20), date(2026, 3, 31)), "VIIRS_SNPP_NRT": (date(2026, 3, 1), date(2026, 11, 2)),
                 **NOAA}
        chunks, spans = F.plan(avail, today=TODAY)
        self.assertEqual(spans["MODIS"], (date(2026, 1, 1), date(2026, 11, 2)))
        self.assertEqual(spans["VIIRS_SNPP"], (date(2026, 1, 1), date(2026, 11, 2)))
        self.assertEqual(spans["VIIRS_NOAA20"], (date(2026, 1, 1), date(2026, 11, 14)))
        self.assertEqual(spans["VIIRS_NOAA21"], (date(2024, 1, 17), date(2026, 11, 14)))
        for name, (sp, nrt) in F.SENSORS.items():
            mine = [c for c in chunks if c[0] in (sp, nrt)]
            d, through = spans[name]
            for src, first, last in mine:
                self.assertEqual(first, d)
                self.assertLessEqual((last - first).days + 1, F.DAYS)
                self.assertTrue(last <= avail[sp][1] if src == sp else first > avail[sp][1])
                d = last + timedelta(days=1)
            self.assertEqual(d, through + timedelta(days=1))

    def test_through_is_common_end(self):
        avail = {"MODIS_NRT": (date(2026, 1, 1), date(2026, 11, 14)), "VIIRS_SNPP_NRT": (date(2026, 1, 1), date(2026, 9, 9))}
        _, spans = F.plan(avail, sensors=LEGACY, today=TODAY)
        self.assertEqual(spans["MODIS"][1], date(2026, 9, 9))

    def test_no_constant_end_date(self):
        avail = {"VIIRS_NOAA20_NRT": (date(2026, 1, 1), date(2027, 3, 1))}
        _, spans = F.plan(avail, sensors=["VIIRS_NOAA20"], today=date(2027, 2, 1))
        self.assertEqual(spans["VIIRS_NOAA20"][1], date(2027, 1, 31))

    def test_snpp_never_past_its_end(self):
        avail = {"MODIS_NRT": (date(2026, 1, 1), date(2026, 11, 14)), "VIIRS_SNPP_NRT": (date(2026, 1, 1), date(2026, 11, 14))}
        _, spans = F.plan(avail, sensors=LEGACY, today=TODAY)
        self.assertEqual(spans["MODIS"][1], date(2026, 11, 2))
        self.assertEqual(spans["VIIRS_SNPP"][1], date(2026, 11, 2))

    def test_start_is_sp_first_day_when_sp_listed(self):
        avail = {"VIIRS_NOAA21_SP": (date(2024, 2, 1), date(2026, 6, 30)), "VIIRS_NOAA21_NRT": (date(2024, 1, 10), date(2026, 11, 15))}
        chunks, spans = F.plan(avail, sensors=["VIIRS_NOAA21"], today=TODAY)
        self.assertEqual(spans["VIIRS_NOAA21"][0], date(2024, 2, 1))
        self.assertEqual(chunks[0], ("VIIRS_NOAA21_SP", date(2024, 2, 1), date(2024, 2, 5)))

    def test_utc_today_lags_past_midnight(self):
        self.assertLessEqual(F.utc_today(), F.utc_today(lag_hours=0))

    def test_selection_plans_only_those_sensors(self):
        chunks, spans = F.plan(NOAA, sensors=["VIIRS_NOAA21", "VIIRS_NOAA20"], today=TODAY)
        self.assertEqual(list(spans), ["VIIRS_NOAA20", "VIIRS_NOAA21"])
        self.assertTrue(all(c[0].startswith("VIIRS_NOAA") for c in chunks))

    def test_linked_sensors_only_together(self):
        for bad in (["MODIS"], ["VIIRS_SNPP", "VIIRS_NOAA20"], ["NOAA20"], []):
            with self.assertRaises(F.FetchError):
                F.check_sensors(bad)

    def test_selected_sensor_not_listed_stops(self):
        with self.assertRaises(F.FetchError):
            F.plan({}, sensors=["VIIRS_NOAA21"], today=TODAY)

    def test_gap_between_sp_and_nrt_stops(self):
        avail = {"MODIS_SP": (date(2000, 1, 1), date(2026, 3, 31)), "MODIS_NRT": (date(2026, 5, 1), date(2026, 11, 14)),
                 "VIIRS_SNPP_SP": (date(2012, 1, 1), date(2026, 3, 31)), "VIIRS_SNPP_NRT": (date(2026, 4, 1), date(2026, 11, 2))}
        with self.assertRaises(F.FetchError):
            F.plan(avail, sensors=LEGACY, today=TODAY)

    def test_nothing_available(self):
        with self.assertRaises(F.FetchError):
            F.plan({}, today=TODAY)


class FetchRegion(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.avail = {"MODIS_SP": (date(2000, 1, 1), date(2026, 1, 7)), "MODIS_NRT": (date(2026, 1, 1), date(2026, 1, 12)),
                      "VIIRS_SNPP_SP": (date(2012, 1, 1), date(2025, 12, 31)), "VIIRS_SNPP_NRT": (date(2026, 1, 1), date(2026, 1, 10)),
                      "VIIRS_NOAA20_NRT": (date(2026, 1, 1), date(2026, 1, 20)), "VIIRS_NOAA21_NRT": (date(2025, 12, 28), date(2026, 1, 20))}
        self.fetch = lambda region=None, **k: F.fetch_region(region or self.region, KEY, self.avail, out=self.tmp, get=self.get,
                                                             log=lambda *a: None, today=date(2026, 1, 16), **k)
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
        ok = lambda u, k: seen.append(u) or "\n".join([hdr] + [row] * 6)
        F.probe(self.region, KEY, get=ok, points=pts, log=lambda *a: None)
        self.assertIn("/MODIS_SP/-1.0,4.5,1.5,6.0/5/2025-08-10", seen[0])
        with self.assertRaises(F.FetchError):
            F.probe(self.region, KEY, get=lambda u, k: hdr, points=pts, log=lambda *a: None)

    def test_bad_region_rejected_before_any_request(self):
        for bad in ({"id": "..", "bbox": [0, 0, 1, 1]}, {"id": "ok", "bbox": ["0", 0, 1, 1]}, {"id": "ok", "bbox": [1, 0, 0, 1]}):
            with self.assertRaises(F.FetchError):
                self.fetch(bad)
        self.assertEqual(self.urls, [])

    def test_fetch_resume_and_coverage(self):
        spans, rows = self.fetch()
        self.assertEqual(spans["MODIS"], {"start": "2026-01-01", "through": "2026-01-10"})
        self.assertEqual(spans["VIIRS_NOAA20"], {"start": "2026-01-01", "through": "2026-01-15"})
        self.assertEqual(spans["VIIRS_NOAA21"], {"start": "2025-12-28", "through": "2026-01-15"})
        n = len(self.urls)
        self.assertEqual(rows, n)
        self.assertTrue(all("/-1.0,4.5,1.5,6.0/" in u for u in self.urls))
        folder = os.path.join(self.tmp, "testland")
        cov = json.loads(read(os.path.join(folder, "coverage.json")))
        self.assertEqual((cov["start"], cov["through"]), ("2026-01-01", "2026-01-10"))
        self.assertEqual(list(cov["sensors"]), list(F.SENSORS))
        self.assertEqual([F.sensor_of(c["source"]) for c in cov["chunks"]],
                         sorted((F.sensor_of(c["source"]) for c in cov["chunks"]), key=list(F.SENSORS).index))
        for name in os.listdir(folder):
            self.assertNotIn(KEY, read(os.path.join(folder, name)))
        put(os.path.join(folder, "MODIS_NRT_2025-12-01_2025-12-05.csv"), body([]))
        self.fetch()
        self.assertEqual(len(self.urls), n)
        self.assertFalse(os.path.exists(os.path.join(folder, "MODIS_NRT_2025-12-01_2025-12-05.csv")))

    def test_sensors_option_keeps_other_chunks_untouched(self):
        self.avail = {k: v for k, v in self.avail.items() if not k.startswith("VIIRS_NOAA")}
        self.fetch(sensors=F.LINKED)
        folder = os.path.join(self.tmp, "testland")
        legacy = {n: read(os.path.join(folder, n)) for n in os.listdir(folder) if F.CHUNK_RE.fullmatch(n)}
        old = json.loads(read(os.path.join(folder, "coverage.json")))
        self.avail.update({"VIIRS_SNPP_SP": (date(2012, 1, 1), date(2026, 1, 8)),
                           "VIIRS_NOAA20_NRT": (date(2026, 1, 1), date(2026, 1, 20))})
        n = len(self.urls)
        spans, _ = self.fetch(sensors=["VIIRS_NOAA20"])
        self.assertTrue(all("/VIIRS_NOAA20_NRT/" in u for u in self.urls[n:]))
        self.assertEqual(spans["VIIRS_SNPP"], old["sensors"]["VIIRS_SNPP"])
        cov = json.loads(read(os.path.join(folder, "coverage.json")))
        self.assertEqual((cov["start"], cov["through"]), (old["start"], old["through"]))
        self.assertEqual(cov["chunks"][:len(old["chunks"])], old["chunks"])
        for name, text in legacy.items():
            self.assertEqual(read(os.path.join(folder, name)), text)

    def test_pre_dp013_coverage_counts_as_modis_and_snpp(self):
        folder = os.path.join(self.tmp, "testland")
        os.makedirs(folder)
        put(os.path.join(folder, "MODIS_SP_2026-01-01_2026-01-05.csv"), body([]))
        put(os.path.join(folder, "coverage.json"), json.dumps({"start": "2026-01-01", "through": "2026-01-05", "chunks": [
            {"source": "MODIS_SP", "first": "2026-01-01", "last": "2026-01-05", "rows": 0, "file": "MODIS_SP_2026-01-01_2026-01-05.csv"}]}))
        spans, _ = self.fetch(sensors=["VIIRS_NOAA21"])
        self.assertEqual(spans["MODIS"], {"start": "2026-01-01", "through": "2026-01-05"})
        self.assertTrue(os.path.exists(os.path.join(folder, "MODIS_SP_2026-01-01_2026-01-05.csv")))

    def test_sensors_never_delete_other_sensors_files_without_coverage(self):
        folder = os.path.join(self.tmp, "testland")
        os.makedirs(folder)
        legacy = ["MODIS_SP_2026-01-01_2026-01-05.csv", "VIIRS_SNPP_NRT_2026-01-01_2026-01-05.csv"]
        for n in legacy:
            put(os.path.join(folder, n), body([]))
        put(os.path.join(folder, "VIIRS_NOAA20_NRT_2025-12-01_2025-12-05.csv"), body([]))
        self.fetch(sensors=["VIIRS_NOAA20"])
        for n in legacy:
            self.assertTrue(os.path.exists(os.path.join(folder, n)), n)
        self.assertFalse(os.path.exists(os.path.join(folder, "VIIRS_NOAA20_NRT_2025-12-01_2025-12-05.csv")))

    def test_unknown_source_in_old_coverage_is_a_clean_error(self):
        folder = os.path.join(self.tmp, "testland")
        os.makedirs(folder)
        put(os.path.join(folder, "coverage.json"), json.dumps({"start": "2026-01-01", "through": "2026-01-05", "sensors": {},
            "chunks": [{"source": "LANDSAT_NRT", "first": "2026-01-01", "last": "2026-01-05", "rows": 0, "file": "x.csv"}]}))
        with self.assertRaises(F.FetchError):
            self.fetch(sensors=["VIIRS_NOAA20"])

    def test_missing_kept_chunk_stops(self):
        self.fetch(sensors=F.LINKED)
        folder = os.path.join(self.tmp, "testland")
        os.remove(os.path.join(folder, "MODIS_SP_2026-01-01_2026-01-05.csv"))
        with self.assertRaises(F.FetchError):
            self.fetch(sensors=["VIIRS_NOAA20"])


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
              "0.10,0.10,300,1,1,2026-01-02,0105,Aqua,MODIS,80,6.1,290,4.0,D,0",
              "0.11,0.12,300,1,1,2026-01-02,0105,Aqua,MODIS,80,6.1,290,4.0,D,2",
              "0.90,0.90,300,1,1,2026-01-03,0105,Terra,MODIS,80,6.1,290,4.0,N,0",
              "1.50,0.10,300,1,1,2026-01-03,0105,Terra,MODIS,80,6.1,290,4.0,N,0"]
        nrt = [mh, "0.12,0.14,300,1,1,2026-01-06,905,Terra,MODIS,70,6.1NRT,290,2.0,D",
               "0.12,0.14,300,1,1,2026-01-08,905,Terra,MODIS,70,6.1NRT,290,2.0,D"]
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
        g = self.build.grid(self.pd.concat([self.archive, df], ignore_index=True))
        self.assertEqual(int(g.aqua_n.sum() + g.terra_n.sum()), 3)

    def test_empty_chunk_keeps_number_types_and_one_letter_sats(self):
        f = os.path.join(self.tmp, "testland")
        mh = "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight"
        put(os.path.join(f, "c.csv"), mh + "\n")
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
        f = os.path.join(self.tmp, "testland")
        mh = "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight,type"
        put(os.path.join(f, "a.csv"), mh + "\n0.10,0.10,300,1,1,2026-01-02,0105,Aqua,MODIS,80,6.1,290,4.0,D,0\n"
                                         "0.20,0.22,300,1,1,2026-01-02,0105,Aqua,MODIS,80,6.1,290,4.0,D,0\n")
        self.cov["chunks"] = [{"source": "MODIS_SP", "first": "2026-01-01", "last": "2026-01-05", "rows": 2, "file": "a.csv"}]
        self.write_cov()
        df, _ = self.build.load_recent(self.region, self.archive, root=self.tmp)
        self.assertEqual(list(df.latitude), [0.10])

    def noaa_setup(self):
        f = os.path.join(self.tmp, "testland")
        vh = HDR
        put(os.path.join(f, "n20.csv"), "\n".join([vh,
            "0.10,0.10,300,1,1,2026-01-07,0105,N20,VIIRS,n,2.0NRT,290,4.0,D",
            "0.11,0.10,300,1,1,2026-01-12,0105,N20,VIIRS,n,2.0NRT,290,4.0,D",
            "0.30,0.30,300,1,1,2026-01-12,0105,N20,VIIRS,n,2.0NRT,290,4.0,D",
            "0.10,0.10,300,1,1,2026-01-16,0105,N20,VIIRS,n,2.0NRT,290,4.0,D"]) + "\n")
        put(os.path.join(f, "n21.csv"), "\n".join([vh,
            "0.10,0.10,300,1,1,2025-06-01,0105,N21,VIIRS,n,2.0NRT,290,4.0,N"]) + "\n")
        self.cov = {"start": "2026-01-01", "through": "2026-01-07",
                    "sensors": {"MODIS": {"start": "2026-01-01", "through": "2026-01-07"},
                                "VIIRS_NOAA20": {"start": "2026-01-01", "through": "2026-01-15"},
                                "VIIRS_NOAA21": {"start": "2024-01-01", "through": "2026-01-15"}},
                    "chunks": self.cov["chunks"] + [
                        {"source": "VIIRS_NOAA20_NRT", "first": "2026-01-06", "last": "2026-01-16", "rows": 4, "file": "n20.csv"},
                        {"source": "VIIRS_NOAA21_NRT", "first": "2025-06-01", "last": "2025-06-01", "rows": 1, "file": "n21.csv"}]}
        self.write_cov()
        self.archive = self.pd.concat([self.archive, self.archive.assign(latitude=[0.3], longitude=[0.3], satellite=["N20"],
                                                                         acq_date=["2025-12-31"])], ignore_index=True)

    def test_noaa_rows_keep_own_window_and_legacy_mask(self):
        self.noaa_setup()
        spans = {}
        df, through = self.build.load_recent(self.region, self.archive, root=self.tmp, spans=spans)
        self.assertEqual(through, "2026-01-07")
        self.assertEqual(sorted(zip(df.satellite, df.acq_date)), [
            ("Aqua", "2026-01-02"), ("N20", "2026-01-07"), ("N20", "2026-01-12"), ("N21", "2025-06-01"), ("Terra", "2026-01-06")])
        self.assertEqual(spans, {"terra": "2026-01-07", "aqua": "2026-01-07", "n20": "2026-01-15", "n21": "2026-01-15"})

    def test_noaa_does_not_change_legacy_rows(self):
        plain, _ = self.build.load_recent(self.region, self.archive.iloc[:1], root=self.tmp)
        self.noaa_setup()
        df, _ = self.build.load_recent(self.region, self.archive, root=self.tmp)
        legacy = df[df.satellite.isin(["Terra", "Aqua", "N"])].reset_index(drop=True)
        self.pd.testing.assert_frame_equal(legacy, plain.reset_index(drop=True))

    def test_satellite_must_match_chunk_sensor(self):
        self.noaa_setup()
        f = os.path.join(self.tmp, "testland")
        put(os.path.join(f, "n21.csv"), HDR + "\n0.10,0.10,300,1,1,2025-06-01,0105,N20,VIIRS,n,2.0NRT,290,4.0,N\n")
        with self.assertRaises(ValueError):
            self.build.load_recent(self.region, self.archive, root=self.tmp)

    def test_noaa_sp_type_filter_applies(self):
        self.noaa_setup()
        f = os.path.join(self.tmp, "testland")
        put(os.path.join(f, "n21.csv"), HDR + ",type\n0.10,0.10,300,1,1,2025-06-01,0105,N21,VIIRS,n,2,290,4.0,N,2\n")
        df, _ = self.build.load_recent(self.region, self.archive, root=self.tmp)
        self.assertNotIn("N21", set(df.satellite))

    def test_chunk_without_span_or_unknown_sensor_stops(self):
        self.noaa_setup()
        del self.cov["sensors"]["VIIRS_NOAA21"]
        self.write_cov()
        with self.assertRaises(SystemExit):
            self.build.load_recent(self.region, self.archive, root=self.tmp)
        self.cov["sensors"]["LANDSAT"] = {"start": "2026-01-01", "through": "2026-01-02"}
        self.write_cov()
        with self.assertRaises(SystemExit):
            self.build.load_recent(self.region, self.archive, root=self.tmp)

    def test_noaa20_overlap_with_its_archive_stops(self):
        self.noaa_setup()
        late = self.pd.concat([self.archive, self.archive.iloc[:1].assign(satellite=["N20"], acq_date=["2026-01-03"])],
                              ignore_index=True)
        with self.assertRaises(SystemExit):
            self.build.load_recent(self.region, late, root=self.tmp)

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
