import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { backtest, cumAt, forecastFrom, outlook, quantile, seasons, seasonStartWeek, weekAtShare } from "./outlook.ts";
import { parseSeries, seasonTiming, type Weekly } from "./series.ts";

const shape = (wk: number) => {
  const d = Math.min(Math.abs(wk - 10), 52 - Math.abs(wk - 10));
  return wk === 40 ? 1 : 10 + 100 * Math.exp(-(d * d) / 50);
};
function synthetic(years: number, extraWeeks: number, lastWeekDays = 7, scale = (y: number) => 1 + 0.1 * y): Weekly {
  const pred: number[] = [];
  for (let i = 0; i < years * 52 + extraWeeks; i++) {
    const y = Math.floor(i / 52), wk = i % 52;
    pred.push(shape(wk) * scale(wk >= 40 ? y : y - 1));
  }
  const n = pred.length;
  return {
    start_year: 2001,
    weeks_per_year: 52,
    modis: pred.map(() => 0),
    viirs: pred.map(() => null),
    pred,
    lo: pred,
    hi: pred,
    source: pred.map((_, i) => (i >= n - 2 ? "forward" : "backcast")),
    last_week_days: lastWeekDays,
  };
}

test("quantile and cumAt", () => {
  assert.equal(quantile([3, 1, 2], 0.5), 2);
  assert.equal(quantile([0, 10], 0.25), 2.5);
  assert.ok(Number.isNaN(quantile([], 0.5)));
  assert.equal(cumAt([1, 3, 6], 0), 0);
  assert.equal(cumAt([1, 3, 6], 2), 3);
  assert.equal(cumAt([1, 3, 6], 2, 0.5), 4.5);
});

test("season starts at the quietest week and crosses New Year", () => {
  const w = synthetic(12, 60);
  assert.equal(seasonStartWeek(w, [2001, 2012]), 40);
  const s = seasons(w, 40);
  assert.equal(s[0].label, "2001-02");
  assert.equal(s[0].start, "2001-10-08");
  assert.equal(s[0].complete, true);
  assert.equal(s.at(-1)!.complete, false);
  assert.equal(s.at(-1)!.forwardWeeks, 2);
});

test("same-shape seasons: forecast is exact and the back-test has no error", () => {
  const w = synthetic(12, 52 + 20, 7, (y) => (y === 12 ? 3 : 1 + 0.1 * y));
  const o = outlook(w, [2001, 2012])!;
  assert.equal(o.reason, null);
  const s = o.current, final = s.cum.at(-1)! / cumAt(o.past[0].cum, o.weeks) * o.past[0].cum[51];
  assert.ok(o.forecast);
  assert.ok(Math.abs(o.forecast.median - final) / final < 1e-9, `${o.forecast.median} vs ${final}`);
  assert.ok(Math.abs(o.forecast.lo - o.forecast.hi) / final < 1e-9);
  for (const r of o.backtest) {
    assert.ok(r.mape < 1e-9);
    assert.equal(r.covered, r.n);
  }
  assert.equal(o.rankQuiet, o.past.length + 1);
});

test("partial last week counts by its share of days", () => {
  const o = outlook(synthetic(12, 52 + 20, 3), [2001, 2012])!;
  assert.equal(o.frac, 3 / 7);
  assert.equal(o.weeks, o.current.cum.length - 1);
  assert.equal(o.through.slice(0, 4), "2014");
});

test("too early: no forecast in the first quiet weeks of a season", () => {
  const o = outlook(synthetic(12, 52 + 41), [2001, 2012])!;
  assert.equal(o.weeks, 1);
  assert.equal(o.forecast, null);
  assert.equal(o.reason, "too-early");
});

test("fewer than 5 usable seasons gives no forecast", () => {
  const w = synthetic(4, 52 + 20);
  const o = outlook(w, [2001, 2004])!;
  assert.equal(o.forecast, null);
  assert.equal(o.reason, "too-few-seasons");
  assert.equal(forecastFrom(1, o.past, 5, 0), null);
});

test("weekAtShare and backtest rows", () => {
  const past = seasons(synthetic(12, 0), 40).filter((s) => s.complete);
  const k25 = weekAtShare(past, 0.25), k75 = weekAtShare(past, 0.75);
  assert.ok(k25 < k75);
  assert.deepEqual(backtest(past).map((r) => r.share), [0.25, 0.5, 0.75]);
});

test("back-test catches a season that finished unlike the others (no leak)", () => {
  const w = synthetic(12, 52 + 20);
  for (let k = 30; k < 40; k++) w.pred[5 * 52 + 40 + k] *= 20;
  const rows = outlook(w, [2001, 2012])!.backtest;
  for (const r of rows) assert.ok(r.covered < r.n, `share ${r.share}: ${r.covered}/${r.n}`);
});

test("season-complete: the ledger ends on a season boundary", () => {
  const o = outlook(synthetic(12, 40), [2001, 2012])!;
  assert.equal(o.current.complete, true);
  assert.equal(o.forecast, null);
  assert.equal(o.reason, "season-complete");
});

test("week 51 is complete only with all of its 8 or 9 days", () => {
  assert.equal(seasons(synthetic(12, 0, 8), 0).at(-1)!.complete, false);
  assert.equal(seasons(synthetic(12, 0, 9), 0).at(-1)!.complete, true);
});

test("nothing yet this season: no forecast rather than a forecast of zero", () => {
  const w = synthetic(12, 52 + 20);
  for (let i = 12 * 52 + 40; i < w.pred.length; i++) w.pred[i] = 0;
  const o = outlook(w, [2001, 2012])!;
  assert.equal(o.now, 0);
  assert.equal(o.forecast, null);
  assert.equal(o.reason, "nothing-yet");
  assert.equal(o.rankQuiet, 1);
});

test("weekAtShare returns 52 when a share is never reached", () => {
  const past = seasons(synthetic(12, 0), 40).filter((s) => s.complete);
  assert.equal(weekAtShare(past, 1.01), 52);
});

const START: Record<string, string> = { portugal: "11-26", ghana: "06-25", punjab: "08-13" };
for (const region of ["portugal", "ghana", "punjab"]) {
  test(`real data: ${region}`, () => {
    const b = parseSeries(JSON.parse(readFileSync(new URL(`../public/data/${region}/series.json`, import.meta.url), "utf8")));
    const o = outlook(b.weekly!, b.calendar?.baseline_years ?? [2001, 2025])!;
    assert.ok(o);
    assert.equal(o.past[0].start.slice(5), START[region]);
    assert.ok(o.past.length >= 20);
    assert.ok(o.rankQuiet >= 1 && o.rankQuiet <= o.past.length + 1);
    if (o.forecast) assert.ok(o.forecast.lo <= o.forecast.median && o.forecast.median <= o.forecast.hi && o.forecast.lo >= o.now - 1e-9);
    for (const r of o.backtest) assert.ok(r.n >= 20 && r.mape >= 0 && r.covered <= r.n);
  });
}

test("FE-017: season timing on outlook().past leaves out the running season and a partial last week", () => {
  const o = outlook(synthetic(12, 52, 3), [2001, 2012])!;
  assert.equal(o.current.complete, false);
  const rows = seasonTiming(o.past, o.startWeek);
  assert.equal(rows.length, o.past.length);
  assert.ok(rows.every((r) => r.year !== o.current.year));
  for (const r of rows) assert.match(r.dates[1], /^\d{4}-03-(0[5-9]|1\d)$/, `${r.label} ${r.dates[1]}`);
});
