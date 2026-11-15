// Run with `npm test` (Node's built-in test runner; Node >= 23.6 strips the TypeScript types).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  buildGrid,
  compact,
  monthSpan,
  parseSeries,
  periodLabel,
  rampColor,
  rampPosition,
  remapColumn,
  SeriesFormatError,
  sliceGrid,
  times,
  weekMonthGroups,
  weekSpan,
} from "./series.ts";

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

test("sliceGrid keeps the touched years and marks months outside the dates", () => {
  const g = buildGrid(parseSeries(fixture));
  const s = sliceGrid(g, "2017-06-15", "2018-02-01");
  assert.deepEqual(s.years, [2017, 2018]);
  assert.deepEqual(s.rows[0].map((c) => c.inRange), [false, false, false, false, false, true, true, true, true, true, true, true]);
  assert.deepEqual(s.rows[1].map((c) => c.inRange), [true, true, false, false, false, false, false, false, false, false, false, false]);
  // colours and the latest-month card still describe the whole record
  assert.equal(s.max, g.max);
  assert.equal(s.latest, g.latest);
  assert.ok(g.rows.flat().every((c) => c.inRange));
});

// FE-016: week view. A synthetic weekly series: 2001-2002 complete, 2003 stops in week 9 after 3 days.
const withWeekly = (n = 52 * 2 + 10, lastDays = 3) => {
  const b = structuredClone(fixture);
  const val = (i: number) => 10 + i;
  b.weekly = {
    start_year: 2001,
    weeks_per_year: 52,
    modis: Array.from({ length: n }, (_, i) => i),
    viirs: Array.from({ length: n }, (_, i) => (i < 60 ? null : val(i))),
    pred: Array.from({ length: n }, (_, i) => val(i) + 0.5),
    lo: Array.from({ length: n }, () => 1),
    hi: Array.from({ length: n }, () => 99),
    last_week_days: lastDays,
  };
  return b;
};

test("weekSpan / monthSpan follow the Series bundle definition", () => {
  assert.deepEqual(weekSpan(2001, 0), { start: "2001-01-01", end: "2001-01-07", length: 7 });
  assert.deepEqual(weekSpan(2001, 51), { start: "2001-12-24", end: "2001-12-31", length: 8 });
  assert.deepEqual(weekSpan(2004, 51), { start: "2004-12-23", end: "2004-12-31", length: 9 });
  // day-of-year 274: 1 Oct in a common year, 30 Sep in a leap year
  assert.equal(weekSpan(2001, 39).start, "2001-10-01");
  assert.equal(weekSpan(2004, 39).start, "2004-09-30");
  assert.deepEqual(monthSpan(2004, 2), { start: "2004-02-01", end: "2004-02-29", length: 29 });
  assert.deepEqual(monthSpan(2001, 12), { start: "2001-12-01", end: "2001-12-31", length: 31 });
});

test("weekMonthGroups covers the 52 weeks once, in order", () => {
  const g = weekMonthGroups();
  assert.equal(g.length, 12);
  assert.equal(g.reduce((s, x) => s + x.span, 0), 52);
  assert.equal(g[0].first, 0);
  g.forEach((x, i) => i > 0 && assert.equal(x.first, g[i - 1].first + g[i - 1].span));
  assert.ok(g.every((x) => x.span === 4 || x.span === 5));
});

test("week grid: years x 52, harmonized = viirs ?? pred, partial last week, later weeks empty", () => {
  const b = parseSeries(withWeekly());
  const g = buildGrid(b, "week");
  assert.equal(g.view, "week");
  assert.equal(g.cols, 52);
  assert.deepEqual(g.years, [2001, 2002, 2003]);
  assert.ok(g.rows.every((r) => r.length === 52));
  const w0 = g.rows[0][0], w60 = g.rows[1][8];
  assert.equal(w0.value, b.weekly!.pred[0]);
  assert.equal(w0.observed, false);
  assert.equal(w60.index, 60);
  assert.equal(w60.value, b.weekly!.viirs[60]);
  assert.equal(g.firstObserved?.index, 60);
  assert.equal(w60.week, 8);
  assert.equal(w60.month, 2); // 2002 week 8 starts 26 Feb
  const last = g.rows[2][9];
  assert.equal(last.partial, true);
  assert.equal(last.days, 3);
  assert.equal(last.length, 7);
  assert.equal(last.start, "2003-03-05");
  assert.equal(last.through, "2003-03-07");
  assert.equal(g.latest, last);
  assert.equal(g.rows[2][10].value, null);
  assert.equal(g.rows[2][10].partial, false);
  assert.deepEqual(g.partialYears, [2003]);
  assert.ok(g.rows.flat().every((c) => c.flag === 0 && c.anomaly === null), "monthly statistics never leak into weeks");
  assert.ok(g.rows.flat().filter((c) => c !== last).every((c) => !c.partial));
});

