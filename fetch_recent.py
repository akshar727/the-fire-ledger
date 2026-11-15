"""Fetch 2026 year-to-date detections (MODIS + VIIRS S-NPP) per region from the NASA FIRMS area API and cache
them in data/raw/recent/<region_id>/ so build.py can add them to the grid without a key.
Usage: python fetch_recent.py [region_id ...]   (no ids = all regions in regions.json)
Needs env FIRMS_MAP_KEY (free key: https://firms.modaps.eosdis.nasa.gov/api/map_key/).

The key is part of every request URL, so this script never prints, logs or stores a URL, and never chains a
network exception (its text or attributes can hold the URL). Only this file reads the key; build.py stays key-free.

Per sensor, standard-processing (SP) data is used up to its last available day and near-real-time (NRT) after
that, so a day is never fetched from both. Requests are 5 days each (the API maximum). Finished chunks are
skipped on a re-run, so an interrupted fetch resumes. Each region folder gets coverage.json:
{"start", "through", "chunks": [{"source", "first", "last", "rows", "file"}]}; build.py reads "through"."""
import argparse, csv, io, json, os, re, sys, time, urllib.error, urllib.request
from datetime import date, timedelta

API = "https://firms.modaps.eosdis.nasa.gov/api"
START, END = date(2026, 1, 1), date(2026, 11, 2)   # END: last Suomi NPP day (the sensor the model is built on)
SENSORS = {"MODIS": ("MODIS_SP", "MODIS_NRT"), "VIIRS_SNPP": ("VIIRS_SNPP_SP", "VIIRS_SNPP_NRT")}
NEED = ["latitude", "longitude", "acq_date", "acq_time", "satellite", "confidence", "frp", "daynight"]
DAYS = 5            # API maximum day range per request
PAUSE = 0.15        # s between requests: ~400 requests total, far under 5,000 per 10 minutes
OUT = "data/raw/recent"
POINTS = "site/public/data/{id}/points"   # archive point files (DP-004), used by probe()
KEY_RE = re.compile(r"[A-Za-z0-9]{16,64}")
ID_RE = re.compile(r"[a-z0-9-]+")
CHUNK_RE = re.compile(r"(MODIS|VIIRS_SNPP)_(SP|NRT)_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv")


class FetchError(Exception):
    """An error whose message is safe to print (never contains the key or a URL)."""


def get_key(environ=os.environ):
    key = environ.get("FIRMS_MAP_KEY", "").strip()
    if not key:
        raise FetchError("FIRMS_MAP_KEY is not set. In PowerShell: $env:FIRMS_MAP_KEY = Read-Host \"FIRMS key\" "
                         "(this window only; typed at the prompt, so it stays out of the command history).")
    if not KEY_RE.fullmatch(key):
        raise FetchError("FIRMS_MAP_KEY does not look like a FIRMS map key (letters and digits only). Check it was pasted whole.")
    return key


def scrub(text, key):
    """Remove the key from any text before it can be shown (defence in depth)."""
    return text.replace(key, "<key>") if key else text


def http_get(url, key, attempts=3, opener=urllib.request.urlopen):
    """GET url, return the body as text. 4xx fails at once (except 408/429); other errors retry.
    Raises FetchError with a message that contains neither the URL nor the key."""
    err = None
    for i in range(attempts):
        fatal = None
        try:
            with opener(url, timeout=120) as r:
                return r.read().decode("utf-8-sig")
        except urllib.error.HTTPError as e:   # holds .url: keep only the code, raise outside this block
            code = e.code
            e.close()
            if 400 <= code < 500 and code not in (408, 429):
                fatal = code
            err = f"HTTP {code}"
        except Exception as e:   # URLError, timeout, reset: report only the class name
            err = type(e).__name__
        if fatal:
            raise FetchError(f"FIRMS API answered HTTP {fatal}. A 400/401/403 usually means the key is wrong or not active yet.")
        if i < attempts - 1:
            time.sleep(5 * (i + 1) if err == "HTTP 429" else 2 * (i + 1))
    raise FetchError(f"FIRMS API request failed after {attempts} attempts ({err}).")


