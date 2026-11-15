// Series bundle (site/public/data/<region>/series.json, registry §3 "Series bundle"): types, a strict parser,
// and the year x month or year x week grid the burn calendar draws (FE-016: week view). Pure functions with relative imports only, so `node --test`
// can run them without the Next.js toolchain.
import { kendallP, SIGNIFICANT_P, theilSen } from "./trend.ts";

export type Flag = -1 | 0 | 1;

export type Monthly = {
  start_year: number;
  bucketing: string;
  modis: number[];
  viirs: (number | null)[]; // null before 2012
  pred: number[]; // VIIRS-equivalent model mean
  lo: number[];
  hi: number[];
  source?: Source[]; // ML-017; optional so older bundles still parse
  last_month_days?: number; // ML-017: days with data in the last month (it may be partial: the forward month to date)
};

/** Where a period's value comes from (ML-017): MODIS back-cast, observed S-NPP, or S-NPP equivalent from NOAA-20/21. */
export type Source = "backcast" | "observed" | "forward";
const SOURCES = new Set(["backcast", "observed", "forward"]);

/** Weekly series: week `w` of a year = day-of-year 7w+1..7w+7, week 51 runs to 31 Dec (8 or 9 days). */
export type Weekly = {
  start_year: number;
  weeks_per_year: 52;
  modis: number[];
  viirs: (number | null)[]; // null for weeks starting before 2012-01-20
  pred: number[];
  lo: number[];
  hi: number[];
  source?: Source[];
  last_week_days: number; // days with data in the last week (it may be partial)
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
  weekly?: Weekly;
  calendar?: CalendarStats;
};

export class SeriesFormatError extends Error {}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function sourceArray(v: unknown, name: string, len: number): void {
  if (v === undefined) return;
  if (!Array.isArray(v) || v.length !== len) throw new SeriesFormatError(`${name} must be an array of ${len} values`);
  v.forEach((x, i) => {
    if (!SOURCES.has(x as string)) throw new SeriesFormatError(`${name}[${i}] is not backcast, observed or forward`);
  });
}

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
  sourceArray(m.source, "monthly.source", n);
  const md = m.last_month_days;
  if (md !== undefined && (!Number.isInteger(md) || (md as number) < 1 || (md as number) > 31))
    throw new SeriesFormatError("monthly.last_month_days must be an integer from 1 to 31");
  const w = b.weekly as Record<string, unknown> | undefined;
  if (w != null) {
    if (typeof w !== "object") throw new SeriesFormatError("weekly is not an object");
    if (!Number.isInteger(w.start_year)) throw new SeriesFormatError("weekly.start_year is not an integer");
    if (w.weeks_per_year !== 52) throw new SeriesFormatError(`weekly.weeks_per_year is ${String(w.weeks_per_year)}, expected 52`);
    numArray(w.modis, "weekly.modis");
    const nw = (w.modis as number[]).length;
    if (nw === 0) throw new SeriesFormatError("weekly series is empty");
    numArray(w.viirs, "weekly.viirs", nw, true);
    for (const k of ["pred", "lo", "hi"]) numArray(w[k], `weekly.${k}`, nw);
    sourceArray(w.source, "weekly.source", nw);
    const d = w.last_week_days;
    if (!Number.isInteger(d) || (d as number) < 1 || (d as number) > 9)
      throw new SeriesFormatError("weekly.last_week_days must be an integer from 1 to 9");
  }
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

export type GridView = "month" | "week";

export type CalendarCell = {
  index: number; // monthly or weekly index, depending on the grid's view
  year: number;
  col: number; // column in the grid, 0-based (month - 1, or the week of the year)
  month: number; // 1-12; in the week view, the month the week starts in
  week: number | null; // 0-51 in the week view, null in the month view
  start: string; // first day of the period, YYYY-MM-DD
  end: string; // last day of the period, YYYY-MM-DD
  length: number; // days in the period
  days: number; // days with data; less than `length` only for a partial last period
  through: string; // last day with data, YYYY-MM-DD (= end unless partial; = start - 1 day when there is no data)
  partial: boolean; // the period has a value but the data stop before its last day
  value: number | null; // harmonized = viirs ?? pred; null = no data for this month
  observed: boolean; // true when the value is a VIIRS observation, false when it is the model's back-cast
  // FE-009: back-cast (MODIS model), observed (S-NPP) or forward (S-NPP to its end + the NOAA-20/21 link after). From
  // the bundle's `source` when present (ML-017), else from `observed`.
  source: Source;
  flag: Flag;
  anomaly: number | null;
  inRange: boolean; // inside the selected dates (sliceGrid); always true from buildGrid
};

