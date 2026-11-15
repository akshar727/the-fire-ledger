// Run with `npm test` (Node's built-in test runner strips the TypeScript types; use Node.js 24 or newer, as the README says).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ApiError,
  HOTSPOT_HEADER,
  MAX_SPAN_DAYS,
  errorResponse,
  filterCsvStream,
  parseBbox,
  parseHotspotQuery,
} from "./server-data.ts";

const H = "date,time_utc,lat,lon,satellite,confidence,frp_mw,daynight";
const row = (date: string, lat: number, lon: number) => `${date},0130,${lat},${lon},N,h,1.5,N`;

const FILE_A = [
  H,
  row("2024-12-29", 40, -8), // before from
  row("2024-12-30", 40, -8),
  row("2024-12-31", 50, -8), // outside bbox (lat)
  row("2024-12-31", 41, -7.5),
];
const FILE_B = [
  H,
  row("2025-01-01", 39, -9),
  row("2025-01-02", 40, -8),
  row("2025-01-03", 40, -8), // after to: stop
  row("2025-01-04", 40, -8),
];
const QUERY = { from: "2024-12-30", to: "2025-01-02", bbox: null };

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Split bytes into random chunks of 1..max bytes (max=1 gives 1-byte chunks). */
function chunkify(text: string, rnd: () => number, max: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; ) {
    const n = Math.min(bytes.length - i, 1 + Math.floor(rnd() * max));
    out.push(bytes.slice(i, i + n));
    i += n;
  }
  return out;
}

