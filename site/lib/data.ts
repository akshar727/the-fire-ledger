// The only module that loads pipeline outputs from site/public/data/ (written by model.py, never hand-edited).
// annual.json and index.json are imported at build time; series.json is fetched by the browser (it may not exist yet). No fs reads,
// so both work on Vercel.
import ghanaAnnual from "@/public/data/ghana/annual.json";
import regionIndex from "@/public/data/index.json";
import portugalAnnual from "@/public/data/portugal/annual.json";
import punjabAnnual from "@/public/data/punjab/annual.json";
import { isRegionId, type RegionId } from "@/lib/regions";
import type { Bounds } from "@/lib/selection";
import { parseSeries, SeriesFormatError, type SeriesBundle } from "@/lib/series";

export { REGIONS, type RegionId } from "@/lib/regions";

/** Hold-out scores for 2020-2025 (see the "DATA" row in SHARED_VARIABLES_AND_FUNCTIONS.md §3). */
export type Score = {
  mape_model: number; // mean absolute % error of the model's annual totals
  mape_ratio: number; // same, for one constant VIIRS/MODIS factor
  coverage: number; // hold-out years whose observed total is inside the 5-95% band
  n_hold: number;
  ratio: number;
  alpha: number;
  weekly_r: number;
  sigma_year: number; // year-level error (RMS of log obs/pred, leave-one-year-out on 2012-2019); sizes the band
};

/** Annual series, one entry per year. `viirs` is null before 2012. */
export type Annual = {
  years: number[];
  modis: number[];
  viirs: (number | null)[];
  pred: number[];
  lo: number[];
  hi: number[];
  score: Score;
};

const ANNUAL: Record<RegionId, Annual> = {
  portugal: portugalAnnual as Annual,
  ghana: ghanaAnnual as Annual,
  punjab: punjabAnnual as Annual,
};

export function loadAnnual(region: RegionId): Annual {
  return ANNUAL[region];
}

/** One entry of site/public/data/index.json (registry §3 "Region index"), the fields the site uses. */
export type RegionInfo = {
  id: RegionId;
  name: string;
  data_through: string; // YYYY-MM-DD, end of the downloaded archive
  point_years: number[]; // years with a points/<year>.csv file
  point_rows: number;
};

/** Regions in index.json order (the DP-003 region list), limited to those this site has pages for. */
export const REGION_LIST: RegionInfo[] = regionIndex.regions.flatMap((r) =>
  isRegionId(r.id)
    ? [{ id: r.id, name: r.name, data_through: r.data_through, point_years: r.point_years, point_rows: r.point_rows }]
    : [],
);

export function regionInfo(region: RegionId): RegionInfo {
  return REGION_LIST.find((r) => r.id === region)!;
}

/** Selectable dates: from the first year of the annual record to the end of the downloaded archive. */
export function regionBounds(region: RegionId): Bounds {
  return { min: `${ANNUAL[region].years[0]}-01-01`, max: regionInfo(region).data_through };
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
