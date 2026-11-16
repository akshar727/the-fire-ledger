"use client";

import { ArrowSquareOutIcon, DownloadSimpleIcon } from "@phosphor-icons/react";
import { BoxFilter } from "@/components/BoxFilter";
import { Disclosure } from "@/components/Disclosure";
import { FirmsAcknowledgment } from "@/components/FirmsAcknowledgment";
import { Button } from "@/components/ui/button";
import { regionInfo } from "@/lib/data";
import { FIRMS_COUNTRY_ARCHIVE, isCountry, REGIONS } from "@/lib/regions";
import {
  boxesOverlap,
  boxLabel,
  hotspotsUrl,
  MAX_SPAN_DAYS,
  pointFileUrl,
  regionBox,
  seriesUrl,
  spanDays,
  yearsBefore,
  yearsIn,
} from "@/lib/selection";
import { useBox, useSelection } from "@/lib/use-selection";

const fmt = (v: number) => v.toLocaleString("en-US");

export function DownloadCsv() {
  const { sel, bounds } = useSelection();
  const days = spanDays(sel.from, sel.to);
  const fits = days <= MAX_SPAN_DAYS;
  const available = new Set(regionInfo(sel.region).point_years);
  const years = yearsIn(sel.from, sel.to).filter((y) => available.has(y));
  const earlier = yearsBefore(bounds, regionInfo(sel.region).point_years);
  const [urlBox, setBox] = useBox();
  const rbox = regionBox(regionInfo(sel.region).bbox);
  const country = isCountry(sel.region);
  const box = !country && urlBox && boxesOverlap(urlBox, rbox) ? urlBox : null;

  return (
    <section aria-labelledby="download-heading" className="grid gap-8 panel p-5 sm:p-6 md:grid-cols-[3fr_2fr]">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <h2 id="download-heading" className="text-xl font-semibold tracking-tight">
            Download the detections
          </h2>
          <p className="max-w-[60ch] leading-relaxed text-muted-foreground">
            {country ? "Monthly fire counts for" : "Every FIRMS hotspot in"} {REGIONS[sel.region]}
            {box && (
              <>
                {" "}
                inside <span className="text-foreground">{boxLabel(box)}</span>
              </>
            )}{" "}
            from{" "}
            <span className="font-mono text-foreground tabular-nums">{sel.from}</span> to{" "}
            <span className="font-mono text-foreground tabular-nums">{sel.to}</span> ({fmt(days)} days)
            {country
              ? ": MODIS, VIIRS and harmonized, with the 5-95% band."
              : ", raw detections; analytics are the monthly counts with their 5-95% band."}
          </p>
        </div>

        {country && (
          <p className="max-w-[60ch] text-sm leading-relaxed">
            Per-detection files are not available for a whole country here; the FIRMS country archive has them, one file per
            year and sensor.
          </p>
        )}
        {!country && urlBox && !box && (
          <p className="max-w-[60ch] text-sm leading-relaxed">
            The box in this link ({boxLabel(urlBox)}) is outside {REGIONS[sel.region]}, so the CSV covers the whole
            region.
          </p>
        )}
        {box && (
          <p className="max-w-[60ch] text-sm leading-relaxed text-muted-foreground">
            The box narrows only the CSV. The chart, calendar, analytics and whole-year files still cover all of{" "}
            {REGIONS[sel.region]}.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          {country ? (
            <Button asChild size="lg" className="px-4">
              <a href={FIRMS_COUNTRY_ARCHIVE} target="_blank" rel="noreferrer">
                <ArrowSquareOutIcon aria-hidden />
                FIRMS country archive
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </Button>
          ) : fits ? (
            <Button asChild size="lg" className="px-4">
              <a href={hotspotsUrl(sel, box)} download>
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
        {!country && !fits && (
          <p id="download-limit" className="max-w-[60ch] text-sm leading-relaxed">
            One download covers up to {MAX_SPAN_DAYS} days. Narrow the dates or pick one year above, or use the yearly
            files just below.
          </p>
        )}

        <Disclosure summary="Whole-year files and more download options" defaultOpen={!!urlBox}>
          <div className="flex flex-col gap-5">
            {!country && (
              <p className="max-w-[60ch] text-sm leading-relaxed text-muted-foreground">
                Each CSV row: date, time (UTC), latitude, longitude, satellite, confidence, fire radiative power and day
                or night.
              </p>
            )}
            {!country && <BoxFilter box={box} region={rbox} regionName={REGIONS[sel.region]} onApply={setBox} />}
            <p className="max-w-[60ch] text-sm leading-relaxed text-muted-foreground">
              Analytics: monthly MODIS, VIIRS and harmonized counts with the 5-95% band for the same months, and where each
              value comes from ({country ? "back-cast or observed" : "back-cast, observed, or forward link from NOAA-20/21"}),
              with the last month marked if it is still running (also as{" "}
              <a className="underline underline-offset-2 hover:text-foreground" href={`/data/${sel.region}/series.json`}>
                JSON
              </a>
              ).
            </p>
            <p className="max-w-[60ch] text-sm leading-relaxed text-muted-foreground">
              Pictures: &quot;Download picture&quot; under the ledger chart and the calendar saves what is on screen as PNG
              or SVG, with title, legend and the FIRMS acknowledgment.
            </p>

            {years.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">
                  Whole-year files{box && <span className="font-normal text-muted-foreground"> (whole region)</span>}
                </p>
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
                Before the ledger starts:{" "}
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
        </Disclosure>
      </div>

      <div className="flex flex-col gap-2 border-t pt-6 text-xs text-muted-foreground md:border-t-0 md:border-l md:pt-0 md:pl-6">
        <p className="font-medium text-foreground">Data source</p>
        <FirmsAcknowledgment className="leading-relaxed" />
      </div>
    </section>
  );
}
