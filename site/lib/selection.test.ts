// Run with `npm test`. The ?region=&from=&to= selection shared by the Record and Calendar views (FE-004).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { MAX_SPAN_DAYS as SERVER_MAX } from "./server-data.ts";
import {
  hotspotsUrl,
  isDate,
  MAX_SPAN_DAYS,
  moveEnd,
  parseSelection,
  pointFileUrl,
  seriesUrl,
  spanDays,
  withSelection,
  yearRange,
  yearsBefore,
  yearsIn,
  type Bounds,
} from "./selection.ts";

const B: Bounds = { min: "2001-01-01", max: "2025-12-31" };
const parse = (q: string) => parseSelection(new URLSearchParams(q), () => B);

test("no query: portugal, whole record", () => {
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