def check_body(body, key):
    """A data answer is CSV starting with the column header. Anything else (e.g. 'Invalid MAP_KEY.') is an error."""
    first = body.split("\n", 1)[0].strip()
    if not first.startswith("latitude"):
        raise FetchError(f"FIRMS API did not return CSV: {scrub(first, key)[:120]!r}")
    cols = [c.strip() for c in first.split(",")]
    missing = [c for c in NEED if c not in cols]
    if missing:
        raise FetchError(f"FIRMS API CSV is missing columns {missing}")
    lines = [l for l in body.replace("\r\n", "\n").split("\n")[1:] if l.strip()]   # pandas skips blank lines too
    # The area API does not end its answers with a newline, so check every row's field count instead. A transfer
    # cut short is caught by urllib (IncompleteRead) or leaves a short last row here.
    rows = [next(csv.reader([l])) for l in lines]
    bad = [i for i, r in enumerate(rows, 2) if len(r) != len(cols)]
    if bad:
        raise FetchError(f"FIRMS API answer has malformed rows (line {bad[0]}: wrong number of fields); looks truncated.")
    if rows and any(not rows[-1][cols.index(c)].strip() for c in NEED):   # cut right after a comma
        raise FetchError("FIRMS API answer's last row has empty required fields; looks truncated.")
    if key and key in body:
        raise FetchError("FIRMS API answer contains the key; not saving it.")
    return len(lines)                # data rows


def availability(key, get=http_get):
    """{source: (min_date, max_date)} from the data availability API, as dates."""
    body = get(f"{API}/data_availability/csv/{key}/ALL", key)
    if key and key in body:
        raise FetchError("Data availability answer contains the key; stopping.")
    rows = list(csv.DictReader(io.StringIO(body)))
    if not rows or not {"data_id", "min_date", "max_date"} <= set(rows[0]):
        raise FetchError(f"Unexpected data availability answer: {scrub(body.splitlines()[0] if body else '', key)[:120]!r}")
    out, ok = {}, True
    for r in rows:
        try:
            out[r["data_id"].strip()] = (date.fromisoformat(r["min_date"].strip()), date.fromisoformat(r["max_date"].strip()))
        except (ValueError, AttributeError):   # message could quote the body: raise our own, outside this block
            ok = False
            break
    if not ok:
        raise FetchError("Data availability answer has a row without valid min_date/max_date.")
    return out


def plan(avail, start=START, end=END):
    """Chunks [(source, first_day, last_day)] covering start..through per sensor, plus `through`: the last day
    covered by BOTH sensors (so MODIS and VIIRS end on the same day). SP up to its max_date, NRT after it."""
    per, ends = [], []
    for sp, nrt in SENSORS.values():
        sp_max = avail[sp][1] if sp in avail else start - timedelta(days=1)
        nrt_max = avail[nrt][1] if nrt in avail else start - timedelta(days=1)
        ends.append(min(end, max(sp_max, nrt_max)))
        per.append((sp, nrt, sp_max))
    through = min(ends)
    if through < start:
        raise FetchError(f"No 2026 data available yet for both sensors (latest common day {through}).")
    for sp, nrt, sp_max in per:   # NRT must start by the day after SP ends, or those days would look fire-free
        if sp_max < through and (nrt not in avail or avail[nrt][0] > max(sp_max, start - timedelta(days=1)) + timedelta(days=1)):
            raise FetchError(f"{nrt} starts {avail[nrt][0] if nrt in avail else 'never'}, after {sp} ends {sp_max}: "
                             "a gap with no data. Not fetching.")
    chunks = []
    for sp, nrt, sp_max in per:
        d = start
        while d <= through:
            src = sp if d <= sp_max else nrt
            limit = min(through, sp_max) if src == sp else through
            last = min(d + timedelta(days=DAYS - 1), limit)
            chunks.append((src, d, last))
            d = last + timedelta(days=1)
    return chunks, through


def check_region(region):
    """Region id and bbox go into paths and URLs: allow only a plain id and four numbers. Returns (id, bbox)."""
    rid, bb = region.get("id", ""), region.get("bbox")
    if not ID_RE.fullmatch(str(rid)):
        raise FetchError(f"regions.json: bad region id {rid!r}")
    if not (isinstance(bb, list) and len(bb) == 4 and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in bb)
            and bb[0] < bb[2] and bb[1] < bb[3]):
        raise FetchError(f"regions.json: bbox of {rid} must be four numbers [west, south, east, north]")
    return rid, bb


