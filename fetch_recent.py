import argparse, csv, io, json, os, re, sys, time, urllib.error, urllib.request
from datetime import date, datetime, timedelta, timezone

API = "https://firms.modaps.eosdis.nasa.gov/api"
SENSORS = {"MODIS": ("MODIS_SP", "MODIS_NRT"), "VIIRS_SNPP": ("VIIRS_SNPP_SP", "VIIRS_SNPP_NRT"),
           "VIIRS_NOAA20": ("VIIRS_NOAA20_SP", "VIIRS_NOAA20_NRT"), "VIIRS_NOAA21": ("VIIRS_NOAA21_SP", "VIIRS_NOAA21_NRT")}
STARTS = {"MODIS": date(2026, 1, 1), "VIIRS_SNPP": date(2026, 1, 1), "VIIRS_NOAA20": date(2026, 1, 1),
          "VIIRS_NOAA21": date(2024, 1, 1)}
START = STARTS["MODIS"]
ENDS = {"VIIRS_SNPP": date(2026, 11, 2)}
LINKED = ("MODIS", "VIIRS_SNPP")
NEED = ["latitude", "longitude", "acq_date", "acq_time", "satellite", "confidence", "frp", "daynight"]
DAYS = 5
PAUSE = 0.15
OUT = "data/raw/recent"
POINTS = "site/public/data/{id}/points"
KEY_RE = re.compile(r"[A-Za-z0-9]{16,64}")
ID_RE = re.compile(r"[a-z0-9-]+")
CHUNK_RE = re.compile(r"(MODIS|VIIRS_SNPP|VIIRS_NOAA20|VIIRS_NOAA21)_(SP|NRT)_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv")


class FetchError(Exception):
    pass


def get_key(environ=os.environ):
    key = environ.get("FIRMS_MAP_KEY", "").strip()
    if not key:
        raise FetchError("FIRMS_MAP_KEY is not set. In PowerShell: $env:FIRMS_MAP_KEY = Read-Host \"FIRMS key\" "
                         "(this window only; typed at the prompt, so it stays out of the command history).")
    if not KEY_RE.fullmatch(key):
        raise FetchError("FIRMS_MAP_KEY does not look like a FIRMS map key (letters and digits only). Check it was pasted whole.")
    return key


def scrub(text, key):
    return re.sub(re.escape(key), "<key>", text, flags=re.I) if key else text


def error_detail(raw, limit, key):
    text = raw.decode("utf-8", "replace")
    if len(raw) >= limit and key:
        text = text[:max(0, len(text) - len(key))]
    text = scrub(re.sub(r"<[^>]*>", "", text), key)
    text = re.sub(r"https?://\S+|\S*firms\.modaps\S*", "<url>", text, flags=re.I)
    text = re.sub(r"[A-Za-z0-9]{20,}", "<redacted>", text)
    return re.sub(r"\s+", " ", text).strip()[:160]


def http_get(url, key, attempts=3, opener=urllib.request.urlopen):
    err, detail = None, ""
    for i in range(attempts):
        fatal = None
        try:
            with opener(url, timeout=120) as r:
                return r.read().decode("utf-8-sig")
        except urllib.error.HTTPError as e:
            code = e.code
            try:
                detail = error_detail(e.read(4000), 4000, key)
            except Exception:
                detail = ""
            try:
                e.close()
            except Exception:
                pass
            if 400 <= code < 500 and code not in (408, 429):
                fatal = code
            err = f"HTTP {code}"
        except Exception as e:
            err = type(e).__name__
        if fatal:
            raise FetchError(f"FIRMS API answered HTTP {fatal} ({detail or 'no message'}). A 400/401/403 usually means the "
                             "key is wrong, not active yet, or over its transaction limit; finished chunks are kept, so "
                             "run the same command again to resume.")
        if i < attempts - 1:
            time.sleep(5 * (i + 1) if err == "HTTP 429" else 2 * (i + 1))
    raise FetchError(f"FIRMS API request failed after {attempts} attempts ({err}).")


