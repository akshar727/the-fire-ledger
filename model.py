"""Per-region model: fit VIIRS ~ MODIS count model on 2012-2019, back-cast a VIIRS-equivalent record
for 2001-2011, validate on held-out 2020-2025. Usage: python model.py [region_id ...] [--nboot N]
Whole countries (countries.json, ML-023): python model.py <country_id> [--method model|ratio] [--cell-deg D]; or the
batch runner run_countries.py. A country is fitted on coarser cells (`cell_deg`, ML-024) or with the constant-ratio
method (`method="ratio"`: MODIS x the 2012-2019 VIIRS/MODIS ratio, no fit, seconds), and labelled by the ship rule.
Writes site/public/data/<region_id>/annual.json and series.json (monthly + weekly series with 5-95% bands,
plus the burn-calendar block from calendar_stats.calendar_block);
run() also returns per-week sums and bootstrap draw sums.
After the S-NPP end (`archive_through`) the record continues with S-NPP-equivalent counts from NOAA-20/21
(forward_link.py, ML-017); every period carries `source`: backcast | observed | forward."""
import argparse, gc, json, os, time
import numpy as np, pandas as pd
import statsmodels.api as sm
from patsy import dmatrix
from calendar_stats import calendar_block
from trend_stats import trend_block
from forward_link import run_forward
from cells import cells_bundle
import site_bundle
import globe
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
# whole countries (ML-023, ML-024): cell sizes tried smallest first, the largest burning-cell count a fit may have
# (Ghana's 362 at 0.25 deg was the largest proven run), and the least training VIIRS a model is checked on
CELL_STEPS, MAX_CELLS, SPARSE_MIN = (0.25, 0.5, 1.0, 2.0, 4.0, 8.0), 400, 1000
COUNTRY_GRID = "data/grid/country"
COUNTRY_NBOOT = 100   # ML-024: same score as 200 draws on Ghana at 1 deg, half the time

def coarsen(d, cell_deg):
    """Sum a 0.25 deg daily grid to cell_deg cells (ML-024): counts summed, mean FRP weighted by counts (so
    n * frp_mean, what run() uses, is the exact sum of the small cells'). Cells are named by their south-west corner."""
    d = d.copy()
    d["lat"] = np.floor(d.lat / cell_deg) * cell_deg
    d["lon"] = np.floor(d.lon / cell_deg) * cell_deg
    keys = ["date", "lat", "lon", "daynight"]
    sums = {}
    for k in ("terra", "aqua", "viirs", "n20", "n21"):
        if f"{k}_n" in d.columns:
            d[f"{k}_frp_sum"] = d[f"{k}_n"] * d[f"{k}_frp_mean"].fillna(0)
            sums[k] = [f"{k}_n", f"{k}_frp_sum"]
    g = d.groupby(keys, sort=True)[[c for v in sums.values() for c in v]].sum().reset_index()
    for k, (n, fs) in sums.items():
        g[f"{k}_frp_mean"] = np.where(g[n] > 0, g[fs] / g[n].clip(lower=1), np.nan)
        g = g.drop(columns=fs)
    return g


def burning_cells(d, cell_deg):
    """Cells of size cell_deg with any Terra, Aqua or S-NPP detection (the model's cell list)."""
    seen = d[(d.terra_n + d.aqua_n + d.viirs_n) > 0]
    return len(set(zip(np.floor(seen.lat / cell_deg), np.floor(seen.lon / cell_deg))))


def pick_cell_deg(d, steps=CELL_STEPS, max_cells=MAX_CELLS):
    """Smallest cell size in steps with at most max_cells burning cells (ML-024 rule), else the largest. Returns
    (cell_deg, {cell_deg: burning cells})."""
    counts = {}
    for c in steps:
        counts[c] = burning_cells(d, c)
        if counts[c] <= max_cells:
            return c, counts
    return steps[-1], counts


def ship_rule(score, method, sparse):
    """The label a whole country is published with (ML-024): "sparse" (too little fire to check), "ratio" (the ratio
    method ran, or one constant ratio beat the model on the hidden years), "model" (beats the ratio and >= 4 of 6
    hidden years inside the band), "caveat" (beats the ratio, band too narrow)."""
    if sparse or score.get("mape_model") is None or score.get("mape_ratio") is None:
        return "sparse"
    if method == "ratio" or score["mape_model"] >= score["mape_ratio"]:
        return "ratio"
    return "model" if score["coverage"] >= min(4, score["n_hold"]) else "caveat"


