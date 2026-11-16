import argparse, concurrent.futures, csv, datetime, json, os, subprocess, sys, time

GRID = "data/grid/country"
OUT = "site/public/data"
LOG = "data/country_runs.csv"
RANK = {"ratio": 0, "model": 1}
TIMEOUT = 3600
FIELDS = ["finished_utc", "id", "asked", "method", "ship", "cell_deg", "seconds", "mape_model", "mape_ratio",
          "coverage", "n_hold", "error"]


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def published(cid, out=OUT):
    p = os.path.join(out, cid, "annual.json")
    if not os.path.isfile(p):
        return None, None
    a = load(p)
    m = a.get("method", "model")
    if m == "ratio" and (a.get("model_score") or a.get("ship") == "sparse"):
        m = "model"
    return m, a.get("ship")


def todo(countries, method, grid=GRID, out=OUT, only=None, redo=False):
    man = load(os.path.join(grid, "manifest.json")) if os.path.exists(os.path.join(grid, "manifest.json")) else {}
    res = []
    for c in countries:
        if only and c["id"] not in only:
            continue
        if c["id"] not in man or not os.path.isfile(os.path.join(grid, f"fire_grid_daily_{c['id']}.csv")):
            continue
        done, _ = published(c["id"], out)
        if not redo and done is not None and RANK[done] >= RANK[method]:
            continue
        res.append(c)
    return res


def deadline(until, now=None):
    if not until:
        return None
    now = now or datetime.datetime.now(datetime.timezone.utc)
    h, m = map(int, until.split(":"))
    d = now.replace(hour=h, minute=m, second=0, microsecond=0)
    return d if d > now else d + datetime.timedelta(days=1)


def past(stop, now=None):
    return stop is not None and (now or datetime.datetime.now(datetime.timezone.utc)) >= stop


def run_one(c, method, nboot):
    cmd = [sys.executable, "model.py", c["id"], "--method", method, "--no-bundle"]
    if nboot:
        cmd += ["--nboot", str(nboot)]
    t = time.time()
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=TIMEOUT)
        err = "" if p.returncode == 0 else (p.stderr.strip().splitlines() or ["exit %d" % p.returncode])[-1][:300]
    except Exception as e:
        err = repr(e)[:300]
    return c, round(time.time() - t), err


def log_row(c, asked, secs, err, out=OUT, log=LOG):
    row = {"finished_utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S"), "id": c["id"],
           "asked": asked, "seconds": secs, "error": err}
    p = os.path.join(out, c["id"], "annual.json")
    if not err and os.path.isfile(p):
        a = load(p)
        sc = dict(a.get("score") or {})
        if a.get("method") == "ratio":
            ms = a.get("model_score") or {}
            sc.update(mape_model=ms.get("mape_model"), coverage=ms.get("coverage", sc.get("coverage")))
        row.update({"method": a.get("method"), "ship": a.get("ship"), "cell_deg": a.get("cell_deg"),
                    "mape_model": None if sc.get("mape_model") is None else round(sc["mape_model"], 2),
                    "mape_ratio": None if sc.get("mape_ratio") is None else round(sc["mape_ratio"], 2),
                    "coverage": sc.get("coverage"), "n_hold": sc.get("n_hold")})
    new = not os.path.exists(log)
    os.makedirs(os.path.dirname(log), exist_ok=True)
    with open(log, "a", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, FIELDS)
        if new:
            w.writeheader()
        w.writerow(row)
    return row


def refresh():
    import globe
    import site_bundle
    with open(os.devnull, "w") as quiet:
        old, sys.stdout = sys.stdout, quiet
        try:
            site_bundle.main()
            globe.main()
        except (Exception, SystemExit) as e:
            print(f"WARNING: refreshing index.json / globe.json failed: {e!r}", file=sys.stderr, flush=True)
        finally:
            sys.stdout = old
            os.chdir(os.path.dirname(os.path.abspath(__file__)))


def main(argv=None):
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    ap = argparse.ArgumentParser(description="Run every country with a grid through model.py.")
    ap.add_argument("--method", choices=("ratio", "model"), required=True)
    ap.add_argument("--jobs", type=int, default=3, help="countries at once (model: < 4 GB each; ratio: tiny)")
    ap.add_argument("--nboot", type=int, default=None, help="default: model.py's country default (100)")
    ap.add_argument("--only", nargs="*", help="only these country ids")
    ap.add_argument("--until", help="HH:MM UTC: start no new country after this")
    ap.add_argument("--redo", action="store_true", help="run countries already at this method again")
    a = ap.parse_args(argv)
    countries = load("countries.json")
    queue = todo(countries, a.method, only=a.only, redo=a.redo)
    print(f"{len(queue)} countries to run with method={a.method}, {a.jobs} at once"
          + (f", none started after {a.until} UTC" if a.until else ""), flush=True)
    t0, done, failed, stopped = time.time(), 0, [], 0
    stop = deadline(a.until)
    if stop:
        print(f"no new country after {stop:%Y-%m-%d %H:%M} UTC", flush=True)
    with concurrent.futures.ThreadPoolExecutor(max(1, a.jobs)) as ex:
        running = set()
        it = iter(queue)
        while True:
            while len(running) < max(1, a.jobs):
                if past(stop):
                    stopped = sum(1 for _ in it)
                    break
                c = next(it, None)
                if c is None:
                    break
                running.add(ex.submit(run_one, c, a.method, a.nboot))
            if not running:
                break
            fin, running = concurrent.futures.wait(running, return_when=concurrent.futures.FIRST_COMPLETED)
            for f in fin:
                c, secs, err = f.result()
                row = log_row(c, a.method, secs, err)
                done += 1
                if err:
                    failed.append(c["id"])
                    print(f"[{done}/{len(queue)}] FAILED {c['id']} after {secs} s: {err}", flush=True)
                else:
                    refresh()
                    mm = row.get("mape_model")
                    print(f"[{done}/{len(queue)}] {c['id']}: {row.get('ship')} ({row.get('method')}"
                          f"{', %s deg' % row['cell_deg'] if row.get('cell_deg') else ''}), {secs} s"
                          + (f", hold-out error model {mm}% vs ratio {row.get('mape_ratio')}%" if mm is not None else ""),
                          flush=True)
    print(f"finished {done - len(failed)} of {len(queue)} in {(time.time() - t0) / 60:.0f} min"
          + (f"; FAILED: {' '.join(failed)}" if failed else "")
          + (f"; {stopped} not started (past {a.until} UTC)" if stopped else ""), flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
