import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyPixels,
  countedSensor,
  dayPoints,
  gibsUrl,
  imageSize,
  LAYERS,
  layersFor,
  parsePeaks,
  PeaksFormatError,
  resolveDay,
  shiftDay,
  toPixel,
  topDays,
  type Bbox,
  type Peaks,
} from "./space.ts";

const PORTUGAL: Bbox = [-10.0, 36.9, -6.0, 42.2];
const ids = (day: string) => layersFor(day).map((l) => l.id);

test("layersFor: satellite by date, best first, with the FE-023 boundaries", () => {
  assert.deepEqual(ids("2001-08-01"), [LAYERS.terra.id]);
  assert.equal(ids("2002-07-02")[0], LAYERS.terra.id);
  assert.equal(ids("2002-07-03")[0], LAYERS.aqua.id);
  assert.equal(ids("2012-06-01")[0], LAYERS.aqua.id);
  assert.equal(ids("2015-11-23")[0], LAYERS.aqua.id);
  assert.equal(ids("2015-11-24")[0], LAYERS.snpp.id);
  assert.equal(ids("2017-10-15")[0], LAYERS.snpp.id);
  assert.equal(ids("2026-11-02")[0], LAYERS.snpp.id);
  assert.equal(ids("2026-11-03")[0], LAYERS.noaa20.id);
});

test("layersFor: fallbacks only include layers that cover the day", () => {
  assert.ok(!ids("2010-01-01").includes(LAYERS.noaa20.id));
  assert.ok(ids("2019-01-01").includes(LAYERS.noaa20.id));
  assert.ok(!ids("2026-11-10").includes(LAYERS.snpp.id));
  assert.ok(ids("2026-11-10").includes(LAYERS.noaa21.id));
  assert.ok(!ids("2020-01-01").includes(LAYERS.noaa21.id));
  assert.equal(new Set(ids("2017-10-15")).size, ids("2017-10-15").length);
});

test("gibsUrl: WMS 1.3.0 GetMap, EPSG:4326 in lat,lon order, size from the box", () => {
  const u = new URL(gibsUrl(LAYERS.terra, PORTUGAL, "2017-10-15", 800));
  assert.equal(u.origin + u.pathname, "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi");
  const q = Object.fromEntries(u.searchParams);
  assert.equal(q.VERSION, "1.3.0");
  assert.equal(q.CRS, "EPSG:4326");
  assert.equal(q.BBOX, "36.9,-10,42.2,-6");
  assert.equal(q.LAYERS, "MODIS_Terra_CorrectedReflectance_TrueColor");
  assert.equal(q.TIME, "2017-10-15");
  assert.equal(q.WIDTH, "800");
  assert.equal(q.HEIGHT, "1060");
  assert.equal(q.FORMAT, "image/jpeg");
  assert.deepEqual(imageSize(PORTUGAL, 1000), { width: 1000, height: 1325 });
});

test("toPixel: linear mapping, north at the top, null outside the box", () => {
  const size = { width: 400, height: 530 };
  assert.deepEqual(toPixel(42.2, -10.0, PORTUGAL, size), [0, 0]);
  assert.deepEqual(toPixel(36.9, -6.0, PORTUGAL, size), [400, 530]);
  const [x, y] = toPixel(39.55, -8.0, PORTUGAL, size)!;
  assert.ok(Math.abs(x - 200) < 1e-9 && Math.abs(y - 265) < 1e-9);
  assert.equal(toPixel(43, -8, PORTUGAL, size), null);
  assert.equal(toPixel(40, -11, PORTUGAL, size), null);
});

const pixels = (rgb: [number, number, number][]) => rgb.flatMap(([r, g, b]) => [r, g, b, 255]);

test("classifyPixels: blank (GIBS missing day), cloudy, ok", () => {
  assert.equal(classifyPixels(pixels(Array(100).fill([0, 0, 0]))), "blank");
  assert.equal(classifyPixels(pixels([...Array(99).fill([0, 0, 0]), [120, 90, 60]])), "blank");
  assert.equal(classifyPixels(pixels([...Array(70).fill([230, 232, 235]), ...Array(30).fill([110, 90, 60])])), "cloudy");
  assert.equal(classifyPixels(pixels([...Array(50).fill([230, 232, 235]), ...Array(50).fill([110, 90, 60])])), "ok");
  assert.equal(classifyPixels(pixels(Array(100).fill([250, 140, 40]))), "ok");
  assert.equal(classifyPixels([]), "blank");
});

