export const GIBS_WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi";
export const GIBS_CREDIT =
  "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS).";

export type Layer = { id: string; satellite: string; first: string; last: string | null };

export const LAYERS: Record<"terra" | "aqua" | "snpp" | "noaa20" | "noaa21", Layer> = {
  terra: { id: "MODIS_Terra_CorrectedReflectance_TrueColor", satellite: "MODIS Terra", first: "2000-02-24", last: null },
  aqua: { id: "MODIS_Aqua_CorrectedReflectance_TrueColor", satellite: "MODIS Aqua", first: "2002-07-03", last: null },
  snpp: { id: "VIIRS_SNPP_CorrectedReflectance_TrueColor", satellite: "VIIRS Suomi NPP", first: "2015-11-24", last: "2026-11-02" },
  noaa20: { id: "VIIRS_NOAA20_CorrectedReflectance_TrueColor", satellite: "VIIRS NOAA-20", first: "2018-01-05", last: null },
  noaa21: { id: "VIIRS_NOAA21_CorrectedReflectance_TrueColor", satellite: "VIIRS NOAA-21", first: "2023-02-10", last: null },
};

const covers = (l: Layer, day: string) => day >= l.first && (l.last == null || day <= l.last);

export function layersFor(day: string): Layer[] {
  const { terra, aqua, snpp, noaa20, noaa21 } = LAYERS;
  const order =
    day < aqua.first ? [terra]
    : day < snpp.first ? [aqua, terra, noaa20]
    : snpp.last && day <= snpp.last ? [snpp, aqua, noaa20, terra]
    : [noaa20, noaa21, aqua, terra];
  return order.filter((l) => covers(l, day));
}

export type Bbox = [number, number, number, number];

export function imageSize(bbox: Bbox, width = 1000): { width: number; height: number } {
  const [w, s, e, n] = bbox;
  return { width, height: Math.round((width * (n - s)) / (e - w)) };
}

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

export function toPixel(lat: number, lon: number, bbox: Bbox, size: { width: number; height: number }): [number, number] | null {
  const [w, s, e, n] = bbox;
  if (lon < w || lon > e || lat < s || lat > n) return null;
  return [((lon - w) / (e - w)) * size.width, ((n - lat) / (n - s)) * size.height];
}

export function classifyPixels(rgba: ArrayLike<number>): "blank" | "cloudy" | "ok" {
  let n = 0, dark = 0, white = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    n++;
    if (r < 8 && g < 8 && b < 8) dark++;
    else if (r > 200 && g > 200 && b > 200 && Math.max(r, g, b) - Math.min(r, g, b) < 30) white++;
  }
  if (n === 0 || dark / n > 0.98) return "blank";
  return white / n > 0.6 ? "cloudy" : "ok";
}

export type Peaks = {
  region: string;
  sensors: string[];
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

export type PeakDay = { date: string; count: number; sensor: string };

const pad2 = (v: number) => String(v).padStart(2, "0");

export function topDays(peaks: Peaks, year: number, month: number): PeakDay[] {
  const key = `${year}-${pad2(month)}`;
  const m = peaks.months.find((x) => x.month === key);
  return (m?.top3 ?? []).map(([day, count, s]) => ({ date: `${key}-${pad2(day)}`, count, sensor: peaks.sensors[s] }));
}

export function countedSensor(peaks: Peaks, day: string): "modis" | "snpp" | "noaa20" {
  return day < peaks.snpp_from ? "modis" : day <= peaks.snpp_through ? "snpp" : "noaa20";
}

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

export function resolveDay(
  chosen: { open: string; region: string; day: string } | null,
  open: string,
  region: string,
  top: PeakDay[],
  minDay: string,
  maxDay: string,
): string {
  const pick = chosen && chosen.open === open && chosen.region === region ? chosen.day : (top[0]?.date ?? `${open}-01`);
  return pick < minDay ? minDay : pick > maxDay ? maxDay : pick;
}

export function shiftDay(day: string, by: number): string {
  const t = new Date(`${day}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + by);
  return t.toISOString().slice(0, 10);
}
