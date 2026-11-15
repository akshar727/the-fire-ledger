// Run with `npm test`. FE-028: the world scoreboard rows, summary, sort and search.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  boardSentence,
  filterRows,
  median,
  scoreRow,
  sortRows,
  summarize,
  type ScoreSource,
} from "./scoreboard.ts";

// DP-018: every published record, read one annual.json per index.json region (annual-all.json is gone)
const readData = (p: string) => JSON.parse(readFileSync(new URL(`../public/data/${p}`, import.meta.url), "utf8"));
const bundle = Object.fromEntries(
  (readData("index.json").regions as { id: string; first_year?: number }[])
    .filter((r) => typeof r.first_year === "number")
    .map((r) => [r.id, readData(`${r.id}/annual.json`)]),
) as Record<string, ScoreSource>;

const score = (
  mape_model: number | null,
  mape_ratio: number | null,
  coverage = 5,
  n_hold = 6,
) => ({
  mape_model,
  mape_ratio,
  coverage,
  n_hold,
});

test("deep dives use their own annual.json scores, at 0.25 degree cells", () => {
  for (const [id, a] of Object.entries(bundle)) {
    if ((a as { tier?: string }).tier === "country") continue;
    const r = scoreRow(id, id, false, a);
    assert.equal(r.label, "deep dive");
    assert.equal(r.model, a.score!.mape_model);
    assert.equal(r.ratio, a.score!.mape_ratio);
    assert.equal(r.cellDeg, 0.25);
    assert.equal(r.modelWins, a.score!.mape_model! < a.score!.mape_ratio!);
  }
});

test("country label comes from ship; ratio-tier countries have no model error", () => {
  assert.equal(
    scoreRow("x", "X", true, {
      ship: "caveat",
      cell_deg: 1,
      score: score(5, 9, 3),
    }).label,
    "caveat",
  );
  const r = scoreRow("y", "Y", true, {
    ship: "ratio",
    method: "ratio",
    cell_deg: 2,
    score: score(7, 7),
  });
  assert.equal(r.label, "ratio");
  assert.equal(r.model, null);
  assert.equal(r.modelWins, null);
  assert.equal(r.cellDeg, 2);
  const s = scoreRow("z", "Z", true, {
    ship: "sparse",
    score: score(null, null, null as never, null as never),
  });
  assert.equal(s.label, "sparse");
  assert.equal(s.model, null);
  assert.equal(s.coverage, null);
});

test("summary counts labels and compares only rows where the model ran", () => {
  const rows = [
    scoreRow("a", "A", false, { score: score(4, 6) }),
    scoreRow("b", "B", false, { score: score(8, 3) }),
    scoreRow("c", "C", true, { ship: "model", score: score(10, 20) }),
    scoreRow("d", "D", true, {
      ship: "ratio",
      method: "ratio",
      score: score(5, 5),
    }),
    scoreRow("e", "E", true, { ship: "sparse", score: score(90, 1) }),
  ];
  const S = summarize(rows);
  assert.equal(S.total, 5);
  assert.equal(S.deepDives, 2);
  assert.equal(S.countries, 3);
  assert.deepEqual(S.counts, {
    "deep dive": 2,
    model: 1,
    caveat: 0,
    ratio: 1,
    sparse: 1,
  });
  assert.equal(S.compared, 3);
  assert.equal(S.modelWins, 2);
  assert.equal(S.medianModel, 8);
  assert.equal(S.medianRatio, 6);
});

test("median of an even list is the mean of the middle two; empty is null", () => {
  assert.equal(median([1, 4, 2, 3]), 2.5);
  assert.equal(median([]), null);
});

test("sort puts missing values last in both directions and breaks ties by name", () => {
  const rows = [
    scoreRow("b", "Brazil", true, { ship: "model", score: score(9, 12) }),
    scoreRow("r", "Russia", true, {
      ship: "ratio",
      method: "ratio",
      score: score(5, 5),
    }),
    scoreRow("a", "Angola", true, { ship: "model", score: score(3, 12) }),
  ];
  assert.deepEqual(
    sortRows(rows, "model", "asc").map((r) => r.id),
    ["a", "b", "r"],
  );
  assert.deepEqual(
    sortRows(rows, "model", "desc").map((r) => r.id),
    ["b", "a", "r"],
  );
  assert.deepEqual(
    sortRows(rows, "ratio", "desc").map((r) => r.id),
    ["a", "b", "r"],
  );
  assert.deepEqual(
    sortRows(rows, "name", "desc").map((r) => r.id),
    ["r", "b", "a"],
  );
});

test("search ignores case and accents, and matches labels", () => {
  const rows = [
    scoreRow("ci", "Côte d'Ivoire", true, {
      ship: "caveat",
      score: score(5, 9, 3),
    }),
    scoreRow("gh", "Ghana", false, { score: score(4, 6) }),
  ];
  assert.deepEqual(
    filterRows(rows, "cote").map((r) => r.id),
    ["ci"],
  );
  assert.deepEqual(
    filterRows(rows, "DEEP DIVE").map((r) => r.id),
    ["gh"],
  );
  assert.deepEqual(
    filterRows(rows, "ca").map((r) => r.id),
    [],
    "a prefix of a label does not pull in its rows",
  );
  assert.deepEqual(
    filterRows(rows, "caveat").map((r) => r.id),
    ["ci"],
  );
  assert.equal(filterRows(rows, "  ").length, 2);
});

test("a country with no score, ship or cell size never shows a made-up value", () => {
  const r = scoreRow("q", "Q", true, { score: null });
  assert.equal(r.label, "ratio");
  assert.equal(r.model, null);
  assert.equal(r.ratio, null);
  assert.equal(r.cellDeg, null);
  assert.equal(scoreRow("w", "W", true, {}).coverage, null);
});

test("summary sentence: deep dives only, then with countries", () => {
  const dives = [
    scoreRow("a", "A", false, { score: score(4, 6) }),
    scoreRow("b", "B", false, { score: score(8, 3) }),
  ];
  assert.equal(
    boardSentence(summarize(dives)),
    "So far the 2 deep dives, each against its own hold-out years; whole countries join this table as their runs are published." +
      " On the 2 places where the model ran, it beats one fixed ratio in 1; median hold-out error 6.0% for the model against 4.5% for one ratio.",
  );
  const world = [
    ...dives,
    scoreRow("c", "C", true, {
      ship: "ratio",
      method: "ratio",
      score: score(5, 5),
    }),
    scoreRow("e", "E", true, { ship: "sparse", score: score(90, 1) }),
  ];
  const t = boardSentence(summarize(world));
  assert.match(t, /^Scored on 4 places \(2 deep dives and 2 whole countries\)/);
  assert.match(
    t,
    /Country labels: 1 ratio, 1 sparse\. 1 country has too little fire to check\./,
  );
  assert.match(t, /On the 2 places where the model ran/);
});
