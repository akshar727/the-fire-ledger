"""DP-009: the region list the site reads, in two generated files under site/public/data/ (never hand-edited).

- index.json: build.py writes the cell regions (regions.json). This adds each whole country (countries.json, DP-011)
  once ML-023 has written its annual.json, with its dates and sensors from data/grid/country/manifest.json.
  Countries carry `tier: "country"` and no point files.
- annual-all.json: every index.json region's annual.json in one object, {region_id: annual}, so the site bundles them
  with one import and a new region needs no edit under site/.

model.py runs this at the end of every run; on its own: `python site_bundle.py` from anywhere.
"""
import json
import os

OUT = "site/public/data"
INDEX = f"{OUT}/index.json"
BUNDLE = f"{OUT}/annual-all.json"
COUNTRIES = "countries.json"
COUNTRY_GRID = "data/grid/country"
CELL_DEG = 0.25  # build.CELL_DEG; cells are named by their south-west corner


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_json(path, obj, indent=2):
    """Atomic (temp file + rename), LF endings, no NaN, like build.py."""
    tmp = path + ".part"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(obj, indent=indent, allow_nan=False, ensure_ascii=False) + "\n")
    os.replace(tmp, path)


def grid_bbox(path):
    """[west, south, east, north] around every cell in a daily grid CSV (columns date, lat, lon, ...), read in chunks
    so a 100+ MB country grid never sits in memory at once."""
    import pandas as pd
    w = s = float("inf")
    e = n = float("-inf")
    for chunk in pd.read_csv(path, usecols=["lat", "lon"], chunksize=1_000_000):
        w, s = min(w, chunk.lon.min()), min(s, chunk.lat.min())
        e, n = max(e, chunk.lon.max() + CELL_DEG), max(n, chunk.lat.max() + CELL_DEG)
    if w == float("inf"):
        raise SystemExit(f"{path}: no cells, cannot place this country")
    return [round(float(w), 4), round(float(s), 4), round(float(e), 4), round(float(n), 4)]


def season_from(fire_type):
    """One sentence of page copy from a fire_type label when countries.json gives no `season`: the site uses no en or em
    dashes, so "peak Jul–Sep" reads "peak Jul to Sep"."""
    s = fire_type.replace("–", " to ").replace("—", ", ").strip()
    return s and (s if s.endswith(".") else s + ".")


def country_entry(c, manifest, grid_dir=COUNTRY_GRID, old=None):
    """index.json entry for one countries.json row, or None while it has no grid manifest entry. `old` is the country's
    current index.json entry, if any: its bbox is reused so the (git-ignored, 100+ MB) grid is scanned only once."""
    m = manifest.get(c["id"])
    if m is None:
        return None
    bbox = c.get("bbox") or (old or {}).get("bbox")
    if not bbox:
        grid_csv = os.path.join(grid_dir, f"fire_grid_daily_{c['id']}.csv")
        if not os.path.isfile(grid_csv):
            raise SystemExit(f"site_bundle: {c['id']}: no bbox in countries.json and no grid {grid_csv} to take it from")
        bbox = grid_bbox(grid_csv)
    e = {"id": c["id"], "name": c["name"]}
    if c.get("short_name"):
        e["short_name"] = c["short_name"]
    e.update({"bbox": bbox, "fire_type": c.get("fire_type", ""), "tier": "country"})
    season = c.get("season") or season_from(c.get("fire_type", ""))
    if season:
        e["season"] = season
    if c.get("caveat"):
        e["caveat"] = c["caveat"]
    e.update({
        "data_through": m["archive_through"],
        "sensors": {s: {k: v.get(k) for k in ("first_date", "last_date", "data_through")} for s, v in m["sensors"].items()},
        "point_years": [],  # no per-detection files for a country (DP-011): the site links the FIRMS archive instead
        "point_rows": 0,
    })
    return e


def add_countries(index, out=OUT, countries_path=COUNTRIES, grid_dir=COUNTRY_GRID):
    """index with every modelled country (has <out>/<id>/annual.json) appended after the cell regions, in
    countries.json order. Country entries already in the index are rebuilt from the grid manifest when this machine has
    it; otherwise (data/grid/country/ is git-ignored, so another clone has no manifest) the existing entry is kept as it
    is. A country is dropped only when its annual.json is gone."""
    regions = [r for r in index["regions"] if r.get("tier", "region") != "country"]
    old = {r["id"]: r for r in index["regions"] if r.get("tier") == "country"}
    countries = load(countries_path) if os.path.exists(countries_path) else []
    man_path = os.path.join(grid_dir, "manifest.json")
    manifest = load(man_path) if os.path.exists(man_path) else {}
    taken = {r["id"] for r in regions}
    for c in countries:
        if c["id"] in taken:
            raise SystemExit(f"{countries_path}: id {c['id']!r} is already a region in regions.json")
        if not os.path.isfile(os.path.join(out, c["id"], "annual.json")):
            continue
        e = country_entry(c, manifest, grid_dir, old.get(c["id"]))
        if e is None:
            e = old.get(c["id"])
            if e is None:
                print(f"site_bundle: {c['id']} has annual.json but no entry in {man_path}; left out of index.json")
                continue
        regions.append(e)
        taken.add(c["id"])
    # a country taken out of countries.json but still modelled keeps its entry rather than vanishing from the site
    for cid, e in old.items():
        if cid not in taken and os.path.isfile(os.path.join(out, cid, "annual.json")):
            print(f"site_bundle: {cid} is not in {countries_path} but has annual.json; entry kept")
            regions.append(e)
            taken.add(cid)
    return {**index, "regions": regions}


def bundle(index, out=OUT):
    """{region_id: annual.json} for every index region that has been modelled, in index order."""
    res = {}
    for r in index["regions"]:
        p = os.path.join(out, r["id"], "annual.json")
        if os.path.isfile(p):
            res[r["id"]] = load(p)
    return res


def main():
    # all paths are relative to the repo root (model.py calls this last, so changing directory there is harmless)
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    index = add_countries(load(INDEX))
    write_json(INDEX, index)
    annual = bundle(index)
    missing = [r["id"] for r in index["regions"] if r["id"] not in annual]
    if missing:
        print(f"site_bundle: no annual.json yet for {missing}; the site hides them until model.py has run")
    write_json(BUNDLE, annual, indent=None)
    print(f"site_bundle: index.json {len(index['regions'])} regions, annual-all.json {len(annual)}")


if __name__ == "__main__":
    main()
