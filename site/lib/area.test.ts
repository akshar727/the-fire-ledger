import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { approxBand, calendarBlock, percentileLinear, pyRound, sumCells, Z95, type CellSeries } from "./area.ts";
import { buildGrid, parseSeries } from "./series.ts";

const REGIONS = ["ghana", "portugal", "punjab"] as const;
const load = (region: string, file: string) =>
  JSON.parse(readFileSync(new URL(`../public/data/${region}/${file}.json`, import.meta.url), "utf8"));
const years = (...rows: number[][]) => rows.flat();
const constant = (v: number) => Array<number>(12).fill(v);

test("pyRound matches Python round(): ties to even on the exact binary value", () => {
  assert.equal(pyRound(0.125, 2), 0.12);
  assert.equal(pyRound(0.375, 2), 0.38);
  assert.equal(pyRound(2.5, 0), 2);
  assert.equal(pyRound(3.5, 0), 4);
  assert.equal(pyRound(2.675, 2), 2.67);
  assert.equal(pyRound(1.005, 2), 1);
  assert.equal(pyRound(1 / 3, 3), 0.333);
  assert.equal(pyRound(1 / 0.333, 4), 3.003);
  assert.equal(pyRound(0.0004, 3), 0);
  assert.equal(pyRound(0.0005, 3), 0.001);
  assert.equal(pyRound(-0.125, 2), -0.12);
  assert.equal(pyRound(123456.789, 1), 123456.8);
  assert.equal(pyRound(0, 3), 0);
});

test("percentileLinear matches numpy.percentile (linear)", () => {
  assert.equal(percentileLinear([1, 2, 3, 10], 0.25), 1.75);
  assert.equal(percentileLinear([1, 2, 3, 10], 0.5), 2.5);
  assert.equal(percentileLinear([1, 2, 3, 10], 0.75), 4.75);
  assert.equal(percentileLinear([7], 0.75), 7);
  assert.equal(percentileLinear([80, 100, 100, 120, 140], 0.75), 120);
  assert.throws(() => percentileLinear([], 0.5), RangeError);
});

test("calendarBlock: hand-computed stats", () => {
  const k = Array.from({ length: 12 }, (_, m) => m + 1);
  const c = calendarBlock(years(k.map((x) => 10 * x), k.map((x) => 20 * x), k.map((x) => 30 * x)), 2001, [2001, 2003]);
  assert.deepEqual(c.baseline_years, [2001, 2003]);
  k.forEach((x, m) => {
    assert.equal(c.month_median[m], 20 * x);
    assert.equal(c.month_p25[m], 15 * x);
    assert.equal(c.month_p75[m], 25 * x);
  });
  assert.deepEqual(c.anomaly.slice(0, 2), [0.5, 0.5]);
  assert.equal(c.anomaly[24], 1.5);
});

test("calendarBlock: keys and lengths", () => {
  const c = calendarBlock(years(constant(5), constant(5), constant(5)), 2001);
  assert.deepEqual(Object.keys(c).sort(), ["anomaly", "baseline_years", "flag", "month_median", "month_p25", "month_p75"]);
  for (const k of ["month_median", "month_p25", "month_p75"] as const) assert.equal(c[k].length, 12);
  assert.equal(c.anomaly.length, 36);
  assert.equal(c.flag.length, 36);
});

test("calendarBlock: zero-median month", () => {
  const c = calendarBlock([...constant(0), ...constant(0), ...constant(0), 25, ...Array(11).fill(0)], 2001, [2001, 2003]);
  assert.equal(c.month_median[0], 0);
  assert.equal(c.anomaly[0], null);
  assert.equal(c.flag[0], 0);
  assert.equal(c.anomaly[36], null);
  assert.equal(c.flag[36], 1);
});

test("calendarBlock: partial trailing year", () => {
  const c = calendarBlock([...constant(10), ...constant(10), 10, 10, 100, 1], 2001, [2001, 2025]);
  assert.deepEqual(c.month_median, constant(10));
  assert.equal(c.anomaly.length, 28);
  assert.equal(c.anomaly[26], 10);
  assert.deepEqual(c.flag.slice(24), [0, 0, 1, 0]);
  assert.equal(c.anomaly[27], 0.1);
});

test("calendarBlock: partial and out-of-window years are left out of the baseline but still scored", () => {
  assert.deepEqual(calendarBlock([...constant(10), ...Array(5).fill(1000)], 2001).month_median, constant(10));
  const c = calendarBlock(years(constant(1000), constant(10), constant(10), constant(100)), 2000, [2001, 2002]);
  assert.deepEqual(c.month_median, constant(10));
  assert.deepEqual(c.flag.slice(0, 12), Array(12).fill(1));
  assert.deepEqual(c.flag.slice(36), Array(12).fill(1));
  assert.equal(c.anomaly[36], 10);
});

