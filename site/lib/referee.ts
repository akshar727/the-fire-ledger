export type RefereeRecord = {
  per_1000km2_before: number | null;
  per_1000km2_after: number | null;
  step: number | null;
  monthly_r_before: number | null;
  monthly_r_after: number | null;
};

export type RefereeRegion = {
  burned_km2_per_year: { before: number | null; after: number | null };
  stitched: RefereeRecord;
  harmonized: RefereeRecord;
  yearly: {
    years: number[];
    burned_km2: (number | null)[];
    stitched: (number | null)[];
    harmonized: (number | null)[];
  };
};

export type Referee = {
  schema: number;
  product: string;
  product_short: string;
  before: number[];
  after: number[];
  note: string;
  regions: Record<string, RefereeRegion>;
};

export function stepLabel(step: number | null): string {
  return step === null ? "n/a" : `${step.toFixed(2)}x`;
}

export function backcastOffset(step: number | null): string | null {
  if (step === null || step <= 0) return null;
  const p = Math.round((1 / step - 1) * 100);
  return p === 0 ? "0%" : `${p > 0 ? "+" : "-"}${Math.abs(p)}%`;
}

export function stepRange(steps: (number | null)[]): string | null {
  const v = steps.filter((s): s is number => s !== null).sort((a, b) => a - b);
  if (v.length === 0) return null;
  return v[0] === v.at(-1)
    ? stepLabel(v[0])
    : `${stepLabel(v[0])} to ${stepLabel(v.at(-1)!)}`;
}

export function nearLevel(r: RefereeRegion, tol = 0.25): boolean {
  const h = r.harmonized.step;
  return h !== null && h >= 1 - tol && h <= 1 + tol && harmonizedCloser(r);
}

export function harmonizedCloser(r: RefereeRegion): boolean {
  const { stitched: s, harmonized: h } = r;
  if (s.step === null || h.step === null || s.step <= 0 || h.step <= 0)
    return false;
  return Math.abs(Math.log(h.step)) < Math.abs(Math.log(s.step));
}
