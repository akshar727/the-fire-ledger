// DP-009 / DP-018: the region list comes from the pipeline's index.json (build.py + site_bundle.py), so adding a region
// (or one of ~180 whole countries) needs no edit under site/ except data files. Entries carry the ids, names, page copy,
// tier and the record fields the site needs before it fetches a region's annual.json (`first_year`; for a country
// `ship` and `ship_caveat`); an entry without `first_year` has no record yet and is left out. No per-region file is
// imported here (WORLD PLAN). Relative JSON import, so client components and `node --test` both use it. `buildRegions`
// is pure, so tests can feed it whole countries without one being published.
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
  first_year?: number;
  /** a country's ship rule (registry "Country-tier outputs", ML-024 / ML-023), copied from its annual.json */
  ship?: string;
  ship_caveat?: string;
};

/** NASA FIRMS country yearly archive: where a whole country's per-detection files are (none are published here). */
export const FIRMS_COUNTRY_ARCHIVE = "https://firms.modaps.eosdis.nasa.gov/country/";

/** /api/hotspots answer for a whole country (DP-018). */
export const COUNTRY_NO_POINTS = `Per-detection files are not published for whole countries on this site. The FIRMS country archive has them: ${FIRMS_COUNTRY_ARCHIVE}`;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The sentence a whole country shows in place of the views it lacks (DP-009), e.g. "... ending in December 2025 ...". */
export function countryNote(through: string): string {
  const end = `${MONTHS[Number(through.slice(5, 7)) - 1]} ${through.slice(0, 4)}`;
  return (
    `Whole-country record from the FIRMS yearly archive, ending in ${end}. Not available for a whole country: ` +
    "per-detection download, fire weather, the NOAA-20/21 forward link and the burned-area check."
  );
}

/** What a country's ship rule adds to its note: "caveat" ships the model with the pipeline's sentence; "ratio" ships
 * MODIS scaled by one constant factor, which must not pass for the model; "sparse" has too little fire to check.
 * ML-023: the pipeline's own sentence (`ship_caveat`: missing FIRMS files, a high 2001-2002 back-cast, the ratio beat
 * the model) is shown for every label except "sparse", whose fixed line already says it all. */
export function shipNote(e: Pick<IndexEntry, "ship" | "ship_caveat">): string | undefined {
  if (e.ship === "ratio")
    return ["Constant-ratio estimate: the harmonized line here is MODIS times this country's 2012 to 2019 VIIRS/MODIS ratio, not the model.", e.ship_caveat]
      .filter(Boolean)
      .join(" ");
  if (e.ship === "sparse")
    return "Too little fire to check: the hold-out has too few detections to test the conversion here, so treat the harmonized line as unchecked.";
  return e.ship_caveat || undefined;
}

/** The short label shown next to a country's record, or null for the model (a "caveat" country shows its sentence in
 * the note instead) and for deep dives. */
export function shipLabel(ship: string | undefined): string | null {
  return ship === "ratio" ? "constant-ratio estimate" : ship === "sparse" ? "too little fire to check" : null;
}

export function buildRegions(index: { regions: IndexEntry[] }) {
  const entries = index.regions.filter((r) => typeof r.first_year === "number");
  const ids = entries.map((r) => r.id);
  const country = (r: IndexEntry) => r.tier === "country";
  return {
    /** Region ids in index.json order: cell regions first, then countries (site_bundle.py appends them). */
    ids,
    /** Display names: `short_name` when the full name is too long for a button, else `name`. */
    names: Object.fromEntries(entries.map((r) => [r.id, r.short_name || r.name])) as Record<RegionId, string>,
    tier: Object.fromEntries(entries.map((r) => [r.id, country(r) ? "country" : "region"])) as Record<RegionId, Tier>,
    /** A country's ship label ("constant-ratio estimate", ...); absent for the model and for deep dives. */
    label: Object.fromEntries(entries.flatMap((r) => (country(r) && shipLabel(r.ship) ? [[r.id, shipLabel(r.ship)!]] : []))) as Partial<
      Record<RegionId, string>
    >,
    /** Fire type and season, one sentence per region (index.json `season`; empty when the pipeline has none). */
    season: Object.fromEntries(entries.map((r) => [r.id, r.season ?? ""])) as Record<RegionId, string>,
    /** Extra caveat (index.json `caveat`, e.g. NW India's Terra-only 2001 to mid-2002 back-cast, ML-006); for a whole
     * country also its ship-rule sentence and what it leaves out. */
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
/** First region in the list: the view a link without ?region= opens on. */
export const DEFAULT_REGION: RegionId = REGION_IDS[0];
export const TIER: Readonly<Record<RegionId, Tier>> = built.tier;
export const isCountry = (id: RegionId) => TIER[id] === "country";
export const FIRE_SEASON: Readonly<Record<RegionId, string>> = built.season;
export const REGION_CAVEAT: Readonly<Partial<Record<RegionId, string>>> = built.caveat;
/** A country's ship label, shown next to its record (DP-018); absent when the model shipped. */
export const SHIP_LABEL: Readonly<Partial<Record<RegionId, string>>> = built.label;
