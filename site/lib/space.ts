// "See it from space" (FE-024): pure helpers for the NASA true-colour image of a region on one day, with no imports so
// `node --test` can run them. Facts from FE-023 (features/frontend/README.md "NASA imagery", tested with curl):
// GIBS WMS GetMap needs no key and sends `access-control-allow-origin: *`; WMS 1.3.0 with EPSG:4326 takes
// BBOX=minLat,minLon,maxLat,maxLon; a day the layer doesn't have comes back as HTTP 200 with an all-black JPEG.

export const GIBS_WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi";
export const GIBS_CREDIT =
  "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS).";

/** A GIBS true-colour layer and the dates it has images for (first/last day, inclusive; last null = still updated). */
export type Layer = { id: string; satellite: string; first: string; last: string | null };

export const LAYERS: Record<"terra" | "aqua" | "snpp" | "noaa20" | "noaa21", Layer> = {
  terra: { id: "MODIS_Terra_CorrectedReflectance_TrueColor", satellite: "MODIS Terra", first: "2000-02-24", last: null },
  aqua: { id: "MODIS_Aqua_CorrectedReflectance_TrueColor", satellite: "MODIS Aqua", first: "2002-07-03", last: null },
  snpp: { id: "VIIRS_SNPP_CorrectedReflectance_TrueColor", satellite: "VIIRS Suomi NPP", first: "2015-11-24", last: "2026-11-02" },
  noaa20: { id: "VIIRS_NOAA20_CorrectedReflectance_TrueColor", satellite: "VIIRS NOAA-20", first: "2018-01-05", last: null },
  noaa21: { id: "VIIRS_NOAA21_CorrectedReflectance_TrueColor", satellite: "VIIRS NOAA-21", first: "2023-02-10", last: null },
};

const covers = (l: Layer, day: string) => day >= l.first && (l.last == null || day <= l.last);

/**
 * Imagery layers to try for a day, best first (FE-023's rule): Terra before Aqua flew; Aqua (afternoon pass, closest to
 * VIIRS) until S-NPP true colour starts on 2015-11-24; S-NPP to its end on 2026-11-02; NOAA-20 after. Each is followed
 * by fallbacks for gap days. Only layers that cover the day are returned. This is the imagery satellite, not the sensor
 * peaks.json counted.
 */
export function layersFor(day: string): Layer[] {
  const { terra, aqua, snpp, noaa20, noaa21 } = LAYERS;
  const order =
    day < aqua.first ? [terra]
    : day < snpp.first ? [aqua, terra, noaa20]
    : snpp.last && day <= snpp.last ? [snpp, aqua, noaa20, terra]
    : [noaa20, noaa21, aqua, terra];
  return order.filter((l) => covers(l, day));
}

/** [west, south, east, north] in degrees. */
export type Bbox = [number, number, number, number];

/** Pixel size for a box: `width` wide, height from the lon:lat span (plate carrée, as EPSG:4326 WMS returns it). */
export function imageSize(bbox: Bbox, width = 1000): { width: number; height: number } {
  const [w, s, e, n] = bbox;
  return { width, height: Math.round((width * (n - s)) / (e - w)) };
}

/** GIBS WMS 1.3.0 GetMap URL for one layer, box and day. EPSG:4326 in 1.3.0 is lat,lon order. */
export function gibsUrl(layer: Layer, bbox: Bbox, day: string, width = 1000): string {
  const [w, s, e, n] = bbox;
  const { height } = imageSize(bbox, width);
  const q = new URLSearchParams({
    SERVICE: "WMS",
    REQUEST: "GetMap",
    VERSION: "1.3.0",
    LAYERS: layer.id,
    CRS: "EPSG:4326",
    BBOX: [s, w, n, e].join(","),
    WIDTH: String(width),
    HEIGHT: String(height),
    FORMAT: "image/jpeg",
    TIME: day,
  });
  return `${GIBS_WMS}?${q}`;
}

/** Lat/lon to pixel position in an image of the box (plain linear mapping; null when outside the box). */
export function toPixel(lat: number, lon: number, bbox: Bbox, size: { width: number; height: number }): [number, number] | null {
  const [w, s, e, n] = bbox;
  if (lon < w || lon > e || lat < s || lat > n) return null;
  return [((lon - w) / (e - w)) * size.width, ((n - lat) / (n - s)) * size.height];
}

/**
 * What an image shows, from its RGBA pixels (sampled): "blank" = all near-black (GIBS's answer for a missing day),
 * "cloudy" = most pixels bright and grey (cloud or thick smoke), else "ok". Thresholds are rough on purpose.
 */
