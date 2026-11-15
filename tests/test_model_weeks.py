"""Week and month bookkeeping in model.py (no model fit, no network, runs in about a second).

Run from the repo root:
    python -m unittest discover -s tests -v
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import model  # noqa: E402  (nothing runs at import)
from calendar_stats import calendar_block  # noqa: E402


def days_per_week(weeks, through=None):
    """Days with data per week (a partial last week counts only the days up to `through`)."""
    end = (lambda y, w: model.week_end(y, w)) if through is None else (lambda y, w: model.covered_end(y, w, through))
    return np.array([(end(y, w) - model.week_start(y, w)).days + 1 for y, w in weeks], dtype=float)


class WeekTests(unittest.TestCase):
    def test_week_51_runs_to_dec_31(self):
        self.assertEqual(model.week_end(2025, 51), pd.Timestamp(2025, 12, 31))
        self.assertEqual(days_per_week([(2025, 51), (2024, 51), (2025, 0)]).tolist(), [8, 9, 7])

    def test_kept_weeks_cut_at_archive_end(self):
        full = model.kept_weeks("2025-12-31")
        self.assertEqual(len(full), 25 * 52)
        self.assertEqual((full[0], full[-1]), ((2001, 0), (2025, 51)))
        # ML-010: a week that has started is kept, even if it is not over yet (the last one is partial)
        self.assertEqual(model.kept_weeks("2024-12-30")[-1], (2024, 51))   # week 51 (23-31 Dec), 8 of 9 days
        self.assertEqual(model.kept_weeks("2025-06-17")[-1], (2025, 23))   # week 23 = 11-17 June, complete
        self.assertEqual(model.kept_weeks("2026-11-02")[-1], (2026, 43))   # week 43 = 29 Oct-4 Nov, 5 days
        self.assertEqual(model.covered_end(2026, 43, "2026-11-02"), pd.Timestamp(2026, 11, 2))
        self.assertEqual(model.covered_end(2026, 42, "2026-11-02"), pd.Timestamp(2026, 10, 28))


class SeriesBundleTests(unittest.TestCase):
    def bundle(self, through):
        weeks = model.kept_weeks(through)
        days = days_per_week(weeks, through)   # one detection per day with data: each month gets its number of days
        wk = {"modis": days, "viirs": days, "pred": days}
        return weeks, model.series_bundle("test", weeks, wk, np.tile(days, (3, 1)), through)

    def test_through_mid_week_keeps_last_full_month(self):
        # ML-010: data to Mon 2 Nov 2026; the week 29 Oct-4 Nov is partial. October is whole, so monthly must reach
        # October 2026 (310 months) and get all 31 of its days, including 29-31 Oct from the partial week.
        weeks, b = self.bundle("2026-11-02")
        m, w = b["monthly"], b["weekly"]
        self.assertEqual(len(m["modis"]), 25 * 12 + 10)
        self.assertEqual(m["modis"][-1], 31.0)
        self.assertEqual(m["modis"][-2], 30.0)   # September untouched
        self.assertEqual(len(w["modis"]), 25 * 52 + 44)
        self.assertEqual(w["last_week_days"], 5)
        self.assertEqual(w["modis"][-1], 5.0)
        self.assertEqual(len(b["calendar"]["flag"]), 310)
        self.assertEqual(b["calendar"]["baseline_years"], [2001, 2025])

    def test_through_month_end_mid_week(self):
        # Sat 31 May 2025 falls inside week 21 (28 May-3 Jun): May is complete and is the last month
        _, b = self.bundle("2025-05-31")
        self.assertEqual(len(b["monthly"]["modis"]), 24 * 12 + 5)
        self.assertEqual(b["monthly"]["modis"][-1], 31.0)
        self.assertEqual(b["weekly"]["last_week_days"], 4)

    def test_through_dec_31_is_unchanged(self):
        # a whole year: nothing partial, last week is the 8-day week 51 (2025 is not a leap year)
        weeks, b = self.bundle("2025-12-31")
        self.assertEqual(weeks[-1], (2025, 51))
        self.assertEqual(len(b["monthly"]["modis"]), 300)
        self.assertEqual(len(b["weekly"]["modis"]), 25 * 52)
        self.assertEqual(b["weekly"]["last_week_days"], 8)

    def test_through_early_january(self):
        # 3 Jan 2026: a 3-day week 0 of 2026 is kept, but no month of 2026 is complete
        _, b = self.bundle("2026-01-03")
        self.assertEqual(len(b["monthly"]["modis"]), 300)
        self.assertEqual(len(b["weekly"]["modis"]), 25 * 52 + 1)
        self.assertEqual(b["weekly"]["last_week_days"], 3)

    def test_day_share_gives_days_per_month(self):
        _, b = self.bundle("2025-12-31")
        m = b["monthly"]
        self.assertEqual(len(m["modis"]), 300)
        want = [pd.Period(f"{2001 + i // 12}-{i % 12 + 1:02d}").days_in_month for i in range(300)]
        self.assertEqual(m["modis"], [float(v) for v in want])
        self.assertEqual(m["lo"], m["hi"])
        self.assertEqual(m["lo"], m["pred"])
        self.assertEqual(m["bucketing"], "calendar-month-day-share")

    def test_monthly_ends_at_last_full_month(self):
        _, b = self.bundle("2025-06-17")
        self.assertEqual(len(b["monthly"]["modis"]), 24 * 12 + 5)   # through May 2025; June is incomplete
        self.assertEqual(len(b["weekly"]["modis"]), 24 * 52 + 24)

    def test_viirs_null_before_viirs_start(self):
        weeks, b = self.bundle("2025-12-31")
        m, w = b["monthly"], b["weekly"]
        self.assertTrue(all(v is None for v in m["viirs"][:133]))   # through January 2012
        self.assertTrue(all(v is not None for v in m["viirs"][133:]))
        i2012 = weeks.index((2012, 0))
        self.assertTrue(all(v is None for v in w["viirs"][:i2012 + 3]))   # 2012 weeks 0-2 start before 20 Jan
        self.assertTrue(all(v is not None for v in w["viirs"][i2012 + 3:]))
        self.assertEqual(w["weeks_per_year"], 52)

    def test_calendar_block_emitted(self):
        for through in ("2025-12-31", "2025-06-17"):   # full final year, and a trailing partial year
            _, b = self.bundle(through)
            m, c = b["monthly"], b["calendar"]
            self.assertEqual(list(b), ["schema", "region", "monthly", "weekly", "calendar"])
            self.assertEqual(len(c["flag"]), len(m["modis"]))
            self.assertEqual(len(c["anomaly"]), len(m["modis"]))
            self.assertEqual(c["baseline_years"], [2001, 2025])
            harmonized = [p if v is None else v for v, p in zip(m["viirs"], m["pred"])]
            self.assertEqual(c, calendar_block(harmonized, m["start_year"]))
            self.assertIsNotNone(c["anomaly"][132])   # January 2012: viirs is null, so the model's value is used



class OverpassTests(unittest.TestCase):
    """ML-016: median daytime local solar time per satellite from points/<year>.csv, and the drift flag."""
    HEADER = "date,time_utc,lat,lon,satellite,confidence,frp_mw,daynight\n"

    def write(self, d, year, rows):
        with open(os.path.join(d, f"{year}.csv"), "w", encoding="utf-8", newline="\n") as f:
            f.write(self.HEADER + "".join(r + "\n" for r in rows))

    def test_median_local_solar_time(self):
        with tempfile.TemporaryDirectory() as d:
            self.write(d, 2020, [
                "2020-01-01,1000,5.0,0.0,Terra,80,1.0,D",     # 10:00 + 0 h      = 10.0
                "2020-01-01,930,5.0,22.5,Terra,80,1.0,D",     # 09:30 + 1.5 h    = 11.0 (3-digit time is zero-padded)
                "2020-01-01,1100,5.0,30.0,Terra,80,1.0,D",    # 11:00 + 2 h      = 13.0 -> median 11.0, mean 11.33
                "2020-01-01,0100,5.0,0.0,Terra,80,1.0,N",     # night: ignored
                "2020-01-01,1320,5.0,-30.0,Aqua,80,1.0,D",    # 13:20 - 2 h      = 11.333
                "2020-01-01,1400,5.0,-30.0,Aqua,80,1.0,D",    # 14:00 - 2 h      = 12.0 -> median 11.667
                "2020-01-01,1900,5.0,-90.0,SNPP,n,1.0,D",     # 19:00 - 6 h      = 13.0
            ])
            h = model.overpass_hours(os.path.join(d, "2020.csv"))
        self.assertEqual(list(h), ["terra", "aqua", "snpp"])
        self.assertAlmostEqual(h["terra"], 11.0)
        self.assertAlmostEqual(h["aqua"], 35 / 3)
        self.assertAlmostEqual(h["snpp"], 13.0)

    def test_missing_satellite_and_year_are_null(self):
        with tempfile.TemporaryDirectory() as d:
            self.write(d, 2014, ["2014-01-01,1030,5.0,0.0,Terra,80,1.0,D"])
            self.write(d, 2015, [])                                        # header only
            ov, drifted = model.overpass_block(d, [2013, 2014, 2015])
            nodir = model.overpass_block(os.path.join(d, "absent"), [2013, 2014])
        self.assertEqual(ov, {"terra": [None, 10.5, None], "aqua": [None, None, None], "snpp": [None, None, None]})
        self.assertEqual(drifted, [0, 0, 0])
        self.assertEqual(nodir, ({"terra": [None, None], "aqua": [None, None], "snpp": [None, None]}, [0, 0]))

    def test_drift_flag_against_2013_2019_median(self):
        # Terra base 10:30 (2013-2019); Aqua base 13:30. Flag only when > 0.5 h away, either satellite.
        terra = {**{y: "1030" for y in range(2013, 2020)}, 2012: "1015", 2022: "1001", 2023: "0959", 2024: "1030", 2025: "1100"}
        aqua = {**{y: "1330" for y in range(2013, 2020)}, 2012: "1330", 2022: "1330", 2023: "1330", 2024: "1402", 2025: "1400"}
        years = sorted(terra)
        with tempfile.TemporaryDirectory() as d:
            for y in years:
                self.write(d, y, [f"{y}-06-01,{terra[y]},5.0,0.0,Terra,80,1.0,D",
                                  f"{y}-06-01,{aqua[y]},5.0,0.0,Aqua,80,1.0,D"])
            ov, drifted = model.overpass_block(d, years)
        flagged = [y for y, f in zip(years, drifted) if f]
        self.assertEqual(flagged, [2023, 2024])   # 2022 29 min early (kept), 2023 31, 2024 Aqua 32 late;
        # 2025 exactly 0.5 h late on both satellites: not flagged (strict >)
        self.assertEqual(ov["terra"][years.index(2012)], 10.25)


if __name__ == "__main__":
    unittest.main()
