// Region and date selection shared by every data view, kept in the URL as ?region=&from=&to= (FE-001 decision) so a
// demo link can open on a prepared view. Pure functions with relative imports only, so `node --test` can run them.
import { DEFAULT_REGION, isRegionId, type RegionId } from "./regions.ts";

/** Longest /api/hotspots request, in days, both ends included. lib/server-data.ts enforces the same value. */
export const MAX_SPAN_DAYS = 366;

/** First and last selectable day of a region's record, inclusive, YYYY-MM-DD. */
export type Bounds = { min: string; max: string };

export type Selection = {
  region: RegionId;
  from: string; // YYYY-MM-DD, inclusive
  to: string; // YYYY-MM-DD, inclusive
  whole: boolean; // true when the range is the region's whole record
};

const DAY_MS = 86_400_000;

/** Strict YYYY-MM-DD that is a real calendar date. */
export function isDate(v: unknown): v is string {
  const m = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null;
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

const clamp = (v: string, { min, max }: Bounds) => (v < min ? min : v > max ? max : v);

/**
 * Reads the selection from the query string. Unknown regions fall back to `fallback`; missing or invalid dates fall
 * back to the region's bounds; dates outside the bounds are clamped; a reversed range is swapped.
 */
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

/**
 * The query string after a change to the selection. Other parameters are kept. A date equal to its bound (or empty)
 * is dropped, so the default view keeps a short URL.
 */
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

/**
 * The range after one end is set to `v`. If the new end crosses the other one, the other end moves to the same day, so
 * either field can be moved anywhere in the record without editing the other field first.
 */
export function moveEnd(sel: { from: string; to: string }, end: "from" | "to", v: string): { from: string; to: string } {
  if (end === "from") return { from: v, to: v > sel.to ? v : sel.to };
  return { from: v < sel.from ? v : sel.from, to: v };
}

/** Burn calendar resolution, kept in the URL as ?view=week (FE-016); month is the default and keeps no parameter. */
export type CalendarView = "month" | "week";

/** Reads ?view=; anything but "week" is the month view. */
export const parseView = (params: URLSearchParams): CalendarView => (params.get("view") === "week" ? "week" : "month");

/** The query string with the view set; other parameters are kept and the default view drops the parameter. */
export function withView(params: URLSearchParams, view: CalendarView): URLSearchParams {
  const next = new URLSearchParams(params);
  if (view === "week") next.set("view", "week");
  else next.delete("view");
  return next;
}

/** Years with a point file that start before the selectable record (2000: partial year, MODIS Terra only). */
export function yearsBefore(bounds: Bounds, pointYears: number[]): number[] {
  const first = Number(bounds.min.slice(0, 4));
  return pointYears.filter((y) => y < first).sort((a, b) => a - b);
}

/** Days from `from` to `to`, both included. */
export function spanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

/** Calendar years the range touches, in order. */
export function yearsIn(from: string, to: string): number[] {
  const out: number[] = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) out.push(y);
  return out;
}

/** Whole calendar year `year`, clamped to the bounds. */
export function yearRange(year: number, bounds: Bounds): { from: string; to: string } {
  return { from: clamp(`${year}-01-01`, bounds), to: clamp(`${year}-12-31`, bounds) };
}

/**
 * Optional latitude/longitude box for the hotspot CSV (FE-020), kept in the URL as ?bbox=w,s,e,n, the same order and
 * edges (all inclusive) as /api/hotspots. It filters the CSV only; the chart, calendar and analytics stay whole-region.
 */
export type Box = { w: number; s: number; e: number; n: number };

/** Why a box can't be used, or null when it is valid. Same rules as `parseBbox` in lib/server-data.ts. */
export function boxError(b: Box): string | null {
  if (![b.w, b.s, b.e, b.n].every(Number.isFinite)) return "Enter all four edges as numbers.";
  if (b.s < -90 || b.n > 90) return "Latitude must be between -90 and 90.";
  if (b.w < -180 || b.e > 180) return "Longitude must be between -180 and 180.";
  if (!(b.s < b.n)) return "South must be less than north.";
  if (!(b.w < b.e)) return "West must be less than east.";
  return null;
}

/** Reads ?bbox=w,s,e,n; a missing or invalid value means no box. */
export function parseBox(params: URLSearchParams): Box | null {
  const v = params.get("bbox");
  if (v === null) return null;
  const nums = v.split(",").map((p) => (p.trim() === "" ? NaN : Number(p)));
  if (nums.length !== 4) return null;
  const b = { w: nums[0], s: nums[1], e: nums[2], n: nums[3] };
  return boxError(b) ? null : b;
}

/** The query string with the box set, or removed for `null`; other parameters are kept. */
export function withBox(params: URLSearchParams, box: Box | null): URLSearchParams {
  const next = new URLSearchParams(params);
  if (box && !boxError(box)) next.set("bbox", [box.w, box.s, box.e, box.n].join(","));
  else next.delete("bbox");
  return next;
}

/** True when the two boxes share any ground (touching edges count, since every edge is inclusive). */
export const boxesOverlap = (a: Box, b: Box) => a.w <= b.e && b.w <= a.e && a.s <= b.n && b.s <= a.n;

/** Region box from index.json ([west, south, east, north]) as a Box. */
export const regionBox = ([w, s, e, n]: [number, number, number, number]): Box => ({ w, s, e, n });

/** "38.5°N to 39°N, 9°W to 8°W": a box in words for the download copy. */
export function boxLabel(b: Box): string {
  const deg = (v: number, pos: string, neg: string) =>
    `${Number(Math.abs(v).toFixed(4))}°${v < 0 ? neg : v > 0 ? pos : ""}`;
  return `${deg(b.s, "N", "S")} to ${deg(b.n, "N", "S")}, ${deg(b.w, "E", "W")} to ${deg(b.e, "E", "W")}`;
}

/** Hotspot CSV for the selection (GET /api/hotspots, registry §4); valid only when the span is <= MAX_SPAN_DAYS. */
export const hotspotsUrl = (s: Selection, box: Box | null = null) =>
  `/api/hotspots?${new URLSearchParams({
    region: s.region,
    from: s.from,
    to: s.to,
    ...(box && !boxError(box) ? { bbox: [box.w, box.s, box.e, box.n].join(",") } : {}),
  })}`;

/** Monthly analytics CSV for the selection (GET /api/series, registry §4). */
export const seriesUrl = (s: Selection) =>
  `/api/series?${new URLSearchParams({ region: s.region, res: "monthly", from: s.from.slice(0, 7), to: s.to.slice(0, 7) })}`;

/** Static per-year hotspot file (registry §3 "Hotspot points"): the fallback when the route handler can't be used. */
export const pointFileUrl = (region: RegionId, year: number) => `/data/${region}/points/${year}.csv`;
