"use client";

import { BurnCalendar } from "@/components/BurnCalendar";
import { DateRange } from "@/components/DateRange";
import { DownloadCsv } from "@/components/DownloadCsv";
import { RegionSwitcher } from "@/components/RegionSwitcher";
import { FIRE_SEASON, REGION_CAVEAT } from "@/lib/regions";
import { useCalendarView, useSelection } from "@/lib/use-selection";

export function CalendarExplorer() {
  const { sel } = useSelection();
  const [view, setView] = useCalendarView();
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
