"use client";

// Burn calendar: year x month heatmap of harmonized monthly detections from series.json (Series bundle contract),
// with per-month median / spread and anomaly marks when the ML-005 `calendar` section is present.
// FE-015: "Download picture" saves the visible rows as PNG or SVG (lib/picture.ts calendarBody).
import Link from "next/link";
import { useCallback, useEffect, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { ArrowRightIcon, CalendarBlankIcon, CaretDownIcon, CaretUpIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DownloadPicture } from "@/components/DownloadPicture";
import { fetchSeries, type RegionId, type SeriesResult } from "@/lib/data";
import { calendarBody, composePicture, pictureName, type LegendItem } from "@/lib/picture";
import { pageTheme, solidColor } from "@/lib/picture-dom";
import { REGIONS } from "@/lib/regions";
import {
  buildGrid,
  compact,
  MONTHS,
  MONTHS_LONG,
  rampColor,
  rampPosition,
  sliceGrid,
  times,
  type CalendarCell,
  type CalendarGrid,
  type CalendarStats,
} from "@/lib/series";

type Mode = "light" | "dark";
const darkQuery = "(prefers-color-scheme: dark)";
const subscribe = (cb: () => void) => {
  const mq = window.matchMedia(darkQuery);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
function useColorMode(): Mode {
  return useSyncExternalStore(
    subscribe,
    () => (window.matchMedia(darkQuery).matches ? "dark" : "light"),
    () => "dark",
  );
}

const fmt = (v: number) => Math.round(v).toLocaleString("en-US");

export function BurnCalendar({ region, from, to }: { region: RegionId; from: string; to: string }) {
  // results are tagged with the request they answer, so switching region or retrying shows the skeleton, never the
  // previous region's grid
  const [loaded, setLoaded] = useState<{ key: string; result: SeriesResult } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = `${region}:${attempt}`;

  useEffect(() => {
    const ac = new AbortController();
    fetchSeries(region, ac.signal).then((result) => setLoaded({ key, result }), () => {});
    return () => ac.abort();
  }, [region, key]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  const result = loaded?.key === key ? loaded.result : null;
  if (result == null) return <CalendarSkeleton />;
  if (result.status === "missing") return <NotPublished />;
  if (result.status === "error") return <LoadError message={result.message} onRetry={retry} />;
  // keyed by the selection so focus and readout reset when the visible rows change
  return (
    <CalendarView
      key={`${region}:${from}:${to}`}
      grid={sliceGrid(buildGrid(result.bundle), from, to)}
      stats={result.bundle.calendar}
      label={{ region, from, to }}
    />
  );
}

type Label = { region: RegionId; from: string; to: string };

function CalendarView({ grid, stats, label }: { grid: CalendarGrid; stats?: CalendarStats; label: Label }) {
  const mode = useColorMode();
  const [active, setActive] = useState<CalendarCell | null>(null);
  const [focus, setFocus] = useState<[number, number]>([grid.rows.length - 1, 0]);
  const [announce, setAnnounce] = useState(""); // screen readers hear keyboard moves only, not every mouse hover
  const color = (v: number) => rampColor(rampPosition(v, grid.max), mode);
  const latest = grid.latest;

  const makePicture = () => {
    const theme = pageTheme();
    const cell = (v: number) => {
      const c = color(v);
      return { bg: solidColor(c.bg, theme.bg), ink: c.ink };
    };
    const body = calendarBody(grid, stats, { cell, theme });
    const legend: LegendItem[] = [
      { color: cell(0).bg, label: "few", kind: "swatch" },
      { color: cell(grid.max).bg, label: `many (${compact(grid.max)} max), log scale`, kind: "swatch" },
      ...(stats
        ? [
            { color: theme.fg, label: "unusually high month", kind: "up" as const },
            { color: theme.fg, label: "unusually low month", kind: "down" as const },
          ]
        : []),
      { color: theme.muted, label: "no data yet", kind: "swatch" },
    ];
    const first = grid.firstObserved;
    return composePicture({
      title: `Burn calendar, ${REGIONS[label.region]}`,
      subtitle: `Harmonized fire detections per month (VIIRS scale), ${label.from} to ${label.to}`,
      legend,
      body: body.body,
      bodyWidth: body.width,
      bodyHeight: body.height,
      note: [
        first && `Before ${monthName(first)}: model back-cast from MODIS. From ${monthName(first)}: VIIRS observed.`,
        stats && `Median and middle half over ${stats.baseline_years[0]}-${stats.baseline_years[1]}.`,
        grid.rows.some((r) => r.some((c) => !c.inRange && c.value != null)) && "Faded months are outside the selected dates.",
      ]
        .filter(Boolean)
        .join(" "),
      theme,
    });
  };

  const onKey = (e: KeyboardEvent<HTMLTableElement>) => {
    const [r, c] = focus;
    const next: Record<string, [number, number]> = {
      ArrowUp: [Math.max(0, r - 1), c],
      ArrowDown: [Math.min(grid.rows.length - 1, r + 1), c],
      ArrowLeft: [r, Math.max(0, c - 1)],
      ArrowRight: [r, Math.min(11, c + 1)],
      Home: [r, 0],
      End: [r, 11],
    };
    const to = next[e.key];
    if (!to) return;
    e.preventDefault();
    setFocus(to);
    setActive(grid.rows[to[0]][to[1]]);
    e.currentTarget.querySelector<HTMLElement>(`[data-cell="${to[0]}-${to[1]}"]`)?.focus();
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] md:items-end">
        {latest && <LatestCard cell={latest} stats={stats} />}
        <Legend max={grid.max} mode={mode} hasFlags={!!stats} firstObserved={grid.firstObserved} />
      </div>

      <section aria-labelledby="calendar-heading" className="rounded-xl border bg-card p-4 sm:p-6">
        <h2 id="calendar-heading" className="sr-only">
          Harmonized detections by year and month
        </h2>
        <p className="sticky top-16 z-10 -mx-1 mb-3 min-h-6 bg-card/95 px-1 py-2 text-sm text-muted-foreground backdrop-blur" aria-hidden>
          {active ? describe(active, stats) : "Hover a month, or focus the table and use the arrow keys, to read its value."}
        </p>
        <p className="sr-only" aria-live="polite">
          {announce}
        </p>
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <table
            className="w-full min-w-[720px] border-separate border-spacing-[3px] font-mono text-xs tabular-nums"
            onKeyDown={onKey}
            onMouseLeave={() => setActive(null)}
          >
            <caption className="sr-only">
              Harmonized monthly fire detections. Values are VIIRS observations from{" "}
              {grid.firstObserved ? monthName(grid.firstObserved) : "2012"} and model back-casts before.
            </caption>
            <thead>
              <tr>
                <th scope="col" className="w-20 text-left font-sans font-normal text-muted-foreground">
                  <span className="sr-only">Year</span>
                </th>
                {MONTHS.map((m) => (
                  <th key={m} scope="col" className="pb-1 font-sans font-normal text-muted-foreground">
                    {m}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.rows.map((row, r) => (
                <tr key={grid.years[r]}>
                  <th scope="row" className="pr-2 text-left font-normal whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5">
                      {grid.years[r]}
                      {grid.partialYears.includes(grid.years[r]) && (
                        <Badge variant="outline" className="h-4 px-1.5 font-sans text-[10px]">
                          partial
                        </Badge>
                      )}
                    </span>
                  </th>
                  {row.map((cell, c) => {
                    const isFocus = focus[0] === r && focus[1] === c;
                    if (cell.value == null)
                      return (
                        <td
                          key={c}
                          data-cell={`${r}-${c}`}
                          tabIndex={isFocus ? 0 : -1}
                          onMouseEnter={() => setActive(cell)}
                          onFocus={() => {
                            setFocus([r, c]);
                            setActive(cell);
                            setAnnounce(describe(cell, stats));
                          }}
                          className={`h-8 rounded-sm bg-[repeating-linear-gradient(135deg,var(--muted)_0_4px,transparent_4px_8px)] outline-none focus-visible:ring-2 focus-visible:ring-ring ${cell.inRange ? "" : "opacity-35 focus-visible:opacity-100"}`}
                        >
                          <span className="sr-only">no data</span>
                        </td>
                      );
                    const { bg, ink } = color(cell.value);
                    return (
                      <td
                        key={c}
                        data-cell={`${r}-${c}`}
                        tabIndex={isFocus ? 0 : -1}
                        onMouseEnter={() => setActive(cell)}
                        onFocus={() => {
                          setFocus([r, c]);
                          setActive(cell);
                          setAnnounce(describe(cell, stats));
                        }}
                        style={{ backgroundColor: bg, color: ink }}
                        className={`relative h-8 rounded-sm text-center outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card ${cell.inRange ? "" : "opacity-35 focus-visible:opacity-100"}`}
                      >
                        {compact(cell.value)}
                        {cell.flag !== 0 && <FlagMark flag={cell.flag} />}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
            {stats && (
              <tfoot>
                <tr>
                  <th scope="row" className="pt-3 pr-2 text-left font-sans font-medium">
                    Median
                  </th>
                  {stats.month_median.map((v, i) => {
                    const { bg, ink } = color(v);
                    return (
                      <td key={i} style={{ backgroundColor: bg, color: ink }} className="h-8 rounded-sm text-center font-medium">
                        {compact(v)}
                      </td>
                    );
                  })}
                </tr>
                <tr>
                  <th scope="row" className="pr-2 text-left font-sans font-normal text-muted-foreground">
                    Middle half
                  </th>
                  {stats.month_p25.map((v, i) => (
                    <td key={i} className="pt-1 text-center text-[10px] leading-tight text-muted-foreground">
                      {compact(v)}
                      <br />
                      to {compact(stats.month_p75[i])}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        {!stats && (
          <p className="mt-4 text-sm text-muted-foreground">
            Monthly medians and unusual-month marks will appear once the calendar statistics are published.
          </p>
        )}
        <div className="mt-5">
          <DownloadPicture
            make={makePicture}
            name={pictureName("calendar", label.region, label.from, label.to)}
            what="burn calendar"
          />
        </div>
      </section>
    </div>
  );
}

function FlagMark({ flag }: { flag: -1 | 1 }) {
  const Icon = flag === 1 ? CaretUpIcon : CaretDownIcon;
  return (
    <span className="absolute top-0 right-0.5" aria-hidden>
      <Icon weight="fill" className="size-2.5" />
    </span>
  );
}

function describe(cell: CalendarCell, stats?: CalendarStats): string {
  const when = `${MONTHS_LONG[cell.month - 1]} ${cell.year}${cell.inRange ? "" : " (outside the selected dates)"}`;
  if (cell.value == null) return `${when}: no data in the record yet.`;
  const src = cell.observed ? "VIIRS observed" : "model back-cast";
  let s = `${when}: ${fmt(cell.value)} harmonized detections (${src}).`;
  if (stats && cell.anomaly != null) {
    s += ` ${times(cell.anomaly)} the ${MONTHS_LONG[cell.month - 1]} median of ${fmt(stats.month_median[cell.month - 1])}`;
    s += cell.flag === 1 ? ", marked unusually high." : cell.flag === -1 ? ", marked unusually low." : ".";
  }
  return s;
}

const monthName = (cell: CalendarCell) => `${MONTHS_LONG[cell.month - 1]} ${cell.year}`;

function LatestCard({ cell, stats }: { cell: CalendarCell; stats?: CalendarStats }) {
  const name = MONTHS_LONG[cell.month - 1];
  const median = stats?.month_median[cell.month - 1];
  // Monthly arrays end at the last fully covered month, so the newest the record can be is last month. Once present-day
  // data (DP-005) reaches that, the card is "last month vs median"; until then it says it shows an older month.
  // read the clock once per mount (a state initializer keeps render pure for the React Compiler); no hydration risk,
  // since this card only renders after the client-side fetch
  const [today] = useState(() => new Date());
  const lastComplete = today.getUTCFullYear() * 12 + today.getUTCMonth() - 1;
  const isRecent = cell.year * 12 + cell.month - 1 >= lastComplete;
  const Mark = cell.flag === 1 ? CaretUpIcon : CaretDownIcon;
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-accent p-5">
      <p className="text-sm text-muted-foreground">
        {isRecent ? "Last month" : "Latest complete month in the record"}: {monthName(cell)}
      </p>
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-4xl font-semibold tracking-tight tabular-nums">{fmt(cell.value ?? 0)}</span>
        <span className="text-sm text-muted-foreground">detections</span>
      </p>
      {stats && median != null && cell.anomaly != null && (
        <div className="flex flex-col gap-1 text-sm">
          <p>
            <span className="font-mono font-semibold text-primary tabular-nums">{times(cell.anomaly)}</span> the {name}{" "}
            median ({fmt(median)}, {stats.baseline_years[0]}-{stats.baseline_years[1]})
          </p>
          {cell.flag !== 0 && (
            <p className="flex items-center gap-1 font-medium">
              <Mark weight="fill" className="size-3" aria-hidden />
              Unusually {cell.flag === 1 ? "high" : "low"} for {name}
            </p>
          )}
        </div>
      )}
      {!isRecent && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Present-day detections are not in the record yet, so this card compares the latest complete month, not this
          month.
        </p>
      )}
    </div>
  );
}

function Legend({
  max,
  mode,
  hasFlags,
  firstObserved,
}: {
  max: number;
  mode: Mode;
  hasFlags: boolean;
  firstObserved: CalendarCell | null;
}) {
  const steps = Array.from({ length: 24 }, (_, i) => rampColor(i / 23, mode).bg);
  // keep clear of the max label; with max 0 every tick would sit at 0, so show none
  const ticks = max > 0 ? [0, 10, 100, 1000, 10000].filter((v) => rampPosition(v, max) < 0.9) : [];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-4 text-sm">
        <span className="font-medium">Detections per month</span>
        <span className="text-muted-foreground">log scale</span>
      </div>
      <div className="relative">
        <div
          className="h-3 rounded-sm"
          style={{ background: `linear-gradient(to right, ${steps.join(", ")})` }}
          aria-hidden
        />
        <div className="relative mt-1 h-4 font-mono text-[11px] text-muted-foreground tabular-nums" aria-hidden>
          {ticks.map((v) => (
            <span
              key={v}
              className="absolute -translate-x-1/2 first:translate-x-0"
              style={{ left: `${rampPosition(v, max) * 100}%` }}
            >
              {compact(v)}
            </span>
          ))}
          <span className="absolute right-0">{compact(max)}</span>
        </div>
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        {hasFlags && (
          <>
            <li className="flex items-center gap-1">
              <CaretUpIcon weight="fill" className="size-3" aria-hidden /> unusually high month
            </li>
            <li className="flex items-center gap-1">
              <CaretDownIcon weight="fill" className="size-3" aria-hidden /> unusually low month
            </li>
          </>
        )}
        <li className="flex items-center gap-1.5">
          <span className="size-3 rounded-sm bg-[repeating-linear-gradient(135deg,var(--muted)_0_3px,transparent_3px_6px)] ring-1 ring-border" />
          no data yet
        </li>
        {firstObserved && (
          <li className="basis-full">
            Before {monthName(firstObserved)}: model back-cast. From {monthName(firstObserved)}: VIIRS observed.
          </li>
        )}
      </ul>
    </div>
  );
}

export function CalendarSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true" aria-label="Loading the calendar">
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="h-40 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
        <div className="h-16 animate-pulse self-end rounded-md bg-muted motion-reduce:animate-none" />
      </div>
      <div className="grid grid-cols-[5rem_repeat(12,minmax(0,1fr))] gap-[3px] rounded-xl border bg-card p-4 sm:p-6">
        {Array.from({ length: 13 * 10 }, (_, i) => (
          <div key={i} className="h-8 animate-pulse rounded-sm bg-muted motion-reduce:animate-none" />
        ))}
      </div>
    </div>
  );
}

function NotPublished() {
  return (
    <div className="flex flex-col items-start gap-4 rounded-xl border border-dashed p-8 sm:p-10">
      <CalendarBlankIcon className="size-8 text-primary" aria-hidden />
      <div className="flex max-w-[60ch] flex-col gap-2">
        <h2 className="text-xl font-semibold tracking-tight">The monthly data isn&apos;t published yet</h2>
        <p className="leading-relaxed text-muted-foreground">
          The calendar reads the harmonized monthly series from the next model export. Until it lands, the yearly
          record is on the Record page.
        </p>
      </div>
      <Button asChild>
        <Link href="/">
          View the record
          <ArrowRightIcon aria-hidden />
        </Link>
      </Button>
    </div>
  );
}

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-4 rounded-xl border border-destructive/40 p-8">
      <WarningCircleIcon className="size-8 text-destructive" aria-hidden />
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold tracking-tight">Couldn&apos;t load the calendar data</h2>
        <p className="text-muted-foreground">{message}</p>
      </div>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
