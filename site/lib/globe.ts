// FE-026: pure helpers for the /globe page (no React, no DOM), so `node --test`, the server page and the client globe
// share one copy. Data in: `globe.json` (registry row "Globe data", written by ML-023's globe.py) or, until it lands,
// the same shape built from each region's annual.json (`fromAnnual`). Outlines: Natural Earth 1:110m Admin 0
// (public domain), cut down by scripts/globe/outlines.py to ISO_A3 / ADM0_A3 / NAME.
import { geoArea } from "d3-geo";

/** ML-023's country labels (registry row "Country-tier outputs"); null = one of our deep-dive boxes. */
export type Ship = "model" | "caveat" | "ratio" | "sparse";
export type View = "year" | "trend";

export interface GlobeTrend {
  slope_pct: number;
  lo_pct: number;
  hi_pct: number;
  p: number;
}

/** One region of globe.json (fields the page uses; extra fields are ignored). */
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

/** Checks globe.json's shape (registry row "Globe data"); every series is cut or padded to `years`. */
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

/** The annual.json fields `fromAnnual` reads (lib/annual.ts `Annual` satisfies it). */
export interface AnnualLike {
  years: number[];
  harmonized: number[];
  lo: number[];
  hi: number[];
  partial: number[];
  trend?: { harmonized?: Partial<GlobeTrend> } | null;
}

/** The first year MODIS and VIIRS overlap; the band is published only for the back-cast years before it. */
export const VIIRS_FROM = 2012;

/**
 * Until globe.json lands: one region in globe.json's shape from its index.json row and annual.json. Complete years only
 * (a still-running year is left out, as globe.py does), lo/hi only on back-cast years, trend = the ML-020 harmonized
 * block. Only real published numbers; nothing is made up for countries that have no record yet.
 */
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

/** Complete years shared by the records: first year to the last year that is complete everywhere it exists. */
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

// ---------------------------------------------------------------- outlines and the join

export interface OutlineProps {
  ISO_A3: string;
  ADM0_A3: string;
  NAME: string;
}

/** Natural Earth's code for a country: ISO_A3, or ADM0_A3 where ISO_A3 is "-99" (France, Norway, Kosovo, ...). */
export function joinCode(p: Pick<OutlineProps, "ISO_A3" | "ADM0_A3">): string {
  return p.ISO_A3 && p.ISO_A3 !== "-99" ? p.ISO_A3 : p.ADM0_A3;
}

/**
 * Codes our country list uses that Natural Earth spells differently. XKX is Kosovo's user-assigned code (FIRMS /
 * countries.json); Natural Earth has ADM0_A3 "KOS".
 */
export const CODE_ALIASES: Readonly<Record<string, string>> = { XKX: "KOS" };

export const canonicalCode = (iso: string) => CODE_ALIASES[iso] ?? iso;

/**
 * Which outline each country region joins to. `matched` maps the Natural Earth code to the region; `unmatched` lists
 * the country regions with no 1:110m outline (small islands such as Singapore or Cape Verde are not drawn at this
 * scale; French Guiana is split out of France by scripts/globe/outlines.py). Deep dives are boxes, never joined.
 */
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

// ---------------------------------------------------------------- areas

/** Mean Earth radius in km (IUGG), the R in area = steradians × R². */
export const EARTH_RADIUS_KM = 6371.0088;

/** A polygon's area in km² from d3-geo's spherical `geoArea` (steradians × R²). */
export function areaKm2(geometry: { type: string; coordinates: unknown }): number {
  let sr = geoArea({ type: "Feature", properties: {}, geometry } as Parameters<typeof geoArea>[0]);
  // d3-geo reads ring winding as the inside; a ring wound the other way gives the rest of the sphere
  if (sr > 2 * Math.PI) sr = 4 * Math.PI - sr;
  return sr * EARTH_RADIUS_KM ** 2;
}

/** Exact area in km² of a lon/lat box [west, south, east, north] on the sphere. */
export function bboxKm2([w, s, e, n]: readonly number[]): number {
  const rad = Math.PI / 180;
  return EARTH_RADIUS_KM ** 2 * (e - w) * rad * (Math.sin(n * rad) - Math.sin(s * rad));
}

/** Detections per 1,000 km²; null when either side is missing. */
export function per1000(total: number | null, km2: number | null): number | null {
  if (total === null || km2 === null || !(km2 > 0)) return null;
  return (total / km2) * 1000;
}

/** A box as a closed GeoJSON polygon, with points every `step`° so its edges follow the parallels on a globe. */
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
  // clockwise in lon/lat (south edge west to east first, then up the east side) = the inside for d3-geo
  return { type: "Polygon" as const, coordinates: [ring.reverse()] };
}

// ---------------------------------------------------------------- colour

/**
 * Log-spaced bin edges for per-1,000 km² values, fixed across every year so moving the slider compares like with like:
 * 1-3-10 steps from below the smallest positive value to above the largest. Always at least 2 edges.
 */
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

/** Which bin a value falls in (0 .. edges.length - 2), values outside clamp to the end bins; null for no value. */
export function binOf(v: number | null, edges: readonly number[]): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  const last = edges.length - 2;
  for (let i = 0; i <= last; i++) if (v < edges[i + 1]) return i;
  return last;
}

