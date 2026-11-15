"use client";

// Region picker for every data view. Options come from index.json (the DP-003 region list) in its order; the labels are
// the short display names in lib/regions.ts.
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { REGION_LIST } from "@/lib/data";
import { isRegionId, REGIONS } from "@/lib/regions";
import { useSelection } from "@/lib/use-selection";

/** `vertical` (FE-025): one button per row, full width, for the Record page's control column. */
export function RegionSwitcher({ orientation = "horizontal" }: { orientation?: "horizontal" | "vertical" }) {
  const { sel, update } = useSelection();
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      spacing={0}
      orientation={orientation}
      value={sel.region}
      onValueChange={(v) => isRegionId(v) && v !== sel.region && update({ region: v })}
      aria-label="Region"
      className={orientation === "vertical" ? "w-full" : "flex-wrap"}
    >
      {REGION_LIST.map(({ id }) => (
        <ToggleGroupItem
          key={id}
          value={id}
          // vertical: full-width rows in a narrow column, so long names ("NW India (Punjab, Haryana)") wrap inside the box
          className={`${orientation === "vertical" ? "h-auto min-h-9 py-2 text-center leading-snug whitespace-normal" : "h-9"} px-4 data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground active:scale-[0.98]`}
        >
          {REGIONS[id]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
