import {
  ApiError,
  csvHeaders,
  errorResponse,
  fetchData,
  filterCsvStream,
  parseHotspotQuery,
} from "@/lib/server-data";
import { COUNTRY_NO_POINTS, isCountry } from "@/lib/regions";

export async function GET(request: Request) {
  try {
    const q = parseHotspotQuery(new URL(request.url).searchParams);
    if (isCountry(q.region)) throw new ApiError(404, COUNTRY_NO_POINTS);
    const responses: Response[] = [];
    try {
      for (const year of q.years) {
        const res = await fetchData(request, q.region, `points/${year}.csv`, [
          "text/csv",
          "text/plain",
        ]);
        if (res) responses.push(res);
      }
    } catch (e) {
      for (const r of responses) void r.body?.cancel().catch(() => {});
      throw e;
    }
    if (responses.length === 0) throw new ApiError(404, "no data for region and range");
    return new Response(filterCsvStream(responses, q), {
      headers: csvHeaders(`hotspots_${q.region}_${q.from}_${q.to}.csv`),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
