"""Download NASA FIRMS country archives (MODIS C6.1 + VIIRS S-NPP) for each region in
regions.json and grid them to 0.25 deg cells per day -> data/grid/fire_grid_daily_<id>.csv,
plus data/grid/manifest.json and site/public/data/index.json.
Usage: python build.py [region_id ...]   (no ids = all regions)
Source: https://firms.modaps.eosdis.nasa.gov/country/ (no key needed)."""
import argparse, json, os, re, time, urllib.error, urllib.request
import numpy as np, pandas as pd

BASE = "https://firms.modaps.eosdis.nasa.gov/data/country"
SRC = {"modis": range(2000, 2026), "viirs-snpp": range(2012, 2026)}
RAW = "data/raw"
GRID = "data/grid"
INDEX = "site/public/data/index.json"
COLS = ["latitude", "longitude", "acq_date", "satellite", "frp", "daynight", "type"]
SAT = {"Terra": "terra", "Aqua": "aqua", "N": "viirs"}  # NOAA-20/21 intentionally not mapped
CELL_DEG = 0.25


def header_missing(path, cols=COLS):
    """Return the required columns absent from the CSV header line of `path`."""
    with open(path, encoding="utf-8-sig", errors="replace") as f:
        have = {c.strip().strip('"') for c in f.readline().split(",")}
    return [c for c in cols if c not in have]


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
                with open(tmp, "rb") as f:  # no Content-Length: a complete CSV ends with a newline
                    f.seek(0, os.SEEK_END)
                    last = b""
                    if f.tell():
                        f.seek(-1, os.SEEK_END)
                        last = f.read(1)
                if last != b"\n":
                    raise OSError("truncated download: file does not end with a newline")
                missing = header_missing(tmp)
                if missing:
                    raise ValueError(f"missing columns {missing}")
                os.replace(tmp, path)
                return
            except urllib.error.HTTPError as e:
                if 400 <= e.code < 500 and e.code not in (408, 429):  # 408/429 are temporary: retry
                    raise SystemExit(f"Could not download {os.path.basename(path)} from {url}: {e}") from e
                err = e
            except Exception as e:
                err = e
            if i < attempts - 1:
                time.sleep(2 * (i + 1))
    finally:
        if os.path.exists(tmp):  # also on Ctrl+C
            os.remove(tmp)
    raise SystemExit(f"Could not download {os.path.basename(path)} from {url} after {attempts} attempts: {err}")


def load_region(region):
    """Download (if missing) and read all yearly files for a region; keep type 0 detections inside its bbox.
    Points are kept if west <= lon < east and south <= lat < north. Edge cells may extend slightly outside
    the bbox when an edge is not a multiple of CELL_DEG (Portugal's 36.9 and 42.2).
    Returns (filtered detections, archive_through): archive_through is the latest acq_date in any of the
    country's files before filtering, i.e. how far the downloaded archive reaches."""
    country = region["country"]
    x0, y0, x1, y1 = region["bbox"]

    def fetch(sensor, y):
        name = f"{sensor}_{y}_{country}.csv"
        path = f"{RAW}/{name}"
        if not os.path.exists(path):
            download(f"{BASE}/{sensor}/{y}/{name}", path)
        missing = header_missing(path)
        if missing:
            raise SystemExit(f"{path} is missing columns {missing}; delete that file and re-run.")
        return name, path

    _, probe = fetch("modis", 2012)  # fail early (bad country name, no network) before the full loop
    print(f"probe {probe}: {os.path.getsize(probe)} bytes")
    frames, archive_through = [], None
    for sensor, years in SRC.items():
        for y in years:
            name, path = fetch(sensor, y)
            try:
                d = pd.read_csv(path, usecols=COLS, dtype={"satellite": str})
            except (pd.errors.ParserError, ValueError, UnicodeDecodeError) as e:
                raise SystemExit(f"{path} could not be read ({e}); delete that file and re-run.") from e
            if d.acq_date.notna().any():
                archive_through = max(archive_through or "", str(d.acq_date.max()))
            d = d[(d.type == 0)
                  & d.longitude.between(x0, x1, inclusive="left")
                  & d.latitude.between(y0, y1, inclusive="left")]  # type 0 = presumed vegetation fire
            frames.append(d)
            print(name, len(d))
    df = pd.concat(frames, ignore_index=True)
    print("satellites:", df.satellite.value_counts().to_dict())
    unknown = sorted(set(df.satellite.dropna()) - set(SAT)) + (["NaN"] if df.satellite.isna().any() else [])
    if unknown:
        raise ValueError(f"Unknown satellite value(s): {unknown}; expected one of {sorted(SAT)}")
    return df, archive_through