export function classifyPixels(rgba: ArrayLike<number>): "blank" | "cloudy" | "ok" {
  let n = 0, dark = 0, white = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    n++;
    if (r < 8 && g < 8 && b < 8) dark++;
    else if (r > 200 && g > 200 && b > 200 && Math.max(r, g, b) - Math.min(r, g, b) < 30) white++;
  }
  if (n === 0 || dark / n > 0.98) return "blank"; // partly black (a swath gap) still shows the rest of the region
  return white / n > 0.6 ? "cloudy" : "ok";
}

/** peaks.json (DP-016, registry §3 "Peak fire days"), the fields this view reads. */
export type Peaks = {
  region: string;
  sensors: string[]; // ["modis", "snpp", "noaa20"]
  snpp_from: string;
  snpp_through: string;
  noaa20_through: string | null;
  last_day: string;
  months: { month: string; peak: [number, number, number] | null; top3: [number, number, number][] }[];
};

export class PeaksFormatError extends Error {}

export function parsePeaks(raw: unknown): Peaks {
  const p = raw as Partial<Peaks> | null;
  if (!p || typeof p !== "object" || !Array.isArray(p.months) || !Array.isArray(p.sensors))
    throw new PeaksFormatError("not a peaks.json file");
  for (const k of ["snpp_from", "snpp_through", "last_day"] as const)
    if (typeof p[k] !== "string") throw new PeaksFormatError(`missing ${k}`);
  return p as Peaks;
}

/** A day with its count and the sensor peaks.json counted for it. */
export type PeakDay = { date: string; count: number; sensor: string };

const pad2 = (v: number) => String(v).padStart(2, "0");

/** The month's top days ("YYYY-MM"), peak first; empty when the month had no detections or isn't in the file. */
export function topDays(peaks: Peaks, year: number, month: number): PeakDay[] {
  const key = `${year}-${pad2(month)}`;
  const m = peaks.months.find((x) => x.month === key);
  return (m?.top3 ?? []).map(([day, count, s]) => ({ date: `${key}-${pad2(day)}`, count, sensor: peaks.sensors[s] }));
}

/** Sensor counted on a day, by peaks.json's own boundaries (MODIS before snpp_from, S-NPP to snpp_through, NOAA-20 after). */
export function countedSensor(peaks: Peaks, day: string): "modis" | "snpp" | "noaa20" {
  return day < peaks.snpp_from ? "modis" : day <= peaks.snpp_through ? "snpp" : "noaa20";
}

/** FIRMS `satellite` values in the point files that belong to a counted sensor, so the dots match the day's count. */
export const SENSOR_SATELLITES: Record<"modis" | "snpp" | "noaa20", string[]> = {
  modis: ["Terra", "Aqua"],
  snpp: ["SNPP"],
  noaa20: ["NOAA20"],
};

export const SENSOR_NAME: Record<"modis" | "snpp" | "noaa20", string> = {
  modis: "MODIS (Terra and Aqua)",
  snpp: "VIIRS Suomi NPP",
  noaa20: "VIIRS NOAA-20",
};

/** Points of one day from a hotspot CSV (registry "Hotspot points" columns), only the counted sensor's satellites. */
export function dayPoints(csv: string, day: string, sensor: "modis" | "snpp" | "noaa20"): { lat: number; lon: number }[] {
  const lines = csv.split(/\r?\n/);
  const head = (lines[0] ?? "").split(",");
  const iDate = head.indexOf("date"), iLat = head.indexOf("lat"), iLon = head.indexOf("lon"), iSat = head.indexOf("satellite");
  if (iDate < 0 || iLat < 0 || iLon < 0 || iSat < 0) return [];
  const sats = new Set(SENSOR_SATELLITES[sensor]);
  const out: { lat: number; lon: number }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    if (c[iDate] !== day || !sats.has(c[iSat])) continue;
    const lat = Number(c[iLat]), lon = Number(c[iLon]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) out.push({ lat, lon });
  }
  return out;
}

/**
 * The day the view shows for an opened month: the user's pick when it belongs to this opened month and region (it may
 * lie in another month after previous/next), else the month's peak day, else the first day of the month; always
 * clamped to [minDay, maxDay] so no future or pre-record day is requested.
 */
export function resolveDay(
  chosen: { open: string; region: string; day: string } | null,
  open: string, // "YYYY-MM" of the opened month
  region: string,
  top: PeakDay[],
  minDay: string,
  maxDay: string,
): string {
  const pick = chosen && chosen.open === open && chosen.region === region ? chosen.day : (top[0]?.date ?? `${open}-01`);
  return pick < minDay ? minDay : pick > maxDay ? maxDay : pick;
}

/** Next/previous calendar day as "YYYY-MM-DD" (UTC). */
export function shiftDay(day: string, by: number): string {
  const t = new Date(`${day}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + by);
  return t.toISOString().slice(0, 10);
}