export type CalendarGrid = {
  view: GridView;
  cols: number; // 12 months or 52 weeks
  years: number[];
  rows: CalendarCell[][]; // one row per year, `cols` cells each
  max: number;
  partialYears: number[]; // years with at least one month missing
  latest: CalendarCell | null; // last period that has a value
  firstObserved: CalendarCell | null; // first period whose value is a VIIRS observation (earlier ones are back-cast)
  firstForward: CalendarCell | null; // first period with forward-link days (FE-009); null when the bundle has none
};

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** First day, last day and length of week `w` (0-51) of `year`, as the Series bundle defines weeks. */
export function weekSpan(year: number, w: number): { start: string; end: string; length: number } {
  const jan1 = Date.UTC(year, 0, 1);
  const length = w < 51 ? 7 : (isLeap(year) ? 366 : 365) - 7 * 51;
  return { start: isoDay(jan1 + 7 * w * DAY_MS), end: isoDay(jan1 + (7 * w + length - 1) * DAY_MS), length };
}

/** First day, last day and length of `month` (1-12) of `year`. */
export function monthSpan(year: number, month: number): { start: string; end: string; length: number } {
  const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, "0");
  return { start: `${year}-${mm}-01`, end: `${year}-${mm}-${String(length).padStart(2, "0")}`, length };
}

/**
 * Month header groups for the week view: for each month, the first week column that starts in it and how many weeks
 * start in it, using a common (non-leap) year. In a leap year a week can start one day earlier in the calendar (week 39
 * starts 30 Sep instead of 1 Oct), so the header is a guide; each cell's own dates are exact.
 */
export function weekMonthGroups(): { month: number; first: number; span: number }[] {
  const starts = Array.from({ length: 52 }, (_, w) => Number(weekSpan(2001, w).start.slice(5, 7)));
  return Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    first: starts.indexOf(i + 1),
    span: starts.filter((m) => m === i + 1).length,
  }));
}

/**
 * Column in the `to` view that matches column `col` of the other view: a month goes to the first week that starts in
 * it; a week goes to the month whose header group holds it (weekMonthGroups).
 */
export function remapColumn(col: number, to: GridView): number {
  const groups = weekMonthGroups();
  if (to === "week") return groups[Math.max(0, Math.min(11, col))].first;
  return groups.filter((g) => g.first <= col).length - 1;
}

/**
 * Lays the series out as year rows x 12 months (`view` "month", the default) or year rows x 52 weeks ("week", from
 * `weekly`; throws SeriesFormatError if the bundle has none). Periods after the end of the series have value null. The
 * calendar statistics are per month, so in the week view every flag is 0 and every anomaly null.
 */
export function buildGrid(b: SeriesBundle, view: GridView = "month"): CalendarGrid {
  const week = view === "week";
  if (week && !b.weekly) throw new SeriesFormatError("weekly series is missing");
  const s = week ? b.weekly! : b.monthly;
  const cols = week ? 52 : 12, n = s.modis.length;
  const nYears = Math.ceil(n / cols);
  const years: number[] = [], rows: CalendarCell[][] = [], partialYears: number[] = [];
  let max = 0, latest: CalendarCell | null = null, firstObserved: CalendarCell | null = null;
  let firstForward: CalendarCell | null = null;
  for (let y = 0; y < nYears; y++) {
    const year = s.start_year + y, row: CalendarCell[] = [];
    for (let col = 0; col < cols; col++) {
      const i = y * cols + col;
      const v = i < n ? s.viirs[i] : null;
      const value = i < n ? (v ?? s.pred[i]) : null;
      const span = week ? weekSpan(year, col) : monthSpan(year, col + 1);
      // the last week (weekly.last_week_days) and the last month (monthly.last_month_days, ML-017) can stop early
      const lastDays = week ? b.weekly!.last_week_days : b.monthly.last_month_days;
      const days = i >= n ? 0 : i === n - 1 && lastDays != null ? Math.min(lastDays, span.length) : span.length;
      const cell: CalendarCell = {
        index: i,
        year,
        col,
        month: week ? Number(span.start.slice(5, 7)) : col + 1,
        week: week ? col : null,
        ...span,
        days,
        through: isoDay(Date.parse(`${span.start}T00:00:00Z`) + (days - 1) * DAY_MS),
        partial: value != null && days < span.length,
        value,
        observed: v != null,
        source: (i < n && s.source?.[i]) || (v != null ? "observed" : "backcast"),
        flag: (!week && i < n && b.calendar?.flag[i]) || 0,
        anomaly: !week && i < n && b.calendar ? b.calendar.anomaly[i] : null,
        inRange: true,
      };
      if (value != null) {
        max = Math.max(max, value);
        latest = cell;
        if (cell.observed && !firstObserved) firstObserved = cell;
        if (cell.source === "forward" && !firstForward) firstForward = cell;
      }
      row.push(cell);
    }
    if (row.some((c) => c.value == null || c.partial)) partialYears.push(year);
    years.push(year);
    rows.push(row);
  }
  return { view, cols, years, rows, max, partialYears, latest, firstObserved, firstForward };
}

