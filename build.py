"""Download NASA FIRMS country archives (MODIS C6.1, VIIRS S-NPP, VIIRS NOAA-20) for each region in
regions.json and grid them to 0.25 deg cells per day -> data/grid/fire_grid_daily_<id>.csv,
plus data/grid/manifest.json and site/public/data/index.json. Also writes the individual detections,
one CSV per region and year -> site/public/data/<id>/points/<year>.csv (see write_points).
Usage: python build.py [region_id ...]   (no ids = all regions)
Source: https://firms.modaps.eosdis.nasa.gov/country/ (no key needed), plus recent chunks that fetch_recent.py
cached in data/raw/recent/<id>/ (area API: MODIS, S-NPP and NOAA-20 from 2026, NOAA-21 from 2024; build.py itself
never needs a key). The model's sensors are Terra, Aqua and S-NPP; NOAA-20/21 get their own grid columns (n20_n,
n21_n) for the forward link past S-NPP's end (2026-11-02) and never change the terra/aqua/viirs values."""
import argparse, json, os, re, time, urllib.error, urllib.request
import numpy as np, pandas as pd

BASE = "https://firms.modaps.eosdis.nasa.gov/data/country"
SRC = {"modis": range(2000, 2026), "viirs-snpp": range(2012, 2026), "viirs-jpss1": range(2018, 2026)}  # jpss1 = NOAA-20
ARCHIVE_KEYS = {"modis": ("terra", "aqua"), "viirs-snpp": ("viirs",), "viirs-jpss1": ("n20",)}   # archive -> sensor keys
LEGACY_ARCHIVES = ("modis", "viirs-snpp")   # archive_through = how far these reach (the model's sensors)
RAW = "data/raw"
RECENT = "data/raw/recent"   # chunks written by fetch_recent.py (committed; build.py never needs the key)
GRID = "data/grid"
INDEX = "site/public/data/index.json"
COLS = ["latitude", "longitude", "acq_date", "acq_time", "satellite", "confidence", "frp", "daynight", "type"]
STR_COLS = {"acq_time": str, "satellite": str, "confidence": str, "daynight": str}  # read as text: keep "0905", "85", "n"
POINTS = "site/public/data/{id}/points"
POINT_COLS = ["date", "time_utc", "lat", "lon", "satellite", "confidence", "frp_mw", "daynight"]
POINT_SAT = {"Terra": "Terra", "Aqua": "Aqua", "N": "SNPP", "N20": "NOAA20", "N21": "NOAA21"}
SAT = {"Terra": "terra", "Aqua": "aqua", "N": "viirs", "N20": "n20", "N21": "n21"}   # FIRMS satellite -> sensor key
KEYS = ("terra", "aqua", "viirs", "n20", "n21")   # grid column order: the model's three first, unchanged
LEGACY_KEYS = ("terra", "aqua", "viirs")
LEGACY_SATS = ("Terra", "Aqua", "N")
# fetch_recent.py sensor -> (sensor keys, satellite values its files may hold after the T/A rename)
RECENT_SENSORS = {"MODIS": (("terra", "aqua"), {"Terra", "Aqua"}), "VIIRS_SNPP": (("viirs",), {"N"}),
                  "VIIRS_NOAA20": (("n20",), {"N20"}), "VIIRS_NOAA21": (("n21",), {"N21"})}
CELL_DEG = 0.25
KNOWN_DEG = 0.05   # load_recent: a 2026 detection must fall on a 0.05° sub-cell seen in the archive (border filter)


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


