"""Forward link (ML-017): Suomi-NPP-equivalent fire counts from NOAA-20 and NOAA-21 after Suomi NPP's record ends.

S-NPP, NOAA-20 and NOAA-21 carry the same VIIRS instrument in the same orbit, ~50 minutes apart, so the link is a
ratio, not the cell-level MODIS model: a Poisson GLM, S-NPP region total ~ day/night with offset log(NOAA exposure),
fitted on region-day x day/night totals 2018-04-01 to 2023 (its fit is S-NPP/NOAA-20 per day/night). Held out
2024 to the S-NPP end (`archive_through`), then applied to the days after it.

NOAA exposure = NOAA-20 count before 2024; from 2024 (NOAA-21 starts 2024-01-01) the mean of NOAA-20 and NOAA-21,
with NOAA-21 first scaled to NOAA-20 per day/night (k = sum NOAA-20 / sum NOAA-21 over 2024 to the NOAA end; no
S-NPP data used). Two views of the same fires average out part of the cloud and overpass noise: hold-out monthly
MAPE 10.6/12.4/10.1% with NOAA-20 alone vs 7.2/10.6/10.2% with both (portugal/ghana/punjab; measured 2026-11-15
on the DP-013 grids with a plain ratio, before the outage rule; `score.mape_ratio_month` is the NOAA-20-alone
baseline as shipped), so both are used.

Outages: a satellite is "out" on a day when it has 0 detections there while another one has >= OUT_MIN. An S-NPP
outage day is missing, not zero (left out of the fit and the score); a NOAA outage day uses the other NOAA satellite
alone (before 2024: the row is left out of the fit). Band: year-block bootstrap of the fit, one lognormal factor per
calendar month (sd `sigma_month`, from leave-one-year-out refits), then negative-binomial noise per row.
Limits: on hold-out days S-NPP itself helps detect a NOAA outage, on forward days only the other NOAA satellite can,
so the hold-out score is slightly optimistic there; an outage in a quiet region (< OUT_MIN fires) or a partial
outage is not detected and only widens the error (sigma_month). Nothing runs at import.
"""
import numpy as np, pandas as pd
import statsmodels.api as sm

N20_START = pd.Timestamp("2018-04-01")    # first NOAA-20 day in the FIRMS archive
N21_START = pd.Timestamp("2024-01-01")    # first NOAA-21 day (FIRMS API)
TRAIN_END = pd.Timestamp("2023-12-31")
HOLD_START = pd.Timestamp("2024-01-01")
TRAIN_YEARS = range(2018, 2024)
MIN_MONTH = 100     # monthly scores and sigma_month use months with at least this many S-NPP detections
OUT_MIN = 20        # outage: 0 detections on a day while another satellite has at least this many


def region_days(d, end):
    """Region totals per day x day/night, every day from N20_START to `end` (missing days = 0)."""
    cols = ["viirs_n", "n20_n", "n21_n"]
    g = d[(d.date >= N20_START) & (d.date <= end)].groupby(["date", "daynight"])[cols].sum()
    idx = pd.MultiIndex.from_product([pd.date_range(N20_START, end), ["D", "N"]], names=["date", "daynight"])
    g = g.reindex(idx, fill_value=0).reset_index()
    g["year"] = g.date.dt.year
    return g


def outages(g, archive_through):
    """Per row: (snpp_out, n20_out, n21_out) booleans from whole-day totals (see module doc)."""
    day = g.groupby("date")[["viirs_n", "n20_n", "n21_n"]].transform("sum")
    has21 = (g.date >= N21_START).values
    snpp_on = (g.date <= archive_through).values
    v, a, b = day.viirs_n.values, day.n20_n.values, np.where(has21, day.n21_n.values, 0)
    ref = lambda *xs: np.max(np.stack(xs), axis=0) >= OUT_MIN
    snpp_out = snpp_on & (v == 0) & ref(a, b)
    n20_out = (a == 0) & ref(np.where(snpp_on, v, 0), b)
    n21_out = has21 & (b == 0) & ref(np.where(snpp_on, v, 0), a)
    return snpp_out, n20_out, n21_out


