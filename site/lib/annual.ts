// Types and pure helpers for one region's annual.json (registry §3 "Annual series as JSON"). No imports, so client
// components and `node --test` can use them without pulling the JSON files into the bundle. `data.ts` loads the files.

/** Hold-out scores (registry §3 "Annual series as JSON" `score`). They cover the complete hold-out years only. */
export type Score = {
  mape_model: number; // mean absolute % error of the model's annual totals
  mape_ratio: number; // same, for one constant VIIRS/MODIS factor
  coverage: number; // hold-out years whose observed total is inside the 5-95% band
  n_hold: number; // complete hold-out years
  ratio: number;
  alpha: number;
  weekly_r: number; // null in a sparse country's file (no fire to correlate); read only when not sparse
  sigma_year: number; // year-level error (RMS of log obs/pred, leave-one-year-out on the training years); sizes the band
  forward?: ForwardScore | null; // ML-017: hold-out score of the NOAA-20/21 forward link; null without NOAA data
};

/**
 * Hold-out score of the forward link (ML-017, registry §3 "Annual series as JSON" `score.forward`): S-NPP-equivalent
 * counts from NOAA-20/21, trained `train`, scored on `hold` against observed S-NPP, applied on `forward` days.
 */
export type ForwardScore = {
  mape_month: number; // mean absolute % error over complete hold-out months with at least `min_month` S-NPP detections
  mape_ratio_month: number; // same, for NOAA-20 times one constant ratio
  coverage_month: number; // those months whose observed total is inside the 5-95% band
  n_month: number;
  min_month: number;
  mape_year: number; // complete hold-out years
  coverage_year: number;
  n_year: number;
  sensors: string[];
  train: string[]; // [first, last] day
  hold: string[]; // [first, last] day
  forward: string[]; // [first, last] forward day
  outage_days_forward: string[]; // forward days with a NOAA outage (filled by the model)
};

/** Where a year's value comes from (ML-017): MODIS back-cast, observed S-NPP, or partly the NOAA-20/21 link. */
export type YearSource = "backcast" | "observed" | "forward";

/**
 * Annual series, one entry per year. `viirs` is null before VIIRS starts and is the raw total (2012 starts 20 Jan).
 * Two different "partial" flags: `partial` is the year still running (FE-006), `viirs_partial` a year VIIRS only
 * observed part of, filled by the model for the rest (ML-009).
 */
export type Annual = {
  years: number[];
  modis: number[];
  viirs: (number | null)[];
  pred: number[];
  lo: number[];
  hi: number[];
  score: Score;
  partial: number[]; // 1 = fewer than 52 kept weeks (the year still running, e.g. 2026)
  data_through: string; // YYYY-MM-DD, last day with data (the archive end; ML-010)
  // ML-009: published ledger = observed VIIRS weeks + model for weeks before VIIRS started (2012 weeks 0-2)
  harmonized: number[];
  viirs_partial: number[]; // 1 = blended year: observed VIIRS for part of it, model for the rest
  // ML-017: `harmonized` (and pred/lo/hi) of a "forward" year add S-NPP-equivalent counts from NOAA-20/21 for the days
  // after `data_through` up to `forward_through`; raw modis/viirs still stop at `data_through`
  source?: YearSource[];
  forward_through?: string | null;
  // ML-023, whole countries only (registry "Country-tier outputs"); the deep dives' files have none of these.
  // method "ratio": pred/harmonized before 2012 are MODIS x the 2012-2019 VIIRS/MODIS ratio (day and night apart), not
  // the model, and `score.mape_model` is that ratio estimate's error; `model_score` is the model's own score when it
  // ran and lost to one constant ratio
  method?: "model" | "ratio";
  ship?: "model" | "caveat" | "ratio" | "sparse";
  model_score?: Score | null;
};

/** FE-029: what made the harmonized line before 2012: the model, or (most whole countries) a constant ratio. */
export const estimateOf = (D: Pick<Annual, "method">): "model" | "ratio" => (D.method === "ratio" ? "ratio" : "model");