def check_body(body, key):
    first = body.split("\n", 1)[0].strip()
    if not first.startswith("latitude"):
        raise FetchError(f"FIRMS API did not return CSV: {scrub(first, key)[:120]!r}")
    cols = [c.strip() for c in first.split(",")]
    missing = [c for c in NEED if c not in cols]
    if missing:
        raise FetchError(f"FIRMS API CSV is missing columns {missing}")
    lines = [l for l in body.replace("\r\n", "\n").split("\n")[1:] if l.strip()]
    rows = [next(csv.reader([l])) for l in lines]
    bad = [i for i, r in enumerate(rows, 2) if len(r) != len(cols)]
    if bad:
        raise FetchError(f"FIRMS API answer has malformed rows (line {bad[0]}: wrong number of fields); looks truncated.")
    if rows and any(not rows[-1][cols.index(c)].strip() for c in NEED):
        raise FetchError("FIRMS API answer's last row has empty required fields; looks truncated.")
    if key and key in body:
        raise FetchError("FIRMS API answer contains the key; not saving it.")
    return len(lines)


def availability(key, get=http_get):
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
        except (ValueError, AttributeError):
            ok = False
            break
    if not ok:
        raise FetchError("Data availability answer has a row without valid min_date/max_date.")
    return out


def utc_today(lag_hours=6):
    return (datetime.now(timezone.utc) - timedelta(hours=lag_hours)).date()


def check_sensors(names):
    names = list(dict.fromkeys(names))
    bad = [n for n in names if n not in SENSORS]
    if bad:
        raise FetchError(f"unknown sensor(s) {bad}; choose from {list(SENSORS)}")
    if 0 < sum(n in names for n in LINKED) < len(LINKED):
        raise FetchError(f"{' and '.join(LINKED)} are fetched together (they end on the same day); name both or neither.")
    if not names:
        raise FetchError("no sensors selected")
    return [n for n in SENSORS if n in names]


def plan(avail, sensors=tuple(SENSORS), today=None):
    last_ok = (today or utc_today()) - timedelta(days=1)
    spans, sp_end = {}, {}
    for name in check_sensors(sensors):
        sp, nrt = SENSORS[name]
        listed = [s for s in (sp, nrt) if s in avail]
        if not listed:
            raise FetchError(f"{name}: neither {sp} nor {nrt} is in the data availability list.")
        start = max(STARTS[name], avail[sp][0] if sp in avail else avail[nrt][0])
        sp_end[name] = avail[sp][1] if sp in avail else start - timedelta(days=1)
        nrt_max = avail[nrt][1] if nrt in avail else start - timedelta(days=1)
        spans[name] = (start, min(last_ok, ENDS.get(name, last_ok), max(sp_end[name], nrt_max)))
    if all(n in spans for n in LINKED):
        common = min(spans[n][1] for n in LINKED)
        for n in LINKED:
            spans[n] = (spans[n][0], common)
    chunks = []
    for name, (start, through) in spans.items():
        sp, nrt = SENSORS[name]
        if through < start:
            raise FetchError(f"{name}: no data available from {start} yet (latest day {through}).")
        sp_max = sp_end[name]
        if sp_max < through and (nrt not in avail or avail[nrt][0] > max(sp_max, start - timedelta(days=1)) + timedelta(days=1)):
            raise FetchError(f"{nrt} starts {avail[nrt][0] if nrt in avail else 'never'}, after {sp} ends {sp_max}: "
                             "a gap with no data. Not fetching.")
        d = start
        while d <= through:
            src = sp if d <= sp_max else nrt
            limit = min(through, sp_max) if src == sp else through
            last = min(d + timedelta(days=DAYS - 1), limit)
            chunks.append((src, d, last))
            d = last + timedelta(days=1)
    return chunks, spans


def sensor_of(source):
    return source.rsplit("_", 1)[0]


def old_coverage(folder):
    path = os.path.join(folder, "coverage.json")
    if not os.path.exists(path):
        return {}, []
    with open(path, encoding="utf-8") as f:
        cov = json.load(f)
    spans = dict(cov.get("sensors") or {})
    if not spans and cov.get("through"):
        spans = {n: {"start": cov["start"], "through": cov["through"]} for n in LINKED}
    return spans, cov.get("chunks", [])


