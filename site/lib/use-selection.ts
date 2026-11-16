"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { regionBounds } from "@/lib/data";
import type { RegionId } from "@/lib/regions";
import {
  parseBox,
  parseSelection,
  parseView,
  withBox,
  withSelection,
  withView,
  type Box,
  type Bounds,
  type CalendarView,
  type Selection,
} from "@/lib/selection";

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

export function useBox(): [Box | null, (box: Box | null) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const set = (box: Box | null) => {
    const qs = withBox(new URLSearchParams(params), box).toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  return [parseBox(new URLSearchParams(params)), set];
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
