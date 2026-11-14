"""Per-region model: fit VIIRS ~ MODIS count model on 2012-2019, back-cast a VIIRS-equivalent record
for 2001-2011, validate on held-out 2020-2025. Usage: python model.py [region_id ...] [--nboot N]
Writes site/public/data/<region_id>/annual.json and series.json (monthly + weekly series with 5-95% bands);
run() also returns per-week sums and bootstrap draw sums."""
import argparse, gc, json, os, time
import numpy as np, pandas as pd
import statsmodels.api as sm
from patsy import dmatrix
try:
    import resource   # not on Windows
except ImportError:
    resource = None

TRAIN, HOLD, NBOOT = range(2012, 2020), range(2020, 2026), 200
VIIRS_START = pd.Timestamp("2012-01-20")   # first VIIRS S-NPP day in FIRMS: earlier weeks have no VIIRS, not zero VIIRS
COMMON = " + C(month) + daynight + C(band)"
F_FULL = "viirs_n ~ la + lt + lf + lr + I(modis_n == 0)" + COMMON      # Terra + Aqua
F_TERRA = "viirs_n ~ lt + lft + lrt + I(terra_n == 0)" + COMMON         # Terra only (before Aqua)

def week_end(yr, wk):
    """Last day of week wk (covers day-of-year 7wk+1..7wk+7; week 51 runs to Dec 31)."""
    end = pd.Timestamp(yr, 12, 31) if wk == 51 else pd.Timestamp(yr, 1, 1) + pd.Timedelta(days=7 * wk + 6)
    return end

def week_start(yr, wk):
    return pd.Timestamp(yr, 1, 1) + pd.Timedelta(days=7 * wk)

def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)

