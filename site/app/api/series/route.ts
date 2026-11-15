import { seriesCsv, seriesFilename, type Block } from "@/lib/series-csv";
import { ApiError, csvHeaders, errorResponse, fetchJson, parseRegion } from "@/lib/server-data";

// No `dynamic` / `runtime` exports: with cacheComponents they are removed/unsupported
// in Next 16 (Node.js is the default runtime; reading `request` makes this dynamic).

/**
 * from/to accepted formats: annual -> YYYY; monthly -> YYYY-MM; weekly -> YYYY
 * (compared against the year part of the period). Inclusive.
 */
function parseBound(name: string, v: string | null, res: string): string | null {
  if (v === null) return null;
  const re = res === "monthly" ? /^\d{4}-(0[1-9]|1[0-2])$/ : /^\d{4}$/;
  if (!re.test(v)) {
    throw new ApiError(400, `${name} must be ${res === "monthly" ? "YYYY-MM" : "YYYY"} for res=${res}`);
  }
  return v;
}

export async function GET(request: Request) {
  try {
    const sp = new URL(request.url).searchParams;
    const region = parseRegion(sp.get("region"));
    const res = sp.get("res") ?? "annual";
    if (res !== "annual" && res !== "monthly" && res !== "weekly") {
      throw new ApiError(400, "res must be annual, monthly or weekly");
    }
    const from = parseBound("from", sp.get("from"), res);
    const to = parseBound("to", sp.get("to"), res);
    if (from !== null && to !== null && from > to) {
      throw new ApiError(400, "from must not be after to");
    }

    let csv: string;
    if (res === "annual") {
      const j = (await fetchJson(request, region, "annual.json")) as (Block & { years?: number[] }) | null;
      if (!j || !Array.isArray(j.years)) throw new ApiError(404, "no annual data for region");
      csv = seriesCsv(res, j, from, to, j.years);
    } else {
      const j = (await fetchJson(request, region, "series.json")) as Record<string, Block | undefined> | null;
      const blk = j?.[res];
      if (!blk || typeof blk.start_year !== "number") throw new ApiError(404, `no ${res} data for region`);
      csv = seriesCsv(res, blk, from, to);
    }
    // BE-006: values rounded to 1 decimal, a `partial` column, week dates, and the range in the file name
    return new Response(csv, { headers: csvHeaders(seriesFilename(region, res, from, to)) });
  } catch (e) {
    return errorResponse(e);
  }
}
