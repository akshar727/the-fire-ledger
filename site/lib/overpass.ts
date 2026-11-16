// FE-031 (F-3b, site half): the MODIS orbit drift, from each deep dive's annual.json `overpass` (ML-016: median daytime
// local solar time of each satellite's detections per year, hours, from FIRMS `time_utc` + longitude / 15) and `drifted`
// (1 = a year whose overpass times are off the training years'). Pure and import-free, so `node --test` covers it and
// the method page renders the chart on the server.

export const SENSORS = ["terra", "aqua", "snpp"] as const;
export type Sensor = (typeof SENSORS)[number];

export const SENSOR_NAME: Readonly<Record<Sensor, string>> = { terra: "Terra", aqua: "Aqua", snpp: "Suomi NPP" };

/** The annual.json fields this reads. Whole countries carry `overpass: null` (no points files): they are skipped. */
export type OverpassSource = {
  years: number[];
  overpass?: Partial<Record<Sensor, (number | null)[]>> | null;
  drifted?: number[] | null;
};

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** "10:40" for 10.667 hours (local solar time, nearest minute). */
export function clock(h: number): string {
  const m = Math.round(h * 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

/** "about 1.5 hours" / "about 50 minutes" for a shift in hours (sign ignored). */
export function shiftText(h: number): string {
  const a = Math.abs(h);
  if (a >= 0.95) {
    const v = Math.round(a * 2) / 2; // nearest half hour
    return `about ${String(v)} ${v === 1 ? "hour" : "hours"}`;
  }
  const m = Math.max(5, Math.round((a * 60) / 5) * 5); // nearest 5 minutes, never "0 minutes"
  return `about ${m} minutes`;
}

/** Mean, over the records and the kept years, of a sensor's yearly median overpass times (null when there are none). */
function meanOver(records: OverpassSource[], s: Sensor, keep: (y: number) => boolean): number | null {
  const v: number[] = [];
  for (const r of records)
    r.years.forEach((y, i) => {
      const x = r.overpass?.[s]?.[i];
      if (keep(y) && isNum(x)) v.push(x);
    });
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

export type Drift = { base: number; last: number; shift: number };

/**
 * How far Terra and Aqua moved: their yearly median overpass times averaged over the training years (`train`, inclusive) against the
 * last year with data, both averaged over the records. Null for a sensor with no data in either span.
 */
export function driftSummary(
  records: OverpassSource[],
  train: [number, number],
): { year: number; terra: Drift | null; aqua: Drift | null } | null {
  const rs = records.filter((r) => r.overpass);
  if (!rs.length) return null;
  const year = Math.max(...rs.map((r) => r.years.at(-1)!));
  const one = (s: Sensor): Drift | null => {
    const base = meanOver(rs, s, (y) => y >= train[0] && y <= train[1]);
    const last = meanOver(rs, s, (y) => y === year);
    return base === null || last === null ? null : { base, last, shift: last - base };
  };
  return { year, terra: one("terra"), aqua: one("aqua") };
}

/** Years flagged drifted in any record (the shaded bands). */
export function driftedYears(records: OverpassSource[]): number[] {
  const out = new Set<number>();
  for (const r of records) r.years.forEach((y, i) => r.drifted?.[i] === 1 && out.add(y));
  return [...out].sort((a, b) => a - b);
}

/** Consecutive runs of years, e.g. [2010, 2024, 2025, 2026] -> [[2010, 2010], [2024, 2026]] (one shaded band each). */
export function runs(years: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const y of years) {
    const r = out.at(-1);
    if (r && y === r[1] + 1) r[1] = y;
    else out.push([y, y]);
  }
  return out;
}

/** SVG path for one series: "M x y L x y ...", a new "M" after a gap (null), "" when there is nothing to draw. */
export function linePath(years: number[], vals: (number | null | undefined)[], x: (y: number) => number, y: (h: number) => number): string {
  let d = "";
  let pen = false;
  years.forEach((yr, i) => {
    const v = vals[i];
    if (!isNum(v)) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(yr).toFixed(1)} ${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}
