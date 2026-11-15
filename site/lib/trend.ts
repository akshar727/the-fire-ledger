// Trend of the yearly ledger over the selected years (FE-014, F-7): "is the trend real?". A port of trend_stats.py
// `trend` (ML-020) so the site can test any range of complete years, not only the 2001-2025 block in annual.json.
// Same method: Theil-Sen slope (scipy.stats.theilslopes, 90% interval, Sen 1968 eq. 2.6) as % of the median per
// year, and the Mann-Kendall two-sided p (scipy.stats.kendalltau, exact when there are no ties and n <= 33, normal
// approximation with tie correction otherwise). Tests check the port against every value model.py published.
// Pure and import-free apart from types, so client components and `node --test` can both use it.
import { VIIRS_FROM, type Annual } from "./annual.ts";

/** One ledger's trend: the shape of `trend.stitched` / `trend.harmonized` in annual.json. Nulls = no trend defined. */
export type TrendStat = { slope_pct: number | null; lo_pct: number | null; hi_pct: number | null; p: number | null };

/** The `trend` block model.py writes into annual.json (registry §3 "Annual series as JSON", ML-020). */
export type TrendBlock = {
  method: string;
  years: [number, number] | null;
  n_years: number;
  interval: number;
  stitched: TrendStat;
  harmonized: TrendStat & { boot_lo_pct: number | null; boot_hi_pct: number | null };
  monthly?: { stitched: Record<keyof TrendStat, (number | null)[]>; harmonized: Record<keyof TrendStat, (number | null)[]> };
};

/** Weekly raw counts, the part of series.json `weekly` needed to rebuild the stitched 2012 total. */
export type WeeklyRaw = { start_year: number; weeks_per_year: number; modis: number[]; viirs: (number | null)[] };

export const ALPHA = 0.9; // interval level, as trend_stats.ALPHA
export const SIGNIFICANT_P = 0.05; // "significant" = Mann-Kendall p < 0.05 (registry, FE-014 wording)
const Z = -1.6448536269514722; // scipy.stats.norm.ppf((1 - ALPHA) / 2)
const NULL: TrendStat = { slope_pct: null, lo_pct: null, hi_pct: null, p: null };

export function median(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** numpy.round: halves go to the even neighbour. */
const roundEven = (v: number) => {
  const f = Math.floor(v);
  const d = v - f;
  return d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
};

const round = (v: number, nd: number) => (Number.isFinite(v) ? Number(v.toFixed(nd)) : null);

/** Sizes of groups of equal values with more than one member (scipy `_find_repeats` counts). */
function repeats(v: number[]): number[] {
  const n = new Map<number, number>();
  for (const x of v) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n.values()].filter((k) => k > 1);
}

/** Theil-Sen slope with its ALPHA interval, as scipy.stats.theilslopes(y, x, alpha=ALPHA). */
export function theilSen(x: number[], y: number[]): { slope: number; lo: number; hi: number } {
  const slopes: number[] = [];
  for (let i = 0; i < x.length; i++)
    for (let j = 0; j < x.length; j++) if (x[i] - x[j] > 0) slopes.push((y[i] - y[j]) / (x[i] - x[j]));
  slopes.sort((a, b) => a - b);
  const nt = slopes.length;
  const n = y.length;
  const t = (k: number) => k * (k - 1) * (2 * k + 5);
  const sigsq = (t(n) - repeats(x).reduce((s, k) => s + t(k), 0) - repeats(y).reduce((s, k) => s + t(k), 0)) / 18;
  const sigma = Math.sqrt(sigsq);
  const ru = Math.min(roundEven((nt - Z * sigma) / 2), nt - 1);
  const rl = Math.max(roundEven((nt + Z * sigma) / 2) - 1, 0);
  return { slope: median(slopes), lo: slopes[rl] ?? NaN, hi: slopes[ru] ?? NaN };
}

/** Exact two-sided Kendall p for n values without ties and c concordant pairs (scipy `_kendall_p_exact`). */
export function kendallExactP(n: number, c: number): number {
  const tot = (n * (n - 1)) / 2;
  c = Math.min(c, tot - c);
  let p: number;
  if (n <= 2) p = 1;
  else if (c === 0) p = 2 / factorial(n);
  else if (c === 1) p = 2 / factorial(n - 1);
  else if (4 * c === n * (n - 1)) p = 1;
  else {
    let next = new Array<number>(c + 1).fill(0);
    next[0] = 1;
    next[1] = 1;
    for (let j = 3; j <= n; j++) {
      let acc = 0;
      next = next.map((v) => (acc += v) / j);
      if (j <= c) for (let k = c; k >= j; k--) next[k] -= next[k - j];
    }
    p = next.reduce((s, v) => s + v, 0);
  }
  return Math.min(1, Math.max(0, p));
}

