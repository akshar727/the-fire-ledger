import math

import numpy as np
from scipy.stats import kendalltau, theilslopes

ALPHA = 0.90
NULL = {"slope_pct": None, "lo_pct": None, "hi_pct": None, "p": None}


def _r(v, nd):
    return None if v is None or not math.isfinite(v) else round(float(v), nd)


def slope_pct(x, y):
    y = np.asarray(y, float)
    med = float(np.median(y)) if len(y) else 0.0
    if len(y) < 3 or med <= 0:
        return None
    return 100 * theilslopes(y, x).slope / med


def trend(x, y):
    x, y = np.asarray(x, float), np.asarray(y, float)
    med = float(np.median(y)) if len(y) else 0.0
    if len(y) < 3 or med <= 0:
        return dict(NULL)
    if np.all(y == y[0]):
        return {"slope_pct": 0.0, "lo_pct": 0.0, "hi_pct": 0.0, "p": 1.0}
    s, _, lo, hi = theilslopes(y, x, alpha=ALPHA)
    return {"slope_pct": _r(100 * s / med, 2), "lo_pct": _r(100 * lo / med, 2),
            "hi_pct": _r(100 * hi / med, 2), "p": _r(kendalltau(x, y).pvalue, 4)}


def _months(series, start_year, years, m):
    return [series[(yr - start_year) * 12 + m] for yr in years]


def trend_block(years, stitched, harmonized, boot_harmonized, monthly_stitched, monthly_harmonized, start_year=2001):
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
