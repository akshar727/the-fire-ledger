"""Trend statistics for the yearly fire record (F-7, ML-020): "is the trend real?".

Method: Theil-Sen slope (median of all pairwise slopes, scipy.stats.theilslopes) of the yearly totals against the
year, with its 90% interval, and a Mann-Kendall test p-value (= Kendall's tau between year and value,
scipy.stats.kendalltau, two-sided). Slopes are given in % per year: slope / median of the values x 100, so regions
of different size compare. Only complete years are used (the caller passes them). A series with fewer than 3
values or a median of 0 gets nulls; a constant series gets slope 0 and p = 1.

Two records are tested:
- stitched: the naive record, raw MODIS for weeks before VIIRS starts (2012-01-20) and raw VIIRS after (what you get
  gluing the sensors).
- harmonized: the published VIIRS-scale record (observed VIIRS from 2012, the model's back-cast before).
For harmonized, `boot_lo_pct`/`boot_hi_pct` are the 5-95% range of the slope over the model's bootstrap draws,
which carries the back-cast uncertainty (only) into the trend; it is separate from the 90% slope interval. The same tests are run per calendar month (season shift).
"""
import math

import numpy as np
from scipy.stats import kendalltau, theilslopes

ALPHA = 0.90   # interval level for the Theil-Sen slope
NULL = {"slope_pct": None, "lo_pct": None, "hi_pct": None, "p": None}


def _r(v, nd):
    return None if v is None or not math.isfinite(v) else round(float(v), nd)


def slope_pct(x, y):
    """Theil-Sen slope in % per year (relative to the median of y); None if undefined."""
    y = np.asarray(y, float)
    med = float(np.median(y)) if len(y) else 0.0
    if len(y) < 3 or med <= 0:
        return None
    return 100 * theilslopes(y, x).slope / med


def trend(x, y):
    """{"slope_pct", "lo_pct", "hi_pct", "p"} for values y at years x (complete years only)."""
    x, y = np.asarray(x, float), np.asarray(y, float)
    med = float(np.median(y)) if len(y) else 0.0
    if len(y) < 3 or med <= 0:
        return dict(NULL)
    if np.all(y == y[0]):
        return {"slope_pct": 0.0, "lo_pct": 0.0, "hi_pct": 0.0, "p": 1.0}   # kendalltau is undefined (all ties)
    s, _, lo, hi = theilslopes(y, x, alpha=ALPHA)
    return {"slope_pct": _r(100 * s / med, 2), "lo_pct": _r(100 * lo / med, 2),
            "hi_pct": _r(100 * hi / med, 2), "p": _r(kendalltau(x, y).pvalue, 4)}


def _months(series, start_year, years, m):
    """Values of calendar month m (0-11) for the given years from a monthly series (index 0 = Jan start_year)."""
    return [series[(yr - start_year) * 12 + m] for yr in years]


def trend_block(years, stitched, harmonized, boot_harmonized, monthly_stitched, monthly_harmonized, start_year=2001):
    """The `trend` block of annual.json.

    years: complete years to test; stitched/harmonized: yearly values for those years; boot_harmonized: array
    (n_draws x n_years) of harmonized yearly values per bootstrap draw; monthly_*: monthly series starting January of
    start_year that cover every month of `years`.
    """
    years = [int(v) for v in years]
    har = trend(years, harmonized)
    boot = [s for s in (slope_pct(years, b) for b in np.asarray(boot_harmonized, float)) if s is not None]
    lo, hi = np.percentile(boot, [5, 95]) if boot else (None, None)
    har.update({"boot_lo_pct": _r(lo, 2), "boot_hi_pct": _r(hi, 2)})

    def per_month(series):
        rows = [trend(years, _months(series, start_year, years, m)) for m in range(12)]
        return {k: [r[k] for r in rows] for k in NULL}

    return {"method": "theil-sen slope (% of median per year), 90% interval; mann-kendall p",
            "years": [years[0], years[-1]] if years else None, "n_years": len(years), "interval": ALPHA,
            "stitched": trend(years, stitched), "harmonized": har,
            "monthly": {"stitched": per_month(monthly_stitched), "harmonized": per_month(monthly_harmonized)}}
