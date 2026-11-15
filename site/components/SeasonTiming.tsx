"use client";

// FE-017: season timing on /record, under the season outlook. For every whole fire season, the days on which its
// running total reached 10%, 50% and 90% of that season's fire, and one sentence on whether onset is drifting. The
// maths is `seasonTiming` / `timingSentence` in lib/series.ts, on the seasons `outlook()` (lib/outlook.ts) already
// split from the weekly harmonized record, so the season start (the quietest week) is the same as the chart above.
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Disclosure } from "@/components/Disclosure";
import { DownloadPicture } from "@/components/DownloadPicture";
import { dayLabel, VIIRS_FROM } from "@/lib/annual";
import type { RegionId } from "@/lib/data";
import type { Outlook } from "@/lib/outlook";
import { shortDay } from "@/lib/outlook-view";
import { composePicture, pictureName, type LegendItem } from "@/lib/picture";
import { cssVar, pageTheme, serializeChart } from "@/lib/picture-dom";
import { MONTHS, seasonTiming, timingSentence, type SeasonTiming as Row } from "@/lib/series";

const W = 800, L = 64, R = 16, T = 8, B = 28, ROW = 12;
const DAY_MS = 86_400_000;
const fmt = (v: number) => Math.round(v).toLocaleString("en-US");

