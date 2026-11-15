// Burned-area referee (ML-019): site/public/data/referee.json, written by referee.py from MODIS burned area
// (MCD64CMQ) and each region's series.json. Registry row "Burned-area referee".

export type RefereeRecord = {
  per_1000km2_before: number | null;
  per_1000km2_after: number | null;
  /** after / before; ~1 means detections per km² burned stayed level across the 2012 sensor switch */
  step: number | null;
  monthly_r_before: number | null;
  monthly_r_after: number | null;
};

export type RefereeRegion = {
  burned_km2_per_year: { before: number | null; after: number | null };
  stitched: RefereeRecord;
  harmonized: RefereeRecord;
  yearly: { years: number[]; burned_km2: (number | null)[]; stitched: (number | null)[]; harmonized: (number | null)[] };
};

export type Referee = {
  schema: number;
  product: string;
  /** e.g. "MCD64CMQ Collection 6" */
  product_short: string;
  /** [first year, last year] */
  before: number[];
  /** [first year, last year] */
  after: number[];
  note: string;
  regions: Record<string, RefereeRegion>;
};

/** "×4.56" (2 dp), or "n/a" when the step could not be computed. */
export function stepLabel(step: number | null): string {
  return step === null ? "n/a" : `×${step.toFixed(2)}`;
}

/**
 * Implied back-cast offset for a harmonized step (after / before): 1 / step - 1 as a whole percent with its sign.
 * 0.84 -> "+19%" (back-cast years have 19% more detections per km² burned than VIIRS years), 1.036 -> "-3%".
 */
export function backcastOffset(step: number | null): string | null {
  if (step === null || step <= 0) return null;
  const p = Math.round((1 / step - 1) * 100);
  return p === 0 ? "0%" : `${p > 0 ? "+" : "-"}${Math.abs(p)}%`;
}

/** "×2.20 to ×4.56" over the non-null steps (one value: "×2.20"; none: null). */
export function stepRange(steps: (number | null)[]): string | null {
  const v = steps.filter((s): s is number => s !== null).sort((a, b) => a - b);
  if (v.length === 0) return null;
  return v[0] === v.at(-1) ? stepLabel(v[0]) : `${stepLabel(v[0])} to ${stepLabel(v.at(-1)!)}`;
}

/** Harmonized step within ±tol of level (default 25%) and closer to level than the stitched step. */
export function nearLevel(r: RefereeRegion, tol = 0.25): boolean {
  const h = r.harmonized.step;
  return h !== null && h >= 1 - tol && h <= 1 + tol && harmonizedCloser(r);
}

/** True when the harmonized step is closer to 1 than the stitched step, on a log scale (×2 and ×0.5 are equally far). */
export function harmonizedCloser(r: RefereeRegion): boolean {
  const { stitched: s, harmonized: h } = r;
  if (s.step === null || h.step === null || s.step <= 0 || h.step <= 0) return false;
  return Math.abs(Math.log(h.step)) < Math.abs(Math.log(s.step));
}
