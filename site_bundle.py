"""DP-009 / DP-018: the region list the site reads, site/public/data/index.json (generated, never hand-edited).

build.py writes the cell regions (regions.json). This adds each whole country (countries.json, DP-011 / DP-017) once
it has an annual.json, with its dates and sensors from data/grid/country/manifest.json; countries carry
`tier: "country"`, `iso_a3` and no point files. DP-018: every entry with an annual.json also gets the few record fields
the site needs before it fetches that file (`first_year`, `forward_through`; for a country `ship`, `method`,
`cell_deg` and the pipeline's `caveat`), so pages bundle only this list and fetch each region's annual.json by id
(~180 regions would make a bundle of every record ~1 MB). An entry without them has no record yet; the site hides it.

model.py runs this at the end of every run; on its own: `python site_bundle.py` from anywhere.
"""
import json
import os

OUT = "site/public/data"
INDEX = f"{OUT}/index.json"
OLD_BUNDLE = f"{OUT}/annual-all.json"  # DP-009's bundle of every record; removed by DP-018
COUNTRIES = "countries.json"
COUNTRY_GRID = "data/grid/country"
CELL_DEG = 0.25  # build.CELL_DEG; cells are named by their south-west corner
# record fields copied from annual.json into index.json (build.write_index keeps them; RECORD_KEYS must match there)
RECORD_KEYS = ("first_year", "forward_through")
COUNTRY_RECORD_KEYS = ("ship", "method", "cell_deg")


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
    if c.get("iso_a3"):
        e["iso_a3"] = c["iso_a3"]
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


def record_fields(entry, annual):
    """The entry with its record fields set from its annual.json (or removed when there is none: not modelled yet).
    A country's `caveat` is the pipeline's ship sentence (ML-023), after any countries.json caveat."""
    e = {k: v for k, v in entry.items() if k not in RECORD_KEYS + COUNTRY_RECORD_KEYS + ("ship_caveat",)}
    if annual is None:
        return e
    e["first_year"] = annual["years"][0]
    e["forward_through"] = annual.get("forward_through")
    if e.get("tier") == "country":
        for k in COUNTRY_RECORD_KEYS:
            if annual.get(k) is not None:
                e[k] = annual[k]
        if annual.get("caveat"):
            e["ship_caveat"] = annual["caveat"]
    return e


def add_records(index, out=OUT):
    """index with every entry's record fields refreshed from <out>/<id>/annual.json."""
    regions = []
    for r in index["regions"]:
        p = os.path.join(out, r["id"], "annual.json")
        regions.append(record_fields(r, load(p) if os.path.isfile(p) else None))
    return {**index, "regions": regions}


def main():
    # all paths are relative to the repo root (model.py calls this last, so changing directory there is harmless)
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    index = add_records(add_countries(load(INDEX)))
    write_json(INDEX, index)
    if os.path.exists(OLD_BUNDLE):
        os.remove(OLD_BUNDLE)
    missing = [r["id"] for r in index["regions"] if "first_year" not in r]
    if missing:
        print(f"site_bundle: no annual.json yet for {missing}; the site hides them until model.py has run")
    print(f"site_bundle: index.json {len(index['regions'])} regions, {len(index['regions']) - len(missing)} with a record")


if __name__ == "__main__":
    main()
