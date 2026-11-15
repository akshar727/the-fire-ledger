// FE-021: season outlook maths (no UI). From the weekly harmonized record (`viirs ?? pred`, the calendar's value):
// running totals per fire season, where this season stands among past seasons at the same point, a forecast of its
// final total from how past seasons finished, and a leave-one-season-out back-test of that forecast.
// Pure functions with relative imports only, so `node --test` runs them. FE-022 draws the chart.
import { weekSpan, type Weekly } from "./series.ts";

const W = 52;
const DAY_MS = 86_400_000;

/** True when the series' last week stops before its own end (week 51 is 8 or 9 days long, the others 7). */
const lastWeekPartial = (w: Weekly) => {
  const i = w.modis.length - 1;
  return w.last_week_days < weekSpan(w.start_year + Math.floor(i / W), i % W).length;
};

/** Linear-interpolated quantile (type 7), q in 0..1; NaN for an empty list. */
export function quantile(v: number[], q: number): number {
  if (v.length === 0) return NaN;
  const s = [...v].sort((a, b) => a - b), k = (s.length - 1) * q, lo = Math.floor(k);
  return s[lo] + (s[Math.ceil(k)] - s[lo]) * (k - lo);
}

/** Harmonized weekly values, one per week of the series (the last week may be partial, `last_week_days`). */
export function harmonized(w: Weekly): number[] {
  return w.modis.map((_, i) => w.viirs[i] ?? w.pred[i]);
}

/**
 * First week of the fire season (0-51): the week with the lowest median over the calendar years in `baseline`
 * (inclusive), so a season that runs across New Year (Ghana, November to February) is not cut on 1 January.
 */
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
  /** calendar year the season starts in */
  year: number;
  /** "2026", or "2025-26" when the season crosses New Year */
  label: string;
  /** first day of the season, YYYY-MM-DD */
  start: string;
  /** running total after each week of the season (up to 52 values; fewer for the current season) */
  cum: number[];
  /** all 52 weeks present and the last one whole */
  complete: boolean;
  /** weeks of this season that hold NOAA-20/21 forward-link days (ML-017) */
  forwardWeeks: number;
};

/** Splits the weekly record into seasons starting at `startWeek`, one per start year from the first year of the record. */
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

/** Running total after `k` whole weeks plus `frac` of the next week (k = 0, frac = 0 gives 0). */
export function cumAt(cum: number[], k: number, frac = 0): number {
  const whole = k > 0 ? cum[Math.min(k, cum.length) - 1] : 0;
  if (frac <= 0 || k >= cum.length) return whole;
  return whole + frac * (cum[k] - whole);
}

export type Forecast = { median: number; lo: number; hi: number; n: number };

/**
 * Season-total forecast from a running total `now`: each past season's (final total / its total at the same point)
 * times `now`, then the median and the 5th-95th percentile over those seasons. Seasons with nothing yet at that point
 * are skipped; fewer than 5 usable seasons gives null.
 */
export function forecastFrom(now: number, past: Season[], k: number, frac: number): Forecast | null {
  const r = past.flatMap((s) => {
    const at = cumAt(s.cum, k, frac);
    return at > 0 ? [s.cum[W - 1] / at] : [];
  });
  if (r.length < 5) return null;
  return { median: now * quantile(r, 0.5), lo: now * quantile(r, 0.05), hi: now * quantile(r, 0.95), n: r.length };
}

/** Whole weeks into the season (1-52) by which the median past season has reached `share` of its own total. */
export function weekAtShare(past: Season[], share: number): number {
  for (let k = 1; k <= W; k++) {
    if (quantile(past.map((s) => s.cum[k - 1] / s.cum[W - 1]), 0.5) >= share) return k;
  }
  return W;
}

export type BacktestRow = {
  /** share of a median season already burnt at the forecast point */
  share: number;
  /** whole weeks into the season (mean over the held-out seasons; each one's point is chosen from the others) */
  week: number;
  /** mean absolute % error of the forecast median against the real final total */
  mape: number;
  /** seasons whose real total fell inside the 5-95% range */
  covered: number;
  n: number;
};

/** Forecasts each complete season from all the others at the points where a median season is 25%, 50% and 75% done. */
export function backtest(past: Season[], shares = [0.25, 0.5, 0.75]): BacktestRow[] {
  return shares.map((share) => {
    let err = 0, covered = 0, n = 0, wk = 0;
    past.forEach((s, i) => {
      // leave-one-out: the held-out season picks neither the forecast point nor the ratios
      const others = past.filter((_, j) => j !== i);
      const k = weekAtShare(others, share);
      wk += k;
      const final = s.cum[W - 1];
      const f = forecastFrom(s.cum[k - 1], others, k, 0);
      if (!f || final <= 0) return;
      err += Math.abs(f.median - final) / final;
      if (final >= f.lo * (1 - 1e-9) && final <= f.hi * (1 + 1e-9)) covered++; // tolerance: float rounding when lo = hi
      n++;
    });
    return { share, week: Math.round(wk / past.length), mape: n ? (100 * err) / n : NaN, covered, n };
  });
}

export type Outlook = {
  startWeek: number;
  past: Season[];
  current: Season;
  /** last day with data, YYYY-MM-DD */
  through: string;
  /** whole weeks of the current season, plus `frac` of a partial last week */
  weeks: number;
  frac: number;
  /** current running total */
  now: number;
  /** median of the past seasons' running totals at the same point */
  pastMedian: number;
  /** rank of the current season among past seasons plus itself at the same point: 1 = quietest */
  rankQuiet: number;
  /** null when no forecast is made; `reason` says why */
  forecast: Forecast | null;
  reason: "too-early" | "nothing-yet" | "season-complete" | "too-few-seasons" | null;
  backtest: BacktestRow[];
};

/**
 * Season outlook for a weekly series. The last season is the current one; past seasons are every complete season
 * before it. `baseline` picks the season start week. No forecast before 5% of a median season has happened.
 */
export function outlook(w: Weekly, baseline: [number, number]): Outlook | null {
  const startWeek = seasonStartWeek(w, baseline);
  const all = seasons(w, startWeek);
  const current = all.at(-1);
  // a past season with no fire at all gives no share or ratio (0/0), so it is left out
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
  else if (now <= 0) reason = "nothing-yet"; // a ratio times 0 would read as "no fire expected"
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
