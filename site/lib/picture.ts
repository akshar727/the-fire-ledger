// Picture downloads (FE-015): pure SVG builders for the "Download picture" buttons, no DOM, so `node --test` can check
// them. `composePicture` frames any chart body with a title, subtitle, legend and the FIRMS acknowledgment footer;
// `calendarBody` draws the burn calendar table as SVG. Colours arrive already resolved (hex or rgb), so the file opens
// the same in a browser, an image viewer or a vector editor. The browser half (serialising the live chart, PNG) is in
// lib/picture-dom.ts.
import { compact, MONTHS, weekMonthGroups, type CalendarGrid, type CalendarStats } from "./series.ts";

/** Plain-text FIRMS acknowledgment (same words as components/FirmsAcknowledgment.tsx). */
export const FIRMS_CREDIT =
  "We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS) " +
  "(https://earthdata.nasa.gov/firms), part of NASA's Land, Atmosphere Near real-time Capability for Earth observations " +
  "(LANCE) (https://earthdata.nasa.gov/lance) and NASA's Earth Science Data and Information System (ESDIS).";

export const SANS = "system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
export const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** Resolved page colours for one colour scheme. */
export type PictureTheme = {
  bg: string;
  fg: string;
  muted: string; // hatch for "no data" cells
  mutedFg: string;
  border: string;
};

export type LegendItem = { color: string; label: string; kind?: "line" | "dash" | "ring" | "swatch" | "up" | "down" };

/** Escapes text and attribute values for SVG/XML. */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Greedy word wrap on an estimated text width (average glyph ≈ 0.53 em for a system sans). */
export function wrap(text: string, maxWidth: number, fontSize: number): string[] {
  const perLine = Math.max(10, Math.floor(maxWidth / (fontSize * 0.53)));
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > perLine) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

const approxWidth = (s: string, size: number) => s.length * size * 0.53;

function legendMark(item: LegendItem, x: number, y: number, bg: string, border: string): string {
  const c = esc(item.color);
  switch (item.kind) {
    case "ring":
      return `<circle cx="${x + 10}" cy="${y}" r="3.5" fill="${esc(bg)}" stroke="${c}" stroke-width="2"/>`;
    case "swatch":
      return `<rect x="${x + 4}" y="${y - 6}" width="12" height="12" rx="2" fill="${c}" stroke="${esc(border)}"/>`;
    case "up":
      return `<path d="M${x + 10} ${y - 5}L${x + 15} ${y + 4}L${x + 5} ${y + 4}Z" fill="${c}"/>`;
    case "down":
      return `<path d="M${x + 5} ${y - 4}L${x + 15} ${y - 4}L${x + 10} ${y + 5}Z" fill="${c}"/>`;
    default:
      return `<line x1="${x}" x2="${x + 20}" y1="${y}" y2="${y}" stroke="${c}" stroke-width="2.5"${item.kind === "dash" ? ' stroke-dasharray="5 3"' : ""}/>`;
  }
}

export type PictureSpec = {
  title: string;
  subtitle: string;
  legend: LegendItem[];
  /** Inner SVG markup drawn in a box of bodyWidth × bodyHeight user units. */
  body: string;
  bodyWidth: number;
  bodyHeight: number;
  /** Optional sentence under the body (e.g. the chart's note). */
  note?: string;
  theme: PictureTheme;
  width?: number; // total width, default 960
};

/**
 * A standalone SVG document: title, subtitle, legend, the body scaled to fit, an optional note and a footer with the
 * FIRMS acknowledgment and the site name. Returns the markup and its size (the PNG is drawn at 2× that).
 */
