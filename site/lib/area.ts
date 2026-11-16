import type { CalendarStats, Flag, SeriesBundle, Source } from "./series.ts";

export function pyRound(x: number, nd: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const neg = x < 0;
  const s = Math.abs(x).toFixed(100);
  const dot = s.indexOf(".");
  const keep = s.slice(0, dot) + s.slice(dot + 1, dot + 1 + nd);
  const rest = s.slice(dot + 1 + nd);
  let up: boolean;
  if (rest[0] > "5") up = true;
  else if (rest[0] < "5") up = false;
  else if (/[1-9]/.test(rest.slice(1))) up = true;
  else up = Number(keep[keep.length - 1]) % 2 === 1;
  let digits = keep;
  if (up) {
    const d = digits.split("");
    let i = d.length - 1;
    while (i >= 0 && d[i] === "9") d[i--] = "0";
    if (i < 0) d.unshift("1");
    else d[i] = String(Number(d[i]) + 1);
    digits = d.join("");
  }
  return Number(`${neg ? "-" : ""}${digits}e-${nd}`);
}

export function percentileLinear(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) throw new RangeError("percentile of an empty array");
  const v = n * q - q;
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

export const Z95 = 1.6448536269514722;

export type BandParams = { alpha: number; sigma_year: number };

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

export type CellSeries = { modis: readonly number[]; viirs: readonly (number | null)[]; pred: readonly number[] };

export type SumOptions = {
  region: string;
  start_year: number;
  params: BandParams;
  last_month_days?: number;
  source?: readonly Source[];
  baseline?: [number, number];
};

export function sumCells(cells: readonly CellSeries[], o: SumOptions): SeriesBundle {
  if (cells.length === 0) throw new RangeError("no cells selected");
  const n = cells[0].pred.length;
  if (n === 0) throw new RangeError("cell series are empty");
  for (const c of cells) {
    if (c.pred.length !== n || c.modis.length !== n || c.viirs.length !== n)
      throw new RangeError("cell series differ in length");
    for (let i = 0; i < n; i++)
      if (clean(c.modis[i]) == null || (c.viirs[i] != null && clean(c.viirs[i]) == null))
        throw new RangeError(`cell value at month ${i} is missing or NaN`);
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
