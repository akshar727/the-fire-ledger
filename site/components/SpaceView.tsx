"use client";

import { ArrowLeftIcon, ArrowRightIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { regionInfo, type RegionId } from "@/lib/data";
import { REGIONS } from "@/lib/regions";
import {
  classifyPixels,
  countedSensor,
  dayPoints,
  GIBS_CREDIT,
  gibsUrl,
  imageSize,
  layersFor,
  parsePeaks,
  resolveDay,
  SENSOR_NAME,
  shiftDay,
  toPixel,
  topDays,
  type Bbox,
  type Layer,
  type Peaks,
} from "@/lib/space";

const WIDTH = 1000;
const TIMEOUT_MS = 20000;

type PeaksState = { region: RegionId; status: "loading" | "missing" | "error" } | { region: RegionId; status: "ready"; peaks: Peaks };
type ImageState =
  | { status: "loading" }
  | { status: "ok" | "cloudy"; layer: Layer; url: string }
  | { status: "none" }
  | { status: "error" };
type PointsState = { status: "loading" } | { status: "ready"; points: { lat: number; lon: number }[] } | { status: "error" };
type Probe = "blank" | "cloudy" | "ok" | "error";

const longDate = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const monthName = (key: string) =>
  new Date(`${key}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const monthKey = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;

function probe(url: string, signal: AbortSignal): Promise<Probe> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("aborted", "AbortError"));
    const img = new Image();
    const timer = setTimeout(() => finish("error"), TIMEOUT_MS);
    const onAbort = () => {
      img.src = "";
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    function finish(v: Probe) {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(v);
    }
    signal.addEventListener("abort", onAbort, { once: true });
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = c.height = 64;
        const ctx = c.getContext("2d");
        if (!ctx) return finish("ok");
        ctx.drawImage(img, 0, 0, 64, 64);
        finish(classifyPixels(ctx.getImageData(0, 0, 64, 64).data));
      } catch {
        finish("ok");
      }
    };
    img.onerror = () => finish("error");
    img.src = url;
  });
}

export function SpaceView({
  region,
  year,
  month,
  opened,
}: {
  region: RegionId;
  year: number;
  month: number;
  opened: number;
}) {
  const bbox = regionInfo(region).bbox as Bbox;
  const size = imageSize(bbox, WIDTH);
  const section = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const open = monthKey(year, month);
  const [pk, setPk] = useState<PeaksState>({ region, status: "loading" });
  const peaks = pk.region === region && pk.status === "ready" ? pk.peaks : null;
  const top = peaks ? topDays(peaks, year, month) : [];
  const minDay = peaks ? `${peaks.months[0]?.month ?? "2001-01"}-01` : `${open}-01`;
  const maxDay = peaks?.last_day ?? `${open}-01`;
  const [chosen, setChosen] = useState<{ open: string; region: string; day: string } | null>(null);
  const day = resolveDay(chosen, open, region, top, minDay, maxDay);
  const tag = `${region}|${day}`;
  const [img, setImg] = useState<{ tag: string; state: ImageState }>({ tag: "", state: { status: "loading" } });
  const [pts, setPts] = useState<{ tag: string; state: PointsState }>({ tag: "", state: { status: "loading" } });
  const [retry, setRetry] = useState(0);
  const [dots, setDots] = useState(true);

  useEffect(() => {
    if (opened === 0) return;
    section.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    heading.current?.focus({ preventScroll: true });
  }, [region, year, month, opened]);

  useEffect(() => {
    const ac = new AbortController();
    fetch(`/data/${region}/peaks.json`, { signal: ac.signal, cache: "no-cache" })
      .then(async (r) => {
        if (r.status === 404) return setPk({ region, status: "missing" });
        if (!r.ok) return setPk({ region, status: "error" });
        setPk({ region, status: "ready", peaks: parsePeaks(await r.json()) });
      })
      .catch(() => !ac.signal.aborted && setPk({ region, status: "error" }));
    return () => ac.abort();
  }, [region]);

  useEffect(() => {
    if (!peaks) return;
    const ac = new AbortController();
    (async () => {
      let errors = 0;
      for (const layer of layersFor(day)) {
        const url = gibsUrl(layer, bbox, day, WIDTH);
        const seen = await probe(url, ac.signal);
        if (seen === "ok" || seen === "cloudy") return setImg({ tag, state: { status: seen, layer, url } });
        if (seen === "error") errors++;
      }
      setImg({ tag, state: { status: errors > 0 && errors === layersFor(day).length ? "error" : "none" } });
    })().catch((e) => {
      if (!ac.signal.aborted && !(e instanceof DOMException && e.name === "AbortError")) setImg({ tag, state: { status: "error" } });
    });
    return () => ac.abort();
  }, [peaks, day, bbox, tag, retry]);

  useEffect(() => {
    if (!peaks) return;
    const ac = new AbortController();
    fetch(`/api/hotspots?${new URLSearchParams({ region, from: day, to: day })}`, { signal: ac.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        setPts({ tag, state: { status: "ready", points: dayPoints(await r.text(), day, countedSensor(peaks, day)) } });
      })
      .catch(() => !ac.signal.aborted && setPts({ tag, state: { status: "error" } }));
    return () => ac.abort();
  }, [peaks, day, region, tag, retry]);

  const points = pts.tag === tag ? pts.state : ({ status: "loading" } as const);
  const circles = useMemo(
    () =>
      points.status === "ready"
        ? points.points.map((p, i) => {
            const xy = toPixel(p.lat, p.lon, bbox, size);
            return xy && <circle key={i} cx={xy[0]} cy={xy[1]} r={4} fill="#ff4d00" fillOpacity={0.75} stroke="#fff" strokeWidth={1} />;
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [points, bbox],
  );

  if (pk.region === region && pk.status === "missing") return null;

  const sensor = peaks ? countedSensor(peaks, day) : null;
  const image = img.tag === tag ? img.state : ({ status: "loading" } as const);
  const count = points.status === "ready" ? points.points.length : null;
  const place = REGIONS[region];
  const shown = image.status === "ok" || image.status === "cloudy";
  const go = (d: string) => d >= minDay && d <= maxDay && setChosen({ open, region, day: d });
  const isPeak = top[0]?.date === day;
  const announce = !peaks
    ? ""
    : image.status === "loading"
      ? `Loading the satellite image for ${longDate(day)}.`
      : image.status === "error"
        ? "NASA's image service could not be reached."
        : image.status === "none"
          ? `NASA has no satellite image for ${longDate(day)}.`
          : `${longDate(day)}, ${image.layer.satellite} image${image.status === "cloudy" ? ", mostly cloud or smoke" : ""}${
              count != null && sensor ? `, ${count} ${SENSOR_NAME[sensor]} detections` : ""
            }.`;

  return (
    <section ref={section} aria-labelledby="space-heading" className="flex scroll-mt-20 flex-col gap-4 panel p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="space-heading" ref={heading} tabIndex={-1} className="text-lg font-semibold tracking-tight outline-none">
            See it from space: {peaks ? longDate(day) : monthName(open)}
          </h2>
          {peaks && (
            <p className="text-sm text-muted-foreground">
              {place}, {isPeak ? `the busiest fire day of ${monthName(open)}` : "a day you picked"}
              {count != null && sensor && `: ${count.toLocaleString("en-GB")} ${SENSOR_NAME[sensor]} detections`}
            </p>
          )}
        </div>
      </div>

      <p className="sr-only" aria-live="polite">
        {announce}
      </p>

      {pk.status === "error" && pk.region === region && (
        <p className="text-sm text-destructive">The list of peak fire days could not be loaded.</p>
      )}

      {peaks && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => go(shiftDay(day, -1))} aria-disabled={day <= minDay} className="aria-disabled:opacity-50">
              <ArrowLeftIcon aria-hidden /> Previous day
            </Button>
            <Button variant="outline" size="sm" onClick={() => go(shiftDay(day, 1))} aria-disabled={day >= maxDay} className="aria-disabled:opacity-50">
              Next day <ArrowRightIcon aria-hidden />
            </Button>
            {top.length > 0 && <span className="ml-2 text-sm text-muted-foreground">Top days:</span>}
            {top.map((t) => (
              <Button
                key={t.date}
                variant={t.date === day ? "default" : "outline"}
                size="sm"
                onClick={() => go(t.date)}
                aria-pressed={t.date === day}
                aria-label={`${longDate(t.date)}, ${t.count.toLocaleString("en-GB")} detections`}
              >
                {Number(t.date.slice(8))} ({t.count.toLocaleString("en-GB")})
              </Button>
            ))}
            {top.length === 0 && <span className="text-sm text-muted-foreground">No fire detections in {monthName(open)}.</span>}
            <label className="ml-auto flex items-center gap-2 text-sm">
              <input type="checkbox" checked={dots} onChange={(e) => setDots(e.target.checked)} className="size-4 accent-primary" />
              Show detections
            </label>
          </div>

          <figure className="flex flex-col gap-2">
            <div
              className="relative mx-auto w-full max-w-xl overflow-hidden rounded-lg bg-muted"
              style={{ aspectRatio: `${size.width} / ${size.height}` }}
            >
              {image.status === "loading" && (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">Loading the NASA image…</div>
              )}
              {image.status === "none" && (
                <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
                  NASA has no satellite image of {place} for {longDate(day)}. Try the previous or next day.
                </div>
              )}
              {image.status === "error" && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
                  NASA&apos;s image service could not be reached.
                  <Button variant="outline" size="sm" onClick={() => setRetry((n) => n + 1)}>
                    Try again
                  </Button>
                </div>
              )}
              {shown && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={image.url}
                  crossOrigin="anonymous"
                  width={size.width}
                  height={size.height}
                  className="absolute inset-0 size-full"
                  alt={`True-colour satellite image of ${place} on ${longDate(day)} from ${image.layer.satellite}${
                    count != null && sensor ? `, with ${count} ${SENSOR_NAME[sensor]} fire detections that day` : ""
                  }.`}
                />
              )}
              {dots && shown && circles && (
                <svg viewBox={`0 0 ${size.width} ${size.height}`} className="pointer-events-none absolute inset-0 size-full" aria-hidden>
                  {circles}
                </svg>
              )}
            </div>
            <figcaption className="mx-auto flex w-full max-w-xl flex-col gap-1 text-xs leading-relaxed text-muted-foreground">
              {image.status === "cloudy" && <span className="font-medium text-foreground">Mostly cloud or smoke over the region this day.</span>}
              <span>
                {longDate(day)}.{shown && ` Image: ${image.layer.satellite}, true colour.`}
                {sensor && ` Dots: ${SENSOR_NAME[sensor]} fire detections (NASA FIRMS)`}
                {sensor && points.status === "error" && ", could not be loaded"}
                {sensor && "."} Fire counts are raw daily detections, not harmonized.
              </span>
              <span>{GIBS_CREDIT}</span>
            </figcaption>
          </figure>
        </>
      )}
    </section>
  );
}