/** Thermal ramp on the near-black page: dim ember to white heat. Monotonic in lightness. */
export const HEAT_STOPS = ["#4a1611", "#7d1c13", "#b8241a", "#ec3a24", "#ff6a35", "#ff9d52", "#ffcf86", "#fff1d6"];
/** Countries with no record yet, the ocean-side globe, neutral (not significant) trends. */
export const NO_DATA = "#2f2624";
export const NEUTRAL = "#6b5a56";
/** Diverging trend colours: falling (cool) ... rising (hot). Index 0 = steepest fall. */
export const TREND_STOPS = ["#2f7fc1", "#62a3d6", "#a6cbe8", "#f5b39a", "#f0703f", "#d4291c"];
/** Trend bin edges in % a year between the 6 colours (≤ -4, -4..-1.5, -1.5..0, 0..1.5, 1.5..4, ≥ 4). */
export const TREND_EDGES = [-4, -1.5, 0, 1.5, 4];
/** "Significant" = Mann-Kendall p below this (the ledger trend's bar, FE-014). */
export const SIG_P = 0.05;

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (c: number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/** n colours spread evenly along `stops` (linear in sRGB between neighbours). */
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

/** Colour of one region-year on the Year view. */
export function heatColor(v: number | null, edges: readonly number[], colors: readonly string[]): string {
  const b = binOf(v, edges);
  return b === null ? NO_DATA : colors[b];
}

/** Trend bin 0..5, or null when there is no trend. */
export function trendBin(t: GlobeTrend | null): number | null {
  if (!t) return null;
  const i = TREND_EDGES.findIndex((e) => t.slope_pct < e);
  return i < 0 ? TREND_EDGES.length : i;
}

/** Colour on the Trend view: neutral when Mann-Kendall says it could be chance (p ≥ 0.05). */
export function trendColor(t: GlobeTrend | null): string {
  const b = trendBin(t);
  if (b === null || !t) return NO_DATA;
  return t.p < SIG_P ? TREND_STOPS[b] : NEUTRAL;
}

/** Lighter, see-through cap for a constant-ratio estimate or a sparse record (the spec's "hatched or lighter"). */
export const isLight = (ship: Ship | null) => ship === "ratio" || ship === "sparse";

/** `#rrggbb` → `rgba(r, g, b, a)`. */
export function withAlpha(color: string, a: number): string {
  const [r, g, b] = hex(color);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// ---------------------------------------------------------------- words

/** The label as the page writes it out. */
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

/** 12,345 / 1.2 / 0.034: three significant figures below 100, whole numbers above. */
export function fmt(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "–";
  if (Math.abs(v) >= 100) return Math.round(v).toLocaleString("en-US");
  if (v === 0) return "0";
  return Number(v.toPrecision(2)).toLocaleString("en-US", { maximumSignificantDigits: 2 });
}

/** "+2.1% a year" / "-0.4% a year". */
export function slopeText(t: GlobeTrend | null): string {
  if (!t) return "–";
  const s = t.slope_pct;
  return `${s > 0 ? "+" : s < 0 ? "-" : ""}${Math.abs(s).toFixed(1)}% a year`;
}

/** "rising 2.1% a year (significant)" for the readout. */
export function trendWords(t: GlobeTrend | null): string {
  if (!t) return "no trend yet";
  const dir = t.slope_pct > 0 ? "rising" : t.slope_pct < 0 ? "falling" : "flat";
  const sig = t.p < SIG_P ? "significant" : "could be chance";
  return `${dir} ${Math.abs(t.slope_pct).toFixed(1)}% a year (${sig}, p ${t.p < 0.001 ? "< 0.001" : `= ${t.p.toFixed(3)}`})`;
}

// ---------------------------------------------------------------- rows

/** A region plus what the page needs to draw and list it: its area and whether it has a shape on the globe. */
export interface PlaceRow extends GlobeRegion {
  km2: number | null;
  onGlobe: boolean;
}

/** One table row for the chosen year. */
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

/** Sorted copy; missing values last in both directions, ties by name. */
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

// ---------------------------------------------------------------- URL state

export interface GlobeState {
  year: number;
  view: View;
}

/** `?year=2023&view=trend`; a missing or out-of-range year falls back to the last year, any other view to "year". */
export function parseGlobeState(params: URLSearchParams, years: readonly number[]): GlobeState {
  const last = years[years.length - 1];
  const y = Number(params.get("year"));
  return {
    year: Number.isInteger(y) && years.includes(y) ? y : last,
    view: params.get("view") === "trend" ? "trend" : "year",
  };
}

/**
 * The query string for a state, defaults left out ("" for the last year on the Year view). Other keys in `base` (the
 * nav's ?region=&from=&to=) are kept, so a visit to the globe and back keeps the selection.
 */
export function globeQuery(s: GlobeState, years: readonly number[], base = ""): string {
  const q = new URLSearchParams(base);
  q.delete("year");
  q.delete("view");
  if (s.year !== years[years.length - 1]) q.set("year", String(s.year));
  if (s.view === "trend") q.set("view", "trend");
  return q.toString();
}
