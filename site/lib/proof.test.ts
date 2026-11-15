import assert from "node:assert/strict";
import { test } from "node:test";
import { proof } from "./proof.ts";
import type { Score } from "./annual.ts";
import type { RefereeRegion } from "./referee.ts";

const score = (mape_model: number, mape_ratio: number): Score =>
  ({ mape_model, mape_ratio, coverage: 5, n_hold: 6, ratio: 4.4, alpha: 0.1, weekly_r: 0.99, sigma_year: 0.05 }) as Score;
const rec = (step: number | null) => ({ per_1000km2_before: 1, per_1000km2_after: 1, step, monthly_r_before: 0.9, monthly_r_after: 0.9 });
const ref = (s: number | null, h: number | null): RefereeRegion => ({
  burned_km2_per_year: { before: 1, after: 1 },
  stitched: rec(s),
  harmonized: rec(h),
  yearly: { years: [], burned_km2: [], stitched: [], harmonized: [] },
});
const yrs = { before: [2003, 2011], after: [2013, 2022] };

test("model wins: error, comparison, band and referee jump", () => {
  const p = proof(score(4.2916, 6.8248), [2020, 2025], ref(4.556, 1.036), yrs);
  assert.equal(p.error, "4.3%");
  assert.equal(p.ratioWins, false);
  assert.equal(p.errorText, "average yearly error on 6 years the model never saw (2020-2025). One constant factor: 6.8%.");
  assert.equal(p.band, "5 of 6");
  assert.equal(p.jump, "×4.56 → ×1.04");
  assert.match(p.jumpText!, /2003-2011 vs 2013-2022/);
});

test("constant factor wins: the strip says so", () => {
  const p = proof(score(7.3, 3.2), [2020, 2025], ref(4.4, 0.92), yrs);
  assert.equal(p.ratioWins, true);
  assert.match(p.errorText, /Here one constant factor does better \(3\.2%\), and we say so\.$/);
});

test("FE-029: a constant-ratio country is never called the model; the model's losing score is shown", () => {
  const p = proof(score(4.66, 4.36), [2020, 2025], undefined, yrs, { kind: "ratio", modelScore: { mape_model: 4.56 } });
  assert.equal(p.error, "4.7%");
  assert.equal(p.ratioWins, false);
  assert.equal(
    p.errorText,
    "average yearly error of this constant-ratio estimate (day and night apart) on 6 hidden years (2020-2025). One pooled factor: 4.4%; the model: 4.6%.",
  );
  assert.doesNotMatch(p.errorText, /never saw/);
  const q = proof(score(6, 5), [2020, 2025], undefined, yrs, { kind: "ratio" });
  assert.match(q.errorText, /One pooled factor: 5\.0%\.$/);
});

test("FE-029: a sparse country shows no error number or band count", () => {
  const p = proof(score(100, 100), [2020, 2024], undefined, yrs, { kind: "ratio", sparse: true });
  assert.equal(p.error, "Unchecked");
  assert.equal(p.band, "–");
  assert.match(p.errorText, /^Too little fire here to score the hidden years \(2020-2024\)/);
  assert.doesNotMatch(p.errorText + p.bandText, /100/);
});

test("no referee data: jump is null", () => {
  assert.equal(proof(score(4, 6), [2020, 2025], undefined, yrs).jump, null);
  assert.equal(proof(score(4, 6), [2020, 2025], ref(null, 1), yrs).jumpText, null);
  assert.equal(proof(score(4, 6), [2020, 2025], ref(2, 1), undefined).jump, null);
});
