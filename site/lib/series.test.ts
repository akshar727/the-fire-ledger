// Run with `npm test` (Node's built-in test runner; Node >= 23.6 strips the TypeScript types).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { buildGrid, compact, parseSeries, rampColor, rampPosition, SeriesFormatError, times } from "./series.ts";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/series.portugal.sample.json", import.meta.url), "utf8"));

test("the sample fixture matches the Series bundle contract", () => {
  const b = parseSeries(fixture);
  assert.equal(b.region, "portugal");
  assert.equal(b.monthly.modis.length, 300);
});

test("grid: years x 12, harmonized = viirs ?? pred, observed flag", () => {
  const g = buildGrid(parseSeries(fixture));
  assert.equal(g.years[0], 2001);
  assert.equal(g.years.at(-1), 2025);
  assert.ok(g.rows.every((r) => r.length === 12));
  const jan2001 = g.rows[0][0], jan2012 = g.rows[11][0];
  assert.equal(jan2001.value, fixture.monthly.pred[0]);
  assert.equal(jan2001.observed, false);
  assert.equal(jan2012.value, fixture.monthly.viirs[132]);
  assert.equal(jan2012.observed, true);
  assert.deepEqual(g.partialYears, []);
  assert.equal(g.latest?.year, 2025);
  assert.equal(g.latest?.month, 12);
  assert.equal(g.firstObserved?.index, fixture.monthly.viirs.findIndex((v: number | null) => v != null));
});

test("grid: a series ending mid-year marks that year partial and leaves later months empty", () => {
  const short = structuredClone(fixture);
  for (const k of ["modis", "viirs", "pred", "lo", "hi"]) short.monthly[k] = short.monthly[k].slice(0, 290);
  for (const k of ["anomaly", "flag"]) short.calendar[k] = short.calendar[k].slice(0, 290);
  const g = buildGrid(parseSeries(short));
  assert.deepEqual(g.partialYears, [2025]);
  assert.equal(g.rows[24][1].value, fixture.monthly.viirs[289]);
  assert.equal(g.rows[24][2].value, null);
  assert.equal(g.latest?.month, 2);
});

test("calendar section is optional", () => {
  const noCal = structuredClone(fixture);
  delete noCal.calendar;
  const g = buildGrid(parseSeries(noCal));
  assert.ok(g.rows.flat().every((c) => c.flag === 0 && c.anomaly === null));
});

test("parser rejects contract violations", () => {
  const bad = (mutate: (b: typeof fixture) => void) => {
    const b = structuredClone(fixture);
    mutate(b);
    return () => parseSeries(b);
  };
  assert.throws(bad((b) => (b.schema = 2)), SeriesFormatError);
  assert.throws(bad((b) => b.monthly.pred.pop()), SeriesFormatError);
  assert.throws(bad((b) => (b.monthly.modis[3] = null)), SeriesFormatError);
  assert.throws(bad((b) => (b.calendar.flag[0] = 2)), SeriesFormatError);
  assert.throws(bad((b) => b.calendar.month_median.pop()), SeriesFormatError);
  assert.throws(bad((b) => delete b.monthly.bucketing), SeriesFormatError);
  assert.throws(bad((b) => (b.calendar.baseline_years = [2001])), SeriesFormatError);
  assert.doesNotThrow(bad((b) => (b.calendar.anomaly[0] = null)));
  assert.throws(() => parseSeries("nope"), SeriesFormatError);
});

test("ramp: log position, monotonic lightness in both modes", () => {
  assert.equal(rampPosition(0, 100), 0);
  assert.equal(rampPosition(100, 100), 1);
  assert.ok(rampPosition(10, 1000) > 0.3);
  for (const mode of ["light", "dark"] as const) {
    const ls = [0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => rampColor(t, mode).lightness);
    const sorted = [...ls].sort((a, b) => (mode === "light" ? b - a : a - b));
    assert.deepEqual(ls, sorted);
  }
});

test("ramp: cell labels clear WCAG AA 4.5:1 at every position in both modes", () => {
  for (const mode of ["light", "dark"] as const)
    for (let i = 0; i <= 200; i++) assert.ok(rampColor(i / 200, mode).contrast >= 4.5, `${mode} t=${i / 200}`);
});

test("compact labels", () => {
  assert.equal(compact(46.4), "46");
  assert.equal(compact(1513), "1.5k");
  assert.equal(compact(2000), "2k");
  assert.equal(compact(18578), "19k");
});

test("ratio labels", () => {
  assert.equal(times(0.1787), "0.18×");
  assert.equal(times(1), "1.0×");
  assert.equal(times(2.44), "2.4×");
  assert.equal(times(12.6), "13×");
});

// The model's real exports (site/public/data/<region>/series.json, written by model.py). Skipped for a region whose
// file isn't there, so a fresh checkout without outputs still passes.
for (const region of ["portugal", "ghana", "punjab"]) {
  const url = new URL(`../public/data/${region}/series.json`, import.meta.url);
  test(`published ${region} series.json passes the parser and has calendar statistics`, { skip: !existsSync(url) }, () => {
    const b = parseSeries(JSON.parse(readFileSync(url, "utf8")));
    assert.equal(b.region, region);
    assert.ok(b.calendar, "calendar section (ML-005) is missing");
    const g = buildGrid(b);
    assert.equal(g.years[0], b.monthly.start_year);
    assert.ok(g.max > 0);
    assert.ok(g.latest && g.firstObserved);
    // VIIRS S-NPP's first day is 2012-01-20, so January 2012 is still back-cast and February 2012 is observed
    assert.equal(g.firstObserved.year, 2012);
    assert.equal(g.firstObserved.month, 2);
  });
}
