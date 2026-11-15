"use client";

// FE-026: everything on /globe below the heading. Rendered on the server for the last year (so the legend, year
// control and the full table are in the HTML with no JavaScript), then: reads ?year=&view= from the URL, and after
// first paint loads the WebGL globe (GlobeCanvas, its own chunk) into a box whose size is fixed by CSS (no layout
// shift). No WebGL, data-saver or a failed load → the table and legend alone, with one sentence saying why.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ComponentType } from "react";
import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { GlobeCanvasProps, Paint, Shape } from "@/components/globe/GlobeCanvas";
import {
  binOf,
  bboxPolygon,
  fmt,
  globeQuery,
  heatColor,
  isLight,
  joinCode,
  joinRegions,
  NEUTRAL,
  NO_DATA,
  parseGlobeState,
  per1000,
  ramp,
  SIG_P,
  slopeText,
  sortYearRows,
  TREND_EDGES,
  TREND_STOPS,
  trendBin,
  trendColor,
  trendWords,
  labelText,
  withAlpha,
  yearRows,
  type GlobeState,
  type OutlineProps,
  type PlaceRow,
  type SortDir,
  type SortKey,
  type View,
} from "@/lib/globe";
import { cn } from "@/lib/utils";

type Status = "waiting" | "loading" | "ready" | "no-webgl" | "save-data" | "failed";

const BOX_ALT = 0.085; // deep-dive boxes float above the tallest country
const ACTIVE_LIFT = 0.02;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    // give the probe's context back at once: browsers allow only ~16 live WebGL contexts
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

const saveData = () =>
  typeof navigator !== "undefined" && !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;

/** After the browser has painted and gone idle, so the globe never delays the page. */
function afterPaint(fn: () => void): () => void {
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
  let idle = 0;
  const raf = requestAnimationFrame(() => {
    idle = w.requestIdleCallback ? w.requestIdleCallback(fn, { timeout: 1500 }) : window.setTimeout(fn, 200);
  });
  return () => {
    cancelAnimationFrame(raf);
    if (w.cancelIdleCallback) w.cancelIdleCallback(idle);
    else clearTimeout(idle);
  };
}

const urlListeners = new Set<() => void>();
function subscribeUrl(cb: () => void) {
  urlListeners.add(cb);
  window.addEventListener("popstate", cb);
  return () => {
    urlListeners.delete(cb);
    window.removeEventListener("popstate", cb);
  };
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return reduced;
}

export interface GlobeExplorerProps {
  years: number[];
  places: PlaceRow[];
  /** Log-spaced per-1,000 km² bin edges over every year (fixed while the slider moves). */
  edges: number[];
  /** Countries in the data with no outline at 1:110m (names). */
  unmatched: string[];
}

