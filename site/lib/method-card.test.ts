import assert from "node:assert/strict";
import { test } from "node:test";
import { methodCard } from "./method-card.ts";
import type { Score } from "./annual.ts";

const score = (mape_model: number, mape_ratio: number, coverage = 5): Score =>
  ({ mape_model, mape_ratio, coverage, n_hold: 6, ratio: 4.4, alpha: 0.1, weekly_r: 0.99, sigma_year: 0.05 }) as Score;
const noDash = (s: string) => assert.ok(!/[–—]/.test(s), `no en/em dash: ${s}`);

test("model: badge and both errors, one decimal", () => {
  const c = methodCard({ ship: "model", score: score(39.0174, 41.172) })!;
  assert.equal(c.badge, "Our model");
  assert.equal(c.why, "Our model was closer on the hidden years 2020-2025: 39.0% average error vs 41.2% for one constant ratio.");
  assert.equal(c.band, undefined);
  noDash(c.why);
});

test("caveat: model sentence plus the band sentence", () => {
  const c = methodCard({ ship: "caveat", score: score(3.2158, 4.9162, 3) })!;
  assert.equal(c.badge, "Our model (band too narrow)");
  assert.match(c.why, /3\.2% average error vs 4\.9%/);
  assert.equal(c.band, "But only 3 of the 6 hidden years fell inside its 5-95% band, so the band is too narrow here.");
  noDash(c.why + c.band!);
});

test("ratio after a lost model: the model's error vs the ratio's", () => {
  const c = methodCard({ ship: "ratio", score: score(4.3609, 4.3609), model_score: score(4.5648, 4.3609) })!;
  assert.equal(c.badge, "One constant ratio");
  assert.equal(
    c.why,
    "We tried our model here: 4.6% average error on the hidden years 2020-2025 vs 4.4% for one constant ratio, so the ratio is published.",
  );
  noDash(c.why);
});

test("ratio with no model score: the ratio's error only", () => {
  const c = methodCard({ ship: "ratio", score: score(10.7, 10.7), model_score: null })!;
  assert.equal(c.why, "One constant ratio is published here: 10.7% average error on the hidden years 2020-2025.");
});

test("sparse: fixed line, no numbers", () => {
  const c = methodCard({ ship: "sparse", score: score(NaN, NaN) })!;
  assert.equal(c.badge, "Too little fire to check");
  assert.doesNotMatch(c.why, /\d%|NaN/);
  noDash(c.why);
});

test("deep dive (no ship): no card", () => {
  assert.equal(methodCard({ score: score(4.3, 6.8) }), null);
});
