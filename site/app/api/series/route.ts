import { ApiError, csvHeaders, errorResponse, fetchJson, parseRegion } from "@/lib/server-data";

// No `dynamic` / `runtime` exports: with cacheComponents they are removed/unsupported
// in Next 16 (Node.js is the default runtime; reading `request` makes this dynamic).

type Num = (number | null)[];
type Block = { start_year: number; modis?: Num; viirs?: Num; pred?: Num; lo?: Num; hi?: Num };

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

const cell = (a: Num | undefined, i: number): number | null => {
  const v = a?.[i];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

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

    const periods: string[] = [];
    let b: Block;
    if (res === "annual") {
      const j = (await fetchJson(request, region, "annual.json")) as
        | (Block & { years?: number[] })
        | null;
      if (!j || !Array.isArray(j.years)) throw new ApiError(404, "no annual data for region");
      for (const y of j.years) periods.push(String(y));
      b = j;
    } else {
      const j = (await fetchJson(request, region, "series.json")) as Record<
        string,
        Block | undefined
      > | null;
      const blk = j?.[res];
      if (!blk || typeof blk.start_year !== "number") {
        throw new ApiError(404, `no ${res} data for region`);
      }
      b = blk;
      const len = Math.max(
        ...[blk.modis, blk.viirs, blk.pred, blk.lo, blk.hi].map((a) => a?.length ?? 0),
      );
      for (let i = 0; i < len; i++) {
        if (res === "monthly") {
          const y = blk.start_year + Math.floor(i / 12);
          periods.push(`${y}-${String((i % 12) + 1).padStart(2, "0")}`);
        } else {
          const y = blk.start_year + Math.floor(i / 52);
          periods.push(`${y}-W${String(i % 52).padStart(2, "0")}`);
        }
      }
    }

    // String-compare the period prefix of the same length as each bound.
    const lines = ["period,modis,viirs,pred,lo,hi,harmonized"];
    periods.forEach((p, i) => {
      if (from !== null && p.slice(0, from.length) < from) return;
      if (to !== null && p.slice(0, to.length) > to) return;
      const viirs = cell(b.viirs, i);
      const pred = cell(b.pred, i);
      const vals = [cell(b.modis, i), viirs, pred, cell(b.lo, i), cell(b.hi, i), viirs ?? pred];
      lines.push([p, ...vals.map((v) => (v === null ? "" : String(v)))].join(","));
    });
    return new Response(lines.join("\n") + "\n", {
      headers: csvHeaders(`series_${region}_${res}.csv`),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
