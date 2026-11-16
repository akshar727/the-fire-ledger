import regionIndex from "@/public/data/index.json";
import refereeData from "@/public/data/referee.json";
import type { Referee } from "@/lib/referee";
import { isRegionId, REGION_IDS, TIER, type RegionId, type Tier } from "@/lib/regions";
import type { Bounds } from "@/lib/selection";
import { parseSeries, SeriesFormatError, type SeriesBundle } from "@/lib/series";
import { parseWeather, type Weather } from "@/lib/weather";

export { REGIONS, type RegionId } from "@/lib/regions";
export type { Annual, Score } from "@/lib/annual";

export { fetchAnnual } from "@/lib/fetch-annual";

export function loadReferee(): Referee {
  return refereeData as Referee;
}

export type RegionInfo = {
  id: RegionId;
  name: string;
  tier: Tier;
  data_through: string;
  point_years: number[];
  point_rows: number;
  bbox: [number, number, number, number];
  first_year: number;
  forward_through: string | null;
};

type IndexRow = Omit<RegionInfo, "tier" | "bbox" | "forward_through"> & { bbox: number[]; forward_through?: string | null };

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

export function regionBounds(region: RegionId): Bounds {
  const r = regionInfo(region), fwd = r.forward_through;
  return { min: `${r.first_year}-01-01`, max: fwd && fwd > r.data_through ? fwd : r.data_through };
}

export type SeriesResult =
  | { status: "ready"; bundle: SeriesBundle }
  | { status: "missing" }
  | { status: "error"; message: string };

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
