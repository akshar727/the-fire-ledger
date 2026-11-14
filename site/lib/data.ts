// The only module that loads pipeline outputs from site/public/data/ (written by model.py, never hand-edited).
// Files are imported at build time rather than read with fs, so they also work on Vercel.
import portugalAnnual from "@/public/data/portugal/annual.json";

/** Hold-out scores for 2020-2025 (see the "DATA" row in SHARED_VARIABLES_AND_FUNCTIONS.md §3). */
export type Score = {
  mape_model: number; // mean absolute % error of the model's annual totals
  mape_ratio: number; // same, for one constant VIIRS/MODIS factor
  coverage: number; // hold-out years whose observed total is inside the 5-95% band
  n_hold: number;
  ratio: number;
  alpha: number;
  weekly_r: number;
};

/** Annual series, one entry per year. `viirs` is null before 2012. */
export type Annual = {
  years: number[];
  modis: number[];
  viirs: (number | null)[];
  pred: number[];
  lo: number[];
  hi: number[];
  score: Score;
};

export const REGIONS = { portugal: "Mainland Portugal" } as const;
export type RegionId = keyof typeof REGIONS;

const ANNUAL: Record<RegionId, Annual> = { portugal: portugalAnnual as Annual };

export function loadAnnual(region: RegionId): Annual {
  return ANNUAL[region];
}