function factorial(n: number): number {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}

/**
 * Complementary error function: Maclaurin series of erf below 2.5, Lentz continued fraction above (both summed to
 * machine precision; relative error < 1e-9 on the range a p-value needs, checked against scipy in the tests).
 */
export function erfc(x: number): number {
  if (x < 0) return 2 - erfc(-x);
  if (x < 2.5) {
    // erf(x) = 2/sqrt(pi) * sum (-1)^n x^(2n+1) / (n! (2n+1))
    let term = x;
    let sum = x;
    for (let n = 1; n < 200 && Math.abs(term) > 1e-17 * Math.abs(sum); n++) {
      term *= (-x * x) / n;
      sum += term / (2 * n + 1);
    }
    return 1 - (2 / Math.sqrt(Math.PI)) * sum;
  }
  // erfc(x) = exp(-x^2)/sqrt(pi) * 1/(x + (1/2)/(x + 1/(x + (3/2)/(x + ...)))), modified Lentz
  const tiny = 1e-300;
  let f = x;
  let c = x;
  let d = 0;
  for (let k = 1; k < 500; k++) {
    const a = k / 2;
    d = x + a * d;
    d = Math.abs(d) < tiny ? 1 / tiny : 1 / d;
    c = x + a / c;
    if (Math.abs(c) < tiny) c = tiny;
    const delta = c * d;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return Math.exp(-x * x) / Math.sqrt(Math.PI) / f;
}

/** Two-sided Mann-Kendall p = scipy.stats.kendalltau(x, y).pvalue (method "auto"); NaN if either is constant. */
export function kendallP(x: number[], y: number[]): number {
  const n = x.length;
  let con = 0;
  let dis = 0;
  let xtie = 0;
  let ytie = 0;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const s = Math.sign(x[i] - x[j]) * Math.sign(y[i] - y[j]);
      if (x[i] === x[j]) xtie++;
      if (y[i] === y[j]) ytie++;
      if (s > 0) con++;
      else if (s < 0) dis++;
    }
  const tot = (n * (n - 1)) / 2;
  if (xtie === tot || ytie === tot) return NaN;
  if (xtie === 0 && ytie === 0 && (n <= 33 || Math.min(dis, tot - dis) <= 1)) return kendallExactP(n, tot - dis);
  const g = (v: number[], f: (k: number) => number) => repeats(v).reduce((s, k) => s + f(k), 0);
  // con - dis equals scipy's con_minus_dis (tot - xtie - ytie + ntie - 2 dis)
  const m = n * (n - 1);
  const v =
    (m * (2 * n + 5) - g(x, (k) => k * (k - 1) * (2 * k + 5)) - g(y, (k) => k * (k - 1) * (2 * k + 5))) / 18 +
    (2 * xtie * ytie) / m +
    (g(x, (k) => k * (k - 1) * (k - 2)) * g(y, (k) => k * (k - 1) * (k - 2))) / (9 * m * (n - 2));
  return Math.min(1, erfc(Math.abs(con - dis) / Math.sqrt(v) / Math.SQRT2));
}

/** trend_stats.trend: slope, interval and p for values y at years x (complete years only). */
export function trend(x: number[], y: number[]): TrendStat {
  const med = median(y);
  if (y.length < 3 || !(med > 0)) return { ...NULL };
  if (y.every((v) => v === y[0])) return { slope_pct: 0, lo_pct: 0, hi_pct: 0, p: 1 };
  const { slope, lo, hi } = theilSen(x, y);
  return { slope_pct: round((100 * slope) / med, 2), lo_pct: round((100 * lo) / med, 2), hi_pct: round((100 * hi) / med, 2), p: round(kendallP(x, y), 4) };
}

/**
 * The naive stitched ledger per year, as model.py builds it: raw MODIS before VIIRS starts (2012-01-20), raw VIIRS
 * after. 2012 needs the weekly file (observed VIIRS from 20 Jan + MODIS for weeks 0-2), so it is null without it.
 */
export function stitchedTotals(D: Annual, weekly?: WeeklyRaw | null): (number | null)[] {
  return D.years.map((yr, i) => {
    if (yr < VIIRS_FROM) return D.modis[i];
    if (yr > VIIRS_FROM) return D.viirs[i] ?? D.modis[i];
    if (!weekly) return null;
    const k = (yr - weekly.start_year) * weekly.weeks_per_year;
    if (k < 0 || k + weekly.weeks_per_year > weekly.modis.length) return null; // weekly file does not cover 2012
    let sum = 0;
    for (let w = k; w < k + weekly.weeks_per_year; w++) sum += weekly.viirs[w] ?? weekly.modis[w];
    return sum;
  });
}

