// "Hear the 2012 satellite jump" (FE-013): pure value -> note mapping for components/PlayCalendar.tsx. No Web Audio
// here, so `node --test` can check it. Relative imports only (see lib/series.ts).
//
// The tour plays the years around the 2012 sensor switch twice: first the raw stitched record (MODIS counts before
// 2012, VIIRS after), where the notes jump up because VIIRS sees several times more fires; then the harmonized record,
// where they don't, because the jump was the satellite, not the fire.
import type { CalendarCell, CalendarGrid, GridView, SeriesBundle } from "./series.ts";

/** "raw" = the stitched record (viirs ?? modis), 2012 jump left in; "harmonized" = what the calendar shows (viirs ?? pred). */
export type Source = "raw" | "harmonized";

export const LOW_HZ = 130.81; // C3: the note for the fewest detections
// up to C6 (1047 Hz) for the most; three octaves so a x2.7 jump (Portugal at 2012, raw) is ~4 semitones, clearly heard
export const OCTAVES = 3;
export const YEAR_SECONDS = 1.44; // 12 months x 120 ms; a year in the week view takes the same time
// shortest tone: week steps are 28 ms, too short to hear a pitch, so week notes ring into the next step
export const MIN_NOTE = 0.045;
export const YEARS_BEFORE = 3; // the tour plays the switch year - 3 .. switch year + 2 (2009-2014)
export const YEARS_AFTER = 2;
export const GAP = 1; // seconds of silence between the raw and the harmonized clip

export type Note = {
  at: number; // seconds from the start of the tour
  dur: number; // seconds the tone sounds
  row: number; // calendar row and column of the cell, for the play highlight
  col: number;
  cell: CalendarCell;
  part: number; // 0 = raw clip, 1 = harmonized clip
  value: number | null; // the value played
  freq: number | null; // null = silence (no data, or zero detections)
};

/** Raw stitched values per index of the grid's view: VIIRS where it observed, else MODIS. */
export function rawValues(b: SeriesBundle, view: GridView): (number | null)[] {
  const s = view === "week" ? b.weekly : b.monthly;
  if (!s) return [];
  return s.modis.map((m, i) => s.viirs[i] ?? m);
}

/**
 * Pitch for a count: the calendar's log scale (log1p(value) / log1p(max), as `rampPosition`) spread over three octaves
 * from C3, so a higher note means more fire. Zero, missing or a zero max is silence.
 */
export function frequency(value: number | null, max: number): number | null {
  if (value == null || !(value > 0) || !(max > 0)) return null;
  const t = Math.min(1, Math.log1p(value) / Math.log1p(max));
  return LOW_HZ * 2 ** (OCTAVES * t);
}

/** Seconds per cell: a year always takes YEAR_SECONDS, whether it has 12 or 52 cells. */
export const stepSeconds = (cols: number) => YEAR_SECONDS / cols;

type Placed = { r: number; cell: CalendarCell };

/**
 * Cells the tour plays, in reading order: those inside the selected dates in the years from YEARS_BEFORE before the
 * sensor-switch year (first VIIRS-observed period, 2012) to YEARS_AFTER after it. Null when that leaves nothing before
 * the switch year or nothing in it (nothing to compare).
 */
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

/**
 * The two clips: every `jumpCells` cell in reading order, raw first, then harmonized after a GAP. Both share one
 * pitch scale (the larger maximum of the two records), so the VIIRS years sound the same in both clips and only the
 * years before the switch move. Null when `jumpCells` is null.
 */
export type Tour = {
  notes: Note[]; // raw clip, then harmonized clip, same length each
  seconds: number;
  step: number;
  partStart: number; // when the harmonized clip starts
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

/**
 * The note heard `time` seconds after the tour started, or null before it, in the gap between the clips and after
 * the end. `part` says which clip that time belongs to (1 from the start of the harmonized clip on).
 */
export function noteAt(tour: Tour, time: number): { note: Note | null; part: number } {
  const per = tour.notes.length / 2;
  const part = time >= tour.partStart ? 1 : 0;
  const k = Math.floor((time - part * tour.partStart) / tour.step);
  return { note: k >= 0 && k < per ? tour.notes[part * per + k] : null, part };
}

/** Short screen-reader line for the start of the tour (kept short: it is spoken over the notes). */
export function tourSummary(years: [number, number], switchYear: number): string {
  return `Playing ${years[0]} to ${years[1]}, raw then harmonized. Listen for the step at ${switchYear}.`;
}
