"use client";

// Region picker for every data view. Options come from index.json (the DP-003 region list) in its order; the labels are
// the short display names in lib/regions.ts.
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { REGION_LIST } from "@/lib/data";
import { isRegionId, REGIONS } from "@/lib/regions";
import { useSelection } from "@/lib/use-selection";

export function RegionSwitcher() {
  const { sel, update } = useSelection();
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      spacing={0}
      value={sel.region}
      onValueChange={(v) => isRegionId(v) && v !== sel.region && update({ region: v })}
      aria-label="Region"
      className="flex-wrap"
    >
      {REGION_LIST.map(({ id }) => (
        <ToggleGroupItem
          key={id}
          value={id}
          className="h-9 px-4 data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground active:scale-[0.98]"
        >
          {REGIONS[id]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
