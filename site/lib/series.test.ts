import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  buildGrid,
  compact,
  monthSpan,
  monthToDate,
  parseSeries,
  periodLabel,
  rampColor,
  rampPosition,
  remapColumn,
  SeriesFormatError,
  sliceGrid,
  times,
  weekMonthGroups,
  weeklyWindow,
  weekSpan,
  dayAtShare,
  driftDays,
  seasonTiming,
  timingDrift,
  timingSentence,
  type SeasonCum,
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
  assert.equal(s.max, g.max);
  assert.equal(s.latest, g.latest);
  assert.ok(g.rows.flat().every((c) => c.inRange));
});

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
  assert.equal(w60.month, 2);
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
  assert.equal(g.latest?.partial, false);
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

test("month grid: monthly.last_month_days marks the last month partial (ML-017, forward month to date)", () => {
  const b = structuredClone(fixture);
  b.monthly.last_month_days = 14;
  const g = buildGrid(parseSeries(b));
  const last = g.latest!;
  assert.equal(last.index, 299);
  assert.equal(last.days, 14);
  assert.equal(last.through, "2025-12-14");
  assert.equal(last.partial, true);
  assert.deepEqual(g.partialYears, [2025]);
  assert.ok(g.rows.flat().filter((c) => c !== last).every((c) => !c.partial));
  b.monthly.last_month_days = 31;
  assert.equal(buildGrid(parseSeries(b)).latest?.partial, false);
});

test("parser checks monthly.source, weekly.source and monthly.last_month_days when present", () => {
  const bad = (mutate: (b: ReturnType<typeof withWeekly>) => void) => {
    const b = withWeekly();
    mutate(b);
    return () => parseSeries(b);
  };
  const src = (n: number) => Array.from({ length: n }, (_, i) => (i < 5 ? "backcast" : "observed"));
  assert.doesNotThrow(bad((b) => ((b.monthly.source = src(300)), (b.weekly.source = src(b.weekly.modis.length)))));
  assert.doesNotThrow(bad((b) => (b.monthly.last_month_days = 31)));
  assert.throws(bad((b) => (b.monthly.source = src(299))), SeriesFormatError);
  assert.throws(bad((b) => (b.monthly.source = [...src(299), "model"])), SeriesFormatError);
  assert.throws(bad((b) => (b.weekly.source = src(3))), SeriesFormatError);
  assert.throws(bad((b) => (b.monthly.last_month_days = 0)), SeriesFormatError);
  assert.throws(bad((b) => (b.monthly.last_month_days = 32)), SeriesFormatError);
});

const forwardBundle = (opts: { lastDays?: number; weekly?: boolean; calendar?: boolean } = {}) => {
  const { lastDays = 14, weekly = true, calendar = false } = opts;
  const nm = 12 * 3 + 11, nw = 52 * 3 + 46;
  const src = (n: number, fwd: number) => Array.from({ length: n }, (_, i) => (i < 5 ? "backcast" : i >= n - fwd ? "forward" : "observed"));
  const b: Record<string, unknown> = {
    schema: 1,
    region: "test",
    monthly: {
      start_year: 2001,
      bucketing: "calendar-month-day-share",
      modis: Array.from({ length: nm }, () => 1),
      viirs: Array.from({ length: nm }, (_, i) => (i < 5 || i === nm - 1 ? null : 30)),
      pred: Array.from({ length: nm }, (_, i) => (i === nm - 1 ? 28 : 31)),
      lo: Array.from({ length: nm }, () => 1),
      hi: Array.from({ length: nm }, () => 99),
      source: src(nm, 1),
      last_month_days: lastDays,
    },
  };
  if (weekly)
    b.weekly = {
      start_year: 2001,
      weeks_per_year: 52,
      modis: Array.from({ length: nw }, () => 1),
      viirs: Array.from({ length: nw }, () => null),
      pred: Array.from({ length: nw }, (_, i) => (i % 52 === 51 ? 8 : 7)),
      lo: Array.from({ length: nw }, () => 1),
      hi: Array.from({ length: nw }, () => 99),
      source: src(nw, 2),
      last_week_days: 3,
    };
  if (calendar)
    b.calendar = {
      baseline_years: [2002, 2003],
      month_median: Array(12).fill(30),
      month_p25: Array(12).fill(20),
      month_p75: Array(12).fill(40),
      anomaly: Array.from({ length: nm }, (_, i) => (i === nm - 1 ? null : 1)),
      flag: Array(nm).fill(0),
    };
  return parseSeries(b);
};