function streamOf(chunks: Uint8Array[], stats?: { pulls: number; cancelled: boolean }) {
  let i = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(c) {
        if (stats) stats.pulls++;
        if (i < chunks.length) c.enqueue(chunks[i++]);
        else c.close();
      },
      cancel() {
        if (stats) stats.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
}

const resp = (chunks: Uint8Array[], stats?: { pulls: number; cancelled: boolean }) =>
  ({ body: streamOf(chunks, stats) }) as unknown as Response;

async function collect(s: ReadableStream<Uint8Array>) {
  return await new Response(s).text();
}

async function run(
  texts: string[],
  q: Parameters<typeof filterCsvStream>[1],
  rnd: () => number,
  max: number,
) {
  return collect(filterCsvStream(texts.map((t) => resp(chunkify(t, rnd, max))), q));
}

const lf = (lines: string[]) => lines.join("\n") + "\n";
const crlf = (lines: string[]) => lines.join("\r\n") + "\r\n";

const EXPECTED = lf([
  H,
  row("2024-12-30", 40, -8),
  row("2024-12-31", 50, -8),
  row("2024-12-31", 41, -7.5),
  row("2025-01-01", 39, -9),
  row("2025-01-02", 40, -8),
]);

test("filterCsvStream: output is identical regardless of chunking (LF and CRLF, many seeds)", async () => {
  for (const seed of [1, 2, 3, 42, 1234, 99999]) {
    for (const max of [1, 2, 3, 7, 50, 10_000]) {
      for (const fmt of [lf, crlf]) {
        const out = await run([fmt(FILE_A), fmt(FILE_B)], QUERY, mulberry32(seed), max);
        assert.equal(out, EXPECTED, `seed=${seed} max=${max} ${fmt === lf ? "lf" : "crlf"}`);
      }
    }
  }
});

test("filterCsvStream: header exactly once across two files, no stray CR", async () => {
  const out = await run([crlf(FILE_A), crlf(FILE_B)], QUERY, mulberry32(7), 1);
  assert.equal(out.split(H).length - 1, 1);
  assert.ok(out.startsWith(H + "\n"));
  assert.ok(!out.includes("\r"));
});

test("filterCsvStream: a CRLF pair split across chunks is handled", async () => {
  const text = crlf(FILE_A);
  const bytes = new TextEncoder().encode(text);
  const cr = bytes.indexOf(13);
  const chunks = [bytes.slice(0, cr + 1), bytes.slice(cr + 1)]; // split between \r and \n
  const out = await collect(filterCsvStream([resp(chunks)], QUERY));
  assert.ok(!out.includes("\r"));
  assert.equal(out, lf([H, row("2024-12-30", 40, -8), row("2024-12-31", 50, -8), row("2024-12-31", 41, -7.5)]));
});

test("filterCsvStream: multibyte characters split across chunks survive", async () => {
  const text = lf([H, "2025-01-01,0,1,1,Ñ✓,h,1,N"]);
  const out = await run([text], { from: "2025-01-01", to: "2025-01-01", bbox: null }, mulberry32(5), 1);
  assert.equal(out, text);
});

test("filterCsvStream: rows outside from..to are dropped; from and to are inclusive", async () => {
  const out = await run([lf(FILE_A), lf(FILE_B)], QUERY, mulberry32(1), 100);
  assert.ok(!out.includes("2024-12-29"));
  assert.ok(!out.includes("2025-01-03"));
  assert.ok(out.includes("2024-12-30"));
  assert.ok(out.includes("2025-01-02"));
});

test("filterCsvStream: last row without trailing newline is kept", async () => {
  const text = FILE_B.slice(0, 3).join("\n");
  const out = await run([text], QUERY, mulberry32(1), 4);
  assert.equal(out, lf([H, row("2025-01-01", 39, -9), row("2025-01-02", 40, -8)]));
});

test("filterCsvStream: header-only and empty-body inputs give just the header", async () => {
  assert.equal(await run([lf([H]), ""], QUERY, mulberry32(1), 5), H + "\n");
  const noBody = { body: null } as unknown as Response;
  assert.equal(await collect(filterCsvStream([noBody], QUERY)), H + "\n");
});

test("filterCsvStream: bbox filter is inclusive on all four edges and drops outside rows", async () => {
  const bbox = { w: -9, s: 39, e: -7, n: 41 };
  const rows = [
    H,
    row("2025-01-01", 39, -9), // SW corner: kept
    row("2025-01-01", 41, -7), // NE corner: kept
    row("2025-01-01", 40, -8), // inside
    row("2025-01-01", 38.99, -8), // south of box
    row("2025-01-01", 41.01, -8), // north of box
    row("2025-01-01", 40, -9.01), // west of box
    row("2025-01-01", 40, -6.99), // east of box
  ];
  const out = await run([lf(rows)], { from: "2025-01-01", to: "2025-01-01", bbox }, mulberry32(3), 6);
  assert.equal(out, lf([H, rows[1], rows[2], rows[3]]));
});

test("filterCsvStream: bbox applied together with the date range", async () => {
  const bbox = { w: -9, s: 39, e: -7, n: 41 };
  const out = await run([lf(FILE_A), lf(FILE_B)], { ...QUERY, bbox }, mulberry32(11), 9);
  assert.equal(
    out,
    lf([H, row("2024-12-30", 40, -8), row("2024-12-31", 41, -7.5), row("2025-01-01", 39, -9), row("2025-01-02", 40, -8)]),
  );
});

test("filterCsvStream: stops reading a file once a row's date > to", async () => {
  const lines = [H, row("2025-01-01", 40, -8), row("2025-01-02", 40, -8), row("2025-01-03", 40, -8)];
  for (let i = 0; i < 200; i++) lines.push(row("2025-02-01", 40, -8)); // far past the cut
  // One line per chunk so the cut point is a known chunk index.
  const chunks = lines.map((l) => new TextEncoder().encode(l + "\n"));
  const stats = { pulls: 0, cancelled: false };
  const out = await collect(filterCsvStream([resp(chunks, stats)], { from: "2025-01-01", to: "2025-01-02", bbox: null }));
  assert.equal(out, lf(lines.slice(0, 3)));
  // Header + 3 rows reach the cut at chunk 4; allow a little slack for stream read-ahead, never the 200 extra.
  assert.ok(stats.pulls <= 6, `source pulled ${stats.pulls} times of ${chunks.length}`);
  assert.equal(stats.cancelled, true);
});

test("filterCsvStream: stopping file A does not stop file B", async () => {
  const a = lf([H, row("2025-01-05", 0, 0)]); // already past `to`
  const b = lf([H, row("2025-01-01", 0, 0)]);
  const out = await run([a, b], { from: "2025-01-01", to: "2025-01-02", bbox: null }, mulberry32(2), 3);
  assert.equal(out, lf([H, row("2025-01-01", 0, 0)]));
});

test("filterCsvStream: cancelling the output cancels the upstream sources", async () => {
  const s1 = { pulls: 0, cancelled: false };
  const s2 = { pulls: 0, cancelled: false };
  const out = filterCsvStream(
    [resp(chunkify(lf(FILE_A), mulberry32(1), 1000), s1), resp(chunkify(lf(FILE_B), mulberry32(1), 1000), s2)],
    QUERY,
  );
  const r = out.getReader();
  await r.read(); // header
  await r.read(); // rows from file A
  await r.cancel();
  assert.equal(s1.cancelled, true);
  assert.equal(s2.cancelled, true);
});

test("filterCsvStream: an upstream read error errors the output stream", async () => {
  const failing = new ReadableStream<Uint8Array>({
    pull() {
      throw new Error("boom");
    },
  });
  const s = filterCsvStream([{ body: failing } as unknown as Response], QUERY);
  await assert.rejects(collect(s), /boom/);
});

// ---- parseHotspotQuery ----

const qs = (o: Record<string, string>) => new URLSearchParams(o);
const base = { region: "punjab", from: "2025-01-01", to: "2025-01-31" };
const bad = (o: Record<string, string>) =>
  assert.throws(
    () => parseHotspotQuery(qs(o)),
    (e: unknown) => e instanceof ApiError && e.status === 400,
    JSON.stringify(o),
  );

test("parseHotspotQuery: valid full query parses to the expected object", () => {
  const q = parseHotspotQuery(qs({ ...base, from: "2025-12-01", to: "2026-01-31", bbox: "-9.5,36.9,-6.1,42.2" }));
  assert.deepEqual(q, {
    region: "punjab",
    from: "2025-12-01",
    to: "2026-01-31",
    years: [2025, 2026],
    bbox: { w: -9.5, s: 36.9, e: -6.1, n: 42.2 },
  });
});

test("parseHotspotQuery: no bbox gives null, single-day span works", () => {
  const q = parseHotspotQuery(qs({ region: "a-b1", from: "2025-03-04", to: "2025-03-04" }));
  assert.equal(q.bbox, null);
  assert.deepEqual(q.years, [2025]);
});

test("parseHotspotQuery: span is inclusive; 366 days OK, 367 rejected (leap year)", () => {
  assert.equal(MAX_SPAN_DAYS, 366);
  // 2016 is a leap year: Jan 1..Dec 31 is exactly 366 days inclusive.
  assert.doesNotThrow(() => parseHotspotQuery(qs({ ...base, from: "2016-01-01", to: "2016-12-31" })));
  // One more day = 367 days.
  bad({ ...base, from: "2016-01-01", to: "2017-01-01" });
  // Non-leap: 365 days OK, 366 days (to 2018-01-01) OK, 367 rejected.
  assert.doesNotThrow(() => parseHotspotQuery(qs({ ...base, from: "2017-01-01", to: "2017-12-31" })));
  assert.doesNotThrow(() => parseHotspotQuery(qs({ ...base, from: "2017-01-01", to: "2018-01-01" })));
  bad({ ...base, from: "2017-01-01", to: "2018-01-02" });
});

test("parseHotspotQuery: years list spans year boundaries", () => {
  const q = parseHotspotQuery(qs({ ...base, from: "2016-12-31", to: "2017-01-01" }));
  assert.deepEqual(q.years, [2016, 2017]);
});

test("parseHotspotQuery: from after to is 400", () => {
  bad({ ...base, from: "2025-02-01", to: "2025-01-31" });
});

test("parseHotspotQuery: invalid or missing dates are 400", () => {
  for (const v of ["2017-02-29", "2025-13-01", "2025-1-1", "", "2025-01-32", "20250101", "2025-01-01T00:00"]) {
    bad({ ...base, from: v });
    bad({ ...base, to: v });
  }
  bad({ region: "punjab", to: "2025-01-31" });
  bad({ region: "punjab", from: "2025-01-01" });
});

test("parseHotspotQuery: bad bbox is 400", () => {
  for (const b of [
    "1,2,3",
    "1,2,3,4,5",
    "a,b,c,d",
    "1,2,3,",
    "-5,-5,5,", // empty north must be rejected, not read as 0
    "0,,1,1", // empty south
    "",
    "NaN,0,1,1",
    "Infinity,0,1,1",
    "5,0,5,1", // w == e
    "6,0,5,1", // w > e
    "0,5,1,5", // s == n
    "0,6,1,5", // s > n
    "-181,0,1,1",
    "0,0,181,1",
    "0,-91,1,1",
    "0,0,1,91",
  ]) {
    bad({ ...base, bbox: b });
  }
});

test("parseHotspotQuery: bad region is 400", () => {
  for (const r of ["Portugal", "../x", "", "a/b", "a b", "a_b"]) bad({ ...base, region: r });
  bad({ from: base.from, to: base.to });
});

// ---- small helpers ----

test("parseBbox: null in, null out; full-world bbox is valid", () => {
  assert.equal(parseBbox(null), null);
  assert.deepEqual(parseBbox("-180,-90,180,90"), { w: -180, s: -90, e: 180, n: 90 });
  assert.deepEqual(parseBbox(" 1 , 2 , 3 , 4 "), { w: 1, s: 2, e: 3, n: 4 });
});

test("HOTSPOT_HEADER matches the registered CSV header", () => {
  assert.equal(HOTSPOT_HEADER, "date,time_utc,lat,lon,satellite,confidence,frp_mw,daynight");
});

test("errorResponse: ApiError keeps its status and JSON {error}; others give 500", async () => {
  const r = errorResponse(new ApiError(400, "nope"));
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: "nope" });
  const r2 = errorResponse(new Error("secret detail"));
  assert.equal(r2.status, 500);
  assert.deepEqual(await r2.json(), { error: "internal error" });
});
