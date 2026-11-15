// FE-020: wording for the validation strip on the Ledger page (under the record chart since FE-025), from annual.json `score` (whole-year hold-out)
// and referee.json (MODIS burned area). Pure and import-free apart from types, so `node --test` covers every sentence.
import type { Score } from "./annual.ts";
import type { RefereeRegion } from "./referee.ts";

export type Proof = {
  /** "4.3%" */
  error: string;
  /** true when one constant VIIRS/MODIS factor had the lower hold-out error (NW India) */
  ratioWins: boolean;
  /** sentence under the error number */
  errorText: string;
  /** "5 of 6" */
  band: string;
  bandText: string;
  /** "×4.56 → ×1.04", or null when referee.json has no usable steps for the region */
  jump: string | null;
  jumpText: string | null;
};

const pct = (v: number) => `${v.toFixed(1)}%`;
const step = (v: number) => `×${v.toFixed(2)}`;

/**
 * FE-029: what the record shows for a whole country (annual.json `method`, `ship`, `model_score`; ML-023). Omitted for
 * the deep dives, which always show the model. "ratio": the line before 2012 is a constant-ratio estimate and
 * `score.mape_model` is its error, so the wording never calls it the model; "sparse": too little fire to score at all.
 */
export type Estimate = { kind: "model" | "ratio"; sparse?: boolean; modelScore?: Pick<Score, "mape_model"> | null };

export function proof(
  score: Score,
  hold: [number, number],
  ref: RefereeRegion | undefined,
  refYears?: { before: number[]; after: number[] },
  est: Estimate = { kind: "model" },
): Proof {
  const n = score.n_hold;
  const hidden = `(${hold[0]}-${hold[1]})`;
  const ratioEst = est.kind === "ratio";
  const ratioWins = !ratioEst && score.mape_ratio < score.mape_model;
  const years = `${n} years the model never saw ${hidden}`;
  const lost = est.modelScore?.mape_model;
  const errorText = est.sparse
    ? `Too little fire here to score the hidden years ${hidden}: the line before 2012 is MODIS times one ratio and is not validated.`
    : ratioEst
      ? `average yearly error of this constant-ratio estimate (day and night apart) on ${n} hidden years ${hidden}. One pooled factor: ${pct(score.mape_ratio)}` +
        (typeof lost === "number" ? `; the model: ${pct(lost)}.` : ".")
      : ratioWins
        ? `average yearly error on ${years}. Here one constant factor does better (${pct(score.mape_ratio)}), and we say so.`
        : `average yearly error on ${years}. One constant factor: ${pct(score.mape_ratio)}.`;
  const s = ref?.stitched.step ?? null;
  const h = ref?.harmonized.step ?? null;
  const ok = s !== null && h !== null && refYears !== undefined;
  return {
    error: est.sparse ? "Unchecked" : pct(score.mape_model),
    ratioWins,
    errorText,
    band: est.sparse ? "–" : `${score.coverage} of ${n}`,
    bandText: est.sparse
      ? `No band check: too few detections for a 5-95% error band to mean anything.`
      : `hidden years whose real total landed inside our 5-95% error band.`,
    jump: ok ? `${step(s)} → ${step(h)}` : null,
    jumpText: ok
      ? `jump across 2012 in fires per km² burned, checked against NASA burned area (${refYears.before[0]}-${refYears.before[1]} vs ${refYears.after[0]}-${refYears.after[1]}): naive record, then ours. ×1.00 = no jump.`
      : null,
  };
}