def mape(pred, obs):
    """Mean absolute % error over years with observed fire (a 0 year can't be scored; None if there is none)."""
    pred, obs = np.asarray(pred, float), np.asarray(obs, float)
    ok = obs > 0
    return float((abs(pred[ok] - obs[ok]) / obs[ok]).mean() * 100) if ok.any() else None


def corr(a, b):
    """Pearson r, or None when either side is constant (e.g. no fire at all)."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    return float(np.corrcoef(a, b)[0, 1]) if a.std() > 0 and b.std() > 0 else None


def country_caveat(ship, score, model_score, ann, missing_files):
    """Plain sentences a whole country shows with its record, or None."""
    out = []
    pct = lambda v: f"{v:.1f}%"
    if ship == "caveat":
        out.append(f"Only {score['coverage']} of the {score['n_hold']} hidden years (2020-2025) fell inside the model's "
                   "5-95% band, so the band is too narrow here.")
    elif ship == "ratio" and model_score and model_score.get("mape_model") is not None:
        out.append(f"On the hidden years 2020-2025 one constant VIIRS/MODIS ratio was closer than the model "
                   f"({pct(model_score['mape_ratio'])} vs {pct(model_score['mape_model'])} average error), so the "
                   "years before 2012 are MODIS times that ratio.")
    elif ship == "sparse":
        out.append("Too little fire to check: a year of 2012-2025 has no VIIRS detections or 2012-2019 has fewer than "
                   f"{SPARSE_MIN:,}, so the years before 2012 are MODIS times the 2012-2019 ratio and are not validated.")
    # the yearly total itself, not per MODIS detection: before mid-2002 MODIS is Terra only, so per-detection runs
    # about 2x by design
    hm = ann.harmonized
    base = hm[(hm.index >= 2003) & (hm.index <= 2011)]
    early = hm[hm.index <= 2002]
    if len(base) >= 5 and len(early) and (early > 1.5 * base.median()).any():
        out.append("The 2001-2002 back-cast (Terra only before mid-2002) runs high against MODIS here: treat 2001-2002 "
                   "with caution.")
    if missing_files:
        years = sorted({int(f.split("_")[1]) for f in missing_files})
        out.append(f"FIRMS has no file for {len(missing_files)} sensor-year(s) ({', '.join(map(str, years))}); "
                   "those count as no fire.")
    return " ".join(out) or None


def week_end(yr, wk):
    """Last day of week wk (covers day-of-year 7wk+1..7wk+7; week 51 runs to Dec 31)."""
    end = pd.Timestamp(yr, 12, 31) if wk == 51 else pd.Timestamp(yr, 1, 1) + pd.Timedelta(days=7 * wk + 6)
    return end

def week_start(yr, wk):
    return pd.Timestamp(yr, 1, 1) + pd.Timedelta(days=7 * wk)

def forward_through(sensors, archive_through):
    """Last day of the forward record: the earliest NOAA-20/21 `data_through` in the manifest, or None if there is
    no NOAA data past `archive_through`."""
    ends = [pd.Timestamp(sensors[s]["data_through"]) for s in ("n20", "n21") if s in sensors]
    end = min(ends) if ends else None
    return end if end is not None and end > pd.Timestamp(archive_through) else None

def source_of(has_fwd, viirs):
    """Per period: forward (any day after the S-NPP end), observed (S-NPP value), else backcast."""
    return ["forward" if f else "backcast" if v is None else "observed" for f, v in zip(has_fwd, viirs)]

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

def series_bundle(region_id, weeks, wk, draws, through=None, fwd=None):
    """series.json content from per-week sums. Monthly: each week's value split over calendar months by its days with
    data in each (one share matrix for modis/viirs/pred/draws); ends at the last month whose last day is on or before
    `through` (default: end of the last kept week). weekly.last_week_days = days with data in the last week.
    fwd (ML-017): forward days after `through` from forward_link.run_forward (`dates`, `pred`, `draws` per day);
    `weeks` then runs to the last forward day and `wk`/`draws` hold zeros there. Forward days add to `pred`/`lo`/`hi`
    by their own day and month; `viirs` is null for any period with a forward day; the monthly arrays then end with
    the partial month to date (monthly.last_month_days), whose calendar statistics are left out.
    ML-022: a period with forward days takes observed S-NPP (`wk["viirs"]`) for its days up to `through`, not the
    back-cast: `pred` = observed part + forward mean, `lo`/`hi` = observed part + forward draws (the observed part is
    fixed, so it adds no spread). The observed S-NPP-end week is split over months by equal weight per day, the same
    approximation as every monthly value. Safe only because a forward period always starts after VIIRS_START, so
    `wk["viirs"]` is observed S-NPP wherever `has_fwd` is true (padded zeros for pure-forward weeks add nothing)."""
    through = week_end(*weeks[-1]) if through is None else pd.Timestamp(through)
    end = fwd["dates"][-1] if fwd else through
    nw = len(weeks)
    nm = (end.year - 2001) * 12 + end.month - (0 if end.is_month_end or fwd else 1)
    S = np.zeros((nw, nm))
    for k, (yr, wkn) in enumerate(weeks):
        days = pd.date_range(week_start(yr, wkn), covered_end(yr, wkn, through))
        for dt in days:
            if (i := (dt.year - 2001) * 12 + dt.month - 1) < nm:
                S[k, i] += 1 / len(days)
    mstarts = [pd.Timestamp(2001 + i // 12, i % 12 + 1, 1) for i in range(nm)]
    wstarts = [week_start(yr, wkn) for yr, wkn in weeks]
    Fm = Fw = None
    if fwd:   # forward day -> month and -> week (exact, no day share needed)
        nd = len(fwd["dates"])
        wi = {k: i for i, k in enumerate(weeks)}
        Fm, Fw = np.zeros((nd, nm)), np.zeros((nd, nw))
        Fm[np.arange(nd), [(t.year - 2001) * 12 + t.month - 1 for t in fwd["dates"]]] = 1
        Fw[np.arange(nd), [wi[(t.year, min((t.dayofyear - 1) // 7, 51))] for t in fwd["dates"]]] = 1
    r = lambda a: [float(v) for v in np.round(a, 1)]
    def block(M, F, starts, ends):
        d = {"start_year": 2001}
        d.update({"bucketing": "calendar-month-day-share"} if M is not None else {"weeks_per_year": 52})
        has_fwd = [min(e, end) > through for e in ends]
        obs = wk["viirs"] @ M if M is not None else wk["viirs"]    # observed S-NPP, days up to `through` only
        for k in ("modis", "viirs", "pred"):
            a = wk[k] @ M if M is not None else wk[k]
            if k == "pred" and F is not None:
                a = np.where(has_fwd, obs, a) + fwd["pred"] @ F     # ML-022: observed S-NPP part, not the back-cast
            # viirs is null for a month or week that starts before VIIRS_START (incl. January 2012) or has forward days
            d[k] = [None if k == "viirs" and (s < VIIRS_START or f) else x for s, f, x in zip(starts, has_fwd, r(a))]
        dr = draws @ M if M is not None else draws
        if F is not None:
            dr = np.where(has_fwd, obs, dr) + fwd["draws"] @ F
        lo, hi = np.percentile(dr, [5, 95], axis=0)
        d["lo"], d["hi"] = r(lo), r(hi)
        d["source"] = source_of(has_fwd, d["viirs"])
        return d
    monthly = block(S, Fm, mstarts, [m + pd.offsets.MonthEnd(0) for m in mstarts])
    monthly["last_month_days"] = (min(mstarts[-1] + pd.offsets.MonthEnd(0), end) - mstarts[-1]).days + 1
    # burn calendar (ML-005): stats on the published harmonized record = observed VIIRS where it exists, else the model;
    # a partial last month (forward, to date) is left out so it is never compared with whole months
    harmonized = [p if v is None else v for v, p in zip(monthly["viirs"], monthly["pred"])]
    if monthly["last_month_days"] < (mstarts[-1] + pd.offsets.MonthEnd(0)).day:
        harmonized[-1] = None
    weekly = block(None, Fw, wstarts, [week_end(yr, wkn) for yr, wkn in weeks])
    weekly["last_week_days"] = (covered_end(*weeks[-1], end) - week_start(*weeks[-1])).days + 1
    return {"schema": 1, "region": region_id, "monthly": monthly, "weekly": weekly,
            "calendar": calendar_block(harmonized, monthly["start_year"])}

def run(region_id, nboot=NBOOT, grid_dir="data/grid", out_dir="site/public/data", points_dir=None, write_cells=False,
        cell_deg=None, method="model", tier=None, model_score=None):
    """Fit one region and write annual.json + series.json. Returns dict: weeks (list of (year, week)), modis/viirs/pred
    (per-week region totals, arrays), draws (nboot x n_weeks bootstrap draw sums), ann (annual DataFrame), score.
    points_dir (default <out_dir>/<region_id>/points, written by build.py) feeds only the overpass fields.
    write_cells (ML-018): also write cells.json (per-cell monthly back-cast, cells.py). Off by default; the CLI
    (main) turns it on for the regions.json regions only.
    Whole countries (ML-023): cell_deg sums the grid to coarser cells (None = as built, the 3 regions unchanged);
    method="ratio" skips the fit (pred = MODIS x the 2012-2019 VIIRS/MODIS ratio, by day/night, Terra-only ratio
    before Aqua); tier="country" adds tier/cell_deg/method/ship/caveat to both files, and a model that loses to one
    constant ratio on the hidden years is re-run as the ratio (model_score keeps the model's score)."""
    if method not in ("model", "ratio"):
        raise ValueError(f"method must be 'model' or 'ratio', not {method!r}")
    if write_cells and method != "model":
        raise ValueError("write_cells needs the cell model (method='model')")
    args = dict(nboot=nboot, grid_dir=grid_dir, out_dir=out_dir, points_dir=points_dir, cell_deg=cell_deg, tier=tier)
    t0 = time.time()
    rng = np.random.default_rng(0)   # per region, so output doesn't depend on which other regions ran
    man = load_json(os.path.join(grid_dir, "manifest.json"))[region_id]
    through = man["archive_through"]
    weeks = kept_weeks(through)
    d = pd.read_csv(os.path.join(grid_dir, f"fire_grid_daily_{region_id}.csv"), parse_dates=["date"])
    if method == "ratio":
        d["lat"], d["lon"] = 0.0, 0.0   # the ratio has no spatial terms: one cell gives the same totals, far faster
    elif cell_deg is not None:
        d = coarsen(d, cell_deg)
    # forward link (ML-017): its own random stream, so the back-cast below is byte-identical with or without it
    fend = forward_through(man.get("sensors", {}), through)
    # fend comes from the manifest build.py writes with the grid; not clipped to the last grid row, because the grid is
    # sparse (a day with no fire anywhere has no row) and clipping would drop real zero days
    fwd = None
    if fend is not None and {"n20_n", "n21_n"} <= set(d.columns):
        fwd = run_forward(d[["date", "daynight", "viirs_n", "n20_n", "n21_n"]], through, fend, nboot,
                          np.random.default_rng(1))
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

    # too little fire to check (ML-014, ML-023): no inf/NaN from empty totals; a zero hold-out year can't be scored
    tr_v, tr_m = float(y[istrain].sum()), float(w.modis_n.values[istrain].sum())
    if tr_v == 0 or tr_m == 0:
        raise SystemExit(f"{region_id}: 2012-2019 training has {tr_v:.0f} VIIRS and {tr_m:.0f} MODIS detections; "
                         "there is nothing to scale")
    sparse = (tr_v < SPARSE_MIN or any(y[istrain & (yrs == yr)].sum() == 0 for yr in TRAIN)
              or any(y[yrs == yr].sum() == 0 for yr in HOLD if yr in set(yrs.tolist())))
    if sparse and method == "model" and tier is not None:   # the 3 deep dives always fit the model
        method = "ratio"   # a model fit on near-empty training years would be noise; the label says so
        print(f"{region_id}: too little fire to check the model ({tr_v:.0f} VIIRS detections 2012-2019): ratio method")

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

    if method == "model":
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
    else:
        # constant ratio (ML-023): MODIS x the 2012-2019 VIIRS/MODIS ratio per day/night, Terra-only ratio before
        # Aqua; year error from leaving each training year out (as sigma_year above), then Poisson count noise
        a_full = None
        dn, terra, modis = w.daynight.values, w.terra_n.values, w.modis_n.values

        def ratios(rows, floor=30):
            # day and night apart, but the pooled day+night ratio where MODIS (or Terra) saw fewer than `floor`
            # training detections: 800 VIIRS over 1 Terra detection is not a ratio
            pool = (y[rows].sum() / max(modis[rows].sum(), 1), y[rows].sum() / max(terra[rows].sum(), 1))
            r = {}
            for k in ("D", "N"):
                m = rows & (dn == k)
                r[k] = (y[m].sum() / modis[m].sum() if modis[m].sum() >= floor else pool[0],
                        y[m].sum() / terra[m].sum() if terra[m].sum() >= floor else pool[1])
            return r

        def ratio_pred(r):
            full = np.where(dn == "D", r["D"][0], r["N"][0])
            tonly = np.where(dn == "D", r["D"][1], r["N"][1])
            return np.where(pre, terra * tonly, modis * full)

        mu = ratio_pred(ratios(istrain))
        loyo = []
        for yr in TRAIN:
            r = istrain & (yrs == yr)
            p = ratio_pred(ratios(istrain & (yrs != yr)))[r].sum()
            if y[r].sum() > 0 and p > 0:
                loyo.append(np.log(y[r].sum() / p))
        sigma_year = float(np.sqrt(np.mean(np.square(loyo)))) if loyo else 0.0
        yidx = yrs - 2001
        draws = np.empty((nboot, nw))
        for b in range(nboot):
            mub = mu * np.exp(sigma_year * rng.standard_normal(yidx.max() + 1) - sigma_year ** 2 / 2)[yidx]
            draws[b] = np.bincount(widx, weights=rng.poisson(mub), minlength=nw)

    wk_modis = np.bincount(widx, weights=w.modis_n.values, minlength=nw)
    wk_viirs = np.bincount(widx, weights=y, minlength=nw)
    wk_pred = np.bincount(widx, weights=mu, minlength=nw)
    # ML-018: per-cell monthly back-cast, built here while `weeks` is still the back-cast weeks (no forward padding)
    cb = cells_bundle(region_id, w.lat.values, w.lon.values, widx, weeks, through, w.modis_n.values, y, mu,
                      a_full, sigma_year, VIIRS_START) if write_cells else None
    # forward link (ML-017): weeks run on to the last NOAA day; the back-cast arrays get zeros there (wk_bc, draws: what
    # series_bundle splits over months), the forward days are added per week for the annual totals (wk_pred, draws_all)
    end = fwd["dates"][-1] if fwd else pd.Timestamp(through)
    wk_bc, draws_all = wk_pred, draws
    wk_fwd = np.zeros(nw, bool)                                         # week has days after the S-NPP end
    wk_link = np.zeros(nw)                                              # forward-link mean per week (ML-022)
    if fwd:
        weeks = kept_weeks(end)
        pad = lambda a: np.concatenate([a, np.zeros(a.shape[:-1] + (len(weeks) - nw,), a.dtype)], axis=-1)
        wk_modis, wk_viirs, wk_bc, draws, wk_nov = map(pad, (wk_modis, wk_viirs, wk_pred, draws, wk_nov))
        wi = {k: i for i, k in enumerate(weeks)}
        Fw = np.zeros((len(fwd["dates"]), len(weeks)))
        Fw[np.arange(len(fwd["dates"])), [wi[(t.year, min((t.dayofyear - 1) // 7, 51))] for t in fwd["dates"]]] = 1
        wk_link = fwd["pred"] @ Fw
        wk_pred, draws_all = wk_bc + wk_link, draws + fwd["draws"] @ Fw
        wk_fwd = np.array([covered_end(*k, end) > pd.Timestamp(through) for k in weeks])
    wyear = np.array([yr for yr, _ in weeks])
    years = sorted(set(wyear.tolist()))
    ysum = lambda a: np.stack([a[..., wyear == yr].sum(axis=-1) for yr in years], axis=-1)   # weeks -> years
    ann = pd.DataFrame({"modis_n": ysum(wk_modis), "viirs_n": ysum(wk_viirs), "mu": ysum(wk_pred)},
                       index=pd.Index(years, name="year"))
    ann["lo"], ann["hi"] = np.percentile(ysum(draws_all), [5, 95], axis=0)
    # harmonized (ML-009): observed VIIRS for weeks starting on/after VIIRS_START, model mean for earlier weeks, so a
    # year VIIRS only partly covers (2012: from 20 Jan) isn't published as a fake dip. Other years: viirs ?? pred.
    # Weeks with forward days (ML-017, ML-022): observed S-NPP to the S-NPP end + the forward link after it.
    # Annual pred/lo/hi stay the model line (back-cast + link) by design: don't align them to harmonized.
    ann["harmonized"] = ysum(np.where(wk_nov, wk_pred, wk_viirs + np.where(wk_fwd, wk_link, 0)))
    ann["viirs_partial"] = (ysum(wk_nov.astype(int)) > 0) & (ysum((~wk_nov).astype(int)) > 0)   # 1 = blended year
    # obs_over_pred (ML-016): observed VIIRS / model mean over the weeks VIIRS covers (2012: from 20 Jan), so it
    # shows where the fitted MODIS -> VIIRS link stops holding (orbit drift). None before 2012.
    ov_viirs, ov_pred = ysum(np.where(wk_nov, 0, wk_viirs)), ysum(np.where(wk_nov, 0, wk_bc))
    obs_over_pred = [round(float(v / p), 4) if n and p > 0 else None
                     for v, p, n in zip(ov_viirs, ov_pred, ysum((~wk_nov).astype(int)))]
    points_dir = points_dir or os.path.join(out_dir, region_id, "points")
    if not os.path.isdir(points_dir):
        print(f"{region_id}: no {points_dir} (run build.py first?): overpass null, drifted 0", flush=True)
    overpass, drifted = overpass_block(points_dir, years)
    ann.loc[ann.index < 2012, "viirs_n"] = np.nan
    # a year is complete when its data reach Dec 31 (52 kept weeks is not enough: the last one may be partial)
    complete = {yr: week_end(yr, 51) <= end for yr in years}

    train = w[istrain]
    hy = [yr for yr in HOLD if yr in years and complete[yr]]   # complete hold-out years only
    if not hy:
        raise SystemExit(f"{region_id}: no complete hold-out year {HOLD.start}-{HOLD.stop - 1} (archive_through {through})")
    h = ann.loc[hy]
    ratio = train.viirs_n.sum() / train.modis_n.sum()                  # naive baseline: one constant factor
    hm = np.isin(wyear, hy)
    score = {
        "mape_model": mape(h.mu, h.viirs_n),
        "mape_ratio": mape(h.modis_n * ratio, h.viirs_n),
        "coverage": int(((h.viirs_n >= h.lo) & (h.viirs_n <= h.hi)).sum()), "n_hold": len(h),
        "ratio": float(ratio), "alpha": a_full,
        "weekly_r": corr(wk_pred[hm], wk_viirs[hm]), "sigma_year": sigma_year,
        "forward": fwd["score"] if fwd else None,   # ML-017: NOAA-20/21 -> S-NPP link, hold-out 2024 -> S-NPP end
    }
    country = None
    if tier is not None:
        ship = ship_rule(score, method, sparse)
        if method == "model" and ship == "ratio":   # one constant ratio did better on the hidden years: publish that
            print(f"{region_id}: model {score['mape_model']:.1f}% vs one ratio {score['mape_ratio']:.1f}% on 2020-2025: "
                  "published as the constant-ratio estimate", flush=True)
            return run(region_id, method="ratio", model_score=score, **args)
        country = {"tier": tier, "cell_deg": cell_deg if method == "model" else None, "method": method, "ship": ship,
                   "caveat": country_caveat(ship, score, model_score, ann, man.get("missing_files") or []),
                   "model_score": model_score}
    yfwd = [bool(wk_fwd[wyear == yr].any()) for yr in years]
    out = {"years": [int(v) for v in ann.index], "modis": [float(v) for v in ann.modis_n],
           "viirs": [None if np.isnan(v) else float(v) for v in ann.viirs_n],
           "pred": [float(v) for v in ann.mu.round(1)], "lo": [float(v) for v in ann.lo],
           "hi": [float(v) for v in ann.hi], "score": score,
           "partial": [int(not complete[yr]) for yr in years],
           # data_through stays the S-NPP end (the annual viirs/modis stop there); forward_through = NOAA end or None
           "data_through": pd.Timestamp(through).strftime("%Y-%m-%d"),
           "harmonized": [float(v) for v in ann.harmonized.round(1)],
           "viirs_partial": [int(v) for v in ann.viirs_partial],
           "overpass": overpass, "obs_over_pred": obs_over_pred, "drifted": drifted,
           "forward_through": end.strftime("%Y-%m-%d") if fwd else None,   # last forward (NOAA) day (ML-017)
           "source": source_of(yfwd, [None if yr < 2012 else 1 for yr in years])}
    if country:
        out.update(country)
    os.makedirs(os.path.join(out_dir, region_id), exist_ok=True)
    # build both files before writing either, so a failure can't leave annual.json new and series.json stale
    bundle = series_bundle(region_id, weeks, {"modis": wk_modis, "viirs": wk_viirs, "pred": wk_bc}, draws, through, fwd)
    # trend (ML-020, F-7): naive stitched record (raw MODIS for weeks before VIIRS_START, raw VIIRS after, so 2012
    # has no fake dip; same rule as the monthly viirs ?? modis) vs harmonized, complete years only. The bootstrap range
    # puts each draw in place of the model mean in the back-cast weeks (observed VIIRS fixed).
    full = [i for i, yr in enumerate(years) if complete[yr]]
    m = bundle["monthly"]
    stitched = ysum(np.where(wk_nov, wk_modis, wk_viirs))
    out["trend"] = trend_block(
        [years[i] for i in full],
        [float(stitched[i]) for i in full],
        [float(ann.harmonized.iloc[i]) for i in full],
        ysum(np.where(wk_nov, draws, wk_viirs))[:, full],
        [mo if v is None else v for v, mo in zip(m["viirs"], m["modis"])],
        [p if v is None else v for v, p in zip(m["viirs"], m["pred"])], m["start_year"])
    if country:
        bundle.update({k: country[k] for k in ("tier", "cell_deg", "method", "ship")})
    write_json(os.path.join(out_dir, region_id, "annual.json"), out)
    write_json(os.path.join(out_dir, region_id, "series.json"), bundle)
    if cb is not None:
        write_json(os.path.join(out_dir, region_id, "cells.json"), cb)

    mem = ""
    if resource:
        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss   # bytes on macOS, KB on Linux
        mem = f", peak memory {rss / (1 << 20 if os.uname().sysname == 'Darwin' else 1 << 10):.0f} MB"
    print(f"== {region_id} ==\n{ann.round(0).to_string()}\n{score}\nrun time {time.time() - t0:.0f} s{mem}", flush=True)
    return {"weeks": weeks, "modis": wk_modis, "viirs": wk_viirs, "pred": wk_pred, "draws": draws_all, "ann": ann,
            "score": score}

def main(argv=None):
    os.chdir(os.path.dirname(os.path.abspath(__file__)))   # ML-014: paths are relative to the repo root
    ids = [r["id"] for r in load_json("regions.json")]
    cids = [c["id"] for c in load_json("countries.json")] if os.path.exists("countries.json") else []
    ap = argparse.ArgumentParser(description="Per-region VIIRS back-cast model.")
    ap.add_argument("regions", nargs="*", metavar="region_id",
                    help=f"any of {ids}, or a countries.json id; default the regions")
    ap.add_argument("--nboot", type=int, default=None, help=f"default {NBOOT}, {COUNTRY_NBOOT} for a country")
    ap.add_argument("--method", choices=("model", "ratio"), default="model", help="countries only")
    ap.add_argument("--cell-deg", type=float, default=None,
                    help=f"countries only; default: smallest of {CELL_STEPS} deg with <= {MAX_CELLS} burning cells")
    ap.add_argument("--no-bundle", action="store_true", help="skip site_bundle/globe (run_countries.py runs them)")
    a = ap.parse_args(argv)
    bad = [r for r in a.regions if r not in ids and r not in cids]
    if bad:
        ap.error(f"unknown region_id {bad}; choose from {ids} or countries.json")
    for r in a.regions or ids:
        if r in cids:
            cell = a.cell_deg
            if a.method == "model" and cell is None:
                g = pd.read_csv(os.path.join(COUNTRY_GRID, f"fire_grid_daily_{r}.csv"),
                                usecols=["lat", "lon", "terra_n", "aqua_n", "viirs_n"])
                cell, counts = pick_cell_deg(g)
                print(f"{r}: burning cells by size {counts}: {cell} deg", flush=True)
            run(r, a.nboot or COUNTRY_NBOOT, grid_dir=COUNTRY_GRID, cell_deg=cell, method=a.method, tier="country")
        else:
            run(r, a.nboot or NBOOT, write_cells=True)   # ML-018: cells.json for the deep dives
    if not a.no_bundle:
        site_bundle.main()  # DP-009 / DP-018: refresh index.json countries and record fields from the files just written
        globe.main()        # ML-023: refresh globe.json

if __name__ == "__main__":
    main()
