import { geoArea } from "d3-geo";

export type Ship = "model" | "caveat" | "ratio" | "sparse";
export type View = "year" | "trend";

export interface GlobeTrend {
  slope_pct: number;
  lo_pct: number;
  hi_pct: number;
  p: number;
}

export interface GlobeRegion {
  id: string;
  name: string;
  tier: "region" | "country";
  iso_a3: string | null;
  bbox: [number, number, number, number] | null;
  ship: Ship | null;
  caveat: string | null;
  harmonized: (number | null)[];
  lo: (number | null)[];
  hi: (number | null)[];
  trend: GlobeTrend | null;
}

export interface GlobeData {
  schema: 1;
  years: number[];
  regions: GlobeRegion[];
}

export class GlobeFormatError extends Error {}

const SHIPS: readonly Ship[] = ["model", "caveat", "ratio", "sparse"];
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOrNull = (v: unknown): number | null => (isNum(v) ? v : null);

export function parseGlobe(raw: unknown): GlobeData {
  const d = raw as Partial<GlobeData> | null;
  if (!d || typeof d !== "object" || d.schema !== 1) throw new GlobeFormatError("globe.json: schema must be 1");
  if (!Array.isArray(d.years) || d.years.length === 0 || !d.years.every(isNum))
    throw new GlobeFormatError("globe.json: years must be a non-empty number array");
  if (!Array.isArray(d.regions)) throw new GlobeFormatError("globe.json: regions must be an array");
  const n = d.years.length;
  const series = (a: unknown) =>
    Array.from({ length: n }, (_, i) => (Array.isArray(a) ? numOrNull(a[i]) : null));
  const regions = d.regions.map((r, k): GlobeRegion => {
    if (!r || typeof r.id !== "string" || typeof r.name !== "string")
      throw new GlobeFormatError(`globe.json: region ${k} needs id and name`);
    const t = r.trend as Partial<GlobeTrend> | null | undefined;
    const bbox = Array.isArray(r.bbox) && r.bbox.length === 4 && r.bbox.every(isNum) ? r.bbox : null;
    return {
      id: r.id,
      name: r.name,
      tier: r.tier === "country" ? "country" : "region",
      iso_a3: typeof r.iso_a3 === "string" ? r.iso_a3 : null,
      bbox: bbox as GlobeRegion["bbox"],
      ship: SHIPS.includes(r.ship as Ship) ? (r.ship as Ship) : null,
      caveat: typeof r.caveat === "string" && r.caveat ? r.caveat : null,
      harmonized: series(r.harmonized),
      lo: series(r.lo),
      hi: series(r.hi),
      trend:
        t && isNum(t.slope_pct) && isNum(t.p)
          ? { slope_pct: t.slope_pct, lo_pct: numOrNull(t.lo_pct) ?? t.slope_pct, hi_pct: numOrNull(t.hi_pct) ?? t.slope_pct, p: t.p }
          : null,
    };
  });
  return { schema: 1, years: [...d.years], regions };
}

export interface AnnualLike {
  years: number[];
  harmonized: number[];
  lo: number[];
  hi: number[];
  partial: number[];
  trend?: { harmonized?: Partial<GlobeTrend> } | null;
}

export const VIIRS_FROM = 2012;

export function fromAnnual(
  info: { id: string; name: string; tier: string; bbox?: number[] | null; iso_a3?: string | null; ship?: string | null; caveat?: string | null },
  a: AnnualLike,
  years: number[],
): GlobeRegion {
  const at = (y: number) => {
    const i = a.years.indexOf(y);
    return i >= 0 && !a.partial[i] ? i : -1;
  };
  const pick = (arr: number[], y: number, band = false) => {
    const i = at(y);
    if (i < 0 || (band && y >= VIIRS_FROM)) return null;
    return numOrNull(arr[i]);
  };
  const t = a.trend?.harmonized;
  return parseGlobe({
    schema: 1,
    years,
    regions: [
      {
        id: info.id,
        name: info.name,
        tier: info.tier,
        iso_a3: info.iso_a3 ?? null,
        bbox: info.bbox ?? null,
        ship: info.ship ?? null,
        caveat: info.caveat ?? null,
        harmonized: years.map((y) => pick(a.harmonized, y)),
        lo: years.map((y) => pick(a.lo, y, true)),
        hi: years.map((y) => pick(a.hi, y, true)),
        trend: t ?? null,
      },
    ],
  }).regions[0];
}

