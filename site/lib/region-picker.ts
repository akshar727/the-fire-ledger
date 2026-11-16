import regionIndex from "../public/data/index.json" with { type: "json" };
import { buildRegions, type IndexEntry, type RegionId, type Tier } from "./regions.ts";

export type PickerItem = {
  id: RegionId;
  name: string;
  search: string;
  tier: Tier;
  tag: string | null;
};

export type PickerGroup = { label: string; items: PickerItem[] };

export const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export function pickerItems(index: { regions: (IndexEntry & { iso_a3?: string })[] }): PickerItem[] {
  const b = buildRegions(index);
  const row = new Map(index.regions.map((r) => [r.id, r]));
  return b.ids.map((id) => {
    const r = row.get(id)!;
    return {
      id,
      name: b.names[id],
      search: fold([b.names[id], r.name, r.iso_a3 ?? "", id].join(" ")),
      tier: b.tier[id],
      tag: b.label[id] ?? null,
    };
  });
}

const byName = (a: PickerItem, b: PickerItem) => a.name.localeCompare(b.name, "en", { sensitivity: "base" });

export function groupRegions(items: PickerItem[], query: string): PickerGroup[] {
  const q = fold(query.trim());
  const hits = q ? items.filter((it) => it.search.includes(q)) : items;
  const starts = (it: PickerItem) => (q && fold(it.name).startsWith(q) ? 0 : 1);
  const rank = (a: PickerItem, b: PickerItem) => starts(a) - starts(b);
  const groups: PickerGroup[] = [
    { label: "Deep dives", items: hits.filter((it) => it.tier === "region").sort(rank) },
    { label: "Countries", items: hits.filter((it) => it.tier === "country").sort((a, b) => rank(a, b) || byName(a, b)) },
  ];
  return groups.filter((g) => g.items.length > 0);
}

export const PICKER_ITEMS: readonly PickerItem[] = pickerItems(regionIndex as { regions: (IndexEntry & { iso_a3?: string })[] });
