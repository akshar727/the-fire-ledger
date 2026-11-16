import { VIIRS_FROM } from "@/lib/annual";
import { compact } from "@/lib/series";
import type { LineSeries } from "@/lib/story";

const W = 640, H = 320, L = 52, R = 16, T = 16, B = 32;

function niceStep(max: number) {
  const raw = max / 4, p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw)!;
}

export function StoryLine({ lines, mode, label }: { lines: LineSeries; mode: "raw" | "harmonized"; label: string }) {
  const n = lines.years.length, j = lines.jumpAt;
  const top = Math.max(...lines.raw, ...lines.harmonized, ...lines.hi.map((v) => v ?? 0));
  const step = niceStep(top), yMax = Math.ceil(top / step) * step;
  const x = (i: number) => L + (i / (n - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - v / yMax) * (H - T - B);
  const path = (vals: (number | null)[], a: number, b: number) =>
    vals.slice(a, b).map((v, k) => `${k ? "L" : "M"}${x(a + k).toFixed(1)},${y(v ?? 0).toFixed(1)}`).join("");
  const band = () => {
    const up = lines.hi.slice(0, j).map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v!).toFixed(1)}`).join("");
    const down = lines.lo.slice(0, j).map((_, i) => `L${x(j - 1 - i).toFixed(1)},${y(lines.lo[j - 1 - i]!).toFixed(1)}`).join("");
    return `${up}${down}Z`;
  };
  const ticks = Array.from({ length: Math.round(yMax / step) + 1 }, (_, k) => k * step);
  const yearTicks = lines.years.map((yr, i) => [yr, i] as const).filter(([yr]) => yr % 5 === 0 || yr === VIIRS_FROM);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="w-full overflow-visible">
      {ticks.map((v) => (
        <g key={v}>
          <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="stroke-border" />
          <text x={L - 8} y={y(v) + 4} textAnchor="end" fontSize={11} className="fill-muted-foreground font-mono">
            {compact(v)}
          </text>
        </g>
      ))}
      {yearTicks.map(([yr, i]) => (
        <text key={yr} x={x(i)} y={H - 10} textAnchor="middle" fontSize={11} className="fill-muted-foreground font-mono">
          {yr}
        </text>
      ))}
      <line x1={x(j)} x2={x(j)} y1={T} y2={H - B} className="stroke-muted-foreground/60" strokeDasharray="2 3" />
      <text x={x(j) + 6} y={T + 10} fontSize={11} className="fill-muted-foreground">
        VIIRS starts
      </text>

      {mode === "raw" ? (
        <>
          <path d={path(lines.raw, 0, j)} pathLength={1} fill="none" stroke="var(--modis)" strokeWidth={2.5} className="story-draw" />
          <path d={path(lines.raw, j - 1, j + 1)} fill="none" stroke="var(--primary)" strokeWidth={2.5} strokeDasharray="4 4" className="story-fade story-late" />
          <path d={path(lines.raw, j, n)} pathLength={1} fill="none" stroke="var(--viirs)" strokeWidth={2.5} className="story-draw story-late" />
        </>
      ) : (
        <>
          <path d={band()} fill="var(--primary)" opacity={0.2} className="story-fade" />
          <path d={path(lines.harmonized, 0, j + 1)} pathLength={1} fill="none" stroke="var(--primary)" strokeWidth={2.5} className="story-draw" />
          <path d={path(lines.harmonized, j, n)} pathLength={1} fill="none" stroke="var(--viirs)" strokeWidth={2.5} className="story-draw" />
          <path d={path(lines.raw, 0, j)} fill="none" stroke="var(--modis)" strokeWidth={1.5} strokeDasharray="3 4" opacity={0.6} />
        </>
      )}
    </svg>
  );
}

export function StoryLegend({ mode }: { mode: "raw" | "harmonized" }) {
  const items =
    mode === "raw"
      ? [
          { color: "var(--modis)", text: "MODIS, 1 km pixels" },
          { color: "var(--viirs)", text: "VIIRS, 375 m pixels" },
        ]
      : [
          { color: "var(--primary)", text: "MODIS years in VIIRS terms, with 5-95% band" },
          { color: "var(--viirs)", text: "VIIRS, observed" },
          { color: "var(--modis)", text: "raw MODIS (dashed)", dash: true },
        ];
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11.5px] tracking-[0.06em] text-muted-foreground uppercase">
      {items.map((it) => (
        <li key={it.text} className="flex items-center gap-2">
          <svg width="20" height="10" aria-hidden>
            <line x1="0" x2="20" y1="5" y2="5" stroke={it.color} strokeWidth="2.5" strokeDasharray={"dash" in it ? "3 3" : undefined} />
          </svg>
          {it.text}
        </li>
      ))}
    </ul>
  );
}
