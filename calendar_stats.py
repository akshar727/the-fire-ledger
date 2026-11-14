"""Burn-calendar statistics for a harmonized monthly fire series.

Method: index i of the series is year start_year + i // 12, month i % 12 + 1. The
baseline is the set of complete years (all 12 months present, none missing) whose
year lies inside the inclusive baseline window (default 2001-2025); partial and
out-of-window years are not used. For each calendar month the median and the 25th and
75th percentiles are taken over the baseline years, using linear interpolation between
closest ranks (the NumPy default), and rounded to 3 decimals. Every month of the
series, including partial and out-of-baseline years, then gets, computed from those
rounded statistics: an anomaly ratio value / median (rounded to 4 decimals; null where
the median is 0 or the value is missing), and a flag. The flag is +1 (unusually high)
if value > p75 and value >= 2 x median and value >= median + 20, -1 (unusually low) if
value < p25 and value <= 0.5 x median and value <= median - 20, otherwise 0; missing
months are flagged 0. A month whose median is 0 therefore has no anomaly ratio but can
still be flagged high once it reaches 20 detections.
"""
import math

import numpy as np


def _clean(v):
    if v is None:
        return None
    f = float(v)
    if math.isnan(f):
        return None
    if math.isinf(f) or f < 0:
        raise ValueError(f"invalid monthly value {v!r}: must be finite and >= 0")
    return f


def _round(a, nd):
    return [round(float(x), nd) for x in a]


def calendar_block(harmonized, start_year, baseline=(2001, 2025)):
    """Return the `calendar` block of series.json for a monthly series.

    harmonized: sequence of monthly values (index i is year start_year + i // 12,
    month i % 12 + 1); the last year may be partial. None and NaN mean missing;
    negative or infinite values raise ValueError. The baseline is the complete years
    (all 12 months present) with baseline[0] <= year <= baseline[1] (inclusive);
    ValueError if there is none. Per-month median/p25/p75 use linear interpolation
    between closest ranks (NumPy default) and are rounded to 3 decimals before the
    anomaly (value / median, 4 decimals, None where the median is 0 or the value is
    missing) and flag (+1 / -1 / 0, see module docstring) are computed from them.
    Returns {"baseline_years", "month_median", "month_p25", "month_p75", "anomaly",
    "flag"} holding only plain Python int/float/None.
    """
    vals = [_clean(v) for v in harmonized]
    n = len(vals)
    b0, b1 = int(baseline[0]), int(baseline[1])
    rows = []
    for y in range(n // 12):
        if b0 <= start_year + y <= b1:
            row = vals[y * 12:(y + 1) * 12]
            if all(v is not None for v in row):
                rows.append(row)
    if not rows:
        raise ValueError(
            f"no complete baseline year (all 12 months present) between {b0} and {b1} "
            f"for a series of {n} months starting {start_year}")
    arr = np.array(rows, dtype=float)
    q50, q25, q75 = np.percentile(arr, [50, 25, 75], axis=0)
    med, p25, p75 = _round(q50, 3), _round(q25, 3), _round(q75, 3)
    anomaly, flag = [], []
    for i, v in enumerate(vals):
        m = i % 12
        if v is None:
            anomaly.append(None)
            flag.append(0)
            continue
        md, lo, hi = med[m], p25[m], p75[m]
        anomaly.append(round(v / md, 4) if md != 0 else None)
        if v > hi and v >= 2 * md and v >= md + 20:
            flag.append(1)
        elif v < lo and v <= 0.5 * md and v <= md - 20:
            flag.append(-1)
        else:
            flag.append(0)
    return {
        "baseline_years": [b0, b1],
        "month_median": med,
        "month_p25": p25,
        "month_p75": p75,
        "anomaly": anomaly,
        "flag": flag,
    }
