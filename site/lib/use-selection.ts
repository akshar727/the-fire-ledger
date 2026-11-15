"use client";

// The selection hook every data view uses. Reads ?region=&from=&to= and writes changes back with router.replace, so
// the browser history doesn't fill up with every date edit. Callers sit inside a Suspense boundary (useSearchParams).
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { regionBounds } from "@/lib/data";
import type { RegionId } from "@/lib/regions";
import { parseSelection, withSelection, type Bounds, type Selection } from "@/lib/selection";

export function useSelection(): {
  sel: Selection;
  bounds: Bounds;
  update: (patch: { region?: RegionId; from?: string; to?: string }) => void;
} {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const sel = parseSelection(new URLSearchParams(params), regionBounds);
  const bounds = regionBounds(sel.region);
  const update = (patch: { region?: RegionId; from?: string; to?: string }) => {
    const next = withSelection(new URLSearchParams(params), patch, regionBounds(patch.region ?? sel.region));
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  return { sel, bounds, update };
}
