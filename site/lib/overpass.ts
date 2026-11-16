export const SENSORS = ["terra", "aqua", "snpp"] as const;
export type Sensor = (typeof SENSORS)[number];

export const SENSOR_NAME: Readonly<Record<Sensor, string>> = { terra: "Terra", aqua: "Aqua", snpp: "Suomi NPP" };

export type OverpassSource = {
  years: number[];
  overpass?: Partial<Record<Sensor, (number | null)[]>> | null;
  drifted?: number[] | null;
};

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function clock(h: number): string {
  const m = Math.round(h * 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

export function shiftText(h: number): string {
  const a = Math.abs(h);
  if (a >= 0.95) {
    const v = Math.round(a * 2) / 2;
    return `about ${String(v)} ${v === 1 ? "hour" : "hours"}`;
  }
  const m = Math.max(5, Math.round((a * 60) / 5) * 5);
  return `about ${m} minutes`;
}

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

export function driftedYears(records: OverpassSource[]): number[] {
  const out = new Set<number>();
  for (const r of records) r.years.forEach((y, i) => r.drifted?.[i] === 1 && out.add(y));
  return [...out].sort((a, b) => a - b);
}

export function runs(years: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const y of years) {
    const r = out.at(-1);
    if (r && y === r[1] + 1) r[1] = y;
    else out.push([y, y]);
  }
  return out;
}

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