/** FE-029: too little fire to check (ship "sparse"): hold-out errors and the 2012 jump are noise, not evidence. */
export const isSparse = (D: Pick<Annual, "ship">) => D.ship === "sparse";

/** True when year i's harmonized value runs past the S-NPP end on the NOAA-20/21 link (FE-009). */
export const isForward = (D: Annual, i: number) => D.source?.[i] === "forward" && !!D.forward_through;

/** "2026 to 14 Nov" for a forward year's harmonized value (to `forward_through`); partialLabel otherwise. */
export function harmonizedLabel(D: Annual, i: number): string {
  return isForward(D, i) ? `${D.years[i]} to ${dayLabel(D.forward_through!, false)}` : partialLabel(D, i);
}

/** "3 Nov" (the day after `data_through`, first forward day) for copy about the forward segment; null without one. */
export function forwardFrom(D: Annual): string | null {
  if (!D.forward_through) return null;
  return dayLabel(new Date(Date.parse(`${D.data_through}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10), false);
}

/**
 * Model years from model.py (registry §1 "Model years"): VIIRS S-NPP starts 2012-01-20, training is VIIRS_FROM to
 * HOLD_FROM - 1, the hold-out starts at HOLD_FROM. Only these two constants are copied here; every end year comes
 * from the data.
 */
export const VIIRS_FROM = 2012;
export const HOLD_FROM = 2020;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const isPartial = (D: Annual, i: number) => D.partial[i] === 1;

/**
 * Index one past the last complete year. model.py only marks trailing years partial (the year still running), so
 * every year before this index is complete.
 */
export function completeEnd(D: Annual): number {
  let end = D.years.length;
  while (end > 0 && isPartial(D, end - 1)) end--;
  return end;
}

export const lastCompleteYear = (D: Annual): number => D.years[Math.max(0, completeEnd(D) - 1)];

/** First and last hold-out year the score covers: `n_hold` complete years from HOLD_FROM. */
export function holdoutYears(D: Annual): [number, number] {
  return [HOLD_FROM, HOLD_FROM + D.score.n_hold - 1];
}

/** "28 Oct 2026" for a YYYY-MM-DD date (no locale, so server and browser agree). */
export function dayLabel(iso: string, withYear = true): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ""}`;
}

/** "2026 to 28 Oct" for the last (running) year; just the year for any other year (`data_through` is not in it). */
export function partialLabel(D: Annual, i: number): string {
  const yr = D.years[i];
  return i === D.years.length - 1 && Number(D.data_through.slice(0, 4)) === yr
    ? `${yr} to ${dayLabel(D.data_through, false)}`
    : `${yr}`;
}

/**
 * The whole published ledger across regions, for site-wide copy: first year, last complete year (common to all
 * regions), last year, latest `data_through`, and the region names as one phrase ("A, B and C").
 */
export function spanOf(list: Annual[], names: string[]) {
  return {
    first: Math.min(...list.map((d) => d.years[0])),
    lastComplete: Math.min(...list.map(lastCompleteYear)),
    last: Math.max(...list.map((d) => d.years.at(-1)!)),
    through: list.map((d) => d.data_through).sort().at(-1)!,
    regions: names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? ""),
  };
}

const mean = (v: number[]) => v.reduce((p, c) => p + c, 0) / v.length;

/**
 * Mean detections per year in the MODIS era (before VIIRS_FROM) and the VIIRS era, complete years only, and their
 * ratio: the apparent jump the harmonization removes. A partial year would pull the VIIRS mean down, so the
 * still-running year is left out (FE-006) and the VIIRS era uses `harmonized`, which fills 1-19 January 2012 from
 * the model (ML-009).
 */
export function eraMeans(D: Annual): { modis: number; viirs: number; jump: number } {
  const end = completeEnd(D);
  const modis = mean(D.modis.filter((_, i) => i < end && D.years[i] < VIIRS_FROM));
  const viirs = mean(D.harmonized.filter((_, i) => i < end && D.years[i] >= VIIRS_FROM));
  return { modis, viirs, jump: viirs / modis };
}
