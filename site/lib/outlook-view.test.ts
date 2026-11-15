import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { outlook } from "./outlook.ts";
import {
  backtestNow,
  coveragePhrase,
  extremes,
  forecastPath,
  forwardWeeks,
  isStale,
  mainBurnMonths,
  medianShare,
  ordinal,
  outlookText,
  rankPhrase,
  staleView,
} from "./outlook-view.ts";
import { parseSeries, type Weekly } from "./series.ts";

// Synthetic record (same idea as outlook.test.ts): quietest week 40, peak at week 10, season y scaled by `scale(y)`.
const shape = (wk: number) => {
  const d = Math.min(Math.abs(wk - 10), 52 - Math.abs(wk - 10));
  return wk === 40 ? 1 : 10 + 100 * Math.exp(-(d * d) / 50);
};
function synthetic(years: number, extraWeeks: number, scale = (y: number) => 1 + 0.1 * ((y * 7) % 5), fwdLast = 2): Weekly {
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
    source: pred.map((_, i) => (i >= n - fwdLast ? "forward" : "backcast")),
    last_week_days: 7,
  };
}

test("ordinal and rankPhrase", () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal), [
    "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th",
  ]);
  assert.equal(rankPhrase(1, 26), "quietest");
  assert.equal(rankPhrase(26, 26), "busiest");
  assert.equal(rankPhrase(3, 26), "3rd quietest");
  assert.equal(rankPhrase(24, 26), "3rd busiest");
  assert.equal(rankPhrase(13, 25), "13th quietest"); // middle of an odd count
});

test("forecastPath starts at now and ends at outlook().forecast", () => {
  const o = outlook(synthetic(12, 52 + 20), [2001, 2012])!;
  assert.ok(o.forecast);
  const p = forecastPath(o);
  assert.deepEqual(p[0], { x: o.weeks + o.frac, lo: o.now, median: o.now, hi: o.now });
  const end = p.at(-1)!;
  assert.equal(end.x, 52);
  assert.ok(Math.abs(end.lo - o.forecast.lo) < 1e-6 && Math.abs(end.hi - o.forecast.hi) < 1e-6);
  assert.ok(Math.abs(end.median - o.forecast.median) < 1e-6);
  for (const q of p) assert.ok(q.lo <= q.median + 1e-9 && q.median <= q.hi + 1e-9);
  // running totals never go down
  for (let i = 1; i < p.length; i++) assert.ok(p[i].lo >= p[i - 1].lo - 1e-9);
  assert.equal(p.length, 1 + 52 - o.weeks);
});

test("forecastPath is empty without a forecast", () => {
  const o = outlook(synthetic(12, 41), [2001, 2012])!; // one week into the season: too early
  assert.equal(o.forecast, null);
  assert.deepEqual(forecastPath(o), []);
});

test("forwardWeeks finds the forward-link weeks of the current season", () => {
  const w = synthetic(12, 52 + 20, undefined, 3);
  const o = outlook(w, [2001, 2012])!;
  const k = forwardWeeks(w, o.startWeek, o.current);
  assert.equal(k.length, o.current.forwardWeeks);
  assert.deepEqual(k, [o.current.cum.length - 3, o.current.cum.length - 2, o.current.cum.length - 1]);
  assert.deepEqual(forwardWeeks(w, o.startWeek, o.past[0]), []);
});

test("backtestNow picks the row nearest the current week", () => {
  const o = outlook(synthetic(12, 52 + 20), [2001, 2012])!;
  const r = backtestNow(o)!;
  const pos = o.weeks + o.frac;
  for (const b of o.backtest) assert.ok(Math.abs(r.week - pos) <= Math.abs(b.week - pos));
});

test("coveragePhrase only says 'less often than 90%' when it is", () => {
  assert.equal(coveragePhrase(21, 25), "84%, less often than the 90% a 5-95% range promises");
  assert.equal(coveragePhrase(23, 25), "92%");
  assert.equal(coveragePhrase(9, 10), "90%");
});

test("staleView: a complete current season is the last complete season", () => {
  // record ends on the last day of a season (week 39 of the last year), so the current season is complete
  const o = outlook(synthetic(12, 40), [2001, 2012])!;
  assert.ok(o.current.complete);
  const v = staleView(o);
  assert.equal(v.focus, o.current);
  assert.equal(v.seasons.length, o.past.length + 1);
  assert.ok(v.rank >= 1 && v.rank <= v.seasons.length);
  assert.match(outlookText(o, true).headline, new RegExp(`season, ${o.current.label}, ended with .+ of ${o.past.length + 1}\\.$`));
  // a partial current season: the last past one
  const o2 = outlook(synthetic(12, 52 + 20), [2001, 2012])!;
  assert.equal(staleView(o2).focus, o2.past.at(-1));
});

