"""Per-cell monthly totals (ML-018): site/public/data/<region>/cells.json, the input of the draw-your-area map.

model.py calls `cells_bundle` from `run` with the per-row arrays it already has (cell, kept week, MODIS, S-NPP, model
mean); nothing here refits anything. Each cell's weekly sums are split over calendar months with the same day-share
rule as series.json `monthly` (`month_shares`, a copy of the matrix in model.series_bundle: tests/test_cells.py checks
that the cell sums give back series.json), so summing any set of cells gives that area's monthly series.

Back-cast only: the forward link (ML-017) is fitted on region totals, so it has no per-cell values. The months end at
the last whole month on or before `through` (the S-NPP archive end), never in a forward month.

Values are stored as integers `round(value * scale)` (value = int / scale) in flat arrays, cell c and month m at
`c * n_months + m`. The monthly values are fractional (a week that straddles two months is split by days), so plain
integer counts would not sum back to series.json; scale 100 keeps the sum of n cells within n * 0.005 of it.

For site/lib/area.ts `sumCells` (FE-011): divide by `scale`; read `viirs` as null for months < `viirs_from` (stored
0 there, while a 0 from `viirs_from` on is a real zero); `n_months` can be one shorter than series.json monthly (a
forward partial month), so pass `monthly.source.slice(0, n_months)` and leave out `last_month_days` (every cell
month is a whole month).
"""
import numpy as np
import pandas as pd

SCALE = 100


def month_index(t):
    return (t.year - 2001) * 12 + t.month - 1


def month_shares(weeks, through, nm):
    """(n_weeks x nm) matrix: week k's value goes to month i by the share of its days with data (days up to `through`)
    in month i. Same as model.series_bundle's S."""
    through = pd.Timestamp(through)
    S = np.zeros((len(weeks), nm))
    for k, (yr, wk) in enumerate(weeks):
        start = pd.Timestamp(yr, 1, 1) + pd.Timedelta(days=7 * wk)
        end = pd.Timestamp(yr, 12, 31) if wk == 51 else start + pd.Timedelta(days=6)
        days = pd.date_range(start, min(end, through))
        for dt in days:
            if (i := month_index(dt)) < nm:
                S[k, i] += 1 / len(days)
    return S


def cells_bundle(region_id, lat, lon, widx, weeks, through, modis, viirs, pred, alpha, sigma_year, viirs_start,
                 cell_deg=0.25):
    """cells.json content. lat/lon/widx/modis/viirs/pred: one entry per model row (cell x day/night x kept week);
    widx = row -> index into `weeks` (the kept back-cast weeks, ending at `through`)."""
    through = pd.Timestamp(through)
    nm = month_index(through) + (1 if through.is_month_end else 0)
    nw = len(weeks)
    keys = pd.MultiIndex.from_arrays([np.asarray(lat), np.asarray(lon)])
    codes, uniq = pd.factorize(keys, sort=True)                 # cells sorted by lat, then lon
    nc = len(uniq)
    flat = codes.astype(np.int64) * nw + np.asarray(widx)
    S = month_shares(weeks, through, nm)

    def per_cell_month(v):
        cw = np.bincount(flat, weights=np.asarray(v, float), minlength=nc * nw).reshape(nc, nw)
        return cw @ S                                           # (n_cells, n_months)

    as_int = lambda a: [int(x) for x in np.rint(a * SCALE).astype(np.int64).ravel()]
    mstarts = [pd.Timestamp(2001 + i // 12, i % 12 + 1, 1) for i in range(nm)]
    viirs_from = next(i for i, s in enumerate(mstarts) if s >= viirs_start)
    v = per_cell_month(viirs)
    v[:, :viirs_from] = 0                                       # no S-NPP yet: read as null, stored as 0
    return {
        "schema": 2, "region": region_id, "cell_deg": cell_deg, "scale": SCALE,
        "start_year": 2001, "n_months": nm, "viirs_from": viirs_from,
        "data_through": through.strftime("%Y-%m-%d"),
        "alpha": float(alpha), "sigma_year": float(sigma_year),
        "lat": [float(a) for a, _ in uniq], "lon": [float(b) for _, b in uniq],
        "modis": as_int(per_cell_month(modis)), "viirs": as_int(v), "pred": as_int(per_cell_month(pred)),
    }
