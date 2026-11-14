"""Fit VIIRS ~ MODIS count model on 2012-2019, back-cast a VIIRS-equivalent record
for 2001-2011, validate on held-out 2020-2025. Writes web/data.js and site/public/data/portugal/annual.json."""
import json, os
import numpy as np, pandas as pd
import statsmodels.api as sm, statsmodels.formula.api as smf

TRAIN, HOLD, NBOOT = range(2012, 2020), range(2020, 2026), 200
rng = np.random.default_rng(0)

d = pd.read_csv("fire_grid_daily.csv", parse_dates=["date"])
d["year"] = d.date.dt.year
d["week"] = np.minimum((d.date.dt.day_of_year - 1) // 7, 51)
for s in ("terra", "aqua"):
    d[s + "_frp_sum"] = d[s + "_n"] * d[s + "_frp_mean"].fillna(0)
key = ["lat", "lon", "daynight", "year", "week"]
w = d.groupby(key)[["terra_n", "aqua_n", "viirs_n", "terra_frp_sum", "aqua_frp_sum"]].sum()

# full grid: every cell that ever burned x every week, so MODIS-zero weeks are modelled too
cells = d[["lat", "lon"]].drop_duplicates()
grid = (cells.merge(pd.DataFrame({"daynight": ["D", "N"]}), how="cross")
        .merge(pd.DataFrame({"year": range(2001, 2026)}), how="cross")
        .merge(pd.DataFrame({"week": range(52)}), how="cross"))
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
COMMON = " + C(month) + daynight + C(band)"
F_FULL = "viirs_n ~ la + lt + lf + lr + I(modis_n == 0)" + COMMON      # Terra + Aqua (2003 onward)
F_TERRA = "viirs_n ~ lt + lft + lrt + I(terra_n == 0)" + COMMON         # Terra only (2001-2002, before Aqua)

from patsy import dmatrix
istrain = w.year.isin(TRAIN).values
pre = (w.year < 2003).values                                       # rows that use the Terra-only model
y = w.viirs_n.values
X = {f: np.asarray(dmatrix(f.split("~")[1], w)) for f in (F_FULL, F_TERRA)}   # design matrices built once

def fit(f, rows):
    """Poisson mean model: its score equations make predicted totals match observed totals in training."""
    return sm.GLM(y[rows], X[f][rows], family=sm.families.Poisson()).fit().params

def predict(rows):
    return np.where(pre, np.exp(X[F_TERRA] @ fit(F_TERRA, rows)), np.exp(X[F_FULL] @ fit(F_FULL, rows)))

tr = np.flatnonzero(istrain)
w["mu"] = predict(tr)
mu_t = w.mu.values[tr]
a_full = max(float(np.sum((y[tr] - mu_t) ** 2 - y[tr]) / np.sum(mu_t ** 2)), 1e-3)   # NB dispersion (Cameron-Trivedi)

# intervals: year-block bootstrap of the fit + negative-binomial sampling noise
rows_by_year = {yr: np.flatnonzero(w.year.values == yr) for yr in TRAIN}
sims = []
for b in range(NBOOT):
    mu = predict(np.concatenate([rows_by_year[yr] for yr in rng.choice(list(TRAIN), len(TRAIN))]))
    draw = rng.poisson(mu * rng.gamma(1 / a_full, a_full, len(mu)))
    sims.append(np.bincount(w.year.values - 2001, weights=draw, minlength=25))
lo, hi = np.percentile(np.array(sims), [5, 95], axis=0)
train = w[istrain]

ann = w.groupby("year")[["modis_n", "viirs_n", "mu"]].sum()
ann["lo"], ann["hi"] = lo, hi
ann.loc[ann.index < 2012, "viirs_n"] = np.nan

h = ann.loc[list(HOLD)]
ratio = train.viirs_n.sum() / train.modis_n.sum()                  # naive baseline: one constant factor
score = {
    "mape_model": float((abs(h.mu - h.viirs_n) / h.viirs_n).mean() * 100),
    "mape_ratio": float((abs(h.modis_n * ratio - h.viirs_n) / h.viirs_n).mean() * 100),
    "coverage": int(((h.viirs_n >= h.lo) & (h.viirs_n <= h.hi)).sum()), "n_hold": len(h),
    "ratio": float(ratio), "alpha": a_full,
    "weekly_r": float(np.corrcoef(*w[w.year.isin(HOLD)].groupby(["year", "week"])[["mu", "viirs_n"]].sum().values.T)[0, 1]),
}
print(ann.round(0).to_string()); print(score)

os.makedirs("web", exist_ok=True)
out = {"years": ann.index.tolist(), "modis": ann.modis_n.tolist(),
       "viirs": [None if np.isnan(v) else v for v in ann.viirs_n],
       "pred": ann.mu.round(1).tolist(), "lo": ann.lo.tolist(), "hi": ann.hi.tolist(), "score": score}
open("web/data.js", "w").write("const DATA = " + json.dumps(out) + ";\n")
os.makedirs("site/public/data/portugal", exist_ok=True)
with open("site/public/data/portugal/annual.json", "w", newline="\n") as f:   # same object, plain JSON for the Next.js site
    f.write(json.dumps(out, allow_nan=False) + "\n")
ann.round(1).to_csv("annual_summary.csv")