test("cells carry their source; firstForward is the first forward period (FE-009)", () => {
  const g = buildGrid(forwardBundle());
  assert.deepEqual([g.rows[0][0].source, g.rows[0][5].source, g.latest!.source], ["backcast", "observed", "forward"]);
  assert.equal(g.firstForward, g.latest);
  assert.equal(g.firstForward?.month, 11);
  const wk = buildGrid(forwardBundle(), "week");
  assert.equal(wk.firstForward?.week, 44);
  const old = buildGrid(parseSeries(fixture));
  assert.equal(old.firstForward, null);
  assert.ok(old.rows.flat().every((c) => c.value == null || c.source === (c.observed ? "observed" : "backcast")));
});

test("weeklyWindow sums the weeks by the share of their days in the window", () => {
  const w = forwardBundle().weekly!;
  assert.equal(weeklyWindow(w, 2002, 11, 1, 14), 14);
  assert.equal(weeklyWindow(w, 2002, 11, 1, 30), 30);
  assert.equal(weeklyWindow(w, 2002, 12, 1, 31), 31);
  assert.equal(weeklyWindow(w, 2004, 11, 1, 30), null);
  const s = structuredClone(forwardBundle());
  s.weekly!.pred[52 + 43] = 70;
  assert.equal(weeklyWindow(s.weekly!, 2002, 11, 1, 14), 40 + 7 + 3);
  assert.equal(weeklyWindow(s.weekly!, 2002, 10, 1, 31), 28 + 30);
});

test("monthToDate: this month so far against the same days in past years (FE-009)", () => {
  const r = monthToDate(forwardBundle())!;
  assert.deepEqual(
    { year: r.year, month: r.month, days: r.days, value: r.value, median: r.median, ratio: r.ratio, years: r.years, n: r.n },
    { year: 2004, month: 11, days: 14, value: 28, median: 14, ratio: 2, years: [2001, 2003], n: 3 },
  );
  assert.deepEqual([r.p25, r.p75], [14, 14]);
  assert.deepEqual(r.recent, [2001, 2002, 2003].map((year) => ({ year, value: 14 })));
  assert.deepEqual(monthToDate(forwardBundle({ calendar: true }))!.years, [2002, 2003]);
  assert.equal(monthToDate(forwardBundle({ lastDays: 30 })), null);
  assert.equal(monthToDate(forwardBundle({ weekly: false })), null);
  assert.equal(monthToDate(parseSeries(fixture)), null);
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
    assert.equal(g.firstObserved?.year, 2012);
    assert.equal(g.firstObserved?.week, 3);
    const latest = g.latest!;
    assert.equal(latest.index, b.weekly.modis.length - 1);
    assert.equal(latest.days, Math.min(b.weekly.last_week_days, latest.length));
    assert.equal(latest.partial, b.weekly.last_week_days < latest.length);
    assert.ok(g.rows.flat().filter((c) => c.value != null && c !== latest).every((c) => !c.partial));
  });
  test(`published ${region} month grid: source per month, last month to date (ML-017)`, { skip: !existsSync(url) }, () => {
    const b = parseSeries(JSON.parse(readFileSync(url, "utf8")));
    const m = b.monthly, n = m.modis.length;
    if (!m.source) return;
    assert.equal(m.source.length, n);
    m.source.forEach((s, i) => assert.equal(s === "observed", m.viirs[i] != null, `month ${i}`));
    const latest = buildGrid(b).latest!;
    assert.equal(latest.index, n - 1);
    assert.equal(latest.days, Math.min(m.last_month_days ?? latest.length, latest.length));
    if (m.source[n - 1] === "forward") assert.equal(b.calendar?.anomaly[n - 1] ?? null, null);
  });
  test(`published ${region}: weekly day shares give the monthly values back; month to date (FE-009)`, { skip: !existsSync(url) }, () => {
    const b = parseSeries(JSON.parse(readFileSync(url, "utf8")));
    const m = b.monthly, w = b.weekly!;
    for (const i of [24, 100, 150, 200, 250, 300]) {
      const y = m.start_year + Math.floor(i / 12), mo = (i % 12) + 1;
      const v = weeklyWindow(w, y, mo, 1, monthSpan(y, mo).length)!;
      const want = m.viirs[i] ?? m.pred[i];
      assert.ok(Math.abs(v - want) <= 0.5 + want * 0.001, `${y}-${mo}: ${v} vs ${want}`);
    }
    const r = monthToDate(b);
    if (m.last_month_days == null || !m.source || m.source.at(-1) !== "forward") return;
    assert.ok(r, "a partial forward month gets a month-to-date comparison");
    assert.equal(r.days, m.last_month_days);
    assert.equal(r.value, m.viirs.at(-1) ?? m.pred.at(-1));
    assert.ok(r.median > 0 && r.p25 <= r.median && r.median <= r.p75);
    assert.equal(r.n, r.years[1] - r.years[0] + 1);
  });
}