export function GlobeExplorer({ years, places, edges, unmatched }: GlobeExplorerProps) {
  const router = useRouter();
  const reduced = useReducedMotion();
  const last = years[years.length - 1];
  // the URL is the store for year and view: ?year=&view= (replaceState, no history entry per slider step); the server
  // snapshot is "" so the HTML is the last year on the Year view
  const search = useSyncExternalStore(subscribeUrl, () => window.location.search, () => "");
  const state = useMemo(() => parseGlobeState(new URLSearchParams(search), years), [search, years]);
  const setState = useCallback(
    (f: (s: GlobeState) => GlobeState) => {
      const next = f(parseGlobeState(new URLSearchParams(window.location.search), years));
      const q = globeQuery(next, years, window.location.search);
      window.history.replaceState(window.history.state, "", q ? `?${q}` : window.location.pathname);
      urlListeners.forEach((l) => l());
    },
    [years],
  );
  const [active, setActive] = useState<{ id: string | null; name: string } | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "density", dir: "desc" });
  const [playing, setPlaying] = useState(false);
  const [status, setStatus] = useState<Status>("waiting");
  const [Canvas, setCanvas] = useState<ComponentType<GlobeCanvasProps> | null>(null);
  const [outlines, setOutlines] = useState<{ properties: OutlineProps; geometry: Shape["geometry"] }[] | null>(null);
  const [drawn, setDrawn] = useState(false);

  const yi = years.indexOf(state.year);
  const colors = useMemo(() => ramp(edges.length - 1), [edges]);
  const byId = useMemo(() => new Map(places.map((p) => [p.id, p])), [places]);

  // the globe: after first paint, only with WebGL and without data-saver
  const load = useCallback(() => {
    setStatus("loading");
    Promise.all([
      import("@/components/globe/GlobeCanvas"),
      fetch("/data/countries-110m.geojson").then((r) => {
        if (!r.ok) throw new Error(`outlines ${r.status}`);
        return r.json();
      }),
    ])
      .then(([mod, geo]) => {
        setCanvas(() => mod.default);
        setOutlines(geo.features);
        setStatus("ready");
      })
      .catch(() => setStatus("failed"));
  }, []);
  useEffect(
    () =>
      afterPaint(() => {
        if (!hasWebGL()) setStatus("no-webgl");
        else if (saveData()) setStatus("save-data");
        else load();
      }),
    [load],
  );

  const shapes = useMemo<Shape[]>(() => {
    if (!outlines) return [];
    const { matched } = joinRegions(outlines, places);
    const countries = outlines.map((f): Shape => {
      const code = joinCode(f.properties);
      const r = matched.get(code);
      return { kind: "country", id: r?.id ?? null, name: r?.name ?? f.properties.NAME, geometry: f.geometry };
    });
    const boxes = places
      .filter((p) => p.tier !== "country" && p.bbox)
      .map((p): Shape => ({ kind: "box", id: p.id, name: p.name, geometry: bboxPolygon(p.bbox!) }));
    return [...countries, ...boxes];
  }, [outlines, places]);

  const paint = useCallback(
    (s: Shape, on: boolean): Paint => {
      const p = s.id ? byId.get(s.id) : undefined;
      const stroke = on ? "#fff1ec" : s.kind === "box" ? "rgba(255, 241, 236, 0.9)" : "rgba(13, 9, 9, 0.85)";
      if (!p) return { cap: NO_DATA, side: withAlpha(NO_DATA, 0.6), stroke, altitude: 0.004 };
      let col: string;
      let alt: number;
      if (state.view === "year") {
        const v = per1000(p.harmonized[yi] ?? null, p.km2);
        col = heatColor(v, edges, colors);
        const b = binOf(v, edges);
        alt = b === null ? 0.004 : 0.006 + (0.055 * (b + 1)) / (edges.length - 1);
      } else {
        col = trendColor(p.trend);
        const b = trendBin(p.trend);
        alt = b === null || !p.trend || p.trend.p >= SIG_P ? 0.005 : 0.008 + 0.012 * Math.abs(b - 2.5);
      }
      const light = p.tier === "country" && isLight(p.ship);
      if (s.kind === "box") alt = BOX_ALT;
      return {
        // lighter, not dimmer: 0.42 made the top bin read as a middle one over the dark globe (R10)
        cap: light ? withAlpha(col, 0.72) : col,
        // boxes float as lit tiles over their country: no walls, just the cap and a bright outline
        side: s.kind === "box" ? "rgba(0, 0, 0, 0)" : withAlpha(col, light ? 0.12 : 0.4),
        stroke,
        altitude: alt + (on ? ACTIVE_LIFT : 0),
      };
    },
    [byId, state.view, yi, edges, colors],
  );

  const tooltip = useCallback(
    (s: Shape): string => {
      const p = s.id ? byId.get(s.id) : undefined;
      const lines = p ? readoutLines(p, yi, state.year) : ["no data yet"];
      return `<div class="globe-tip"><b>${esc(s.name)}</b>${lines.map((l) => `<span>${esc(l)}</span>`).join("")}${
        p ? "<em>Click to open the ledger</em>" : ""
      }</div>`;
    },
    [byId, yi, state.year],
  );

  // play: one year a step, stops at the last year; never under reduced motion
  useEffect(() => {
    if (!playing || reduced) return;
    const t = window.setTimeout(() => {
      if (yi >= years.length - 1) setPlaying(false);
      else setState((s) => ({ ...s, year: years[yi + 1] }));
    }, 900);
    return () => clearTimeout(t);
  }, [playing, reduced, yi, years, setState]);

  const rows = useMemo(() => sortYearRows(yearRows(places, yi), sort.key, sort.dir), [places, yi, sort]);
  const shownPlace = active?.id ? byId.get(active.id) : undefined;
  const countries = places.filter((p) => p.tier === "country" && p.harmonized.some((v) => v !== null)).length;
  const dives = places.filter((p) => p.tier !== "country").length;

  const setYear = (year: number) => setState((s) => ({ ...s, year }));
  const sortBy = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" || key === "label" ? "asc" : "desc" }));

  const fallback =
    status === "no-webgl"
      ? "This browser has WebGL turned off, so the 3D globe cannot be drawn; the table below has every number."
      : status === "failed"
        ? "The 3D globe did not load; the table below has every number."
        : status === "save-data"
          ? "Data saver is on, so the 3D globe (about 560 KB of compressed code) is not loaded; the table below has every number."
          : null;

  return (
    <div className="flex flex-col gap-8">
      <section aria-label="Globe" className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div
          className="panel relative aspect-square max-h-[78svh] w-full overflow-hidden bg-[radial-gradient(circle_at_50%_46%,#221210_0%,#0d0909_68%)]"
          data-globe={status}
        >
          {Canvas && status === "ready" && (
            <Canvas
              shapes={shapes}
              paint={paint}
              label={tooltip}
              version={`${state.view}:${state.year}`}
              active={active?.id ?? null}
              focus={focus}
              reducedMotion={reduced}
              onHover={(id, name) => setActive(name ? { id, name } : null)}
              onOpen={(id) => router.push(`/record?region=${encodeURIComponent(id)}`)}
              onReady={() => setDrawn(true)}
              onFail={() => setStatus("failed")}
            />
          )}
          {!drawn && !fallback && (
            <p className="absolute inset-x-0 bottom-4 text-center font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
              Loading the globe
            </p>
          )}
          {fallback && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center">
              <p className="max-w-[40ch] text-sm leading-relaxed text-muted-foreground">{fallback}</p>
              {status === "save-data" && (
                <button type="button" className="btn-quiet" onClick={load}>
                  Load the globe anyway
                </button>
              )}
            </div>
          )}
          {!fallback && (
            <p className="pointer-events-none absolute top-3 left-4 font-mono text-[10.5px] tracking-[0.14em] text-muted-foreground uppercase">
              Drag to turn · scroll or pinch to zoom · click a country
            </p>
          )}
        </div>

        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <span className="kicker">View</span>
            <ToggleGroup
              type="single"
              variant="outline"
              spacing={0}
              value={state.view}
              onValueChange={(v) => v && setState((s) => ({ ...s, view: v as View }))}
              aria-label="Colour countries by"
            >
              {(["year", "trend"] as const).map((v) => (
                <ToggleGroupItem
                  key={v}
                  value={v}
                  className="h-9 flex-1 px-4 font-mono text-[11px] tracking-[0.12em] uppercase data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                >
                  {v === "year" ? "One year" : "Trend"}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <label htmlFor="globe-year" className="kicker">
                Year
              </label>
              <output htmlFor="globe-year" className="font-mono text-3xl font-semibold tabular-nums" aria-live="off">
                {state.year}
              </output>
            </div>
            <div className="flex items-center gap-3">
              {!reduced && state.view === "year" && (
                <button
                  type="button"
                  onClick={() => {
                    if (!playing && state.year === last) setYear(years[0]);
                    setPlaying((p) => !p);
                  }}
                  aria-pressed={playing}
                  aria-label={playing ? "Pause the years" : "Play the years"}
                  className="grid size-9 shrink-0 place-items-center border border-border text-foreground transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-primary"
                >
                  {playing ? <PauseIcon weight="fill" aria-hidden /> : <PlayIcon weight="fill" aria-hidden />}
                </button>
              )}
              <input
                id="globe-year"
                type="range"
                min={years[0]}
                max={last}
                step={1}
                value={state.year}
                onChange={(e) => {
                  setPlaying(false);
                  setYear(Number(e.target.value));
                }}
                aria-valuetext={`${state.year}`}
                className="h-9 w-full cursor-pointer accent-[var(--primary)]"
              />
            </div>
            <div className="flex justify-between font-mono text-[10.5px] text-muted-foreground">
              <span>{years[0]}</span>
              <span>{last}</span>
            </div>
            {state.view === "trend" && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                The globe shows each record&apos;s 2001-2025 trend; the year still sets the table&apos;s numbers.
              </p>
            )}
          </div>

          <Legend view={state.view} edges={edges} colors={colors} />

          {/* no aria-live: it would talk over every table row a screen reader tabs through; the rows say it all.
              Fixed height (long names and caveats are clamped): if it grew on hover, the table under it would move
              away from the pointer. The full caveat is on each record page. */}
          <div className="panel flex h-[19rem] flex-col gap-1.5 overflow-hidden p-4">
            <span className="kicker">Readout</span>
            {active ? (
              <>
                <p className="line-clamp-2 text-lg leading-snug font-semibold">{active.name}</p>
                {shownPlace ? (
                  readoutLines(shownPlace, yi, state.year).map((l) => (
                    <p key={l} title={l.startsWith("Caveat:") ? l : undefined} className={`font-mono text-xs leading-relaxed text-muted-foreground ${l.startsWith("Caveat:") ? "line-clamp-4" : ""}`}>
                      {l}
                    </p>
                  ))
                ) : (
                  <p className="font-mono text-xs text-muted-foreground">No data yet</p>
                )}
              </>
            ) : (
              <p className="text-sm leading-relaxed text-muted-foreground">
                Point at a country, or move through the table with the keyboard.
              </p>
            )}
          </div>
        </div>
      </section>

      <section aria-labelledby="globe-table" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="globe-table" className="text-xl">
            Every place, {state.year}
          </h2>
          <p className="max-w-[70ch] text-sm leading-relaxed text-muted-foreground">
            {dives} deep {dives === 1 ? "dive" : "dives"}
            {countries > 0 ? ` and ${countries} ${countries === 1 ? "country" : "countries"}` : ""}. Harmonized detections
            for the year (5-95% band on the back-cast years before 2012), per 1,000 km² of land, and the 2001-2025 trend
            (Theil-Sen, significant when Mann-Kendall p &lt; 0.05). Each name opens its record.
          </p>
        </div>
        {/* relative: the sr-only spans in the cells are absolutely positioned and must stay inside the scroll box */}
        <div className="relative max-h-[32rem] overflow-auto border">
          <table className="w-full min-w-[40rem] border-collapse text-sm">
            <caption className="sr-only">
              Harmonized fire detections in {state.year} for every place on the globe, sortable by each column.
            </caption>
            <thead className="sticky top-0 z-10 bg-card">
              <tr>
                {(
                  [
                    ["name", "Place", false],
                    ["total", `Detections ${state.year}`, true],
                    ["density", "Per 1,000 km²", true],
                    ["trend", "Trend", true],
                    ["label", "Label", false],
                  ] as const
                ).map(([key, title, numeric]) => (
                  <th
                    key={key}
                    scope="col"
                    aria-sort={sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                    className={cn("border-b px-3 py-2 font-mono text-[11px] font-medium tracking-[0.08em] uppercase", numeric ? "text-right" : "text-left")}
                  >
                    <button type="button" onClick={() => sortBy(key)} className="inline-flex items-center gap-1 hover:text-primary focus-visible:outline-2 focus-visible:outline-primary">
                      {title}
                      <span aria-hidden className="text-muted-foreground">
                        {sort.key === key ? (sort.dir === "asc" ? "▲" : "▼") : ""}
                      </span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody onMouseLeave={() => setActive(null)}>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  onMouseEnter={() => setActive({ id: r.id, name: r.name })}
                  className={cn("border-b last:border-b-0 hover:bg-primary/6", active?.id === r.id && "bg-primary/8", r.light && "text-muted-foreground")}
                >
                  <th scope="row" className="px-3 py-1.5 text-left font-normal">
                    <Link
                      href={`/record?region=${encodeURIComponent(r.id)}`}
                      onBlur={() => setFocus(null)}
                      onFocus={() => {
                        setActive({ id: r.id, name: r.name });
                        if (r.onGlobe) setFocus(r.id);
                      }}
                      className="underline-offset-2 hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary"
                    >
                      {r.name}
                    </Link>
                    {!r.onGlobe && <span className="ml-1.5 text-xs text-muted-foreground">(not on the map)</span>}
                  </th>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                    {fmt(r.total)}
                    {r.lo !== null && r.hi !== null && (
                      <span className="block text-[11px] text-muted-foreground">
                        {fmt(r.lo)}-{fmt(r.hi)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">{fmt(r.density)}</td>
                  <td className={cn("px-3 py-1.5 text-right font-mono tabular-nums", r.trend && r.trend.p >= SIG_P && "text-muted-foreground")}>
                    {slopeText(r.trend)}
                    {r.trend && <span className="sr-only">{r.trend.p < SIG_P ? ", significant" : ", could be chance"}</span>}
                    {r.trend && r.trend.p < SIG_P && <span aria-hidden> *</span>}
                  </td>
                  <td className="px-3 py-1.5">
                    {r.label}
                    {r.caveat && (
                      <span className="ml-1 text-primary" title={r.caveat}>
                        <span aria-hidden>⚠</span>
                        <span className="sr-only"> (caveat: {r.caveat})</span>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          * significant trend. Grey rows are constant-ratio estimates or sparse records (drawn lighter on the globe).
          {unmatched.length > 0 &&
            ` Not on the map, too small for the 1:110m outlines (listed here with no area): ${unmatched.join(", ")}.`}
        </p>
      </section>
    </div>
  );
}

/** What the readout and the tooltip say about one place. */
function readoutLines(p: PlaceRow, yi: number, year: number): string[] {
  const total = p.harmonized[yi] ?? null;
  const lo = p.lo[yi] ?? null;
  const hi = p.hi[yi] ?? null;
  const band = lo !== null && hi !== null ? ` (${fmt(lo)}-${fmt(hi)})` : "";
  const out = [
    `${year}: ${total === null ? "no record" : `${fmt(total)} detections${band}`}`,
    `${fmt(per1000(total, p.km2))} per 1,000 km²`,
    `Trend: ${trendWords(p.trend)}`,
    `Label: ${labelText(p)}`,
  ];
  if (p.caveat) out.push(`Caveat: ${p.caveat}`);
  return out;
}

function Legend({ view, edges, colors }: { view: View; edges: number[]; colors: string[] }) {
  if (view === "trend") {
    const ranges = [`≤ ${TREND_EDGES[0]}`, ...TREND_EDGES.slice(0, -1).map((e, i) => `${e} to ${TREND_EDGES[i + 1]}`), `≥ ${TREND_EDGES.at(-1)}`];
    return (
      <figure className="flex flex-col gap-2">
        <figcaption className="kicker">Trend, % a year</figcaption>
        <ul className="grid grid-cols-3 gap-x-3 gap-y-1.5 font-mono text-[11px] text-muted-foreground">
          {TREND_STOPS.map((c, i) => (
            <li key={c} className="flex items-center gap-1.5">
              <span className="size-3 shrink-0" style={{ background: c }} aria-hidden />
              {ranges[i].replaceAll("-", "−")}
            </li>
          ))}
        </ul>
        <LegendKeys extra={{ color: NEUTRAL, text: "Could be chance (p ≥ 0.05)" }} />
      </figure>
    );
  }
  const labelled = legendLabels(edges);
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="kicker">Detections per 1,000 km²</figcaption>
      {/* inset by half a label so the end labels can sit centred on their edges */}
      <div className="flex flex-col px-4" aria-hidden>
        <div className="flex h-3">
          {colors.map((c) => (
            <span key={c} className="flex-1" style={{ background: c }} />
          ))}
        </div>
        <div className="relative h-5 font-mono text-[10.5px] text-muted-foreground">
          {edges.map((e, i) => {
            const left = `${(i / (edges.length - 1)) * 100}%`;
            return labelled[i] ? (
              <Fragment key={e}>
                <span className="absolute top-0 h-1.5 w-px -translate-x-1/2 bg-muted-foreground" style={{ left }} />
                <span className="absolute top-1.5 -translate-x-1/2 whitespace-nowrap" style={{ left }}>
                  {fmt(e)}
                </span>
              </Fragment>
            ) : (
              <span key={e} className="absolute top-0 h-1 w-px -translate-x-1/2 bg-border" style={{ left }} />
            );
          })}
        </div>
      </div>
      <p className="sr-only">
        Colour bins, dark to bright: {edges.slice(0, -1).map((e, i) => `${fmt(e)} to ${fmt(edges[i + 1])}`).join("; ")}.
        The same bins for every year.
      </p>
      <LegendKeys />
    </figure>
  );
}

/**
 * Which bin edges get a number under the colour bar: one per power of ten (the edges run 1, 3, 10, 30, ...), so the
 * labels never overlap in the 19rem side column; every other edge when the edges are not on powers of ten. The rest
 * get a short tick, and the screen-reader text lists every bin.
 */
function legendLabels(edges: number[]): boolean[] {
  const pow10 = edges.map((e) => e > 0 && Math.abs(Math.log10(e) - Math.round(Math.log10(e))) < 1e-9);
  if (pow10.filter(Boolean).length >= 2) return pow10;
  return edges.map((_, i) => i % 2 === 0);
}

function LegendKeys({ extra }: { extra?: { color: string; text: string } }) {
  return (
    <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
      {extra && (
        <li className="flex items-center gap-2">
          <span className="size-3 shrink-0" style={{ background: extra.color }} aria-hidden />
          {extra.text}
        </li>
      )}
      <li className="flex items-center gap-2">
        <span className="size-3 shrink-0" style={{ background: NO_DATA }} aria-hidden />
        No data yet
      </li>
      <li className="flex items-center gap-2">
        <span className="size-3 shrink-0 bg-[#ff9d52]/70" aria-hidden />
        Lighter: constant-ratio estimate or sparse
      </li>
      <li className="flex items-center gap-2">
        <span className="size-3 shrink-0 border-2 border-[#fff1ec]" aria-hidden />
        Outlined box: one of our three deep dives
      </li>
    </ul>
  );
}
