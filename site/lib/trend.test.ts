import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Annual } from "./annual.ts";
import {
  erfc,
  kendallExactP,
  kendallP,
  median,
  rangeTrend,
  rangeYears,
  slopeLabel,
  stitchedTotals,
  theilSen,
  trend,
  trendClause,
  trendSentence,
  type RangeTrend,
  type TrendBlock,
  type TrendStat,
  type WeeklyRaw,
} from "./trend.ts";

const REGIONS = ["portugal", "ghana", "punjab"];
const read = (r: string, f: string) => JSON.parse(readFileSync(new URL(`../public/data/${r}/${f}`, import.meta.url), "utf8"));

// Within the rounding model.py applies (2 dp for slopes, 4 dp for p): equal, or one unit apart on a rounding edge.
function close(got: TrendStat, want: TrendStat, what: string) {
  for (const k of ["slope_pct", "lo_pct", "hi_pct"] as const) {
    if (want[k] === null) assert.equal(got[k], null, `${what} ${k}`);
    else assert.ok(got[k] !== null && Math.abs(got[k] - want[k]) <= 0.0100001, `${what} ${k}: ${got[k]} vs ${want[k]}`);
  }
  if (want.p === null) assert.equal(got.p, null, `${what} p`);
  else assert.ok(got.p !== null && Math.abs(got.p - want.p) <= 0.000100001, `${what} p: ${got.p} vs ${want.p}`);
}

test("erfc matches scipy.special.erfc", () => {
  const want: [number, number][] = [
    [0, 1], [0.1, 0.8875370839817152], [0.3, 0.6713732405408726], [0.49, 0.48833173881147696],
    [0.5, 0.4795001221869535], [0.8, 0.2578990352923395], [1.2, 0.08968602177036462], [2, 0.004677734981047266],
    [3, 2.209049699858544e-5], [3.9, 3.479224859723178e-8], [4, 1.541725790028002e-8], [5, 1.5374597944280347e-12],
    [6.5, 3.842148327120647e-20],
  ];
  for (const [x, v] of want) assert.ok(Math.abs(erfc(x) - v) <= 1e-9 * v, `erfc(${x}) = ${erfc(x)}, want ${v}`);
  assert.ok(Math.abs(erfc(-1.2) - (2 - 0.08968602177036462)) < 1e-14);
});

test("median, Theil-Sen and Kendall on small cases", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(theilSen([1, 2, 3, 4], [2, 4, 6, 8]).slope, 2);
  // perfect order, n = 5: exact p = 2 / 5! (scipy kendalltau gives 0.016666...)
  assert.ok(Math.abs(kendallP([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]) - 2 / 120) < 1e-15);
  assert.equal(kendallExactP(2, 1), 1);
  // ties in y, so asymptotic with tie correction: scipy.stats.kendalltau(range(10), [3,1,4,1,5,9,2,6,5,3]).pvalue
  assert.ok(Math.abs(kendallP([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [3, 1, 4, 1, 5, 9, 2, 6, 5, 3]) - 0.2772892580884726) < 1e-12);
  assert.ok(Number.isNaN(kendallP([1, 2, 3], [5, 5, 5])));
});

test("trend: nulls, constant series, too few years", () => {
  assert.deepEqual(trend([1, 2], [1, 2]), { slope_pct: null, lo_pct: null, hi_pct: null, p: null });
  assert.deepEqual(trend([1, 2, 3, 4], [0, 0, 0, 5]), { slope_pct: null, lo_pct: null, hi_pct: null, p: null }); // median 0
  assert.deepEqual(trend([1, 2, 3], [7, 7, 7]), { slope_pct: 0, lo_pct: 0, hi_pct: 0, p: 1 });
});

for (const r of REGIONS) {
  test(`${r}: port reproduces model.py's published trend block (annual and every month)`, () => {
    const D = read(r, "annual.json") as Annual & { trend: TrendBlock };
    const S = read(r, "series.json");
    const b = D.trend;
    assert.ok(b.years, "trend.years");
    const got = rangeTrend(D, b.years, S.weekly as WeeklyRaw);
    assert.equal(got.years.length, b.n_years);
    // recomputed from the weekly file (rangeTrend itself reuses the stored answer for this range)
    const st = stitchedTotals(D, S.weekly as WeeklyRaw);
    close(trend(got.years, rangeYears(D, b.years).idx.map((i) => st[i] as number)), b.stitched, "stitched");
    // the published range needs no weekly file: stitched comes from annual.json
    assert.deepEqual(rangeTrend(D, b.years, null).stitched, b.stitched);
    assert.equal(rangeYears(D, b.years).needsWeekly, false);
    close(got.harmonized, b.harmonized, "harmonized");
    assert.deepEqual(got.boot, [b.harmonized.boot_lo_pct, b.harmonized.boot_hi_pct]);
    // monthly: many zero months and ties, so this exercises the asymptotic p with tie corrections
    const m = S.monthly;
    const years = got.years;
    for (const [key, alt] of [["stitched", "modis"], ["harmonized", "pred"]] as const) {
      for (let k = 0; k < 12; k++) {
        const y = years.map((yr) => {
          const i = (yr - m.start_year) * 12 + k;
          return m.viirs[i] ?? m[alt][i];
        });
        const want = Object.fromEntries((["slope_pct", "lo_pct", "hi_pct", "p"] as const).map((f) => [f, b.monthly![key][f][k]])) as TrendStat;
        close(trend(years, y), want, `${key} month ${k + 1}`);
      }
    }
  });
}

