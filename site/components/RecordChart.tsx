"use client";

// Annual record chart with the Raw / Harmonized toggle. Port of the proof-of-concept web/index.html
// (same series, band and sentences; top margin and two extra labels added), plus a per-year readout on hover / arrow keys.
// FE-004: draws only the years in `years` (the selected dates); the sentences under it still describe the whole record.
import { useState, type KeyboardEvent } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { Annual } from "@/lib/data";
import { compact } from "@/lib/series";

type Mode = "raw" | "harm";

const W = 800, H = 380, L = 55, R = 15, T = 18, B = 30;
const fmt = (v: number) => Math.round(v).toLocaleString("en-US");

/** Gridline step: the 1, 2 or 5 times a power of ten nearest to max / 5 (Portugal keeps its 5k lines). */
function tickStep(max: number): number {
  const raw = max / 5, p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).reduce((best, s) => (Math.abs(s - raw) < Math.abs(best - raw) ? s : best));
}

/** Marker label beside a vertical line; flips to the left of the line near the right edge so it isn't clipped. */
function MarkerLabel({ at, children }: { at: number; children: string }) {
  const flip = at > W - R - 90;
  return (
    <text x={flip ? at - 5 : at + 5} y={T + 8} textAnchor={flip ? "end" : "start"} className="fill-muted-foreground">
      {children}
    </text>
  );
}