test("calendarBlock: a missing month (null or NaN) makes its year incomplete", () => {
  for (const missing of [null, NaN]) {
    const bad: (number | null)[] = constant(500);
    bad[3] = missing;
    const c = calendarBlock([...constant(10), ...bad], 2001);
    assert.deepEqual(c.month_median, constant(10));
    assert.equal(c.anomaly[15], null);
    assert.equal(c.flag[15], 0);
    assert.equal(c.flag[12], 1);
  }
});

test("calendarBlock: no complete baseline year, or a bad value, throws", () => {
  assert.throws(() => calendarBlock(constant(1).slice(0, 11), 2001), RangeError);
  assert.throws(() => calendarBlock([null, ...Array(11).fill(1)], 2001), RangeError);
  assert.throws(() => calendarBlock(constant(1), 2001, [2005, 2010]), RangeError);
  assert.throws(() => calendarBlock([...constant(1), ...constant(1)], 2030), RangeError);
  for (const bad of [-1, Infinity, -Infinity]) {
    const h = constant(1);
    h[4] = bad;
    assert.throws(() => calendarBlock(h, 2001), RangeError);
  }
});

const flagOf = (base: number[], v: number) =>
  calendarBlock([...base.flatMap(constant), v], 2001, [2001, 2000 + base.length]).flag.at(-1);

test("calendarBlock: high-flag boundaries", () => {
  const base = [80, 100, 120, 140, 100];
  assert.equal(flagOf(base, 200), 1);
  assert.equal(flagOf(base, 199.9), 0);
  assert.equal(flagOf([10, 10, 10], 30), 1);
  assert.equal(flagOf([10, 10, 10], 29.9), 0);
  assert.equal(flagOf([0, 0, 0], 20), 1);
  assert.equal(flagOf([0, 0, 0], 19.9), 0);
  assert.equal(flagOf([0, 0, 100, 100], 100), 0);
  assert.equal(flagOf([0, 0, 100, 100], 100.1), 1);
});

test("calendarBlock: low-flag boundaries", () => {
  const base = [60, 100, 100, 100, 140];
  assert.equal(flagOf(base, 50), -1);
  assert.equal(flagOf(base, 50.1), 0);
  assert.equal(flagOf([30, 30, 30], 10), -1);
  assert.equal(flagOf([30, 30, 30], 10.1), 0);
  assert.equal(flagOf([100, 100, 100], 50.1), 0);
  assert.equal(flagOf([40, 40, 100, 100, 100], 40), 0);
  assert.equal(flagOf([40, 40, 100, 100, 100], 39.9), -1);
});

test("calendarBlock: rounding as calendar_stats.py", () => {
  let c = calendarBlock([...constant(1 / 3), ...constant(1)], 2001, [2001, 2001]);
  assert.equal(c.month_median[0], 0.333);
  assert.equal(c.anomaly[12], 3.003);
  c = calendarBlock([...constant(3), ...constant(1)], 2001, [2001, 2001]);
  assert.equal(c.anomaly[12], 0.3333);
  c = calendarBlock([...constant(0.0004), ...constant(5)], 2001, [2001, 2001]);
  assert.equal(c.month_median[0], 0);
  assert.equal(c.anomaly[12], null);
});

for (const region of REGIONS)
  test(`calendarBlock reproduces ${region}'s published calendar exactly`, () => {
    const s = parseSeries(load(region, "series"));
    const m = s.monthly, n = m.pred.length;
    const h: (number | null)[] = m.viirs.map((v, i) => v ?? m.pred[i]);
    const last = new Date(Date.UTC(m.start_year + Math.floor((n - 1) / 12), ((n - 1) % 12) + 1, 0)).getUTCDate();
    if (m.last_month_days != null && m.last_month_days < last) h[n - 1] = null;
    assert.deepEqual(calendarBlock(h, m.start_year), s.calendar);
  });

test("approxBand: lognormal with the stated mean and variance", () => {
  const p = { alpha: 0.2, sigma_year: 0.1 };
  const mus = [100, 40, 0, 7.5];
  const M = 147.5, V = mus.reduce((a, mu) => a + mu + 0.2 * mu * mu, 0) + (0.1 * M) ** 2;
  const b = approxBand(mus, p);
  assert.equal(b.mean, M);
  const s = Math.log(b.hi / b.lo) / (2 * Z95);
  const m = (Math.log(b.hi) + Math.log(b.lo)) / 2;
  assert.ok(Math.abs(Math.exp(m + s * s / 2) - M) < 1e-9);
  assert.ok(Math.abs((Math.exp(s * s) - 1) * M * M - V) < 1e-6);
  assert.ok(b.lo < M && M < b.hi);
  assert.deepEqual(approxBand([0, 0], p), { mean: 0, lo: 0, hi: 0 });
  assert.deepEqual(approxBand([], p), { mean: 0, lo: 0, hi: 0 });
});

