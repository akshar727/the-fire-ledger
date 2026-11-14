// Series bundle (site/public/data/<region>/series.json, registry §3 "Series bundle"): types, a strict parser,
// and the year x month grid the burn calendar draws. Pure functions with relative imports only, so `node --test`
// can run them without the Next.js toolchain.

export type Flag = -1 | 0 | 1;

export type Monthly = {
  start_year: number;
  bucketing: string;
  modis: number[];
  viirs: (number | null)[]; // null before 2012
  pred: number[]; // VIIRS-equivalent model mean
  lo: number[];
  hi: number[];
};

/** Per-month statistics from ML-005; optional until ML-005 lands. */
export type CalendarStats = {
  baseline_years: [number, number];
  month_median: number[]; // 12
  month_p25: number[]; // 12
  month_p75: number[]; // 12
  anomaly: (number | null)[]; // ratio to the month median, one per monthly index; null where the median is 0
  flag: Flag[]; // -1 low, 0 normal, 1 high, one per monthly index
};

export type SeriesBundle = {
  schema: 1;
  region: string;
  monthly: Monthly;
  calendar?: CalendarStats;
};

export class SeriesFormatError extends Error {}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function numArray(v: unknown, name: string, len?: number, nullable = false): void {
  if (!Array.isArray(v)) throw new SeriesFormatError(`${name} is not an array`);
  if (len != null && v.length !== len) throw new SeriesFormatError(`${name} has ${v.length} values, expected ${len}`);
  v.forEach((x, i) => {
    if (!(isNum(x) || (nullable && x === null))) throw new SeriesFormatError(`${name}[${i}] is not a number`);
  });
}

/** Checks a parsed series.json against the registered contract; throws SeriesFormatError on the first problem. */
export function parseSeries(raw: unknown): SeriesBundle {
  if (typeof raw !== "object" || raw === null) throw new SeriesFormatError("not a JSON object");
  const b = raw as Record<string, unknown>;
  if (b.schema !== 1) throw new SeriesFormatError(`unsupported schema ${String(b.schema)}`);
  if (typeof b.region !== "string") throw new SeriesFormatError("region is missing");
  const m = b.monthly as Record<string, unknown> | undefined;
  if (typeof m !== "object" || m === null) throw new SeriesFormatError("monthly is missing");
  if (!Number.isInteger(m.start_year)) throw new SeriesFormatError("monthly.start_year is not an integer");
  if (typeof m.bucketing !== "string") throw new SeriesFormatError("monthly.bucketing is not a string");
  numArray(m.modis, "monthly.modis");
  const n = (m.modis as number[]).length;
  if (n === 0) throw new SeriesFormatError("monthly series is empty");
  numArray(m.viirs, "monthly.viirs", n, true);
  for (const k of ["pred", "lo", "hi"]) numArray(m[k], `monthly.${k}`, n);
  const c = b.calendar as Record<string, unknown> | undefined;
  if (c != null) {
    for (const k of ["month_median", "month_p25", "month_p75"]) numArray(c[k], `calendar.${k}`, 12);
    numArray(c.baseline_years, "calendar.baseline_years", 2);
    numArray(c.anomaly, "calendar.anomaly", n, true);
    numArray(c.flag, "calendar.flag", n);
    if ((c.flag as number[]).some((f) => f !== -1 && f !== 0 && f !== 1))
      throw new SeriesFormatError("calendar.flag values must be -1, 0 or 1");
  }
  return raw as SeriesBundle;
}

export type CalendarCell = {
  index: number; // monthly index
  year: number;
  month: number; // 1-12
  value: number | null; // harmonized = viirs ?? pred; null = no data for this month
  observed: boolean; // true when the value is a VIIRS observation, false when it is the model's back-cast
  flag: Flag;
  anomaly: number | null;
};

export type CalendarGrid = {
  years: number[];
  rows: CalendarCell[][]; // one row per year, 12 cells each
  max: number;
  partialYears: number[]; // years with at least one month missing
  latest: CalendarCell | null; // last month that has a value
};

