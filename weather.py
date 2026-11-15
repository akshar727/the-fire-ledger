"""Monthly fire-weather index per region from NASA POWER (DP-014).

For each region in regions.json: pick up to 9 points (the fire-weighted centre of each ninth of the
bbox), fetch NASA POWER daily data for each point (no key), cache it under data/raw/power/<id>/, and
write site/public/data/<id>/weather.json: monthly regional means and a fire-weather index turned into
a percentile within each calendar month.

Index, per day and point (kept simple so the page can explain it in one sentence):
    vpd   = es(T2M_MAX) * (1 - RH2M / 100)            vapour-pressure deficit, kPa (Tetens)
    index = vpd * WS10M / (1 + rain30 / RAIN_HALF_MM)  rain30 = rain of the last 30 days, mm
i.e. hot, dry air times wind, halved after RAIN_HALF_MM of rain in the past 30 days; monthly mean.
A second, simpler measure, vpd_peak7, is the month's highest 7-day mean VPD (its worst heat/dryness
spell): calm heat waves such as Portugal's 1-14 Aug 2003 score low on the index (little wind, a
cool wet end of month) but top on vpd_peak7 (human decision, Sai, 2026-11-15: ship both).
GWETTOP (soil wetness) is exported for context only. Nothing here feeds model.py.

Usage: python weather.py [region_id ...] [--refresh]   (no ids = all regions; runs from any folder)
Source: https://power.larc.nasa.gov/docs/services/api/temporal/daily/ (POWER Daily API, MERRA-2)."""
import argparse, http.client, io, json, os, time, urllib.error, urllib.request
from datetime import date, datetime, timedelta, timezone
import numpy as np, pandas as pd

API = "https://power.larc.nasa.gov/api/temporal/daily/point"
PARAMS = ["T2M_MAX", "RH2M", "PRECTOTCORR", "WS10M", "GWETTOP"]
FETCH_START = date(2000, 12, 1)   # 30 days before 2001 so January 2001 has a full rain window
START_YEAR = 2001
RAIN_DAYS = 30
RAIN_HALF_MM = 25.0   # 25 mm of rain in the last 30 days halves the index
PEAK_DAYS = 7         # vpd_peak7: worst 7-day spell of the month
COVER_SLACK_DAYS = 10   # a fetched file must reach within this many days of the requested end
FILL = -999.0
GRID = "data/grid/fire_grid_daily_{id}.csv"
RAW = "data/raw/power/{id}"
OUT = "site/public/data/{id}/weather.json"
SPLIT = 3   # 3 x 3 lattice


class FetchError(Exception):
    pass


def lattice(bbox, cells, split=SPLIT):
    """Up to split*split points: for each tile of the bbox, the detection-weighted centre of the grid
    cells in it. cells: DataFrame lat, lon (south-west corners), n (detections). Tiles without fire
    are dropped. Returns [{lat, lon, weight}] with weights summing to 1, south-to-north, west-to-east."""
    w, s, e, n = bbox
    c = cells.assign(clat=cells.lat + 0.125, clon=cells.lon + 0.125)
    c = c[(c.n > 0) & (c.clon >= w) & (c.clon < e) & (c.clat >= s) & (c.clat < n)]
    if c.empty:
        raise SystemExit("weather.py: no fire cells inside the bbox, cannot place lattice points")
    ti = np.minimum(((c.clat - s) / (n - s) * split).astype(int), split - 1)
    tj = np.minimum(((c.clon - w) / (e - w) * split).astype(int), split - 1)
    total = c.n.sum()
    pts = []
    for (i, j), g in c.groupby([ti, tj], sort=True):
        wt = g.n / g.n.sum()
        pts.append({"lat": round(float((g.clat * wt).sum()), 2), "lon": round(float((g.clon * wt).sum()), 2),
                    "weight": float(g.n.sum() / total)})
    return pts


def fire_cells(region_id, grid=GRID):
    """Detections per 0.25 deg cell from the committed grid (MODIS + S-NPP, all days)."""
    g = pd.read_csv(grid.format(id=region_id), usecols=["lat", "lon", "terra_n", "aqua_n", "viirs_n"])
    g["n"] = g.terra_n + g.aqua_n + g.viirs_n
    return g.groupby(["lat", "lon"], as_index=False).n.sum()


def url_for(lat, lon, end):
    return (f"{API}?parameters={','.join(PARAMS)}&community=AG&longitude={lon}&latitude={lat}"
            f"&start={FETCH_START:%Y%m%d}&end={end:%Y%m%d}&format=CSV")


