"use client";

// FE-022: season outlook on /ledger, under the annual chart. This fire season's running total against every past
// season since the record starts, with the forecast range to season end and how that forecast did on past seasons.
// Every number comes from `outlook()` (lib/outlook.ts, FE-021) on the weekly harmonized record in series.json; the
// sentences and the week-by-week range are in lib/outlook-view.ts. The date range above does not change it: it is
// always the latest season. FE-017: the season timing section (SeasonTiming) follows, drawn from the same outlook.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { DownloadPicture } from "@/components/DownloadPicture";
import { SeasonTiming } from "@/components/SeasonTiming";
import { dayLabel, forwardFrom, lastCompleteYear, type Annual } from "@/lib/annual";
import { fetchSeries, REGION_LIST, type RegionId } from "@/lib/data";
import { cumAt, outlook, quantile, type Outlook, type Season } from "@/lib/outlook";
import {
  backtestIsNear,
  backtestNow,
  extremes,
  forecastPath,
  forwardWeeks,
  isStale,
  outlookText,
  rankPhrase,
  seasonWeek,
  shortDay,
  staleView,
  type RangePoint,
} from "@/lib/outlook-view";
import { composePicture, pictureName, type LegendItem } from "@/lib/picture";
import { cssVar, pageTheme, serializeChart } from "@/lib/picture-dom";
import { compact, MONTHS, weekSpan, type Weekly } from "@/lib/series";

const WK = 52;
const W = 800, H = 360, L = 55, R = 118, T = 14, B = 30;
const fmt = (v: number) => Math.round(v).toLocaleString("en-US");

type Loaded =
  | { region: RegionId; status: "ready"; weekly: Weekly; o: Outlook | null }
  | { region: RegionId; status: "failed"; message: string };

