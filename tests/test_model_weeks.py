"""Week and month bookkeeping in model.py (no model fit, no network, runs in about a second).

Run from the repo root:
    python -m unittest discover -s tests -v
"""
import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import model  # noqa: E402  (nothing runs at import)
from calendar_stats import calendar_block  # noqa: E402


def days_per_week(weeks):
    return np.array([(model.week_end(y, w) - model.week_start(y, w)).days + 1 for y, w in weeks], dtype=float)


class WeekTests(unittest.TestCase):
    def test_week_51_runs_to_dec_31(self):
        self.assertEqual(model.week_end(2025, 51), pd.Timestamp(2025, 12, 31))
        self.assertEqual(days_per_week([(2025, 51), (2024, 51), (2025, 0)]).tolist(), [8, 9, 7])

    def test_kept_weeks_cut_at_archive_end(self):
        full = model.kept_weeks("2025-12-31")
        self.assertEqual(len(full), 25 * 52)
        self.assertEqual((full[0], full[-1]), ((2001, 0), (2025, 51)))
        self.assertEqual(model.kept_weeks("2024-12-30")[-1], (2024, 50))   # week 51 not complete
        self.assertEqual(model.kept_weeks("2025-06-17")[-1], (2025, 23))   # week 23 = 11-17 June


class SeriesBundleTests(unittest.TestCase):
    def bundle(self, through):
        weeks = model.kept_weeks(through)
        days = days_per_week(weeks)   # one detection per day, so each month should get its number of days
        wk = {"modis": days, "viirs": days, "pred": days}
        return weeks, model.series_bundle("test", weeks, wk, np.tile(days, (3, 1)))

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


if __name__ == "__main__":
    unittest.main()
