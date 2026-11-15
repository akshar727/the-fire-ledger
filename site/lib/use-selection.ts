"use client";

// The selection hook every data view uses. Reads ?region=&from=&to= and writes changes back with router.replace, so
// the browser history doesn't fill up with every date edit. Callers sit inside a Suspense boundary (useSearchParams).
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { regionBounds } from "@/lib/data";
import type { RegionId } from "@/lib/regions";
import {
  parseSelection,
  parseView,
  withSelection,
  withView,
  type Bounds,
  type CalendarView,
  type Selection,
} from "@/lib/selection";

/** The burn calendar's Month / Week view from ?view= (FE-016), written back the same way as the selection. */
export function useCalendarView(): [CalendarView, (view: CalendarView) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const set = (view: CalendarView) => {
    const qs = withView(new URLSearchParams(params), view).toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  return [parseView(new URLSearchParams(params)), set];
}

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
