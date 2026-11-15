"""Per-region model: fit VIIRS ~ MODIS count model on 2012-2019, back-cast a VIIRS-equivalent record
for 2001-2011, validate on held-out 2020-2025. Usage: python model.py [region_id ...] [--nboot N]
Writes site/public/data/<region_id>/annual.json and series.json (monthly + weekly series with 5-95% bands,
plus the burn-calendar block from calendar_stats.calendar_block);
run() also returns per-week sums and bootstrap draw sums."""
import argparse, gc, json, os, time
import numpy as np, pandas as pd
import statsmodels.api as sm
from patsy import dmatrix
from calendar_stats import calendar_block
try:
    import resource   # not on Windows
except ImportError:
    resource = None

TRAIN, HOLD, NBOOT = range(2012, 2020), range(2020, 2026), 200
VIIRS_START = pd.Timestamp("2012-01-20")   # first VIIRS S-NPP day in FIRMS: earlier weeks have no VIIRS, not zero VIIRS
COMMON = " + C(month) + daynight + C(band)"
F_FULL = "viirs_n ~ la + lt + lf + lr + I(modis_n == 0)" + COMMON      # Terra + Aqua
F_TERRA = "viirs_n ~ lt + lft + lrt + I(terra_n == 0)" + COMMON         # Terra only (before Aqua)
# overpass drift (ML-016): satellite key in annual.json -> `satellite` value in points/<year>.csv
OVERPASS_SATS = {"terra": "Terra", "aqua": "Aqua", "snpp": "SNPP"}
DRIFT_BASE, DRIFT_LIMIT, DRIFT_SATS = range(2013, 2020), 0.5, ("terra", "aqua")   # stable-orbit years; hours

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
    """(year, week) pairs from 2001 that start on or before `through`. The last one is partial when it ends after
    `through` (ML-010: dropping it cut the record, and the last whole month, short of the data)."""
    through = pd.Timestamp(through)
    return [(yr, wk) for yr in range(2001, through.year + 1) for wk in range(52) if week_start(yr, wk) <= through]

def overpass_hours(path):
    """Median daytime local solar time (hours) per satellite in one points/<year>.csv: time_utc (HHMM, UTC) + lon/15.
    Median over detections, so it is the time the satellite saw this region's fires; it also moves with the
    longitude mix of those fires (7.5 deg = 0.5 h), which matters only for very wide regions. {key: float or None}."""
    d = pd.read_csv(path, usecols=["time_utc", "lon", "satellite", "daynight"], dtype={"time_utc": str})
    d = d[d.daynight == "D"]
    t = d.time_utc.str.strip().str.zfill(4)
    lst = (t.str[:2].astype(int) + t.str[2:].astype(int) / 60 + d.lon / 15) % 24
    med = lst.groupby(d.satellite).median()
    return {k: (float(med[s]) if s in med.index else None) for k, s in OVERPASS_SATS.items()}

def overpass_block(points_dir, years):
    """Per year: median daytime overpass per satellite (None without a points file or detections), and drifted = 1
    where Terra or Aqua is more than DRIFT_LIMIT hours from its own DRIFT_BASE median (median of the yearly medians;
    a satellite with no base-year value is never flagged)."""
    ov = {k: [] for k in OVERPASS_SATS}
    for yr in years:
        p = os.path.join(points_dir, f"{yr}.csv")
        h = overpass_hours(p) if os.path.isfile(p) else {}
        for k in OVERPASS_SATS:
            ov[k].append(h.get(k))
    drifted = [0] * len(years)
    for k in DRIFT_SATS:
        base = [v for yr, v in zip(years, ov[k]) if yr in DRIFT_BASE and v is not None]
        if base:
            ref = float(np.median(base))
            drifted = [int(f or (v is not None and abs(v - ref) > DRIFT_LIMIT)) for f, v in zip(drifted, ov[k])]
    return {k: [None if v is None else round(v, 3) for v in a] for k, a in ov.items()}, drifted

def covered_end(yr, wk, through):
    """Last day of week wk that has data: the week's end, or `through` for a partial last week."""
    return min(week_end(yr, wk), pd.Timestamp(through))

