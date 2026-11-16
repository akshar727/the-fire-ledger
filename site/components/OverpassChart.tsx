// FE-031 (F-3b): the MODIS orbit drift as a picture. Median daytime local overpass time of Terra, Aqua and Suomi NPP per year, one
// thin line per deep dive (they lie on top of each other: the drift is the satellite's, not the place's), drifted years
// shaded. Server component: plain SVG, no client JS. Data: annual.json `overpass` / `drifted` (ML-016), lib/overpass.ts.
import { clock, driftedYears, linePath, runs, SENSOR_NAME, SENSORS, type OverpassSource, type Sensor } from "@/lib/overpass";

const W = 640;
const H = 280;
const M = { top: 14, right: 16, bottom: 30, left: 52 };
const Y0 = 8.5; // local hours shown: 8:30 to 15:30
const Y1 = 15.5;
const COLOR: Readonly<Record<Sensor, string>> = { terra: "var(--modis)", aqua: "var(--modis)", snpp: "var(--viirs)" };
const DASH: Readonly<Record<Sensor, string | undefined>> = { terra: undefined, aqua: "6 4", snpp: "1 4" };
const WIDTH: Readonly<Record<Sensor, number>> = { terra: 1.5, aqua: 1.5, snpp: 2.5 }; // S-NPP dotted and heavier: not only colour

export function OverpassChart({ records }: { records: { id: string; name: string; D: OverpassSource }[] }) {
  const rs = records.filter((r) => r.D.overpass);
  if (!rs.length) return null;
  const years = [...new Set(rs.flatMap((r) => r.D.years))].sort((a, b) => a - b); // each line uses its own years
  const first = years[0];
  const last = years.at(-1)!;
  const x = (yr: number) => M.left + ((yr - first) / Math.max(last - first, 1)) * (W - M.left - M.right);
  const y = (h: number) => M.top + ((Y1 - h) / (Y1 - Y0)) * (H - M.top - M.bottom);
  const drifted = driftedYears(rs.map((r) => r.D));
  const step = (W - M.left - M.right) / Math.max(last - first, 1);
  const ticksY = [9, 11, 13, 15];
  // every 5 years plus the ends, but an end within 2 years of a 5-year tick replaces it (no "20252026" overlap)
  const fives = years.filter((yr) => yr % 5 === 0 && yr - first > 2 && last - yr > 2);
  const ticksX = [first, ...fives, last];

  return (
    <figure className="flex flex-col gap-3">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full overflow-visible"
        role="img"
        aria-labelledby="overpass-title"
      >
        <title id="overpass-title">
          Local overpass time per year: Terra drifts earlier and Aqua later in the shaded years; Suomi NPP holds steady.
        </title>
        {runs(drifted).map(([a, b]) => (
          <rect
            key={a}
            x={x(a) - step / 2}
            y={M.top}
            width={x(b) - x(a) + step}
            height={H - M.top - M.bottom}
            fill="var(--primary)"
            opacity={0.12}
          />
        ))}
        {ticksY.map((h) => (
          <g key={h}>
            <line x1={M.left} x2={W - M.right} y1={y(h)} y2={y(h)} stroke="var(--border)" />
            <text x={M.left - 8} y={y(h)} dy="0.32em" textAnchor="end" fontSize={13} fill="var(--muted-foreground)">
              {clock(h)}
            </text>
          </g>
        ))}
        {ticksX.map((yr) => (
          <text key={yr} x={x(yr)} y={H - 8} textAnchor="middle" fontSize={13} fill="var(--muted-foreground)">
            {yr}
          </text>
        ))}
        {rs.flatMap((r) =>
          SENSORS.map((s) => (
            <path
              key={`${r.id}-${s}`}
              d={linePath(r.D.years, r.D.overpass?.[s] ?? [], x, y)}
              fill="none"
              stroke={COLOR[s]}
              strokeWidth={WIDTH[s]}
              strokeLinecap="round"
              strokeDasharray={DASH[s]}
              strokeLinejoin="round"
              opacity={0.85}
            />
          )),
        )}
      </svg>
      <figcaption className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
        {SENSORS.map((s) => (
          <span key={s} className="inline-flex items-center gap-2">
            <svg width="22" height="8" aria-hidden>
              <line x1="0" x2="22" y1="4" y2="4" stroke={COLOR[s]} strokeWidth={WIDTH[s] + 0.5} strokeDasharray={DASH[s]} strokeLinecap="round" />
            </svg>
            {SENSOR_NAME[s]}
            {s === "snpp" ? " (VIIRS)" : " (MODIS)"}
          </span>
        ))}
        {drifted.length > 0 && (
          <span className="inline-flex items-center gap-2">
            <span aria-hidden className="inline-block h-3 w-4 rounded-[2px] bg-primary/15" />
            drifted years ({runs(drifted).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ")})
          </span>
        )}
        <span>
          One line per deep dive ({rs.map((r) => r.name).join(", ")}): the median daytime local solar time of each
          satellite&apos;s detections that year.
        </span>
      </figcaption>
      <div className="sr-only">
        <table>
          <caption>Median daytime local overpass time of each satellite&apos;s fire detections per year, by deep dive</caption>
          <thead>
            <tr>
              <th scope="col">Year</th>
              {rs.flatMap((r) =>
                SENSORS.map((s) => (
                  <th key={`${r.id}-${s}`} scope="col">
                    {SENSOR_NAME[s]}, {r.name}
                  </th>
                )),
              )}
            </tr>
          </thead>
          <tbody>
            {years.map((yr) => (
              <tr key={yr}>
                <th scope="row">
                  {yr}
                  {drifted.includes(yr) ? " (drifted)" : ""}
                </th>
                {rs.flatMap((r) =>
                  SENSORS.map((s) => {
                    const v = r.D.overpass?.[s]?.[r.D.years.indexOf(yr)];
                    return <td key={`${r.id}-${s}`}>{typeof v === "number" ? clock(v) : "none"}</td>;
                  }),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