export function completeYears(records: AnnualLike[]): number[] {
  let first = Infinity;
  let last = -Infinity;
  for (const a of records)
    a.years.forEach((y, i) => {
      if (a.partial[i]) return;
      first = Math.min(first, y);
      last = Math.max(last, y);
    });
  if (!Number.isFinite(first)) return [];
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

export interface OutlineProps {
  ISO_A3: string;
  ADM0_A3: string;
  NAME: string;
}

export function joinCode(p: Pick<OutlineProps, "ISO_A3" | "ADM0_A3">): string {
  return p.ISO_A3 && p.ISO_A3 !== "-99" ? p.ISO_A3 : p.ADM0_A3;
}

export const CODE_ALIASES: Readonly<Record<string, string>> = { XKX: "KOS" };

export const canonicalCode = (iso: string) => CODE_ALIASES[iso] ?? iso;

export function joinRegions<R extends Pick<GlobeRegion, "id" | "tier" | "iso_a3">>(
  outlines: { properties: Pick<OutlineProps, "ISO_A3" | "ADM0_A3"> }[],
  regions: R[],
): { matched: Map<string, R>; unmatched: R[] } {
  const codes = new Set(outlines.map((f) => joinCode(f.properties)));
  const matched = new Map<string, R>();
  const unmatched: R[] = [];
  for (const r of regions) {
    if (r.tier !== "country") continue;
    const code = r.iso_a3 ? canonicalCode(r.iso_a3) : null;
    if (code && codes.has(code) && !matched.has(code)) matched.set(code, r);
    else unmatched.push(r);
  }
  return { matched, unmatched };
}

export const EARTH_RADIUS_KM = 6371.0088;

export function areaKm2(geometry: { type: string; coordinates: unknown }): number {
  let sr = geoArea({ type: "Feature", properties: {}, geometry } as Parameters<typeof geoArea>[0]);
  if (sr > 2 * Math.PI) sr = 4 * Math.PI - sr;
  return sr * EARTH_RADIUS_KM ** 2;
}

export function bboxKm2([w, s, e, n]: readonly number[]): number {
  const rad = Math.PI / 180;
  return EARTH_RADIUS_KM ** 2 * (e - w) * rad * (Math.sin(n * rad) - Math.sin(s * rad));
}

export function per1000(total: number | null, km2: number | null): number | null {
  if (total === null || km2 === null || !(km2 > 0)) return null;
  return (total / km2) * 1000;
}

export function bboxPolygon([w, s, e, n]: readonly number[], step = 0.25) {
  const along = (a: number, b: number) => {
    const k = Math.max(1, Math.ceil(Math.abs(b - a) / step));
    return Array.from({ length: k }, (_, i) => a + ((b - a) * i) / k);
  };
  const ring: [number, number][] = [
    ...along(w, e).map((x): [number, number] => [x, s]),
    ...along(s, n).map((y): [number, number] => [e, y]),
    ...along(e, w).map((x): [number, number] => [x, n]),
    ...along(n, s).map((y): [number, number] => [w, y]),
  ];
  ring.push(ring[0]);
  return { type: "Polygon" as const, coordinates: [ring.reverse()] };
}

export function logBins(values: Iterable<number | null>): number[] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v === null || !(v > 0) || !Number.isFinite(v)) continue;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  if (!Number.isFinite(lo)) return [1, 10];
  const steps = (k: number) => [10 ** k, 3 * 10 ** k];
  const edges: number[] = [];
  for (let k = Math.floor(Math.log10(lo)) - 1; k <= Math.ceil(Math.log10(hi)) + 1; k++) edges.push(...steps(k));
  const a = edges.findLastIndex((x) => x <= lo);
  const b = edges.findIndex((x) => x >= hi);
  const out = edges.slice(Math.max(0, a), (b < 0 ? edges.length - 1 : Math.max(b, a + 1)) + 1);
  return out.map((x) => Number(x.toPrecision(6)));
}

export function binOf(v: number | null, edges: readonly number[]): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  const last = edges.length - 2;
  for (let i = 0; i <= last; i++) if (v < edges[i + 1]) return i;
  return last;
}

export const HEAT_STOPS = ["#4a1611", "#7d1c13", "#b8241a", "#ec3a24", "#ff6a35", "#ff9d52", "#ffcf86", "#fff1d6"];
export const NO_DATA = "#2f2624";
export const NEUTRAL = "#6b5a56";
export const TREND_STOPS = ["#2f7fc1", "#62a3d6", "#a6cbe8", "#f5b39a", "#f0703f", "#d4291c"];
export const TREND_EDGES = [-4, -1.5, 0, 1.5, 4];
export const SIG_P = 0.05;

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (c: number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

export function ramp(n: number, stops: readonly string[] = HEAT_STOPS): string[] {
  if (n <= 1) return [stops[stops.length - 1]];
  return Array.from({ length: n }, (_, i) => {
    const t = (i / (n - 1)) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(t));
    const f = t - k;
    const [a, b] = [hex(stops[k]), hex(stops[k + 1])];
    return toHex(a.map((v, j) => v + (b[j] - v) * f));
  });
}

