"use client";

import { use } from "react";
import { DateRange } from "@/components/DateRange";
import { DownloadCsv } from "@/components/DownloadCsv";
import { HoldoutStats } from "@/components/HoldoutStats";
import { RecordChart } from "@/components/RecordChart";
import { RegionSwitcher } from "@/components/RegionSwitcher";
import { SeasonOutlook } from "@/components/SeasonOutlook";
import { TrendSummary } from "@/components/TrendSummary";
import { ValidationStrip } from "@/components/ValidationStrip";
import { eraMeans, estimateOf, HOLD_FROM, holdoutYears, isSparse, lastCompleteYear, VIIRS_FROM } from "@/lib/annual";
import { fetchAnnual } from "@/lib/data";
import { FIRE_SEASON, REGION_CAVEAT, REGIONS, SHIP_LABEL } from "@/lib/regions";
import { useSelection } from "@/lib/use-selection";

export function JumpStat() {
  const { sel } = useSelection();
  const data = use(fetchAnnual(sel.region));
  if (!data) return <div className="md:col-span-4" />;
  const label = SHIP_LABEL[sel.region];
  const era = eraMeans(data);
  const noJump = isSparse(data) || !Number.isFinite(era.jump);
  return (
    <div className="flex flex-col gap-0.5 border-l-2 border-primary pl-5 md:col-span-4 md:justify-self-end">
      <span className="kicker">
        {REGIONS[sel.region]}, {data.years[0]}-{lastCompleteYear(data)}
        {label && <span className="text-muted-foreground"> · {label}</span>}
      </span>
      <span className="font-mono text-3xl font-semibold tracking-tight tabular-nums">
        {noJump ? "–" : `×${era.jump.toFixed(1)}`}
      </span>
      <span className="max-w-[30ch] text-sm leading-snug text-muted-foreground">
        {noJump
          ? `too few detections a year to read a jump when VIIRS replaces MODIS in ${VIIRS_FROM}`
          : `apparent rise in yearly detections when VIIRS replaces MODIS in ${VIIRS_FROM}`}
      </span>
    </div>
  );
}

export function RecordExplorer() {
  const { sel } = useSelection();
  const data = use(fetchAnnual(sel.region));
  if (!data)
    return (
      <p role="alert" className="rounded-xl border bg-card p-6 leading-relaxed text-muted-foreground">
        The record for {REGIONS[sel.region]} could not be loaded. Check the connection and reload the page.
      </p>
    );
  const years: [number, number] = [Number(sel.from.slice(0, 4)), Number(sel.to.slice(0, 4))];
  const [h0, h1] = holdoutYears(data);
  const estimate = estimateOf(data);

  return (
    <>
      <section
        aria-labelledby="record-heading"
        className="grid gap-5 panel p-4 sm:p-6 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-8"
      >
        <h2 id="record-heading" className="sr-only">
          Annual active-fire detections
        </h2>
        <div className="flex flex-col gap-4 border-b pb-5 lg:border-r lg:border-b-0 lg:pr-6 lg:pb-0">
          <div className="w-full max-w-sm lg:max-w-none">
            <RegionSwitcher className="w-full" />
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {FIRE_SEASON[sel.region]}
            {REGION_CAVEAT[sel.region] && ` ${REGION_CAVEAT[sel.region]}`}
          </p>
          <DateRange />
          <p className="text-xs leading-relaxed text-muted-foreground">The chart shows whole years; downloads use the exact dates.</p>
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <RecordChart data={data} region={REGIONS[sel.region]} regionId={sel.region} years={years} />
          <TrendSummary data={data} regionId={sel.region} years={years} />
        </div>
      </section>

      <ValidationStrip data={data} />

      <SeasonOutlook data={data} regionId={sel.region} region={REGIONS[sel.region]} />

      <section aria-labelledby="holdout-heading" className="flex flex-col gap-6">
        <div className="flex max-w-[65ch] flex-col gap-2">
          <h2 id="holdout-heading" className="text-2xl font-semibold tracking-tight">
            Validated on left out data
          </h2>
          <p className="leading-relaxed text-muted-foreground">
            {estimate === "ratio"
              ? `The VIIRS/MODIS ratio was taken from ${VIIRS_FROM}-${HOLD_FROM - 1}, when both sensors flew. We then predicted ${h0}-${h1} from MODIS times that ratio and checked against what VIIRS saw in ${REGIONS[sel.region]}.`
              : `The model learned from ${VIIRS_FROM}-${HOLD_FROM - 1}, when both sensors flew. We then predicted ${h0}-${h1} from MODIS alone and checked against what VIIRS saw in ${REGIONS[sel.region]}.`}
          </p>
        </div>
        <HoldoutStats score={data.score} years={[h0, h1]} estimate={estimate} sparse={isSparse(data)} />
      </section>

      <DownloadCsv />
    </>
  );
}

export function RecordSkeleton() {
  return (
    <div className="flex flex-col gap-6 panel p-4 sm:p-6" role="status" aria-busy="true" aria-label="Loading the ledger">
      <div className="h-9 w-80 max-w-full animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
      <div className="h-14 w-full max-w-xl animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
      <div className="aspect-[800/330] w-full animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
    </div>
  );
}
