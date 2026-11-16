// Run with `npm test`. FE-026: the globe page's pure helpers, on synthetic cases and the published files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  areaKm2,
  bboxKm2,
  bboxPolygon,
  binOf,
  completeYears,
  fmt,
  fromAnnual,
  globeQuery,
  GlobeFormatError,
  HEAT_STOPS,
  heatColor,
  joinCode,
  joinRegions,
  logBins,
  NEUTRAL,
  NO_DATA,
  parseGlobe,
  parseGlobeState,
  per1000,
  ramp,
  slopeText,
  sortYearRows,
  trendBin,
  trendColor,
  TREND_STOPS,
  yearRows,
  type AnnualLike,
  type OutlineProps,
  type PlaceRow,
} from "./globe.ts";

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const outlines = read("../public/data/countries-110m.geojson").features as {
  properties: OutlineProps;
  geometry: { type: string; coordinates: unknown };
}[];
const byCode = new Map(outlines.map((f) => [joinCode(f.properties), f]));
const near = (a: number, b: number, rel: number, msg?: string) =>
  assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${msg ?? ""} ${a} not within ${rel * 100}% of ${b}`);

/** Countries in our 176-country world list (countries.json) that Natural Earth 1:110m does not draw. */
const KNOWN_UNMATCHED = ["AND", "BHR", "COM", "CPV", "MUS", "SGP", "STP"];

test("joinCode uses ISO_A3, falling back to ADM0_A3 where it is -99", () => {
  assert.equal(joinCode({ ISO_A3: "GHA", ADM0_A3: "GHA" }), "GHA");
  assert.equal(joinCode({ ISO_A3: "-99", ADM0_A3: "FRA" }), "FRA");
  assert.equal(joinCode({ ISO_A3: "", ADM0_A3: "NOR" }), "NOR");
  // the published outlines: France and Norway are -99 in Natural Earth and still join
  assert.ok(byCode.has("FRA") && byCode.has("NOR") && byCode.has("KOS"));
  assert.equal(byCode.get("FRA")!.properties.ISO_A3, "-99");
  assert.equal(new Set(outlines.map((f) => joinCode(f.properties))).size, outlines.length, "codes are unique");
});

test("joinRegions matches countries (with the Kosovo alias), skips deep dives, lists the rest", () => {
  const regions = [
    { id: "portugal", tier: "region" as const, iso_a3: null },
    { id: "france", tier: "country" as const, iso_a3: "FRA" },
    { id: "kosovo", tier: "country" as const, iso_a3: "XKX" },
    { id: "singapore", tier: "country" as const, iso_a3: "SGP" },
    { id: "nowhere", tier: "country" as const, iso_a3: null },
  ];
  const { matched, unmatched } = joinRegions(outlines, regions);
  assert.deepEqual([...matched.keys()].sort(), ["FRA", "KOS"]);
  assert.deepEqual(unmatched.map((r) => r.id), ["singapore", "nowhere"]);
});

test("every country in the world list joins to an outline or is a known small-island gap", () => {
  const world = read("../../countries.json") as { id: string; iso_a3: string }[];
  const { unmatched } = joinRegions(outlines, world.map((c) => ({ ...c, tier: "country" as const })));
  assert.deepEqual(unmatched.map((c) => c.iso_a3).sort(), KNOWN_UNMATCHED);
});

test("every globe.json country joins to an outline or is listed as unmatched", { skip: !existsSync(new URL("../public/data/globe.json", import.meta.url)) }, () => {
  const g = parseGlobe(read("../public/data/globe.json"));
  const { unmatched } = joinRegions(outlines, g.regions);
  for (const r of unmatched) assert.ok(KNOWN_UNMATCHED.includes(r.iso_a3 ?? ""), `${r.id} (${r.iso_a3}) has no outline`);
});

test("areas: polygons from geoArea × R², boxes exact", () => {
  // reference land areas (km²); the 1:110m outlines are coarse, so within a few per cent
  near(areaKm2(byCode.get("GHA")!.geometry), 238_533, 0.04, "Ghana");
  near(areaKm2(byCode.get("AUS")!.geometry), 7_692_024, 0.03, "Australia");
  near(areaKm2(byCode.get("BRA")!.geometry), 8_515_767, 0.03, "Brazil");
  // French Guiana is split out of Natural Earth's France (scripts/globe/outlines.py): France = metropolitan + Corsica
  near(areaKm2(byCode.get("FRA")!.geometry), 551_695, 0.05, "metropolitan France");
  near(areaKm2(byCode.get("GUF")!.geometry), 83_534, 0.08, "French Guiana");
  // 1° × 1° at the equator: R² × (π/180) × sin(1°)
  near(bboxKm2([0, 0, 1, 1]), 12_363.7, 0.001);
  // the densified box polygon has the same area as the exact box (and is wound the way d3-geo reads as inside)
  near(areaKm2(bboxPolygon([-3.5, 4.5, 1.5, 11.5])), bboxKm2([-3.5, 4.5, 1.5, 11.5]), 0.002, "Ghana box");
  // a ring wound the wrong way still gives the small area, not the rest of the sphere
  const ring = bboxPolygon([10, 10, 12, 12]).coordinates[0];
  near(areaKm2({ type: "Polygon", coordinates: [[...ring].reverse()] }), bboxKm2([10, 10, 12, 12]), 0.002, "reversed");
  assert.equal(per1000(500, 250_000), 2);
  assert.equal(per1000(null, 1), null);
  assert.equal(per1000(5, null), null);
  assert.equal(per1000(5, 0), null);
});

test("logBins: 1-3-10 edges covering every value, fixed for all years", () => {
  const e = logBins([0.04, 2, null, 0, 950, -1]);
  assert.deepEqual(e, [0.03, 0.1, 0.3, 1, 3, 10, 30, 100, 300, 1000]);
  assert.equal(binOf(0.04, e), 0);
  assert.equal(binOf(0.1, e), 1);
  assert.equal(binOf(950, e), e.length - 2);
  assert.equal(binOf(5000, e), e.length - 2, "clamps high");
  assert.equal(binOf(0.001, e), 0, "clamps low");
  assert.equal(binOf(0, e), 0, "zero fire is the lowest bin, not no data");
  assert.equal(binOf(null, e), null);
  assert.deepEqual(logBins([]), [1, 10]);
  assert.deepEqual(logBins([5, 5]), [3, 10]);
});

test("colours: ramp ends on the stops, no data grey, non-significant trends neutral", () => {
  const c = ramp(5);
  assert.equal(c.length, 5);
  assert.equal(c[0], HEAT_STOPS[0]);
  assert.equal(c[4], HEAT_STOPS[HEAT_STOPS.length - 1]);
  assert.equal(heatColor(null, [1, 10], c), NO_DATA);
  assert.equal(trendBin({ slope_pct: -9, lo_pct: 0, hi_pct: 0, p: 0 }), 0);
  assert.equal(trendBin({ slope_pct: 0.5, lo_pct: 0, hi_pct: 0, p: 0 }), 3);
  assert.equal(trendBin({ slope_pct: 9, lo_pct: 0, hi_pct: 0, p: 0 }), 5);
  assert.equal(trendColor({ slope_pct: -1.12, lo_pct: 0, hi_pct: 0, p: 0.0017 }), TREND_STOPS[2]);
  assert.equal(trendColor({ slope_pct: -2.07, lo_pct: 0, hi_pct: 0, p: 0.3187 }), NEUTRAL);
  assert.equal(trendColor(null), NO_DATA);
});

test("fromAnnual: every published record in globe.json's shape (complete years, band before 2012 only)", () => {
  const index = read("../public/data/index.json") as { regions: { id: string; name: string; tier: string; bbox: number[] }[] };
  const recs = index.regions
    .filter((r) => existsSync(new URL(`../public/data/${r.id}/annual.json`, import.meta.url)))
    .map((r) => ({ r, a: read(`../public/data/${r.id}/annual.json`) as AnnualLike }));
  const years = completeYears(recs.map((x) => x.a));
  assert.equal(years[0], 2001);
  assert.equal(years.at(-1), 2025, "2026 is still running, so it is left out");
  let with2025 = 0;
  let withTrend = 0;
  for (const { r, a } of recs) {
    const g = fromAnnual(r, a, years);
    assert.equal(g.harmonized.length, years.length);
    // FE-030: a record that ends before 2025 (Andorra's FIRMS country archive stops in December 2024) has no 2025
    // value, which the globe shows as null ("no data"), not undefined; a still-running 2025 is left out the same way
    const i2025 = a.years.indexOf(2025);
    const has2025 = i2025 >= 0 && !a.partial[i2025];
    if (has2025) with2025++;
    assert.equal(g.harmonized.at(-1), has2025 ? a.harmonized[i2025] : null, `${r.id} 2025`);
    assert.equal(g.lo[years.indexOf(2011)], a.lo[a.years.indexOf(2011)], `${r.id} back-cast band`);
    assert.equal(g.lo[years.indexOf(2012)], null, `${r.id} no band once VIIRS observes`);
    // a sparse country's trend is all null in annual.json (too little fire to fit one): the globe says "no trend yet"
    const t = (a as { trend?: { harmonized?: { slope_pct?: unknown; p?: unknown } } }).trend?.harmonized;
    if (typeof t?.slope_pct === "number" && typeof t.p === "number") {
      withTrend++;
      assert.ok(g.trend && Number.isFinite(g.trend.slope_pct) && Number.isFinite(g.trend.p), `${r.id} trend`);
    } else assert.equal(g.trend, null, `${r.id} no trend`);
  }
  // the null branches above are exceptions: nearly every record has a 2025 total and a trend
  assert.ok(with2025 >= recs.length - 5 && withTrend >= recs.length - 10, `${with2025} with 2025, ${withTrend} with a trend, of ${recs.length}`);
});

test("parseGlobe checks the shape and pads series to the years", () => {
  assert.throws(() => parseGlobe({ schema: 2, years: [2001], regions: [] }), GlobeFormatError);
  assert.throws(() => parseGlobe({ schema: 1, years: [], regions: [] }), GlobeFormatError);
  assert.throws(() => parseGlobe({ schema: 1, years: [2001], regions: [{ name: "x" }] }), GlobeFormatError);
  const g = parseGlobe({
    schema: 1,
    years: [2001, 2002],
    regions: [{ id: "x", name: "X", tier: "country", iso_a3: "GHA", ship: "bogus", harmonized: [1], lo: null, trend: { slope_pct: 1 } }],
  });
  assert.deepEqual(g.regions[0].harmonized, [1, null]);
  assert.deepEqual(g.regions[0].lo, [null, null]);
  assert.equal(g.regions[0].ship, null);
  assert.equal(g.regions[0].trend, null, "a trend without p is dropped");
});

test("year rows and sorting: missing values last both ways, ties by name", () => {
  const place = (id: string, h: (number | null)[], km2: number | null, slope: number | null): PlaceRow => ({
    id,
    name: id.toUpperCase(),
    tier: "country",
    iso_a3: null,
    bbox: null,
    ship: "ratio",
    caveat: null,
    harmonized: h,
    lo: h.map(() => null),
    hi: h.map(() => null),
    trend: slope === null ? null : { slope_pct: slope, lo_pct: slope, hi_pct: slope, p: 0.01 },
    km2,
    onGlobe: km2 !== null,
  });
  const rows = yearRows([place("a", [10, 20], 1000, 1), place("b", [null, 5], null, null), place("c", [30, 40], 10_000, -2)], 1);
  assert.equal(rows[0].density, 20);
  assert.equal(rows[0].label, "constant-ratio estimate");
  assert.ok(rows[0].light);
  assert.equal(rows[1].density, null, "no outline, no area");
  assert.deepEqual(sortYearRows(rows, "density", "desc").map((r) => r.id), ["a", "c", "b"]);
  assert.deepEqual(sortYearRows(rows, "density", "asc").map((r) => r.id), ["c", "a", "b"]);
  assert.deepEqual(sortYearRows(rows, "trend", "asc").map((r) => r.id), ["c", "a", "b"]);
  assert.deepEqual(sortYearRows(rows, "name", "desc").map((r) => r.id), ["c", "b", "a"]);
});

test("URL state: year and view round-trip, bad values fall back", () => {
  const years = [2001, 2002, 2003];
  assert.deepEqual(parseGlobeState(new URLSearchParams(""), years), { year: 2003, view: "year" });
  assert.deepEqual(parseGlobeState(new URLSearchParams("year=2002&view=trend"), years), { year: 2002, view: "trend" });
  assert.deepEqual(parseGlobeState(new URLSearchParams("year=1999&view=x"), years), { year: 2003, view: "year" });
  assert.deepEqual(parseGlobeState(new URLSearchParams("year=2002.5"), years), { year: 2003, view: "year" });
  assert.equal(globeQuery({ year: 2003, view: "year" }, years), "");
  assert.equal(globeQuery({ year: 2001, view: "trend" }, years), "year=2001&view=trend");
  assert.equal(globeQuery({ year: 2001, view: "year" }, years, "region=punjab&year=2003&view=trend"), "region=punjab&year=2001");
  assert.equal(globeQuery({ year: 2003, view: "year" }, years, "?region=ghana&from=2010-01-01"), "region=ghana&from=2010-01-01");
  const s = { year: 2002, view: "trend" as const };
  assert.deepEqual(parseGlobeState(new URLSearchParams(globeQuery(s, years)), years), s);
});

test("words", () => {
  assert.equal(fmt(null), "–");
  assert.equal(fmt(123456.7), "123,457");
  assert.equal(fmt(1.234), "1.2");
  assert.equal(fmt(0.0345), "0.035");
  assert.equal(slopeText({ slope_pct: -1.12, lo_pct: 0, hi_pct: 0, p: 0 }), "-1.1% a year");
  assert.equal(slopeText({ slope_pct: 2, lo_pct: 0, hi_pct: 0, p: 0 }), "+2.0% a year");
});
