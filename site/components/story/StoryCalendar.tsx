import { compact, MONTHS, rampColor, rampPosition, type CalendarGrid } from "@/lib/series";

const CW = 22, CH = 13, GAP = 2, LX = 40, TY = 18;

export function StoryCalendar({ grid, label }: { grid: CalendarGrid; label: string }) {
  const W = LX + 12 * (CW + GAP), H = TY + grid.years.length * (CH + GAP);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="mx-auto w-full max-w-[420px]">
      {MONTHS.map((m, k) => (
        <text key={m} x={LX + k * (CW + GAP) + CW / 2} y={11} textAnchor="middle" fontSize={8.5} className="fill-muted-foreground">
          {m[0]}
        </text>
      ))}
      {grid.rows.map((row, r) => {
        const yr = grid.years[r];
        const yy = TY + r * (CH + GAP);
        return (
          <g key={yr} className="story-row" style={{ transitionDelay: `${r * 35}ms` }}>
            {(yr % 5 === 0 || r === 0 || r === grid.years.length - 1) && (
              <text x={LX - 6} y={yy + CH - 3} textAnchor="end" fontSize={9} className="fill-muted-foreground font-mono">
                {yr}
              </text>
            )}
            {row.map((c) => {
              const x = LX + (c.month - 1) * (CW + GAP);
              if (c.value == null) {
                return <rect key={c.month} x={x + 0.5} y={yy + 0.5} width={CW - 1} height={CH - 1} rx={2} fill="none" className="stroke-border" />;
              }
              const t = rampPosition(c.value, grid.max);
              const style = { "--cl": rampColor(t, "light").bg, "--cd": rampColor(t, "dark").bg } as React.CSSProperties;
              return (
                <rect key={c.month} x={x} y={yy} width={CW} height={CH} rx={2} className="story-cell" style={style}>
                  <title>{`${MONTHS[c.month - 1]} ${c.year}: ${compact(c.value)}${c.source === "forward" ? " (to date, incl. NOAA-20/21 forward link)" : c.source === "backcast" ? " (back-cast)" : ""}`}</title>
                </rect>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}