def load_region(region, ends=None):
    """Download (if missing) and read all yearly files for a region; keep type 0 detections inside its bbox.
    Points are kept if west <= lon < east and south <= lat < north. Edge cells may extend slightly outside
    the bbox when an edge is not a multiple of CELL_DEG (Portugal's 36.9 and 42.2).
    Returns (filtered detections, archive_through): archive_through is the latest acq_date in any of the
    country's MODIS and S-NPP files (LEGACY_ARCHIVES) before filtering, i.e. how far the model's archive reaches.
    ends: optional dict, filled with {sensor key: latest acq_date in that sensor's archive files} (e.g. "n20")."""
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

    first = next(((s, y) for s, ys in SRC.items() for y in ys), None)   # the loop's first file, by construction
    if first is None:
        raise SystemExit("SRC lists no years")
    _, probe = fetch(*first)  # fetch and print the first file up front: a quick availability check (bad country, no network)
    print(f"probe {probe}: {os.path.getsize(probe)} bytes")
    frames, archive_through = [], None
    for sensor, years in SRC.items():
        for y in years:
            name, path = fetch(sensor, y)
            try:
                d = pd.read_csv(path, usecols=COLS, dtype=STR_COLS)
            except (pd.errors.ParserError, ValueError, UnicodeDecodeError) as e:
                raise SystemExit(f"{path} could not be read ({e}); delete that file and re-run.") from e
            if d.acq_date.notna().any():
                last = str(d.acq_date.max())
                if sensor in LEGACY_ARCHIVES:
                    archive_through = max(archive_through or "", last)
                if ends is not None:
                    for k in ARCHIVE_KEYS[sensor]:
                        ends[k] = max(ends.get(k) or "", last)
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


def recent_spans(cov):
    """{fetch_recent sensor: (start, through)} from a coverage.json. A file from before DP-013 has no "sensors":
    its start/through belong to MODIS and VIIRS_SNPP."""
    spans = {n: (v["start"], v["through"]) for n, v in (cov.get("sensors") or {}).items()}
    if not spans and cov.get("through"):
        spans = {"MODIS": (cov["start"], cov["through"]), "VIIRS_SNPP": (cov["start"], cov["through"])}
    return spans


def load_recent(region, archive_df, root=RECENT, spans=None):
    """Detections cached by fetch_recent.py in <root>/<id>/ (none -> empty frame, through None).
    Same filters as the archive: inside the bbox and type 0 where the file has a `type` column (NRT files don't:
    those rows are kept, so non-vegetation hotspots can slip in). The area API returns the whole bbox, the
    archives only the country, so a recent detection is kept only if its KNOWN_DEG (0.05°, ~5.5 km) sub-cell had a
    MODIS or S-NPP detection in this region's archive (the mask ignores NOAA-20 archive rows, so adding NOAA-20 never
    changes which MODIS/S-NPP rows are kept). Measured (DP-005 review): with 0.25° cells ~6% of 2026 detections fell
    on ground with no detection in 2000-2024 (neighbour side of border cells + untyped NRT static sources), against
    0.04-0.3% for 2025; the 0.05° mask drops at most ~0.3% of genuine detections.
    Each sensor's rows are kept only inside its own span from coverage.json (MODIS and S-NPP: start..through; NOAA-20
    and NOAA-21 run later), and a chunk's satellite values must belong to its sensor.
    Returns (detections, through): through = last day fetch_recent covered for MODIS and S-NPP (None if absent).
    spans: optional dict, filled with {sensor key: last day covered} for every sensor in coverage.json."""
    folder = os.path.join(root, region["id"])
    cov_path = os.path.join(folder, "coverage.json")
    if not os.path.exists(cov_path):
        return archive_df.iloc[0:0], None
    with open(cov_path, encoding="utf-8") as f:
        cov = json.load(f)
    sens = recent_spans(cov)
    unknown = sorted(set(sens) - set(RECENT_SENSORS))
    if unknown:
        raise SystemExit(f"{cov_path}: unknown sensor(s) {unknown}")
    for n, (start, _) in sens.items():   # a day must not come from both the archive and the API
        sats = [s for s, k in SAT.items() if k in RECENT_SENSORS[n][0]]
        arch = archive_df.acq_date[archive_df.satellite.isin(sats)]
        if len(arch) and start <= str(arch.max()):
            raise SystemExit(f"{cov_path}: {n} starts {start}, but the archive already reaches {arch.max()}; "
                             "rows would be counted twice. Drop the overlapping years from SRC or re-run fetch_recent.py.")
    x0, y0, x1, y1 = region["bbox"]
    key = lambda d: (np.floor(d.latitude.to_numpy() / KNOWN_DEG + 1e-9).astype(np.int64) * 100_000
                     + np.floor(d.longitude.to_numpy() / KNOWN_DEG + 1e-9).astype(np.int64))
    known = np.unique(key(archive_df[archive_df.satellite.isin(LEGACY_SATS)]))
    frames = []
    for c in cov["chunks"]:
        path = os.path.join(folder, c["file"])
        name = c["source"].rsplit("_", 1)[0]
        if name not in sens:
            raise SystemExit(f"{cov_path}: chunk {c['file']} belongs to {name}, which has no span in coverage.json")
        cols = [k for k in COLS if k != "type" or not header_missing(path, ["type"])]
        missing = header_missing(path, [k for k in COLS if k != "type"])
        if missing:
            raise SystemExit(f"{path} is missing columns {missing}; delete it and re-run fetch_recent.py.")
        d = pd.read_csv(path, usecols=cols, dtype={**STR_COLS, "latitude": float, "longitude": float, "frp": float})
        if len(d) != c["rows"]:
            raise SystemExit(f"{path}: {len(d)} rows, coverage.json says {c['rows']}; re-run fetch_recent.py.")
        if not len(d):              # a quiet 5 days: an empty frame would turn number columns into text on concat
            continue
        if "type" not in d:
            d["type"] = 0           # NRT: no type column (see docstring)
        d["type"] = d["type"].astype(archive_df["type"].dtype)
        d["satellite"] = d.satellite.replace({"T": "Terra", "A": "Aqua"})   # MODIS NRT may use one-letter names
        wrong = sorted(set(d.satellite.dropna()) - RECENT_SENSORS[name][1])
        if wrong:
            raise ValueError(f"{path}: satellite value(s) {wrong} in a {name} chunk; expected {sorted(RECENT_SENSORS[name][1])}")
        start, through = sens[name]
        d = d[(d.type == 0) & d.longitude.between(x0, x1, inclusive="left") & d.latitude.between(y0, y1, inclusive="left")
              & (d.acq_date >= start) & (d.acq_date <= through)]
        d = d[np.isin(key(d), known)] if len(d) else d
        frames.append(d)
    df = pd.concat(frames, ignore_index=True) if frames else archive_df.iloc[0:0]
    unknown = sorted(set(df.satellite.dropna()) - set(SAT)) + (["NaN"] if df.satellite.isna().any() else [])
    if unknown:
        raise ValueError(f"{region['id']} recent: unknown satellite value(s) {unknown}; expected one of {sorted(SAT)}")
    if spans is not None:
        spans.update({k: through for n, (_, through) in sens.items() for k in RECENT_SENSORS[n][0]})
    print(f"recent {region['id']}: {len(df)} detections; "
          + "; ".join(f"{n} {a} .. {b}" for n, (a, b) in sens.items()))
    return df, cov.get("through")


