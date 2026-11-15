// Browser half of the picture downloads (FE-015): resolves theme colours, serialises the live ledger chart with its
// computed colours inlined, rasterises an SVG to PNG and saves files. Client components only (needs the DOM).
import type { PictureTheme } from "./picture.ts";
import { MONO, SANS } from "./picture.ts";

let ctx: CanvasRenderingContext2D | null = null;

/**
 * Any CSS colour the browser understands (oklch, color-mix, rgb with alpha...) as an opaque #rrggbb, composited over
 * `over`. A canvas does the parsing, so the file never depends on CSS variables or newer colour syntax.
 */
export function solidColor(css: string, over = "#ffffff"): string {
  ctx ??= Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
  if (!ctx) return css;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = over;
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = "#000000";
  ctx.fillStyle = css; // an empty or unknown colour is ignored, so it comes out as opaque black
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

/** Value of a custom property on :root, e.g. cssVar("--modis"), as an opaque colour over `over`. */
export function cssVar(name: string, over?: string): string {
  return solidColor(getComputedStyle(document.documentElement).getPropertyValue(name).trim(), over);
}

/** Page colours for the colour scheme in use (cards are the picture's background). */
export function pageTheme(): PictureTheme {
  const bg = cssVar("--card");
  return {
    bg,
    fg: cssVar("--foreground", bg),
    muted: cssVar("--muted", bg),
    mutedFg: cssVar("--muted-foreground", bg),
    border: cssVar("--border", bg),
  };
}

const isClear = (v: string) => v === "transparent" || /rgba?\(0,\s*0,\s*0,\s*0\)/.test(v) || / \/ 0\)$/.test(v);

/**
 * Copies a rendered <svg> with computed fill, stroke and fonts written as attributes and classes removed, so it looks
 * the same outside the page (draw-in and fade-in animations show their end state, even mid-animation). Transparent
 * hover targets are dropped.
 */
export function serializeChart(svg: SVGSVGElement, bg: string): { body: string; width: number; height: number } {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const src = [svg, ...svg.querySelectorAll("*")];
  const dst = [clone, ...clone.querySelectorAll("*")];
  const drop: Element[] = [];
  src.forEach((el, i) => {
    const out = dst[i], cs = getComputedStyle(el);
    if (el.hasAttribute("data-no-export")) drop.push(out); // e.g. the hover line
    const paint = (prop: "fill" | "stroke") => {
      const v = cs.getPropertyValue(prop);
      if (!v || v === "none" || v.startsWith("url(")) out.setAttribute(prop, v || "none");
      else if (isClear(v)) out.setAttribute(prop, "none");
      else out.setAttribute(prop, solidColor(v, bg));
    };
    if (el !== svg) {
      paint("fill");
      paint("stroke");
      // opacity stays as the `opacity` attribute on the element: the computed value is mid-animation right after a
      // Raw / Harmonized switch (chart-fade starts at 0)
      if (el.tagName === "rect" && out.getAttribute("fill") === "none" && out.getAttribute("stroke") === "none") drop.push(out);
    }
    if (el.tagName === "text") {
      out.setAttribute("font-family", el.classList.contains("font-mono") || cs.fontFamily.includes("ono") ? MONO : SANS);
      out.setAttribute("font-size", cs.fontSize.replace("px", ""));
    }
    out.removeAttribute("class");
    out.removeAttribute("style");
    out.removeAttribute("aria-hidden");
  });
  drop.forEach((el) => el.remove());
  const [, , w, h] = (svg.getAttribute("viewBox") ?? "0 0 800 380").split(/\s+/).map(Number);
  const body = [...clone.childNodes].map((n) => new XMLSerializer().serializeToString(n)).join("");
  return { body: body.replace(/ xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, ""), width: w, height: h };
}

/** Draws the SVG on a canvas at `scale` × its size and returns a PNG. */
export async function svgToPng(svg: string, width: number, height: number, scale = 2): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((ok, fail) => {
      img.onload = () => ok();
      img.onerror = () => fail(new Error("The picture could not be drawn."));
      img.src = url;
    });
    const canvas = Object.assign(document.createElement("canvas"), { width: width * scale, height: height * scale });
    const c = canvas.getContext("2d");
    if (!c) throw new Error("This browser cannot draw a PNG.");
    c.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((ok, fail) =>
      canvas.toBlob((b) => (b ? ok(b) : fail(new Error("This browser cannot save a PNG."))), "image/png"),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Saves a blob under `name` through a temporary download link. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
