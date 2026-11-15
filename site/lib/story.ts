// Data moments for the landing story (FE-018, route `/`): pure functions with relative imports only, so `node --test`
// can run them. `lib/story-data.ts` feeds them the published files at build time; nothing here reads files.

import { completeEnd, VIIRS_FROM, type Annual } from "./annual.ts";

/** One FIRMS detection from a points/<year>.csv file (registry §3 "Point files"). */
export type Detection = {
  date: string; // YYYY-MM-DD (UTC)
  time: string; // HHMM (UTC)
  lat: number;
  lon: number;
  satellite: string; // Terra | Aqua | SNPP
  daynight: string; // D | N
};

/** Parses a points CSV (header `date,time_utc,lat,lon,satellite,confidence,frp_mw,daynight`). */
export function parsePoints(csv: string): Detection[] {
  const lines = csv.split(/\r?\n/);
  const head = lines[0].split(",");
  const col = (name: string) => {
    const i = head.indexOf(name);
    if (i < 0) throw new Error(`points file has no ${name} column`);
    return i;
  };
  const [d, t, la, lo, s, dn] = ["date", "time_utc", "lat", "lon", "satellite", "daynight"].map(col);
  const out: Detection[] = [];
  for (let k = 1; k < lines.length; k++) {
    if (!lines[k]) continue;
    const f = lines[k].split(",");
    out.push({ date: f[d], time: f[t].padStart(4, "0"), lat: Number(f[la]), lon: Number(f[lo]), satellite: f[s], daynight: f[dn] });
  }
  return out;
}

export const isModis = (satellite: string) => satellite === "Terra" || satellite === "Aqua";

/** Nominal pixel edge at nadir, metres: MODIS 1 km, VIIRS I-band 375 m. */
export const PIXEL_M = { modis: 1000, viirs: 375 } as const;

export type Pass = { satellite: string; date: string; time: string; points: [number, number][] }; // points = [lat, lon]

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2));

/**
 * Groups detections into overpasses: same satellite, same day, times at most `gap` minutes apart (one overpass can
 * straddle two granules, e.g. 01:47 and 01:48). The pass time is its first detection's.
 */
export function passes(rows: Detection[], gap = 3): Pass[] {
  const sorted = [...rows].sort((a, b) =>
    a.satellite.localeCompare(b.satellite) || a.date.localeCompare(b.date) || a.time.localeCompare(b.time),
  );
  const out: Pass[] = [];
  let last: { p: Pass; t: number } | null = null;
  for (const r of sorted) {
    const t = minutes(r.time);
    if (last && last.p.satellite === r.satellite && last.p.date === r.date && t - last.t <= gap) {
      last.p.points.push([r.lat, r.lon]);
      last.t = t;
    } else {
      last = { p: { satellite: r.satellite, date: r.date, time: r.time, points: [[r.lat, r.lon]] }, t };
      out.push(last.p);
    }
  }
  return out;
}

export type Bbox = { w: number; s: number; e: number; n: number };

export type FirePair = { modis: Pass; viirs: Pass; gapMinutes: number; ratio: number };

/**
 * The story's fire: the Pedrógão Grande fire in central Portugal, the day after it started (17 June 2017). The box
 * holds that fire and the Góis fire just north of it; the points come from portugal/points/2017.csv.
 */
export const STORY_FIRE = {
  region: "portugal",
  date: "2017-06-18",
  place: "Pedrógão Grande, Portugal",
  bbox: { w: -8.7, s: 39.6, e: -7.8, n: 40.3 } satisfies Bbox,
} as const;

/**
 * "Same fire, two answers": on `date`, inside `bbox`, the daytime MODIS and VIIRS overpasses closest together in time
 * (each with at least `minPoints` detections), so both satellites saw the fire at nearly the same moment.
 */
