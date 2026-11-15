// FE-028: the world scoreboard on /method. One row per published record (the 3 deep dives and every whole country in
// index.json, each annual.json read at build time: DP-018), each with its own hold-out check. Pure, no imports, so `node --test` and the client table use it.
// Country fields (`ship`, `method`, `cell_deg`) are the registry rows "Country-tier outputs" / "Globe data" (ML-023);
// the deep dives' annual.json has none of them. A country joins index.json (site_bundle.py) as soon as ML-026 commits
// its annual.json, so the table fills in with no change here.

/** What a row's record is: one of ML-023's country labels, or one of our deep-dive boxes. */
export type Label = "deep dive" | "model" | "caveat" | "ratio" | "sparse";

export const LABELS: readonly Label[] = [
  "deep dive",
  "model",
  "caveat",
  "ratio",
  "sparse",
];

/** One line per label, shown under the table. */
export const LABEL_TEXT: Readonly<Record<Label, string>> = {
  "deep dive":
    "One of our three boxes, modelled at 0.25° cells with every extra check (weather, burned area, NOAA-20/21).",
  model:
    "The model beats one fixed ratio on the hold-out and at least 4 of the 6 years fall inside its band.",
  caveat:
    "The model beats one fixed ratio, but fewer than 4 of the 6 years fall inside its band; published with a warning.",
  ratio:
    "One fixed ratio did as well or better, or only the ratio was run: the line is a constant-ratio estimate.",
  sparse:
    "Too little fire to check (a hold-out or training year with no VIIRS detections, or under 1,000 VIIRS detections 2012 to 2019).",
};

/** The annual.json fields read here. Scores may be null for a sparse country (ML-014: never inf or NaN). */
export type ScoreSource = {
  ship?: string | null;
  method?: string | null;
  cell_deg?: number | null;
  score?: {
    mape_model?: number | null;
    mape_ratio?: number | null;
    coverage?: number | null;
    n_hold?: number | null;
  } | null;
  /** ML-023: the model's own score when it ran on a country and lost to one ratio (that country ships the ratio). */
  model_score?: { mape_model?: number | null; mape_ratio?: number | null } | null;
};

export type ScoreRow = {
  id: string;
  name: string;
  label: Label;
  /** Model's mean annual hold-out error, %; null when the model did not run (ratio only, or sparse) or there is no score; for a country where it ran and lost, from `model_score`. */
  model: number | null;
  /** One fixed ratio's mean annual hold-out error, %. */
  ratio: number | null;
  /** True when the model ran and beat the ratio; null when there is nothing to compare. */
  modelWins: boolean | null;
  coverage: number | null;
  nHold: number | null;
  /** Cell size in degrees; null for a country whose file does not say. */
  cellDeg: number | null;
};

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function labelOf(a: ScoreSource, country: boolean): Label {
  if (!country) return "deep dive";
  const s = a.ship;
  if (s === "model" || s === "caveat" || s === "ratio" || s === "sparse")
    return s;
  // The registry says every country carries `ship`; without one, never claim the model: show the humblest label.
  return "ratio";
}