const PEAKS: Peaks = {
  region: "portugal",
  sensors: ["modis", "snpp", "noaa20"],
  snpp_from: "2012-01-20",
  snpp_through: "2026-11-02",
  noaa20_through: "2026-11-14",
  last_day: "2026-11-14",
  months: [
    { month: "2017-10", peak: [16, 2685, 1], top3: [[16, 2685, 1], [15, 1629, 1], [8, 557, 1]] },
    { month: "2001-01", peak: null, top3: [] },
  ],
};

test("topDays: dates rebuilt from month + day, sensors by index; empty for a month without detections", () => {
  assert.deepEqual(topDays(PEAKS, 2017, 10), [
    { date: "2017-10-16", count: 2685, sensor: "snpp" },
    { date: "2017-10-15", count: 1629, sensor: "snpp" },
    { date: "2017-10-08", count: 557, sensor: "snpp" },
  ]);
  assert.deepEqual(topDays(PEAKS, 2001, 1), []);
  assert.deepEqual(topDays(PEAKS, 1999, 1), []);
});

test("countedSensor: peaks.json's own boundaries", () => {
  assert.equal(countedSensor(PEAKS, "2012-01-19"), "modis");
  assert.equal(countedSensor(PEAKS, "2012-01-20"), "snpp");
  assert.equal(countedSensor(PEAKS, "2026-11-02"), "snpp");
  assert.equal(countedSensor(PEAKS, "2026-11-03"), "noaa20");
});

test("parsePeaks: rejects files that aren't peaks.json", () => {
  assert.equal(parsePeaks(PEAKS).region, "portugal");
  assert.throws(() => parsePeaks(null), PeaksFormatError);
  assert.throws(() => parsePeaks({ months: [] }), PeaksFormatError);
  assert.throws(() => parsePeaks({ ...PEAKS, snpp_from: undefined }), PeaksFormatError);
});

test("dayPoints: only the day and the counted sensor's satellites, so dots match the count", () => {
  const csv = [
    "date,time_utc,lat,lon,satellite,confidence,frp_mw,daynight",
    "2017-10-16,0130,40.1,-8.2,SNPP,n,3.1,N",
    "2017-10-16,0200,40.15,-8.25,NOAA21,n,2.0,N",
    "2017-10-16,1110,40.2,-8.3,Terra,80,5.0,D",
    "2017-10-16,1330,40.3,-8.4,Aqua,70,4.0,D",
    "2017-10-15,0130,40.4,-8.5,SNPP,h,2.0,N",
    "2017-10-16,0145,bad,-8.6,SNPP,n,1.0,N",
    "",
  ].join("\r\n");
  assert.deepEqual(dayPoints(csv, "2017-10-16", "snpp"), [{ lat: 40.1, lon: -8.2 }]);
  assert.deepEqual(dayPoints(csv, "2017-10-16", "modis"), [
    { lat: 40.2, lon: -8.3 },
    { lat: 40.3, lon: -8.4 },
  ]);
  assert.deepEqual(dayPoints(csv, "2017-10-16", "noaa20"), []);
  assert.deepEqual(dayPoints("no,header\n", "2017-10-16", "snpp"), []);
});

test("shiftDay: across month, year and leap day", () => {
  assert.equal(shiftDay("2017-10-31", 1), "2017-11-01");
  assert.equal(shiftDay("2017-01-01", -1), "2016-12-31");
  assert.equal(shiftDay("2016-02-28", 1), "2016-02-29");
});

