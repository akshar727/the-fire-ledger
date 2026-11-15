// Region ids and page copy, with no imports, so client components and `node --test` can use them without pulling the
// annual.json files into the bundle. Order and ids follow site/public/data/index.json (DP-003 region registry);
// lib/regions.test.ts checks they still match.

/** Display names. */
export const REGIONS = {
  portugal: "Mainland Portugal",
  ghana: "Ghana",
  punjab: "NW India (Punjab, Haryana)",
} as const;
export type RegionId = keyof typeof REGIONS;

export const isRegionId = (v: unknown): v is RegionId => typeof v === "string" && Object.hasOwn(REGIONS, v);

/** Fire type and season per region, reworded from index.json `fire_type` (page copy uses no en dashes). */
export const FIRE_SEASON: Record<RegionId, string> = {
  portugal: "Forest and shrub wildfire, peaking July to October.",
  ghana: "Savanna burning, peaking November to February.",
  punjab: "Crop-residue burning, peaking April to May and October to November.",
};

/**
 * Extra caveat shown under a region's calendar. NW India's 2001 to mid-2002 back-cast (Terra only; Aqua's first day
 * there is 2002-07-18) runs well above the full model (ML-006). Revisit when a human decides ML-008.
 */
export const REGION_CAVEAT: Partial<Record<RegionId, string>> = {
  punjab:
    "Before July 2002 only the Terra satellite was flying, and the back-cast for those months runs high here, so treat 2001 and early 2002 with caution.",
};
