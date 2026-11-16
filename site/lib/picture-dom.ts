import type { PictureTheme } from "./picture.ts";
import { MONO, SANS } from "./picture.ts";

let ctx: CanvasRenderingContext2D | null = null;

export function solidColor(css: string, over = "#ffffff"): string {
  ctx ??= Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
  if (!ctx) return css;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = over;
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = "#000000";
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

export function cssVar(name: string, over?: string): string {
  return solidColor(getComputedStyle(document.documentElement).getPropertyValue(name).trim(), over);
}

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

export function serializeChart(svg: SVGSVGElement, bg: string): { body: string; width: number; height: number } {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const src = [svg, ...svg.querySelectorAll("*")];
  const dst = [clone, ...clone.querySelectorAll("*")];
  const drop: Element[] = [];
  src.forEach((el, i) => {
    const out = dst[i], cs = getComputedStyle(el);
    if (el.hasAttribute("data-no-export")) drop.push(out);
    const paint = (prop: "fill" | "stroke") => {
      const v = cs.getPropertyValue(prop);
      if (!v || v === "none" || v.startsWith("url(")) out.setAttribute(prop, v || "none");
      else if (isClear(v)) out.setAttribute(prop, "none");
      else out.setAttribute(prop, solidColor(v, bg));
    };
    if (el !== svg) {
      paint("fill");
      paint("stroke");
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

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
