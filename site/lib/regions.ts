// DP-009: the region list comes from the pipeline's files, so adding a region (or a whole country) needs no edit
// under site/ except data files. index.json (build.py + site_bundle.py) gives the ids, names, page copy and tier;
// annual-all.json (site_bundle.py) says which of them have been modelled. A region in index.json without a record yet is
// left out until model.py has run. Relative JSON imports only, so client components and `node --test` both use it
// (lib/data.ts bundles the same annual-all.json, so this adds nothing to a page). `buildRegions` is pure, so tests can
// feed it a whole country without one being published.
import annualAll from "../public/data/annual-all.json" with { type: "json" };
import regionIndex from "../public/data/index.json" with { type: "json" };

/** A region id from index.json (lowercase letters, digits, '-'). */
export type RegionId = string;

/** "region": a box modelled cell by cell, with point files, weather and the rest. "country": a whole country, record and
 * calendar only (no per-detection files, weather, forward link or burned-area check). */
export type Tier = "region" | "country";

/** The index.json fields read here (registry §3 "Region index"). */
export type IndexEntry = {
  id: string;
  name: string;
  short_name?: string;
  tier?: string;
  season?: string;
  caveat?: string;
  data_through?: string | null;
};

/** The annual.json fields read here: a country's ship rule (registry "Country-tier outputs", ML-024 / ML-023). */
export type AnnualHead = { ship?: string; caveat?: string };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The sentence a whole country shows in place of the views it lacks (DP-009), e.g. "... ending in December 2025 ...". */
export function countryNote(through: string): string {
  const end = `${MONTHS[Number(through.slice(5, 7)) - 1]} ${through.slice(0, 4)}`;
  return (
    `Whole-country record from the FIRMS yearly archive, ending in ${end}. Not available for a whole country: ` +
    "per-detection download, fire weather, the NOAA-20/21 forward link and the burned-area check."
  );
}

/** What a country's label adds to its note (ML-023): "ratio" ships MODIS scaled by one constant factor, which must not
 * pass for the model, so it always says so; every label then adds the pipeline's own sentence when there is one
 * ("caveat": the band is too narrow; "sparse": too little fire to check; any label: missing FIRMS files or a high
 * 2001-2002 back-cast). */
export function shipNote(a: AnnualHead | undefined): string | undefined {
  const ratio =
    a?.ship === "ratio" || a?.ship === "sparse"
      ? "The harmonized line here is a constant-ratio estimate (MODIS times this country's 2012 to 2019 VIIRS/MODIS ratio), not the model."
      : undefined;
  return [ratio, a?.caveat].filter(Boolean).join(" ") || undefined;
}

export function buildRegions(index: { regions: IndexEntry[] }, bundle: Record<string, AnnualHead>) {
  const entries = index.regions.filter((r) => Object.hasOwn(bundle, r.id));
  const ids = entries.map((r) => r.id);
  const country = (r: IndexEntry) => r.tier === "country";
  return {
    /** Region ids in index.json order: cell regions first, then countries (site_bundle.py appends them). */
    ids,
    /** Display names: `short_name` when the full name is too long for a button, else `name`. */
    names: Object.fromEntries(entries.map((r) => [r.id, r.short_name || r.name])) as Record<RegionId, string>,
    tier: Object.fromEntries(entries.map((r) => [r.id, country(r) ? "country" : "region"])) as Record<RegionId, Tier>,
    /** Fire type and season, one sentence per region (index.json `season`; empty when the pipeline has none). */
    season: Object.fromEntries(entries.map((r) => [r.id, r.season ?? ""])) as Record<RegionId, string>,
    /** Extra caveat (index.json `caveat`, e.g. NW India's Terra-only 2001 to mid-2002 back-cast, ML-006); for a whole
     * country also its ship-rule sentence and what it leaves out. */
    caveat: Object.fromEntries(
      entries.flatMap((r) => {
        const parts = country(r)
          ? [r.caveat, shipNote(bundle[r.id]), r.data_through ? countryNote(r.data_through) : undefined]
          : [r.caveat];
        const text = parts.filter(Boolean).join(" ");
        return text ? [[r.id, text]] : [];
      }),
    ) as Partial<Record<RegionId, string>>,
  };
}

const built = buildRegions(regionIndex as { regions: IndexEntry[] }, annualAll as Record<string, AnnualHead>);

export const REGION_IDS: readonly RegionId[] = built.ids;
export const REGIONS: Readonly<Record<RegionId, string>> = built.names;
export const isRegionId = (v: unknown): v is RegionId => typeof v === "string" && Object.hasOwn(REGIONS, v);
/** First region in the list: the view a link without ?region= opens on. */
export const DEFAULT_REGION: RegionId = REGION_IDS[0];
export const TIER: Readonly<Record<RegionId, Tier>> = built.tier;
export const isCountry = (id: RegionId) => TIER[id] === "country";
export const FIRE_SEASON: Readonly<Record<RegionId, string>> = built.season;
export const REGION_CAVEAT: Readonly<Partial<Record<RegionId, string>>> = built.caveat;
