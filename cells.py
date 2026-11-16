import numpy as np
import pandas as pd

SCALE = 100


def month_index(t):
    return (t.year - 2001) * 12 + t.month - 1


def month_shares(weeks, through, nm):
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
    through = pd.Timestamp(through)
    nm = month_index(through) + (1 if through.is_month_end else 0)
    nw = len(weeks)
    keys = pd.MultiIndex.from_arrays([np.asarray(lat), np.asarray(lon)])
    codes, uniq = pd.factorize(keys, sort=True)
    nc = len(uniq)
    flat = codes.astype(np.int64) * nw + np.asarray(widx)
    S = month_shares(weeks, through, nm)

    def per_cell_month(v):
        cw = np.bincount(flat, weights=np.asarray(v, float), minlength=nc * nw).reshape(nc, nw)
        return cw @ S

    as_int = lambda a: [int(x) for x in np.rint(a * SCALE).astype(np.int64).ravel()]
    mstarts = [pd.Timestamp(2001 + i // 12, i % 12 + 1, 1) for i in range(nm)]
    viirs_from = next(i for i, s in enumerate(mstarts) if s >= viirs_start)
    v = per_cell_month(viirs)
    v[:, :viirs_from] = 0
    return {
        "schema": 2, "region": region_id, "cell_deg": cell_deg, "scale": SCALE,
        "start_year": 2001, "n_months": nm, "viirs_from": viirs_from,
        "data_through": through.strftime("%Y-%m-%d"),
        "alpha": float(alpha), "sigma_year": float(sigma_year),
        "lat": [float(a) for a, _ in uniq], "lon": [float(b) for _, b in uniq],
        "modis": as_int(per_cell_month(modis)), "viirs": as_int(v), "pred": as_int(per_cell_month(pred)),
    }
