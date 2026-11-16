import { monthSpan, weekSpan } from "./series.ts";

export type Res = "annual" | "monthly" | "weekly";
type Num = (number | null)[];
export type Block = {
  start_year: number;
  modis?: Num;
  viirs?: Num;
  pred?: Num;
  lo?: Num;
  hi?: Num;
  harmonized?: Num;
  source?: unknown[];
  partial?: unknown[];
  last_month_days?: number;
  last_week_days?: number;
};

const SOURCES = new Set(["backcast", "observed", "forward"]);

const cell = (a: Num | undefined, i: number): number | null => {
  const v = a?.[i];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

export function num(v: number | null): string {
  if (v === null) return "";
  const r = Math.round(v * 10) / 10;
  return String(Object.is(r, -0) ? 0 : r);
}

export function periods(res: Res, b: Block, years?: number[]): string[] {
  if (res === "annual") return (years ?? []).map(String);
  const len = Math.max(...[b.modis, b.viirs, b.pred, b.lo, b.hi].map((a) => a?.length ?? 0));
  return Array.from({ length: len }, (_, i) =>
    res === "monthly"
      ? `${b.start_year + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`
      : `${b.start_year + Math.floor(i / 52)}-W${String(i % 52).padStart(2, "0")}`,
  );
}

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

export function seriesFilename(region: string, res: Res, from: string | null, to: string | null): string {
  const parts = [region, res, from !== null ? `from-${from}` : null, to !== null ? `to-${to}` : null];
  return `series_${parts.filter((x) => x !== null).join("_")}.csv`;
}
