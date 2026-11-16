export type Score = {
  mape_model: number;
  mape_ratio: number;
  coverage: number;
  n_hold: number;
  ratio: number;
  alpha: number;
  weekly_r: number;
  sigma_year: number;
  forward?: ForwardScore | null;
};

export type ForwardScore = {
  mape_month: number;
  mape_ratio_month: number;
  coverage_month: number;
  n_month: number;
  min_month: number;
  mape_year: number;
  coverage_year: number;
  n_year: number;
  sensors: string[];
  train: string[];
  hold: string[];
  forward: string[];
  outage_days_forward: string[];
};

export type YearSource = "backcast" | "observed" | "forward";

export type Annual = {
  years: number[];
  modis: number[];
  viirs: (number | null)[];
  pred: number[];
  lo: number[];
  hi: number[];
  score: Score;
  partial: number[];
  data_through: string;
  harmonized: number[];
  viirs_partial: number[];
  source?: YearSource[];
  forward_through?: string | null;
  method?: "model" | "ratio";
  ship?: "model" | "caveat" | "ratio" | "sparse";
  model_score?: Score | null;
};

export const estimateOf = (D: Pick<Annual, "method">): "model" | "ratio" => (D.method === "ratio" ? "ratio" : "model");

export const isSparse = (D: Pick<Annual, "ship">) => D.ship === "sparse";

export const isForward = (D: Annual, i: number) => D.source?.[i] === "forward" && !!D.forward_through;

export function harmonizedLabel(D: Annual, i: number): string {
  return isForward(D, i) ? `${D.years[i]} to ${dayLabel(D.forward_through!, false)}` : partialLabel(D, i);
}

export function forwardFrom(D: Annual): string | null {
  if (!D.forward_through) return null;
  return dayLabel(new Date(Date.parse(`${D.data_through}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10), false);
}

export const VIIRS_FROM = 2012;
export const HOLD_FROM = 2020;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const isPartial = (D: Annual, i: number) => D.partial[i] === 1;

export function completeEnd(D: Annual): number {
  let end = D.years.length;
  while (end > 0 && isPartial(D, end - 1)) end--;
  return end;
}

export const lastCompleteYear = (D: Annual): number => D.years[Math.max(0, completeEnd(D) - 1)];

export function holdoutYears(D: Annual): [number, number] {
  return [HOLD_FROM, HOLD_FROM + D.score.n_hold - 1];
}

export function dayLabel(iso: string, withYear = true): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ""}`;
}

export function partialLabel(D: Annual, i: number): string {
  const yr = D.years[i];
  return i === D.years.length - 1 && Number(D.data_through.slice(0, 4)) === yr
    ? `${yr} to ${dayLabel(D.data_through, false)}`
    : `${yr}`;
}

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

export function eraMeans(D: Annual): { modis: number; viirs: number; jump: number } {
  const end = completeEnd(D);
  const modis = mean(D.modis.filter((_, i) => i < end && D.years[i] < VIIRS_FROM));
  const viirs = mean(D.harmonized.filter((_, i) => i < end && D.years[i] >= VIIRS_FROM));
  return { modis, viirs, jump: viirs / modis };
}
