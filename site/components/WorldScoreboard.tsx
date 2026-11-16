"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import {
  filterRows,
  sortRows,
  type ScoreRow,
  type SortDir,
  type SortKey,
} from "@/lib/scoreboard";

const COLUMNS: { key: SortKey; title: string; numeric?: boolean }[] = [
  { key: "name", title: "Place" },
  { key: "label", title: "Label" },
  { key: "model", title: "Model error", numeric: true },
  { key: "ratio", title: "One-ratio error", numeric: true },
  { key: "coverage", title: "Years in band", numeric: true },
  { key: "cellDeg", title: "Cell size", numeric: true },
];

const pct = (v: number | null) => (v === null ? "–" : `${v.toFixed(1)}%`);

export function WorldScoreboard({ rows }: { rows: ScoreRow[] }) {
  const [query, setQuery] = useState("");
  const [key, setKey] = useState<SortKey>("name");
  const [dir, setDir] = useState<SortDir>("asc");
  const searchId = useId();
  const shown = useMemo(
    () => sortRows(filterRows(rows, query), key, dir),
    [rows, query, key, dir],
  );

  const sortBy = (k: SortKey) => {
    if (k === key) setDir(dir === "asc" ? "desc" : "asc");
    else {
      setKey(k);
      setDir("asc");
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label htmlFor={searchId} className="text-sm font-medium">
          Find a place
        </label>
        <input
          id={searchId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Country, or a label such as ratio"
          className="h-9 w-full max-w-xs rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <p
          role="status"
          aria-live="polite"
          className="text-sm text-muted-foreground"
        >
          {shown.length === rows.length
            ? `${rows.length} places`
            : `${shown.length} of ${rows.length} places`}
          , sorted by {COLUMNS.find((c) => c.key === key)!.title.toLowerCase()},{" "}
          {dir === "asc" ? "ascending" : "descending"}
        </p>
      </div>
      <div className="relative max-h-[32rem] scroll-pt-10 overflow-auto rounded-xl border">
        <table className="w-full min-w-[40rem] text-sm">
          <caption className="sr-only">
            Hold-out check per place. Column headers are buttons that sort the
            table.
          </caption>
          <thead className="sticky top-0 bg-muted text-left">
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={
                    c.key === key
                      ? dir === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                  className="bg-muted p-0 font-medium"
                >
                  <button
                    type="button"
                    onClick={() => sortBy(c.key)}
                    className="flex w-full items-center gap-1 px-3 py-2 text-left whitespace-nowrap hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    {c.title}
                    <span aria-hidden className="text-muted-foreground">
                      {c.key === key ? (dir === "asc" ? "↑" : "↓") : "↕"}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y text-muted-foreground tabular-nums">
            {shown.map((r) => {
              const lower = (wins: boolean) => r.label !== "sparse" && wins;
              return (
                <tr key={r.id}>
                  <th scope="row" className="px-3 py-2 text-left font-normal">
                    <Link
                      href={`/ledger?region=${encodeURIComponent(r.id)}`}
                      className="text-foreground underline underline-offset-2"
                    >
                      {r.name}
                    </Link>
                  </th>
                  <td className="px-3 py-2 whitespace-nowrap">{r.label}</td>
                  <td
                    className={`px-3 py-2 whitespace-nowrap ${lower(r.modelWins === true) ? "font-medium text-foreground" : ""}`}
                  >
                    {r.label === "ratio" && r.model === null
                      ? "not run"
                      : pct(r.model)}
                    {lower(r.modelWins === true) && (
                      <span className="sr-only"> (lower)</span>
                    )}
                  </td>
                  <td
                    className={`px-3 py-2 whitespace-nowrap ${lower(r.modelWins === false) ? "font-medium text-foreground" : ""}`}
                  >
                    {pct(r.ratio)}
                    {lower(r.modelWins === false) && (
                      <span className="sr-only"> (lower)</span>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.coverage === null || r.nHold === null
                      ? "–"
                      : `${r.coverage} of ${r.nHold}`}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.cellDeg === null ? "–" : `${r.cellDeg}°`}
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length} className="px-3 py-6 text-center">
                  No place matches “{query}”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
