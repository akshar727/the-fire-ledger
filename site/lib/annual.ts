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
  weekly_r: number;
  sigma_year: number; // year-level error (RMS of log obs/pred, leave-one-year-out on the training years); sizes the band
};

/** Annual series, one entry per year. `viirs` is null before VIIRS starts. */
export type Annual = {
  years: number[];
  modis: number[];
  viirs: (number | null)[];
  pred: number[];
  lo: number[];
  hi: number[];
  score: Score;
  partial: number[]; // 1 = fewer than 52 kept weeks (the year still running, e.g. 2026)
  data_through: string; // YYYY-MM-DD, last day of the last kept week
};

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
 * The whole published record across regions, for site-wide copy: first year, last complete year (common to all
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
 * ratio: the apparent jump the harmonization removes. A partial year would pull the VIIRS mean down.
 */
export function eraMeans(D: Annual): { modis: number; viirs: number; jump: number } {
  const end = completeEnd(D);
  const modis = mean(D.modis.filter((_, i) => i < end && D.years[i] < VIIRS_FROM));
  const viirs = mean(D.viirs.flatMap((v, i) => (i < end && v != null ? [v] : [])));
  return { modis, viirs, jump: viirs / modis };
}
