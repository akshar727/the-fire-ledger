"""Country grids (DP-011): stream NASA FIRMS country archive files into the same 0.25 deg per-cell daily table that
model.py trains on, without keeping the detections. build.py holds every detection of a region in memory and writes
points/<year>.csv for the site; a whole country (Brazil, Australia: ~150 MB of files per year) needs neither, so here
each year's files are read, filtered and gridded, and that year's grid rows are appended to the output file.

Usage: python build_country.py <country_id> [...] [--delete-raw] [--jobs N] [--skip-done]
       python build_country.py --all --jobs 6 --skip-done --delete-raw      (every country, countries.json order)
Writes data/grid/country/fire_grid_daily_<id>.csv and data/grid/country/manifest.json (git-ignored), in the format
model.run(region_id, grid_dir="data/grid/country") reads. Nothing under site/. No key: archive files only, so a
country's data end where the FIRMS country archive ends (build.py adds recent area-API chunks for the 3 deep dives).
Only the model's sensors are read (MODIS Terra/Aqua, VIIRS S-NPP): NOAA-20/21 feed only the forward link past S-NPP's
end, which needs the area API, so for a country they would add downloads and could only reorder the model's cells
(build.check_model_cells). The n20/n21 grid columns are kept, all zero, so the table has the usual columns.
--delete-raw removes each file this run downloaded once its year is gridded (files already on disk are kept, and so
are files of a year that failed), so disk use stays at about one country. --jobs N downloads a country's missing
files N at a time before gridding it. A file FIRMS does not have (HTTP 404: e.g. a year before the country existed,
or a year with no fire) counts as no detections and is listed in the manifest's `missing_files`; a country whose
files are all missing fails. One failing country does not stop the others (exit code 1 at the end). The manifest is
updated under a lock file, so two runs can share it. --skip-done skips countries already in the manifest.
Source: https://firms.modaps.eosdis.nasa.gov/country/ (MODIS C6.1, VIIRS S-NPP), the same files as build.py."""
import argparse, concurrent.futures, json, os, re, time, urllib.error
import pandas as pd
import build

COUNTRIES = "countries.json"
OUT = "data/grid/country"
ARCHIVES = ("modis", "viirs-snpp")             # the model's sensors only (see the docstring)
SENSORS = build.LEGACY_KEYS                    # terra, aqua, viirs
COLUMNS = ["date", "lat", "lon", "daynight"] + [f"{k}_{f}" for g in (build.LEGACY_KEYS, ("n20", "n21"))
                                                for f in ("n", "frp_mean") for k in g]   # build.grid's order
LOCK_WAIT = 120                                # seconds to wait for another run's manifest lock
CHUNK = 1_000_000                              # rows per read: a Brazil S-NPP year is ~1.5M rows before filtering


def check_countries(countries):
    """Fail early on a malformed countries.json."""
    ids = set()
    for c in countries:
        missing = [k for k in ("id", "name", "country") if k not in c]   # fire_type optional for countries
        if missing:
            raise SystemExit(f"{COUNTRIES}: {c.get('id', '?')} is missing {missing}")
        if not re.fullmatch(r"[a-z0-9-]+", c["id"]) or c["id"] in ids:
            raise SystemExit(f"{COUNTRIES}: bad or duplicate id {c['id']!r} (use lowercase letters, digits, '-')")
        if c.get("bbox") is not None:
            w, s, e, n = c["bbox"]
            if not (w < e and s < n):
                raise SystemExit(f"{COUNTRIES}: bbox of {c['id']} must be [west, south, east, north]")
        ids.add(c["id"])


def year_files():
    """{year: [archive, ...]} for the model's archives, so each year's files are read together."""
    years = {}
    for archive in ARCHIVES:
        for y in build.SRC[archive]:
            years.setdefault(y, []).append(archive)
    return dict(sorted(years.items()))


def read_filtered(path, bbox):
    """Detections of one file with type 0 (presumed vegetation fire), inside bbox if given (same edge rule as
    build.load_region: west <= lon < east, south <= lat < north). Returns (rows, last acq_date before filtering).
    rows is None when nothing is kept (a header-only file too), so no all-object empty frame reaches build.grid."""
    parts, last = [], None
    try:
        for d in pd.read_csv(path, usecols=build.COLS, dtype=build.STR_COLS, chunksize=CHUNK):
            if d.acq_date.notna().any():
                last = max(last or "", str(d.acq_date.max()))
            keep = d.type == 0
            if bbox is not None:
                x0, y0, x1, y1 = bbox
                keep &= d.longitude.between(x0, x1, inclusive="left") & d.latitude.between(y0, y1, inclusive="left")
            if keep.any():
                parts.append(d[keep])
    except (pd.errors.ParserError, ValueError, UnicodeDecodeError) as e:
        raise SystemExit(f"{path} could not be read ({e}); delete that file and re-run.") from e
    return (pd.concat(parts, ignore_index=True) if parts else None), last


