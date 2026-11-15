// Picture downloads (FE-015): SVG builders. Run with `npm test` (or `node --test lib/picture.test.ts` on Windows).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calendarBody, composePicture, esc, FIRMS_CREDIT, pictureName, wrap, type PictureTheme } from "./picture.ts";
import { buildGrid, parseSeries, sliceGrid } from "./series.ts";

const theme: PictureTheme = { bg: "#ffffff", fg: "#111111", muted: "#eeeeee", mutedFg: "#666666", border: "#dddddd" };
const fixture = parseSeries(JSON.parse(readFileSync(new URL("../fixtures/series.portugal.sample.json", import.meta.url), "utf8")));

/** Text content of every <text>/<tspan>, tags stripped, entities decoded. */
const texts = (svg: string) =>
  [...svg.matchAll(/<text[^>]*>(.*?)<\/text>/g)].map((m) =>
    m[1].replace(/<[^>]+>/g, "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"),
  );

test("esc escapes the five XML characters", () => {
  assert.equal(esc(`a<b>&"c'`), "a&lt;b&gt;&amp;&quot;c&#39;");
});

test("wrap keeps every word, in order, and respects the width", () => {
  const lines = wrap(FIRMS_CREDIT, 400, 11);
  assert.ok(lines.length > 1);
  assert.equal(lines.join(" "), FIRMS_CREDIT);
  const perLine = Math.floor(400 / (11 * 0.53));
  for (const l of lines) assert.ok(l.length <= perLine || !l.includes(" "), l);
});

test("composePicture: standalone SVG with title, subtitle, legend, body, note and the full FIRMS credit", () => {
  const pic = composePicture({
    title: "Annual active-fire detections, Ghana",
    subtitle: "Harmonized ledger, 2001-2026",
    legend: [
      { color: "#cc3300", label: "Back-cast", kind: "line" },
      { color: "#cc3300", label: "Hold-out", kind: "dash" },
      { color: "#000000", label: "2026 to 2 Nov, partial year", kind: "ring" },
    ],
    body: '<path d="M0 0L800 380" stroke="#cc3300"/>',
    bodyWidth: 800,
    bodyHeight: 380,
    note: "Hold-out 2020-2025: mean annual error 4.0% & more <here>.",
    theme,
  });
  assert.match(pic.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="960" height="\d+" viewBox="0 0 960 \d+">/);
  assert.ok(pic.svg.endsWith("</svg>"));
  assert.equal(pic.width, 960);
  assert.ok(pic.height > 380 * (896 / 800), "body fits inside the picture");
  assert.match(pic.svg, new RegExp(`height="${pic.height}"`));
  assert.match(pic.svg, /<rect width="100%" height="100%" fill="#ffffff"\/>/, "opaque background");
  assert.match(pic.svg, /viewBox="0 0 800 380"/, "body keeps its own coordinates");
  assert.match(pic.svg, /stroke-dasharray="5 3"/, "dash legend mark");
  assert.match(pic.svg, /<circle [^>]*stroke="#000000"/, "ring legend mark");
  const all = texts(pic.svg);
  assert.ok(all.includes("Annual active-fire detections, Ghana"));
  assert.ok(all.includes("Harmonized ledger, 2001-2026"));
  assert.ok(all.includes("Back-cast") && all.includes("Hold-out"));
  assert.equal(all.filter((t) => FIRMS_CREDIT.includes(t)).join(" "), FIRMS_CREDIT, "credit is complete");
  assert.ok(all.join(" ").includes("mean annual error 4.0% & more <here>."), "note text is escaped, not dropped");
  assert.ok(!/[–—]/.test(pic.svg), "no en/em dashes in picture copy");
  assert.ok(!pic.svg.includes("var(--"), "no CSS variables");
});

test("composePicture wraps a long legend onto more rows (taller picture)", () => {
  const base = { title: "t", subtitle: "s", body: "", bodyWidth: 800, bodyHeight: 380, theme };
  const one = composePicture({ ...base, legend: [{ color: "#000", label: "a" }] });
  const many = composePicture({ ...base, legend: Array.from({ length: 12 }, (_, i) => ({ color: "#000", label: `legend item number ${i}` })) });
  assert.ok(many.height > one.height);
});