def grid(df):
    """Aggregate detections to CELL_DEG cells per day, day/night and sensor. Columns: date, lat, lon, daynight, then
    terra/aqua/viirs counts and mean FRP (the model's input, same order as before DP-013), then n20/n21 counts and
    mean FRP. A row exists where any sensor saw a fire, so rows after S-NPP's end hold NOAA counts only."""
    df = df.copy()
    df["lat"] = np.floor(df.latitude / CELL_DEG) * CELL_DEG
    df["lon"] = np.floor(df.longitude / CELL_DEG) * CELL_DEG
    df["src"] = df.satellite.map(SAT)
    g = df.groupby(["acq_date", "lat", "lon", "daynight", "src"]).frp.agg(n="size", frp="mean").unstack("src")
    g = g.reindex(columns=pd.MultiIndex.from_product([["n", "frp"], KEYS]))  # a sensor may be absent
    cols = {}
    for group in (LEGACY_KEYS, tuple(k for k in KEYS if k not in LEGACY_KEYS)):
        cols.update({f"{k}_n": g[("n", k)] for k in group})
        cols.update({f"{k}_frp_mean": g[("frp", k)] for k in group})
    out = pd.DataFrame(cols).reset_index().rename(columns={"acq_date": "date"})
    for k in KEYS:
        out[f"{k}_n"] = out[f"{k}_n"].fillna(0).astype(int)
    return out.round(2).sort_values(["date", "lat", "lon", "daynight"]).reset_index(drop=True)


