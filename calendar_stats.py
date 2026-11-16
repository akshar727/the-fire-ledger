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
