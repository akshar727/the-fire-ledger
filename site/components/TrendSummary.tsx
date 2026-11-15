"use client";

// FE-014 (F-7): "is the trend real?" under the record chart. One sentence and a small graphic of the Theil-Sen slope
// and its 90% interval for the stitched and the harmonized record, recomputed for the complete years in the selected
// range (lib/trend.ts, a port of trend_stats.py). The stitched 2012 total needs the weekly file, so series.json is
// fetched only when 2012 is in a range other than the published 2001-2025 block (whose answer annual.json already
// holds); the harmonized row never waits for it.
import { useEffect, useRef, useState } from "react";

import { Disclosure } from "@/components/Disclosure";
import { VIIRS_FROM, type Annual } from "@/lib/annual";
import { fetchSeries, type RegionId } from "@/lib/data";
import { ALPHA, isSignificant, rangeTrend, rangeYears, slopeLabel, trendSentence, type TrendBlock, type TrendStat, type WeeklyRaw } from "@/lib/trend";

type Weekly = { region: RegionId; weekly: WeeklyRaw | null; failed: boolean };

export function TrendSummary({ data, regionId, years }: { data: Annual; regionId: RegionId; years: [number, number] }) {
  const D = data as Annual & { trend?: TrendBlock };
  const [loaded, setLoaded] = useState<Weekly | null>(null);
  const w = loaded?.region === regionId ? loaded : null;
  // fetch once per region; a later range that needs it reuses what is loaded
  const fetchNow = rangeYears(D, years).needsWeekly && !(w && !w.failed);

  useEffect(() => {
    if (!fetchNow) return;
    const ac = new AbortController();
    fetchSeries(regionId, ac.signal).then(
      (r) => setLoaded({ region: regionId, weekly: r.status === "ready" ? (r.bundle.weekly ?? null) : null, failed: r.status !== "ready" || !r.bundle.weekly }),
      () => {
        if (!ac.signal.aborted) setLoaded({ region: regionId, weekly: null, failed: true });
      },
    );
    return () => ac.abort();
  }, [regionId, fetchNow]);

  const r = rangeTrend(D, years, w?.weekly);
  // weekly file missing or broken: say so instead of "loading" forever
  const sentence = trendSentence(r, !!w?.failed);

  return (
    <div className="flex flex-col gap-3 border-t pt-6">
      <h3 className="text-sm font-semibold">Is the trend real?</h3>
      <p className="max-w-[75ch] text-sm leading-relaxed" aria-live="polite">
        {sentence}
      </p>
      {r.years.length >= 3 && <SlopeIntervals stitched={r.stitched} harmonized={r.harmonized} boot={r.boot} />}
      {/* FE-025: the method note on request */}
      <Disclosure summary="How the trend is measured">
        <p className="max-w-[75ch] text-xs leading-relaxed text-muted-foreground">
          Theil-Sen slope as a share of the median year, with its {Math.round(ALPHA * 100)}% interval; significant means a
          Mann-Kendall p below 0.05. Partial years are left out. The stitched record glues raw MODIS (before 20 January{" "}
          {VIIRS_FROM}) to raw VIIRS, so it carries the sensor change.
          {r.boot &&
            ` The thin tick marks show how much the harmonized slope moves across the ${D.method === "ratio" ? "ratio estimate's" : "model's"} back-cast draws.`}
        </p>
      </Disclosure>
    </div>
  );
}

const MAX_W = 640;
const L = 92; // label column
const R = 16;
const ROW = 34;

