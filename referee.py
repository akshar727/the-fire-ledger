import argparse, glob, json, os, re

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.abspath(__file__))
CELL = 0.25
BEFORE, AFTER_START, LAST = (2003, 2011), 2013, 2025
NAME = re.compile(r"MCD64CMQ\.A(\d{4})(\d{3})\.(\d{3})\.")
COLLECTION = {"006": "6", "061": "6.1"}


def cell_index(lat, lon):
    row = np.rint((89.75 - np.asarray(lat, float)) / CELL).astype(int)
    col = np.rint((np.asarray(lon, float) + 180) / CELL).astype(int)
    return row, col


def file_month(path):
    m = NAME.search(os.path.basename(path))
    if not m:
        raise ValueError(f"not an MCD64CMQ file name: {path}")
    d = pd.Timestamp(int(m.group(1)), 1, 1) + pd.Timedelta(days=int(m.group(2)) - 1)
    return d.year, d.month, COLLECTION.get(m.group(3), m.group(3))


def region_cells(grid_dir, region_id):
    d = pd.read_csv(os.path.join(grid_dir, f"fire_grid_daily_{region_id}.csv"), usecols=["lat", "lon"])
    return d.drop_duplicates().sort_values(["lat", "lon"]).to_numpy()


def extract(hdf_dir, grid_dir="data/grid", out_csv="data/referee/burned_area.csv", regions_file="regions.json"):
    from pyhdf.SD import SD, SDC
    with open(regions_file, encoding="utf-8") as f:
        ids = [r["id"] for r in json.load(f)]
    idx = {rid: cell_index(*region_cells(grid_dir, rid).T) for rid in ids}
    rows = []
    files = sorted(glob.glob(os.path.join(hdf_dir, "MCD64CMQ.A*.hdf")))
    if not files:
        raise SystemExit(f"no MCD64CMQ.A*.hdf files in {hdf_dir}")
    for f in files:
        yr, mo, coll = file_month(f)
        sd = SD(f, SDC.READ)
        ba = sd.select("BurnedArea").get().astype(float) * 0.01
        um = sd.select("UnmappedFraction").get().astype(float)
        sd.end()
        for rid, (r, c) in idx.items():
            rows.append((rid, yr, mo, round(float(ba[r, c].sum()), 2), round(float(um[r, c].mean()), 3), coll))
    out = pd.DataFrame(rows, columns=["region", "year", "month", "burned_ha", "unmapped_pct", "collection"])
    out = out.sort_values(["region", "year", "month"])
    os.makedirs(os.path.dirname(out_csv), exist_ok=True)
    out.to_csv(out_csv, index=False, lineterminator="\n")
    print(f"{len(files)} files -> {out_csv} ({len(out)} rows)")
    return out


def monthly_records(series):
    m = series["monthly"]
    st = np.array([mo if v is None else v for v, mo in zip(m["viirs"], m["modis"])], float)
    ha = np.array([p if v is None else v for v, p in zip(m["viirs"], m["pred"])], float)
    return m["start_year"], st, ha


def _r(v, nd):
    return None if v is None or not np.isfinite(v) else round(float(v), nd)


def last_full_year(burned):
    n = burned.groupby("year").size()
    full = n[n == 12].index
    if len(full) == 0:
        raise SystemExit("burned_area.csv: a region has no complete year of burned area (re-run `referee.py extract`)")
    return int(min(full.max(), LAST))


