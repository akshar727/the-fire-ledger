"use client";

// One Fire Record view for the selected region and dates (?region=&from=&to=): hero stat, the record chart and its trend (FE-014), hold-out
// scores and downloads. All three regions' annual.json are bundled (about 5 KB each), so switching needs no fetch.
import { DateRange } from "@/components/DateRange";
import { DownloadCsv } from "@/components/DownloadCsv";
import { HoldoutStats } from "@/components/HoldoutStats";
import { RecordChart } from "@/components/RecordChart";
import { RegionSwitcher } from "@/components/RegionSwitcher";
import { SeasonOutlook } from "@/components/SeasonOutlook";
import { TrendSummary } from "@/components/TrendSummary";
import { eraMeans, HOLD_FROM, holdoutYears, lastCompleteYear, VIIRS_FROM } from "@/lib/annual";
import { loadAnnual } from "@/lib/data";
import { FIRE_SEASON, REGION_CAVEAT, REGIONS } from "@/lib/regions";
import { useSelection } from "@/lib/use-selection";

export function JumpStat() {
  const { sel } = useSelection();
  const data = loadAnnual(sel.region);
  return (
    <div className="flex flex-col gap-1 border-l-2 border-primary pl-5 md:col-span-4 md:justify-self-end">
      <span className="text-xs font-medium tracking-[0.16em] text-primary uppercase">
        {REGIONS[sel.region]}, {data.years[0]}-{lastCompleteYear(data)}
      </span>
      <span className="font-mono text-5xl font-semibold tracking-tight tabular-nums">×{eraMeans(data).jump.toFixed(1)}</span>
      <span className="max-w-[28ch] text-sm leading-relaxed text-muted-foreground">
        apparent rise in yearly detections when VIIRS replaces MODIS in {VIIRS_FROM}
      </span>
    </div>
  );
}

export function RecordExplorer() {
  const { sel } = useSelection();
  const data = loadAnnual(sel.region);
  const years: [number, number] = [Number(sel.from.slice(0, 4)), Number(sel.to.slice(0, 4))];
  const [h0, h1] = holdoutYears(data);

  return (
    <>
      <section aria-labelledby="record-heading" className="flex flex-col gap-6 rounded-xl border bg-card p-4 sm:p-6">
        <h2 id="record-heading" className="sr-only">
          Annual active-fire detections
        </h2>
        <div className="flex flex-col gap-4 border-b pb-6">
          <RegionSwitcher />
          <p className="max-w-[65ch] text-sm leading-relaxed text-muted-foreground">
            {FIRE_SEASON[sel.region]}
            {REGION_CAVEAT[sel.region] && ` ${REGION_CAVEAT[sel.region]}`}
          </p>
          <DateRange />
          <p className="text-xs text-muted-foreground">The chart shows whole years; downloads use the exact dates.</p>
        </div>
        <RecordChart data={data} region={REGIONS[sel.region]} regionId={sel.region} years={years} />
        <TrendSummary data={data} regionId={sel.region} years={years} />
      </section>

      {/* FE-022: this season against every past season, with the forecast range (lib/outlook.ts) */}
      <SeasonOutlook data={data} regionId={sel.region} region={REGIONS[sel.region]} />

      <section aria-labelledby="holdout-heading" className="flex flex-col gap-6">
        <div className="flex max-w-[65ch] flex-col gap-2">
          <h2 id="holdout-heading" className="text-2xl font-semibold tracking-tight">
            Tested on years it never saw
          </h2>
          <p className="leading-relaxed text-muted-foreground">
            The model learned from {VIIRS_FROM}-{HOLD_FROM - 1}, when both sensors flew. We then predicted {h0}-{h1} from
            MODIS alone and checked against what VIIRS saw in {REGIONS[sel.region]}.
          </p>
        </div>
        <HoldoutStats score={data.score} years={[h0, h1]} />
      </section>

      <DownloadCsv />
    </>
  );
}

export function RecordSkeleton() {
  return (
    <div className="flex flex-col gap-6 rounded-xl border bg-card p-4 sm:p-6" role="status" aria-busy="true" aria-label="Loading the record">
      <div className="h-9 w-80 max-w-full animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
      <div className="h-14 w-full max-w-xl animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
      <div className="aspect-[800/380] w-full animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
    </div>
  );
}
