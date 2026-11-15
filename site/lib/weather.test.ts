import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseSeries, type CalendarStats } from "./series.ts";
import { monthWeather, parseWeather, summarySentence, weatherPhrase, weatherSentence, weatherSummary, weatherVerdict, type Weather } from "./weather.ts";

// Two years of a toy file: 24 months, `index` rising through the years so the second year is the ledger for each month.
function toy(pctl: number[], opts: { complete?: boolean; days?: number; peak7?: number[] } = {}): Weather {
  const n = pctl.length;
  return {
    schema: 1,
    region: "x",
    source: "test",
    through: "2002-12-31",
    monthly: {
      start_year: 2001,
      t2m_max_c: Array(n).fill(30),
      precip_mm: Array(n).fill(10),
      index: pctl.map((p, i) => p + i / 1000),
      pctl,
      pctl_peak7: opts.peak7 ?? Array(n).fill(50),
      last_month_days: opts.days ?? 31,
      last_month_complete: opts.complete ?? true,
    },
  };
}

test("parseWeather accepts the real files and rejects broken ones", () => {
  for (const r of ["portugal", "ghana", "punjab"]) {
    const raw = JSON.parse(readFileSync(new URL(`../public/data/${r}/weather.json`, import.meta.url), "utf8"));
    assert.ok(parseWeather(raw), r);
  }
  assert.equal(parseWeather(null), null);
  assert.equal(parseWeather({ schema: 2 }), null);
  const bad = toy([50, 50]) as unknown as { monthly: { pctl_peak7: number[] } };
  bad.monthly.pctl_peak7 = [1];
  assert.equal(parseWeather(bad), null);
});

test("phrase thresholds: top 10%, top quarter, ordinary, bottom quarter, ordinals", () => {
  const base = { year: 2001, month: 8, peak7: 50, partialDays: null, record: false, n: 25 };
  assert.equal(weatherPhrase({ ...base, pctl: 92 }, 2001), "fire-prone weather for August (top 10%)");
  assert.equal(weatherPhrase({ ...base, pctl: 78.4 }, 2001), "hotter, drier or windier than most Augusts (78th percentile)");
  assert.equal(weatherPhrase({ ...base, pctl: 75 }, 2001), "hotter, drier or windier than most Augusts (75th percentile)");
  assert.equal(weatherPhrase({ ...base, pctl: 52 }, 2001), "ordinary weather for August (52nd percentile)");
  assert.equal(weatherPhrase({ ...base, pctl: 11 }, 2001), "cooler, damper or calmer weather than most Augusts (11th percentile)");
  assert.equal(weatherPhrase({ ...base, pctl: 21 }, 2001), "cooler, damper or calmer weather than most Augusts (21st percentile)");
  assert.equal(weatherPhrase({ ...base, pctl: 99, record: true }, 2001), "the most fire-prone August weather since 2001");
  assert.equal(weatherPhrase({ ...base, pctl: 60, peak7: 95 }, 2001), "ordinary weather for August (60th percentile), with one of the hottest, driest weeks of any August");
});

test("verdict: weather explains high fire, or points to people; low fire; normal months say nothing", () => {
  const w = (pctl: number) => ({ year: 2001, month: 8, pctl, peak7: 50, partialDays: null, record: false, n: 25 });
  assert.equal(weatherVerdict(w(80), 1), "The weather helps explain the high fire.");
  assert.equal(weatherVerdict(w(50), 1), "The weather was not unusual, so it does not explain the high fire.");
  assert.equal(weatherVerdict(w(80), -1), "Fire stayed low despite fire-prone weather.");
  assert.equal(weatherVerdict(w(10), -1), "Cool, damp or calm weather fits the low fire.");
  assert.equal(weatherVerdict(w(50), -1), null);
  assert.equal(weatherVerdict(w(95), 0), null);
  assert.equal(weatherVerdict({ ...w(95), partialDays: 12 }, 1), null);
});

test("record month, partial month and months the file does not reach", () => {
  const W = toy([...Array(12).fill(40), ...Array(12).fill(60)]);
  // the toy has only 2 of each month: too few to call a record
  assert.equal(monthWeather(W, 2002, 3)!.record, false);
  const many = toy(Array.from({ length: 72 }, (_, i) => (i < 60 ? 40 : 98)));
  assert.equal(monthWeather(many, 2006, 3)!.record, true);
  assert.equal(monthWeather(many, 2005, 3)!.record, false);
  assert.equal(monthWeather(W, 2003, 1), null);
  assert.equal(monthWeather(W, 2000, 12), null);
  const part = toy(Array(24).fill(50), { complete: false, days: 12 });
  assert.equal(monthWeather(part, 2002, 12)!.partialDays, 12);
  assert.equal(weatherSentence(part, 2002, 12, 0), "Weather for 1-12 December so far: ordinary weather for December (50th percentile).");
  assert.equal(weatherSentence(W, 2002, 3, 1), "Weather: ordinary weather for March (60th percentile). The weather was not unusual, so it does not explain the high fire.");
});

test("summary counts fire flags against fire-prone weather, skipping a partial last month", () => {
  const W = toy([90, 90, 10, 10, 80, 20, 50, 50, 50, 50, 50, 50], { complete: false, days: 5 });
  const stats = { flag: [1, 1, 1, -1, 0, 0, 0, 0, 0, 0, 0, 1] } as unknown as CalendarStats;
  const s = weatherSummary(W, stats, 2001, false)!;
  assert.equal(s.n, 11); // the weather file's last month is partial
  assert.deepEqual(s.high, { prone: 2, other: 1 });
  assert.deepEqual(s.low, { prone: 0, other: 1 });
  assert.deepEqual(s.normal, { prone: 1, other: 6 });
  assert.equal(s.baseShare, 3 / 11);
  assert.equal(summarySentence(s), "2 of 3 unusually high months had fire-prone weather (top quarter for that month); chance alone would give about 1.");
  assert.equal(weatherSummary(W, stats, 2001, true)!.n, 11);
  assert.equal(weatherSummary(W, stats, 2010, false), null);
});

// Real data: the summary the calendar shows (snapshot of DP-014's files; update when weather.py is rerun).
test("real data: high-fire months line up with fire-prone weather far more often than chance", () => {
  for (const r of ["portugal", "ghana", "punjab"]) {
    const W = parseWeather(JSON.parse(readFileSync(new URL(`../public/data/${r}/weather.json`, import.meta.url), "utf8")))!;
    const b = parseSeries(JSON.parse(readFileSync(new URL(`../public/data/${r}/series.json`, import.meta.url), "utf8")));
    const s = weatherSummary(W, b.calendar!, b.monthly.start_year, true)!;
    const hi = s.high.prone + s.high.other;
    assert.ok(hi > 0 && s.high.prone / hi > s.baseShare, r);
  }
});