test("layersFor: every layer's first day is a boundary, and the full fallback order", () => {
  assert.deepEqual(layersFor("2000-02-23"), []);
  assert.deepEqual(ids("2000-02-24"), [LAYERS.terra.id]);
  assert.ok(!ids("2018-01-04").includes(LAYERS.noaa20.id));
  assert.ok(ids("2018-01-05").includes(LAYERS.noaa20.id));
  assert.ok(!ids("2023-02-09").includes(LAYERS.noaa21.id));
  assert.deepEqual(ids("2017-10-15"), [LAYERS.snpp.id, LAYERS.aqua.id, LAYERS.terra.id]);
  assert.deepEqual(ids("2019-06-01"), [LAYERS.snpp.id, LAYERS.aqua.id, LAYERS.noaa20.id, LAYERS.terra.id]);
  assert.deepEqual(ids("2010-06-01"), [LAYERS.aqua.id, LAYERS.terra.id]);
  assert.deepEqual(ids("2026-11-03"), [LAYERS.noaa20.id, LAYERS.noaa21.id, LAYERS.aqua.id, LAYERS.terra.id]);
});

test("layersFor: after the S-NPP end, NOAA-21 is listed only from its first day", () => {
  assert.equal(LAYERS.noaa21.first, "2023-02-10");
  assert.equal(LAYERS.snpp.last, "2026-11-02");
  assert.equal(ids("2026-11-10")[1], LAYERS.noaa21.id);
});

test("imageSize: height is rounded, not floored", () => {
  assert.equal(imageSize([0, 0, 3, 1], 1000).height, 333);
  assert.equal(imageSize([0, 0, 3, 2], 1000).height, 667);
});

test("classifyPixels: bright saturated colours are not cloud; partly black images are still shown", () => {
  assert.equal(classifyPixels(pixels(Array(100).fill([250, 250, 210]))), "ok");
  assert.equal(classifyPixels(pixels(Array(100).fill([150, 150, 150]))), "ok");
  assert.equal(classifyPixels(pixels([...Array(90).fill([0, 0, 0]), ...Array(10).fill([110, 90, 60])])), "ok");
  assert.equal(classifyPixels(pixels([...Array(60).fill([0, 0, 0]), ...Array(40).fill([110, 90, 60])])), "ok");
  assert.equal(classifyPixels(pixels(Array(100).fill([10, 10, 10]))), "ok");
  assert.equal(classifyPixels(pixels(Array(100).fill([5, 5, 5]))), "blank");
  assert.equal(classifyPixels(pixels(Array(100).fill([230, 150, 150]))), "ok");
  assert.equal(classifyPixels(pixels(Array(100).fill([215, 195, 195]))), "ok");
  assert.equal(classifyPixels(pixels(Array(100).fill([150, 230, 230]))), "ok");
});

test("resolveDay: picks follow the opened month even across months; a new month or region resets to its peak", () => {
  const top = topDays(PEAKS, 2017, 10);
  const min = "2001-01-01", max = "2026-11-14";
  assert.equal(resolveDay(null, "2017-10", "portugal", top, min, max), "2017-10-16");
  assert.equal(resolveDay({ open: "2017-10", region: "portugal", day: "2017-11-01" }, "2017-10", "portugal", top, min, max), "2017-11-01");
  assert.equal(resolveDay({ open: "2017-10", region: "portugal", day: "2017-09-30" }, "2017-10", "portugal", top, min, max), "2017-09-30");
  assert.equal(resolveDay({ open: "2017-10", region: "portugal", day: "2017-10-08" }, "2001-01", "portugal", [], min, max), "2001-01-01");
  assert.equal(resolveDay({ open: "2017-10", region: "ghana", day: "2017-10-08" }, "2017-10", "portugal", top, min, max), "2017-10-16");
  assert.equal(resolveDay(null, "2005-03", "portugal", [], min, max), "2005-03-01");
  assert.equal(resolveDay(null, "2026-12", "portugal", [], min, max), "2026-11-14");
  assert.equal(resolveDay(null, "2000-11", "portugal", [], min, max), "2001-01-01");
  assert.equal(resolveDay({ open: "2026-11", region: "portugal", day: "2026-11-20" }, "2026-11", "portugal", [], min, max), "2026-11-14");
});

test("parsePeaks: needs the months array", () => {
  assert.throws(() => parsePeaks({ ...PEAKS, months: undefined }), PeaksFormatError);
  assert.throws(() => parsePeaks({ ...PEAKS, sensors: "modis" }), PeaksFormatError);
});

