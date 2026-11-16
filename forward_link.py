import numpy as np, pandas as pd
import statsmodels.api as sm

N20_START = pd.Timestamp("2018-04-01")
N21_START = pd.Timestamp("2024-01-01")
TRAIN_END = pd.Timestamp("2023-12-31")
HOLD_START = pd.Timestamp("2024-01-01")
TRAIN_YEARS = range(2018, 2024)
MIN_MONTH = 100
OUT_MIN = 20


def region_days(d, end):
    cols = ["viirs_n", "n20_n", "n21_n"]
    g = d[(d.date >= N20_START) & (d.date <= end)].groupby(["date", "daynight"])[cols].sum()
    idx = pd.MultiIndex.from_product([pd.date_range(N20_START, end), ["D", "N"]], names=["date", "daynight"])
    g = g.reindex(idx, fill_value=0).reset_index()
    g["year"] = g.date.dt.year
    return g


def outages(g, archive_through):
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
    usable = ~(n20_out & (~has21 | n21_out))
    return x, k, {"snpp": snpp_out, "n20": n20_out, "n21": n21_out, "usable": usable}


def _design(g):
    return np.column_stack([np.ones(len(g)), (g.daynight == "N").values.astype(float)])


def _fit(y, X, x, rows):
    rows = rows[x[rows] > 0]
    return sm.GLM(y[rows], X[rows], offset=np.log(x[rows]), family=sm.families.Poisson()).fit().params


def _mu(X, x, params):
    return np.exp(X @ params) * x


def _months(dates):
    p = dates.dt.to_period("M")
    first = p.min()
    months = pd.period_range(first, p.max(), freq="M")
    return ((p.dt.year - first.year) * 12 + p.dt.month - first.month).values, months


def run_forward(d, archive_through, forward_through, nboot, rng):
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
    a = max(float(np.sum((y[t] - mu[t]) ** 2 - y[t]) / np.sum(mu[t] ** 2)), 1e-3)

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
