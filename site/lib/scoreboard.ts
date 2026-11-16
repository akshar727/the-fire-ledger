export type Label = "deep dive" | "model" | "caveat" | "ratio" | "sparse";

export const LABELS: readonly Label[] = [
  "deep dive",
  "model",
  "caveat",
  "ratio",
  "sparse",
];

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
  model_score?: { mape_model?: number | null; mape_ratio?: number | null } | null;
};

export type ScoreRow = {
  id: string;
  name: string;
  label: Label;
  model: number | null;
  ratio: number | null;
  modelWins: boolean | null;
  coverage: number | null;
  nHold: number | null;
  cellDeg: number | null;
};

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function labelOf(a: ScoreSource, country: boolean): Label {
  if (!country) return "deep dive";
  const s = a.ship;
  if (s === "model" || s === "caveat" || s === "ratio" || s === "sparse")
    return s;
  return "ratio";
}

export function scoreRow(
  id: string,
  name: string,
  country: boolean,
  a: ScoreSource,
): ScoreRow {
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
  compared: number;
  modelWins: number;
  medianModel: number | null;
  medianRatio: number | null;
};

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
