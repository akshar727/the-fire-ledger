// Run with `npm test`. FE-031: the overpass drift helpers, on a fixture and on the published deep dives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clock, driftedYears, driftSummary, linePath, runs, shiftText, type OverpassSource } from "./overpass.ts";

const read = (p: string) => JSON.parse(readFileSync(new URL(`../public/data/${p}`, import.meta.url), "utf8"));

test("clock and shiftText", () => {
  assert.equal(clock(10.667), "10:40");
  assert.equal(clock(9.163), "9:10");
  assert.equal(clock(13.999), "14:00");
  assert.equal(shiftText(-1.62), "about 1.5 hours");
  assert.equal(shiftText(1.8), "about 2 hours");
  assert.equal(shiftText(0.83), "about 50 minutes");
  assert.equal(shiftText(0.99), "about 1 hour");
  assert.equal(shiftText(1.0), "about 1 hour");
  assert.equal(shiftText(1.72), "about 1.5 hours");
  assert.equal(shiftText(0.01), "about 5 minutes");
});

test("runs splits drifted years into contiguous bands", () => {
  assert.deepEqual(runs([2010, 2024, 2025, 2026]), [[2010, 2010], [2024, 2026]]);
  assert.deepEqual(runs([]), []);
});

test("driftSummary: training mean against the last year, over every record; countries without overpass skipped", () => {
  const a: OverpassSource = { years: [2012, 2013, 2026], overpass: { terra: [11, 10, 9], aqua: [13, 13, 15] }, drifted: [0, 0, 1] };
  const b: OverpassSource = { years: [2012, 2013, 2026], overpass: { terra: [11, 12, 9.5], aqua: [null, 13, 14] }, drifted: [0, 1, 1] };
  const country: OverpassSource = { years: [2012, 2013], overpass: null };
  const d = driftSummary([a, b, country], [2012, 2019])!;
  assert.equal(d.year, 2026);
  assert.deepEqual(d.terra, { base: 11, last: 9.25, shift: -1.75 });
  assert.deepEqual(d.aqua, { base: 13, last: 14.5, shift: 1.5 });
  assert.deepEqual(driftedYears([a, b, country]), [2013, 2026]);
  assert.equal(driftSummary([country], [2012, 2019]), null);
});

test("linePath breaks at gaps", () => {
  const x = (y: number) => y - 2000;
  const y = (h: number) => h * 10;
  assert.equal(linePath([2001, 2002, 2003, 2004], [1, null, 2, 3], x, y), "M1.0 10.0M3.0 20.0L4.0 30.0");
  assert.equal(linePath([2001], [null], x, y), "");
});

test("the published deep dives: Terra earlier and Aqua later than in the training years", () => {
  const index = read("index.json") as { regions: { id: string; tier: string }[] };
  const recs = index.regions.filter((r) => r.tier === "region").map((r) => read(`${r.id}/annual.json`) as OverpassSource);
  assert.ok(recs.length > 0 && recs.every((r) => r.overpass));
  const d = driftSummary(recs, [2012, 2019])!;
  assert.ok(d.terra && d.terra.shift < -1, `Terra moved ${d.terra?.shift}`);
  assert.ok(d.aqua && d.aqua.shift > 1, `Aqua moved ${d.aqua?.shift}`);
  assert.ok(driftedYears(recs).length > 0);
});
