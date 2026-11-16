import assert from "node:assert/strict";
import { test } from "node:test";
import { backcastOffset, harmonizedCloser, nearLevel, stepLabel, stepRange, type RefereeRegion } from "./referee.ts";

const rec = (step: number | null) => ({
  per_1000km2_before: 1,
  per_1000km2_after: step,
  step,
  monthly_r_before: 0.9,
  monthly_r_after: 0.9,
});
const region = (s: number | null, h: number | null): RefereeRegion => ({
  burned_km2_per_year: { before: 1, after: 1 },
  stitched: rec(s),
  harmonized: rec(h),
  yearly: { years: [], burned_km2: [], stitched: [], harmonized: [] },
});

test("stepLabel", () => {
  assert.equal(stepLabel(4.556), "×4.56");
  assert.equal(stepLabel(0.84), "×0.84");
  assert.equal(stepLabel(null), "n/a");
});

test("backcastOffset is 1 / step - 1", () => {
  assert.equal(backcastOffset(0.84), "+19%");
  assert.equal(backcastOffset(1.036), "-3%");
  assert.equal(backcastOffset(0.916), "+9%");
  assert.equal(backcastOffset(1.004), "0%");
  assert.equal(backcastOffset(null), null);
});

test("stepRange", () => {
  assert.equal(stepRange([4.556, 2.196, 4.347]), "×2.20 to ×4.56");
  assert.equal(stepRange([1, null]), "×1.00");
  assert.equal(stepRange([null]), null);
});

test("nearLevel needs both: within ±25% and closer than stitched", () => {
  assert.equal(nearLevel(region(2.196, 0.84)), true);
  assert.equal(nearLevel(region(4.556, 1.036)), true);
  assert.equal(nearLevel(region(4.0, 0.7)), false);
  assert.equal(nearLevel(region(1.1, 1.2)), false);
});

test("harmonizedCloser compares distance from 1 on a log scale", () => {
  assert.equal(harmonizedCloser(region(4.556, 1.036)), true);
  assert.equal(harmonizedCloser(region(2.196, 0.84)), true);
  assert.equal(harmonizedCloser(region(1.1, 0.5)), false);
  assert.equal(harmonizedCloser(region(null, 1)), false);
});
