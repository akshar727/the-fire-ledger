"""Write the FE-026 globe outlines: Natural Earth 1:110m Admin 0 countries, cut down for the browser.

Source: Natural Earth 1:110m Cultural Vectors, Admin 0 - Countries, v5.1.2 (public domain),
https://www.naturalearthdata.com/downloads/110m-cultural-vectors/110m-admin-0-countries/
GeoJSON copy used: https://github.com/nvkelso/natural-earth-vector/blob/v5.1.2/geojson/ne_110m_admin_0_countries.geojson

Keeps only three properties per country, as Natural Earth names them: ISO_A3, ADM0_A3 and NAME. The site joins on
ISO_A3, falling back to ADM0_A3 where ISO_A3 is "-99" (France, Norway, Kosovo, N. Cyprus, Somaliland): `joinCode` in
site/lib/globe.ts.
and rounds coordinates to 2 decimals (~1 km; the 1:110m lines are coarser than that).

One change to the shapes: Natural Earth draws French Guiana as part of France (one MultiPolygon), but NASA FIRMS
archives it as its own country (countries.json, GUF). Its polygon (the one west of 30 W) is moved into a feature of
its own, ISO_A3 = ADM0_A3 = "GUF", so France's area is metropolitan France + Corsica and French Guiana gets a shape.

Usage: python scripts/globe/outlines.py <ne_110m_admin_0_countries.geojson> [out]
Default out: site/public/data/countries-110m.geojson
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "site" / "public" / "data" / "countries-110m.geojson"


def rnd(coords):
    if isinstance(coords[0], (int, float)):
        return [round(coords[0], 2), round(coords[1], 2)]
    out = [rnd(c) for c in coords]
    # drop consecutive duplicates made by rounding (rings keep their closing point)
    if out and isinstance(out[0][0], float):
        dedup = [out[0]]
        for p in out[1:]:
            if p != dedup[-1]:
                dedup.append(p)
        if dedup[-1] != dedup[0]:
            dedup.append(dedup[0])
        out = dedup if len(dedup) >= 4 else out
    return out


def split_overseas(features: list) -> list:
    """French Guiana out of France (see the module docstring)."""
    out = []
    for f in features:
        g = f["geometry"]
        if f["properties"].get("ADM0_A3") == "FRA" and g["type"] == "MultiPolygon":
            west = lambda poly: sum(x for x, _ in poly[0]) / len(poly[0]) < -30
            home = [poly for poly in g["coordinates"] if not west(poly)]
            away = [poly for poly in g["coordinates"] if west(poly)]
            if away:
                f = {**f, "geometry": {"type": "MultiPolygon", "coordinates": home}}
                out.append({
                    "type": "Feature",
                    "properties": {**f["properties"], "ISO_A3": "GUF", "ADM0_A3": "GUF", "NAME": "French Guiana"},
                    "geometry": {"type": "MultiPolygon", "coordinates": away},
                })
        out.append(f)
    return out


def build(src: dict) -> dict:
    feats = []
    for f in split_overseas(src["features"]):
        p = f["properties"]
        g = f["geometry"]
        feats.append({
            "type": "Feature",
            "properties": {"ISO_A3": p["ISO_A3"], "ADM0_A3": p["ADM0_A3"], "NAME": p["NAME"]},
            "geometry": {"type": g["type"], "coordinates": rnd(g["coordinates"])},
        })
    feats.sort(key=lambda f: f["properties"]["ADM0_A3"])
    return {"type": "FeatureCollection", "features": feats}


def main(argv: list[str]) -> None:
    if len(argv) < 2:
        sys.exit(__doc__)
    src = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
    out = Path(argv[2]) if len(argv) > 2 else OUT
    data = build(src)
    out.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(data['features'])} countries -> {out} ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main(sys.argv)
