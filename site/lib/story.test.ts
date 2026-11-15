// Tests for lib/story.ts (FE-018): synthetic detections, plus the published Portugal 2017 points and annual files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { VIIRS_FROM, type Annual } from "./annual.ts";
import {
  bigCount,
  closestPair,
  extent,
  jumpVerb,
  metricFrame,
  parsePoints,
  passes,
  STORY_FIRE,
  storyLines,
  utc,
  type Detection,
} from "./story.ts";

const HEADER = "date,time_utc,lat,lon,satellite,confidence,frp_mw,daynight";
const det = (time: string, satellite: string, lat = 40, lon = -8, daynight = "D", date = "2017-06-18"): Detection => ({
  date, time, lat, lon, satellite, daynight,
});

test("parsePoints reads the published column layout and pads times", () => {
  const rows = parsePoints(`${HEADER}\n2017-06-18,253,40.1,-8.2,Aqua,80,12.5,D\n\n`);
  assert.deepEqual(rows, [{ date: "2017-06-18", time: "0253", lat: 40.1, lon: -8.2, satellite: "Aqua", daynight: "D" }]);
});

test("passes joins one satellite's detections a minute or two apart and splits the rest", () => {
  const p = passes([det("0147", "Aqua"), det("0148", "Aqua"), det("0230", "Aqua"), det("0147", "SNPP")]);
  assert.deepEqual(p.map((x) => [x.satellite, x.time, x.points.length]), [["Aqua", "0147", 2], ["Aqua", "0230", 1], ["SNPP", "0147", 1]]);
});

test("closestPair picks the daytime MODIS and VIIRS passes nearest in time, inside the box", () => {
  const many = (n: number, time: string, sat: string, dn = "D", lat = 40) => Array.from({ length: n }, () => det(time, sat, lat, -8, dn));
  const rows = [
    ...many(50, "1113", "Terra"), // 2 h 15 min from VIIRS
    ...many(30, "1253", "Aqua"), // 35 min: chosen
    ...many(200, "1328", "SNPP"),
    ...many(900, "0205", "SNPP", "N"), // night, ignored
    ...many(10, "1254", "Aqua", "D", 45), // outside the box
  ];
  const pair = closestPair(rows, "2017-06-18", { w: -9, s: 39, e: -7, n: 41 })!;
  assert.equal(pair.modis.time, "1253");
  assert.equal(pair.modis.points.length, 30);
  assert.equal(pair.viirs.time, "1328");
  assert.equal(pair.gapMinutes, 35);
  assert.ok(Math.abs(pair.ratio - 200 / 30) < 1e-9);
  assert.equal(closestPair(rows, "2017-06-19", { w: -9, s: 39, e: -7, n: 41 }), null);
});

test("metricFrame measures about 111 km per degree of latitude and shrinks longitude by cos(lat)", () => {
  const f = metricFrame({ w: 0, s: 59.5, e: 1, n: 60.5 });
  assert.ok(Math.abs(f.height - 111_195) < 50);
  assert.ok(Math.abs(f.width - 111_195 * Math.cos(Math.PI / 3)) < 50);
  assert.deepEqual(f.project([60.5, 0]), [0, 0]);
  const pad = extent([[40, -8]], 1000);
  assert.ok(Math.abs(metricFrame(pad).height - 2000) < 1);
});

test("storyLines drops the partial year and stitches MODIS to VIIRS at VIIRS_FROM", () => {
  const years = [VIIRS_FROM - 2, VIIRS_FROM - 1, VIIRS_FROM, VIIRS_FROM + 1, VIIRS_FROM + 2];
  const D = {
    years,
    modis: [100, 110, 120, 130, 10],
    viirs: [null, null, 380, 400, 30],
    pred: [300, 320, 350, 390, 40],
    lo: [250, 270, 300, 340, 20],
    hi: [350, 370, 400, 440, 60],
    harmonized: [300, 320, 390, 400, 30],
    partial: [0, 0, 0, 0, 1],
  } as unknown as Annual;
  const L = storyLines(D);
  assert.deepEqual(L.years, years.slice(0, 4));
  assert.deepEqual(L.raw, [100, 110, 390, 400]);
  assert.deepEqual(L.harmonized, [300, 320, 390, 400]);
  assert.deepEqual(L.lo, [250, 270, null, null]);
  assert.equal(L.jumpAt, 2);
});

test("copy helpers", () => {
  assert.equal(jumpVerb(4.08), "quadruple");
  assert.equal(jumpVerb(2.1), "double");
  assert.equal(jumpVerb(2.5), "rise ×2.5");
  assert.equal(bigCount(4_216_096), "4.2 million");
  assert.equal(bigCount(186_439), "186,439");
  assert.equal(utc("1253"), "12:53 UTC");
});

const POINTS = new URL(`../public/data/${STORY_FIRE.region}/points/${STORY_FIRE.date.slice(0, 4)}.csv`, import.meta.url);

test("the published 2017 points give the story's Aqua and S-NPP passes over Pedrógão Grande", { skip: !existsSync(POINTS) }, () => {
  const pair = closestPair(parsePoints(readFileSync(POINTS, "utf8")), STORY_FIRE.date, STORY_FIRE.bbox)!;
  assert.equal(pair.modis.satellite, "Aqua");
  assert.equal(pair.viirs.satellite, "SNPP");
  assert.ok(pair.gapMinutes <= 60, `passes ${pair.gapMinutes} min apart`);
  // MODIS sees a handful of 1 km pixels, VIIRS several times as many 375 m pixels (area ratio ~7)
  assert.ok(pair.ratio > 3 && pair.ratio < 12, `ratio ${pair.ratio}`);
});

for (const region of ["portugal", "ghana", "punjab"]) {
  const file = new URL(`../public/data/${region}/annual.json`, import.meta.url);
  test(`storyLines on the published ${region} annual.json: no partial year, raw jumps at ${VIIRS_FROM}`, { skip: !existsSync(file) }, () => {
    const D = JSON.parse(readFileSync(file, "utf8")) as Annual;
    const L = storyLines(D);
    assert.ok(L.jumpAt > 0);
    assert.equal(L.years.length, L.raw.length);
    assert.ok(L.years.every((y) => D.partial[D.years.indexOf(y)] === 0));
    assert.ok(L.raw.every((v) => Number.isFinite(v) && v >= 0));
    assert.ok(L.lo.slice(0, L.jumpAt).every((v) => v != null));
  });
}
