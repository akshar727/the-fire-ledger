import type { Score } from "./annual.ts";
import type { RefereeRegion } from "./referee.ts";

export type Proof = {
  error: string;
  ratioWins: boolean;
  errorText: string;
  band: string;
  bandText: string;
  jump: string | null;
  jumpText: string | null;
};

const pct = (v: number) => `${v.toFixed(1)}%`;
const step = (v: number) => `×${v.toFixed(2)}`;

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
