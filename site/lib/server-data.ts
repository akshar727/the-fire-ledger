// Server-only helpers for the /api/* route handlers. Do not import from client components
// (the `server-only` package is not a dependency, so this is enforced by convention).
//
// Plan B (not implemented): if fetching our own /data/ files fails on Vercel,
// switch to fs.readFile(path.join(process.cwd(), "public/data/...")) plus
// outputFileTracingIncludes for "/api/**" in next.config.ts. Only this file would change.

export const MAX_SPAN_DAYS = 366;
export const REGION_RE = /^[a-z0-9-]+$/;
export const HOTSPOT_HEADER =
  "date,time_utc,lat,lon,satellite,confidence,frp_mw,daynight";

const DAY_MS = 86_400_000;

export class ApiError extends Error {
  // explicit field, not a `public status` parameter property: Node's type stripping (npm test) can't handle those
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function errorResponse(e: unknown): Response {
  if (e instanceof ApiError) {
    return Response.json({ error: e.message }, { status: e.status });
  }
  return Response.json({ error: "internal error" }, { status: 500 });
}

export function csvHeaders(filename: string): HeadersInit {
  return {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "public, max-age=300",
  };
}

export function parseRegion(v: string | null): string {
  if (!v || !REGION_RE.test(v)) throw new ApiError(400, "invalid or missing region");
  return v;
}

/** Strict YYYY-MM-DD real calendar date -> UTC ms. */
export function parseDate(name: string, v: string | null): number {
  const m = v ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null;
  if (!m) throw new ApiError(400, `${name} must be YYYY-MM-DD`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw new ApiError(400, `${name} is not a real calendar date`);
  }
  return t;
}

export type Bbox = { w: number; s: number; e: number; n: number };

export function parseBbox(v: string | null): Bbox | null {
  if (v === null) return null;
  const nums = v.split(",").map((p) => (p.trim() === "" ? NaN : Number(p)));
  if (nums.length !== 4 || !nums.every(Number.isFinite)) {
    throw new ApiError(400, "bbox must be w,s,e,n (4 numbers)");
  }
  const [w, s, e, n] = nums;
  if (!(w < e) || !(s < n) || w < -180 || e > 180 || s < -90 || n > 90) {
    throw new ApiError(400, "bbox out of range or not w<e, s<n");
  }
  return { w, s, e, n };
}

export type HotspotQuery = {
  region: string;
  from: string;
  to: string;
  years: number[];
  bbox: Bbox | null;
};

export function parseHotspotQuery(sp: URLSearchParams): HotspotQuery {
  const region = parseRegion(sp.get("region"));
  const fromMs = parseDate("from", sp.get("from"));
  const toMs = parseDate("to", sp.get("to"));
  if (fromMs > toMs) throw new ApiError(400, "from must not be after to");
  if ((toMs - fromMs) / DAY_MS + 1 > MAX_SPAN_DAYS) {
    throw new ApiError(400, `span exceeds ${MAX_SPAN_DAYS} days`);
  }
  const bbox = parseBbox(sp.get("bbox"));
  const y0 = new Date(fromMs).getUTCFullYear();
  const y1 = new Date(toMs).getUTCFullYear();
  const years: number[] = [];
  for (let y = y0; y <= y1; y++) years.push(y);
  return { region, from: sp.get("from")!, to: sp.get("to")!, years, bbox };
}

/**
 * Own-origin fetch of /data/<region>/<file>. Returns null on 404.
 * region and file are validated here so the URL can never leave /data/.
 * Throws ApiError(502) on other failures or when the content type is not one of `types`.
 */
export async function fetchData(
  request: Request,
  region: string,
  file: string,
  types: string[],
): Promise<Response | null> {
  if (!REGION_RE.test(region)) throw new ApiError(400, "invalid region");
  if (!/^(points\/\d{4}\.csv|annual\.json|series\.json)$/.test(file)) {
    throw new ApiError(500, "invalid data file");
  }
  const url = `${new URL(request.url).origin}/data/${region}/${file}`;
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch {
    throw new ApiError(502, "upstream data fetch failed");
  }
  if (res.status === 404) {
    void res.body?.cancel().catch(() => {});
    return null;
  }
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  if (!res.ok || !types.some((t) => ct.startsWith(t))) {
    void res.body?.cancel().catch(() => {});
    throw new ApiError(502, "unexpected upstream response");
  }
  return res;
}

/** Fetch and parse JSON; null on 404, 502 on bad content type or parse failure. */
export async function fetchJson(
  request: Request,
  region: string,
  file: "annual.json" | "series.json",
): Promise<unknown | null> {
  const res = await fetchData(request, region, file, ["application/json"]);
  if (!res) return null;
  try {
    return await res.json();
  } catch {
    throw new ApiError(502, "invalid JSON from upstream");
  }
}

/**
 * Stream the given CSV responses as one CSV: header once, then rows with
 * from <= date <= to (and inside bbox if given). Reads incrementally; stops
 * reading a file once date > to.
 * Status 200 and headers go out before the first upstream read, so a read error
 * mid-stream ends as a truncated download (aborted connection), not a JSON error.
 */
export function filterCsvStream(
  responses: Response[],
  q: { from: string; to: string; bbox: Bbox | null },
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const { from, to, bbox } = q;
  let idx = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let decoder = new TextDecoder();
  let carry = "";
  let headerSkipped = false;
  let headerSent = false;

  // Appends the line to out if it matches; returns true when date > to (stop this file).
  const handle = (raw: string, out: string[]): boolean => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "") return false;
    if (!headerSkipped) {
      headerSkipped = true;
      return false;
    }
    const comma = line.indexOf(",");
    if (comma < 0) return false; // malformed row; the contract rules these out
    const date = line.slice(0, comma);
    if (date > to) return true;
    if (date < from) return false;
    if (bbox) {
      const f = line.split(",");
      const lat = Number(f[2]);
      const lon = Number(f[3]);
      if (!(lon >= bbox.w && lon <= bbox.e && lat >= bbox.s && lat <= bbox.n)) return false;
    }
    out.push(line);
    return false;
  };

  const nextFile = async () => {
    if (reader) void reader.cancel().catch(() => {});
    reader = null;
    idx++;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!headerSent) {
        headerSent = true;
        controller.enqueue(enc.encode(HOTSPOT_HEADER + "\n"));
        return;
      }
      try {
        // Loop until something is enqueued or all input is consumed.
        for (;;) {
          if (idx >= responses.length) {
            controller.close();
            return;
          }
          if (!reader) {
            const body = responses[idx].body;
            if (!body) {
              idx++;
              continue;
            }
            reader = body.getReader();
            decoder = new TextDecoder();
            carry = "";
            headerSkipped = false;
          }
          const { done, value } = await reader.read();
          const out: string[] = [];
          let stop = false;
          if (done) {
            carry += decoder.decode();
            if (carry) handle(carry, out);
            carry = "";
            stop = true;
          } else {
            carry += decoder.decode(value, { stream: true });
            const lines = carry.split("\n");
            carry = lines.pop() ?? "";
            for (const l of lines) {
              if (handle(l, out)) {
                stop = true;
                break;
              }
            }
          }
          if (stop) await nextFile();
          if (out.length) {
            controller.enqueue(enc.encode(out.join("\n") + "\n"));
            return;
          }
        }
      } catch (e) {
        controller.error(e);
      }
    },
    async cancel() {
      if (reader) void reader.cancel().catch(() => {});
      for (let i = reader ? idx + 1 : idx; i < responses.length; i++) {
        void responses[i].body?.cancel().catch(() => {});
      }
    },
  });
}
