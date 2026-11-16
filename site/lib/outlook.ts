import { weekSpan, type Weekly } from "./series.ts";

const W = 52;
const DAY_MS = 86_400_000;

const lastWeekPartial = (w: Weekly) => {
  const i = w.modis.length - 1;
  return w.last_week_days < weekSpan(w.start_year + Math.floor(i / W), i % W).length;
};

export function quantile(v: number[], q: number): number {
  if (v.length === 0) return NaN;
  const s = [...v].sort((a, b) => a - b), k = (s.length - 1) * q, lo = Math.floor(k);
  return s[lo] + (s[Math.ceil(k)] - s[lo]) * (k - lo);
}

export function harmonized(w: Weekly): number[] {
  return w.modis.map((_, i) => w.viirs[i] ?? w.pred[i]);
}

export function seasonStartWeek(w: Weekly, baseline: [number, number]): number {
  const v = harmonized(w), last = v.length - 1, meds: number[] = [];
  for (let wk = 0; wk < W; wk++) {
    const col: number[] = [];
    for (let y = baseline[0]; y <= baseline[1]; y++) {
      const i = (y - w.start_year) * W + wk;
      if (i >= 0 && i <= last && !(i === last && lastWeekPartial(w))) col.push(v[i]);
    }
    meds.push(col.length ? quantile(col, 0.5) : Infinity);
  }
  return meds.indexOf(Math.min(...meds));
}

export type Season = {
  year: number;
  label: string;
  start: string;
  cum: number[];
  complete: boolean;
  forwardWeeks: number;
};

export function seasons(w: Weekly, startWeek: number): Season[] {
  const v = harmonized(w), n = v.length, out: Season[] = [];
  for (let y = w.start_year; ; y++) {
    const i0 = (y - w.start_year) * W + startWeek;
    if (i0 >= n) break;
    const cum: number[] = [];
    let s = 0, fwd = 0;
    for (let k = 0; k < W && i0 + k < n; k++) {
      s += v[i0 + k];
      cum.push(s);
      if (w.source?.[i0 + k] === "forward") fwd++;
    }
    const complete = cum.length === W && !(i0 + W - 1 === n - 1 && lastWeekPartial(w));
    out.push({
      year: y,
      label: startWeek === 0 ? String(y) : `${y}-${String((y + 1) % 100).padStart(2, "0")}`,
      start: weekSpan(y, startWeek).start,
      cum,
      complete,
      forwardWeeks: fwd,
    });
  }
  return out;
}

export function cumAt(cum: number[], k: number, frac = 0): number {
  const whole = k > 0 ? cum[Math.min(k, cum.length) - 1] : 0;
  if (frac <= 0 || k >= cum.length) return whole;
  return whole + frac * (cum[k] - whole);
}

export type Forecast = { median: number; lo: number; hi: number; n: number };

export function forecastFrom(now: number, past: Season[], k: number, frac: number): Forecast | null {
  const r = past.flatMap((s) => {
    const at = cumAt(s.cum, k, frac);
    return at > 0 ? [s.cum[W - 1] / at] : [];
  });
  if (r.length < 5) return null;
  return { median: now * quantile(r, 0.5), lo: now * quantile(r, 0.05), hi: now * quantile(r, 0.95), n: r.length };
}

export function weekAtShare(past: Season[], share: number): number {
  for (let k = 1; k <= W; k++) {
    if (quantile(past.map((s) => s.cum[k - 1] / s.cum[W - 1]), 0.5) >= share) return k;
  }
  return W;
}

export type BacktestRow = {
  share: number;
  week: number;
  mape: number;
  covered: number;
  n: number;
};

export function backtest(past: Season[], shares = [0.25, 0.5, 0.75]): BacktestRow[] {
  return shares.map((share) => {
    let err = 0, covered = 0, n = 0, wk = 0;
    past.forEach((s, i) => {
      const others = past.filter((_, j) => j !== i);
      const k = weekAtShare(others, share);
      wk += k;
      const final = s.cum[W - 1];
      const f = forecastFrom(s.cum[k - 1], others, k, 0);
      if (!f || final <= 0) return;
      err += Math.abs(f.median - final) / final;
      if (final >= f.lo * (1 - 1e-9) && final <= f.hi * (1 + 1e-9)) covered++;
      n++;
    });
    return { share, week: Math.round(wk / past.length), mape: n ? (100 * err) / n : NaN, covered, n };
  });
}

export type Outlook = {
  startWeek: number;
  past: Season[];
  current: Season;
  through: string;
  weeks: number;
  frac: number;
  now: number;
  pastMedian: number;
  rankQuiet: number;
  forecast: Forecast | null;
  reason: "too-early" | "nothing-yet" | "season-complete" | "too-few-seasons" | null;
  backtest: BacktestRow[];
};

export function outlook(w: Weekly, baseline: [number, number]): Outlook | null {
  const startWeek = seasonStartWeek(w, baseline);
  const all = seasons(w, startWeek);
  const current = all.at(-1);
  const past = all.filter((s) => s.complete && s !== current && s.cum[W - 1] > 0);
  if (!current || past.length === 0) return null;
  const n = w.modis.length, len = current.cum.length;
  const lastYear = w.start_year + Math.floor((n - 1) / W), lastSpan = weekSpan(lastYear, (n - 1) % W);
  const lastPartial = lastWeekPartial(w);
  const weeks = lastPartial ? len - 1 : len;
  const frac = lastPartial ? w.last_week_days / lastSpan.length : 0;
  const through = isoDay(Date.parse(`${lastSpan.start}T00:00:00Z`) + (Math.min(w.last_week_days, lastSpan.length) - 1) * DAY_MS);
  const now = current.cum[len - 1];
  const at = past.map((s) => cumAt(s.cum, weeks, frac));
  const medShare = quantile(past.map((s, i) => at[i] / s.cum[W - 1]), 0.5);
  let forecast: Forecast | null = null;
  let reason: Outlook["reason"] = null;
  if (current.complete) reason = "season-complete";
  else if (!(medShare >= 0.05)) reason = "too-early";
  else if (now <= 0) reason = "nothing-yet";
  else {
    forecast = forecastFrom(now, past, weeks, frac);
    if (!forecast) reason = "too-few-seasons";
  }
  return {
    startWeek,
    past,
    current,
    through,
    weeks,
    frac,
    now,
    pastMedian: quantile(at, 0.5),
    rankQuiet: 1 + at.filter((a) => a < now).length,
    forecast,
    reason,
    backtest: backtest(past),
  };
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
