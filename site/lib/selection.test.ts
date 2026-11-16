import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { MAX_SPAN_DAYS as SERVER_MAX } from "./server-data.ts";
import { parseBbox } from "./server-data.ts";
import {
  boxError,
  boxesOverlap,
  boxLabel,
  hotspotsUrl,
  parseBox,
  regionBox,
  withBox,
  isDate,
  MAX_SPAN_DAYS,
  moveEnd,
  parseView,
  withView,
  parseSelection,
  pointFileUrl,
  seriesUrl,
  spanDays,
  withSelection,
  yearRange,
  yearsBefore,
  yearsIn,
  type Bounds,
  type Box,
} from "./selection.ts";

const B: Bounds = { min: "2001-01-01", max: "2025-12-31" };
const parse = (q: string) => parseSelection(new URLSearchParams(q), () => B);

test("no query: portugal, whole ledger", () => {
  assert.deepEqual(parse(""), { region: "portugal", from: B.min, to: B.max, whole: true });
});

test("valid query is kept", () => {
  assert.deepEqual(parse("region=ghana&from=2017-08-01&to=2017-08-31"), {
    region: "ghana",
    from: "2017-08-01",
    to: "2017-08-31",
    whole: false,
  });
});

test("unknown region, bad dates, out-of-range and reversed dates are repaired", () => {
  assert.equal(parse("region=toString").region, "portugal");
  assert.equal(parse("from=2017-02-30").from, B.min);
  assert.equal(parse("from=1990-01-01&to=2099-01-01").whole, true);
  const r = parse("from=2020-05-01&to=2019-01-01");
  assert.deepEqual([r.from, r.to], ["2019-01-01", "2020-05-01"]);
});

test("isDate accepts only real YYYY-MM-DD dates", () => {
  assert.ok(isDate("2024-02-29"));
  for (const v of ["2023-02-29", "2024-2-29", "2024-02-29T00:00", "", null, 20240229]) assert.equal(isDate(v), false, String(v));
});

test("withSelection keeps other params and drops dates equal to the bounds", () => {
  const p = new URLSearchParams("region=ghana&x=1&from=2010-01-01");
  assert.equal(withSelection(p, { from: B.min }, B).toString(), "region=ghana&x=1");
  assert.equal(withSelection(p, { region: "punjab", to: "2011-06-30" }, B).toString(), "region=punjab&x=1&from=2010-01-01&to=2011-06-30");
  assert.equal(withSelection(p, { to: "not a date" }, B).get("to"), null);
});

test("span and years", () => {
  assert.equal(spanDays("2024-01-01", "2024-12-31"), 366);
  assert.equal(spanDays("2025-03-10", "2025-03-10"), 1);
  assert.deepEqual(yearsIn("2019-12-31", "2021-01-01"), [2019, 2020, 2021]);
  assert.deepEqual(yearRange(2025, { min: B.min, max: "2025-11-28" }), { from: "2025-01-01", to: "2025-11-28" });
});

test("the client download limit is the one the route handler enforces", () => {
  assert.equal(MAX_SPAN_DAYS, SERVER_MAX);
});

test("download URLs follow the registry contracts", () => {
  const s = parse("region=punjab&from=2018-10-01&to=2018-11-30");
  assert.equal(hotspotsUrl(s), "/api/hotspots?region=punjab&from=2018-10-01&to=2018-11-30");
  assert.equal(seriesUrl(s), "/api/series?region=punjab&res=monthly&from=2018-10&to=2018-11");
  assert.equal(pointFileUrl("ghana", 2017), "/data/ghana/points/2017.csv");
});

test("every published region has a point file for each year in point_years", () => {
  const index = JSON.parse(readFileSync(new URL("../public/data/index.json", import.meta.url), "utf8"));
  for (const r of index.regions) {
    for (const y of r.point_years) {
      assert.ok(existsSync(new URL(`../public${pointFileUrl(r.id, y)}`, import.meta.url)), `${r.id} ${y}`);
    }
  }
});

test("moveEnd: an end that crosses the other one pulls it along", () => {
  const sel = { from: "2010-03-01", to: "2010-06-30" };
  assert.deepEqual(moveEnd(sel, "from", "2010-04-15"), { from: "2010-04-15", to: "2010-06-30" });
  assert.deepEqual(moveEnd(sel, "from", "2015-01-01"), { from: "2015-01-01", to: "2015-01-01" });
  assert.deepEqual(moveEnd(sel, "to", "2010-05-01"), { from: "2010-03-01", to: "2010-05-01" });
  assert.deepEqual(moveEnd(sel, "to", "2005-07-01"), { from: "2005-07-01", to: "2005-07-01" });
});

test("yearsBefore: point files older than the selectable record", () => {
  assert.deepEqual(yearsBefore(B, [2003, 2000, 2001, 2002]), [2000]);
  assert.deepEqual(yearsBefore(B, [2001, 2002]), []);
});