export function closestPair(rows: Detection[], date: string, bbox: Bbox, minPoints = 5): FirePair | null {
  const inside = rows.filter(
    (r) => r.date === date && r.daynight === "D" && r.lat >= bbox.s && r.lat <= bbox.n && r.lon >= bbox.w && r.lon <= bbox.e,
  );
  const all = passes(inside).filter((p) => p.points.length >= minPoints);
  let best: FirePair | null = null;
  for (const m of all.filter((p) => isModis(p.satellite))) {
    for (const v of all.filter((p) => !isModis(p.satellite))) {
      const gapMinutes = Math.abs(minutes(m.time) - minutes(v.time));
      if (!best || gapMinutes < best.gapMinutes) {
        best = { modis: m, viirs: v, gapMinutes, ratio: v.points.length / m.points.length };
      }
    }
  }
  return best;
}

/**
 * Local metric frame for drawing footprints: x east, y south, in metres from the top-left of `bbox`. Equirectangular
 * at the bbox's middle latitude; over a few tens of kilometres the error is well under one VIIRS pixel.
 */
export function metricFrame(bbox: Bbox) {
  const R = 6_371_000, rad = Math.PI / 180;
  const kx = R * rad * Math.cos(((bbox.s + bbox.n) / 2) * rad), ky = R * rad;
  return {
    width: (bbox.e - bbox.w) * kx,
    height: (bbox.n - bbox.s) * ky,
    project: ([lat, lon]: [number, number]): [number, number] => [(lon - bbox.w) * kx, (bbox.n - lat) * ky],
  };
}

/** The extent of some points, padded by `padM` metres on every side. */
export function extent(points: [number, number][], padM: number): Bbox {
  const lats = points.map((p) => p[0]), lons = points.map((p) => p[1]);
  const mid = (Math.min(...lats) + Math.max(...lats)) / 2;
  const dLat = padM / 111_195, dLon = padM / (111_195 * Math.cos((mid * Math.PI) / 180));
  return { s: Math.min(...lats) - dLat, n: Math.max(...lats) + dLat, w: Math.min(...lons) - dLon, e: Math.max(...lons) + dLon };
}

export type LineSeries = {
  years: number[]; // complete years only
  raw: number[]; // MODIS before VIIRS_FROM, VIIRS (harmonized, ML-009 fills its first January weeks) from VIIRS_FROM
  harmonized: number[];
  lo: (number | null)[]; // 5-95% band where the value is the model's back-cast, else null
  hi: (number | null)[];
  jumpAt: number; // index of VIIRS_FROM
};

/** The raw and harmonized annual lines for the story, complete years only (a partial year is never drawn here). */
export function storyLines(D: Annual): LineSeries {
  const end = completeEnd(D);
  const idx = D.years.map((_, i) => i).filter((i) => i < end);
  const back = (i: number) => D.years[i] < VIIRS_FROM;
  return {
    years: idx.map((i) => D.years[i]),
    raw: idx.map((i) => (back(i) ? D.modis[i] : D.harmonized[i])),
    harmonized: idx.map((i) => D.harmonized[i]),
    lo: idx.map((i) => (back(i) ? D.lo[i] : null)),
    hi: idx.map((i) => (back(i) ? D.hi[i] : null)),
    jumpAt: idx.findIndex((i) => D.years[i] === VIIRS_FROM),
  };
}

/** "doubled", "tripled", "quadrupled" for a jump that rounds to 2, 3 or 4; otherwise "rose ×N.N". */
export function jumpVerb(jump: number): string {
  const words: Record<number, string> = { 2: "double", 3: "triple", 4: "quadruple" };
  const w = words[Math.round(jump)];
  return w && Math.abs(jump - Math.round(jump)) < 0.25 ? w : `rise ×${jump.toFixed(1)}`;
}

/** Big counts for copy: 4.2 million, 1.8 million, 186,439. */
export function bigCount(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} million` : n.toLocaleString("en-US");
}

/** "12:53 UTC" from "1253". */
export const utc = (hhmm: string) => `${hhmm.slice(0, 2)}:${hhmm.slice(2)} UTC`;