def check_region(region):
    rid, bb = region.get("id", ""), region.get("bbox")
    if not ID_RE.fullmatch(str(rid)):
        raise FetchError(f"regions.json: bad region id {rid!r}")
    if not (isinstance(bb, list) and len(bb) == 4 and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in bb)
            and bb[0] < bb[2] and bb[1] < bb[3]):
        raise FetchError(f"regions.json: bbox of {rid} must be four numbers [west, south, east, north]")
    return rid, bb


def probe(region, key, get=http_get, points=POINTS, log=print):
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


def fetch_region(region, key, avail, out=OUT, get=http_get, log=print, sensors=tuple(SENSORS), today=None):
    rid, bb = check_region(region)
    chunks, spans = plan(avail, sensors, today)
    folder = os.path.join(out, rid)
    os.makedirs(folder, exist_ok=True)
    old_spans, old_chunks = old_coverage(folder)
    kept = [c for c in old_chunks if sensor_of(c["source"]) not in spans]
    for c in kept:
        if sensor_of(c["source"]) not in SENSORS or sensor_of(c["source"]) not in old_spans:
            raise FetchError(f"{rid}: coverage.json lists chunk {c['file']} of an unknown or span-less sensor; "
                             "run again without --sensors to re-fetch everything.")
        if not os.path.exists(os.path.join(folder, c["file"])):
            raise FetchError(f"{rid}: cached chunk {c['file']} is listed in coverage.json but missing; "
                             "run again without --sensors to re-fetch everything.")
    bbox = ",".join(repr(float(v)) for v in bb)
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
    span_out = {n: v for n, v in old_spans.items() if n not in spans and n in SENSORS}
    span_out.update({n: {"start": str(a), "through": str(b)} for n, (a, b) in spans.items()})
    span_out = {n: span_out[n] for n in SENSORS if n in span_out}
    order = {n: i for i, n in enumerate(SENSORS)}
    allc = sorted(kept + done, key=lambda c: order[sensor_of(c["source"])])
    link = span_out.get(LINKED[0], {})
    cov = os.path.join(folder, "coverage.json")
    with open(cov + ".part", "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps({"start": link.get("start"), "through": link.get("through"), "sensors": span_out,
                            "chunks": allc}, indent=1) + "\n")
    os.replace(cov + ".part", cov)
    keep = {c["file"] for c in allc}
    for name in os.listdir(folder):
        m = CHUNK_RE.fullmatch(name)
        if m and m.group(1) in spans and name not in keep:
            os.remove(os.path.join(folder, name))
    return span_out, sum(c["rows"] for c in done)


def main(argv=None):
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    with open("regions.json", encoding="utf-8") as f:
        regions = json.load(f)
    ap = argparse.ArgumentParser(description="Fetch recent FIRMS detections into data/raw/recent/ (needs FIRMS_MAP_KEY).")
    ap.add_argument("regions", nargs="*", metavar="region_id")
    ap.add_argument("--sensors", default=",".join(SENSORS),
                    help=f"comma-separated subset of {','.join(SENSORS)} (default all); others keep their cached chunks")
    a = ap.parse_args(argv)
    ids = [r["id"] for r in regions]
    bad = [i for i in a.regions if i not in ids]
    if bad:
        ap.error(f"unknown region_id {bad}; choose from {ids}")
    key = None
    try:
        sensors = check_sensors([n.strip() for n in a.sensors.split(",") if n.strip()])
        key = get_key()
        avail = availability(key)
        for s in (s for n in sensors for s in SENSORS[n]):
            print(f"{s}: {avail[s][0]} .. {avail[s][1]}" if s in avail else f"{s}: not listed")
        for r in regions:
            if not a.regions or r["id"] in a.regions:
                probe(r, key)
                spans, rows = fetch_region(r, key, avail, sensors=sensors)
                print(f"== {r['id']}: {rows} detections fetched; " +
                      "; ".join(f"{n} {v['start']} .. {v['through']}" for n, v in spans.items()))
    except FetchError as e:
        sys.exit(f"fetch_recent: {scrub(str(e), key)}")
    except KeyboardInterrupt:
        sys.exit("fetch_recent: interrupted; run again to resume (finished chunks are kept).")
    print("Done. Next: python build.py, then python model.py.")


if __name__ == "__main__":
    main()