test("text: forecast, range and the back-test line", () => {
  const o = outlook(synthetic(12, 52 + 20), [2001, 2012])!;
  const t = outlookText(o);
  assert.match(t.headline, new RegExp(`^By \\d+ \\w{3} this is the .+ season of ${o.past.length + 1}: `));
  assert.match(t.forecast, /^At this pace it ends between [\d,]+ and [\d,]+ detections/);
  assert.match(t.honest, /off by \d+% on average, and the range held the real total \d+ of \d+ times/);
});

test("text: too early names the months most fire burns", () => {
  const o = outlook(synthetic(12, 41), [2001, 2012])!;
  assert.equal(o.reason, "too-early");
  assert.ok(medianShare(o) < 0.05);
  const t = outlookText(o);
  assert.match(t.forecast, /^Too early to forecast: by this date a typical season has had only \d+% of its fire\. Most of it burns /);
  assert.equal(t.honest, "");
  // season starts week 40 (early October); peak around week 10 (March)
  assert.match(mainBurnMonths(o.past, o.past[0].start), /^\w+ to \w+$/);
});

test("text: stale region shows the last complete season and no forecast", () => {
  const o = outlook(synthetic(12, 52 + 20), [2001, 2012])!;
  assert.ok(isStale("2025-12-31", "2026-11-14"));
  assert.ok(!isStale("2026-11-14", "2026-11-14"));
  const t = outlookText(o, true);
  assert.match(t.headline, new RegExp(`^No data for this year yet\\. The last complete season, ${o.past.at(-1)!.label}, ended with`));
  assert.match(t.forecast, /^No forecast/);
  assert.equal(t.honest, "");
});

test("extremes", () => {
  const o = outlook(synthetic(12, 52 + 20), [2001, 2012])!;
  const { quietest, busiest } = extremes(o.past);
  for (const s of o.past) assert.ok(quietest.cum[51] <= s.cum[51] && s.cum[51] <= busiest.cum[51]);
});

// Real data (snapshot through 14 Nov 2026; update when the model is rerun).
const real = (region: string) => {
  const b = parseSeries(JSON.parse(readFileSync(new URL(`../public/data/${region}/series.json`, import.meta.url), "utf8")));
  return { w: b.weekly!, o: outlook(b.weekly!, b.calendar?.baseline_years ?? [2001, 2025])! };
};

test("real data: NW India range and back-test line", () => {
  const { w, o } = real("punjab");
  const t = outlookText(o);
  assert.match(t.headline, /^By 14 Nov this is the quietest season of 26/);
  assert.match(t.forecast, /between 6,611 and 23,152 detections/);
  assert.match(t.honest, /held the real total 21 of 25 times \(84%, less often than the 90% a 5-95% range promises\)\.$/);
  assert.equal(forwardWeeks(w, o.startWeek, o.current).length, o.current.forwardWeeks);
});

test("real data: Portugal's back-test line names the nearest tested week and the error by week", () => {
  const { o } = real("portugal");
  const h = outlookText(o).honest;
  assert.match(h, /at week 39 of 52, the nearest point we tested \(this season is in week 51\)/);
  assert.match(h, /Across the tested points the error was 63% at week 31, 25% at week 37, 20% at week 39\./);
});

test("real data: forecastPath ends at outlook().forecast with a partial last week", () => {
  for (const region of ["portugal", "punjab"]) {
    const { o } = real(region);
    assert.ok(o.frac > 0 && o.forecast);
    const end = forecastPath(o).at(-1)!;
    assert.ok(Math.abs(end.lo - o.forecast.lo) < 1e-6 && Math.abs(end.median - o.forecast.median) < 1e-6 && Math.abs(end.hi - o.forecast.hi) < 1e-6);
  }
});

test("real data: Ghana is too early and says when it burns", () => {
  const { o } = real("ghana");
  assert.equal(o.reason, "too-early");
  const t = outlookText(o);
  assert.match(t.forecast, /Most of it burns (November|December) to (January|February|March)\./);
});
