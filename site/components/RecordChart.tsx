"use client";

// Annual record chart with the Raw / Harmonized toggle. Port of the proof-of-concept web/index.html
// (same series, band and sentences; top margin and two extra labels added), plus a per-year readout on hover / arrow keys.
import { useState, type KeyboardEvent } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { Annual } from "@/lib/data";

type Mode = "raw" | "harm";

const W = 800, H = 380, L = 55, R = 15, T = 18, B = 30;
const fmt = (v: number) => Math.round(v).toLocaleString("en-US");

export function RecordChart({ data }: { data: Annual }) {
  const [mode, setMode] = useState<Mode>("raw");
  const [hover, setHover] = useState<number | null>(null);

  const D = data, n = D.years.length;
  const viirsVals = D.viirs.filter((v): v is number => v != null);
  const max = Math.max(...D.hi, ...viirsVals) * 1.05;
  const x = (i: number) => L + (i * (W - L - R)) / (n - 1);
  const y = (v: number) => H - B - (v * (H - T - B)) / max;
  const i2003 = D.years.indexOf(2003), i2012 = D.years.indexOf(2012), i2020 = D.years.indexOf(2020);

  const path = (vals: (number | null)[], from: number, to: number) =>
    vals.slice(from, to).map((v, k) => `${k ? "L" : "M"}${x(from + k)} ${y(v ?? 0)}`).join("");
  const band = (from: number, to: number) =>
    path(D.hi, from, to) +
    D.lo.slice(from, to).map((v, k) => `L${x(from + k)} ${y(v)}`).reverse().join("") + "Z";

  const ticks: number[] = [];
  for (let v = 0; v <= max; v += 5000) ticks.push(v);

  // Sentences under the chart: same formulas as the proof of concept.
  const modisMean = D.modis.slice(0, i2012).reduce((p, c) => p + c, 0) / i2012;
  const viirsMean = viirsVals.reduce((p, c) => p + c, 0) / viirsVals.length;
  const s = D.score;
  const note =
    mode === "raw"
      ? `Naively stitched record. Mean detections per year go from ${fmt(modisMean)} (MODIS era) to ${fmt(viirsMean)} (VIIRS era): ×${(viirsMean / modisMean).toFixed(1)}, mostly because VIIRS has finer pixels, not because fire changed.`
      : `Hold-out 2020-2025 (the model never saw these years): mean annual error ${s.mape_model.toFixed(1)}% vs ${s.mape_ratio.toFixed(1)}% for a single constant factor; the 5-95% band contains the observed total in ${s.coverage} of ${s.n_hold} years; weekly correlation r = ${s.weekly_r.toFixed(3)}.`;

  const legend: [string, string, boolean?][] =
    mode === "raw"
      ? [["var(--modis)", "MODIS detections (2001-2011)"], ["var(--viirs)", "VIIRS detections (2012-2025)"]]
      : [
          ["var(--primary)", "Back-cast VIIRS-equivalent, 5-95% band"],
          ["var(--viirs)", "VIIRS observed"],
          ["var(--primary)", "Hold-out prediction 2020-2025", true],
        ];

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight") setHover((h) => Math.min(n - 1, (h ?? -1) + 1));
    else if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? n) - 1));
    else if (e.key === "Escape") setHover(null);
    else return;
    e.preventDefault();
  };

  const readout = hover == null ? null : readoutRows(D, hover, mode);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          value={mode}
          onValueChange={(v) => v && setMode(v as Mode)}
          aria-label="Record view"
        >
          {(["raw", "harm"] as const).map((m) => (
            <ToggleGroupItem
              key={m}
              value={m}
              className="h-9 px-4 data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground active:scale-[0.98]"
            >
              {m === "raw" ? "Raw" : "Harmonized"}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
          {legend.map(([c, t, dashed]) => (
            <li key={t} className="flex items-center gap-2">
              <svg width="20" height="6" aria-hidden>
                <line x1="0" x2="20" y1="3" y2="3" stroke={c} strokeWidth="2.5" strokeDasharray={dashed ? "5 3" : undefined} />
              </svg>
              {t}
            </li>
          ))}
        </ul>
      </div>

      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div
          className="relative min-w-[560px] rounded-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          tabIndex={0}
          role="group"
          aria-label="Annual fire detections chart. Use the left and right arrow keys to read values per year."
          onKeyDown={onKey}
          onMouseLeave={(e) => e.currentTarget !== document.activeElement && setHover(null)}
          onBlur={() => setHover(null)}
        >
          <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full text-[11px]" aria-hidden>
            {ticks.map((v) => (
              <g key={v}>
                <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="stroke-border" />
                <text x={L - 8} y={y(v) + 4} textAnchor="end" className="fill-muted-foreground font-mono">
                  {v / 1000}k
                </text>
              </g>
            ))}
            {D.years.map((yr, i) =>
              yr % 3 === 0 ? (
                <text key={yr} x={x(i)} y={H - 8} textAnchor="middle" className="fill-muted-foreground font-mono">
                  {yr}
                </text>
              ) : null,
            )}

            <line x1={x(i2012)} x2={x(i2012)} y1={T} y2={H - B} className="stroke-muted-foreground/60" strokeDasharray="2 3" />
            <text x={x(i2012) + 5} y={T + 8} className="fill-muted-foreground">VIIRS starts</text>

            {mode === "raw" ? (
              <g key="raw">
                {/* Aqua MODIS data starts in July 2002: before that, counts are Terra alone. */}
                <rect x={x(0)} y={T} width={x(i2003 - 1) - x(0)} height={H - T - B} className="fill-muted chart-fade" />
                <text x={x(0) + 5} y={T + 8} className="fill-muted-foreground">Terra only to mid-2002</text>
                <path d={path(D.modis, 0, i2012)} pathLength={1} fill="none" stroke="var(--modis)" strokeWidth={2.25} className="chart-draw" />
                <path d={path(D.viirs, i2012, n)} pathLength={1} fill="none" stroke="var(--viirs)" strokeWidth={2.25} className="chart-draw" />
                <path
                  d={`M${x(i2012 - 1)} ${y(D.modis[i2012 - 1])}L${x(i2012)} ${y(D.viirs[i2012] ?? 0)}`}
                  className="stroke-muted-foreground chart-fade"
                  strokeDasharray="2 3"
                />
              </g>
            ) : (
              <g key="harm">
                <line x1={x(i2020)} x2={x(i2020)} y1={T} y2={H - B} className="stroke-muted-foreground/60" strokeDasharray="2 3" />
                <text x={x(i2020) + 5} y={T + 8} className="fill-muted-foreground">Hold-out</text>
                <path d={band(0, i2012 + 1)} fill="var(--primary)" opacity={0.18} className="chart-fade" />
                <path d={band(i2020, n)} fill="var(--primary)" opacity={0.18} className="chart-fade" />
                <path
                  d={path(D.pred.slice(0, i2012).concat(D.viirs[i2012] ?? 0), 0, i2012 + 1)}
                  pathLength={1}
                  fill="none"
                  stroke="var(--primary)"
                  strokeWidth={2.25}
                  className="chart-draw"
                />
                <path d={path(D.viirs, i2012, n)} pathLength={1} fill="none" stroke="var(--viirs)" strokeWidth={2.25} className="chart-draw" />
                <path d={path(D.pred, i2020, n)} fill="none" stroke="var(--primary)" strokeWidth={2.25} strokeDasharray="5 4" className="chart-fade" />
              </g>
            )}

            {hover != null && (
              <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="stroke-foreground/40" />
            )}
            {D.years.map((yr, i) => (
              <rect
                key={yr}
                x={x(i) - (W - L - R) / (n - 1) / 2}
                y={T}
                width={(W - L - R) / (n - 1)}
                height={H - T - B}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
              />
            ))}
          </svg>

          {readout && hover != null && (
            <div
              className="pointer-events-none absolute top-8 w-64 rounded-lg border bg-popover px-3 py-2.5 text-sm text-popover-foreground shadow-lg shadow-foreground/5"
              style={
                x(hover) / W > 0.6
                  ? { right: `${100 - (x(hover) / W) * 100 + 1.5}%` }
                  : { left: `${(x(hover) / W) * 100 + 1.5}%` }
              }
            >
              <p className="mb-1 font-mono font-medium">{D.years[hover]}</p>
              <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
                {readout.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="text-right font-mono whitespace-nowrap tabular-nums">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>
      </div>

      <p className="max-w-[75ch] text-sm leading-relaxed text-muted-foreground" aria-live="polite">
        {note}
      </p>

      <div className="sr-only">
      <table>
        <caption>Annual active-fire detections, mainland Portugal</caption>
        <thead>
          <tr>
            <th scope="col">Year</th>
            <th scope="col">MODIS</th>
            <th scope="col">VIIRS observed</th>
            <th scope="col">VIIRS-equivalent (model)</th>
            <th scope="col">5th percentile</th>
            <th scope="col">95th percentile</th>
          </tr>
        </thead>
        <tbody>
          {D.years.map((yr, i) => (
            <tr key={yr}>
              <th scope="row">{yr}</th>
              <td>{fmt(D.modis[i])}</td>
              <td>{D.viirs[i] == null ? "none" : fmt(D.viirs[i]!)}</td>
              <td>{fmt(D.pred[i])}</td>
              <td>{fmt(D.lo[i])}</td>
              <td>{fmt(D.hi[i])}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

function readoutRows(D: Annual, i: number, mode: Mode): [string, string][] {
  const yr = D.years[i], v = D.viirs[i];
  if (mode === "raw") {
    const rows: [string, string][] = [["MODIS", fmt(D.modis[i])]];
    if (v != null) rows.push(["VIIRS", fmt(v)]);
    return rows;
  }
  const band = `${fmt(D.lo[i])} - ${fmt(D.hi[i])}`;
  if (v == null) return [["VIIRS-equivalent", fmt(D.pred[i])], ["5-95% band", band]];
  const rows: [string, string][] = [["VIIRS observed", fmt(v)]];
  if (yr >= 2020) rows.push(["Model prediction", fmt(D.pred[i])], ["5-95% band", band]);
  return rows;
}
