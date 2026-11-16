import { metricFrame, PIXEL_M, utc, type Bbox, type Pass } from "@/lib/story";

export const SAT: Record<string, string> = { Aqua: "Aqua MODIS", Terra: "Terra MODIS", SNPP: "Suomi NPP VIIRS" };

function Panel({ pass, frame, pixel, color, id }: { pass: Pass; frame: Bbox; pixel: number; color: string; id: string }) {
  const f = metricFrame(frame);
  const W = f.width, H = f.height;
  const scaleBar = 5000;
  return (
    <figure className="flex flex-col gap-2">
      <svg
        viewBox={`0 0 ${W.toFixed(0)} ${H.toFixed(0)}`}
        role="img"
        aria-labelledby={`${id}-cap`}
        className="w-full rounded-lg border bg-card"
      >
        <g className="story-pixels">
          {pass.points.map((p, i) => {
            const [x, y] = f.project(p);
            return (
              <rect
                key={i}
                x={x - pixel / 2}
                y={y - pixel / 2}
                width={pixel}
                height={pixel}
                fill={color}
                fillOpacity={0.82}
                style={{ transitionDelay: `${Math.round((i / pass.points.length) * 700)}ms` }}
              />
            );
          })}
        </g>
        <g transform={`translate(${W - scaleBar - 900} ${H - 800})`} className="fill-muted-foreground">
          <rect width={scaleBar} height={220} />
          <text y={-360} fontSize={1500} className="font-mono">
            5 km
          </text>
        </g>
      </svg>
      <figcaption id={`${id}-cap`} className="flex items-baseline justify-between gap-3 font-mono text-xs tracking-[0.04em]">
        <span>
          <span className="font-medium">{SAT[pass.satellite] ?? pass.satellite}</span>
          <span className="text-muted-foreground">, {utc(pass.time)}, {pixel >= 1000 ? "1 km" : `${pixel} m`} pixels</span>
        </span>
        <span className="font-mono text-2xl font-semibold tabular-nums">{pass.points.length}</span>
      </figcaption>
    </figure>
  );
}

export function FireFootprints({ modis, viirs, frame }: { modis: Pass; viirs: Pass; frame: Bbox }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Panel pass={modis} frame={frame} pixel={PIXEL_M.modis} color="var(--modis)" id="fp-modis" />
      <Panel pass={viirs} frame={frame} pixel={PIXEL_M.viirs} color="var(--viirs)" id="fp-viirs" />
    </div>
  );
}