export function heatColor(v: number | null, edges: readonly number[], colors: readonly string[]): string {
  const b = binOf(v, edges);
  return b === null ? NO_DATA : colors[b];
}

export function trendBin(t: GlobeTrend | null): number | null {
  if (!t) return null;
  const i = TREND_EDGES.findIndex((e) => t.slope_pct < e);
  return i < 0 ? TREND_EDGES.length : i;
}

export function trendColor(t: GlobeTrend | null): string {
  const b = trendBin(t);
  if (b === null || !t) return NO_DATA;
  return t.p < SIG_P ? TREND_STOPS[b] : NEUTRAL;
}

export const isLight = (ship: Ship | null) => ship === "ratio" || ship === "sparse";

export function withAlpha(color: string, a: number): string {
  const [r, g, b] = hex(color);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export function labelText(r: Pick<GlobeRegion, "tier" | "ship">): string {
  if (r.tier !== "country") return "deep dive";
  switch (r.ship) {
    case "model":
      return "model";
    case "caveat":
      return "model, with a caveat";
    case "ratio":
      return "constant-ratio estimate";
    case "sparse":
      return "sparse";
    default:
      return "constant-ratio estimate";
  }
}

export function fmt(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "–";
  if (Math.abs(v) >= 100) return Math.round(v).toLocaleString("en-US");
  if (v === 0) return "0";
  return Number(v.toPrecision(2)).toLocaleString("en-US", { maximumSignificantDigits: 2 });
}

export function slopeText(t: GlobeTrend | null): string {
  if (!t) return "–";
  const s = t.slope_pct;
  return `${s > 0 ? "+" : s < 0 ? "-" : ""}${Math.abs(s).toFixed(1)}% a year`;
}

export function trendWords(t: GlobeTrend | null): string {
  if (!t) return "no trend yet";
  const dir = t.slope_pct > 0 ? "rising" : t.slope_pct < 0 ? "falling" : "flat";
  const sig = t.p < SIG_P ? "significant" : "could be chance";
  return `${dir} ${Math.abs(t.slope_pct).toFixed(1)}% a year (${sig}, p ${t.p < 0.001 ? "< 0.001" : `= ${t.p.toFixed(3)}`})`;
}

export interface PlaceRow extends GlobeRegion {
  km2: number | null;
  onGlobe: boolean;
}

export interface YearRow {
  id: string;
  name: string;
  label: string;
  light: boolean;
  caveat: string | null;
  onGlobe: boolean;
  total: number | null;
  lo: number | null;
  hi: number | null;
  density: number | null;
  trend: GlobeTrend | null;
}

export function yearRows(places: readonly PlaceRow[], yi: number): YearRow[] {
  return places.map((p) => ({
    id: p.id,
    name: p.name,
    label: labelText(p),
    light: p.tier === "country" && isLight(p.ship),
    caveat: p.caveat,
    onGlobe: p.onGlobe,
    total: p.harmonized[yi] ?? null,
    lo: p.lo[yi] ?? null,
    hi: p.hi[yi] ?? null,
    density: per1000(p.harmonized[yi] ?? null, p.km2),
    trend: p.trend,
  }));
}

export type SortKey = "name" | "total" | "density" | "trend" | "label";
export type SortDir = "asc" | "desc";

export function sortYearRows(rows: readonly YearRow[], key: SortKey, dir: SortDir): YearRow[] {
  const val = (r: YearRow): string | number | null =>
    key === "name" ? r.name : key === "label" ? r.label : key === "trend" ? (r.trend?.slope_pct ?? null) : r[key];
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const [x, y] = [val(a), val(b)];
    if (x === null && y === null) return a.name.localeCompare(b.name);
    if (x === null) return 1;
    if (y === null) return -1;
    const c = typeof x === "string" ? x.localeCompare(y as string) : x - (y as number);
    return c !== 0 ? sign * c : a.name.localeCompare(b.name);
  });
}

export interface GlobeState {
  year: number;
  view: View;
}

export function parseGlobeState(params: URLSearchParams, years: readonly number[]): GlobeState {
  const last = years[years.length - 1];
  const y = Number(params.get("year"));
  return {
    year: Number.isInteger(y) && years.includes(y) ? y : last,
    view: params.get("view") === "trend" ? "trend" : "year",
  };
}

export function globeQuery(s: GlobeState, years: readonly number[], base = ""): string {
  const q = new URLSearchParams(base);
  q.delete("year");
  q.delete("view");
  if (s.year !== years[years.length - 1]) q.set("year", String(s.year));
  if (s.view === "trend") q.set("view", "trend");
  return q.toString();
}