/** Month-to-date comparison for a partial month (FE-009): this month so far against the same days in past years. */
export type MonthToDate = {
  year: number;
  month: number; // 1-12
  days: number; // days with data in this month: 1..days
  value: number; // harmonized detections, days 1..days
  median: number; // median over `years` of harmonized detections on the same days
  p25: number;
  p75: number;
  ratio: number | null; // value / median; null when the median is 0
  years: [number, number]; // past years compared (the calendar baseline years, or every earlier year without one)
  n: number; // how many of them had weekly data
  // the same days in the 3 years before `year` (oldest first), so a long-run median isn't the only yardstick
  recent: { year: number; value: number }[];
};

const median = (v: number[], q = 0.5) => {
  const s = [...v].sort((a, b) => a - b), k = (s.length - 1) * q, lo = Math.floor(k);
  return s[lo] + (s[Math.ceil(k)] - s[lo]) * (k - lo);
};

/**
 * Harmonized detections (`viirs ?? pred`) on days `fromDay`..`toDay` of `month` in `year`, from the weekly series:
 * each week counts by the share of its days inside that window (model.py's day-share rule for monthly values, so a
 * whole month gives the monthly value back). null when the weekly series does not cover every week touched.
 */
export function weeklyWindow(w: Weekly, year: number, month: number, fromDay: number, toDay: number): number | null {
  const mm = String(month).padStart(2, "0");
  const a = Date.parse(`${year}-${mm}-${String(fromDay).padStart(2, "0")}T00:00:00Z`);
  const z = Date.parse(`${year}-${mm}-${String(toDay).padStart(2, "0")}T00:00:00Z`);
  let sum = 0;
  for (let wk = 0; wk < 52; wk++) {
    const span = weekSpan(year, wk);
    const s = Date.parse(`${span.start}T00:00:00Z`), e = Date.parse(`${span.end}T00:00:00Z`);
    const overlap = (Math.min(e, z) - Math.max(s, a)) / DAY_MS + 1;
    if (overlap <= 0) continue;
    const i = (year - w.start_year) * 52 + wk;
    if (i < 0 || i >= w.modis.length) return null;
    sum += (w.viirs[i] ?? w.pred[i]) * (overlap / span.length);
  }
  return sum;
}

/**
 * When the last month of the ledger is partial (`monthly.last_month_days`, ML-017: the forward month to date), compares
 * it with the same days of that month in the baseline years: median and middle half of their harmonized detections on
 * days 1..N, from the weekly series. A partial month is never compared with whole months, and is not flagged. null when
 * the last month is complete or the bundle has no weekly series.
 */
export function monthToDate(b: SeriesBundle): MonthToDate | null {
  const m = b.monthly, n = m.modis.length, w = b.weekly;
  const year = m.start_year + Math.floor((n - 1) / 12), month = ((n - 1) % 12) + 1;
  const days = m.last_month_days;
  if (!w || days == null || days >= monthSpan(year, month).length) return null;
  const [y0, y1] = b.calendar?.baseline_years ?? [m.start_year, year - 1];
  const past: number[] = [];
  for (let y = y0; y <= Math.min(y1, year - 1); y++) {
    const v = weeklyWindow(w, y, month, 1, days);
    if (v != null) past.push(v);
  }
  if (past.length === 0) return null;
  const recent = [year - 3, year - 2, year - 1].flatMap((y) => {
    const v = y >= m.start_year ? weeklyWindow(w, y, month, 1, days) : null;
    return v == null ? [] : [{ year: y, value: v }];
  });
  // this month's own value is the monthly one: model.py places forward days in their month exactly, while the weekly
  // window would split the week that straddles the month start by day share
  const value = m.viirs[n - 1] ?? m.pred[n - 1];
  const med = median(past);
  return {
    year,
    month,
    days,
    value,
    median: med,
    p25: median(past, 0.25),
    p75: median(past, 0.75),
    ratio: med > 0 ? value / med : null,
    years: [y0, Math.min(y1, year - 1)],
    n: past.length,
    recent,
  };
}

