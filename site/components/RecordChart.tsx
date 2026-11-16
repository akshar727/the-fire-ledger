"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { DownloadPicture } from "@/components/DownloadPicture";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  completeEnd,
  dayLabel,
  eraMeans,
  estimateOf,
  forwardFrom,
  harmonizedLabel,
  HOLD_FROM,
  holdoutYears,
  isForward,
  isPartial,
  isSparse,
  lastCompleteYear,
  partialLabel,
  VIIRS_FROM,
  type Annual,
} from "@/lib/annual";
import { composePicture, pictureName } from "@/lib/picture";
import { cssVar, pageTheme, serializeChart } from "@/lib/picture-dom";
import { compact } from "@/lib/series";

type Mode = "raw" | "harm";

const W = 800, H = 330, L = 55, R = 15, T = 18, B = 30;
const fmt = (v: number) => Math.round(v).toLocaleString("en-US");

function tickStep(max: number): number {
  const raw = max / 5, p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).reduce((best, s) => (Math.abs(s - raw) < Math.abs(best - raw) ? s : best));
}

function MarkerLabel({ at, children }: { at: number; children: string }) {
  const flip = at > W - R - 90;
  return (
    <text x={flip ? at - 5 : at + 5} y={T + 8} textAnchor={flip ? "end" : "start"} className="fill-muted-foreground">
      {children}
    </text>
  );
}

