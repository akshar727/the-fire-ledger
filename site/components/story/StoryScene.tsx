"use client";

// The scroll scene behind the landing story (FE-019): 180 pre-rendered frames (public/scene/, made by
// scripts/landing_scene/scene.py from SRTM terrain and the 2017 detections) scrubbed on one <canvas> by scroll
// position. Decoration only: the canvas is aria-hidden and every word and figure of the story is the HTML above it.
// Loaded by StorySceneGate after first paint, on wide screens with motion allowed; nothing here runs otherwise.
//
// Frames arrive as blobs, coarse to fine (lib/scene.ts loadOrder), and only the few around the current position are
// kept decoded (CACHE bitmaps, ~6 MB of pixels each), so memory stays flat and a draw is one drawImage call.
import { useEffect, useRef } from "react";
import { FRAME_COUNT, FRAME_H, FRAME_W, follow, frameAt, frameUrl, loadOrder, nearest } from "@/lib/scene";

const CACHE = 14; // decoded frames kept
const AHEAD = 4; // frames decoded ahead of the scroll direction
const DECODES = 3; // decodes in flight at once: a jump to the far end must not queue a hundred of them
const PARALLEL = 4; // downloads at once

export default function StoryScene({ onReady }: { onReady: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const shell = canvas?.closest<HTMLElement>("[data-story-shell]");
    const ctx = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !shell || !ctx) return;

    const blobs = new Array<Blob | undefined>(FRAME_COUNT);
    const bitmaps = new Map<number, ImageBitmap>();
    const decoding = new Set<number>();
    const abort = new AbortController();
    let alive = true, ready = false;
    let centres: number[] = [];
    let target = 0, shown = 0, drawn = -1, raf = 0;

    const schedule = () => {
      if (!raf && alive) raf = requestAnimationFrame(tick);
    };
    const aim = () => {
      target = frameAt(centres, window.scrollY + window.innerHeight / 2);
      schedule();
    };
    const measure = () => {
      centres = [...shell.querySelectorAll<HTMLElement>("[data-chapter]")].map((el) => {
        const r = el.getBoundingClientRect();
        return r.top + window.scrollY + r.height / 2;
      });
      aim();
    };

    const evict = () => {
      while (bitmaps.size > CACHE) {
        let far = -1, dist = -1;
        for (const k of bitmaps.keys()) {
          const d = Math.abs(k - shown);
          if (k !== drawn && d > dist) [far, dist] = [k, d];
        }
        if (far < 0) return;
        bitmaps.get(far)!.close();
        bitmaps.delete(far);
      }
    };
    const near = (i: number) => Math.abs(i - shown) <= CACHE / 2;
    const best = () => nearest(shown, FRAME_COUNT, (k) => blobs[k] !== undefined);
    // `wanted` = the closest frame that has downloaded: decoded however far it is, so a slow or stalled connection
    // still shows the nearest frame it has instead of holding an old one
    const decode = (i: number, wanted = false) => {
      const blob = blobs[i];
      if (!blob || bitmaps.has(i) || decoding.has(i) || decoding.size >= DECODES || !(wanted || near(i))) return;
      decoding.add(i);
      createImageBitmap(blob).then(
        (bitmap) => {
          decoding.delete(i);
          // the scroll moved on while this decoded (or the scene is gone): drop it, unless nothing is on screen yet
          // or it is still the closest frame there is
          if (!alive || (!near(i) && drawn >= 0 && i !== best())) {
            bitmap.close();
            return schedule();
          }
          bitmaps.set(i, bitmap);
          evict();
          schedule();
        },
        () => {
          decoding.delete(i);
          blobs[i] = undefined; // a frame that will not decode is skipped; its neighbours stand in
          schedule();
        },
      );
    };

    function tick() {
      raf = 0;
      shown = follow(shown, target);
      const want = best();
      if (want >= 0) {
        decode(want, true);
        const dir = target >= shown ? 1 : -1;
        for (let k = 1; k <= AHEAD; k++) {
          const i = want + dir * k;
          if (i >= 0 && i < FRAME_COUNT) decode(i);
        }
      }
      const have = nearest(shown, FRAME_COUNT, (i) => bitmaps.has(i));
      if (have >= 0 && have !== drawn) {
        ctx!.drawImage(bitmaps.get(have)!, 0, 0, FRAME_W, FRAME_H);
        drawn = have;
        if (!ready) {
          ready = true;
          onReady();
        }
      }
      if (shown !== target) schedule();
    }

    measure();
    shown = target; // open on the frame for wherever the page already is (reload half-way down)

    // downloads: the frame for the current position first, then coarse to fine
    const first = Math.round(target);
    const queue = [first, ...loadOrder().filter((i) => i !== first)];
    const worker = async () => {
      while (alive && queue.length) {
        const i = queue.shift()!;
        try {
          const res = await fetch(frameUrl(i), { signal: abort.signal, priority: i === first ? "high" : "low" });
          if (!res.ok) continue;
          blobs[i] = await res.blob();
          schedule();
        } catch {
          // offline or aborted: the frames that did arrive keep working
        }
      }
    };
    for (let k = 0; k < PARALLEL; k++) void worker();

    const resize = new ResizeObserver(measure);
    resize.observe(shell);
    window.addEventListener("scroll", aim, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      alive = false;
      abort.abort();
      cancelAnimationFrame(raf);
      resize.disconnect();
      window.removeEventListener("scroll", aim);
      window.removeEventListener("resize", measure);
      for (const b of bitmaps.values()) b.close();
      bitmaps.clear();
    };
  }, [onReady]);

  return <canvas ref={ref} width={FRAME_W} height={FRAME_H} aria-hidden />;
}
