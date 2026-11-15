"""Peak fire day per month (DP-016): site/public/data/<region>/peaks.json, so the site knows which day's NASA
satellite image to show for a month.

Raw daily detections (not harmonized), summed over all cells and both day/night rows. Sensor counted per day:
MODIS (terra_n + aqua_n) before VIIRS_START, VIIRS S-NPP (viirs_n) from VIIRS_START through the region's
archive_through (manifest.json), NOAA-20 (n20_n) after archive_through through sensors.n20.data_through.
Months run from 2001-01 to the month of the last day with data. Ties: the earliest date wins.

Run from the repo root:
    python peaks.py [region_id ...]        (default: every region in regions.json)
"""
import json
import os
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent
VIIRS_START = pd.Timestamp("2012-01-20")   # same as model.VIIRS_START (not imported: model.py pulls in statsmodels)
START_MONTH = "2001-01"
SENSORS = ("modis", "snpp", "noaa20")
COUNTS_NOTE = ("raw daily detections, not harmonized; sensor per day: MODIS (Terra+Aqua) before %s, "
               "VIIRS S-NPP from then to %s, NOAA-20 after. In the two transition months (the month of the S-NPP "
               "start, and the month of the S-NPP end) days from different sensors are ranked against each other.")


def write_json(path, obj):
    """Atomic (temp file + rename), LF endings, no NaN (same as model.write_json)."""
    with open(str(path) + ".part", "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(obj, allow_nan=False, separators=(",", ":")) + "\n")
    os.replace(str(path) + ".part", path)


def daily_counts(grid, archive_through, n20_through):
    """DataFrame indexed by date: count, sensor, for every day with a counted sensor in range (days may be 0).
    Ends at the later of archive_through and n20_through (S-NPP days are kept if NOAA-20 ends earlier)."""
    archive_through, n20_through = pd.Timestamp(archive_through), pd.Timestamp(n20_through)
    end = max(archive_through, n20_through)
    g = grid.copy()
    g["date"] = pd.to_datetime(g["date"])
    for c in ("terra_n", "aqua_n", "viirs_n", "n20_n"):
        g[c] = g[c].fillna(0)
    d = g.groupby("date")[["terra_n", "aqua_n", "viirs_n", "n20_n"]].sum()
    # every calendar day up to the last day with data, so empty days exist as 0 (and zero months are not holes)
    d = d.reindex(pd.date_range(pd.Timestamp(START_MONTH + "-01"), end, freq="D"), fill_value=0)
    idx = d.index
    modis = idx < VIIRS_START
    snpp = (idx >= VIIRS_START) & (idx <= archive_through)
    out = pd.DataFrame(index=idx)
    out["count"] = (d["terra_n"] + d["aqua_n"]).where(modis, d["viirs_n"].where(snpp, d["n20_n"])).astype(int)
    out["sensor"] = ["modis" if m else "snpp" if s else "noaa20" for m, s in zip(modis, snpp)]
    return out


def build_peaks(region, grid, archive_through, n20_through=None):
    """n20_through None (no NOAA-20 data) means the record ends at archive_through."""
    n20_through = n20_through or archive_through
    daily = daily_counts(grid, archive_through, n20_through)
    last = daily.index[-1]
    snpp_from = VIIRS_START.strftime("%Y-%m-%d")
    months, partial = [], []
    for (y, m), df in daily.groupby([daily.index.year, daily.index.month]):
        # highest count first, earliest date on ties
        df = df[df["count"] > 0].reset_index().rename(columns={"index": "date"})
        df = df.sort_values(["count", "date"], ascending=[False, True], kind="stable").head(3)
        top3 = [[r.date.day, int(r.count), SENSORS.index(r.sensor)] for r in df.itertuples()]
        months.append({"month": "%04d-%02d" % (y, m), "peak": top3[0] if top3 else None, "top3": top3})
        if last < pd.Timestamp(y, m, 1) + pd.offsets.MonthEnd(0):
            partial.append(months[-1]["month"])
    return {"schema": 1, "region": region, "counts": COUNTS_NOTE % (snpp_from, archive_through), "start": START_MONTH,
            "snpp_from": snpp_from, "snpp_through": archive_through,
            "noaa20_through": n20_through if pd.Timestamp(n20_through) > pd.Timestamp(archive_through) else None,
            "last_day": last.strftime("%Y-%m-%d"), "partial_months": partial, "sensors": list(SENSORS),
            "entry": "[day of month, count, index into sensors]; peak is top3[0] or null; top3 is empty for a month "
                     "with no detections; ties: earliest date first",
            "months": months}


def run(region, grid_dir, out_dir):
    manifest = json.loads((Path(grid_dir) / "manifest.json").read_text())[region]
    grid = pd.read_csv(Path(grid_dir) / ("fire_grid_daily_%s.csv" % region),
                       usecols=["date", "terra_n", "aqua_n", "viirs_n", "n20_n"])
    n20 = (manifest["sensors"].get("n20") or {}).get("data_through")   # absent or null: region has no NOAA-20 data
    res = build_peaks(region, grid, manifest["archive_through"], n20)
    path = Path(out_dir) / region / "peaks.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    write_json(path, res)
    return path, len(res["months"])


def main(argv):
    regions = [r["id"] for r in json.loads((ROOT / "regions.json").read_text())]
    ids = argv or regions
    for r in ids:
        if r not in regions:
            sys.exit("unknown region %r (known: %s)" % (r, ", ".join(regions)))
    for r in ids:
        path, n = run(r, ROOT / "data" / "grid", ROOT / "site" / "public" / "data")
        print("%s: %d months, %.1f KB -> %s" % (r, n, path.stat().st_size / 1024, path.relative_to(ROOT)))


if __name__ == "__main__":
    main(sys.argv[1:])
