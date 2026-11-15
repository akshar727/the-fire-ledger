// Analytics CSV for GET /api/series (registry §4 "Series CSV"): builds the file from annual.json or one series.json
// block. Pure, relative imports only, so `node --test` covers every column (BE-006).
import { monthSpan, weekSpan } from "./series.ts";

export type Res = "annual" | "monthly" | "weekly";
type Num = (number | null)[];
// harmonized: annual.json only (ML-009; 2012 blends model weeks before VIIRS started). series.json blocks have none:
// their viirs is already null before 20 Jan 2012, so viirs ?? pred is the harmonized value there.
// source (ML-017, FE-009): backcast | observed | forward per period, in annual.json and both series.json blocks
export type Block = {
  start_year: number;
  modis?: Num;
  viirs?: Num;
  pred?: Num;
  lo?: Num;
  hi?: Num;
  harmonized?: Num;
  source?: unknown[];
  /** annual.json: 1 = the year is still running */
  partial?: unknown[];
  /** series.json monthly: days with data in the last month */
  last_month_days?: number;
  /** series.json weekly: days with data in the last week */
  last_week_days?: number;
};

const SOURCES = new Set(["backcast", "observed", "forward"]);

const cell = (a: Num | undefined, i: number): number | null => {
  const v = a?.[i];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

/** One decimal at most, without float noise: 98026.99999999999 -> "98027", 146284.34999999998 -> "146284.3". */
export function num(v: number | null): string {
  if (v === null) return "";
  const r = Math.round(v * 10) / 10;
  return String(Object.is(r, -0) ? 0 : r);
}

/** Period labels: annual `YYYY` (from `years`), monthly `YYYY-MM`, weekly `YYYY-Www` (ww = 00-51). */
export function periods(res: Res, b: Block, years?: number[]): string[] {
  if (res === "annual") return (years ?? []).map(String);
  const len = Math.max(...[b.modis, b.viirs, b.pred, b.lo, b.hi].map((a) => a?.length ?? 0));
  return Array.from({ length: len }, (_, i) =>
    res === "monthly"
      ? `${b.start_year + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`
      : `${b.start_year + Math.floor(i / 52)}-W${String(i % 52).padStart(2, "0")}`,
  );
}

/** 1 when period `i` is incomplete: annual from `partial`; monthly/weekly only the last period, from its days with data. */
export function isPartial(res: Res, b: Block, i: number, n: number): 0 | 1 {
  if (res === "annual") return b.partial?.[i] === 1 ? 1 : 0;
  if (i !== n - 1) return 0;
  const year = b.start_year + Math.floor(i / (res === "monthly" ? 12 : 52));
  if (res === "monthly") {
    const len = monthSpan(year, (i % 12) + 1).length;
    return typeof b.last_month_days === "number" && b.last_month_days < len ? 1 : 0;
  }
  const len = weekSpan(year, i % 52).length;
  return typeof b.last_week_days === "number" && b.last_week_days < len ? 1 : 0;
}

/**
 * The CSV text. Columns `period,modis,viirs,pred,lo,hi,harmonized,source,partial`, plus `week_start,week_end` for
 * weekly; new columns go at the end so readers of the older files keep their column positions. `from`/`to` are
 * inclusive and compared with the period prefix of their own length (YYYY, or YYYY-MM for monthly).
 */
export function seriesCsv(res: Res, b: Block, from: string | null, to: string | null, years?: number[]): string {
  const ps = periods(res, b, years);
  const head = ["period", "modis", "viirs", "pred", "lo", "hi", "harmonized", "source", "partial"];
  if (res === "weekly") head.push("week_start", "week_end");
  const lines = [head.join(",")];
  ps.forEach((p, i) => {
    if (from !== null && p.slice(0, from.length) < from) return;
    if (to !== null && p.slice(0, to.length) > to) return;
    const viirs = cell(b.viirs, i), pred = cell(b.pred, i);
    const harmonized = cell(b.harmonized, i) ?? viirs ?? pred;
    const src = b.source?.[i];
    const row = [
      p,
      ...[cell(b.modis, i), viirs, pred, cell(b.lo, i), cell(b.hi, i), harmonized].map(num),
      typeof src === "string" && SOURCES.has(src) ? src : "",
      String(isPartial(res, b, i, ps.length)),
    ];
    if (res === "weekly") {
      const s = weekSpan(b.start_year + Math.floor(i / 52), i % 52);
      row.push(s.start, s.end);
    }
    lines.push(row.join(","));
  });
  return lines.join("\n") + "\n";
}

/** `series_ghana_weekly.csv`, or with the range: `series_ghana_monthly_from-2020-01_to-2025-12.csv`. */
export function seriesFilename(region: string, res: Res, from: string | null, to: string | null): string {
  const parts = [region, res, from !== null ? `from-${from}` : null, to !== null ? `to-${to}` : null];
  return `series_${parts.filter((x) => x !== null).join("_")}.csv`;
}
