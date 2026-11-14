"""Download NASA FIRMS country archives (MODIS C6.1 + VIIRS S-NPP) for one country
and grid them to 0.25 deg cells per day -> fire_grid_daily.csv
Source: https://firms.modaps.eosdis.nasa.gov/country/ (no key needed)."""
import os, time, urllib.error, urllib.request
import numpy as np, pandas as pd

COUNTRY = "Portugal"
BBOX = (-10.0, 36.9, -6.0, 42.2)  # mainland only (drops Azores/Madeira)
BASE = "https://firms.modaps.eosdis.nasa.gov/data/country"
SRC = {"modis": range(2000, 2026), "viirs-snpp": range(2012, 2026)}
RAW = "data/raw"
COLS = ["latitude", "longitude", "acq_date", "satellite", "frp", "daynight", "type"]
SAT = {"Terra": "terra", "Aqua": "aqua", "N": "viirs"}  # NOAA-20/21 intentionally not mapped
os.makedirs(RAW, exist_ok=True)


def header_missing(path):
    """Return the required columns absent from the CSV header line of `path`."""
    with open(path, encoding="utf-8-sig", errors="replace") as f:
        have = {c.strip().strip('"') for c in f.readline().split(",")}
    return [c for c in COLS if c not in have]


def download(url, path, attempts=3):
    """Download to path + '.part', check it is complete and has the header, then move it to path.
    timeout=60 applies to each network read, not to the whole download.
    HTTP 4xx (e.g. a year FIRMS hasn't published) fails at once, except 408/429; other errors are retried."""
    tmp = path + ".part"
    err = None
    try:
        for i in range(attempts):
            try:
                with urllib.request.urlopen(url, timeout=60) as r, open(tmp, "wb") as f:
                    while chunk := r.read(1 << 16):
                        f.write(chunk)
                    if r.length:  # server closed early: bytes promised by Content-Length never arrived
                        raise OSError(f"truncated download: {r.length} bytes missing")
                missing = header_missing(tmp)
                if missing:
                    raise ValueError(f"missing columns {missing}")
                os.replace(tmp, path)
                return
            except urllib.error.HTTPError as e:
                if 400 <= e.code < 500 and e.code not in (408, 429):  # 408/429 are temporary: retry
                    raise RuntimeError(f"Could not download {os.path.basename(path)} from {url}: {e}") from e
                err = e
            except Exception as e:
                err = e
            if i < attempts - 1:
                time.sleep(2 * (i + 1))
    finally:
        if os.path.exists(tmp):  # also on Ctrl+C
            os.remove(tmp)
    raise RuntimeError(f"Could not download {os.path.basename(path)} from {url} after {attempts} attempts: {err}")


frames = []
for sensor, years in SRC.items():
    for y in years:
        name = f"{sensor}_{y}_{COUNTRY}.csv"
        path = f"{RAW}/{name}"
        if not os.path.exists(path):
            download(f"{BASE}/{sensor}/{y}/{name}", path)
        missing = header_missing(path)
        if missing:
            raise SystemExit(f"{path} is missing columns {missing}; delete that file and re-run.")
        d = pd.read_csv(path, usecols=COLS, dtype={"satellite": str})
        frames.append(d)
        print(name, len(d))
df = pd.concat(frames, ignore_index=True)
print("satellites:", df.satellite.value_counts().to_dict(), "| types:", df.type.value_counts().to_dict())

x0, y0, x1, y1 = BBOX
df = df[(df.type == 0) & df.longitude.between(x0, x1) & df.latitude.between(y0, y1)]  # type 0 = presumed vegetation fire
df["lat"] = np.floor(df.latitude / 0.25) * 0.25
df["lon"] = np.floor(df.longitude / 0.25) * 0.25
unknown = sorted(set(df.satellite.dropna()) - set(SAT)) + (["NaN"] if df.satellite.isna().any() else [])
if unknown:
    raise ValueError(f"Unknown satellite value(s): {unknown}; expected one of {sorted(SAT)}")
df["src"] = df.satellite.map(SAT)

g = df.groupby(["acq_date", "lat", "lon", "daynight", "src"]).frp.agg(n="size", frp="mean").unstack("src")
out = pd.DataFrame({
    "terra_n": g[("n", "terra")], "aqua_n": g[("n", "aqua")], "viirs_n": g[("n", "viirs")],
    "terra_frp_mean": g[("frp", "terra")], "aqua_frp_mean": g[("frp", "aqua")], "viirs_frp_mean": g[("frp", "viirs")],
}).reset_index().rename(columns={"acq_date": "date"})
for c in ("terra_n", "aqua_n", "viirs_n"):
    out[c] = out[c].fillna(0).astype(int)
out = out.round(2).sort_values(["date", "lat", "lon", "daynight"])
out.to_csv("fire_grid_daily.csv", index=False, lineterminator="\n")
print("rows:", len(out), "| dates:", out.date.min(), "->", out.date.max())
