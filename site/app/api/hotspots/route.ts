import {
  ApiError,
  csvHeaders,
  errorResponse,
  fetchData,
  filterCsvStream,
  parseHotspotQuery,
} from "@/lib/server-data";

// No `dynamic` / `runtime` exports: with cacheComponents they are removed/unsupported
// in Next 16 (Node.js is the default runtime; reading `request` makes this dynamic).

export async function GET(request: Request) {
  try {
    const q = parseHotspotQuery(new URL(request.url).searchParams);
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