def http_get(url, attempts=4, opener=urllib.request.urlopen):
    err = None
    for i in range(attempts):
        try:
            with opener(url, timeout=180) as r:
                body = r.read()
                if r.length:   # urllib does not raise on a short body (data-pipeline pitfall)
                    raise FetchError("truncated response")
                return body.decode("utf-8")
        except urllib.error.HTTPError as e:
            err = f"HTTP {e.code}"
            if 400 <= e.code < 500 and e.code not in (408, 429):
                raise FetchError(f"POWER API answered {err}") from None
        except (urllib.error.URLError, http.client.HTTPException, TimeoutError, ConnectionError, FetchError) as e:
            # http.client.IncompleteRead (a short body) is an HTTPException
            err = type(e).__name__
        if i < attempts - 1:
            time.sleep(3 * (i + 1))
    raise FetchError(f"POWER API request failed after {attempts} attempts ({err})")


def parse(text):
    """POWER daily CSV (with its -BEGIN HEADER- block) -> DataFrame indexed by date, FILL -> NaN."""
    body = text.split("-END HEADER-", 1)[-1].lstrip()
    df = pd.read_csv(io.StringIO(body))
    missing = [c for c in ["YEAR", "DOY"] + PARAMS if c not in df.columns]
    if missing:
        raise FetchError(f"POWER CSV lacks columns {missing}")
    idx = pd.to_datetime(df.YEAR.astype(str), format="%Y") + pd.to_timedelta(df.DOY - 1, unit="D")
    out = df[PARAMS].set_axis(idx).rename_axis("date").astype(float)
    return out.where(out > FILL + 1)


def point_file(region_id, k, p, raw=RAW):
    return os.path.join(raw.format(id=region_id), f"p{k}_{p['lat']:.2f}_{p['lon']:.2f}.csv")


def load_point(region_id, k, p, end, refresh=False, get=http_get, raw=RAW, log=print):
    path = point_file(region_id, k, p, raw)
    if refresh or not os.path.exists(path):
        end = end or yesterday_utc()
        text = get(url_for(p["lat"], p["lon"], end))
        d = parse(text)   # validate before caching: a short answer would be cached for good
        if d.empty or d.index[0] != pd.Timestamp(FETCH_START) or d.index[-1] < pd.Timestamp(end) - pd.Timedelta(days=COVER_SLACK_DAYS):
            raise FetchError(f"POWER answer for point {k} does not cover {FETCH_START} .. {end}")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path + ".part", "w", encoding="utf-8", newline="\n") as f:
            f.write(text.replace("\r\n", "\n"))
        os.replace(path + ".part", path)
        log(f"  fetched {os.path.basename(path)}")
    with open(path, encoding="utf-8") as f:
        return parse(f.read())


def vpd_kpa(t_c, rh):
    """Vapour-pressure deficit (kPa) from temperature (C) and relative humidity (%), Tetens formula."""
    es = 0.6108 * np.exp(17.27 * t_c / (t_c + 237.3))
    return np.clip(es * (1 - rh / 100.0), 0, None)


def daily_index(d):
    """d: daily frame with PARAMS -> adds vpd, rain30, index. rain30 is NaN for the first 29 days."""
    d = d.copy()
    d["vpd"] = vpd_kpa(d.T2M_MAX, d.RH2M)
    d["rain30"] = d.PRECTOTCORR.rolling(RAIN_DAYS, min_periods=RAIN_DAYS).sum()
    d["index"] = d.vpd * d.WS10M / (1 + d.rain30 / RAIN_HALF_MM)
    return d


def peak7(reg):
    """Highest 7-day mean VPD ending in each month (the month's worst heat/dryness spell), kPa."""
    v = reg.vpd.reindex(pd.date_range(reg.index[0], reg.index[-1], freq="D"))   # a gap must not stretch a window
    s = v.rolling(PEAK_DAYS, min_periods=PEAK_DAYS).mean().dropna()
    return s.groupby([s.index.year, s.index.month]).max()


def regional(points, frames):
    """Weighted mean over points, per day, of each daily variable. A day counts only if every point
    has it; trailing days missing anywhere are dropped."""
    cols = PARAMS + ["vpd", "index"]
    wts = np.array([p["weight"] for p in points])
    stack = np.stack([f[cols].to_numpy() for f in frames])          # point x day x var
    ok = ~np.isnan(stack).any(axis=0)                                  # day x var
    mean = np.einsum("p,pdv->dv", wts, np.nan_to_num(stack))
    out = pd.DataFrame(np.where(ok, mean, np.nan), index=frames[0].index, columns=cols)
    return out[out.index >= pd.Timestamp(START_YEAR, 1, 1)]