def probe(region, key, get=http_get, points=POINTS, log=print):
    """Sanity check before fetching 2026: ask the API for the busiest 5 MODIS days of 2025 in this region and
    compare with the archive's point file for the same days. The API returns the whole bbox and the archive
    only the country, so the API count must be at least ~the archive count. 0 against hundreds means the
    requests are built wrong (or the API changed), and nothing is fetched."""
    check_region(region)
    path = os.path.join(points.format(id=region["id"]), "2025.csv")
    if not os.path.exists(path):
        log(f"{region['id']}: no 2025 point file, skipping the probe")
        return
    per_day = {}
    with open(path, encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            if r["satellite"] in ("Terra", "Aqua"):
                per_day[r["date"]] = per_day.get(r["date"], 0) + 1
    if not per_day:
        return
    win = lambda d0: [str(date.fromisoformat(d0) + timedelta(days=i)) for i in range(DAYS)]
    start = max(per_day, key=lambda d0: sum(per_day.get(d, 0) for d in win(d0)))
    expected = sum(per_day.get(d, 0) for d in win(start))
    bbox = ",".join(repr(float(v)) for v in region["bbox"])
    body = get(f"{API}/area/csv/{key}/MODIS_SP/{bbox}/{DAYS}/{start}", key)
    check_body(body, key)
    x0, y0, x1, y1 = region["bbox"]
    got = 0
    for r in csv.DictReader(io.StringIO(body)):
        if r.get("type", "0").strip() == "0" and x0 <= float(r["longitude"]) < x1 and y0 <= float(r["latitude"]) < y1:
            got += 1
    log(f"{region['id']} probe {start} +{DAYS - 1} days, MODIS: API {got}, archive {expected}")
    if got < 0.9 * expected:
        raise FetchError(f"{region['id']}: the API returned {got} MODIS detections for {start} +{DAYS - 1} days, "
                         f"the archive has {expected}. The requests are not returning data; nothing fetched.")


def fetch_region(region, key, avail, out=OUT, get=http_get, log=print):
    """Fetch every planned chunk for one region (skipping cached ones) and write coverage.json."""
    rid, bb = check_region(region)
    chunks, through = plan(avail)
    folder = os.path.join(out, rid)
    os.makedirs(folder, exist_ok=True)
    bbox = ",".join(repr(float(v)) for v in bb)          # west,south,east,north, as the API expects
    done = []
    for src, first, last in chunks:
        name = f"{src}_{first}_{last}.csv"
        path = os.path.join(folder, name)
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                rows = check_body(f.read(), key)
        else:
            n = (last - first).days + 1
            body = get(f"{API}/area/csv/{key}/{src}/{bbox}/{n}/{first}", key)
            rows = check_body(body, key)
            text = body.replace("\r\n", "\n")
            with open(path + ".part", "w", encoding="utf-8", newline="\n") as f:
                f.write(text if text.endswith("\n") else text + "\n")
            os.replace(path + ".part", path)
            time.sleep(PAUSE)
        done.append({"source": src, "first": str(first), "last": str(last), "rows": rows, "file": name})
        log(f"{region['id']} {name}: {rows} rows")
    cov = os.path.join(folder, "coverage.json")
    with open(cov + ".part", "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps({"start": str(START), "through": str(through), "chunks": done}, indent=1) + "\n")
    os.replace(cov + ".part", cov)
    keep = {c["file"] for c in done}
    for name in os.listdir(folder):                    # chunks from an earlier plan (e.g. NRT later replaced by SP)
        if CHUNK_RE.fullmatch(name) and name not in keep:
            os.remove(os.path.join(folder, name))
    return through, sum(c["rows"] for c in done)


def main(argv=None):
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    with open("regions.json", encoding="utf-8") as f:
        regions = json.load(f)
    ap = argparse.ArgumentParser(description="Fetch 2026 FIRMS detections into data/raw/recent/ (needs FIRMS_MAP_KEY).")
    ap.add_argument("regions", nargs="*", metavar="region_id")
    a = ap.parse_args(argv)
    ids = [r["id"] for r in regions]
    bad = [i for i in a.regions if i not in ids]
    if bad:
        ap.error(f"unknown region_id {bad}; choose from {ids}")
    key = None
    try:
        key = get_key()
        avail = availability(key)
        for s in (s for pair in SENSORS.values() for s in pair):
            print(f"{s}: {avail[s][0]} .. {avail[s][1]}" if s in avail else f"{s}: not listed")
        for r in regions:
            if not a.regions or r["id"] in a.regions:
                probe(r, key)
                through, rows = fetch_region(r, key, avail)
                print(f"== {r['id']}: {rows} detections through {through}")
    except FetchError as e:
        sys.exit(f"fetch_recent: {scrub(str(e), key)}")
    except KeyboardInterrupt:
        sys.exit("fetch_recent: interrupted; run again to resume (finished chunks are kept).")
    print("Done. Next: python build.py, then python model.py.")


if __name__ == "__main__":
    main()
