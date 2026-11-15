// FE-022: what the season outlook chart says and draws, from `outlook()` (lib/outlook.ts, FE-021). No new statistics:
// the forecast range per week uses the same ratio method as `forecastFrom`, so its last point is `outlook().forecast`.
// Pure functions with relative imports only, so `node --test` runs them.
import { cumAt, quantile, weekAtShare, type BacktestRow, type Outlook, type Season } from "./outlook.ts";
import { MONTHS, MONTHS_LONG, type Weekly } from "./series.ts";

const W = 52;
const DAY_MS = 86_400_000;

const fmt = (v: number) => Math.round(v).toLocaleString("en-US");

/** 1st, 2nd, 3rd, 11th, 22nd. */
export function ordinal(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** "3rd quietest" in the quieter half (rank 1 = quietest of `of`), "2nd busiest" in the busier half. */
export function rankPhrase(rankQuiet: number, of: number): string {
  if (rankQuiet === 1) return "quietest";
  if (rankQuiet === of) return "busiest";
  const busy = of + 1 - rankQuiet;
  return rankQuiet <= busy ? `${ordinal(rankQuiet)} quietest` : `${ordinal(busy)} busiest`;
}

/** "14 Nov" for YYYY-MM-DD. */
export const shortDay = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

/** Day `days` after a season's first day, YYYY-MM-DD. */
export const dayInSeason = (start: string, days: number) =>
  new Date(Date.parse(`${start}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Median share of their own total that past seasons had reached at the current point (0..1). */
export function medianShare(o: Outlook): number {
  return quantile(o.past.map((s) => cumAt(s.cum, o.weeks, o.frac) / s.cum[W - 1]), 0.5);
}

/** The back-test row nearest to the current point in the season (by weeks); ties go to the earlier row. */
export function backtestNow(o: Outlook): BacktestRow | null {
  const pos = o.weeks + o.frac;
  let best: BacktestRow | null = null;
  for (const r of o.backtest) if (r.n > 0 && (!best || Math.abs(r.week - pos) < Math.abs(best.week - pos))) best = r;
  return best;
}

export type RangePoint = { x: number; lo: number; median: number; hi: number };

/**
 * The forecast range week by week, from now (x = weeks + frac, all three = now) to the season end (x = 52): at each
 * later week, each past season's (running total then / its total now) times the current total, then the 5th, 50th
 * and 95th percentile. Empty when `outlook` made no forecast. The x = 52 point equals `o.forecast`.
 */
export function forecastPath(o: Outlook): RangePoint[] {
  if (!o.forecast) return [];
  const usable = o.past.flatMap((s) => {
    const at = cumAt(s.cum, o.weeks, o.frac);
    return at > 0 ? [{ s, at }] : [];
  });
  const out: RangePoint[] = [{ x: o.weeks + o.frac, lo: o.now, median: o.now, hi: o.now }];
  for (let k = o.weeks + 1; k <= W; k++) {
    const r = usable.map(({ s, at }) => s.cum[k - 1] / at);
    out.push({ x: k, lo: o.now * quantile(r, 0.05), median: o.now * quantile(r, 0.5), hi: o.now * quantile(r, 0.95) });
  }
  return out;
}

/** Weeks of `season` (0-based, from its first week) that hold NOAA-20/21 forward-link days. */
export function forwardWeeks(w: Weekly, startWeek: number, season: Season): number[] {
  const i0 = (season.year - w.start_year) * W + startWeek, out: number[] = [];
  for (let k = 0; k < season.cum.length; k++) if (w.source?.[i0 + k] === "forward") out.push(k);
  return out;
}

/**
 * Months that hold the middle of a typical season's fire: from the week the median past season passes 10% of its total
 * to the week it passes 90%, as "December to February" (one month when both fall in it).
 */
export function mainBurnMonths(past: Season[], start: string): string {
  const a = weekAtShare(past, 0.1), b = weekAtShare(past, 0.9);
  const m = (d: string) => MONTHS_LONG[Number(d.slice(5, 7)) - 1];
  const from = m(dayInSeason(start, 7 * (a - 1))), to = m(dayInSeason(start, 7 * b - 1));
  return from === to ? from : `${from} to ${to}`;
}

/** Quietest and busiest past seasons by their final total. */
export function extremes(past: Season[]): { quietest: Season; busiest: Season } {
  let quietest = past[0], busiest = past[0];
  for (const s of past) {
    if (s.cum[W - 1] < quietest.cum[W - 1]) quietest = s;
    if (s.cum[W - 1] > busiest.cum[W - 1]) busiest = s;
  }
  return { quietest, busiest };
}

/**
 * True when the region's data stop in an earlier calendar year than the site's latest data (a country-tier region
 * with no data this year): the chart then shows the last complete season, without a forecast.
 */
export const isStale = (through: string, siteThrough: string) => through.slice(0, 4) < siteThrough.slice(0, 4);

/**
 * For a stale region: the last complete season (the current one when it is complete, else the last past one), every
 * complete season, and its rank among them by total (1 = quietest).
 */
export function staleView(o: Outlook): { focus: Season; seasons: Season[]; rank: number } {
  const seasons = o.current.complete ? [...o.past, o.current] : o.past;
  const focus = seasons.at(-1)!, total = focus.cum[W - 1];
  return { focus, seasons, rank: 1 + seasons.filter((s) => s.cum[W - 1] < total).length };
}

/** Week of the season the data reach (1-52; a partial week counts). */
export const seasonWeek = (o: Outlook) => Math.min(W, o.weeks + (o.frac > 0 ? 1 : 0));

/** True when the back-test row was made within 2 weeks of where the season is now. */
export const backtestIsNear = (o: Outlook, r: BacktestRow) => Math.abs(r.week - (o.weeks + o.frac)) <= 2;

/** "83%, less often than the 90% a 5-95% range promises", or just "92%" when the range held at least 90% of the time. */
export function coveragePhrase(covered: number, n: number): string {
  const pct = Math.round((100 * covered) / n);
  return covered / n < 0.9 ? `${pct}%, less often than the 90% a 5-95% range promises` : `${pct}%`;
}

export type OutlookText = {
  /** where the season stands */
  headline: string;
  /** the forecast range, or why there is none */
  forecast: string;
  /** how the same forecast did on past seasons; empty without a forecast */
  honest: string;
};

/** The sentences under the chart. `stale`: the region has no data this year (see `isStale`). */
export function outlookText(o: Outlook, stale = false): OutlookText {
  const of = o.past.length + 1;
  if (stale) {
    const { focus, seasons, rank } = staleView(o);
    return {
      headline: `No data for this year yet. The last complete season, ${focus.label}, ended with ${fmt(focus.cum[W - 1])} detections, the ${rankPhrase(rank, seasons.length)} of ${seasons.length}.`,
      forecast: "No forecast: the ledger stops before the current season.",
      honest: "",
    };
  }
  const cur = o.current;
  if (o.reason === "season-complete") {
    return {
      headline: `The ${cur.label} season ended with ${fmt(o.now)} detections, the ${rankPhrase(o.rankQuiet, of)} of ${of}.`,
      forecast: "No forecast: the season is complete.",
      honest: "",
    };
  }
  const headline =
    `By ${shortDay(o.through)} this is the ${rankPhrase(o.rankQuiet, of)} season of ${of}: ${fmt(o.now)} detections ` +
    `so far in ${cur.label}, against ${fmt(o.pastMedian)} for a typical past season by the same date.`;
  if (!o.forecast) {
    const why =
      o.reason === "too-early"
        ? `Too early to forecast: by this date a typical season has had only ${Math.round(100 * medianShare(o))}% of its fire. Most of it burns ${mainBurnMonths(o.past, cur.start)}.`
        : o.reason === "nothing-yet"
          ? "Too early to forecast: no fire detected yet this season, so there is nothing to scale from."
          : "Too early to forecast: too few past seasons had any fire by this date.";
    return { headline, forecast: why, honest: "" };
  }
  const f = o.forecast;
  const bt = backtestNow(o);
  const near = bt != null && backtestIsNear(o, bt);
  const when = (r: BacktestRow) =>
    near
      ? `from about this point (week ${r.week} of 52)`
      : `at week ${r.week} of 52, the nearest point we tested (this season is in week ${seasonWeek(o)})`;
  // when the tested point is far from today, say how the error changed through the season (all rows, real numbers)
  const trendNote =
    near || o.backtest.length < 2
      ? ""
      : ` Across the tested points the error was ${o.backtest.map((r) => `${Math.round(r.mape)}% at week ${r.week}`).join(", ")}.`;
  const honest = bt
    ? `Tested on ${bt.n} past seasons ${when(bt)}, each forecast made without its own season: ` +
      `off by ${Math.round(bt.mape)}% on average, and the range held the real total ${bt.covered} of ${bt.n} times ` +
      `(${coveragePhrase(bt.covered, bt.n)}).${trendNote}`
    : "";
  return {
    headline,
    forecast: `At this pace it ends between ${fmt(f.lo)} and ${fmt(f.hi)} detections (middle estimate ${fmt(f.median)}).`,
    honest,
  };
}
