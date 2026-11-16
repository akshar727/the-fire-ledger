import json
import os

OUT = "site/public/data"
INDEX = f"{OUT}/index.json"
GLOBE = f"{OUT}/globe.json"
COUNTRIES = "countries.json"


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def entry(r, a, iso):
    keep = [i for i, p in enumerate(a.get("partial", [0] * len(a["years"]))) if not p]
    yrs = [a["years"][i] for i in keep]
    band = lambda k: [round(a[k][i], 1) if a["years"][i] < 2012 else None for i in keep]
    t = (a.get("trend") or {}).get("harmonized") or {}
    sc = dict(a.get("score") or {})
    if a.get("method") == "ratio":
        sc["mape_model"] = (a.get("model_score") or {}).get("mape_model")
    country = r.get("tier") == "country"
    return yrs, {
        "id": r["id"],
        "name": r["name"],
        "tier": "country" if country else "region",
        "iso_a3": iso.get(r["id"]) if country else None,
        "bbox": None if country else r.get("bbox"),
        "ship": a.get("ship") if country else None,
        "method": a.get("method", "model"),
        "cell_deg": a.get("cell_deg", 0.25 if not country else None),
        "caveat": a.get("caveat"),
        "harmonized": [round(a["harmonized"][i], 1) for i in keep],
        "lo": band("lo"),
        "hi": band("hi"),
        "trend": {k: t.get(k) for k in ("slope_pct", "lo_pct", "hi_pct", "p")},
        "score": {k: sc.get(k) for k in ("mape_model", "mape_ratio", "coverage", "n_hold")},
    }


def build(out=OUT, countries_path=COUNTRIES):
    index = load(os.path.join(out, "index.json"))
    iso = {c["id"]: c.get("iso_a3") for c in load(countries_path)} if os.path.exists(countries_path) else {}
    rows = []
    for r in index["regions"]:
        p = os.path.join(out, r["id"], "annual.json")
        if os.path.isfile(p):
            rows.append((r["id"],) + entry(r, load(p), iso))
    years = max((yrs for _, yrs, _ in rows), key=len, default=[])
    for rid, yrs, e in rows:
        if yrs != years[:len(yrs)]:
            raise SystemExit(f"globe: {rid} years {yrs[0]}-{yrs[-1]} don't line up with {years[0]}-{years[-1]}")
        for k in ("harmonized", "lo", "hi"):
            e[k] = e[k] + [None] * (len(years) - len(yrs))
    return {"schema": 1, "years": years, "regions": [e for _, _, e in rows]}


def write(out=OUT, countries_path=COUNTRIES):
    g = build(out, countries_path)
    path = os.path.join(out, "globe.json")
    with open(path + ".part", "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(g, allow_nan=False, ensure_ascii=False, separators=(",", ":")) + "\n")
    os.replace(path + ".part", path)
    return g


def main():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    g = write()
    tiers = {}
    for e in g["regions"]:
        k = e["ship"] or "deep dive"
        tiers[k] = tiers.get(k, 0) + 1
    print(f"globe: {len(g['regions'])} regions {tiers}, years {g['years'][0] if g['years'] else '-'}"
          f"-{g['years'][-1] if g['years'] else '-'}")


if __name__ == "__main__":
    main()