def exposure(g, archive_through, forward_through):
    """NOAA exposure per row (S-NPP-scale is the GLM's job), the NOAA-21 scale k per day/night, and the outage flags."""
    snpp_out, n20_out, n21_out = outages(g, archive_through)
    has21 = (g.date >= N21_START).values
    ok21 = has21 & ~n21_out & ~n20_out
    k = {}
    for dn in ("D", "N"):
        m = ok21 & (g.daynight == dn).values
        s21 = g.n21_n.values[m].sum()
        k[dn] = float(g.n20_n.values[m].sum() / s21) if s21 > 0 else 1.0
    n21s = g.n21_n.values * g.daynight.map(k).values
    n20 = g.n20_n.values.astype(float)
    x = np.where(has21, (n20 + n21s) / 2, n20)
    x = np.where(has21 & n20_out & ~n21_out, n21s, x)
    x = np.where(has21 & n21_out & ~n20_out, n20, x)
    usable = ~(n20_out & (~has21 | n21_out))                    # some NOAA view of the day exists
    return x, k, {"snpp": snpp_out, "n20": n20_out, "n21": n21_out, "usable": usable}


def _design(g):
    return np.column_stack([np.ones(len(g)), (g.daynight == "N").values.astype(float)])


def _fit(y, X, x, rows):
    """Poisson GLM with offset log(x), on rows with x > 0. Its MLE is sum(y) / sum(x) per day/night."""
    rows = rows[x[rows] > 0]
    return sm.GLM(y[rows], X[rows], offset=np.log(x[rows]), family=sm.families.Poisson()).fit().params


def _mu(X, x, params):
    return np.exp(X @ params) * x


def _months(dates):
    """Row -> year-month index (0 = first month), and the PeriodIndex of months."""
    p = dates.dt.to_period("M")
    first = p.min()
    months = pd.period_range(first, p.max(), freq="M")
    return ((p.dt.year - first.year) * 12 + p.dt.month - first.month).values, months


def run_forward(d, archive_through, forward_through, nboot, rng):
    """Fit the link on grid rows `d` (date, daynight, viirs_n, n20_n, n21_n) and predict S-NPP equivalents.

    Returns None when there is nothing to forward (forward_through <= archive_through), else a dict:
      dates : DatetimeIndex of the forward days (archive_through + 1 .. forward_through)
      pred  : model mean per forward day (day + night), array
      draws : nboot x n_days bootstrap draws per forward day
      score : the `score.forward` block of annual.json (hold-out 2024 .. archive_through)
    """
    archive_through, forward_through = pd.Timestamp(archive_through), pd.Timestamp(forward_through)
    if forward_through <= archive_through:
        return None
    g = region_days(d, forward_through)
    y = g.viirs_n.values.astype(float)
    x, k, out = exposure(g, archive_through, forward_through)
    X = _design(g)
    yrs = g.year.values
    train = (g.date <= TRAIN_END).values & ~out["snpp"] & out["usable"]
    hold = ((g.date >= HOLD_START) & (g.date <= archive_through)).values & ~out["snpp"]
    fwd = (g.date > archive_through).values
    tr = np.flatnonzero(train)
    params = _fit(y, X, x, tr)
    mu = _mu(X, x, params)
    t = tr[x[tr] > 0]
    a = max(float(np.sum((y[t] - mu[t]) ** 2 - y[t]) / np.sum(mu[t] ** 2)), 1e-3)   # NB dispersion

    # month-level error: refit without each training year, compare that year's monthly totals (months >= MIN_MONTH)
    midx, months = _months(g.date)
    logs = []
    for yr in TRAIN_YEARS:
        p = _mu(X, x, _fit(y, X, x, np.flatnonzero(train & (yrs != yr))))
        sel = train & (yrs == yr)
        obs = np.bincount(midx[sel], weights=y[sel], minlength=len(months))
        prd = np.bincount(midx[sel], weights=p[sel], minlength=len(months))
        ok = (obs >= MIN_MONTH) & (prd > 0)
        logs.extend(np.log(obs[ok] / prd[ok]))
    sigma_month = float(np.sqrt(np.mean(np.square(logs)))) if logs else 0.0

    by_year = {yr: np.flatnonzero(train & (yrs == yr)) for yr in TRAIN_YEARS}
    draws = np.empty((nboot, len(y)))
    for b in range(nboot):
        rows = np.concatenate([by_year[yr] for yr in rng.choice(list(TRAIN_YEARS), len(TRAIN_YEARS))])
        mub = _mu(X, x, _fit(y, X, x, rows))
        mub *= np.exp(sigma_month * rng.standard_normal(len(months)) - sigma_month ** 2 / 2)[midx]
        draws[b] = rng.poisson(mub * rng.gamma(1 / a, a, len(mub)))

    ymd = lambda ts: ts.strftime("%Y-%m-%d")
    score = _score(g, y, mu, draws, hold, midx, months, archive_through, x, train)
    score.update({
        "sensors": ["noaa20", "noaa21"], "train": [ymd(N20_START), ymd(TRAIN_END)],
        "hold": [ymd(HOLD_START), ymd(archive_through)],
        "forward": [ymd(archive_through + pd.Timedelta(days=1)), ymd(forward_through)],
        "ratio_day": round(float(np.exp(params[0])), 4), "ratio_night": round(float(np.exp(params[0] + params[1])), 4),
        "n21_scale_day": round(k["D"], 4), "n21_scale_night": round(k["N"], 4),
        "alpha": a, "sigma_month": sigma_month,
        "outage_days_forward": sorted({ymd(t) for t in g.date[fwd & (out["n20"] | out["n21"])]}),
    })

    day = (g.date[fwd] - (archive_through + pd.Timedelta(days=1))).dt.days.values
    nd = (forward_through - archive_through).days
    pred = np.bincount(day, weights=mu[fwd], minlength=nd)
    dr = np.stack([np.bincount(day, weights=r, minlength=nd) for r in draws[:, fwd]])
    return {"dates": pd.date_range(archive_through + pd.Timedelta(days=1), forward_through),
            "pred": pred, "draws": dr, "score": score}