export function SeasonOutlook({ data, regionId, region }: { data: Annual; regionId: RegionId; region: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const baseline: [number, number] = [data.years[0], lastCompleteYear(data)];
  const [b0, b1] = baseline;

  useEffect(() => {
    const ac = new AbortController();
    fetchSeries(regionId, ac.signal).then(
      (r) => {
        if (r.status === "ready" && r.bundle.weekly) {
          const w = r.bundle.weekly;
          setLoaded({ region: regionId, status: "ready", weekly: w, o: outlook(w, r.bundle.calendar?.baseline_years ?? [b0, b1]) });
        } else
          setLoaded({
            region: regionId,
            status: "failed",
            message: r.status === "error" ? r.message : "The weekly data for this region is not published yet.",
          });
      },
      () => {
        if (!ac.signal.aborted) setLoaded({ region: regionId, status: "failed", message: "Network error while loading the weekly data." });
      },
    );
    return () => ac.abort();
  }, [regionId, b0, b1]);

  const cur = loaded?.region === regionId ? loaded : null;

  return (
    <>
      <section aria-labelledby="outlook-heading" className="flex flex-col gap-6 panel p-4 sm:p-6">
        <div className="flex max-w-[70ch] flex-col gap-2">
          <h2 id="outlook-heading" className="text-2xl font-semibold tracking-tight">
            This fire season so far
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Each line is one fire season&apos;s running total in {region} (harmonized record, starting in the quietest week, so
            a season across New Year stays whole); always the latest season, whatever the dates above.
          </p>
        </div>
        {cur == null ? (
          <div className="aspect-[800/360] w-full animate-pulse rounded-lg bg-muted motion-reduce:animate-none" role="status" aria-label="Loading the season outlook" />
        ) : cur.status === "failed" || !cur.o ? (
          <p className="text-sm text-muted-foreground" role="status">
            Season outlook not available: {cur.status === "failed" ? cur.message : "no complete past season to compare with."}
          </p>
        ) : (
          <OutlookChart o={cur.o} weekly={cur.weekly} data={data} regionId={regionId} region={region} />
        )}
      </section>
      {/* FE-017: 10% / 50% / 90% dates of every whole season, on the same seasons */}
      {cur?.status === "ready" && cur.o && <SeasonTiming o={cur.o} regionId={regionId} region={region} />}
    </>
  );
}

function OutlookChart({ o, weekly, data, regionId, region }: { o: Outlook; weekly: Weekly; data: Annual; regionId: RegionId; region: string }) {
  const [hoverAt, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // a region with no data this year (country tier) shows its last complete season instead of the running one
  const siteThrough = REGION_LIST.reduce((m, r) => (r.data_through > m ? r.data_through : m), "");
  const stale = isStale(o.through, siteThrough);
  const text = outlookText(o, stale);
  const sv = stale ? staleView(o) : null;
  const focus: Season = sv ? sv.focus : o.current;
  const complete = sv ? sv.seasons : o.past; // every complete season drawn
  const others = complete.filter((s) => s !== focus);
  const path: RangePoint[] = stale ? [] : forecastPath(o);
  const { quietest, busiest } = extremes(complete);
  const fwd = stale ? [] : forwardWeeks(weekly, o.startWeek, focus);
  const bt = stale ? null : backtestNow(o);
  // x of the focus season's last point: a partial last week sits at its fraction
  const focusEnd = stale || o.current.complete ? focus.cum.length : o.weeks + o.frac;
  const start = focus.start;

  const max = Math.max(1, ...o.past.map((s) => s.cum[WK - 1]), focus.cum.at(-1) ?? 0, ...path.map((p) => p.hi)) * 1.05;
  const x = (k: number) => L + (k / WK) * (W - L - R);
  const y = (v: number) => H - B - (v * (H - T - B)) / max;

  // date of season week k (0-based) and of its end, from the calendar weeks (week 51 is 8 or 9 days)
  const span = (k: number) => {
    const c = o.startWeek + k;
    return weekSpan(focus.year + Math.floor(c / WK), c % WK);
  };
  // month ticks: x of the 1st of each month inside the season
  const ticks: { x: number; label: string }[] = [];
  for (let k = 0; k < WK; k++) {
    const s = span(k), d0 = Date.parse(`${s.start}T00:00:00Z`);
    for (let d = 0; d < s.length; d++) {
      const day = new Date(d0 + d * 86_400_000);
      if (day.getUTCDate() === 1) ticks.push({ x: x(k + d / s.length), label: MONTHS[day.getUTCMonth()] });
    }
  }
  const step = tickStep(max / 1.05);
  const yTicks: number[] = [];
  for (let v = 0; v <= max; v += step) yTicks.push(v);

  const line = (s: Season, end = s.cum.length) => {
    const pts = [`${x(0)} ${y(0)}`];
    const whole = Math.min(s.cum.length, Math.floor(end));
    for (let k = 1; k <= whole; k++) pts.push(`${x(k)} ${y(s.cum[k - 1])}`);
    if (end > whole && s.cum.length > whole) pts.push(`${x(end)} ${y(s.cum[whole])}`);
    return "M" + pts.join("L");
  };
  const band = path.length
    ? "M" + [...path.map((p) => `${x(p.x)} ${y(p.hi)}`), ...[...path].reverse().map((p) => `${x(p.x)} ${y(p.lo)}`)].join("L") + "Z"
    : "";
  const median = path.length ? "M" + path.map((p) => `${x(p.x)} ${y(p.median)}`).join("L") : "";

  // labels at the right edge, pushed apart so they don't overlap
  const nowVal = focus.cum.at(-1) ?? 0;
  const labels = spread(
    [
      { key: "busiest", y: y(busiest.cum[WK - 1]), text: `${busiest.label} busiest`, cls: "fill-muted-foreground" },
      { key: "quietest", y: y(quietest.cum[WK - 1]), text: `${quietest.label} quietest`, cls: "fill-muted-foreground" },
      ...(path.length ? [{ key: "range", y: y(path.at(-1)!.median), text: "forecast range", cls: "fill-primary" }] : []),
      ...(focus.complete || stale
        ? [{ key: "focus", y: y(nowVal), text: focus.label, cls: "fill-primary font-semibold" }]
        : []),
    ].filter((l, i, a) => a.findIndex((m) => m.text === l.text) === i),
    T + 6,
    H - B - 2,
  );

  // keyboard / hover readout over the 52 weeks of the season (1-based: after week k)
  const hover = hoverAt != null && hoverAt >= 1 && hoverAt <= WK ? hoverAt : null;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight") setHover(Math.min(WK, (hover ?? 0) + 1));
    else if (e.key === "ArrowLeft") setHover(Math.max(1, (hover ?? WK + 1) - 1));
    else if (e.key === "Escape") setHover(null);
    else return;
    e.preventDefault();
  };
  const readout = hover == null ? null : readoutRows(hover);
  function readoutRows(k: number): [string, string][] {
    const rows: [string, string][] = [];
    const isPartialWeek = !stale && !focus.complete && k === focus.cum.length && o.frac > 0;
    if (k <= focus.cum.length)
      rows.push([
        `${focus.label}${isPartialWeek ? ` to ${shortDay(o.through)}` : ""}${fwd.includes(k - 1) ? " (forward link)" : ""}`,
        fmt(focus.cum[k - 1]),
      ]);
    const atK = others.map((s) => s.cum[k - 1]);
    if (atK.length) {
      rows.push(["Typical past season", fmt(quantile(atK, 0.5))]);
      rows.push(["Past range", `${compact(Math.min(...atK))} - ${compact(Math.max(...atK))}`]);
    }
    const p = path.find((q) => q.x === k);
    if (p && k > focusEnd) rows.push(["Forecast 5-95%", `${compact(p.lo)} - ${compact(p.hi)}`]);
    return rows;
  }
  const hoverSpan = hover == null ? null : span(hover - 1);
  const hoverPartial = !stale && !focus.complete && o.frac > 0 && hover === focus.cum.length;

  const legend: LegendItem[] = [
    { color: "var(--muted-foreground)", label: `Past seasons (${others.length})` },
    { color: "var(--primary)", label: stale ? `${focus.label}, last complete season` : `${focus.label}, this season` },
    ...(path.length ? [{ color: "var(--primary)", label: "Forecast, middle and 5-95% range", kind: "dash" as const }] : []),
    ...(fwd.length ? [{ color: "var(--primary)", label: "Weeks with NOAA-20/21 forward-link days", kind: "swatch" as const }] : []),
  ];

  const fwdNote =
    fwd.length && data.forward_through
      ? `The total so far includes ${fwd.length} week${fwd.length > 1 ? "s" : ""} on the NOAA-20/21 forward link (bar along the bottom): Suomi NPP data end ${dayLabel(data.data_through)}, and from ${forwardFrom(data)} the counts are S-NPP equivalents from NOAA-20 and NOAA-21.`
      : "";
  const allText = [text.headline, text.forecast, text.honest, fwdNote].filter(Boolean).join(" ");

  const makePicture = () => {
    if (!svgRef.current) return null;
    const theme = pageTheme();
    const color = (c: string) => (c.startsWith("var(") ? cssVar(c.slice(4, -1), theme.bg) : c);
    const chart = serializeChart(svgRef.current, theme.bg);
    return composePicture({
      title: `Fire season outlook, ${region}`,
      subtitle: `${focus.label} season from ${dayLabel(start)} against ${others.length} past seasons, data to ${dayLabel(o.through)}`,
      legend: legend.map((l) => ({ ...l, color: color(l.color) })),
      body: chart.body,
      bodyWidth: chart.width,
      bodyHeight: chart.height,
      note: allText,
      theme,
    });
  };

  const f = stale ? null : o.forecast;
  const pct = bt ? Math.round((100 * bt.covered) / bt.n) : null;
  const rankOf = sv ? sv.seasons.length : o.past.length + 1;
  const rankText = sv ? rankPhrase(sv.rank, rankOf) : rankPhrase(o.rankQuiet, rankOf);

  return (
    <div className="flex flex-col gap-5">
      <dl className="grid gap-4 sm:grid-cols-3">
        <Stat label={stale ? `${focus.label}, whole season` : `So far, ${focus.label} (to ${shortDay(o.through)})`}>
          <span className="font-mono text-3xl font-semibold tracking-tight tabular-nums">{fmt(nowVal)}</span>
          {fwd.length > 0 && <span className="text-xs text-muted-foreground">includes NOAA-20/21 forward-link weeks</span>}
        </Stat>
        <Stat label="Forecast season total, 5-95%">
          {f ? (
            <>
              <span className="font-mono text-3xl font-semibold tracking-tight tabular-nums">
                {compact(f.lo)} - {compact(f.hi)}
              </span>
              {bt && (
                <span className="text-xs text-muted-foreground">
                  held {bt.covered} of {bt.n} times in back-tests{backtestIsNear(o, bt) ? "" : ` at week ${bt.week}`} ({pct}%
                  {bt.covered / bt.n < 0.9 ? ", not 90%" : ""})
                </span>
              )}
            </>
          ) : (
            <span className="text-lg font-medium">{stale || o.reason === "season-complete" ? "No forecast" : "Too early to forecast"}</span>
          )}
        </Stat>
        <Stat label={stale ? `Rank among ${rankOf} seasons` : `Rank among ${rankOf} seasons, same date`}>
          <span className="text-lg font-medium first-letter:uppercase">{rankText}</span>
        </Stat>
      </dl>

      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
        {legend.map(({ color, label, kind }) => (
          <li key={label} className="flex items-center gap-2">
            <svg width="20" height="10" aria-hidden>
              {kind === "swatch" ? (
                <rect x="2" y="3" width="16" height="4" rx="1" fill={color} />
              ) : (
                <line
                  x1="0" x2="20" y1="5" y2="5" stroke={color}
                  strokeWidth={kind === "dash" ? 2 : label.startsWith("Past") ? 1.5 : 2.5}
                  strokeDasharray={kind === "dash" ? "5 3" : undefined}
                  opacity={label.startsWith("Past") ? 0.5 : 1}
                />
              )}
            </svg>
            {label}
          </li>
        ))}
      </ul>

      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div
          className="relative min-w-[560px] rounded-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          tabIndex={0}
          role="group"
          aria-label={`Fire season running totals, ${region}. Use the left and right arrow keys to read values week by week.`}
          onKeyDown={onKey}
          onMouseLeave={(e) => e.currentTarget !== document.activeElement && setHover(null)}
          onBlur={() => setHover(null)}
        >
          <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full text-[11px]" aria-hidden>
            {yTicks.map((v) => (
              <g key={v}>
                <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="stroke-border" />
                <text x={L - 8} y={y(v) + 4} textAnchor="end" className="fill-muted-foreground font-mono">
                  {compact(v)}
                </text>
              </g>
            ))}
            {ticks.map((t) => (
              <g key={`${t.label}-${t.x}`}>
                <line x1={t.x} x2={t.x} y1={H - B} y2={H - B + 4} className="stroke-muted-foreground/60" />
                <text x={t.x + 3} y={H - 10} className="fill-muted-foreground">
                  {t.label}
                </text>
              </g>
            ))}

            {/* past seasons: thin grey; the quietest and busiest a little stronger */}
            {others.map((s) => (
              <path
                key={s.year}
                d={line(s)}
                fill="none"
                stroke="var(--muted-foreground)"
                strokeWidth={s === quietest || s === busiest ? 1.5 : 1}
                opacity={s === quietest || s === busiest ? 0.75 : 0.3}
                className="chart-fade"
              />
            ))}

            {band && (
              <>
                <path d={band} fill="var(--primary)" opacity={0.18} className="chart-fade" />
                <path d={median} fill="none" stroke="var(--primary)" strokeWidth={2} strokeDasharray="5 4" className="chart-fade" />
              </>
            )}

            <path d={line(focus, focusEnd)} pathLength={1} fill="none" stroke="var(--primary)" strokeWidth={2.75} className="chart-draw" />
            {!stale && !focus.complete && (
              <>
                <circle cx={x(focusEnd)} cy={y(nowVal)} r={4.5} fill="var(--primary)" className="chart-fade" />
                <text
                  x={x(focusEnd) + (x(focusEnd) > W - R - 60 ? -8 : 8)}
                  y={y(nowVal) - 8}
                  textAnchor={x(focusEnd) > W - R - 60 ? "end" : "start"}
                  className="fill-primary font-semibold chart-fade"
                >
                  {`${compact(nowVal)} to ${shortDay(o.through)}`}
                </text>
              </>
            )}

            {/* forward-link weeks: a bar along the bottom, as on the calendar */}
            {fwd.map((k) => (
              <rect
                key={`fwd-${k}`}
                x={x(k) + 0.5}
                y={H - B + 2}
                width={Math.max(1, x(Math.min(k + 1, focusEnd)) - x(k) - 1)}
                height={4}
                rx={1}
                fill="var(--primary)"
              />
            ))}

            {labels.map((l) => (
              <text key={l.key} x={W - R + 8} y={l.y + 4} className={l.cls}>
                {l.text}
              </text>
            ))}

            {hover != null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="stroke-foreground/40" data-no-export />}
            {Array.from({ length: WK }, (_, k) => (
              <rect
                key={k}
                x={x(k + 0.5)}
                y={T}
                width={x(1) - x(0)}
                height={H - T - B}
                fill="transparent"
                onMouseEnter={() => setHover(k + 1)}
              />
            ))}
          </svg>

          {readout && hover != null && hoverSpan && (
            <div
              className="pointer-events-none absolute top-4 w-64 rounded-lg border bg-popover px-3 py-2.5 text-sm text-popover-foreground shadow-lg shadow-foreground/5"
              style={x(hover) / W > 0.55 ? { right: `${100 - (x(hover) / W) * 100 + 1.5}%` } : { left: `${(x(hover) / W) * 100 + 1.5}%` }}
            >
              <p className="mb-1 font-medium">
                Week {hover}{" "}
                <span className="text-muted-foreground">
                  · to {shortDay(hoverPartial ? o.through : hoverSpan.end)}
                  {hoverPartial ? " (week so far)" : ""}
                </span>
              </p>
              <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
                {readout.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="text-right font-mono whitespace-nowrap tabular-nums">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>
      </div>

      <div className="flex max-w-[75ch] flex-col gap-2 text-sm leading-relaxed" aria-live="polite">
        <p>
          {text.headline} {text.forecast}
        </p>
        {text.honest && <p className="text-muted-foreground">{text.honest}</p>}
        {fwdNote && <p className="text-muted-foreground">{fwdNote}</p>}
      </div>

      <DownloadPicture
        make={makePicture}
        name={pictureName("season", regionId, focus.label, `to-${o.through}`)}
        what="season outlook chart"
      />

      <div className="sr-only">
        <table>
          <caption>
            Running total of fire detections per season in {region}, at {stale ? "season end" : `${shortDay(o.through)} (week ${seasonWeek(o)} of the season)`} and at season end.
          </caption>
          <thead>
            <tr>
              <th scope="col">Season</th>
              <th scope="col">Starts</th>
              <th scope="col">{stale ? "Season total" : `Total by ${shortDay(o.through)}`}</th>
              <th scope="col">Season total</th>
            </tr>
          </thead>
          <tbody>
            {[...others, focus].map((s) => {
              const atNow = stale ? s.cum[WK - 1] : cumAt(s.cum, o.weeks, o.frac);
              const isFocus = s === focus;
              return (
                <tr key={s.year}>
                  <th scope="row">
                    {s.label}
                    {isFocus ? (stale ? " (last complete season)" : " (this season)") : ""}
                    {s === quietest ? ", quietest" : s === busiest ? ", busiest" : ""}
                  </th>
                  <td>{dayLabel(s.start)}</td>
                  <td>{isFocus ? `${fmt(nowVal)}${fwd.length ? " (with the NOAA-20/21 forward link)" : ""}` : fmt(atNow)}</td>
                  <td>
                    {s.complete
                      ? fmt(s.cum[WK - 1])
                      : f
                        ? `not yet known; forecast ${fmt(f.lo)} to ${fmt(f.hi)}, middle ${fmt(f.median)}`
                        : "not yet known"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-l-2 border-primary pl-4">
      <dt className="font-mono text-[11px] font-medium tracking-[0.14em] text-primary uppercase">{label}</dt>
      <dd className="flex flex-col gap-0.5">{children}</dd>
    </div>
  );
}

/** Gridline step: 1, 2 or 5 times a power of ten nearest to max / 5 (as RecordChart). */
function tickStep(max: number): number {
  const raw = Math.max(1, max) / 5, p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).reduce((best, s) => (Math.abs(s - raw) < Math.abs(best - raw) ? s : best));
}

/** Pushes labels apart vertically (13 px) inside [top, bottom], keeping their order. */
function spread<T extends { y: number }>(items: T[], top: number, bottom: number, gap = 13): T[] {
  const s = [...items].sort((a, b) => a.y - b.y).map((l) => ({ ...l }));
  for (let i = 0; i < s.length; i++) s[i].y = Math.max(s[i].y, i ? s[i - 1].y + gap : top);
  for (let i = s.length - 1; i >= 0; i--) s[i].y = Math.min(s[i].y, i < s.length - 1 ? s[i + 1].y - gap : bottom);
  return s;
}
