// The only module that loads pipeline outputs from site/public/data/ (written by the pipeline, never hand-edited).
// annual-all.json (every region's annual.json, site_bundle.py) and index.json are imported at build time; series.json is
// fetched by the browser (it may not exist yet). No fs reads, so both work on Vercel. DP-009: no region is named here;
// the list is whatever index.json and annual-all.json hold (lib/regions.ts).
import annualAll from "@/public/data/annual-all.json";
import regionIndex from "@/public/data/index.json";
import refereeData from "@/public/data/referee.json";
import { spanOf, type Annual } from "@/lib/annual";
import type { Referee } from "@/lib/referee";
import { isRegionId, REGION_IDS, REGIONS, TIER, type RegionId, type Tier } from "@/lib/regions";
import type { Bounds } from "@/lib/selection";
import { parseSeries, SeriesFormatError, type SeriesBundle } from "@/lib/series";
import { parseWeather, type Weather } from "@/lib/weather";

export { REGIONS, type RegionId } from "@/lib/regions";
export type { Annual, Score } from "@/lib/annual";

const ANNUAL = annualAll as unknown as Record<RegionId, Annual>;

export function loadAnnual(region: RegionId): Annual {
  return ANNUAL[region];
}

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
};

/** Regions in index.json order (the DP-003 region list), limited to those with a record (lib/regions.ts). */
export const REGION_LIST: RegionInfo[] = regionIndex.regions.flatMap((r) =>
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
        },
      ]
    : [],
);
if (REGION_LIST.length !== REGION_IDS.length) throw new Error("index.json and lib/regions.ts disagree on the region list");

export function regionInfo(region: RegionId): RegionInfo {
  return REGION_LIST.find((r) => r.id === region)!;
}

/** The whole published record across the cell regions, for site-wide copy (`spanOf` in lib/annual.ts). Whole countries
 * (DP-009) are left out: they are listed apart, and their archive-only record would shorten every page's year range. */
export function recordSpan() {
  const cells = REGION_LIST.filter((r) => r.tier === "region");
  return spanOf(cells.map((r) => ANNUAL[r.id]), cells.map((r) => REGIONS[r.id]));
}

/**
 * Selectable dates: from the first year of the annual record to the end of the downloaded archive, or to the end of
 * the NOAA-20/21 forward link when there is one (FE-009: its weeks and points run past the Suomi NPP end).
 */
export function regionBounds(region: RegionId): Bounds {
  const through = regionInfo(region).data_through, fwd = ANNUAL[region].forward_through;
  return { min: `${ANNUAL[region].years[0]}-01-01`, max: fwd && fwd > through ? fwd : through };
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
 * is missing, unreadable or in an unexpected format, and the calendar then shows no weather (FE-012).
 */
export async function fetchWeather(region: RegionId, signal?: AbortSignal): Promise<Weather | null> {
  try {
    const res = await fetch(`/data/${region}/weather.json`, { signal, cache: "no-cache" });
    return res.ok ? parseWeather(await res.json()) : null;
  } catch (e) {
    if (signal?.aborted) throw e;
    return null;
  }
}
