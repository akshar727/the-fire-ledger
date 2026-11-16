import type { CalendarCell, CalendarGrid, GridView, SeriesBundle } from "./series.ts";

export type Source = "raw" | "harmonized";

export const LOW_HZ = 130.81;
export const OCTAVES = 3;
export const YEAR_SECONDS = 1.44;
export const MIN_NOTE = 0.045;
export const YEARS_BEFORE = 3;
export const YEARS_AFTER = 2;
export const GAP = 1;

export type Note = {
  at: number;
  dur: number;
  row: number;
  col: number;
  cell: CalendarCell;
  part: number;
  value: number | null;
  freq: number | null;
};

export function rawValues(b: SeriesBundle, view: GridView): (number | null)[] {
  const s = view === "week" ? b.weekly : b.monthly;
  if (!s) return [];
  return s.modis.map((m, i) => s.viirs[i] ?? m);
}

export function frequency(value: number | null, max: number): number | null {
  if (value == null || !(value > 0) || !(max > 0)) return null;
  const t = Math.min(1, Math.log1p(value) / Math.log1p(max));
  return LOW_HZ * 2 ** (OCTAVES * t);
}

export const stepSeconds = (cols: number) => YEAR_SECONDS / cols;

type Placed = { r: number; cell: CalendarCell };

export function jumpCells(grid: CalendarGrid): { cells: Placed[]; switchYear: number } | null {
  const switchYear = grid.firstObserved?.year;
  if (switchYear == null) return null;
  const cells = grid.rows.flatMap((row, r) =>
    row.flatMap((cell) =>
      cell.inRange && cell.year >= switchYear - YEARS_BEFORE && cell.year <= switchYear + YEARS_AFTER ? [{ r, cell }] : [],
    ),
  );
  if (!cells.some((c) => c.cell.year < switchYear) || !cells.some((c) => c.cell.year === switchYear)) return null;
  return { cells, switchYear };
}

export type Tour = {
  notes: Note[];
  seconds: number;
  step: number;
  partStart: number;
  switchYear: number;
  years: [number, number];
};

export function jumpTour(grid: CalendarGrid, raw: (number | null)[]): Tour | null {
  const jc = jumpCells(grid);
  if (!jc) return null;
  const { cells } = jc;
  const rawOf = (c: CalendarCell) => (c.value == null ? null : (raw[c.index] ?? null));
  const max = Math.max(grid.max, ...raw.filter((v): v is number => v != null));
  const step = stepSeconds(grid.cols);
  const partStart = cells.length * step + GAP;
  const notes: Note[] = [];
  (["raw", "harmonized"] as const).forEach((source, part) =>
    cells.forEach(({ r, cell }, k) => {
      const value = source === "raw" ? rawOf(cell) : cell.value;
      notes.push({
        at: part * partStart + k * step,
        dur: Math.max(step * 0.85, MIN_NOTE),
        row: r,
        col: cell.col,
        cell,
        part,
        value,
        freq: frequency(value, max),
      });
    }),
  );
  const years: [number, number] = [cells[0].cell.year, cells.at(-1)!.cell.year];
  return { notes, seconds: partStart + cells.length * step, step, partStart, switchYear: jc.switchYear, years };
}

export function noteAt(tour: Tour, time: number): { note: Note | null; part: number } {
  const per = tour.notes.length / 2;
  const part = time >= tour.partStart ? 1 : 0;
  const k = Math.floor((time - part * tour.partStart) / tour.step);
  return { note: k >= 0 && k < per ? tour.notes[part * per + k] : null, part };
}

export function tourSummary(years: [number, number], switchYear: number): string {
  return `Playing ${years[0]} to ${years[1]}, raw then harmonized. Listen for the step at ${switchYear}.`;
}