test("stitchedTotals: 2012 needs the weekly file; other years come from annual.json", () => {
  const D = read("ghana", "annual.json") as Annual;
  const S = read("ghana", "series.json");
  const i = D.years.indexOf(2012);
  const without = stitchedTotals(D, null);
  assert.equal(without[i], null);
  assert.equal(without[0], D.modis[0]);
  assert.equal(without[i + 1], D.viirs[i + 1]);
  const withW = stitchedTotals(D, S.weekly);
  assert.ok((withW[i] as number) > (D.viirs[i] as number)); // MODIS fills 1-19 Jan
});

test("rangeTrend: selected years, partial years out, no bootstrap range off the published block", () => {
  const D = read("portugal", "annual.json") as Annual & { trend: TrendBlock };
  const last = D.years[D.years.length - 1];
  const r = rangeTrend(D, [2015, last], null);
  assert.equal(r.years[0], 2015);
  assert.ok(!r.years.includes(last) || D.partial[D.years.length - 1] === 0);
  assert.ok(r.stitched !== null); // 2012 not in range: no weekly file needed
  assert.equal(r.boot, null);
  assert.equal(rangeTrend(D, [2005, 2015], null).stitched, null); // 2012 in range, weekly not loaded
  assert.equal(rangeYears(D, [2005, 2015]).needsWeekly, true);
  assert.equal(rangeYears(D, [2012, 2013]).needsWeekly, false); // under 3 years: no trend, no fetch
  assert.equal(rangeYears(D, [2015, 2020]).needsWeekly, false);
  // a weekly file that starts after 2012 cannot give the 2012 total
  assert.equal(stitchedTotals(D, { start_year: 2013, weeks_per_year: 52, modis: [], viirs: [] })[D.years.indexOf(2012)], null);
  assert.equal(rangeTrend(D, [2010, 2011], null).years.length, 2);
  // works without a trend block (older annual.json)
  const { trend: _drop, ...old } = D;
  void _drop;
  assert.equal(rangeTrend(old, [2001, 2025], null).boot, null);
});

const stat = (slope_pct: number | null, p: number | null): TrendStat => ({ slope_pct, lo_pct: null, hi_pct: null, p });
const rt = (s: TrendStat | null, h: TrendStat, n = 25): RangeTrend => ({ years: Array.from({ length: n }, (_, i) => 2001 + i), stitched: s, harmonized: h, boot: null });

test("wording: sign, significance, missing values", () => {
  assert.equal(slopeLabel(6.04), "+6.0% a year");
  assert.equal(slopeLabel(-2.07), "−2.1% a year");
  assert.equal(slopeLabel(0.04), "no change");
  assert.equal(trendClause(stat(6, 0.01)), "+6.0% a year, significant");
  assert.equal(trendClause(stat(-2, 0.32)), "−2.0% a year, not significant");
  assert.equal(trendClause(stat(3, 0.05)), "+3.0% a year, not significant"); // p < 0.05 strictly
  assert.equal(trendClause(stat(null, null)), "no trend can be measured (too little fire)");
  assert.equal(trendClause(null), "loading");
  assert.equal(trendClause(stat(0.01, 0.01)), "no change");
});

test("trendSentence", () => {
  assert.equal(
    trendSentence(rt(stat(6, 0.01), stat(-2, 0.32))),
    "2001-2025 (25 complete years). Stitched ledger: +6.0% a year, significant. Harmonized: −2.0% a year, not significant. The stitched trend does not hold once both sensors are on one scale.",
  );
  assert.equal(
    trendSentence(rt(stat(3.4, 0.09), stat(-2.1, 0.32))),
    "2001-2025 (25 complete years). Stitched ledger: +3.4% a year, not significant. Harmonized: −2.1% a year, not significant.",
  );
  assert.match(trendSentence(rt(stat(5, 0.001), stat(-3, 0.01))), /opposite directions/);
  assert.match(trendSentence(rt(stat(1, 0.4), stat(4, 0.01))), /shows a trend the stitched one hides/);
  assert.equal(trendSentence(rt(stat(1, 0.01), stat(1, 0.01), 2)), "A trend needs at least 3 complete years; this range has 2.");
  assert.match(trendSentence(rt(null, stat(1, 0.5))), /Stitched ledger: loading\./);
  assert.match(trendSentence(rt(null, stat(1, 0.5)), true), /Stitched ledger: unavailable \(the weekly file did not load\)\./);
});
