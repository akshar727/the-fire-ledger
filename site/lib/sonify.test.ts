import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGrid, parseSeries, sliceGrid, type SeriesBundle } from "./series.ts";
import {
  frequency,
  GAP,
  jumpCells,
  jumpTour,
  LOW_HZ,
  MIN_NOTE,
  noteAt,
  OCTAVES,
  rawValues,
  stepSeconds,
  tourSummary,
  YEAR_SECONDS,
} from "./sonify.ts";

const START = 2006, YEARS = 11;
function bundle(): SeriesBundle {
  const n = 12 * YEARS;
  return parseSeries({
    schema: 1,
    region: "test",
    monthly: {
      start_year: START,
      bucketing: "calendar-month",
      modis: Array(n).fill(100),
      viirs: Array.from({ length: n }, (_, i) => (START + Math.floor(i / 12) >= 2012 ? 400 : null)),
      pred: Array(n).fill(400),
      lo: Array(n).fill(300),
      hi: Array(n).fill(500),
    },
  });
}

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("frequency: log scale over OCTAVES octaves from LOW_HZ; zero and missing are silent", () => {
  close(frequency(1000, 1000)!, LOW_HZ * 2 ** OCTAVES);
  close(frequency(5000, 1000)!, LOW_HZ * 2 ** OCTAVES);
  assert.equal(frequency(0, 1000), null);
  assert.equal(frequency(null, 1000), null);
  assert.equal(frequency(10, 0), null);
  const mid = Math.log1p(100) / Math.log1p(10000);
  close(frequency(100, 10000)!, LOW_HZ * 2 ** (OCTAVES * mid));
  assert.ok(frequency(10, 1000)! < frequency(100, 1000)!);
});

test("a year takes the same time in the month and week views", () => {
  close(stepSeconds(12) * 12, YEAR_SECONDS);
  close(stepSeconds(52) * 52, YEAR_SECONDS);
});

test("the tour plays 2009-2014: raw first, then harmonized after a gap", () => {
  const b = bundle(), g = buildGrid(b);
  const t = jumpTour(g, rawValues(b, "month"))!;
  assert.equal(t.switchYear, 2012);
  assert.deepEqual(t.years, [2009, 2014]);
  assert.equal(t.notes.length, 2 * 6 * 12);
  close(t.partStart, 72 * 0.12 + GAP);
  close(t.seconds, t.partStart + 72 * 0.12);
  const raw = t.notes.filter((n) => n.part === 0), harm = t.notes.filter((n) => n.part === 1);
  assert.deepEqual([raw[0].cell.year, raw[0].cell.month, raw[0].row], [2009, 1, 3]);
  close(harm[0].at, t.partStart);
  close(harm[5].at - harm[4].at, 0.12);
});

test("raw jumps up at 2012; harmonized stays level; the VIIRS years sound the same in both", () => {
  const b = bundle();
  const t = jumpTour(buildGrid(b), rawValues(b, "month"))!;
  const raw = t.notes.filter((n) => n.part === 0), harm = t.notes.filter((n) => n.part === 1);
  const dec2011 = 35, jan2012 = 36;
  assert.ok(raw[dec2011].freq! < raw[jan2012].freq!);
  assert.equal(raw[dec2011].value, 100);
  close(harm[dec2011].freq!, harm[jan2012].freq!);
  close(raw[jan2012 + 5].freq!, harm[jan2012 + 5].freq!);
});

test("no tour when the selected dates leave no year before the switch, or miss the switch year", () => {
  const b = bundle(), raw = rawValues(b, "month");
  assert.equal(jumpTour(sliceGrid(buildGrid(b), "2013-01-01", "2016-12-31"), raw), null);
  assert.equal(jumpTour(sliceGrid(buildGrid(b), "2006-01-01", "2011-12-31"), raw), null);
  const t = jumpTour(sliceGrid(buildGrid(b), "2011-06-01", "2016-12-31"), raw)!;
  assert.deepEqual(t.years, [2011, 2014]);
  assert.equal(t.notes.length, 2 * (7 + 3 * 12));
  assert.deepEqual([t.notes[0].cell.month, t.notes[0].row], [6, 0]);
  const nb = bundle();
  nb.monthly.viirs = nb.monthly.viirs.map(() => null);
  assert.equal(jumpCells(buildGrid(nb)), null);
});

test("week view: 52 steps a year, still 1.44 s, notes long enough to hear", () => {
  const b = bundle();
  const n = 52 * YEARS;
  b.weekly = {
    start_year: START,
    weeks_per_year: 52,
    modis: Array(n).fill(25),
    viirs: Array.from({ length: n }, (_, i) => (START + Math.floor(i / 52) >= 2012 ? 100 : null)),
    pred: Array(n).fill(100),
    lo: Array(n).fill(90),
    hi: Array(n).fill(110),
    last_week_days: 9,
  };
  const t = jumpTour(buildGrid(b, "week"), rawValues(b, "week"))!;
  assert.equal(t.notes.length, 2 * 6 * 52);
  close(t.partStart, 6 * YEAR_SECONDS + GAP);
  assert.ok(t.notes.every((x) => x.dur >= MIN_NOTE));
  assert.equal(t.notes[0].value, 25);
  const s = jumpTour(sliceGrid(buildGrid(b, "week"), "2010-01-01", "2013-12-31"), rawValues(b, "week"))!;
  assert.deepEqual(s.years, [2010, 2013]);
  assert.deepEqual([s.notes[0].row, s.notes[0].col, s.notes[0].cell.week], [0, 0, 0]);
  assert.equal(s.notes.length, 2 * 4 * 52);
});

test("noteAt: silent before the start, in the gap and after the end; the right note in each clip", () => {
  const b = bundle();
  const t = jumpTour(buildGrid(b), rawValues(b, "month"))!;
  const per = t.notes.length / 2;
  assert.deepEqual(noteAt(t, -0.01), { note: null, part: 0 });
  assert.equal(noteAt(t, 0).note, t.notes[0]);
  assert.equal(noteAt(t, 0.13).note, t.notes[1]);
  const gap = noteAt(t, t.partStart - GAP / 2);
  assert.deepEqual([gap.note, gap.part], [null, 0]);
  assert.equal(noteAt(t, t.partStart).note, t.notes[per]);
  assert.equal(noteAt(t, t.partStart + 0.25).note, t.notes[per + 2]);
  assert.deepEqual(noteAt(t, t.seconds + 0.01), { note: null, part: 1 });
});

test("a raw array shorter than the grid gives silent raw notes, not an error", () => {
  const b = bundle();
  const t = jumpTour(buildGrid(b), rawValues(b, "month").slice(0, 12 * 4))!;
  const raw = t.notes.filter((n) => n.part === 0);
  assert.ok(raw[0].freq != null);
  assert.ok(raw.slice(12).every((n) => n.freq == null && n.value == null));
  assert.ok(t.notes.filter((n) => n.part === 1).every((n) => n.freq != null));
});

test("rawValues uses the weekly series in the week view, and is empty without one", () => {
  const b = bundle();
  assert.deepEqual(rawValues(b, "week"), []);
  assert.equal(rawValues(b, "month")[0], 100);
  assert.equal(rawValues(b, "month")[12 * 6], 400);
});

test("tourSummary for screen readers", () => {
  assert.equal(tourSummary([2009, 2014], 2012), "Playing 2009 to 2014, raw then harmonized. Listen for the step at 2012.");
});