def grid(df):
    """Aggregate detections to CELL_DEG cells per day, day/night and sensor."""
    df = df.copy()
    df["lat"] = np.floor(df.latitude / CELL_DEG) * CELL_DEG
    df["lon"] = np.floor(df.longitude / CELL_DEG) * CELL_DEG
    df["src"] = df.satellite.map(SAT)
    g = df.groupby(["acq_date", "lat", "lon", "daynight", "src"]).frp.agg(n="size", frp="mean").unstack("src")
    g = g.reindex(columns=pd.MultiIndex.from_product([["n", "frp"], ["terra", "aqua", "viirs"]]))  # a sensor may be absent
    out = pd.DataFrame({
        "terra_n": g[("n", "terra")], "aqua_n": g[("n", "aqua")], "viirs_n": g[("n", "viirs")],
        "terra_frp_mean": g[("frp", "terra")], "aqua_frp_mean": g[("frp", "aqua")], "viirs_frp_mean": g[("frp", "viirs")],
    }).reset_index().rename(columns={"acq_date": "date"})
    for c in ("terra_n", "aqua_n", "viirs_n"):
        out[c] = out[c].fillna(0).astype(int)
    return out.round(2).sort_values(["date", "lat", "lon", "daynight"]).reset_index(drop=True)


def coverage(df, out, archive_through):
    """Per sensor: first/last DETECTION date and count, from the filtered detections. last_date is the
    last day a fire was detected, not the end of the data (a quiet month has no rows).
    archive_through: how far the downloaded archive reaches (latest acq_date in the raw files)."""
    src = df.satellite.map(SAT)
    sensors = {}
    for s in ("terra", "aqua", "viirs"):
        dates = df.acq_date[src == s]
        sensors[s] = {
            "first_date": str(dates.min()) if len(dates) else None,
            "last_date": str(dates.max()) if len(dates) else None,
            "detections": int(len(dates)),
        }
    return {"archive_through": archive_through, "sensors": sensors, "grid_rows": int(len(out))}


def write_json(path, obj):
    """Write JSON atomically (temp file + rename), UTF-8, LF, no NaN."""
    tmp = path + ".part"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(obj, indent=2, allow_nan=False, ensure_ascii=False) + "\n")
    os.replace(tmp, path)


def write_index(regions, manifest):
    """site/public/data/index.json. data_through = how far the archive reaches (archive_through).
    point_years / point_rows belong to DP-004 (point export): values already in the index are kept."""
    old = {}
    if os.path.exists(INDEX):
        with open(INDEX, encoding="utf-8") as f:
            old = {e["id"]: e for e in json.load(f).get("regions", [])}
    entries = []
    for r in regions:
        m = manifest.get(r["id"])
        if m is None:
            continue
        sens = {s: {"first_date": v["first_date"], "last_date": v["last_date"]} for s, v in m["sensors"].items()}
        prev = old.get(r["id"], {})
        entries.append({
            "id": r["id"], "name": r["name"], "bbox": r["bbox"], "fire_type": r["fire_type"],
            "data_through": m.get("archive_through"),  # None for an entry written before this field existed
            "sensors": sens,
            "point_years": prev.get("point_years", []), "point_rows": prev.get("point_rows", 0),
        })
    os.makedirs(os.path.dirname(INDEX), exist_ok=True)
    write_json(INDEX, {"schema": 1, "regions": entries})


def check_regions(regions):
    """Fail early on a malformed regions.json."""
    ids = set()
    for r in regions:
        missing = [k for k in ("id", "name", "country", "bbox", "fire_type") if k not in r]
        if missing:
            raise SystemExit(f"regions.json: region {r.get('id', '?')} is missing {missing}")
        if not re.fullmatch(r"[a-z0-9-]+", r["id"]) or r["id"] in ids:
            raise SystemExit(f"regions.json: bad or duplicate id {r['id']!r} (use lowercase letters, digits, '-')")
        w, s, e, n = r["bbox"]
        if not (w < e and s < n):
            raise SystemExit(f"regions.json: bbox of {r['id']} must be [west, south, east, north] with west<east, south<north")
        ids.add(r["id"])


def main(argv=None):
    os.chdir(os.path.dirname(os.path.abspath(__file__)))  # all paths are relative to the repo root
    with open("regions.json", encoding="utf-8") as f:
        regions = json.load(f)
    check_regions(regions)
    ap = argparse.ArgumentParser(description="Build per-region fire grids from NASA FIRMS archives.")
    ap.add_argument("regions", nargs="*", metavar="region_id", help="region ids to build (default: all)")
    args = ap.parse_args(argv)
    valid = [r["id"] for r in regions]
    bad = [i for i in args.regions if i not in valid]
    if bad:
        raise SystemExit(f"Unknown region id(s): {bad}; valid ids: {valid}")
    todo = [r for r in regions if not args.regions or r["id"] in args.regions]

    os.makedirs(RAW, exist_ok=True)
    os.makedirs(GRID, exist_ok=True)
    manifest_path = f"{GRID}/manifest.json"
    manifest = {}
    if os.path.exists(manifest_path):
        with open(manifest_path, encoding="utf-8") as f:
            manifest = json.load(f)
    for r in todo:  # manifest and index are written after EACH region, so a later failure leaves them consistent
        print(f"== {r['id']} ==")
        df, archive_through = load_region(r)
        out = grid(df)
        path = f"{GRID}/fire_grid_daily_{r['id']}.csv"
        out.to_csv(path + ".part", index=False, lineterminator="\n")
        os.replace(path + ".part", path)
        print("rows:", len(out), "| dates:", out.date.min(), "->", out.date.max())
        manifest[r["id"]] = coverage(df, out, archive_through)
        write_json(manifest_path, dict(sorted(manifest.items())))
        write_index(regions, manifest)


if __name__ == "__main__":
    main()