def _score(g, y, mu, draws, hold, midx, months, through, x, train):
    """Hold-out scores: monthly (complete months with >= MIN_MONTH observed) and annual (complete years).
    mape_ratio_month: NOAA-20 alone times one constant ratio (the naive baseline)."""
    sel, nm = hold, len(months)
    agg = lambda w: np.bincount(midx[sel], weights=w[sel], minlength=nm)
    obs, prd = agg(y), agg(mu)
    lo, hi = np.percentile(np.stack([agg(r) for r in draws]), [5, 95], axis=0)
    complete = np.array([m.end_time.normalize() <= through for m in months])
    ok = complete & np.array([m.start_time >= HOLD_START for m in months]) & (obs >= MIN_MONTH)
    n20 = g.n20_n.values.astype(float)
    ratio = y[train].sum() / n20[train].sum()
    pct = lambda p, o: float(np.mean(np.abs(p - o) / o) * 100) if len(o) else None

    yrs = g.year.values
    hy = [yr for yr in range(HOLD_START.year, through.year + 1) if pd.Timestamp(yr, 12, 31) <= through]
    ysel = [sel & (yrs == yr) for yr in hy]
    oy, py = np.array([y[s].sum() for s in ysel]), np.array([mu[s].sum() for s in ysel])
    dy = np.array([[r[s].sum() for s in ysel] for r in draws]).reshape(len(draws), len(hy))
    ylo, yhi = np.percentile(dy, [5, 95], axis=0) if hy else (np.array([]), np.array([]))
    return {
        "mape_month": pct(prd[ok], obs[ok]), "mape_ratio_month": pct(agg(n20)[ok] * ratio, obs[ok]),
        "coverage_month": int(((obs >= lo) & (obs <= hi))[ok].sum()), "n_month": int(ok.sum()),
        "min_month": MIN_MONTH,
        "mape_year": pct(py, oy), "coverage_year": int(((oy >= ylo) & (oy <= yhi)).sum()), "n_year": len(hy),
    }
