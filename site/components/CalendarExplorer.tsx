"use client";

// Burn calendar with its region picker. The region lives in the URL (?region=, FE-001 decision) so a demo link can open
// straight on one region; other query parameters are kept for FE-004's date range.
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { BurnCalendar } from "@/components/BurnCalendar";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { FIRE_SEASON, isRegionId, REGION_CAVEAT, REGIONS, type RegionId } from "@/lib/regions";

export function CalendarExplorer() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const q = params.get("region");
  const region: RegionId = isRegionId(q) ? q : "portugal";

  const choose = (v: string) => {
    if (!isRegionId(v) || v === region) return;
    const next = new URLSearchParams(params);
    next.set("region", v);
    router.replace(`${pathname}?${next}`, { scroll: false });
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          value={region}
          onValueChange={choose}
          aria-label="Region"
          className="flex-wrap"
        >
          {(Object.keys(REGIONS) as RegionId[]).map((id) => (
            <ToggleGroupItem
              key={id}
              value={id}
              className="h-9 px-4 data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground active:scale-[0.98]"
            >
              {REGIONS[id]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="max-w-[65ch] leading-relaxed text-muted-foreground">
          {FIRE_SEASON[region]}
          {REGION_CAVEAT[region] && ` ${REGION_CAVEAT[region]}`}
        </p>
      </div>
      <BurnCalendar region={region} />
    </div>
  );
}
