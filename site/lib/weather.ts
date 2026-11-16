import { MONTHS_LONG, type CalendarStats } from "./series.ts";

export type WeatherMonthly = {
  start_year: number;
  t2m_max_c: (number | null)[];
  precip_mm: (number | null)[];
  index: (number | null)[];
  pctl: (number | null)[];
  pctl_peak7: (number | null)[];
  last_month_days: number;
  last_month_complete: boolean;
};

export type Weather = { schema: 1; region: string; source: string; through: string; monthly: WeatherMonthly };

export function parseWeather(raw: unknown): Weather | null {
  if (typeof raw !== "object" || raw === null) return null;
  const w = raw as Record<string, unknown>;
  const m = w.monthly as Record<string, unknown> | undefined;
  if (w.schema !== 1 || typeof w.through !== "string" || !m || typeof m.start_year !== "number") return null;
  const n = Array.isArray(m.pctl) ? m.pctl.length : -1;
  for (const k of ["index", "pctl", "pctl_peak7", "t2m_max_c", "precip_mm"]) {
    if (!Array.isArray(m[k]) || (m[k] as unknown[]).length !== n) return null;
  }
  if (typeof m.last_month_days !== "number" || typeof m.last_month_complete !== "boolean") return null;
  return raw as Weather;
}

export const PRONE = 75;
export const MILD = 25;

export type MonthWeather = {
  year: number;
  month: number;
  pctl: number;
  peak7: number | null;
  partialDays: number | null;
  record: boolean;
  n: number;
};

export function monthWeather(W: Weather, year: number, month: number): MonthWeather | null {
  const m = W.monthly, i = (year - m.start_year) * 12 + month - 1, len = m.pctl.length;
  if (i < 0 || i >= len) return null;
  const pctl = m.pctl[i], idx = m.index[i];
  if (pctl == null || idx == null) return null;
  const partial = i === len - 1 && !m.last_month_complete;
  let n = 0, above = 0;
  for (let j = month - 1; j < len; j += 12) {
    if (j === len - 1 && !m.last_month_complete) continue;
    const v = m.index[j];
    if (v == null) continue;
    n++;
    if (j !== i && v >= idx) above++;
  }
  return {
    year,
    month,
    pctl,
    peak7: m.pctl_peak7[i] ?? null,
    partialDays: partial ? m.last_month_days : null,
    record: !partial && above === 0 && n >= 5,
    n,
  };
}

const ordinal = (p: number) => {
  const r = Math.round(p), t = r % 100;
  return `${r}${t >= 11 && t <= 13 ? "th" : (["th", "st", "nd", "rd"][r % 10] ?? "th")}`;
};

export function weatherPhrase(w: MonthWeather, startYear: number): string {
  const name = MONTHS_LONG[w.month - 1];
  let s: string;
  if (w.record) s = `the most fire-prone ${name} weather since ${startYear}`;
  else if (w.pctl >= 90) s = `fire-prone weather for ${name} (top 10%)`;
  else if (w.pctl >= PRONE) s = `hotter, drier or windier than most ${name}s (${ordinal(w.pctl)} percentile)`;
  else if (w.pctl > MILD) s = `ordinary weather for ${name} (${ordinal(w.pctl)} percentile)`;
  else s = `cooler, damper or calmer weather than most ${name}s (${ordinal(w.pctl)} percentile)`;
  if (w.pctl < 90 && w.peak7 != null && w.peak7 >= 90) s += `, with one of the hottest, driest weeks of any ${name}`;
  return s;
}

export function weatherVerdict(w: MonthWeather, flag: -1 | 0 | 1): string | null {
  if (w.partialDays != null || flag === 0) return null;
  if (flag === 1) {
    return w.pctl >= PRONE
      ? "The weather helps explain the high fire."
      : "The weather was not unusual, so it does not explain the high fire.";
  }
  if (w.pctl >= PRONE) return "Fire stayed low despite fire-prone weather.";
  if (w.pctl <= MILD) return "Cool, damp or calm weather fits the low fire.";
  return null;
}

export function weatherSentence(W: Weather, year: number, month: number, flag: -1 | 0 | 1): string | null {
  const w = monthWeather(W, year, month);
  if (!w) return null;
  const head = w.partialDays != null ? `Weather for 1-${w.partialDays} ${MONTHS_LONG[month - 1]} so far` : "Weather";
  const verdict = weatherVerdict(w, flag);
  return `${head}: ${weatherPhrase(w, W.monthly.start_year)}.${verdict ? ` ${verdict}` : ""}`;
}

export type WeatherSummary = {
  n: number;
  years: [number, number];
  high: { prone: number; other: number };
  normal: { prone: number; other: number };
  low: { prone: number; other: number };
  baseShare: number;
};

export function weatherSummary(W: Weather, stats: CalendarStats, startYear: number, lastMonthPartial: boolean): WeatherSummary | null {
  const m = W.monthly;
  const cells = { high: { prone: 0, other: 0 }, normal: { prone: 0, other: 0 }, low: { prone: 0, other: 0 } };
  let n = 0, prone = 0, first = Infinity, last = -Infinity;
  const end = stats.flag.length - (lastMonthPartial ? 1 : 0);
  for (let i = 0; i < end; i++) {
    const year = startYear + Math.floor(i / 12), month = (i % 12) + 1;
    const j = (year - m.start_year) * 12 + month - 1;
    if (j < 0 || j >= m.pctl.length || (j === m.pctl.length - 1 && !m.last_month_complete)) continue;
    const p = m.pctl[j];
    if (p == null) continue;
    const f = stats.flag[i], isProne = p >= PRONE;
    const row = f === 1 ? cells.high : f === -1 ? cells.low : cells.normal;
    if (isProne) row.prone++;
    else row.other++;
    n++;
    if (isProne) prone++;
    first = Math.min(first, year);
    last = Math.max(last, year);
  }
  if (n === 0) return null;
  return { n, years: [first, last], ...cells, baseShare: prone / n };
}

export function summarySentence(s: WeatherSummary): string {
  const hi = s.high.prone + s.high.other;
  if (hi === 0) return "No month was unusually high, so there is nothing to explain.";
  const chance = Math.round(hi * s.baseShare);
  return `${s.high.prone} of ${hi} unusually high months had fire-prone weather (top quarter for that month); chance alone would give about ${chance}.`;
}

export const SEASON_DRIVER: Record<string, string> = {
  punjab:
    "The two yearly peaks themselves come from the harvest, not the weather: farmers burn wheat stubble in April-May and rice straw in October-November every year. Weather only makes a given month busier or quieter than usual.",
};