def region_check(burned, series, after=None):
    AFTER = after or (AFTER_START, last_full_year(burned))
    y0, st, ha = monthly_records(series)
    n = len(st)
    t = pd.DataFrame({"year": [y0 + i // 12 for i in range(n)], "month": [i % 12 + 1 for i in range(n)],
                      "stitched": st, "harmonized": ha})
    t = t.merge(burned[["year", "month", "burned_ha"]], on=["year", "month"], how="inner")
    yearly = t.groupby("year")[["stitched", "harmonized", "burned_ha"]].sum()
    yearly = yearly[t.groupby("year").size() == 12]
    yearly["burned_km2"] = yearly.burned_ha / 100

    def per1000(rec, span):
        s = yearly.loc[span[0]:span[1]]
        return 1000 * s[rec].sum() / s.burned_km2.sum() if s.burned_km2.sum() > 0 else None

    def corr(rec, span):
        s = t[(t.year >= span[0]) & (t.year <= span[1])]
        return float(np.corrcoef(s[rec], s.burned_ha)[0, 1]) if len(s) > 2 and s.burned_ha.std() > 0 else None

    out = {"burned_km2_per_year": {"before": _r(yearly.loc[BEFORE[0]:BEFORE[1]].burned_km2.mean(), 1),
                                   "after": _r(yearly.loc[AFTER[0]:AFTER[1]].burned_km2.mean(), 1)}}
    for rec in ("stitched", "harmonized"):
        b, a = per1000(rec, BEFORE), per1000(rec, AFTER)
        out[rec] = {"per_1000km2_before": _r(b, 1), "per_1000km2_after": _r(a, 1),
                    "step": _r(a / b, 3) if b and a is not None else None,
                    "monthly_r_before": _r(corr(rec, BEFORE), 3), "monthly_r_after": _r(corr(rec, AFTER), 3)}
    out["yearly"] = {"years": [int(y) for y in yearly.index],
                     "burned_km2": [_r(v, 1) for v in yearly.burned_km2],
                     "stitched": [_r(v, 1) for v in yearly.stitched],
                     "harmonized": [_r(v, 1) for v in yearly.harmonized]}
    return out


def run(burned_csv="data/referee/burned_area.csv", data_dir="site/public/data", regions_file="regions.json",
        out_json=None):
    with open(regions_file, encoding="utf-8") as f:
        ids = [r["id"] for r in json.load(f)]
    ba = pd.read_csv(burned_csv)
    colls = sorted({str(c) for c in ba.get("collection", pd.Series(["6"]))})
    product_short = f"MCD64CMQ Collection {'/'.join(colls)}"
    product = f"{product_short} (MODIS burned area, 0.25 deg monthly)"
    after = (AFTER_START, min(last_full_year(ba[ba.region == rid]) for rid in ids))
    res = {"schema": 1, "product": product, "product_short": product_short,
           "before": list(BEFORE), "after": list(after),
           "note": "detections per 1,000 km2 burned, summed over the model's grid cells; step = after / before",
           "regions": {}}
    for rid in ids:
        with open(os.path.join(data_dir, rid, "series.json"), encoding="utf-8") as f:
            series = json.load(f)
        res["regions"][rid] = region_check(ba[ba.region == rid], series, after)
    out_json = out_json or os.path.join(data_dir, "referee.json")
    tmp = out_json + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(res, f, indent=1, allow_nan=False)
        f.write("\n")
    os.replace(tmp, out_json)
    for rid, r in res["regions"].items():
        print(f"{rid}: stitched step x{r['stitched']['step']}, harmonized step x{r['harmonized']['step']} "
              f"(r before/after: stitched {r['stitched']['monthly_r_before']}/{r['stitched']['monthly_r_after']}, "
              f"harmonized {r['harmonized']['monthly_r_before']}/{r['harmonized']['monthly_r_after']})")
    return res


def main():
    ap = argparse.ArgumentParser(description="MCD64 burned-area referee for the back-cast (ML-019).")
    ap.add_argument("cmd", nargs="?", default="check", choices=["check", "extract"])
    ap.add_argument("hdf_dir", nargs="?", help="folder with MCD64CMQ .hdf files (extract only)")
    a = ap.parse_args()
    hdf_dir = os.path.abspath(a.hdf_dir) if a.hdf_dir else None
    os.chdir(ROOT)
    if a.cmd == "extract":
        if not hdf_dir:
            ap.error("extract needs the folder of MCD64CMQ .hdf files")
        extract(hdf_dir)
    else:
        run()


if __name__ == "__main__":
    main()
