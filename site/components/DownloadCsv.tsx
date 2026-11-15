"use client";

// Downloads for the current selection (BE-001): "Download CSV" links to /api/hotspots while the range fits in one
// request (MAX_SPAN_DAYS); the static per-year point files are always listed as the fallback and for longer ranges,
// plus any file from before the selectable record (2000), which no date range can reach;
// "Download analytics" links to /api/series. The FIRMS acknowledgment sits next to the buttons (nothing is added
// inside the CSV).
import { DownloadSimpleIcon } from "@phosphor-icons/react";
import { FirmsAcknowledgment } from "@/components/FirmsAcknowledgment";
import { Button } from "@/components/ui/button";
import { regionInfo } from "@/lib/data";
import { REGIONS } from "@/lib/regions";
import { hotspotsUrl, MAX_SPAN_DAYS, pointFileUrl, seriesUrl, spanDays, yearsBefore, yearsIn } from "@/lib/selection";
import { useSelection } from "@/lib/use-selection";

const fmt = (v: number) => v.toLocaleString("en-US");

export function DownloadCsv() {
  const { sel, bounds } = useSelection();
  const days = spanDays(sel.from, sel.to);
  const fits = days <= MAX_SPAN_DAYS;
  const available = new Set(regionInfo(sel.region).point_years);
  const years = yearsIn(sel.from, sel.to).filter((y) => available.has(y));
  const earlier = yearsBefore(bounds, regionInfo(sel.region).point_years);

  return (
    <section aria-labelledby="download-heading" className="grid gap-8 rounded-xl border bg-card p-5 sm:p-6 md:grid-cols-[3fr_2fr]">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <h2 id="download-heading" className="text-xl font-semibold tracking-tight">
            Download the detections
          </h2>
          <p className="max-w-[60ch] leading-relaxed text-muted-foreground">
            Every FIRMS hotspot in {REGIONS[sel.region]} from{" "}
            <span className="font-mono text-foreground tabular-nums">{sel.from}</span> to{" "}
            <span className="font-mono text-foreground tabular-nums">{sel.to}</span> ({fmt(days)} days): date, time
            (UTC), latitude, longitude, satellite, confidence, fire radiative power and day or night. Raw detections,
            not harmonized.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {fits ? (
            <Button asChild size="lg" className="px-4">
              <a href={hotspotsUrl(sel)} download>
                <DownloadSimpleIcon aria-hidden />
                Download CSV
              </a>
            </Button>
          ) : (
            <Button size="lg" className="px-4" disabled aria-describedby="download-limit">
              <DownloadSimpleIcon aria-hidden />
              Download CSV
            </Button>
          )}
          <Button asChild variant="outline" size="lg" className="px-4">
            <a href={seriesUrl(sel)} download>
              Download analytics
            </a>
          </Button>
        </div>
        {!fits && (
          <p id="download-limit" className="max-w-[60ch] text-sm leading-relaxed">
            One download covers up to {MAX_SPAN_DAYS} days. Narrow the dates or pick one year above, or use the yearly
            files below.
          </p>
        )}
        <p className="max-w-[60ch] text-sm leading-relaxed text-muted-foreground">
          Analytics: monthly MODIS, VIIRS and harmonized counts with the 5-95% band for the same months (also as{" "}
          <a className="underline underline-offset-2 hover:text-foreground" href={`/data/${sel.region}/series.json`}>
            JSON
          </a>
          ).
        </p>
        <p className="max-w-[60ch] text-sm leading-relaxed text-muted-foreground">
          Pictures: &quot;Download picture&quot; under the record chart and the calendar saves what is on screen as PNG
          or SVG, with title, legend and the FIRMS acknowledgment.
        </p>

        {years.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">Whole-year files</p>
            <ul className="flex flex-wrap gap-1.5" aria-label="Whole-year hotspot files">
              {years.map((y) => (
                <li key={y}>
                  <a
                    href={pointFileUrl(sel.region, y)}
                    download
                    className="inline-flex h-7 items-center rounded-md border px-2 font-mono text-xs tabular-nums transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    {y}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
        {earlier.length > 0 && (
          <p className="max-w-[60ch] text-sm leading-relaxed text-muted-foreground">
            Before the record starts:{" "}
            {earlier.map((y, i) => (
              <span key={y}>
                {i > 0 && ", "}
                <a
                  className="font-mono tabular-nums underline underline-offset-2 hover:text-foreground"
                  href={pointFileUrl(sel.region, y)}
                  download
                >
                  {y}
                </a>
              </span>
            ))}{" "}
            (partial year, MODIS Terra only).
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t pt-6 text-xs text-muted-foreground md:border-t-0 md:border-l md:pt-0 md:pl-6">
        <p className="font-medium text-foreground">Data source</p>
        <FirmsAcknowledgment className="leading-relaxed" />
      </div>
    </section>
  );
}