export function SeasonTiming({ o, regionId, region }: { o: Outlook; regionId: RegionId; region: string }) {
  const rows = useMemo(() => seasonTiming(o.past, o.startWeek), [o]);
  const [active, setActive] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  if (rows.length === 0) return null;

  const sentence = timingSentence(rows, region);
  const caveat = `Where a region burns in two separate peaks, the halfway and 90% points can jump from one peak to the other when the balance between them changes. Seasons before ${VIIRS_FROM} come from the MODIS back-cast, so their timing follows how MODIS saw each week.`;
  const H = T + rows.length * ROW + B;
  const x = (d: number) => L + (d / 366) * (W - L - R);
  const y = (i: number) => T + i * ROW + ROW / 2;

  // month ticks: day of the season of each 1st of the month, from the first season (every season starts in the same week)
  const t0 = Date.parse(`${rows[0].start}T00:00:00Z`);
  const ticks: { x: number; label: string }[] = [];
  for (let d = 0; d < 366; d++) {
    const day = new Date(t0 + d * DAY_MS);
    if (day.getUTCDate() === 1) ticks.push({ x: x(d), label: MONTHS[day.getUTCMonth()] });
  }

  const legend: LegendItem[] = [
    { color: "var(--muted-foreground)", label: "10% to 90% of the season's fire", kind: "line" },
    { color: "var(--primary)", label: "Halfway (50%)", kind: "swatch" },
  ];
  const readout = (r: Row) =>
    `${r.label} season: 10% by ${shortDay(r.dates[0])}, halfway by ${shortDay(r.dates[1])}, 90% by ${shortDay(r.dates[2])} (${fmt(r.total)} detections)`;
  const cur = active == null ? null : rows[active];

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowRight") setActive((a) => (a == null ? 0 : Math.min(rows.length - 1, a + 1)));
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") setActive((a) => (a == null ? rows.length - 1 : Math.max(0, a - 1)));
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(rows.length - 1);
    else if (e.key === "Escape") setActive(null);
    else return;
    e.preventDefault();
  };

  const makePicture = () => {
    if (!svgRef.current) return null;
    const theme = pageTheme();
    const color = (c: string) => (c.startsWith("var(") ? cssVar(c.slice(4, -1), theme.bg) : c);
    const chart = serializeChart(svgRef.current, theme.bg);
    return composePicture({
      title: `Fire season timing, ${region}`,
      subtitle: `Days on which each season reached 10%, 50% and 90% of its fire, ${rows[0].label} to ${rows.at(-1)!.label}`,
      legend: legend.map((l) => ({ ...l, color: color(l.color) })),
      body: chart.body,
      bodyWidth: chart.width,
      bodyHeight: chart.height,
      note: `${sentence} ${caveat}`,
      theme,
    });
  };

  return (
    <section aria-labelledby="timing-heading" className="flex flex-col gap-5 panel p-4 sm:p-6">
      <div className="flex max-w-[70ch] flex-col gap-2">
        <h2 id="timing-heading" className="text-2xl font-semibold tracking-tight">
          When each season burns
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          The days on which each whole season reached 10%, 50% and 90% of its fire. Seasons start in the quietest week, as
          above; the running season is left out.
        </p>
      </div>

      <p className="max-w-[75ch] text-sm leading-relaxed">
        {sentence}
      </p>

      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground" aria-hidden>
        {legend.map(({ color, label, kind }) => (
          <li key={label} className="flex items-center gap-1.5">
            <svg width="20" height="10" aria-hidden>
              {kind === "swatch" ? <circle cx="10" cy="5" r="3.5" fill={color} /> : <line x1="0" x2="20" y1="5" y2="5" stroke={color} strokeWidth={2} />}
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
          aria-label={`Fire season timing, ${region}. Use the up and down arrow keys to read one season at a time.`}
          onKeyDown={onKey}
          onMouseLeave={(e) => e.currentTarget !== document.activeElement && setActive(null)}
          onBlur={() => setActive(null)}
        >
          <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full text-[10px]" aria-hidden>
            {ticks.map((t) => (
              <g key={`${t.label}-${t.x}`}>
                <line x1={t.x} x2={t.x} y1={T} y2={H - B} className="stroke-border" />
                <text x={t.x + 3} y={H - 10} className="fill-muted-foreground">
                  {t.label}
                </text>
              </g>
            ))}
            {rows.map((r, i) => (
              <g key={r.year} opacity={active == null || active === i ? 1 : 0.35}>
                {/* every other season, counted from the latest, so the newest row is always labelled */}
                {(rows.length - 1 - i) % 2 === 0 && (
                  <text x={L - 8} y={y(i) + 3.5} textAnchor="end" className="fill-muted-foreground font-mono">
                    {r.label}
                  </text>
                )}
                <line x1={x(r.days[0])} x2={x(r.days[2] + 1)} y1={y(i)} y2={y(i)} stroke="var(--muted-foreground)" strokeWidth={2} strokeLinecap="round" />
                <circle cx={x(r.days[1] + 0.5)} cy={y(i)} r={3.5} fill="var(--primary)" />
                {/* hit area for the whole row */}
                <rect x={L} y={y(i) - ROW / 2} width={W - L - R} height={ROW} fill="transparent" onMouseEnter={() => setActive(i)} />
              </g>
            ))}
          </svg>
        </div>
      </div>
      <p className="min-h-[1.25rem] text-sm text-muted-foreground" aria-live="polite">
        {cur ? readout(cur) : "Point at a season, or focus the chart and use the arrow keys, to read its dates."}
      </p>

      <p className="max-w-[75ch] text-xs leading-relaxed text-muted-foreground">
        {caveat}
      </p>

      <DownloadPicture make={makePicture} name={pictureName("season-timing", regionId, rows[0].label, rows.at(-1)!.label)} what="season timing chart" />

      <Disclosure summary="Every season's dates">
        <div className="overflow-x-auto">
          <table className="w-full max-w-2xl text-sm">
            <caption className="sr-only">Days on which each fire season in {region} reached 10%, 50% and 90% of its detections</caption>
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th scope="col" className="py-1.5 pr-4 font-medium">Season</th>
                <th scope="col" className="py-1.5 pr-4 font-medium">Starts</th>
                <th scope="col" className="py-1.5 pr-4 font-medium">10%</th>
                <th scope="col" className="py-1.5 pr-4 font-medium">50%</th>
                <th scope="col" className="py-1.5 pr-4 font-medium">90%</th>
                <th scope="col" className="py-1.5 text-right font-medium">Detections</th>
              </tr>
            </thead>
            <tbody className="font-mono tabular-nums">
              {rows.map((r) => (
                <tr key={r.year} className="border-b border-border/50">
                  <th scope="row" className="py-1 pr-4 text-left font-normal">{r.label}</th>
                  <td className="py-1 pr-4">{dayLabel(r.start)}</td>
                  {r.dates.map((d, k) => (
                    <td key={k} className="py-1 pr-4">{dayLabel(d)}</td>
                  ))}
                  <td className="py-1 text-right">{fmt(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Disclosure>
    </section>
  );
}