test("approxBand: splitting an area into more cells narrows only the alpha part", () => {
  const p = { alpha: 0.15, sigma_year: 0.08 };
  const one = approxBand([400], p), four = approxBand([100, 100, 100, 100], p);
  const many = approxBand(Array(4000).fill(0.1), p), yearOnly = approxBand([400], { alpha: 0, sigma_year: 0.08 });
  assert.ok(four.hi - four.lo < one.hi - one.lo);
  assert.ok(many.hi - many.lo < four.hi - four.lo);
  const wy = yearOnly.hi - yearOnly.lo;
  assert.ok(Math.abs(many.hi - many.lo - wy) / wy < 0.01);
});

for (const region of REGIONS)
  test(`approxBand brackets ${region}'s real monthly band width and sits where the real band does`, () => {
    const m = parseSeries(load(region, "series")).monthly;
    const params = load(region, "annual").score;
    let inside = 0, near = 0, total = 0;
    m.pred.forEach((M, i) => {
      if (m.source?.[i] === "forward" || M < 50) return;
      total++;
      const narrow = approxBand(Array(10_000).fill(M / 10_000), params), wide = approxBand([M], params);
      const w = m.hi[i] - m.lo[i];
      if (w >= narrow.hi - narrow.lo && w <= wide.hi - wide.lo) inside++;
      if (Math.abs(Math.sqrt((narrow.lo * narrow.hi) / (m.lo[i] * m.hi[i])) - 1) <= 0.25) near++;
    });
    assert.ok(total > 200, `${region}: only ${total} months to check`);
    assert.ok(inside / total >= 0.95, `${region}: ${inside} of ${total} months inside`);
    assert.ok(near / total >= 0.95, `${region}: centre within 25% in only ${near} of ${total} months`);
  });

test("sumCells: a region split into cells gives back its calendar, and buildGrid draws it", () => {
  const s = parseSeries(load("portugal", "series"));
  const m = s.monthly;
  const shares = [0.5, 0.3, 0.2];
  const cells: CellSeries[] = shares.map((f) => ({
    modis: m.modis.map((x) => x * f),
    viirs: m.viirs.map((x) => (x == null ? null : x * f)),
    pred: m.pred.map((x) => x * f),
  }));
  const b = sumCells(cells, {
    region: "portugal:custom",
    start_year: m.start_year,
    params: load("portugal", "annual").score,
    last_month_days: m.last_month_days,
    source: m.source,
  });
  assert.equal(buildGrid(parseSeries(b)).firstForward?.index, buildGrid(s).firstForward?.index);
  m.pred.forEach((x, i) => assert.ok(Math.abs(b.monthly.pred[i] - x) <= 0.051, `pred[${i}]`));
  m.viirs.forEach((x, i) => assert.equal(b.monthly.viirs[i] == null, x == null, `viirs[${i}]`));
  assert.deepEqual(b.calendar!.month_median, s.calendar!.month_median);
  const flags = (x: typeof s) => x.calendar!.flag.join("");
  assert.equal(flags(b), flags(s));
  assert.equal(b.calendar!.anomaly.at(-1), null);
  const g = buildGrid(parseSeries(b));
  assert.equal(g.years[0], 2001);
  assert.equal(g.latest!.index, m.pred.length - 1);
  assert.equal(g.latest!.partial, buildGrid(s).latest!.partial);
});

test("sumCells: viirs is null where any cell has none; errors on bad input", () => {
  const n = 24, start = 2011;
  const a: CellSeries = { modis: Array(n).fill(2), viirs: Array(n).fill(3), pred: Array(n).fill(3) };
  const b: CellSeries = { modis: Array(n).fill(1), viirs: [null, ...Array(n - 1).fill(1)], pred: Array(n).fill(1) };
  const o = { region: "x", start_year: start, params: { alpha: 0.1, sigma_year: 0.05 }, baseline: [2011, 2012] as [number, number] };
  const s = sumCells([a, b], o);
  assert.equal(s.monthly.viirs[0], null);
  assert.equal(s.monthly.viirs[1], 4);
  assert.equal(s.monthly.modis[0], 3);
  assert.ok(s.monthly.lo[1] < 4 && s.monthly.hi[1] > 4);
  assert.equal(s.calendar!.anomaly.length, n);
  assert.throws(() => sumCells([], o), RangeError);
  assert.throws(() => sumCells([a, { ...b, pred: [1] }], o), RangeError);
  for (const bad of [-1, NaN, Infinity]) {
    const set = (arr: readonly (number | null)[]) => arr.map((x, i) => (i === 5 ? bad : x));
    assert.throws(() => sumCells([a, { ...b, pred: set(b.pred) as number[] }], o), RangeError, `pred ${bad}`);
    assert.throws(() => sumCells([a, { ...b, modis: set(b.modis) as number[] }], o), RangeError, `modis ${bad}`);
    assert.throws(() => sumCells([a, { ...b, viirs: set(b.viirs) }], o), RangeError, `viirs ${bad}`);
  }
  assert.throws(() => sumCells([a], { ...o, source: ["observed"] }), RangeError);
  assert.throws(() => approxBand([1, -2], o.params), RangeError);
});