def check_model_cells(out, region_id):
    """model.py takes its cell list (and, through it, its row order and bootstrap draws) from every grid row in
    first-appearance order. NOAA rows must not add a cell or bring one forward, or the model's outputs change even
    though terra/aqua/viirs did not. SystemExit if they would; ML-017 makes model.py filter its cells itself."""
    cells = out[["lat", "lon"]].drop_duplicates().reset_index(drop=True)
    seen = out[(out.terra_n + out.aqua_n + out.viirs_n) > 0][["lat", "lon"]].drop_duplicates().reset_index(drop=True)
    if not cells.equals(seen):
        raise SystemExit(f"{region_id}: NOAA-20/21 detections add or reorder grid cells ({len(cells)} cells vs "
                         f"{len(seen)} with MODIS/S-NPP), which would change model.py's fit. Grid not written.")


def write_points(region, df):
    """Write the individual detections of a region as <POINTS>/<year>.csv (year of acq_date UTC), only for
    years with at least one detection. Rows are sorted (date, time, satellite, lat, lon, confidence, frp) so
    a rebuild is byte-identical. Stale <year>.csv files from earlier runs are removed. Returns (years, rows)."""
    if df.acq_date.isna().any():
        raise ValueError(f"{region['id']}: detections without acq_date; check the raw files")
    _, _, east, north = region["bbox"]
    d = pd.DataFrame({
        "date": df.acq_date.astype(str),
        "time_utc": df.acq_time.astype(str).str.strip().str.zfill(4),
        # rounding to 4 decimals could land exactly on the excluded east/north edge: keep it inside the bbox
        "lat": np.minimum(df.latitude.round(4), round(north - 1e-4, 4)) + 0.0,  # + 0.0 turns -0.0 into 0.0
        "lon": np.minimum(df.longitude.round(4), round(east - 1e-4, 4)) + 0.0,
        "satellite": df.satellite.map(POINT_SAT),
        "confidence": df.confidence.astype(str).str.strip(),
        "frp_mw": df.frp.round(1) + 0.0,
        "daynight": df.daynight,
    })
    d = d.sort_values(["date", "time_utc", "satellite", "lat", "lon", "confidence", "frp_mw"], kind="stable")
    folder = POINTS.format(id=region["id"])
    os.makedirs(folder, exist_ok=True)
    years, rows = [], 0
    for y, part in d.groupby(d.date.str[:4], sort=True):
        part = part.copy()  # format one year at a time: strings for a whole region (Ghana 4 M rows) are ~2 GB
        for c, n in (("lat", 4), ("lon", 4), ("frp_mw", 1)):
            part[c] = part[c].map(lambda v, n=n: "" if pd.isna(v) else f"{v:.{n}f}")
        path = f"{folder}/{y}.csv"
        part[POINT_COLS].to_csv(path + ".part", index=False, lineterminator="\n", encoding="utf-8")
        os.replace(path + ".part", path)
        years.append(int(y))
        rows += len(part)
    keep = {f"{y}.csv" for y in years}
    for name in os.listdir(folder):  # leftovers only: <year>.csv / .part, nothing else
        if re.fullmatch(r"\d{4}\.csv(\.part)?", name) and name not in keep:
            os.remove(f"{folder}/{name}")
    return years, rows


def coverage(df, out, archive_through, sensor_through=None):
    """Per sensor: first/last DETECTION date and count, from the filtered detections. last_date is the
    last day a fire was detected, not the end of the data (a quiet month has no rows).
    archive_through: how far the model's data reach (MODIS and S-NPP, archive + fetch_recent).
    sensor_through: {sensor key: last day with data}; default archive_through for terra/aqua/viirs, None otherwise.
    Each sensor's data_through is that day (None = no data for that sensor)."""
    src = df.satellite.map(SAT)
    through = {k: archive_through for k in LEGACY_KEYS}
    through.update(sensor_through or {})
    sensors = {}
    for s in KEYS:
        dates = df.acq_date[src == s]
        sensors[s] = {
            "first_date": str(dates.min()) if len(dates) else None,
            "last_date": str(dates.max()) if len(dates) else None,
            "detections": int(len(dates)),
            "data_through": through.get(s),
        }
    return {"archive_through": archive_through, "sensors": sensors, "grid_rows": int(len(out))}