/** Lays the monthly series out as year rows x 12 months. Months after the end of the series have value null. */
export function buildGrid(b: SeriesBundle): CalendarGrid {
  const m = b.monthly, n = m.modis.length;
  const nYears = Math.ceil(n / 12);
  const years: number[] = [], rows: CalendarCell[][] = [], partialYears: number[] = [];
  let max = 0, latest: CalendarCell | null = null;
  for (let y = 0; y < nYears; y++) {
    const year = m.start_year + y, row: CalendarCell[] = [];
    for (let mo = 0; mo < 12; mo++) {
      const i = y * 12 + mo;
      const v = i < n ? m.viirs[i] : null;
      const value = i < n ? (v ?? m.pred[i]) : null;
      const cell: CalendarCell = {
        index: i,
        year,
        month: mo + 1,
        value,
        observed: v != null,
        flag: (i < n && b.calendar?.flag[i]) || 0,
        anomaly: i < n && b.calendar ? b.calendar.anomaly[i] : null,
      };
      if (value != null) {
        max = Math.max(max, value);
        latest = cell;
      }
      row.push(cell);
    }
    if (row.some((c) => c.value == null)) partialYears.push(year);
    years.push(year);
    rows.push(row);
  }
  return { years, rows, max, partialYears, latest };
}

/** Position on the colour ramp, 0-1, on a log scale (monthly fire counts span three orders of magnitude). */
export function rampPosition(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0;
  return Math.min(1, Math.log1p(value) / Math.log1p(max));
}

type Oklch = [number, number, number];

// Sequential ramps with strictly monotonic lightness, so order stays readable with any colour-vision deficiency.
// Light mode runs pale to dark; dark mode runs dark to bright (low months recede into the page in both).
export const RAMP: Record<"light" | "dark", Oklch[]> = {
  light: [
    [0.97, 0.02, 75],
    [0.82, 0.12, 62],
    [0.64, 0.19, 40],
    [0.42, 0.16, 25],
  ],
  dark: [
    [0.25, 0.02, 40],
    [0.45, 0.13, 35],
    [0.67, 0.18, 48],
    [0.91, 0.14, 92],
  ],
};

/** WCAG relative luminance of an oklch colour (via OKLab -> linear sRGB, clipped to the sRGB gamut). */
export function luminance([l, c, h]: Oklch): number {
  const a = c * Math.cos((h * Math.PI) / 180), b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clip = (v: number) => Math.min(1, Math.max(0, v));
  const r = clip(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_);
  const g = clip(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_);
  const bl = clip(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_);
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}

const contrast = (y1: number, y2: number) => (Math.max(y1, y2) + 0.05) / (Math.min(y1, y2) + 0.05);

/**
 * Colour at ramp position t, plus whichever ink (white or black) contrasts more with it. Pure white/black are used
 * on purpose: with them the worst cell on any ramp still clears WCAG AA 4.5:1 for the small cell labels.
 */
export function rampColor(t: number, mode: "light" | "dark"): { bg: string; ink: string; lightness: number; contrast: number } {
  const stops = RAMP[mode];
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const k = Math.min(stops.length - 2, Math.floor(x)), f = x - k;
  const [l, c, h] = stops[k].map((a, j) => a + (stops[k + 1][j] - a) * f) as Oklch;
  const y = luminance([l, c, h]);
  const onWhite = contrast(y, 1), onBlack = contrast(y, 0);
  return {
    bg: `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)})`,
    ink: onWhite >= onBlack ? "#fff" : "#000",
    lightness: l,
    contrast: Math.max(onWhite, onBlack),
  };
}

/** Short cell label: 46, 1.5k, 19k. */
export function compact(v: number): string {
  if (v < 1000) return String(Math.round(v));
  if (v < 10000) return `${(v / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(v / 1000)}k`;
}

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
export const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;
