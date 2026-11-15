// Burn calendar for any sum of cells (FE-010): a port of calendar_stats.py `calendar_block` (ML-005) so the site can
// compute the calendar statistics for an area the user picks, plus an approximate 5-95% band for that area from the
// region's fitted parameters (`score.alpha`, `score.sigma_year` in annual.json). `sumCells` turns per-cell monthly
// series into a SeriesBundle, so `buildGrid` and `BurnCalendar` draw a custom area exactly like a whole region.
// Pure and import-free apart from types, so client components and `node --test` can both use it.
import type { CalendarStats, Flag, SeriesBundle, Source } from "./series.ts";

/**
 * Python's `round(x, nd)`: the decimal nearest to the exact binary value of `x`, ties to even. `Math.round` and
 * `toFixed` both break ties upward (round(0.125, 2) is 0.12 in Python, 0.13 with toFixed), so the port uses this to get
 * the same numbers as calendar_stats.py. Exact for every double with at most 100 decimal places, i.e. any value whose
 * size matters here (smaller ones round to 0 either way).
 */
export function pyRound(x: number, nd: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const neg = x < 0;
  const s = Math.abs(x).toFixed(100); // exact decimal expansion of the double
  const dot = s.indexOf(".");
  const keep = s.slice(0, dot) + s.slice(dot + 1, dot + 1 + nd); // integer digits + nd decimals
  const rest = s.slice(dot + 1 + nd);
  let up: boolean;
  if (rest[0] > "5") up = true;
  else if (rest[0] < "5") up = false;
  else if (/[1-9]/.test(rest.slice(1))) up = true;
  else up = Number(keep[keep.length - 1]) % 2 === 1; // exact tie: to even
  let digits = keep;
  if (up) {
    // add 1 to the digit string (no BigInt: the site targets ES2017)
    const d = digits.split("");
    let i = d.length - 1;
    while (i >= 0 && d[i] === "9") d[i--] = "0";
    if (i < 0) d.unshift("1");
    else d[i] = String(Number(d[i]) + 1);
    digits = d.join("");
  }
  return Number(`${neg ? "-" : ""}${digits}e-${nd}`);
}

/**
 * NumPy's default percentile (method "linear") of an ascending array, `q` in [0, 1]. Same arithmetic as NumPy's
 * `_lerp`, including its switch to `b - (b - a) * (1 - t)` for t >= 0.5, so results match to the last bit.
 */
export function percentileLinear(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) throw new RangeError("percentile of an empty array");
  const v = n * q - q; // NumPy: n*q + (alpha + q*(1 - alpha - beta)) - 1 with alpha = beta = 1
  const lo = Math.min(Math.max(Math.floor(v), 0), n - 1);
  const hi = Math.min(lo + 1, n - 1);
  const t = v - Math.floor(v);
  const a = sorted[lo], b = sorted[hi];
  const d = b - a;
  return t >= 0.5 ? b - d * (1 - t) : a + d * t;
}

function clean(v: number | null | undefined): number | null {
  if (v == null || Number.isNaN(v)) return null;
  if (!Number.isFinite(v) || v < 0) throw new RangeError(`invalid monthly value ${v}: must be finite and >= 0`);
  return v;
}

/**
 * Port of calendar_stats.py `calendar_block`: the `calendar` block of series.json for a monthly series (index i is year
 * startYear + floor(i / 12), month i % 12 + 1; the last year may be partial). null / NaN = missing; negative or infinite
 * values throw RangeError. Baseline = complete years (all 12 months present) with baseline[0] <= year <= baseline[1];
 * RangeError if there is none. Per-month median / p25 / p75 (NumPy linear percentile) are rounded to 3 decimals before
 * the anomaly (value / median, 4 decimals, null where the median is 0 or the value is missing) and the flag: +1 if
 * value > p75 and value >= 2 x median and value >= median + 20, -1 if value < p25 and value <= 0.5 x median and
 * value <= median - 20, else 0 (missing months 0).
 */
export function calendarBlock(
  harmonized: readonly (number | null | undefined)[],
  startYear: number,
  baseline: [number, number] = [2001, 2025],
): CalendarStats {
  const vals = harmonized.map(clean);
  const n = vals.length;
  const [b0, b1] = baseline;
  const rows: number[][] = [];
  for (let y = 0; y < Math.floor(n / 12); y++) {
    if (startYear + y < b0 || startYear + y > b1) continue;
    const row = vals.slice(y * 12, (y + 1) * 12);
    if (row.every((v) => v != null)) rows.push(row as number[]);
  }
  if (rows.length === 0)
    throw new RangeError(
      `no complete baseline year (all 12 months present) between ${b0} and ${b1} for a series of ${n} months starting ${startYear}`,
    );
  const med: number[] = [], p25: number[] = [], p75: number[] = [];
  for (let m = 0; m < 12; m++) {
    const col = rows.map((r) => r[m]).sort((a, b) => a - b);
    med.push(pyRound(percentileLinear(col, 0.5), 3));
    p25.push(pyRound(percentileLinear(col, 0.25), 3));
    p75.push(pyRound(percentileLinear(col, 0.75), 3));
  }
  const anomaly: (number | null)[] = [], flag: Flag[] = [];
  vals.forEach((v, i) => {
    const m = i % 12;
    if (v == null) {
      anomaly.push(null);
      flag.push(0);
      return;
    }
    const md = med[m], lo = p25[m], hi = p75[m];
    anomaly.push(md !== 0 ? pyRound(v / md, 4) : null);
    if (v > hi && v >= 2 * md && v >= md + 20) flag.push(1);
    else if (v < lo && v <= 0.5 * md && v <= md - 20) flag.push(-1);
    else flag.push(0);
  });
  return { baseline_years: [b0, b1], month_median: med, month_p25: p25, month_p75: p75, anomaly, flag };
}