test("calendar view: ?view=week, anything else is month; month drops the parameter (FE-016)", () => {
  assert.equal(parseView(new URLSearchParams("")), "month");
  assert.equal(parseView(new URLSearchParams("view=week")), "week");
  assert.equal(parseView(new URLSearchParams("view=WEEK")), "month");
  assert.equal(parseView(new URLSearchParams("view=day")), "month");
  const q = new URLSearchParams("region=ghana&from=2017-01-01");
  assert.equal(withView(q, "week").toString(), "region=ghana&from=2017-01-01&view=week");
  assert.equal(withView(new URLSearchParams("region=ghana&view=week"), "month").toString(), "region=ghana");
  assert.equal(q.toString(), "region=ghana&from=2017-01-01", "input is not mutated");
  assert.equal(withSelection(new URLSearchParams("view=week"), { region: "punjab" }, B).get("view"), "week");
});

test("box: ?bbox= parses like the route handler, and bad values mean no box (FE-020)", () => {
  const q = (v: string) => parseBox(new URLSearchParams({ bbox: v }));
  assert.deepEqual(q("-9,38.5,-8,39"), { w: -9, s: 38.5, e: -8, n: 39 });
  assert.equal(parseBox(new URLSearchParams("")), null);
  for (const bad of ["", "1,2,3", "1,2,3,4,5", "a,1,2,3", "-8,38,-9,39", "-9,39,-8,38", "-200,0,0,1", "0,-91,1,0", "-9,,-8,39"]) {
    assert.equal(q(bad), null, bad);
    assert.throws(() => parseBbox(bad), /bbox/, `server must reject ${bad} too`);
  }
  for (const good of ["-9,38.5,-8,39", "-180,-90,180,90", "73.75,28.75,77.5,32.5"]) {
    assert.deepEqual(parseBbox(good), q(good), good);
  }
});

test("box: errors name the problem, in the order the form shows the fields", () => {
  assert.equal(boxError({ w: -9, s: 38, e: -8, n: 39 }), null);
  assert.match(boxError({ w: NaN, s: 38, e: -8, n: 39 })!, /all four/);
  assert.match(boxError({ w: -9, s: 38, e: -8, n: 95 })!, /Latitude/);
  assert.match(boxError({ w: -190, s: 38, e: -8, n: 39 })!, /Longitude/);
  assert.match(boxError({ w: -9, s: 39, e: -8, n: 39 })!, /South must be less than north/);
  assert.match(boxError({ w: -8, s: 38, e: -9, n: 39 })!, /West must be less than east/);
});

test("box: withBox sets and clears ?bbox= and keeps the selection; hotspotsUrl carries it", () => {
  const p = new URLSearchParams("region=portugal&from=2017-06-01&to=2017-06-30");
  const b: Box = { w: -8.7, s: 39.6, e: -7.8, n: 40.3 };
  const set = withBox(p, b);
  assert.equal(set.toString(), "region=portugal&from=2017-06-01&to=2017-06-30&bbox=-8.7%2C39.6%2C-7.8%2C40.3");
  assert.deepEqual(parseBox(set), b);
  assert.equal(withBox(set, null).toString(), p.toString());
  assert.equal(withBox(p, { w: 1, s: 0, e: 0, n: 1 }).has("bbox"), false, "an invalid box is never written");
  const s = parse("region=portugal&from=2017-06-01&to=2017-06-30");
  assert.equal(hotspotsUrl(s), "/api/hotspots?region=portugal&from=2017-06-01&to=2017-06-30");
  assert.equal(
    hotspotsUrl(s, b),
    "/api/hotspots?region=portugal&from=2017-06-01&to=2017-06-30&bbox=-8.7%2C39.6%2C-7.8%2C40.3",
  );
  assert.deepEqual(parseBbox(new URL(hotspotsUrl(s, b), "http://x").searchParams.get("bbox")), b);
});

test("box: overlap with the region box (edges inclusive) and the label", () => {
  const pt = regionBox([-10, 36.9, -6, 42.2]);
  assert.ok(boxesOverlap({ w: -9, s: 38, e: -8, n: 39 }, pt));
  assert.ok(boxesOverlap({ w: -12, s: 30, e: 0, n: 50 }, pt), "a box around the whole region");
  assert.ok(boxesOverlap({ w: -6, s: 42.2, e: -5, n: 43 }, pt), "touching corner counts");
  assert.ok(!boxesOverlap({ w: -3.5, s: 4.5, e: 1.5, n: 11.5 }, pt), "Ghana's box misses Portugal");
  assert.equal(boxLabel({ w: -9, s: 38.5, e: -8, n: 39 }), "38.5°N to 39°N, 9°W to 8°W");
  assert.equal(boxLabel({ w: -1.25, s: -0.5, e: 0, n: 0.123456 }), "0.5°S to 0.1235°N, 1.25°W to 0°");
});