def write_json(path, obj):
    """Atomic (temp file + rename), LF endings, no NaN, so a reader never sees a half-written file."""
    with open(path + ".part", "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(obj, allow_nan=False) + "\n")
    os.replace(path + ".part", path)

def kept_weeks(through):
    """(year, week) pairs from 2001 whose last day is on or before `through`."""
    through = pd.Timestamp(through)
    return [(yr, wk) for yr in range(2001, through.year + 1) for wk in range(52) if week_end(yr, wk) <= through]

def series_bundle(region_id, weeks, wk, draws):
    """series.json content from per-week sums. Monthly: each week's value split over calendar months by its days in
    each (one share matrix for modis/viirs/pred/draws); ends at the last month fully covered by the kept weeks."""
    nw, end = len(weeks), week_end(*weeks[-1])
    nm = (end.year - 2001) * 12 + end.month - (0 if end.is_month_end else 1)
    S = np.zeros((nw, nm))
    for k, (yr, wkn) in enumerate(weeks):
        days = pd.date_range(week_start(yr, wkn), week_end(yr, wkn))
        for dt in days:
            if (i := (dt.year - 2001) * 12 + dt.month - 1) < nm:
                S[k, i] += 1 / len(days)
    r = lambda a: [float(v) for v in np.round(a, 1)]
    def block(M, starts):
        d = {"start_year": 2001}
        d.update({"bucketing": "calendar-month-day-share"} if M is not None else {"weeks_per_year": 52})
        for k in ("modis", "viirs", "pred"):
            v = r(wk[k] @ M if M is not None else wk[k])
            # viirs is null for any month or week that starts before VIIRS_START (incl. January 2012)
            d[k] = [None if k == "viirs" and s < VIIRS_START else x for s, x in zip(starts, v)]
        lo, hi = np.percentile(draws @ M if M is not None else draws, [5, 95], axis=0)
        d["lo"], d["hi"] = r(lo), r(hi)
        return d
    return {"schema": 1, "region": region_id,
            "monthly": block(S, [pd.Timestamp(2001 + i // 12, i % 12 + 1, 1) for i in range(nm)]),
            "weekly": block(None, [week_start(yr, wkn) for yr, wkn in weeks])}

def run(region_id, nboot=NBOOT, grid_dir="data/grid", out_dir="site/public/data"):
    """Fit one region and write annual.json + series.json. Returns dict: weeks (list of (year, week)), modis/viirs/pred
    (per-week region totals, arrays), draws (nboot x n_weeks bootstrap draw sums), ann (annual DataFrame), score."""
    t0 = time.time()
    rng = np.random.default_rng(0)   # per region, so output doesn't depend on which other regions ran
    through = load_json(os.path.join(grid_dir, "manifest.json"))[region_id]["archive_through"]
    weeks = kept_weeks(through)
    d = pd.read_csv(os.path.join(grid_dir, f"fire_grid_daily_{region_id}.csv"), parse_dates=["date"])
    d["year"] = d.date.dt.year
    d["week"] = np.minimum((d.date.dt.day_of_year - 1) // 7, 51)
    for s in ("terra", "aqua"):
        d[s + "_frp_sum"] = d[s + "_n"] * d[s + "_frp_mean"].fillna(0)
    key = ["lat", "lon", "daynight", "year", "week"]
    w = d.groupby(key)[["terra_n", "aqua_n", "viirs_n", "terra_frp_sum", "aqua_frp_sum"]].sum()

    # full grid: every cell that ever burned x every kept week, so MODIS-zero weeks are modelled too
    cells = d[["lat", "lon"]].drop_duplicates()
    grid = (cells.merge(pd.DataFrame({"daynight": ["D", "N"]}), how="cross")
            .merge(pd.DataFrame(weeks, columns=["year", "week"]), how="cross"))
    del d
    w = grid.merge(w.reset_index(), on=key, how="left").fillna(0)
    w["month"] = pd.to_datetime(w.week * 7 + 4, unit="D", origin="2001-01-01").dt.month
    w["band"] = np.floor(w.lat).astype(int)
    w["modis_n"] = w.terra_n + w.aqua_n
    w["la"], w["lt"] = np.log1p(w.aqua_n), np.log1p(w.terra_n)
    w["lf"] = np.log1p((w.terra_frp_sum + w.aqua_frp_sum) / w.modis_n.clip(lower=1))   # mean MODIS fire power
    w["lft"] = np.log1p(w.terra_frp_sum / w.terra_n.clip(lower=1))
    # regional context: MODIS activity across the whole region that week (helps cells where MODIS saw nothing)
    grp = w.groupby(["year", "week", "daynight"])
    w["lr"], w["lrt"] = np.log1p(grp.modis_n.transform("sum")), np.log1p(grp.terra_n.transform("sum"))

    yrs, wks = w.year.values, w.week.values
    pre = (yrs == 2001) | ((yrs == 2002) & (wks <= 26))               # rows before Aqua: Terra-only model
    y = w.viirs_n.values
    X = {f: np.asarray(dmatrix(f.split("~")[1], w)) for f in (F_FULL, F_TERRA)}   # design matrices built once
    nw = len(weeks)
    widx = (pd.Series(range(nw), index=pd.MultiIndex.from_tuples(weeks))
            .reindex(pd.MultiIndex.from_arrays([yrs, wks])).values)   # row -> kept-week index
    no_viirs = np.array([week_start(*k) < VIIRS_START for k in weeks])[widx]
    istrain = w.year.isin(TRAIN).values & ~no_viirs                    # 2012 weeks 0-2 left out of training

    def fit(f, rows):
        """Poisson mean model: its score equations make predicted totals match observed totals in training."""
        params = sm.GLM(y[rows], X[f][rows], family=sm.families.Poisson()).fit().params
        gc.collect()   # statsmodels results sit in reference cycles; free their large arrays now, not at 10+ GB
        return params

    def predict(rows):
        mu = np.empty(len(y))
        mu[pre] = np.exp(X[F_TERRA][pre] @ fit(F_TERRA, rows))
        mu[~pre] = np.exp(X[F_FULL][~pre] @ fit(F_FULL, rows))
        return mu

    tr = np.flatnonzero(istrain)
    mu = predict(tr)
    mu_t = mu[tr]
    a_full = max(float(np.sum((y[tr] - mu_t) ** 2 - y[tr]) / np.sum(mu_t ** 2)), 1e-3)   # NB dispersion (Cameron-Trivedi)

    # intervals: year-block bootstrap of the fit + negative-binomial sampling noise; keep only per-week sums
    rows_by_year = {yr: np.flatnonzero(istrain & (yrs == yr)) for yr in TRAIN}
    draws = np.empty((nboot, nw))
    for b in range(nboot):
        mub = predict(np.concatenate([rows_by_year[yr] for yr in rng.choice(list(TRAIN), len(TRAIN))]))
        draws[b] = np.bincount(widx, weights=rng.poisson(mub * rng.gamma(1 / a_full, a_full, len(mub))), minlength=nw)

    wk_modis = np.bincount(widx, weights=w.modis_n.values, minlength=nw)
    wk_viirs = np.bincount(widx, weights=y, minlength=nw)
    wk_pred = np.bincount(widx, weights=mu, minlength=nw)
    wyear = np.array([yr for yr, _ in weeks])
    years = sorted(set(wyear.tolist()))
    ysum = lambda a: np.stack([a[..., wyear == yr].sum(axis=-1) for yr in years], axis=-1)   # weeks -> years
    ann = pd.DataFrame({"modis_n": ysum(wk_modis), "viirs_n": ysum(wk_viirs), "mu": ysum(wk_pred)},
                       index=pd.Index(years, name="year"))
    ann["lo"], ann["hi"] = np.percentile(ysum(draws), [5, 95], axis=0)
    ann.loc[ann.index < 2012, "viirs_n"] = np.nan
    nweeks = np.array([(wyear == yr).sum() for yr in years])

    train = w[istrain]
    hy = [yr for yr in HOLD if yr in years and nweeks[years.index(yr)] == 52]   # complete hold-out years only
    if not hy:
        raise SystemExit(f"{region_id}: no complete hold-out year {HOLD.start}-{HOLD.stop - 1} (archive_through {through})")
    h = ann.loc[hy]
    ratio = train.viirs_n.sum() / train.modis_n.sum()                  # naive baseline: one constant factor
    hm = np.isin(wyear, hy)
    score = {
        "mape_model": float((abs(h.mu - h.viirs_n) / h.viirs_n).mean() * 100),
        "mape_ratio": float((abs(h.modis_n * ratio - h.viirs_n) / h.viirs_n).mean() * 100),
        "coverage": int(((h.viirs_n >= h.lo) & (h.viirs_n <= h.hi)).sum()), "n_hold": len(h),
        "ratio": float(ratio), "alpha": a_full,
        "weekly_r": float(np.corrcoef(wk_pred[hm], wk_viirs[hm])[0, 1]),
    }
    out = {"years": [int(v) for v in ann.index], "modis": [float(v) for v in ann.modis_n],
           "viirs": [None if np.isnan(v) else float(v) for v in ann.viirs_n],
           "pred": [float(v) for v in ann.mu.round(1)], "lo": [float(v) for v in ann.lo],
           "hi": [float(v) for v in ann.hi], "score": score,
           "partial": [int(n < 52) for n in nweeks], "data_through": week_end(*weeks[-1]).strftime("%Y-%m-%d")}
    os.makedirs(os.path.join(out_dir, region_id), exist_ok=True)
    write_json(os.path.join(out_dir, region_id, "annual.json"), out)
    write_json(os.path.join(out_dir, region_id, "series.json"),
               series_bundle(region_id, weeks, {"modis": wk_modis, "viirs": wk_viirs, "pred": wk_pred}, draws))

    mem = ""
    if resource:
        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss   # bytes on macOS, KB on Linux
        mem = f", peak memory {rss / (1 << 20 if os.uname().sysname == 'Darwin' else 1 << 10):.0f} MB"
    print(f"== {region_id} ==\n{ann.round(0).to_string()}\n{score}\nrun time {time.time() - t0:.0f} s{mem}", flush=True)
    return {"weeks": weeks, "modis": wk_modis, "viirs": wk_viirs, "pred": wk_pred, "draws": draws, "ann": ann, "score": score}

def main():
    ids = [r["id"] for r in load_json("regions.json")]
    ap = argparse.ArgumentParser(description="Per-region VIIRS back-cast model.")
    ap.add_argument("regions", nargs="*", metavar="region_id", help=f"any of {ids}; default all")
    ap.add_argument("--nboot", type=int, default=NBOOT)
    a = ap.parse_args()
    bad = [r for r in a.regions if r not in ids]
    if bad:
        ap.error(f"unknown region_id {bad}; choose from {ids}")
    for r in a.regions or ids:
        run(r, a.nboot)

if __name__ == "__main__":
    main()