class Coverage:
    """build.coverage's per-sensor fields, accumulated one year at a time instead of from all detections."""

    def __init__(self):
        self.s = {k: {"first_date": None, "last_date": None, "detections": 0} for k in SENSORS}
        self.ends = {}

    def add(self, df):
        src = df.satellite.map(build.SAT)
        for k in SENSORS:
            dates = df.acq_date[src == k]
            if len(dates):
                e = self.s[k]
                e["first_date"] = min(e["first_date"] or "9999", str(dates.min()))
                e["last_date"] = max(e["last_date"] or "", str(dates.max()))
                e["detections"] += int(len(dates))

    def end(self, archive, last):
        """Latest acq_date in an archive file (before filtering): how far that archive reaches."""
        if last:
            for k in build.ARCHIVE_KEYS[archive]:
                self.ends[k] = max(self.ends.get(k) or "", last)

    def manifest(self, grid_rows):
        """No n20/n21 keys, so model.forward_through finds no NOAA data and no forward link runs."""
        legacy = [self.ends[k] for k in ("terra", "viirs") if self.ends.get(k)]
        archive_through = max(legacy) if legacy else None   # build.load_region: latest day in any MODIS/S-NPP file
        sensors = {k: {**v, "data_through": archive_through} for k, v in self.s.items()}
        return {"archive_through": archive_through, "sensors": sensors, "grid_rows": int(grid_rows), "tier": "country"}


def not_found(e):
    """True if a download failed because FIRMS has no such file (HTTP 404)."""
    cause = e.__cause__ if isinstance(e, SystemExit) else e
    return isinstance(cause, urllib.error.HTTPError) and cause.code == 404


def prefetch(c, raw, fetch, jobs):
    """Download a country's missing files, `jobs` at a time. Returns (paths downloaded, file names FIRMS lacks)."""
    todo = [(f"{build.BASE}/{a}/{y}/{a}_{y}_{c['country']}.csv", os.path.join(raw, f"{a}_{y}_{c['country']}.csv"))
            for y, archives in year_files().items() for a in archives]
    todo = [(u, p) for u, p in todo if not os.path.exists(p)]
    made, missing = [], []

    def one(up):
        try:
            fetch(*up)
            return up[1], None
        except BaseException as e:   # build.download raises SystemExit
            if not_found(e):
                return None, os.path.basename(up[1])
            raise

    with concurrent.futures.ThreadPoolExecutor(max(1, jobs)) as ex:
        for got, miss in ex.map(one, todo):
            if got:
                made.append(got)
            if miss:
                missing.append(miss)
    return made, sorted(missing)


