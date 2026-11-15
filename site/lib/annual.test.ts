// Tests for lib/annual.ts against a small synthetic record and the published annual.json files (FE-006).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  completeEnd,
  dayLabel,
  forwardFrom,
  harmonizedLabel,
  isForward,
  eraMeans,
  HOLD_FROM,
  holdoutYears,
  isPartial,
  lastCompleteYear,
  partialLabel,
  spanOf,
  VIIRS_FROM,
  type Annual,
} from "./annual.ts";

const score = { mape_model: 1, mape_ratio: 2, coverage: 2, n_hold: 2, ratio: 3, alpha: 0.1, weekly_r: 0.9, sigma_year: 0.1 };

/**
 * 2010-2021: MODIS 100 a year, VIIRS 300 from 2012, last year partial with VIIRS 30. 2012 is blended (ML-009): raw
 * VIIRS 280 from 20 Jan, harmonized 300 with the model filling 1-19 Jan.
 */
function sample(): Annual {
  const years = Array.from({ length: 12 }, (_, k) => 2010 + k);
  const viirs = years.map((y) => (y < VIIRS_FROM ? null : y === 2021 ? 30 : y === VIIRS_FROM ? 280 : 300));
  return {
    years,
    modis: years.map((y) => (y === 2021 ? 10 : 100)),
    viirs,
    pred: years.map(() => 290),
    lo: years.map(() => 250),
    hi: years.map(() => 330),
    score,
    partial: years.map((y) => (y === 2021 ? 1 : 0)),
    data_through: "2021-03-04",
    harmonized: years.map((y, i) => (y === VIIRS_FROM ? 300 : (viirs[i] ?? 290))),
    viirs_partial: years.map((y) => (y === VIIRS_FROM ? 1 : 0)),
  };
}

test("completeEnd and lastCompleteYear stop before trailing partial years", () => {
  const D = sample();
  assert.equal(completeEnd(D), 11);
  assert.equal(lastCompleteYear(D), 2020);
  assert.ok(isPartial(D, 11) && !isPartial(D, 10));
  const full = { ...D, partial: D.years.map(() => 0) };
  assert.equal(completeEnd(full), 12);
  assert.equal(lastCompleteYear(full), 2021);
});

test("eraMeans leaves the partial year out and uses the harmonized 2012", () => {
  const e = eraMeans(sample());
  assert.equal(e.modis, 100);
  // with 2021 in it would be (9 * 300 + 30) / 10 = 273; with the raw 2012 it would be (280 + 8 * 300) / 9 = 297.8
  assert.equal(e.viirs, 300);
  assert.equal(e.jump, 3);
});

test("holdoutYears counts n_hold complete years from HOLD_FROM", () => {
  assert.deepEqual(holdoutYears(sample()), [HOLD_FROM, HOLD_FROM + 1]);
});

test("dayLabel and partialLabel", () => {
  assert.equal(dayLabel("2026-10-28"), "28 Oct 2026");
  assert.equal(dayLabel("2026-01-05", false), "5 Jan");
  const D = sample();
  assert.equal(partialLabel(D, 11), "2021 to 4 Mar");
  assert.equal(partialLabel(D, 5), "2015");
  assert.equal(partialLabel({ ...D, data_through: "2022-01-02" }, 11), "2021");
});

test("spanOf: first year, common last complete year, latest data_through, names phrase", () => {
  const A = sample();
  const B = { ...sample(), years: A.years.map((y) => y - 1), partial: A.years.map(() => 0), data_through: "2020-12-31" };
  const s = spanOf([A, B], ["A", "B", "C"]);
  assert.deepEqual(s, { first: 2009, lastComplete: 2020, last: 2021, through: "2021-03-04", regions: "A, B and C" });
  assert.equal(spanOf([A], ["Only"]).regions, "Only");
});

for (const region of ["portugal", "ghana", "punjab"]) {
  test(`published ${region}/annual.json: partial year, hold-out and copy years follow the data`, () => {
    const D: Annual = JSON.parse(readFileSync(new URL(`../public/data/${region}/annual.json`, import.meta.url), "utf8"));
    assert.equal(D.partial.length, D.years.length);
    assert.match(D.data_through, /^\d{4}-\d{2}-\d{2}$/);
    // only trailing years may be partial (completeEnd relies on it)
    const end = completeEnd(D);
    assert.ok(D.partial.slice(0, end).every((p) => p === 0), "partial year before a complete one");
    // the score's hold-out years are all complete and end at or before the last complete year
    const [h0, h1] = holdoutYears(D);
    assert.equal(h0, HOLD_FROM);
    assert.ok(h1 <= lastCompleteYear(D));
    assert.ok(D.years.includes(VIIRS_FROM) && D.viirs[D.years.indexOf(VIIRS_FROM) - 1] === null);
    // the jump uses complete years only, from the harmonized record (ML-009)
    assert.equal(D.harmonized.length, D.years.length);
    assert.equal(D.viirs_partial.length, D.years.length);
    const e = eraMeans(D);
    const complete = D.harmonized.filter((_, i) => D.years[i] >= VIIRS_FROM && i < end);
    assert.equal(e.viirs, complete.reduce((p, c) => p + c, 0) / complete.length);
  });
}

test("forward year helpers (FE-009)", () => {
  const D = sample();
  assert.equal(isForward(D, 11), false);
  assert.equal(harmonizedLabel(D, 11), "2021 to 4 Mar");
  assert.equal(forwardFrom(D), null);
  const F: Annual = { ...D, source: D.years.map((y) => (y < VIIRS_FROM ? "backcast" : y === 2021 ? "forward" : "observed")), forward_through: "2021-03-16" };
  assert.equal(isForward(F, 11), true);
  assert.equal(isForward(F, 10), false);
  assert.equal(harmonizedLabel(F, 11), "2021 to 16 Mar");
  assert.equal(partialLabel(F, 11), "2021 to 4 Mar"); // the raw value still stops at data_through
  assert.equal(forwardFrom(F), "5 Mar");
  assert.equal(isForward({ ...F, forward_through: null }, 11), false);
});

for (const region of ["portugal", "ghana", "punjab"]) {
  test(`published ${region}/annual.json: forward link fields (ML-017)`, () => {
    const D: Annual = JSON.parse(readFileSync(new URL(`../public/data/${region}/annual.json`, import.meta.url), "utf8"));
    if (!D.source) return; // before ML-017
    assert.equal(D.source.length, D.years.length);
    const fwd = D.years.flatMap((_, i) => (isForward(D, i) ? [i] : []));
    if (!D.forward_through) return assert.deepEqual(fwd, []);
    assert.deepEqual(fwd, [D.years.length - 1]);
    assert.ok(D.forward_through > D.data_through);
    const s = D.score.forward!;
    assert.deepEqual(s.forward[1], D.forward_through);
    assert.ok(s.n_month > 0 && s.coverage_month <= s.n_month && s.coverage_year <= s.n_year);
  });
}