/**
 * Keeps the year rows that the selected dates touch and marks months outside them (`inRange: false`). Takes
 * `YYYY-MM-DD` dates; a month or week counts as inside if any of its days is. `max`, `latest` and `firstObserved` still describe
 * the whole ledger, so colours and the latest-month card don't change with the filter.
 */
export function sliceGrid(g: CalendarGrid, from: string, to: string): CalendarGrid {
  const keep = g.years.map((y) => y >= Number(from.slice(0, 4)) && y <= Number(to.slice(0, 4)));
  return {
    ...g,
    years: g.years.filter((_, r) => keep[r]),
    rows: g.rows.filter((_, r) => keep[r]).map((row) => row.map((c) => ({ ...c, inRange: c.end >= from && c.start <= to }))),
    partialYears: g.partialYears.filter((y) => keep[g.years.indexOf(y)]),
  };
}

/** "29 Oct" from YYYY-MM-DD. */
export const dayMonth = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;

/** "29 Oct to 4 Nov 2026" for a week, "October 2026" for a month. */
export function periodLabel(cell: CalendarCell): string {
  if (cell.week == null) return `${MONTHS_LONG[cell.month - 1]} ${cell.year}`;
  return `${dayMonth(cell.start)} to ${dayMonth(cell.end)} ${cell.year}`;
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
  // red thermal ramp (site theme): ember red through orange to pale gold; same lightness steps as before
  dark: [
    [0.25, 0.03, 25],
    [0.45, 0.15, 22],
    [0.67, 0.19, 32],
    [0.91, 0.12, 75],
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

/** Ratio to the month median: 0.18×, 2.4×, 12×. Two decimals below 1 so low months don't all read "0.1×". */
export function times(r: number): string {
  return `${r < 1 ? r.toFixed(2) : r < 10 ? r.toFixed(1) : Math.round(r)}×`;
}

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
export const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

// FE-017: season timing. When in each fire season the running total reaches 10%, 50% and 90% of that season's total,
// from the weekly cumulative sums `outlook.seasons()` builds (lib/outlook.ts imports this file, so seasons come in as a
// plain shape here), and whether those dates drift over the years (Theil-Sen + Mann-Kendall, as the ledger trend).

/** The fields of an outlook `Season` this needs: running total after each of its 52 weeks, first week `startWeek`. */
export type SeasonCum = { year: number; label: string; start: string; cum: number[] };

export const TIMING_SHARES = [0.1, 0.5, 0.9] as const;

/**
 * Days into the season (fractional; 0 = start of its first day) at which the running total reaches `share` of the
 * season total, spreading each week's detections evenly over its days. Season week k is calendar week
 * `(startWeek + k) % 52`, so week 51's 8 or 9 days count in full. null for a season with no fire.
 */
export function dayAtShare(cum: number[], startYear: number, startWeek: number, share: number): number | null {
  const total = cum.at(-1) ?? 0;
  if (!(total > 0)) return null;
  const target = share * total;
  let days = 0, prev = 0;
  for (let k = 0; k < cum.length; k++) {
    const c = startWeek + k, len = weekSpan(startYear + Math.floor(c / 52), c % 52).length;
    // tolerance: 0.1 * 30 is 3.0000000000000004, which must still be reached by a running total of exactly 3
    if (cum[k] >= target - 1e-9 * total) return days + (len * Math.max(0, target - prev)) / (cum[k] - prev);
    days += len;
    prev = cum[k];
  }
  return days;
}

export type SeasonTiming = {
  year: number;
  label: string;
  start: string;
  total: number;
  /** day of the season (0-based) during which 10%, 50% and 90% are reached */
  days: [number, number, number];
  /** the same days as dates, YYYY-MM-DD */
  dates: [string, string, string];
};

/**
 * 10% / 50% / 90% dates of every whole season. Pass complete seasons only (outlook's `past`: 52 whole weeks), so the
 * partial current season and a partial first or last year never enter; seasons without 52 weeks or without fire are
 * dropped here too.
 */
export function seasonTiming(seasons: SeasonCum[], startWeek: number): SeasonTiming[] {
  return seasons.flatMap((s) => {
    if (s.cum.length !== 52) return [];
    const f = TIMING_SHARES.map((q) => dayAtShare(s.cum, s.year, startWeek, q));
    if (f.some((d) => d == null)) return [];
    // ceil less a hair: a share reached exactly at the end of day 21 (d = 21 + float noise) belongs to day index 20
    const days = f.map((d) => Math.max(0, Math.ceil(d! - 1e-9) - 1)) as [number, number, number];
    const t0 = Date.parse(`${s.start}T00:00:00Z`);
    return [{
      year: s.year,
      label: s.label,
      start: s.start,
      total: s.cum[51],
      days,
      dates: days.map((d) => isoDay(t0 + d * DAY_MS)) as [string, string, string],
    }];
  });
}

export type TimingDrift = {
  /** 0, 1, 2 for the 10%, 50%, 90% date */
  which: number;
  /** Theil-Sen slope in days per decade (positive = later in the season), with its 90% interval */
  perDecade: number;
  lo: number;
  hi: number;
  /** two-sided Mann-Kendall p; NaN when the dates never change */
  p: number;
  n: number;
};

/** Drift of the `which` date (0 = 10%, 1 = 50%, 2 = 90%) across seasons; null with fewer than 5 seasons. */
export function timingDrift(rows: SeasonTiming[], which: number): TimingDrift | null {
  if (rows.length < 5) return null;
  const x = rows.map((r) => r.year), y = rows.map((r) => r.days[which]);
  const { slope, lo, hi } = theilSen(x, y);
  return { which, perDecade: 10 * slope, lo: 10 * lo, hi: 10 * hi, p: kendallP(x, y), n: rows.length };
}

/** "6 days later", "2.5 days earlier", "no change": a drift in days per decade. */
export function driftDays(perDecade: number): string {
  const a = Math.abs(perDecade);
  if (a < 0.05) return "no change";
  const v = a < 10 ? a.toFixed(1).replace(/\.0$/, "") : String(Math.round(a));
  return `${v} day${v === "1" ? "" : "s"} ${perDecade > 0 ? "later" : "earlier"}`;
}

const TIMING_NAMES = ["first 10%", "halfway point", "90% point"] as const;

/**
 * One sentence on whether onset (the 10% date) is drifting, with the halfway date as a second reading. "Drifting" =
 * Mann-Kendall p < SIGNIFICANT_P and a 90% interval that excludes 0, the same bar as the ledger trend sentence.
 */
export function timingSentence(rows: SeasonTiming[], region: string): string {
  const on = timingDrift(rows, 0), mid = timingDrift(rows, 1);
  if (!on || !mid) return `Too few whole fire seasons in ${region} to tell whether the season's timing is drifting.`;
  const real = (d: TimingDrift) => d.p < SIGNIFICANT_P && (d.lo > 0 || d.hi < 0);
  const span = `${rows[0].label} to ${rows.at(-1)!.label}`;
  const read = (d: TimingDrift, verb: string) => {
    const days = driftDays(d.perDecade);
    if (real(d)) return `${verb} ${days} per decade (90% interval ${signedDays(d.lo)} to ${signedDays(d.hi)}), a consistent shift`;
    if (Number.isNaN(d.p)) return "falls on the same day of the season every year";
    if (days === "no change") return `shows no drift (p = ${fmtP(d.p)})`;
    return `${verb} ${days} per decade, within the year-to-year scatter (p = ${fmtP(d.p)})`;
  };
  const lead = real(on)
    ? `Onset is drifting in ${region}: across ${rows.length} whole seasons (${span}) the ${TIMING_NAMES[0]} of the season's fire ${read(on, "arrives")}`
    : `Onset is not clearly drifting in ${region}: across ${rows.length} whole seasons (${span}) the ${TIMING_NAMES[0]} ${read(on, "arrives")}`;
  return `${lead}; the ${TIMING_NAMES[1]} ${read(mid, "moves")}.`;
}

const signedDays = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v) < 10 ? Math.abs(v).toFixed(1).replace(/\.0$/, "") : Math.round(Math.abs(v))}`;
const fmtP = (p: number) => (Number.isNaN(p) ? "n/a" : p < 0.001 ? "< 0.001" : p.toFixed(p < 0.01 ? 3 : 2));