class Lock:
    """Exclusive lock file next to the manifest (O_EXCL create), so parallel runs don't drop each other's entries."""

    def __init__(self, path, wait=LOCK_WAIT):
        self.path, self.wait = path + ".lock", wait

    def __enter__(self):
        t = time.time()
        while True:
            try:
                os.close(os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
                return self
            except FileExistsError:
                if time.time() - t > self.wait:
                    raise SystemExit(f"{self.path} held for over {self.wait} s: another run, or a stale lock "
                                     "(delete it if no other build_country.py is running)")
                time.sleep(0.2)

    def __exit__(self, *exc):
        os.remove(self.path)


def build_country(c, raw=build.RAW, out_dir=OUT, delete_raw=False, fetch=None, jobs=1):
    """Grid one country year by year into <out_dir>/fire_grid_daily_<id>.csv (rows appended to a .part file per year,
    renamed at the end, so memory holds one year and a failed run leaves the previous file as it was) and add its
    entry to <out_dir>/manifest.json. fetch(url, path) defaults to build.download (tests pass a stub). Returns the
    manifest entry."""
    fetch = fetch or build.download
    name, bbox, t0 = c["country"], c.get("bbox"), time.time()
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"fire_grid_daily_{c['id']}.csv")
    part = path + ".part"
    pd.DataFrame(columns=COLUMNS).to_csv(part, index=False, lineterminator="\n")   # header
    cov, rows_out, read, nbytes, files, cells = Coverage(), 0, 0, 0, 0, set()
    made_all, absent = [], []
    try:
        made_all, absent = prefetch(c, raw, fetch, jobs)
        n_files = sum(len(a) for a in year_files().values())
        if len(absent) == n_files:
            raise SystemExit(f"{c['id']}: FIRMS has none of the {n_files} files for country name {name!r} (wrong name?)")
        if absent:
            print(f"{c['id']}: {len(absent)} file(s) not on FIRMS, counted as no detections: {', '.join(absent)}")
        for y, archives in year_files().items():
            frames, made = [], []
            for archive in archives:
                fname = f"{archive}_{y}_{name}.csv"
                fpath = os.path.join(raw, fname)
                if fname in absent:
                    continue
                if fpath in made_all:
                    made.append(fpath)
                missing = build.header_missing(fpath)
                if missing:
                    raise SystemExit(f"{fpath} is missing columns {missing}; delete that file and re-run.")
                rows, last = read_filtered(fpath, bbox)
                cov.end(archive, last)
                nbytes += os.path.getsize(fpath)
                files += 1
                if rows is not None:
                    read += len(rows)
                    frames.append(rows)
            if frames:
                df = pd.concat(frames, ignore_index=True)
                unknown = sorted(set(df.satellite.dropna()) - set(build.SAT)) + (["NaN"] if df.satellite.isna().any() else [])
                if unknown:
                    raise ValueError(f"{name} {y}: unknown satellite value(s) {unknown}")
                cov.add(df)
                g = build.grid(df)[COLUMNS]
                if not (g.date.astype(str).str[:4] == str(y)).all():
                    # appending per year is only the same as gridding everything at once if a year file holds only
                    # its own year (otherwise one cell-day could be split over two rows)
                    raise SystemExit(f"{name} {y}: a {y} file holds detections from another year; use build.py")
                g.to_csv(part, mode="a", header=False, index=False, lineterminator="\n")
                rows_out += len(g)
                cells.update(zip(g.lat, g.lon))
                del df, g
            print(f"{name} {y}: {sum(len(f) for f in frames)} detections kept, {rows_out} grid rows so far")
            del frames
            if delete_raw:   # only after the year is gridded: a failed year keeps its files for the re-run
                for p in made:
                    os.remove(p)
    except BaseException:
        if os.path.exists(part):
            os.remove(part)
        raise
    os.replace(part, path)
    entry = cov.manifest(rows_out)
    entry["missing_files"] = absent
    mpath = os.path.join(out_dir, "manifest.json")
    with Lock(mpath):
        man = load_manifest(out_dir)
        man[c["id"]] = entry
        build.write_json(mpath, dict(sorted(man.items())))
    print(f"== {c['id']}: {files} files, {nbytes / 1e6:.0f} MB read, {read} detections kept, {len(cells)} cells, "
          f"{rows_out} grid rows ({os.path.getsize(path) / 1e6:.1f} MB), archive through {entry['archive_through']}, "
          f"{(time.time() - t0) / 60:.1f} min -> {path}")
    return entry


def load_manifest(out_dir=OUT):
    mpath = os.path.join(out_dir, "manifest.json")
    if not os.path.exists(mpath):
        return {}
    with open(mpath, encoding="utf-8") as f:
        return json.load(f)


def main(argv=None):
    os.chdir(os.path.dirname(os.path.abspath(__file__)))   # paths are relative to the repo root
    with open(COUNTRIES, encoding="utf-8") as f:
        countries = json.load(f)
    check_countries(countries)
    ap = argparse.ArgumentParser(description="Build per-country fire grids from NASA FIRMS country archives.")
    ap.add_argument("countries", nargs="*", metavar="country_id", help="ids from countries.json (default: all)")
    ap.add_argument("--all", action="store_true", help="every country in countries.json (same as giving no ids)")
    ap.add_argument("--delete-raw", action="store_true", help="delete files this run downloaded once gridded")
    ap.add_argument("--jobs", type=int, default=1, help="download a country's files N at a time (default 1)")
    ap.add_argument("--skip-done", action="store_true", help="skip countries already in the country manifest")
    args = ap.parse_args(argv)
    if args.all and args.countries:
        ap.error("give country ids or --all, not both")
    valid = [c["id"] for c in countries]
    bad = [i for i in args.countries if i not in valid]
    if bad:
        raise SystemExit(f"Unknown country id(s): {bad}; valid ids: {valid}")
    os.makedirs(build.RAW, exist_ok=True)
    todo = [c for c in countries if not args.countries or c["id"] in args.countries]
    done = set(load_manifest()) if args.skip_done else set()
    failed, t0 = [], time.time()
    for i, c in enumerate(todo, 1):
        if c["id"] in done and os.path.exists(os.path.join(OUT, f"fire_grid_daily_{c['id']}.csv")):
            print(f"[{i}/{len(todo)}] {c['id']}: already built, skipped")
            continue
        print(f"[{i}/{len(todo)}] {c['id']} ({(time.time() - t0) / 60:.0f} min so far)", flush=True)
        try:
            build_country(c, delete_raw=args.delete_raw, jobs=args.jobs)
        except (Exception, SystemExit) as e:   # one country must not stop the world run; Ctrl+C still stops it
            print(f"FAILED {c['id']}: {e}", flush=True)
            failed.append(c["id"])
    print(f"done: {len(todo) - len(failed)} of {len(todo)} countries in {(time.time() - t0) / 60:.0f} min"
          + (f"; FAILED: {' '.join(failed)} (re-run the same command to retry them)" if failed else ""))
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