test("calendarBody: one row per visible year, values, flags, no-data hatch, dimmed months, median rows", () => {
  const grid = sliceGrid(buildGrid(fixture), "2024-03-01", "2025-12-31");
  const cells: number[] = [];
  const body = calendarBody(grid, fixture.calendar, {
    theme,
    cell: (v) => {
      cells.push(v);
      return { bg: "#ff8800", ink: "#000000" };
    },
  });
  assert.deepEqual(grid.years, [2024, 2025]);
  const all = texts(body.body);
  assert.ok(all.includes("2024") && all.includes("2025"));
  for (const m of ["Jan", "Jun", "Dec"]) assert.ok(all.includes(m));
  const values = grid.rows.flat().filter((c) => c.value != null);
  // one colour lookup per valued cell, plus 12 median cells when the statistics exist
  assert.equal(cells.length, values.length + (fixture.calendar ? 12 : 0));
  // months Jan-Feb 2024 are outside the selection: drawn faded
  assert.equal((body.body.match(/opacity="0\.35"/g) ?? []).length, grid.rows.flat().filter((c) => !c.inRange).length);
  assert.equal(body.width, 78 + 12 * 55);
  assert.ok(body.height > 2 * 27);
  if (fixture.calendar) {
    assert.ok(all.includes("Median") && all.includes("Middle half"));
    const flagged = values.filter((c) => c.flag !== 0).length;
    assert.equal((body.body.match(/<path d="M[^"]+Z" fill="#000000"\/>/g) ?? []).length, flagged, "one mark per flagged month");
  }
});

test("calendarBody: months with no data use the hatch pattern and the partial label shows", () => {
  const grid = buildGrid({ ...fixture, monthly: { ...fixture.monthly } });
  const last = grid.rows.at(-1)!;
  const empty = last.filter((c) => c.value == null).length;
  const body = calendarBody(grid, undefined, { theme, cell: () => ({ bg: "#ff8800", ink: "#000" }) });
  assert.equal((body.body.match(/fill="url\(#nodata\)"/g) ?? []).length, grid.rows.flat().filter((c) => c.value == null).length);
  if (empty > 0) assert.match(body.body, /> partial<\/tspan>/);
  assert.ok(!texts(body.body).includes("Median"), "no statistics, no median row");
});

test("pictureName is lower case and filesystem-safe", () => {
  assert.equal(pictureName("record", "NW India (Punjab, Haryana)", "raw", "2001-2026"), "record_nw-india-punjab-haryana_raw_2001-2026");
  assert.equal(pictureName("calendar", "ghana", "2001-01-01", "2026-11-02"), "calendar_ghana_2001-01-01_2026-11-02");
});

test("calendarBody week view (FE-016): 52 unlabelled cells per row, month headers, dashed partial week, no median", () => {
  const b = structuredClone(fixture);
  const n = 52 + 20;
  b.weekly = {
    start_year: 2001,
    weeks_per_year: 52,
    modis: Array(n).fill(1),
    viirs: Array(n).fill(null),
    pred: Array.from({ length: n }, (_, i) => 100 + i),
    lo: Array(n).fill(1),
    hi: Array(n).fill(9),
    last_week_days: 4,
  };
  const grid = buildGrid(b, "week");
  const body = calendarBody(grid, fixture.calendar, { theme, cell: () => ({ bg: "#ff8800", ink: "#000" }) });
  const t = texts(body.body);
  assert.deepEqual(t.filter((s) => /^[A-Z][a-z]{2}$/.test(s)), ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);
  assert.ok(!t.some((s) => /^\d/.test(s) && !/^20\d\d/.test(s)), "no value labels in week cells");
  assert.ok(!t.includes("Median"), "monthly statistics are not drawn on weeks");
  assert.equal((body.body.match(/fill="#ff8800"/g) ?? []).length, n);
  assert.equal((body.body.match(/fill="url\(#nodata\)"/g) ?? []).length, 52 * 2 - n);
  assert.equal((body.body.match(/stroke-dasharray/g) ?? []).length, 1);
  assert.equal(body.width, 78 + 52 * 16);
});

test("calendar picture: a bar along the bottom of forward-link periods only (FE-009)", () => {
  const b = structuredClone(fixture);
  const n = b.monthly.modis.length;
  b.monthly.source = Array.from({ length: n }, (_, i) => (i >= n - 2 ? "forward" : b.monthly.viirs[i] == null ? "backcast" : "observed"));
  const body = calendarBody(buildGrid(b), undefined, { theme, cell: () => ({ bg: "#ff8800", ink: "#123456" }) });
  // the bar is the only element drawn in the ink colour as a 2-px-high rect
  assert.equal((body.body.match(/height="2" rx="1" fill="#123456"/g) ?? []).length, 2);
  const none = calendarBody(buildGrid(fixture), undefined, { theme, cell: () => ({ bg: "#ff8800", ink: "#123456" }) });
  assert.equal((none.body.match(/height="2" rx="1"/g) ?? []).length, 0);
});