def write_json(path, obj):
    """Write JSON atomically (temp file + rename), UTF-8, LF, no NaN."""
    tmp = path + ".part"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(obj, indent=2, allow_nan=False, ensure_ascii=False) + "\n")
    os.replace(tmp, path)


def write_index(regions, manifest, points=None):
    """site/public/data/index.json. data_through = how far the archive reaches (archive_through).
    points: {region_id: (years, rows)} for regions built in this run; other regions keep the
    point_years / point_rows already in the index."""
    points = points or {}
    old = {}
    if os.path.exists(INDEX):
        with open(INDEX, encoding="utf-8") as f:
            old = {e["id"]: e for e in json.load(f).get("regions", [])}
    entries = []
    for r in regions:
        m = manifest.get(r["id"])
        if m is None:
            continue
        sens = {s: {k: v.get(k) for k in ("first_date", "last_date", "data_through")} for s, v in m["sensors"].items()}
        prev = old.get(r["id"], {})
        e = {"id": r["id"], "name": r["name"]}
        if r.get("short_name"):
            e["short_name"] = r["short_name"]
        e.update({"bbox": r["bbox"], "fire_type": r["fire_type"], "tier": r.get("tier", "region")})
        for k in ("season", "caveat"):  # DP-009: one-line page copy the site shows under the region switcher
            if r.get(k):
                e[k] = r[k]
        entries.append({
            **e,
            "data_through": m.get("archive_through"),  # None for an entry written before this field existed
            "sensors": sens,
            "point_years": list(points[r["id"]][0]) if r["id"] in points else prev.get("point_years", []),
            "point_rows": points[r["id"]][1] if r["id"] in points else prev.get("point_rows", 0),
        })
    # DP-009: whole countries are added by site_bundle.py (not in regions.json); keep them, after the cell regions
    entries += [e for e in old.values() if e.get("tier") == "country" and e["id"] not in {x["id"] for x in entries}]
    os.makedirs(os.path.dirname(INDEX), exist_ok=True)
    write_json(INDEX, {"schema": 1, "regions": entries})


def check_regions(regions):
    """Fail early on a malformed regions.json."""
    ids = set()
    for r in regions:
        missing = [k for k in ("id", "name", "country", "bbox", "fire_type") if k not in r]
        if missing:
            raise SystemExit(f"regions.json: region {r.get('id', '?')} is missing {missing}")
        if r.get("tier", "region") != "region":
            raise SystemExit(f"regions.json: {r['id']}: tier must be \"region\" (whole countries go in countries.json)")
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
    manifest, points = {}, {}
    if os.path.exists(manifest_path):
        with open(manifest_path, encoding="utf-8") as f:
            manifest = json.load(f)
    for r in todo:  # manifest and index are written after EACH region, so a later failure leaves them consistent
        print(f"== {r['id']} ==")
        ends, spans = {}, {}
        df, archive_through = load_region(r, ends)
        recent, through = load_recent(r, df, spans=spans)
        if len(recent):   # area API (DP-005, DP-013): same schema as the archive
            df = pd.concat([df, recent], ignore_index=True)
        if through:       # MODIS and S-NPP now reach `through`
            archive_through = through
        sensor_through = {k: v for k, v in ends.items() if k not in LEGACY_KEYS}
        sensor_through.update(spans)
        sensor_through.update({k: archive_through for k in LEGACY_KEYS})
        out = grid(df)
        check_model_cells(out, r["id"])   # before writing: a failure leaves the committed grid as it was
        path = f"{GRID}/fire_grid_daily_{r['id']}.csv"
        out.to_csv(path + ".part", index=False, lineterminator="\n")
        os.replace(path + ".part", path)
        print("rows:", len(out), "| dates:", out.date.min(), "->", out.date.max())
        points[r["id"]] = write_points(r, df)
        print("point files:", len(points[r["id"]][0]), "| point rows:", points[r["id"]][1])
        manifest[r["id"]] = coverage(df, out, archive_through, sensor_through)
        write_json(manifest_path, dict(sorted(manifest.items())))
        write_index(regions, manifest, points)


if __name__ == "__main__":
    main()