export function scoreRow(
  id: string,
  name: string,
  country: boolean,
  a: ScoreSource,
): ScoreRow {
  // A ratio-method file's `score.mape_model` is the ratio estimate's error, not the model's. FE-029: when the model ran
  // and lost, its error is in `model_score`, compared with the same one-ratio error, so the "beats one ratio in X of N"
  // claim counts the losses too (without this, 11 of 27 model runs on the world data were shown as "not run")
  const lost = a.method === "ratio" ? a.model_score ?? null : null;
  const model = a.method === "ratio" ? num(lost?.mape_model) : num(a.score?.mape_model);
  const ratio = num(lost ? lost.mape_ratio : a.score?.mape_ratio);
  return {
    id,
    name,
    label: labelOf(a, country),
    model,
    ratio,
    modelWins: model === null || ratio === null ? null : model < ratio,
    coverage: num(a.score?.coverage),
    nHold: num(a.score?.n_hold),
    cellDeg: num(a.cell_deg) ?? (country ? null : 0.25),
  };
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export type Summary = {
  total: number;
  deepDives: number;
  countries: number;
  counts: Record<Label, number>;
  /** Rows where the model ran and both errors exist (the "beats one ratio in X of N" claim). */
  compared: number;
  modelWins: number;
  medianModel: number | null;
  medianRatio: number | null;
};

/** Medians are over the same compared rows, so the two numbers are like for like. */
export function summarize(rows: ScoreRow[]): Summary {
  const counts = Object.fromEntries(LABELS.map((l) => [l, 0])) as Record<
    Label,
    number
  >;
  for (const r of rows) counts[r.label]++;
  const cmp = rows.filter((r) => r.modelWins !== null && r.label !== "sparse");
  return {
    total: rows.length,
    deepDives: counts["deep dive"],
    countries: rows.length - counts["deep dive"],
    counts,
    compared: cmp.length,
    modelWins: cmp.filter((r) => r.modelWins).length,
    medianModel: median(cmp.map((r) => r.model!)),
    medianRatio: median(cmp.map((r) => r.ratio!)),
  };
}

export type SortKey =
  "name" | "label" | "model" | "ratio" | "coverage" | "cellDeg";
export type SortDir = "asc" | "desc";

const SORT_VALUE: Record<SortKey, (r: ScoreRow) => string | number | null> = {
  name: (r) => r.name,
  label: (r) => LABELS.indexOf(r.label),
  model: (r) => r.model,
  ratio: (r) => r.ratio,
  coverage: (r) =>
    r.coverage === null || !r.nHold ? null : r.coverage / r.nHold,
  cellDeg: (r) => r.cellDeg,
};

/** Sorted copy; missing values always go last, ties fall back to the name. */
export function sortRows(
  rows: ScoreRow[],
  key: SortKey,
  dir: SortDir,
): ScoreRow[] {
  const get = SORT_VALUE[key];
  const sign = dir === "asc" ? 1 : -1;
  const byName = (a: ScoreRow, b: ScoreRow) =>
    a.name.localeCompare(b.name, "en");
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    if (x === null || y === null)
      return x === y ? byName(a, b) : x === null ? 1 : -1;
    const c =
      typeof x === "string"
        ? x.localeCompare(y as string, "en")
        : x - (y as number);
    return c !== 0 ? sign * c : byName(a, b);
  });
}

/** Case- and accent-insensitive match on the name; a query that is exactly a label ("ratio") finds that label's rows. */
export function filterRows(rows: ScoreRow[], query: string): ScoreRow[] {
  const fold = (s: string) =>
    s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const q = fold(query.trim());
  if (!q) return rows;
  return rows.filter((r) => fold(r.name).includes(q) || r.label === q);
}

const pct = (v: number) => `${v.toFixed(1)}%`;
const count = (v: number, one: string, many: string) =>
  `${v.toLocaleString("en-US")} ${v === 1 ? one : many}`;

/** The one summary sentence above the table (FE-028): places scored, country labels, model vs one ratio. */
export function boardSentence(B: Summary): string {
  const dives = count(B.deepDives, "deep dive", "deep dives");
  let text =
    B.countries > 0
      ? `Scored on ${count(B.total, "place", "places")} (${dives} and ${count(B.countries, "whole country", "whole countries")}), each against its own hold-out years.`
      : `So far the ${dives}, each against its own hold-out years; whole countries join this table as their runs are published.`;
  if (B.countries > 0) {
    const labels = LABELS.filter(
      (l) => l !== "deep dive" && B.counts[l] > 0,
    ).map((l) => `${B.counts[l]} ${l}`);
    text += ` Country labels: ${labels.join(", ")}.`;
    if (B.counts.sparse > 0)
      text += ` ${count(B.counts.sparse, "country has", "countries have")} too little fire to check.`;
  }
  if (B.compared > 0 && B.medianModel !== null && B.medianRatio !== null)
    text +=
      ` On the ${count(B.compared, "place", "places")} where the model ran, it beats one fixed ratio in ${B.modelWins};` +
      ` median hold-out error ${pct(B.medianModel)} for the model against ${pct(B.medianRatio)} for one ratio.`;
  return text;
}