def percentile_within_month(values, months, complete):
    """Percent of complete same-calendar-month values below x (ties count half), 0-100, 1 decimal.
    values, months (1-12), complete (bool) are equal-length arrays; NaN values give None."""
    values, months, complete = np.asarray(values, float), np.asarray(months), np.asarray(complete, bool)
    out = []
    for v, m in zip(values, months):
        ref = values[(months == m) & complete & ~np.isnan(values)]
        if np.isnan(v) or ref.size == 0:
            out.append(None)
            continue
        out.append(round(float(100 * ((ref < v).sum() + 0.5 * (ref == v).sum()) / ref.size), 1))
    return out


def monthly(reg):
    """Daily regional frame -> monthly arrays (through the last month with any complete day)."""
    reg = reg.dropna(subset=["index"])
    if reg.empty:
        raise SystemExit("weather.py: no complete day of POWER data")
    through = reg.index[-1]
    grp = reg.groupby([reg.index.year, reg.index.month])
    m = grp.mean()
    m["PRECTOTCORR"] = grp.PRECTOTCORR.sum()
    m["days"] = grp.size()
    m["vpd_peak7"] = peak7(reg)
    full = pd.MultiIndex.from_tuples([(y, mo) for y in range(START_YEAR, through.year + 1)
                                      for mo in range(1, 13) if (y, mo) <= (through.year, through.month)])
    m = m.reindex(full)
    dim = np.array([pd.Period(f"{y}-{mo:02d}").days_in_month for y, mo in full])
    complete = (m.days.to_numpy() == dim)
    months = np.array([mo for _, mo in full])
    return m, through, complete, months


def r(x, nd):
    return [None if pd.isna(v) else round(float(v), nd) for v in x]


def bundle(region_id, points, m, through, complete, months):
    last_days = int(m.days.iloc[-1]) if not pd.isna(m.days.iloc[-1]) else 0
    return {
        "schema": 1,
        "region": region_id,
        "source": "NASA POWER Daily API (MERRA-2), community AG, https://power.larc.nasa.gov/",
        "points": points,
        "index_def": ("vpd_kpa * ws10m / (1 + rain30_mm / %g); vpd from T2M_MAX and RH2M (Tetens); "
                      "rain30 = PRECTOTCORR over the last %d days; weighted mean over points, then monthly mean"
                      % (RAIN_HALF_MM, RAIN_DAYS)),
        "through": through.strftime("%Y-%m-%d"),
        "monthly": {
            "start_year": START_YEAR,
            "t2m_max_c": r(m.T2M_MAX, 2),
            "rh2m_pct": r(m.RH2M, 1),
            "precip_mm": r(m.PRECTOTCORR, 1),
            "ws10m_ms": r(m.WS10M, 2),
            "gwettop": r(m.GWETTOP, 3),
            "vpd_kpa": r(m.vpd, 3),
            "index": r(m["index"], 3),
            "pctl": percentile_within_month(m["index"].to_numpy(), months, complete),
            "vpd_peak7_kpa": r(m.vpd_peak7, 3),
            "pctl_peak7": percentile_within_month(m.vpd_peak7.to_numpy(), months, complete),
            "last_month_days": last_days,
            "last_month_complete": bool(complete[-1]),
        },
    }


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".part", "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(obj, indent=2, allow_nan=False, ensure_ascii=False) + "\n")
    os.replace(path + ".part", path)


def yesterday_utc():
    return (datetime.now(timezone.utc) - timedelta(days=1)).date()


def run_region(region, refresh=False, get=http_get, end=None, log=print):
    rid = region["id"]
    points = lattice(region["bbox"], fire_cells(rid))
    log(f"{rid}: {len(points)} points")
    end = end or yesterday_utc()
    frames = []
    for k, p in enumerate(points):
        frames.append(daily_index(load_point(rid, k, p, end, refresh=refresh, get=get, log=log)))
    common = frames[0].index
    for f in frames[1:]:
        common = common.intersection(f.index)
    frames = [f.reindex(common) for f in frames]
    m, through, complete, months = monthly(regional(points, frames))
    write_json(OUT.format(id=rid), bundle(rid, points, m, through, complete, months))
    log(f"{rid}: weather.json through {through:%Y-%m-%d} ({len(m)} months)")


def main(argv=None):
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("regions", nargs="*")
    ap.add_argument("--refresh", action="store_true", help="re-fetch cached POWER files (to extend to yesterday)")
    a = ap.parse_args(argv)
    with open("regions.json", encoding="utf-8") as f:
        regions = json.load(f)
    ids = [x["id"] for x in regions]
    unknown = [x for x in a.regions if x not in ids]
    if unknown:
        raise SystemExit(f"unknown region(s): {unknown}; known: {ids}")
    for region in regions:
        if not a.regions or region["id"] in a.regions:
            run_region(region, refresh=a.refresh)


if __name__ == "__main__":
    main()