test("remapColumn maps months and weeks both ways", () => {
  assert.equal(remapColumn(0, "week"), 0);
  assert.equal(remapColumn(0, "month"), 0);
  assert.equal(remapColumn(51, "month"), 11);
  assert.equal(remapColumn(39, "month"), 9);
  assert.equal(remapColumn(9, "week"), 39);
  for (let m = 0; m < 12; m++) assert.equal(remapColumn(remapColumn(m, "week"), "month"), m);
  for (let w = 0; w < 52; w++) assert.equal(remapColumn(w, "month"), Number(weekSpan(2001, w).start.slice(5, 7)) - 1);
});

const cumOf = (weekly: number[]) => weekly.reduce<number[]>((a, v) => [...a, (a.at(-1) ?? 0) + v], []);
const season = (year: number, startWeek: number, from: number, to: number): SeasonCum => ({
  year,
  label: String(year),
  start: weekSpan(year, startWeek).start,
  cum: cumOf(Array.from({ length: 52 }, (_, k) => (k >= from && k <= to ? 10 : 0))),
});

test("dayAtShare interpolates inside the crossing week", () => {
  const cum = cumOf(Array(52).fill(7));
  assert.ok(Math.abs(dayAtShare(cum, 2001, 0, 0.1)! - 36.4) < 1e-9);
  assert.ok(Math.abs(dayAtShare(cum, 2001, 0, 0.5)! - 182) < 1e-9);
  const one = cumOf(Array.from({ length: 52 }, (_, k) => (k === 10 ? 50 : 0)));
  for (const q of [0.1, 0.5, 0.9]) assert.ok(dayAtShare(one, 2001, 0, q)! > 70 && dayAtShare(one, 2001, 0, q)! <= 77);
  assert.equal(dayAtShare(Array(52).fill(0), 2001, 0, 0.5), null);
  const edge = { year: 2001, label: "2001", start: "2001-01-01", cum: cumOf([...Array(30).fill(1), ...Array(22).fill(0)]) };
  assert.equal(seasonTiming([edge], 0)[0].days[0], 20);
});

test("dayAtShare counts week 51's 8 or 9 days when the season crosses New Year", () => {
  const cum = cumOf(Array.from({ length: 52 }, (_, k) => (k === 2 ? 70 : 0)));
  assert.ok(Math.abs(dayAtShare(cum, 2004, 50, 0.5)! - (7 + 9 + 3.5)) < 1e-9);
});

test("seasonTiming gives the three dates and skips partial or fire-free seasons", () => {
  const rows = seasonTiming(
    [season(2001, 40, 10, 19), { ...season(2002, 40, 10, 19), cum: season(2002, 40, 10, 19).cum.slice(0, 30) }, season(2003, 40, 60, 60)],
    40,
  );
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.start, "2001-10-08");
  assert.equal(r.total, 100);
  assert.deepEqual(r.days, [76, 105, 133]);
  assert.deepEqual(r.dates, ["2001-12-23", "2002-01-21", "2002-02-18"]);
});

test("timingDrift finds a season that starts later every year, and none in a fixed one", () => {
  const later = seasonTiming(Array.from({ length: 20 }, (_, i) => season(2001 + i, 30, 5 + Math.floor(i / 2), 15 + Math.floor(i / 2))), 30);
  const d = timingDrift(later, 0)!;
  assert.ok(Math.abs(d.perDecade - 35) < 1e-9, String(d.perDecade));
  assert.ok(d.p < 0.001 && d.lo > 0);
  assert.match(timingSentence(later, "Testland"), /^Onset is drifting in Testland: across 20 whole seasons \(2001 to 2020\) the first 10% of the season's fire arrives 35 days later per decade \(90% interval \+35 to \+35\), a consistent shift;/);
  const fixed = seasonTiming(Array.from({ length: 20 }, (_, i) => season(2001 + i, 30, 5, 15)), 30);
  const f = timingDrift(fixed, 0)!;
  assert.equal(f.perDecade, 0);
  assert.ok(Number.isNaN(f.p));
  assert.equal(
    timingSentence(fixed, "Testland"),
    "Onset is not clearly drifting in Testland: across 20 whole seasons (2001 to 2020) the first 10% falls on the same day of the season every year; the halfway point falls on the same day of the season every year.",
  );
  assert.equal(timingDrift(fixed.slice(0, 4), 0), null);
  assert.match(timingSentence(fixed.slice(0, 4), "Testland"), /^Too few whole fire seasons in Testland/);
});

test("driftDays wording", () => {
  assert.equal(driftDays(6), "6 days later");
  assert.equal(driftDays(-2.25), "2.3 days earlier");
  assert.equal(driftDays(1), "1 day later");
  assert.equal(driftDays(12.4), "12 days later");
  assert.equal(driftDays(0.01), "no change");
});