export function composePicture(spec: PictureSpec): { svg: string; width: number; height: number } {
  const W = spec.width ?? 960, pad = 32, inner = W - 2 * pad;
  const t = spec.theme;
  const parts: string[] = [];
  let y = pad + 22;
  parts.push(`<text x="${pad}" y="${y}" font-family="${esc(SANS)}" font-size="22" font-weight="600" fill="${esc(t.fg)}">${esc(spec.title)}</text>`);
  y += 24;
  parts.push(`<text x="${pad}" y="${y}" font-family="${esc(SANS)}" font-size="14" fill="${esc(t.mutedFg)}">${esc(spec.subtitle)}</text>`);

  // legend: items flow left to right and wrap
  y += 26;
  let lx = pad;
  for (const item of spec.legend) {
    const w = 26 + approxWidth(item.label, 12) + 18;
    if (lx > pad && lx + w > W - pad) {
      lx = pad;
      y += 20;
    }
    parts.push(legendMark(item, lx, y - 4, t.bg, t.border));
    parts.push(`<text x="${lx + 26}" y="${y}" font-family="${esc(SANS)}" font-size="12" fill="${esc(t.mutedFg)}">${esc(item.label)}</text>`);
    lx += w;
  }

  // body, scaled to the inner width
  y += 16;
  const scale = inner / spec.bodyWidth, bodyH = spec.bodyHeight * scale;
  parts.push(
    `<svg x="${pad}" y="${y}" width="${inner}" height="${bodyH.toFixed(1)}" viewBox="0 0 ${spec.bodyWidth} ${spec.bodyHeight}" overflow="visible">${spec.body}</svg>`,
  );
  y += bodyH;

  if (spec.note) {
    y += 10;
    for (const line of wrap(spec.note, inner, 13)) {
      y += 18;
      parts.push(`<text x="${pad}" y="${y}" font-family="${esc(SANS)}" font-size="13" fill="${esc(t.mutedFg)}">${esc(line)}</text>`);
    }
  }

  // footer: rule, credit, site
  y += 22;
  parts.push(`<line x1="${pad}" x2="${W - pad}" y1="${y}" y2="${y}" stroke="${esc(t.border)}"/>`);
  y += 4;
  for (const line of wrap(FIRMS_CREDIT, inner, 11)) {
    y += 15;
    parts.push(`<text x="${pad}" y="${y}" font-family="${esc(SANS)}" font-size="11" fill="${esc(t.mutedFg)}">${esc(line)}</text>`);
  }
  y += 18;
  parts.push(`<text x="${pad}" y="${y}" font-family="${esc(SANS)}" font-size="11" font-weight="600" fill="${esc(t.fg)}">One Fire Record · one-fire-record.vercel.app</text>`);
  const H = Math.ceil(y + pad);

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<title>${esc(spec.title)}</title>` +
    `<rect width="100%" height="100%" fill="${esc(t.bg)}"/>` +
    parts.join("") +
    `</svg>`;
  return { svg, width: W, height: H };
}

export type CalendarColors = {
  /** Cell fill and label ink for a value (the page's log ramp, already resolved). */
  cell: (value: number) => { bg: string; ink: string };
  theme: PictureTheme;
};

const YEAR_W = 78, HEAD_H = 22;

/**
 * The burn calendar as SVG: one row per year, 12 month cells with the compact value, ▲/▼ for flagged months, a hatch
 * for months with no data, dimmed months outside the selected dates, and the median / middle-half rows when the
 * calendar statistics exist. Week view (FE-016): 52 narrow cells without labels, month names over the weeks that start
 * in them, a dashed outline on the partial last week, no statistics rows. A bar along the bottom of forward-link
 * periods (FE-009). Returns the body for composePicture.
 */
export function calendarBody(grid: CalendarGrid, stats: CalendarStats | undefined, colors: CalendarColors) {
  const t = colors.theme;
  const week = grid.view === "week";
  const CELL_W = week ? 14 : 52, CELL_H = week ? 14 : 24, GAP = week ? 2 : 3;
  if (week) stats = undefined;
  const width = YEAR_W + grid.cols * (CELL_W + GAP);
  const out: string[] = [
    `<defs><pattern id="nodata" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="8" fill="${esc(t.muted)}"/></pattern></defs>`,
  ];
  const cx = (c: number) => YEAR_W + c * (CELL_W + GAP);
  if (week)
    weekMonthGroups().forEach(({ month, first }) => {
      out.push(`<text x="${cx(first)}" y="${HEAD_H - 8}" font-family="${esc(SANS)}" font-size="11" fill="${esc(t.mutedFg)}">${MONTHS[month - 1]}</text>`);
    });
  else
    MONTHS.forEach((m, c) => {
      out.push(`<text x="${cx(c) + CELL_W / 2}" y="${HEAD_H - 8}" text-anchor="middle" font-family="${esc(SANS)}" font-size="11" fill="${esc(t.mutedFg)}">${m}</text>`);
    });

  let y = HEAD_H;
  const cellText = (x: number, yy: number, text: string, ink: string, weight = "400") =>
    `<text x="${x + CELL_W / 2}" y="${yy + CELL_H / 2 + 4}" text-anchor="middle" font-family="${esc(MONO)}" font-size="11" font-weight="${weight}" fill="${esc(ink)}">${esc(text)}</text>`;

  grid.rows.forEach((row, r) => {
    const year = grid.years[r];
    const partial = grid.partialYears.includes(year);
    out.push(
      `<text x="0" y="${y + CELL_H / 2 + 4}" font-family="${esc(MONO)}" font-size="12" fill="${esc(t.fg)}">${year}${partial ? `<tspan font-family="${esc(SANS)}" font-size="10" fill="${esc(t.mutedFg)}"> partial</tspan>` : ""}</text>`,
    );
    row.forEach((cell, c) => {
      const x = cx(c);
      const dim = cell.inRange ? "" : ' opacity="0.35"';
      if (cell.value == null) {
        out.push(`<rect x="${x}" y="${y}" width="${CELL_W}" height="${CELL_H}" rx="2" fill="url(#nodata)"${dim}/>`);
        return;
      }
      const { bg, ink } = colors.cell(cell.value);
      out.push(`<g${dim}>`);
      out.push(`<rect x="${x}" y="${y}" width="${CELL_W}" height="${CELL_H}" rx="2" fill="${esc(bg)}"/>`);
      if (cell.partial)
        out.push(`<rect x="${x + 0.75}" y="${y + 0.75}" width="${CELL_W - 1.5}" height="${CELL_H - 1.5}" rx="2" fill="none" stroke="${esc(t.fg)}" stroke-width="1.5" stroke-dasharray="2 1.5"/>`);
      // FE-009: forward-link period (S-NPP ended; NOAA-20/21 after): a bar along the cell's bottom edge, as on the page
      if (cell.source === "forward")
        out.push(`<rect x="${x + 3}" y="${y + CELL_H - 4}" width="${CELL_W - 6}" height="2" rx="1" fill="${esc(ink)}"/>`);
      if (!week) out.push(cellText(x, y, compact(cell.value), ink));
      if (cell.flag === 1) out.push(`<path d="M${x + CELL_W - 6} ${y + 2}L${x + CELL_W - 2.5} ${y + 7}L${x + CELL_W - 9.5} ${y + 7}Z" fill="${esc(ink)}"/>`);
      if (cell.flag === -1) out.push(`<path d="M${x + CELL_W - 9.5} ${y + 2}L${x + CELL_W - 2.5} ${y + 2}L${x + CELL_W - 6} ${y + 7}Z" fill="${esc(ink)}"/>`);
      out.push(`</g>`);
    });
    y += CELL_H + GAP;
  });

  if (stats) {
    y += 9;
    out.push(`<text x="0" y="${y + CELL_H / 2 + 4}" font-family="${esc(SANS)}" font-size="12" font-weight="600" fill="${esc(t.fg)}">Median</text>`);
    stats.month_median.forEach((v, c) => {
      const { bg, ink } = colors.cell(v);
      out.push(`<rect x="${cx(c)}" y="${y}" width="${CELL_W}" height="${CELL_H}" rx="2" fill="${esc(bg)}"/>`);
      out.push(cellText(cx(c), y, compact(v), ink, "600"));
    });
    y += CELL_H + GAP + 4;
    out.push(`<text x="0" y="${y + 12}" font-family="${esc(SANS)}" font-size="11" fill="${esc(t.mutedFg)}">Middle half</text>`);
    stats.month_p25.forEach((v, c) => {
      const mid = cx(c) + CELL_W / 2;
      out.push(`<text x="${mid}" y="${y + 10}" text-anchor="middle" font-family="${esc(MONO)}" font-size="10" fill="${esc(t.mutedFg)}">${compact(v)}</text>`);
      out.push(`<text x="${mid}" y="${y + 23}" text-anchor="middle" font-family="${esc(MONO)}" font-size="10" fill="${esc(t.mutedFg)}">to ${compact(stats.month_p75[c])}</text>`);
    });
    y += 28;
  }
  return { body: out.join(""), width, height: y };
}

/** Filesystem-safe download name: lower case, [a-z0-9_-] only. */
export function pictureName(...parts: (string | number)[]): string {
  return parts
    .map((p) => String(p).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .join("_");
}
