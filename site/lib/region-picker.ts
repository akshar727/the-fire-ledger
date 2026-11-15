// FE-008: what the region picker lists and how typing filters it. Pure, so `node --test` covers it without a browser.
// Two groups: "Deep dives" (the cell regions, index.json order) and "Countries" (alphabetical, with the ship label as a
// tag). A group with nothing in it is left out, so the site with only the 3 deep dives shows one group.
import regionIndex from "../public/data/index.json" with { type: "json" };
import { buildRegions, type IndexEntry, type RegionId, type Tier } from "./regions.ts";

export type PickerItem = {
  id: RegionId;
  /** What the list shows: the short display name (lib/regions.ts REGIONS). */
  name: string;
  /** Extra text typing also matches: the full name, ISO 3166 alpha-3 code and id ("NW India" also finds "punjab"). */
  search: string;
  tier: Tier;
  /** "constant-ratio estimate" or "too little fire to check" for a country, else null. */
  tag: string | null;
};

export type PickerGroup = { label: string; items: PickerItem[] };

/** Lower case, accents dropped, so "cote" finds "Côte d'Ivoire". */
export const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** One picker item per region with a record, from the same index.json rows lib/regions.ts reads. */
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

/** The groups to show for what has been typed. Empty query: everything. Otherwise items whose name, full name, ISO
 * code or id contains the text; names that start with it come first ("in" puts India before Argentina). */
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

/** The site's picker items (index.json, the same list lib/regions.ts reads). */
export const PICKER_ITEMS: readonly PickerItem[] = pickerItems(regionIndex as { regions: (IndexEntry & { iso_a3?: string })[] });
