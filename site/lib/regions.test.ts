// Run with `npm test`. DP-009 / DP-018: the region list is read from index.json alone; these tests check the site against
// that file, that its record fields match each region's annual.json, and the country notes on a fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  buildRegions,
  COUNTRY_NO_POINTS,
  countryNote,
  DEFAULT_REGION,
  FIRE_SEASON,
  FIRMS_COUNTRY_ARCHIVE,
  isCountry,
  isRegionId,
  REGION_CAVEAT,
  REGION_IDS,
  REGIONS,
  shipLabel,
  TIER,
} from "./regions.ts";

const url = (p: string) => new URL(`../public/data/${p}`, import.meta.url);
const read = (p: string) => JSON.parse(readFileSync(url(p), "utf8"));
type Row = { id: string; name: string; short_name?: string; tier?: string; first_year?: number; forward_through?: string | null; ship?: string };
const index = read("index.json") as { regions: Row[] };

test("the site lists every index.json region with a record, in index.json order", () => {
  const ids = index.regions.filter((r) => typeof r.first_year === "number").map((r) => r.id);
  assert.deepEqual([...REGION_IDS], ids);
  assert.deepEqual(Object.keys(REGIONS), ids);
  assert.deepEqual(Object.keys(FIRE_SEASON), ids);
  assert.deepEqual(Object.keys(TIER), ids);
  assert.equal(DEFAULT_REGION, ids[0]);
});

test("index.json record fields match each region's annual.json (rerun site_bundle.py after model.py)", () => {
  for (const r of index.regions) {
    if (!existsSync(url(`${r.id}/annual.json`))) {
      assert.equal(r.first_year, undefined, `${r.id}: record fields but no annual.json`);
      continue;
    }
    const a = read(`${r.id}/annual.json`);
    assert.equal(r.first_year, a.years[0], `${r.id} first_year`);
    assert.equal(r.forward_through ?? null, a.forward_through ?? null, `${r.id} forward_through`);
    if (r.tier === "country") assert.equal(r.ship, a.ship, `${r.id} ship`);
  }
});

test("no per-region bundle is published any more (DP-018)", () => {
  assert.equal(existsSync(url("annual-all.json")), false);
});

test("display names use short_name when there is one", () => {
  for (const r of index.regions.filter((x) => x.id in REGIONS)) assert.equal(REGIONS[r.id], r.short_name || r.name, r.id);
  assert.equal(REGIONS.punjab, "NW India (Punjab, Haryana)");
});

test("the three cell regions keep their page copy", () => {
  assert.equal(FIRE_SEASON.portugal, "Forest and shrub wildfire, peaking July to October.");
  assert.equal(FIRE_SEASON.ghana, "Savanna burning, peaking November to February.");
  assert.match(REGION_CAVEAT.punjab ?? "", /^Before July 2002 only the Terra satellite was flying/);
  assert.equal(REGION_CAVEAT.portugal, undefined);
  for (const id of ["portugal", "ghana", "punjab"]) assert.equal(TIER[id], "region", id);
  assert.equal(isCountry("ghana"), false);
});

test("a whole country says what it leaves out, and when its record ends", () => {
  const s = countryNote("2025-12-31");
  assert.match(s, /ending in December 2025\./);
  for (const w of ["per-detection download", "fire weather", "forward link", "burned-area check"]) assert.ok(s.includes(w), w);
});

const fixture = {
  regions: [
    { id: "ghana", name: "Ghana", tier: "region", season: "Savanna burning.", first_year: 2001 },
    { id: "greece", name: "Greece", tier: "country", season: "Summer wildfire.", data_through: "2025-12-31", first_year: 2001, ship: "ratio" },
    { id: "brazil", name: "Brazil", tier: "country", data_through: "2025-12-31", first_year: 2001, ship: "caveat", ship_caveat: "Cloudy in the wet season." },
    { id: "chad", name: "Chad", tier: "country", data_through: "2025-12-31", first_year: 2001, ship: "model" },
    { id: "nauru", name: "Nauru", tier: "country", data_through: "2025-12-31", first_year: 2001, ship: "sparse" },
    { id: "built-only", name: "Built, not modelled" },
  ],
};

test("buildRegions: countries get their tier, ship label and note; unmodelled regions are hidden", () => {
  const b = buildRegions(fixture);
  assert.deepEqual(b.ids, ["ghana", "greece", "brazil", "chad", "nauru"]);
  assert.deepEqual(b.tier, { ghana: "region", greece: "country", brazil: "country", chad: "country", nauru: "country" });
  assert.deepEqual(b.label, { greece: "constant-ratio estimate", nauru: "too little fire to check" });
  assert.equal(b.caveat.ghana, undefined);
  assert.match(b.caveat.greece!, /^Constant-ratio estimate: .* not the model\. Whole-country record .* ending in December 2025\./);
  assert.match(b.caveat.brazil!, /^Cloudy in the wet season\. Whole-country record/);
  assert.match(b.caveat.chad!, /^Whole-country record/);
  assert.match(b.caveat.nauru!, /^Too little fire to check: /);
  assert.equal(b.season.brazil, "");
  for (const s of Object.values(b.caveat)) assert.doesNotMatch(s ?? "", /[–—]/);
});

test("ship labels", () => {
  assert.equal(shipLabel("model"), null);
  assert.equal(shipLabel("caveat"), null);
  assert.equal(shipLabel(undefined), null);
  assert.equal(shipLabel("ratio"), "constant-ratio estimate");
  assert.equal(shipLabel("sparse"), "too little fire to check");
});

test("the hotspots answer for a country points at the FIRMS archive", () => {
  assert.ok(COUNTRY_NO_POINTS.includes(FIRMS_COUNTRY_ARCHIVE));
  assert.doesNotMatch(COUNTRY_NO_POINTS, /[–—]/);
});

test("isRegionId accepts only listed ids", () => {
  assert.ok(isRegionId("ghana"));
  for (const v of ["toString", "__proto__", "", "Ghana", null, 3]) assert.equal(isRegionId(v), false, String(v));
});

test("page copy has no en or em dashes", () => {
  for (const s of [...Object.values(REGIONS), ...Object.values(FIRE_SEASON), ...Object.values(REGION_CAVEAT), countryNote("2025-12-31")])
    assert.doesNotMatch(s ?? "", /[–—]/);
});
