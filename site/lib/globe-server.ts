// FE-026: build-time data for /globe (server components only; same rule as data-server.ts: the page MUST stay static,
// public/ is read with fs while it prerenders). Uses globe.json (registry row "Globe data") once ML-023/ML-026 commit
// it; until then the same shape built from every index.json region's annual.json (real data only).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import regionIndex from "@/public/data/index.json";
import { REGION_LIST, REGIONS } from "@/lib/data";
import { readAnnual } from "@/lib/data-server";
import {
  areaKm2,
  bboxKm2,
  completeYears,
  fromAnnual,
  joinCode,
  joinRegions,
  canonicalCode,
  parseGlobe,
  type GlobeData,
  type OutlineProps,
  type PlaceRow,
} from "@/lib/globe";

const DATA = path.join(process.cwd(), "public", "data");

/** index.json fields REGION_LIST leaves out (site_bundle.py writes them for countries). */
type IndexExtra = { id: string; iso_a3?: string; ship?: string; caveat?: string };

export interface Outline {
  type: "Feature";
  properties: OutlineProps;
  geometry: { type: "Polygon" | "MultiPolygon"; coordinates: unknown };
}

export function readOutlines(): Outline[] {
  return JSON.parse(readFileSync(path.join(DATA, "countries-110m.geojson"), "utf8")).features as Outline[];
}

/** globe.json when committed, else the same shape from annual.json; `source` says which, for the page's note. */
export function readGlobe(): { data: GlobeData; source: "globe.json" | "annual.json" } {
  const file = path.join(DATA, "globe.json");
  if (existsSync(file)) return { data: parseGlobe(JSON.parse(readFileSync(file, "utf8"))), source: "globe.json" };
  const records = REGION_LIST.map((r) => ({ r, a: readAnnual(r.id) }));
  const years = completeYears(records.map((x) => x.a));
  const rows = new Map((regionIndex.regions as IndexExtra[]).map((r) => [r.id, r]));
  const regions = records.map(({ r, a }) => {
    const row = rows.get(r.id);
    const rec = a as unknown as { ship?: string | null; caveat?: string | null };
    const country = r.tier === "country";
    return fromAnnual(
      {
        id: r.id,
        name: REGIONS[r.id],
        tier: r.tier,
        // globe.json has a bbox for the deep dives only (registry row "Globe data")
        bbox: country ? null : r.bbox,
        iso_a3: row?.iso_a3 ?? null,
        ship: country ? (rec.ship ?? row?.ship ?? null) : null,
        caveat: (country ? rec.caveat : row?.caveat) ?? null,
      },
      a,
      years,
    );
  });
  return { data: { schema: 1, years, regions }, source: "annual.json" };
}

/** Every region with its area (outline for a country, box for a deep dive) and whether the globe can draw it. */
export function readPlaces(): { years: number[]; places: PlaceRow[]; source: "globe.json" | "annual.json"; unmatched: string[] } {
  const { data, source } = readGlobe();
  const outlines = readOutlines();
  const { matched, unmatched } = joinRegions(outlines, data.regions);
  const area = new Map<string, number>();
  for (const f of outlines) area.set(joinCode(f.properties), areaKm2(f.geometry));
  const places = data.regions.map((r): PlaceRow => {
    if (r.tier !== "country") return { ...r, km2: r.bbox ? bboxKm2(r.bbox) : null, onGlobe: r.bbox !== null };
    const code = r.iso_a3 ? canonicalCode(r.iso_a3) : null;
    const on = code !== null && matched.get(code) === r;
    return { ...r, km2: on ? (area.get(code) ?? null) : null, onGlobe: on };
  });
  return { years: data.years, places, source, unmatched: unmatched.map((r) => r.name) };
}