test("week grid: a complete last week is not partial; a year that ends exactly on week 51 is not partial", () => {
  const g = buildGrid(parseSeries(withWeekly(52 * 2, 8)), "week");
  assert.deepEqual(g.years, [2001, 2002]);
  assert.equal(g.latest?.partial, false); // 2002 week 51 has 8 days
  assert.deepEqual(g.partialYears, []);
});

test("month grid cells carry their dates and are never partial", () => {
  const g = buildGrid(parseSeries(fixture));
  assert.equal(g.view, "month");
  assert.equal(g.cols, 12);
  const feb2004 = g.rows[3][1];
  assert.equal(feb2004.start, "2004-02-01");
  assert.equal(feb2004.end, "2004-02-29");
  assert.equal(feb2004.through, "2004-02-29");
  assert.equal(feb2004.week, null);
  assert.equal(feb2004.col, 1);
  assert.ok(g.rows.flat().every((c) => !c.partial));
});

test("week grid needs the weekly series", () => {
  assert.throws(() => buildGrid(parseSeries(fixture), "week"), SeriesFormatError);
});

test("parser checks the weekly section when present", () => {
  const bad = (mutate: (b: ReturnType<typeof withWeekly>) => void) => {
    const b = withWeekly();
    mutate(b);
    return () => parseSeries(b);
  };
  assert.doesNotThrow(bad(() => {}));
  assert.throws(bad((b) => (b.weekly.weeks_per_year = 53)), SeriesFormatError);
  assert.throws(bad((b) => b.weekly.pred.pop()), SeriesFormatError);
  assert.throws(bad((b) => (b.weekly.last_week_days = 0)), SeriesFormatError);
  assert.throws(bad((b) => (b.weekly.last_week_days = 10)), SeriesFormatError);
  assert.throws(bad((b) => (b.weekly.modis = [])), SeriesFormatError);
  assert.throws(bad((b) => (b.weekly.viirs[0] = "x")), SeriesFormatError);
});

test("sliceGrid on weeks: a week is inside if any of its days is", () => {
  const g = buildGrid(parseSeries(withWeekly()), "week");
  const s = sliceGrid(g, "2001-01-10", "2001-01-15");
  assert.deepEqual(s.years, [2001]);
  assert.deepEqual(s.rows[0].slice(0, 4).map((c) => c.inRange), [false, true, true, false]);
  assert.ok(s.rows[0].slice(3).every((c) => !c.inRange));
  // the last week of a year (8 days) is inside when only its last day is selected
  const end = sliceGrid(g, "2001-12-31", "2001-12-31");
  assert.deepEqual(end.rows[0].map((c, i) => (c.inRange ? i : -1)).filter((i) => i >= 0), [51]);
  assert.equal(s.max, g.max);
});

test("periodLabel names months and weeks", () => {
  const g = buildGrid(parseSeries(withWeekly()), "week");
  assert.equal(periodLabel(g.rows[0][0]), "1 Jan to 7 Jan 2001");
  assert.equal(periodLabel(g.rows[0][4]), "29 Jan to 4 Feb 2001");
  assert.equal(periodLabel(g.rows[0][51]), "24 Dec to 31 Dec 2001");
  assert.equal(periodLabel(buildGrid(parseSeries(fixture)).rows[16][9]), "October 2017");
});

for (const region of ["portugal", "ghana", "punjab"]) {
  const url = new URL(`../public/data/${region}/series.json`, import.meta.url);
  test(`published ${region} weekly series draws a week grid`, { skip: !existsSync(url) }, () => {
    const b = parseSeries(JSON.parse(readFileSync(url, "utf8")));
    assert.ok(b.weekly, "weekly section is missing");
    const g = buildGrid(b, "week");
    assert.equal(g.years[0], b.weekly.start_year);
    assert.equal(g.years.length, Math.ceil(b.weekly.modis.length / 52));
    assert.ok(g.max > 0);
    // VIIRS S-NPP starts 2012-01-20: week 2 (15-21 Jan) is back-cast, week 3 (from 22 Jan) observed
    assert.equal(g.firstObserved?.year, 2012);
    assert.equal(g.firstObserved?.week, 3);
    const latest = g.latest!;
    assert.equal(latest.index, b.weekly.modis.length - 1);
    assert.equal(latest.days, Math.min(b.weekly.last_week_days, latest.length));
    assert.equal(latest.partial, b.weekly.last_week_days < latest.length);
    // every period before the last has full days
    assert.ok(g.rows.flat().filter((c) => c.value != null && c !== latest).every((c) => !c.partial));
  });
}

test("remapColumn maps months and weeks both ways", () => {
  assert.equal(remapColumn(0, "week"), 0);
  assert.equal(remapColumn(0, "month"), 0);
  assert.equal(remapColumn(51, "month"), 11);
  assert.equal(remapColumn(39, "month"), 9); // week 39 starts 1 Oct in a common year
  assert.equal(remapColumn(9, "week"), 39);
  for (let m = 0; m < 12; m++) assert.equal(remapColumn(remapColumn(m, "week"), "month"), m);
  for (let w = 0; w < 52; w++) assert.equal(remapColumn(w, "month"), Number(weekSpan(2001, w).start.slice(5, 7)) - 1);
});
