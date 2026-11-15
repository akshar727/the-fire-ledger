// The only module that loads pipeline outputs from site/public/data/ in the browser (written by the pipeline, never
// hand-edited). index.json (the region list, with each region's record fields: DP-018) and referee.json are imported at
// build time; every per-region file (annual.json, series.json, weather.json) is fetched by id, so ~180 regions add
// nothing to a page's bundle (WORLD PLAN). Build-time reads for server components live in lib/data-server.ts.
import regionIndex from "@/public/data/index.json";
import refereeData from "@/public/data/referee.json";
import type { Referee } from "@/lib/referee";
import { isRegionId, REGION_IDS, TIER, type RegionId, type Tier } from "@/lib/regions";
import type { Bounds } from "@/lib/selection";
import { parseSeries, SeriesFormatError, type SeriesBundle } from "@/lib/series";
import { parseWeather, type Weather } from "@/lib/weather";

export { REGIONS, type RegionId } from "@/lib/regions";
export type { Annual, Score } from "@/lib/annual";

// DP-018: per-region records are fetched by id (lib/fetch-annual.ts)
export { fetchAnnual } from "@/lib/fetch-annual";

/** Burned-area referee (ML-019): site/public/data/referee.json, written by referee.py. */
export function loadReferee(): Referee {
  return refereeData as Referee;
}

/** One entry of site/public/data/index.json (registry §3 "Region index"), the fields the site uses. */
export type RegionInfo = {
  id: RegionId;
  name: string;
  tier: Tier;
  data_through: string; // YYYY-MM-DD, end of the downloaded archive
  point_years: number[]; // years with a points/<year>.csv file (none for a country)
  point_rows: number;
  bbox: [number, number, number, number]; // [west, south, east, north] degrees, from regions.json / countries.json
  first_year: number; // DP-018: annual.json years[0], copied by site_bundle.py
  forward_through: string | null; // DP-018: annual.json forward_through (NOAA-20/21 forward link end), or null
};

type IndexRow = Omit<RegionInfo, "tier" | "bbox" | "forward_through"> & { bbox: number[]; forward_through?: string | null };

/** Regions in index.json order (the DP-003 region list), limited to those with a record (lib/regions.ts). */
export const REGION_LIST: RegionInfo[] = (regionIndex.regions as IndexRow[]).flatMap((r) =>
  isRegionId(r.id)
    ? [
        {
          id: r.id,
          name: r.name,
          tier: TIER[r.id],
          data_through: r.data_through,
          point_years: r.point_years,
          point_rows: r.point_rows,
          bbox: r.bbox as RegionInfo["bbox"],
          first_year: r.first_year,
          forward_through: r.forward_through ?? null,
        },
      ]
    : [],
);
if (REGION_LIST.length !== REGION_IDS.length) throw new Error("index.json and lib/regions.ts disagree on the region list");

export function regionInfo(region: RegionId): RegionInfo {
  return REGION_LIST.find((r) => r.id === region)!;
}

/**
 * Selectable dates: from the first year of the annual ledger to the end of the downloaded archive, or to the end of
 * the NOAA-20/21 forward link when there is one (FE-009: its weeks and points run past the Suomi NPP end). DP-018: both
 * come from index.json, so the dates are known before annual.json is fetched.
 */
export function regionBounds(region: RegionId): Bounds {
  const r = regionInfo(region), fwd = r.forward_through;
  return { min: `${r.first_year}-01-01`, max: fwd && fwd > r.data_through ? fwd : r.data_through };
}

/** Result of loading series.json in the browser. "missing" = the file is not published yet (ML-004). */
export type SeriesResult =
  | { status: "ready"; bundle: SeriesBundle }
  | { status: "missing" }
  | { status: "error"; message: string };

/**
 * Loads the Series bundle for a region from /data/<region>/series.json at runtime (browser fetch, not a build-time
 * import), so the site builds and deploys while ML-004 has not written the file yet.
 */
export async function fetchSeries(region: RegionId, signal?: AbortSignal): Promise<SeriesResult> {
  let res: Response;
  try {
    res = await fetch(`/data/${region}/series.json`, { signal, cache: "no-cache" });
  } catch (e) {
    if (signal?.aborted) throw e;
    return { status: "error", message: "Network error while loading the calendar data." };
  }
  if (res.status === 404) return { status: "missing" };
  if (!res.ok) return { status: "error", message: `The server answered ${res.status}.` };
  try {
    return { status: "ready", bundle: parseSeries(await res.json()) };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { status: "error", message: e instanceof SeriesFormatError ? `Unexpected file format: ${e.message}.` : "The file is not valid JSON." };
  }
}

/**
 * Loads a region's fire-weather file (DP-014, /data/<region>/weather.json) in the browser. Optional extra: null when it
 * is missing, unreadable or in an unexpected format, and the calendar then shows no weather (FE-012). A whole country
 * has no weather.json (deep dives only), so it gets null without a request (FE-029: no 404 on ~176 country pages).
 */
export async function fetchWeather(region: RegionId, signal?: AbortSignal): Promise<Weather | null> {
  if (TIER[region] === "country") return null;
  try {
    const res = await fetch(`/data/${region}/weather.json`, { signal, cache: "no-cache" });
    return res.ok ? parseWeather(await res.json()) : null;
  } catch (e) {
    if (signal?.aborted) throw e;
    return null;
  }
}