export function RecordChart({
  data,
  region,
  regionId,
  years,
}: {
  data: Annual;
  region: string;
  regionId: string;
  years: [number, number];
}) {
  const [mode, setMode] = useState<Mode>("raw");
  const [hoverAt, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const D = data;
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
  const i2003 = D.years.indexOf(2003), i2012 = D.years.indexOf(VIIRS_FROM), i2020 = D.years.indexOf(HOLD_FROM);
  const end = completeEnd(D);
  const [h0, h1] = holdoutYears(D);
  const holdEnd = D.years.indexOf(h1) + 1;
  const inHold = (i: number) => i >= i2020 && i < holdEnd;
  const tail = D.years.flatMap((_, i) => (i >= end && visible(i) ? [i] : []));

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
  const backcast = D.pred.map((p, i) => (i < i2012 ? p : i === i2012 ? D.harmonized[i] : null));

  const ticks: number[] = [];
  for (let v = 0, s = Math.max(1, tickStep(max / 1.05)); v <= max; v += s) ticks.push(v);
  const labelEvery = n <= 8 ? 1 : n <= 16 ? 2 : 3;

  const era = eraMeans(D);
  const s = D.score;
  const by = estimateOf(D) === "ratio" ? "the ratio" : "the model";
  const sparse = isSparse(D);
  const noJump = sparse || !Number.isFinite(era.jump);
  const note =
    mode === "raw"
      ? `This is a naively stitched ledger. The mean detections per year go from ${fmt(era.modis)} (MODIS era data) to ${fmt(era.viirs)} (VIIRS era, complete years, with 1-19 January ${VIIRS_FROM} filled by ${by})` +
        (noJump
          ? `: too few detections to read a jump.`
          : `: ×${era.jump.toFixed(1)}, mostly because VIIRS has finer pixels, not because fire actually changed.`)
      : sparse
        ? `Too little fire here to score the hold-out years ${h0}-${h1}: the back-cast is MODIS times one ratio and isn't validated.`
        : by === "the ratio"
          ?
            `This is a constant-ratio estimate. Hold-out years were ${h0}-${h1}: mean annual error ${s.mape_ratio.toFixed(1)}%` +
            (D.model_score?.mape_model != null && Number.isFinite(D.model_score.mape_model)
              ? ` vs ${D.model_score.mape_model.toFixed(1)}% for our model, which lost here`
              : "") +
            `. The 5-95% band contains the observed total in ${s.coverage} of ${s.n_hold} years. The weekly correlation r = ${s.weekly_r.toFixed(3)}.`
          : `Hold-out years were ${h0}-${h1} (the model never saw these years): mean annual error ${s.mape_model.toFixed(1)}% vs ${s.mape_ratio.toFixed(1)}% for a single constant factor; the 5-95% band contains the observed total in ${s.coverage} of ${s.n_hold} years. The weekly correlation r = ${s.weekly_r.toFixed(3)}.`;

  const legend: { color: string; label: string; kind?: "dash" | "ring" }[] =
    mode === "raw"
      ? [
          { color: "var(--modis)", label: `MODIS detections (${D.years[0]}-${VIIRS_FROM - 1})` },
          { color: "var(--viirs)", label: `VIIRS detections (${VIIRS_FROM}-${lastCompleteYear(D)})` },
        ]
      : [
          { color: "var(--primary)", label: "Back-cast VIIRS-equivalent, 5-95% band" },
          { color: "var(--viirs)", label: `VIIRS observed (1-19 Jan ${VIIRS_FROM} from ${by})` },
          { color: "var(--primary)", label: `Hold-out prediction ${h0}-${h1}`, kind: "dash" },
        ];
  for (const i of tail) {
    const fwd = mode === "harm" && isForward(D, i);
    legend.push({ color: "var(--viirs)", label: `${fwd ? harmonizedLabel(D, i) : partialLabel(D, i)}, partial year`, kind: "ring" });
    if (fwd) legend.push({ color: "var(--viirs)", label: `from ${forwardFrom(D)}: NOAA-20/21 forward link`, kind: "dash" });
  }
  const fwdTail = mode === "harm" ? tail.find((i) => isForward(D, i)) : undefined;
  const fwdNote =
    fwdTail == null
      ? ""
      : ` Suomi NPP data end ${dayLabel(D.data_through)}; ${harmonizedLabel(D, fwdTail)} adds S-NPP-equivalent counts from NOAA-20 and NOAA-21 for ${forwardFrom(D)} onwards (dashed stem).`;

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight") setHover(Math.min(b, (hover ?? a - 1) + 1));
    else if (e.key === "ArrowLeft") setHover(Math.max(a, (hover ?? b + 1) - 1));
    else if (e.key === "Escape") setHover(null);
    else return;
    e.preventDefault();
  };

  const readout = hover == null ? null : readoutRows(D, hover, mode, inHold(hover));

  const y0 = D.years[a], y1 = D.years[b];
  const makePicture = () => {
    if (!svgRef.current) return null;
    const theme = pageTheme();
    const color = (c: string) => (c.startsWith("var(") ? cssVar(c.slice(4, -1), theme.bg) : c);
    const chart = serializeChart(svgRef.current, theme.bg);
    return composePicture({
      title: `Annual active-fire detections, ${region}`,
      subtitle: `${mode === "raw" ? "Raw (naively stitched) ledger" : "Harmonized ledger, VIIRS scale"}, ${y0 === y1 ? y0 : `${y0}-${y1}`}`,
      legend: legend.map((l) => ({ ...l, color: color(l.color), kind: l.kind ?? "line" })),
      body: chart.body,
      bodyWidth: chart.width,
      bodyHeight: chart.height,
      note: note + fwdNote,
      theme,
    });
  };

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
          {legend.map(({ color, label, kind }) => (
            <li key={label} className="flex items-center gap-2">
              <svg width="20" height="10" aria-hidden>
                {kind === "ring" ? (
                  <circle cx="10" cy="5" r="3.5" fill="var(--card)" stroke={color} strokeWidth="2" />
                ) : (
                  <line x1="0" x2="20" y1="5" y2="5" stroke={color} strokeWidth="2.5" strokeDasharray={kind === "dash" ? "5 3" : undefined} />
                )}
              </svg>
              {label}
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
          <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full text-[11px]" aria-hidden>
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
                {visible(i2003 - 1) && a < i2003 - 1 && (
                  <>
                    <rect x={x(a)} y={T} width={x(i2003 - 1) - x(a)} height={H - T - B} className="fill-muted chart-fade" />
                    <text x={x(a) + 5} y={T + 8} className="fill-muted-foreground">Terra only to mid-2002</text>
                  </>
                )}
                <path d={path(D.modis, 0, i2012)} pathLength={1} fill="none" stroke="var(--modis)" strokeWidth={2.25} className="chart-draw" />
                <path d={path(D.viirs, i2012, end)} pathLength={1} fill="none" stroke="var(--viirs)" strokeWidth={2.25} className="chart-draw" />
                {visible(i2012 - 1) && visible(i2012) && (
                  <path
                    d={`M${x(i2012 - 1)} ${y(D.modis[i2012 - 1])}L${x(i2012)} ${y(D.viirs[i2012] ?? 0)}`}
                    className="stroke-muted-foreground chart-fade"
                    strokeDasharray="2 3"
                  />
                )}
                {n === 1 && a < end && <Dot cx={x(a)} cy={y(a < i2012 ? D.modis[a] : (D.viirs[a] ?? 0))} color={a < i2012 ? "var(--modis)" : "var(--viirs)"} />}
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
                <path d={band(i2020, holdEnd)} fill="var(--primary)" opacity={0.18} className="chart-fade" />
                <path d={path(backcast, 0, i2012 + 1)} pathLength={1} fill="none" stroke="var(--primary)" strokeWidth={2.25} className="chart-draw" />
                <path d={path(D.harmonized, i2012, end)} pathLength={1} fill="none" stroke="var(--viirs)" strokeWidth={2.25} className="chart-draw" />
                <path d={path(D.pred, i2020, holdEnd)} fill="none" stroke="var(--primary)" strokeWidth={2.25} strokeDasharray="5 4" className="chart-fade" />
                {n === 1 && (a < i2012 || inHold(a)) && (
                  <line x1={x(a)} x2={x(a)} y1={y(D.lo[a])} y2={y(D.hi[a])} stroke="var(--primary)" strokeWidth={6} opacity={0.25} />
                )}
                {n === 1 && a < end && <Dot cx={x(a)} cy={y(a < i2012 ? D.pred[a] : D.harmonized[a])} color={a < i2012 ? "var(--primary)" : "var(--viirs)"} />}
              </g>
            )}

            {tail.map((i) => {
              const raw = i < i2012 ? D.modis[i] : (D.viirs[i] ?? D.pred[i]);
              const fwd = mode === "harm" && isForward(D, i);
              const cy = y(fwd ? D.harmonized[i] : raw);
              const below = !fwd && cy + 20 < H - B - 4;
              return (
                <g key={`partial-${i}`} className="chart-fade">
                  {fwd && (
                    <>
                      <line x1={x(i)} x2={x(i)} y1={cy + 5} y2={Math.max(cy + 5, y(raw))} stroke="var(--viirs)" strokeWidth={2} strokeDasharray="3 2" />
                      <circle cx={x(i)} cy={y(raw)} r={2.5} fill="var(--viirs)" />
                    </>
                  )}
                  <circle cx={x(i)} cy={cy} r={5} fill="var(--card)" stroke="var(--viirs)" strokeWidth={2} />
                  <text
                    x={n === 1 ? x(i) : x(i) + 6}
                    y={below ? cy + 20 : cy - 11}
                    textAnchor={n === 1 ? "middle" : "end"}
                    className="fill-muted-foreground"
                  >
                    {fwd ? harmonizedLabel(D, i) : partialLabel(D, i)}
                  </text>
                </g>
              );
            })}

            {hover != null && (
              <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="stroke-foreground/40" data-no-export />
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
              <p className="mb-1 font-medium">
                <span className="font-mono">{D.years[hover]}</span>
                {isPartial(D, hover) && <span className="text-muted-foreground"> · partial year</span>}
              </p>
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
        {fwdNote}
      </p>

      <DownloadPicture
        make={makePicture}
        name={pictureName("record", regionId,mode === "raw" ? "raw" : "harmonized", y0 === y1 ? y0 : `${y0}-${y1}`)}
        what="ledger chart"
      />

      <div className="sr-only">
      <table>
        <caption>
          Annual active-fire detections, {region}
          {tail.length > 0 && `. ${tail.map((i) => D.years[i]).join(", ")} is a partial year, data to ${dayLabel(D.data_through)}.`}
          {tail.some((i) => isForward(D, i)) &&
            ` Its harmonized ledger adds S-NPP-equivalent counts from NOAA-20/21 to ${dayLabel(D.forward_through!)}.`}
        </caption>
        <thead>
          <tr>
            <th scope="col">Year</th>
            <th scope="col">MODIS</th>
            <th scope="col">VIIRS observed</th>
            <th scope="col">VIIRS-equivalent ({by === "the ratio" ? "constant ratio" : "model"})</th>
            <th scope="col">Harmonized ledger</th>
            <th scope="col">5th percentile</th>
            <th scope="col">95th percentile</th>
          </tr>
        </thead>
        <tbody>
          {D.years.map((yr, i) => visible(i) && (
            <tr key={yr}>
              <th scope="row">{isPartial(D, i) ? `${yr} (partial year, to ${dayLabel(D.data_through)})` : yr}</th>
              <td>{fmt(D.modis[i])}</td>
              <td>{D.viirs[i] == null ? "none" : fmt(D.viirs[i]!)}</td>
              {isPartial(D, i) && isForward(D, i) ? (
                <>
                  <td>not shown: partial year</td>
                  <td>{fmt(D.harmonized[i])} (to {dayLabel(D.forward_through!)}, with the NOAA-20/21 forward link)</td>
                  <td colSpan={2}>not shown: partial year</td>
                </>
              ) : isPartial(D, i) ? (
                <td colSpan={4}>not shown: partial year, outside the hold-out</td>
              ) : (
                <>
                  <td>{fmt(D.pred[i])}</td>
                  <td>{fmt(D.harmonized[i])}{D.viirs_partial[i] === 1 ? ` (observed VIIRS part year + ${by === "the ratio" ? "ratio" : "model"})` : ""}</td>
                  <td>{fmt(D.lo[i])}</td>
                  <td>{fmt(D.hi[i])}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

function Dot({ cx, cy, color }: { cx: number; cy: number; color: string }) {
  return <circle cx={cx} cy={cy} r={5} fill={color} className="chart-fade" />;
}

function readoutRows(D: Annual, i: number, mode: Mode, hold: boolean): [string, string][] {
  const v = D.viirs[i], blended = D.viirs_partial[i] === 1;
  const through: [string, string][] = isPartial(D, i) ? [["Data through", dayLabel(D.data_through)]] : [];
  if (mode === "harm" && isForward(D, i))
    return [
      [`VIIRS observed to ${dayLabel(D.data_through, false)}`, fmt(v ?? 0)],
      [`With NOAA-20/21 to ${dayLabel(D.forward_through!, false)}`, fmt(D.harmonized[i])],
    ];
  if (mode === "raw") {
    const rows: [string, string][] = [["MODIS", fmt(D.modis[i])]];
    if (v != null) rows.push(["VIIRS", fmt(v)]);
    return [...rows, ...through];
  }
  const band = `${fmt(D.lo[i])} - ${fmt(D.hi[i])}`;
  if (v == null) return [["VIIRS-equivalent", fmt(D.pred[i])], ["5-95% band", band], ...through];
  const rows: [string, string][] = blended
    ? [["Harmonized", fmt(D.harmonized[i])], ["VIIRS observed (part year)", fmt(v)]]
    : [["VIIRS observed", fmt(v)]];
  if (hold) rows.push([D.method === "ratio" ? "Ratio estimate" : "Model prediction", fmt(D.pred[i])], ["5-95% band", band]);
  return [...rows, ...through];
}