def series_bundle(region_id, weeks, wk, draws, through=None):
    """series.json content from per-week sums. Monthly: each week's value split over calendar months by its days with
    data in each (one share matrix for modis/viirs/pred/draws); ends at the last month whose last day is on or before
    `through` (default: end of the last kept week). weekly.last_week_days = days with data in the last week."""
    through = week_end(*weeks[-1]) if through is None else pd.Timestamp(through)
    nw = len(weeks)
    nm = (through.year - 2001) * 12 + through.month - (0 if through.is_month_end else 1)
    S = np.zeros((nw, nm))
    for k, (yr, wkn) in enumerate(weeks):
        days = pd.date_range(week_start(yr, wkn), covered_end(yr, wkn, through))
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
    monthly = block(S, [pd.Timestamp(2001 + i // 12, i % 12 + 1, 1) for i in range(nm)])
    # burn calendar (ML-005): stats on the published harmonized record = observed VIIRS where it exists, else the model
    harmonized = [p if v is None else v for v, p in zip(monthly["viirs"], monthly["pred"])]
    weekly = block(None, [week_start(yr, wkn) for yr, wkn in weeks])
    weekly["last_week_days"] = (covered_end(*weeks[-1], through) - week_start(*weeks[-1])).days + 1
    return {"schema": 1, "region": region_id, "monthly": monthly, "weekly": weekly,
            "calendar": calendar_block(harmonized, monthly["start_year"])}

def run(region_id, nboot=NBOOT, grid_dir="data/grid", out_dir="site/public/data", points_dir=None):
    """Fit one region and write annual.json + series.json. Returns dict: weeks (list of (year, week)), modis/viirs/pred
    (per-week region totals, arrays), draws (nboot x n_weeks bootstrap draw sums), ann (annual DataFrame), score.
    points_dir (default <out_dir>/<region_id>/points, written by build.py) feeds only the overpass fields."""
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
    wk_nov = np.array([week_start(*k) < VIIRS_START for k in weeks])    # kept week starts before VIIRS existed
    no_viirs = wk_nov[widx]
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

    # year-level error (ML-002): refit without each training year, compare that year's predicted and observed totals.
    # The bootstrap below misses this: its per-row noise averages out over a year, so annual bands came out ~2x too
    # narrow (hold-out coverage 1-4 of 6). sigma_year = RMS of log(observed / predicted) over the 8 left-out years.
    # Slightly conservative (it also holds parameter and count noise the bootstrap adds again). Thin: 8 years, F_FULL
    # only, applied to every year; the 2001-2011 back-cast extrapolates, so its true year error may be larger.
    rows_by_year = {yr: np.flatnonzero(istrain & (yrs == yr)) for yr in TRAIN}
    loyo = []
    for yr in TRAIN:
        p = fit(F_FULL, np.flatnonzero(istrain & (yrs != yr)))
        r = rows_by_year[yr]
        loyo.append(np.log(y[r].sum() / np.exp(X[F_FULL][r] @ p).sum()))
    sigma_year = float(np.sqrt(np.mean(np.square(loyo))))
    yidx = yrs - 2001                                                   # row -> year index, for one factor per year

    # intervals: year-block bootstrap of the fit, a shared lognormal factor per year (mean 1, sd sigma_year in log
    # terms), then negative-binomial sampling noise; keep only per-week sums
    draws = np.empty((nboot, nw))
    for b in range(nboot):
        mub = predict(np.concatenate([rows_by_year[yr] for yr in rng.choice(list(TRAIN), len(TRAIN))]))
        mub *= np.exp(sigma_year * rng.standard_normal(yidx.max() + 1) - sigma_year ** 2 / 2)[yidx]
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
    # harmonized (ML-009): observed VIIRS for weeks starting on/after VIIRS_START, model mean for earlier weeks, so a
    # year VIIRS only partly covers (2012: from 20 Jan) isn't published as a fake dip. Other years: viirs ?? pred.
    ann["harmonized"] = ysum(np.where(wk_nov, wk_pred, wk_viirs))
    ann["viirs_partial"] = (ysum(wk_nov.astype(int)) > 0) & (ysum((~wk_nov).astype(int)) > 0)   # 1 = blended year
    # obs_over_pred (ML-016): observed VIIRS / model mean over the weeks VIIRS covers (2012: from 20 Jan), so it
    # shows where the fitted MODIS -> VIIRS link stops holding (orbit drift). None before 2012.
    ov_viirs, ov_pred = ysum(np.where(wk_nov, 0, wk_viirs)), ysum(np.where(wk_nov, 0, wk_pred))
    obs_over_pred = [round(float(v / p), 4) if n and p > 0 else None
                     for v, p, n in zip(ov_viirs, ov_pred, ysum((~wk_nov).astype(int)))]
    points_dir = points_dir or os.path.join(out_dir, region_id, "points")
    if not os.path.isdir(points_dir):
        print(f"{region_id}: no {points_dir} (run build.py first?): overpass null, drifted 0", flush=True)
    overpass, drifted = overpass_block(points_dir, years)
    ann.loc[ann.index < 2012, "viirs_n"] = np.nan
    # a year is complete when its data reach Dec 31 (52 kept weeks is not enough: the last one may be partial)
    complete = {yr: week_end(yr, 51) <= pd.Timestamp(through) for yr in years}

    train = w[istrain]
    hy = [yr for yr in HOLD if yr in years and complete[yr]]   # complete hold-out years only
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
        "weekly_r": float(np.corrcoef(wk_pred[hm], wk_viirs[hm])[0, 1]), "sigma_year": sigma_year,
    }
    out = {"years": [int(v) for v in ann.index], "modis": [float(v) for v in ann.modis_n],
           "viirs": [None if np.isnan(v) else float(v) for v in ann.viirs_n],
           "pred": [float(v) for v in ann.mu.round(1)], "lo": [float(v) for v in ann.lo],
           "hi": [float(v) for v in ann.hi], "score": score,
           "partial": [int(not complete[yr]) for yr in years],
           "data_through": covered_end(*weeks[-1], through).strftime("%Y-%m-%d"),
           "harmonized": [float(v) for v in ann.harmonized.round(1)],
           "viirs_partial": [int(v) for v in ann.viirs_partial],
           "overpass": overpass, "obs_over_pred": obs_over_pred, "drifted": drifted}
    os.makedirs(os.path.join(out_dir, region_id), exist_ok=True)
    # build both files before writing either, so a failure can't leave annual.json new and series.json stale
    bundle = series_bundle(region_id, weeks, {"modis": wk_modis, "viirs": wk_viirs, "pred": wk_pred}, draws, through)
    write_json(os.path.join(out_dir, region_id, "annual.json"), out)
    write_json(os.path.join(out_dir, region_id, "series.json"), bundle)

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
