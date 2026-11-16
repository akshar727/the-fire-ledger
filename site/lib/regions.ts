import regionIndex from "../public/data/index.json" with { type: "json" };

export type RegionId = string;

export type Tier = "region" | "country";

export type IndexEntry = {
  id: string;
  name: string;
  short_name?: string;
  tier?: string;
  season?: string;
  caveat?: string;
  data_through?: string | null;
  first_year?: number;
  ship?: string;
  ship_caveat?: string;
};

export const FIRMS_COUNTRY_ARCHIVE = "https://firms.modaps.eosdis.nasa.gov/country/";

export const COUNTRY_NO_POINTS = `Per-detection files are not published for whole countries on this site. The FIRMS country archive has them: ${FIRMS_COUNTRY_ARCHIVE}`;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function countryNote(through: string): string {
  const end = `${MONTHS[Number(through.slice(5, 7)) - 1]} ${through.slice(0, 4)}`;
  return (
    `Whole-country record from the FIRMS yearly archive, ending in ${end}. Not available for a whole country: ` +
    "the per-detection download, fire weather records, the NOAA-20/21 forward link, and the burned-area check."
  );
}

export function shipNote(e: Pick<IndexEntry, "ship" | "ship_caveat">): string | undefined {
  if (e.ship === "ratio")
    return ["Constant-ratio estimate: the harmonized line here is MODIS times this country's 2012 to 2019 VIIRS/MODIS ratio, not the model.", e.ship_caveat]
      .filter(Boolean)
      .join(" ");
  if (e.ship === "sparse")
    return "Too little fire to check: the hold-out has too few detections to test the conversion here, so we treat the harmonized line as unchecked.";
  return e.ship_caveat || undefined;
}

export function shipLabel(ship: string | undefined): string | null {
  return ship === "ratio" ? "constant-ratio estimate" : ship === "sparse" ? "too little fire to check" : null;
}

export function buildRegions(index: { regions: IndexEntry[] }) {
  const entries = index.regions.filter((r) => typeof r.first_year === "number");
  const ids = entries.map((r) => r.id);
  const country = (r: IndexEntry) => r.tier === "country";
  return {
    ids,
    names: Object.fromEntries(entries.map((r) => [r.id, r.short_name || r.name])) as Record<RegionId, string>,
    tier: Object.fromEntries(entries.map((r) => [r.id, country(r) ? "country" : "region"])) as Record<RegionId, Tier>,
    label: Object.fromEntries(entries.flatMap((r) => (country(r) && shipLabel(r.ship) ? [[r.id, shipLabel(r.ship)!]] : []))) as Partial<
      Record<RegionId, string>
    >,
    season: Object.fromEntries(entries.map((r) => [r.id, r.season ?? ""])) as Record<RegionId, string>,
    caveat: Object.fromEntries(
      entries.flatMap((r) => {
        const parts = country(r)
          ? [r.caveat, shipNote(r), r.data_through ? countryNote(r.data_through) : undefined]
          : [r.caveat];
        const text = parts.filter(Boolean).join(" ");
        return text ? [[r.id, text]] : [];
      }),
    ) as Partial<Record<RegionId, string>>,
  };
}

const built = buildRegions(regionIndex as { regions: IndexEntry[] });

export const REGION_IDS: readonly RegionId[] = built.ids;
export const REGIONS: Readonly<Record<RegionId, string>> = built.names;
export const isRegionId = (v: unknown): v is RegionId => typeof v === "string" && Object.hasOwn(REGIONS, v);
export const DEFAULT_REGION: RegionId = REGION_IDS[0];
export const TIER: Readonly<Record<RegionId, Tier>> = built.tier;
export const isCountry = (id: RegionId) => TIER[id] === "country";
export const FIRE_SEASON: Readonly<Record<RegionId, string>> = built.season;
export const REGION_CAVEAT: Readonly<Partial<Record<RegionId, string>>> = built.caveat;
export const SHIP_LABEL: Readonly<Partial<Record<RegionId, string>>> = built.label;
