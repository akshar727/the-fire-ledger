// Run with `npm test`. FE-008: the region picker's groups and filtering, on the site's index.json and on a fixture
// with countries (none are published yet).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fold, groupRegions, PICKER_ITEMS, pickerItems } from "./region-picker.ts";
import { REGION_IDS, REGIONS } from "./regions.ts";

const fixture = pickerItems({
  regions: [
    { id: "portugal", name: "Mainland Portugal", short_name: "Portugal", tier: "region", first_year: 2001 },
    { id: "punjab", name: "NW India (Punjab, Haryana)", tier: "region", first_year: 2001 },
    { id: "india", name: "India", tier: "country", iso_a3: "IND", data_through: "2025-12-31", first_year: 2001, ship: "model" },
    { id: "argentina", name: "Argentina", tier: "country", iso_a3: "ARG", data_through: "2025-12-31", first_year: 2001, ship: "ratio" },
    { id: "cote-divoire", name: "Côte d'Ivoire", tier: "country", iso_a3: "CIV", data_through: "2025-12-31", first_year: 2001 },
    { id: "nauru", name: "Nauru", tier: "country", iso_a3: "NRU", data_through: "2025-12-31", first_year: 2001, ship: "sparse" },
    { id: "chad", name: "Chad", tier: "country", data_through: "2025-12-31" }, // no record yet: not listed
  ],
});
const ids = (q: string) => groupRegions(fixture, q).map((g) => [g.label, g.items.map((it) => it.id)]);

test("the site's picker lists every region with a record, under Deep dives only while there are no countries", () => {
  assert.deepEqual(PICKER_ITEMS.map((it) => it.id), [...REGION_IDS]);
  for (const it of PICKER_ITEMS) assert.equal(it.name, REGIONS[it.id]);
  const groups = groupRegions([...PICKER_ITEMS], "");
  assert.ok(groups.every((g) => g.items.length > 0), "no empty group");
  assert.equal(groups[0].label, "Deep dives");
});

test("empty query: deep dives in index order, then countries A to Z with their ship tag", () => {
  assert.deepEqual(ids(""), [
    ["Deep dives", ["portugal", "punjab"]],
    ["Countries", ["argentina", "cote-divoire", "india", "nauru"]],
  ]);
  const tag = Object.fromEntries(fixture.map((it) => [it.id, it.tag]));
  assert.deepEqual(tag, { portugal: null, punjab: null, india: null, argentina: "constant-ratio estimate", "cote-divoire": null, nauru: "too little fire to check" });
});

test("typing filters both groups; names starting with the text come first; empty groups vanish", () => {
  assert.deepEqual(ids("in"), [
    ["Deep dives", ["portugal", "punjab"]], // "Mainland Portugal", "NW India"
    ["Countries", ["india", "argentina"]],
  ]);
  assert.deepEqual(ids("  PORT "), [["Deep dives", ["portugal"]]]);
  assert.deepEqual(ids("zzz"), []);
});

test("full name, ISO code, id and accents all match", () => {
  assert.deepEqual(ids("mainland"), [["Deep dives", ["portugal"]]]);
  assert.deepEqual(ids("civ"), [["Countries", ["cote-divoire"]]]);
  assert.deepEqual(ids("cote d"), [["Countries", ["cote-divoire"]]]);
  assert.deepEqual(ids("haryana"), [["Deep dives", ["punjab"]]]);
  assert.equal(fold("Côte d'Ivoire"), "cote d'ivoire");
});
