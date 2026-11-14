"""Download NASA FIRMS country archives (MODIS C6.1 + VIIRS S-NPP) for one country
and grid them to 0.25 deg cells per day -> fire_grid_daily.csv
Source: https://firms.modaps.eosdis.nasa.gov/country/ (no key needed)."""
import os, urllib.request
import numpy as np, pandas as pd

COUNTRY = "Portugal"
BBOX = (-10.0, 36.9, -6.0, 42.2)  # mainland only (drops Azores/Madeira)
BASE = "https://firms.modaps.eosdis.nasa.gov/data/country"
SRC = {"modis": range(2000, 2026), "viirs-snpp": range(2012, 2026)}
RAW = "data/raw"
os.makedirs(RAW, exist_ok=True)

frames = []
for sensor, years in SRC.items():
    for y in years:
        name = f"{sensor}_{y}_{COUNTRY}.csv"
        path = f"{RAW}/{name}"
        if not os.path.exists(path):
            urllib.request.urlretrieve(f"{BASE}/{sensor}/{y}/{name}", path)
        d = pd.read_csv(path, usecols=["latitude", "longitude", "acq_date", "satellite", "frp", "daynight", "type"])
        frames.append(d)
        print(name, len(d))
df = pd.concat(frames, ignore_index=True)
print("satellites:", df.satellite.value_counts().to_dict(), "| types:", df.type.value_counts().to_dict())

x0, y0, x1, y1 = BBOX
df = df[(df.type == 0) & df.longitude.between(x0, x1) & df.latitude.between(y0, y1)]  # type 0 = presumed vegetation fire
df["lat"] = np.floor(df.latitude / 0.25) * 0.25
df["lon"] = np.floor(df.longitude / 0.25) * 0.25
df["src"] = df.satellite.map({"Terra": "terra", "Aqua": "aqua", "N": "viirs"})
assert df.src.notna().all(), df.satellite.unique()

g = df.groupby(["acq_date", "lat", "lon", "daynight", "src"]).frp.agg(n="size", frp="mean").unstack("src")
out = pd.DataFrame({
    "terra_n": g[("n", "terra")], "aqua_n": g[("n", "aqua")], "viirs_n": g[("n", "viirs")],
    "terra_frp_mean": g[("frp", "terra")], "aqua_frp_mean": g[("frp", "aqua")], "viirs_frp_mean": g[("frp", "viirs")],
}).reset_index().rename(columns={"acq_date": "date"})
for c in ("terra_n", "aqua_n", "viirs_n"):
    out[c] = out[c].fillna(0).astype(int)
out = out.round(2).sort_values(["date", "lat", "lon", "daynight"])
out.to_csv("fire_grid_daily.csv", index=False)
print("rows:", len(out), "| dates:", out.date.min(), "->", out.date.max())