export type RangeTrend = {
  years: number[]; // complete years tested
  stitched: TrendStat | null; // null = 2012 is in range and the weekly file is not loaded
  harmonized: TrendStat;
  boot: [number, number] | null; // back-cast range of the harmonized slope; only when the range is the published block's
};

/**
 * Which years a range tests: the complete years in [from, to] (partial years left out, as model.py does), whether
 * that is exactly the published block (so its stored answers can be used), and whether the weekly file is needed
 * (2012 in range, at least 3 years, and not the published block).
 */
export function rangeYears(D: Annual & { trend?: TrendBlock }, [from, to]: [number, number]) {
  const idx = D.years.flatMap((yr, i) => (yr >= from && yr <= to && D.partial[i] !== 1 ? [i] : []));
  const years = idx.map((i) => D.years[i]);
  const b = D.trend;
  const published = !!b?.years && years.length > 0 && b.years[0] === years[0] && b.years[1] === years[years.length - 1] && b.n_years === years.length;
  const needsWeekly = !published && years.length >= 3 && years.includes(VIIRS_FROM);
  return { idx, years, published, needsWeekly };
}

/** Trends of both records over the complete years in [from, to]. */
export function rangeTrend(D: Annual & { trend?: TrendBlock }, range: [number, number], weekly?: WeeklyRaw | null): RangeTrend {
  const { idx, years, published } = rangeYears(D, range);
  const b = D.trend;
  const st = stitchedTotals(D, weekly);
  const sv = idx.map((i) => st[i]);
  const boot = published && b && b.harmonized.boot_lo_pct !== null && b.harmonized.boot_hi_pct !== null ? ([b.harmonized.boot_lo_pct, b.harmonized.boot_hi_pct] as [number, number]) : null;
  // the published block already holds the stitched answer for its own years, so the default view needs no weekly file
  const stitched = published && b ? b.stitched : sv.every((v) => v !== null) ? trend(years, sv as number[]) : null;
  return { years, stitched, harmonized: trend(years, idx.map((i) => D.harmonized[i])), boot };
}

export const isSignificant = (t: TrendStat) => t.p !== null && t.p < SIGNIFICANT_P;

/** "+3.4% a year" / "−2.1% a year" / "no change"; one decimal, a real minus sign. */
export function slopeLabel(pct: number): string {
  const r = Math.round(pct * 10) / 10;
  if (r === 0) return "no change";
  return `${r > 0 ? "+" : "−"}${Math.abs(r).toFixed(1)}% a year`;
}

/** One clause for a record: "+3.4% a year, not significant". */
export function trendClause(t: TrendStat | null, unavailable = false): string {
  if (t === null) return unavailable ? "unavailable (the weekly file did not load)" : "loading";
  if (t.slope_pct === null || t.p === null) return "no trend can be measured (too little fire)";
  const label = slopeLabel(t.slope_pct);
  return label === "no change" ? label : `${label}, ${isSignificant(t) ? "significant" : "not significant"}`;
}

/**
 * The sentence under the ledger chart, e.g. "Stitched ledger: +3.4% a year, not significant. Harmonized: −2.1% a
 * year, not significant." plus one plain-language reading when the two disagree. Null-safe throughout.
 */
export function trendSentence(r: RangeTrend, stitchedUnavailable = false): string {
  const n = r.years.length;
  if (n < 3) return `A trend needs at least 3 complete years; this range has ${n}.`;
  const head = `${r.years[0]}-${r.years[n - 1]} (${n} complete years). Stitched ledger: ${trendClause(r.stitched, stitchedUnavailable)}. Harmonized: ${trendClause(r.harmonized)}.`;
  const s = r.stitched;
  const h = r.harmonized;
  if (!s || s.slope_pct === null || h.slope_pct === null) return head;
  if (isSignificant(s) && !isSignificant(h)) return `${head} The stitched trend does not hold once both sensors are on one scale.`;
  if (isSignificant(s) && isSignificant(h) && Math.sign(s.slope_pct) !== Math.sign(h.slope_pct))
    return `${head} The two records point in opposite directions; the stitched one carries the sensor change.`;
  if (!isSignificant(s) && isSignificant(h)) return `${head} The harmonized ledger shows a trend the stitched one hides.`;
  return head;
}
