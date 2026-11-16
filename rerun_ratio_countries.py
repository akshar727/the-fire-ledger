import contextlib, io, json, os, sys, time
os.chdir(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ".")
import model
import run_countries

t0, n, before, after = time.time(), 0, [], []
for c in json.load(open("countries.json", encoding="utf-8")):
    p = f"site/public/data/{c['id']}/annual.json"
    if not os.path.isfile(p):
        continue
    a = json.load(open(p, encoding="utf-8"))
    if a.get("method") != "ratio":
        continue
    before.append(a["score"]["mape_model"])
    with contextlib.redirect_stdout(io.StringIO()):
        model.run(c["id"], model.COUNTRY_NBOOT, grid_dir=model.COUNTRY_GRID, method="ratio", tier="country",
                  model_score=a.get("model_score"))
    b = json.load(open(p, encoding="utf-8"))
    after.append(b["score"]["mape_model"])
    n += 1
run_countries.refresh()
med = lambda v: sorted(x for x in v if x is not None)[len([x for x in v if x is not None]) // 2]
print(f"re-ran {n} ratio countries in {time.time() - t0:.0f} s; published-line hold-out error median "
      f"{med(before):.1f}% -> {med(after):.1f}%")