/** Dot = slope, bar = interval, dashed line = no change; one row per record. */
function SlopeIntervals({ stitched, harmonized, boot }: { stitched: TrendStat | null; harmonized: TrendStat; boot: [number, number] | null }) {
  const rows: { label: string; t: TrendStat | null; color: string }[] = [
    { label: "Stitched", t: stitched, color: "var(--muted-foreground)" },
    { label: "Harmonized", t: harmonized, color: "var(--primary)" },
  ];
  const vals = rows.flatMap(({ t }) => (t ? [t.slope_pct, t.lo_pct, t.hi_pct] : [])).concat(boot ?? []);
  const nums = vals.filter((v): v is number => v !== null && Number.isFinite(v));
  const step = niceStep(Math.max(1, ...nums.map(Math.abs)));
  const lim = step * Math.max(1, Math.ceil(Math.max(1e-9, ...nums.map(Math.abs)) / step));
  // drawn at its real pixel width (not a scaled viewBox), so the 11-12 px labels stay readable on a phone
  const box = useRef<HTMLElement>(null);
  const [W, setW] = useState(MAX_W);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.min(MAX_W, Math.round(e.contentRect.width)))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const x = (v: number) => L + ((v + lim) / (2 * lim)) * (W - L - R);
  const H = 22 + rows.length * ROW;
  const ticks = [-lim, -lim / 2, 0, lim / 2, lim];

  return (
    <figure ref={box} className="flex w-full max-w-[640px] flex-col gap-1">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="max-w-full" role="img" aria-labelledby="trend-graphic-title">
        <title id="trend-graphic-title">
          {rows.map(({ label, t }) => `${label}: ${describe(t)}`).join(". ")}
        </title>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={x(v)} x2={x(v)} y1={4} y2={H - 18} stroke="var(--border)" strokeDasharray={v === 0 ? "4 3" : undefined} strokeWidth={v === 0 ? 1.5 : 1} />
            <text x={x(v)} y={H - 4} textAnchor="middle" className="fill-muted-foreground text-[11px] tabular-nums">
              {v === 0 ? "0" : `${v > 0 ? "+" : "−"}${fmt(Math.abs(v))}%`}
            </text>
          </g>
        ))}
        {rows.map(({ label, t, color }, k) => {
          const cy = 6 + ROW / 2 + k * ROW;
          const ok = t && t.slope_pct !== null && t.lo_pct !== null && t.hi_pct !== null;
          return (
            <g key={label}>
              <text x={0} y={cy + 4} className="fill-foreground text-[12px]">
                {label}
              </text>
              {ok ? (
                <>
                  <line x1={x(t.lo_pct!)} x2={x(t.hi_pct!)} y1={cy} y2={cy} stroke={color} strokeWidth={6} strokeLinecap="round" opacity={0.35} />
                  {k === 1 && boot && (
                    <>
                      <line x1={x(boot[0])} x2={x(boot[0])} y1={cy - 8} y2={cy + 8} stroke={color} strokeWidth={1.5} />
                      <line x1={x(boot[1])} x2={x(boot[1])} y1={cy - 8} y2={cy + 8} stroke={color} strokeWidth={1.5} />
                    </>
                  )}
                  <circle cx={x(t.slope_pct!)} cy={cy} r={5} fill={isSignificant(t) ? color : "var(--card)"} stroke={color} strokeWidth={2} />
                </>
              ) : (
                <text x={L} y={cy + 4} className="fill-muted-foreground text-[12px]">
                  {t === null ? "loading…" : "no trend can be measured"}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="text-xs text-muted-foreground">
        % change a year. Filled dot = significant, hollow = not; the bar is the {Math.round(ALPHA * 100)}% interval, so a bar
        across the dashed zero line means no clear direction.
      </figcaption>
    </figure>
  );
}

function describe(t: TrendStat | null): string {
  if (t === null) return "loading";
  if (t.slope_pct === null || t.lo_pct === null || t.hi_pct === null) return "no trend can be measured";
  return `${slopeLabel(t.slope_pct)}, ${Math.round(ALPHA * 100)}% interval ${fmt(t.lo_pct)} to ${fmt(t.hi_pct)}%, ${isSignificant(t) ? "significant" : "not significant"}`;
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

/** 1, 2, 2.5 or 5 × 10^k so that about two steps cover m. */
function niceStep(m: number): number {
  const raw = m / 2;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