/** z of the 95th percentile of a standard normal. */
export const Z95 = 1.6448536269514722;

/** Fitted parameters of a region's model (annual.json `score`): NB dispersion and the year-level log error. */
export type BandParams = { alpha: number; sigma_year: number };

/**
 * Approximate 5-95% band for the total of several cells over one period, from each cell's model mean `mus`:
 * variance = sum(mu + alpha mu^2) (negative-binomial count noise per cell) + (sigma_year sum(mu))^2 (the year factor
 * all cells share), then a lognormal with that mean and variance. "Approximate": model.py's bands come from a
 * bootstrap, which also holds the fit's parameter noise and splits each cell into day/night x week rows (so its
 * alpha term is smaller than summing it per cell-month, as here). A zero total gives a zero band.
 */
export function approxBand(mus: readonly number[], { alpha, sigma_year }: BandParams): { mean: number; lo: number; hi: number } {
  let mean = 0, v = 0;
  for (const mu of mus) {
    if (!Number.isFinite(mu) || mu < 0) throw new RangeError(`invalid cell mean ${mu}: must be finite and >= 0`);
    mean += mu;
    v += mu + alpha * mu * mu;
  }
  if (!(mean > 0)) return { mean: 0, lo: 0, hi: 0 };
  v += (sigma_year * mean) ** 2;
  const s2 = Math.log1p(v / (mean * mean));
  const m = Math.log(mean) - s2 / 2, s = Math.sqrt(s2);
  return { mean, lo: Math.exp(m - Z95 * s), hi: Math.exp(m + Z95 * s) };
}

/** One cell's monthly series (same indexing as series.json `monthly`); `viirs` null before VIIRS. */
export type CellSeries = { modis: readonly number[]; viirs: readonly (number | null)[]; pred: readonly number[] };

export type SumOptions = {
  region: string; // label written into the bundle, e.g. "portugal:custom"
  start_year: number;
  params: BandParams;
  last_month_days?: number; // the last month may be partial (series.json monthly.last_month_days)
  source?: readonly Source[]; // the region's monthly.source (same for every cell), so forward months stay marked
  baseline?: [number, number];
};

/**
 * Sums cells into a SeriesBundle (monthly only) that `buildGrid` and `BurnCalendar` draw like a region: modis / viirs /
 * pred are the cell sums (1 dp, as series.json); viirs is null for a month where any cell has none; lo / hi come from
 * `approxBand`; `calendar` is `calendarBlock` on the harmonized sum (viirs ?? pred), leaving out a partial last month as
 * model.py does. Throws RangeError for no cells, cells of different lengths, a missing / NaN / negative / infinite
 * modis, viirs or pred value (viirs may be null), or no complete baseline year.
 */
export function sumCells(cells: readonly CellSeries[], o: SumOptions): SeriesBundle {
  if (cells.length === 0) throw new RangeError("no cells selected");
  const n = cells[0].pred.length;
  if (n === 0) throw new RangeError("cell series are empty");
  for (const c of cells) {
    if (c.pred.length !== n || c.modis.length !== n || c.viirs.length !== n)
      throw new RangeError("cell series differ in length");
    for (let i = 0; i < n; i++)
      if (clean(c.modis[i]) == null || (c.viirs[i] != null && clean(c.viirs[i]) == null))
        throw new RangeError(`cell value at month ${i} is missing or NaN`); // clean() throws on negative / infinite
  }
  if (o.source && o.source.length !== n) throw new RangeError("source differs in length from the cells");
  const r1 = (x: number) => pyRound(x, 1);
  const modis: number[] = [], viirs: (number | null)[] = [], pred: number[] = [], lo: number[] = [], hi: number[] = [];
  for (let i = 0; i < n; i++) {
    let mo = 0, vi: number | null = 0;
    const mus: number[] = [];
    for (const c of cells) {
      mo += c.modis[i];
      const v = c.viirs[i];
      vi = v == null || vi == null ? null : vi + v;
      mus.push(c.pred[i]);
    }
    const b = approxBand(mus, o.params);
    modis.push(r1(mo));
    viirs.push(vi == null ? null : r1(vi));
    pred.push(r1(b.mean));
    lo.push(r1(b.lo));
    hi.push(r1(b.hi));
  }
  const harmonized: (number | null)[] = viirs.map((v, i) => v ?? pred[i]);
  const lastYear = o.start_year + Math.floor((n - 1) / 12), lastMonth = ((n - 1) % 12) + 1;
  const lastLength = new Date(Date.UTC(lastYear, lastMonth, 0)).getUTCDate();
  if (o.last_month_days != null && o.last_month_days < lastLength) harmonized[n - 1] = null;
  const monthly: SeriesBundle["monthly"] = {
    start_year: o.start_year,
    bucketing: "calendar-month-day-share",
    modis,
    viirs,
    pred,
    lo,
    hi,
    ...(o.source ? { source: [...o.source] } : {}),
    ...(o.last_month_days != null ? { last_month_days: o.last_month_days } : {}),
  };
  return {
    schema: 1,
    region: o.region,
    monthly,
    calendar: calendarBlock(harmonized, o.start_year, o.baseline),
  };
}
