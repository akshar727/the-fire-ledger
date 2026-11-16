import { DEFAULT_REGION, isRegionId, type RegionId } from "./regions.ts";

export const MAX_SPAN_DAYS = 366;

export type Bounds = { min: string; max: string };

export type Selection = {
  region: RegionId;
  from: string;
  to: string;
  whole: boolean;
};

const DAY_MS = 86_400_000;

export function isDate(v: unknown): v is string {
  const m = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null;
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

const clamp = (v: string, { min, max }: Bounds) => (v < min ? min : v > max ? max : v);

export function parseSelection(
  params: URLSearchParams,
  boundsOf: (region: RegionId) => Bounds,
  fallback: RegionId = DEFAULT_REGION,
): Selection {
  const q = params.get("region");
  const region = isRegionId(q) ? q : fallback;
  const b = boundsOf(region);
  const f = params.get("from"), t = params.get("to");
  let from = isDate(f) ? clamp(f, b) : b.min;
  let to = isDate(t) ? clamp(t, b) : b.max;
  if (from > to) [from, to] = [to, from];
  return { region, from, to, whole: from === b.min && to === b.max };
}

export function withSelection(
  params: URLSearchParams,
  patch: { region?: RegionId; from?: string; to?: string },
  bounds: Bounds,
): URLSearchParams {
  const next = new URLSearchParams(params);
  if (patch.region) next.set("region", patch.region);
  for (const [key, bound] of [["from", bounds.min], ["to", bounds.max]] as const) {
    const v = patch[key];
    if (v === undefined) continue;
    if (!isDate(v) || v === bound) next.delete(key);
    else next.set(key, v);
  }
  return next;
}

export function moveEnd(sel: { from: string; to: string }, end: "from" | "to", v: string): { from: string; to: string } {
  if (end === "from") return { from: v, to: v > sel.to ? v : sel.to };
  return { from: v < sel.from ? v : sel.from, to: v };
}

export type CalendarView = "month" | "week";

export const parseView = (params: URLSearchParams): CalendarView => (params.get("view") === "week" ? "week" : "month");

export function withView(params: URLSearchParams, view: CalendarView): URLSearchParams {
  const next = new URLSearchParams(params);
  if (view === "week") next.set("view", "week");
  else next.delete("view");
  return next;
}

export function yearsBefore(bounds: Bounds, pointYears: number[]): number[] {
  const first = Number(bounds.min.slice(0, 4));
  return pointYears.filter((y) => y < first).sort((a, b) => a - b);
}

export function spanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

export function yearsIn(from: string, to: string): number[] {
  const out: number[] = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) out.push(y);
  return out;
}

export function yearRange(year: number, bounds: Bounds): { from: string; to: string } {
  return { from: clamp(`${year}-01-01`, bounds), to: clamp(`${year}-12-31`, bounds) };
}

export type Box = { w: number; s: number; e: number; n: number };

export function boxError(b: Box): string | null {
  if (![b.w, b.s, b.e, b.n].every(Number.isFinite)) return "Enter all four edges as numbers.";
  if (b.s < -90 || b.n > 90) return "Latitude must be between -90 and 90.";
  if (b.w < -180 || b.e > 180) return "Longitude must be between -180 and 180.";
  if (!(b.s < b.n)) return "South must be less than north.";
  if (!(b.w < b.e)) return "West must be less than east.";
  return null;
}

export function parseBox(params: URLSearchParams): Box | null {
  const v = params.get("bbox");
  if (v === null) return null;
  const nums = v.split(",").map((p) => (p.trim() === "" ? NaN : Number(p)));
  if (nums.length !== 4) return null;
  const b = { w: nums[0], s: nums[1], e: nums[2], n: nums[3] };
  return boxError(b) ? null : b;
}

export function withBox(params: URLSearchParams, box: Box | null): URLSearchParams {
  const next = new URLSearchParams(params);
  if (box && !boxError(box)) next.set("bbox", [box.w, box.s, box.e, box.n].join(","));
  else next.delete("bbox");
  return next;
}

export const boxesOverlap = (a: Box, b: Box) => a.w <= b.e && b.w <= a.e && a.s <= b.n && b.s <= a.n;

export const regionBox = ([w, s, e, n]: [number, number, number, number]): Box => ({ w, s, e, n });

export function boxLabel(b: Box): string {
  const deg = (v: number, pos: string, neg: string) =>
    `${Number(Math.abs(v).toFixed(4))}°${v < 0 ? neg : v > 0 ? pos : ""}`;
  return `${deg(b.s, "N", "S")} to ${deg(b.n, "N", "S")}, ${deg(b.w, "E", "W")} to ${deg(b.e, "E", "W")}`;
}

export const hotspotsUrl = (s: Selection, box: Box | null = null) =>
  `/api/hotspots?${new URLSearchParams({
    region: s.region,
    from: s.from,
    to: s.to,
    ...(box && !boxError(box) ? { bbox: [box.w, box.s, box.e, box.n].join(",") } : {}),
  })}`;

export const seriesUrl = (s: Selection) =>
  `/api/series?${new URLSearchParams({ region: s.region, res: "monthly", from: s.from.slice(0, 7), to: s.to.slice(0, 7) })}`;

export const pointFileUrl = (region: RegionId, year: number) => `/data/${region}/points/${year}.csv`;
