"use client";

// Burn calendar with the shared selection controls. Region, dates and the Month / Week view live in the URL
// (?region=&from=&to=&view=, FE-001 decision; view FE-016) so a demo link can open straight on one view.
// FE-025: region and dates share one row, so the calendar starts on a laptop's first screen.
import { BurnCalendar } from "@/components/BurnCalendar";
import { DateRange } from "@/components/DateRange";
import { DownloadCsv } from "@/components/DownloadCsv";
import { RegionSwitcher } from "@/components/RegionSwitcher";
import { FIRE_SEASON, REGION_CAVEAT } from "@/lib/regions";
import { useCalendarView, useSelection } from "@/lib/use-selection";

export function CalendarExplorer() {
  const { sel } = useSelection();
  const [view, setView] = useCalendarView(); // ?view=week (FE-016)
  const region = sel.region;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <RegionSwitcher className="w-full sm:w-72" />
          <DateRange />
        </div>
        <p className="max-w-[90ch] text-sm leading-relaxed text-muted-foreground">
          {FIRE_SEASON[region]}
          {REGION_CAVEAT[region] && ` ${REGION_CAVEAT[region]}`}
        </p>
      </div>
      <BurnCalendar region={region} from={sel.from} to={sel.to} view={view} onView={setView} />
      <DownloadCsv />
    </div>
  );
}
