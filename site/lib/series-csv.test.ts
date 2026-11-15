import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isPartial, num, periods, seriesCsv, seriesFilename, type Block } from "./series-csv.ts";

const load = (region: string, file: string) =>
  JSON.parse(readFileSync(new URL(`../public/data/${region}/${file}`, import.meta.url), "utf8"));

test("num: one decimal at most, no float noise", () => {
  assert.equal(num(98026.99999999999), "98027");
  assert.equal(num(146284.34999999998), "146284.3");
  assert.equal(num(253.5), "253.5");
  assert.equal(num(1000), "1000");
  assert.equal(num(-0.04), "0");
  assert.equal(num(null), "");
});

test("filename carries the range", () => {
  assert.equal(seriesFilename("ghana", "weekly", null, null), "series_ghana_weekly.csv");
  assert.equal(seriesFilename("ghana", "monthly", "2020-01", "2025-12"), "series_ghana_monthly_from-2020-01_to-2025-12.csv");
  assert.equal(seriesFilename("punjab", "annual", "2010", null), "series_punjab_annual_from-2010.csv");
  assert.equal(seriesFilename("punjab", "annual", null, "2010"), "series_punjab_annual_to-2010.csv");
});

test("partial: annual from the file, monthly and weekly only the last period, by its days", () => {
  const m: Block = { start_year: 2026, pred: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], last_month_days: 14 };
  assert.equal(isPartial("monthly", m, 10, 11), 1); // 14 of 30 November days
  assert.equal(isPartial("monthly", m, 9, 11), 0);
  assert.equal(isPartial("monthly", { ...m, last_month_days: 30 }, 10, 11), 0);
  assert.equal(isPartial("monthly", { ...m, last_month_days: undefined }, 10, 11), 0);
  // week 51 of 2026 (not a leap year) is days 358-365: 24-31 Dec, 8 days
  const w: Block = { start_year: 2026, pred: Array(52).fill(1), last_week_days: 7 };
  assert.equal(isPartial("weekly", w, 51, 52), 1);
  assert.equal(isPartial("weekly", { ...w, last_week_days: 8 }, 51, 52), 0);
  assert.equal(isPartial("weekly", { ...w, last_week_days: 3 }, 50, 52), 0); // only the last week can be partial
  // leap year: week 51 of 2024 is 23-31 Dec, 9 days
  assert.equal(isPartial("weekly", { start_year: 2024, pred: Array(52).fill(1), last_week_days: 8 }, 51, 52), 1);
  assert.equal(isPartial("weekly", { start_year: 2024, pred: Array(52).fill(1), last_week_days: 9 }, 51, 52), 0);
  assert.equal(isPartial("annual", { start_year: 0, partial: [0, 1] }, 1, 2), 1);
  assert.equal(isPartial("annual", { start_year: 0, partial: [0, 1] }, 0, 2), 0);
});

test("annual CSV on real data: header, rounding, partial 2026, forward source", () => {
  const a = load("ghana", "annual.json");
  const csv = seriesCsv("annual", a, null, null, a.years);
  const [head, ...rows] = csv.trim().split("\n");
  assert.equal(head, "period,modis,viirs,pred,lo,hi,harmonized,source,partial");
  assert.equal(rows.length, a.years.length);
  assert.ok(!/\d\.\d{2,}/.test(csv), "no value has more than one decimal");
  assert.match(rows.at(-1)!, /^2026,.*,forward,1$/);
  assert.match(rows.at(-2)!, /^2025,.*,observed,0$/);
  // a filtered file keeps each year's own partial flag
  const only = seriesCsv("annual", a, "2025", "2026", a.years).trim().split("\n").slice(1);
  assert.deepEqual(only.map((r) => r.split(",")[0] + ":" + r.split(",").at(-1)), ["2025:0", "2026:1"]);
});

test("monthly CSV: range filter, last month partial", () => {
  const b = load("punjab", "series.json");
  const rows = seriesCsv("monthly", b.monthly, "2026-10", null).trim().split("\n").slice(1);
  assert.deepEqual(rows.map((r) => r.split(",")[0]), ["2026-10", "2026-11"]);
  assert.equal(rows[0].split(",").at(-1), "0");
  assert.equal(rows[1].split(",").at(-1), "1"); // November 2026 to 14 Nov
});

test("weekly CSV: week dates, week 51 to 31 Dec, labels unchanged", () => {
  const b = load("portugal", "series.json");
  const csv = seriesCsv("weekly", b.weekly, "2025", "2025");
  const [head, ...rows] = csv.trim().split("\n");
  assert.equal(head, "period,modis,viirs,pred,lo,hi,harmonized,source,partial,week_start,week_end");
  assert.equal(rows.length, 52);
  assert.match(rows[0], /^2025-W00,.*,2025-01-01,2025-01-07$/);
  assert.match(rows[51], /^2025-W51,.*,2025-12-24,2025-12-31$/);
  assert.equal(periods("weekly", b.weekly).length, b.weekly.pred.length);
});
