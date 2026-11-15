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

export function proof(score: Score, hold: [number, number], ref: RefereeRegion | undefined, refYears?: { before: number[]; after: number[] }): Proof {
  const ratioWins = score.mape_ratio < score.mape_model;
  const n = score.n_hold;
  const years = `${n} years the model never saw (${hold[0]}-${hold[1]})`;
  const errorText = ratioWins
    ? `average yearly error on ${years}. Here one constant factor does better (${pct(score.mape_ratio)}), and we say so.`
    : `average yearly error on ${years}. One constant factor: ${pct(score.mape_ratio)}.`;
  const s = ref?.stitched.step ?? null;
  const h = ref?.harmonized.step ?? null;
  const ok = s !== null && h !== null && refYears !== undefined;
  return {
    error: pct(score.mape_model),
    ratioWins,
    errorText,
    band: `${score.coverage} of ${n}`,
    bandText: `hidden years whose real total landed inside our 5-95% error band.`,
    jump: ok ? `${step(s)} → ${step(h)}` : null,
    jumpText: ok
      ? `jump across 2012 in fires per km² burned, checked against NASA burned area (${refYears.before[0]}-${refYears.before[1]} vs ${refYears.after[0]}-${refYears.after[1]}): naive record, then ours. ×1.00 = no jump.`
      : null,
  };
}