export function RecordChart({ data, region, years }: { data: Annual; region: string; years: [number, number] }) {
  const [mode, setMode] = useState<Mode>("raw");
  const [hoverAt, setHover] = useState<number | null>(null);

  const D = data;
  // visible years: full-record indexes a..b (inclusive); every index below is a full-record index
  const a = Math.max(0, D.years.indexOf(Math.max(years[0], D.years[0])));
  const b = Math.max(a, D.years.indexOf(Math.min(years[1], D.years.at(-1)!)));
  const n = b - a + 1;
  const visible = (i: number) => i >= a && i <= b;
  const hover = hoverAt != null && visible(hoverAt) ? hoverAt : null;

  const inView = D.years.flatMap((_, i) => (visible(i) ? [D.hi[i], D.modis[i], D.viirs[i] ?? 0, D.harmonized[i]] : []));
  const max = Math.max(1, ...inView) * 1.05;
  const step = (W - L - R) / Math.max(1, n - 1);
  const x = (i: number) => (n === 1 ? (L + W - R) / 2 : L + (i - a) * step);
  const y = (v: number) => H - B - (v * (H - T - B)) / max;
  const i2003 = D.years.indexOf(2003), i2012 = D.years.indexOf(2012), i2020 = D.years.indexOf(2020);

  // full-record index range [from, to) cut down to the visible years; null when nothing is left
  const clip = (from: number, to: number): [number, number] | null => {
    const lo = Math.max(from, a), hi = Math.min(to, b + 1);
    return lo < hi ? [lo, hi] : null;
  };
  const pts = (vals: (number | null)[], lo: number, hi: number) =>
    Array.from({ length: hi - lo }, (_, k) => `${x(lo + k)} ${y(vals[lo + k] ?? 0)}`);
  const path = (vals: (number | null)[], from: number, to: number) => {
    const c = clip(from, to);
    return c ? "M" + pts(vals, ...c).join("L") : "";
  };
  const band = (from: number, to: number) => {
    const c = clip(from, to);
    return c ? "M" + [...pts(D.hi, ...c), ...pts(D.lo, ...c).reverse()].join("L") + "Z" : "";
  };
  // back-cast line runs into the first VIIRS year so the two segments join; from 2012 the Harmonized view draws
  // `harmonized` (ML-009: 2012 = observed VIIRS from 20 Jan + model for 1-19 Jan), Raw draws the raw `viirs`
  const backcast = D.pred.map((p, i) => (i < i2012 ? p : i === i2012 ? D.harmonized[i] : null));

  const ticks: number[] = [];
  for (let v = 0, s = Math.max(1, tickStep(max / 1.05)); v <= max; v += s) ticks.push(v);
  const labelEvery = n <= 8 ? 1 : n <= 16 ? 2 : 3;

  // Sentences under the chart: same formulas as the proof of concept.
  const modisMean = D.modis.slice(0, i2012).reduce((p, c) => p + c, 0) / i2012;
  // VIIRS-era mean from `harmonized`, as jump() in RecordExplorer, so a 2012 that starts 20 Jan doesn't pull it down
  const viirsEra = D.harmonized.slice(i2012);
  const viirsMean = viirsEra.reduce((p, c) => p + c, 0) / viirsEra.length;
  const s = D.score;
  const note =
    mode === "raw"
      ? `Naively stitched record. Mean detections per year go from ${fmt(modisMean)} (MODIS era) to ${fmt(viirsMean)} (VIIRS era, with 1-19 January 2012 filled by the model): ×${(viirsMean / modisMean).toFixed(1)}, mostly because VIIRS has finer pixels, not because fire changed.`
      : `Hold-out 2020-2025 (the model never saw these years): mean annual error ${s.mape_model.toFixed(1)}% vs ${s.mape_ratio.toFixed(1)}% for a single constant factor; the 5-95% band contains the observed total in ${s.coverage} of ${s.n_hold} years; weekly correlation r = ${s.weekly_r.toFixed(3)}.`;

  const legend: [string, string, boolean?][] =
    mode === "raw"
      ? [["var(--modis)", "MODIS detections (2001-2011)"], ["var(--viirs)", "VIIRS detections (2012-2025)"]]
      : [
          ["var(--primary)", "Back-cast VIIRS-equivalent, 5-95% band"],
          ["var(--viirs)", "VIIRS observed (1-19 Jan 2012 from the model)"],
          ["var(--primary)", "Hold-out prediction 2020-2025", true],
        ];

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight") setHover(Math.min(b, (hover ?? a - 1) + 1));
    else if (e.key === "ArrowLeft") setHover(Math.max(a, (hover ?? b + 1) - 1));
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
          aria-label={`Annual fire detections chart, ${region}. Use the left and right arrow keys to read values per year.`}
          onKeyDown={onKey}
          onMouseLeave={(e) => e.currentTarget !== document.activeElement && setHover(null)}
          onBlur={() => setHover(null)}
        >
          <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full text-[11px]" aria-hidden>
            {ticks.map((v) => (
              <g key={v}>
                <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="stroke-border" />
                <text x={L - 8} y={y(v) + 4} textAnchor="end" className="fill-muted-foreground font-mono">
                  {compact(v)}
                </text>
              </g>
            ))}
            {D.years.map((yr, i) =>
              visible(i) && yr % labelEvery === 0 ? (
                <text key={yr} x={x(i)} y={H - 8} textAnchor="middle" className="fill-muted-foreground font-mono">
                  {yr}
                </text>
              ) : null,
            )}

            {visible(i2012) && (
              <>
                <line x1={x(i2012)} x2={x(i2012)} y1={T} y2={H - B} className="stroke-muted-foreground/60" strokeDasharray="2 3" />
                <MarkerLabel at={x(i2012)}>VIIRS starts</MarkerLabel>
              </>
            )}

            {mode === "raw" ? (
              <g key="raw">
                {/* Aqua MODIS data starts in July 2002: before that, counts are Terra alone. */}
                {visible(i2003 - 1) && a < i2003 - 1 && (
                  <>
                    <rect x={x(a)} y={T} width={x(i2003 - 1) - x(a)} height={H - T - B} className="fill-muted chart-fade" />
                    <text x={x(a) + 5} y={T + 8} className="fill-muted-foreground">Terra only to mid-2002</text>
                  </>
                )}
                <path d={path(D.modis, 0, i2012)} pathLength={1} fill="none" stroke="var(--modis)" strokeWidth={2.25} className="chart-draw" />
                <path d={path(D.viirs, i2012, D.years.length)} pathLength={1} fill="none" stroke="var(--viirs)" strokeWidth={2.25} className="chart-draw" />
                {visible(i2012 - 1) && visible(i2012) && (
                  <path
                    d={`M${x(i2012 - 1)} ${y(D.modis[i2012 - 1])}L${x(i2012)} ${y(D.viirs[i2012] ?? 0)}`}
                    className="stroke-muted-foreground chart-fade"
                    strokeDasharray="2 3"
                  />
                )}
                {n === 1 && <Dot cx={x(a)} cy={y(a < i2012 ? D.modis[a] : (D.viirs[a] ?? 0))} color={a < i2012 ? "var(--modis)" : "var(--viirs)"} />}
              </g>
            ) : (
              <g key="harm">
                {visible(i2020) && (
                  <>
                    <line x1={x(i2020)} x2={x(i2020)} y1={T} y2={H - B} className="stroke-muted-foreground/60" strokeDasharray="2 3" />
                    <MarkerLabel at={x(i2020)}>Hold-out</MarkerLabel>
                  </>
                )}
                <path d={band(0, i2012 + 1)} fill="var(--primary)" opacity={0.18} className="chart-fade" />
                <path d={band(i2020, D.years.length)} fill="var(--primary)" opacity={0.18} className="chart-fade" />
                <path d={path(backcast, 0, i2012 + 1)} pathLength={1} fill="none" stroke="var(--primary)" strokeWidth={2.25} className="chart-draw" />
                <path d={path(D.harmonized, i2012, D.years.length)} pathLength={1} fill="none" stroke="var(--viirs)" strokeWidth={2.25} className="chart-draw" />
                <path d={path(D.pred, i2020, D.years.length)} fill="none" stroke="var(--primary)" strokeWidth={2.25} strokeDasharray="5 4" className="chart-fade" />
                {n === 1 && (a < i2012 || a >= i2020) && (
                  <line x1={x(a)} x2={x(a)} y1={y(D.lo[a])} y2={y(D.hi[a])} stroke="var(--primary)" strokeWidth={6} opacity={0.25} />
                )}
                {n === 1 && <Dot cx={x(a)} cy={y(a < i2012 ? D.pred[a] : D.harmonized[a])} color={a < i2012 ? "var(--primary)" : "var(--viirs)"} />}
              </g>
            )}

            {hover != null && (
              <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="stroke-foreground/40" />
            )}
            {D.years.map((yr, i) =>
              visible(i) ? (
                <rect
                  key={yr}
                  x={n === 1 ? L : x(i) - step / 2}
                  y={T}
                  width={n === 1 ? W - L - R : step}
                  height={H - T - B}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                />
              ) : null,
            )}
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
        <caption>Annual active-fire detections, {region}</caption>
        <thead>
          <tr>
            <th scope="col">Year</th>
            <th scope="col">MODIS</th>
            <th scope="col">VIIRS observed</th>
            <th scope="col">VIIRS-equivalent (model)</th>
            <th scope="col">Harmonized record</th>
            <th scope="col">5th percentile</th>
            <th scope="col">95th percentile</th>
          </tr>
        </thead>
        <tbody>
          {D.years.map((yr, i) => visible(i) && (
            <tr key={yr}>
              <th scope="row">{yr}</th>
              <td>{fmt(D.modis[i])}</td>
              <td>{D.viirs[i] == null ? "none" : fmt(D.viirs[i]!)}</td>
              <td>{fmt(D.pred[i])}</td>
              <td>{fmt(D.harmonized[i])}{D.viirs_partial[i] === 1 ? " (observed VIIRS part year + model)" : ""}</td>
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

/** Marker for a one-year view, where a line has nothing to join. */
function Dot({ cx, cy, color }: { cx: number; cy: number; color: string }) {
  return <circle cx={cx} cy={cy} r={5} fill={color} className="chart-fade" />;
}

function readoutRows(D: Annual, i: number, mode: Mode): [string, string][] {
  const yr = D.years[i], v = D.viirs[i], blended = D.viirs_partial[i] === 1;
  if (mode === "raw") {
    const rows: [string, string][] = [["MODIS", fmt(D.modis[i])]];
    if (v != null) rows.push(["VIIRS", fmt(v)]);
    return rows;
  }
  const band = `${fmt(D.lo[i])} - ${fmt(D.hi[i])}`;
  if (v == null) return [["VIIRS-equivalent", fmt(D.pred[i])], ["5-95% band", band]];
  const rows: [string, string][] = blended
    ? [["Harmonized", fmt(D.harmonized[i])], ["VIIRS observed (part year)", fmt(v)]]
    : [["VIIRS observed", fmt(v)]];
  if (yr >= 2020) rows.push(["Model prediction", fmt(D.pred[i])], ["5-95% band", band]);
  return rows;
}
