// Run with `npm test`. DP-009: the region list is read from index.json + annual-all.json; these tests check the site
// against those files, and that annual-all.json is not stale against each region's own annual.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { buildRegions, countryNote, DEFAULT_REGION, FIRE_SEASON, isCountry, isRegionId, REGION_CAVEAT, REGION_IDS, REGIONS, TIER } from "./regions.ts";

const read = (p: string) => JSON.parse(readFileSync(new URL(`../public/data/${p}`, import.meta.url), "utf8"));
const index = read("index.json") as { regions: { id: string; name: string; short_name?: string; tier?: string }[] };
const bundle = read("annual-all.json") as Record<string, unknown>;

test("the site lists every modelled index.json region, in index.json order", () => {
  const ids = index.regions.map((r) => r.id).filter((id) => id in bundle);
  assert.deepEqual([...REGION_IDS], ids);
  assert.deepEqual(Object.keys(REGIONS), ids);
  assert.deepEqual(Object.keys(FIRE_SEASON), ids);
  assert.deepEqual(Object.keys(TIER), ids);
  assert.equal(DEFAULT_REGION, ids[0]);
});

test("annual-all.json holds index.json regions only, and leaves out only regions not modelled yet", () => {
  const ids = index.regions.map((r) => r.id);
  for (const id of Object.keys(bundle)) assert.ok(ids.includes(id), `${id} in annual-all.json but not in index.json`);
  for (const id of ids.filter((x) => !(x in bundle)))
    assert.ok(!existsSync(new URL(`../public/data/${id}/annual.json`, import.meta.url)), `${id}: annual.json exists, rerun site_bundle.py`);
});

test("annual-all.json matches each region's annual.json (rerun site_bundle.py after model.py)", () => {
  for (const id of Object.keys(bundle)) assert.deepEqual(bundle[id], read(`${id}/annual.json`), id);
});

test("display names use short_name when there is one", () => {
  for (const r of index.regions) assert.equal(REGIONS[r.id], r.short_name || r.name, r.id);
  assert.equal(REGIONS.punjab, "NW India (Punjab, Haryana)");
});

test("the three cell regions keep their page copy", () => {
  assert.equal(FIRE_SEASON.portugal, "Forest and shrub wildfire, peaking July to October.");
  assert.equal(FIRE_SEASON.ghana, "Savanna burning, peaking November to February.");
  assert.match(REGION_CAVEAT.punjab ?? "", /^Before July 2002 only the Terra satellite was flying/);
  assert.equal(REGION_CAVEAT.portugal, undefined);
  for (const id of ["portugal", "ghana", "punjab"]) assert.equal(TIER[id], "region", id);
});

test("tier comes from index.json and defaults to region", () => {
  for (const r of index.regions) assert.equal(TIER[r.id], r.tier === "country" ? "country" : "region", r.id);
  assert.equal(isCountry("ghana"), false);
});

test("a whole country says what it leaves out, and when its record ends", () => {
  const s = countryNote("2025-12-31");
  assert.match(s, /ending in December 2025\./);
  for (const w of ["per-detection download", "fire weather", "forward link", "burned-area check"]) assert.ok(s.includes(w), w);
  for (const r of index.regions.filter((x) => x.tier === "country")) assert.ok(REGION_CAVEAT[r.id]?.includes("Whole-country record"), r.id);
});

const fixture = {
  regions: [
    { id: "ghana", name: "Ghana", tier: "region", season: "Savanna burning." },
    { id: "greece", name: "Greece", tier: "country", season: "Summer wildfire.", data_through: "2025-12-31" },
    { id: "brazil", name: "Brazil", tier: "country", data_through: "2025-12-31" },
    { id: "chad", name: "Chad", tier: "country", data_through: "2025-12-31" },
    { id: "built-only", name: "Built, not modelled" },
  ],
};
const fixtureBundle = { ghana: {}, greece: { ship: "ratio" }, brazil: { ship: "caveat", caveat: "Cloudy in the wet season." }, chad: { ship: "model" } };

test("buildRegions: countries get their tier, ship sentence and what they leave out; unmodelled regions are hidden", () => {
  const b = buildRegions(fixture, fixtureBundle);
  assert.deepEqual(b.ids, ["ghana", "greece", "brazil", "chad"]);
  assert.deepEqual(b.tier, { ghana: "region", greece: "country", brazil: "country", chad: "country" });
  assert.equal(b.caveat.ghana, undefined);
  assert.match(b.caveat.greece!, /^The harmonized line here is a constant-ratio estimate .* not the model\. Whole-country record .* ending in December 2025\./);
  assert.match(b.caveat.brazil!, /^Cloudy in the wet season\. Whole-country record/);
  assert.match(b.caveat.chad!, /^Whole-country record/);
  assert.equal(b.season.brazil, "");
  for (const s of Object.values(b.caveat)) assert.doesNotMatch(s ?? "", /[–—]/);
});

test("isRegionId accepts only listed ids", () => {
  assert.ok(isRegionId("ghana"));
  for (const v of ["toString", "__proto__", "", "Ghana", null, 3]) assert.equal(isRegionId(v), false, String(v));
});

test("page copy has no en or em dashes", () => {
  for (const s of [...Object.values(REGIONS), ...Object.values(FIRE_SEASON), ...Object.values(REGION_CAVEAT), countryNote("2025-12-31")])
    assert.doesNotMatch(s ?? "", /[–—]/);
});
