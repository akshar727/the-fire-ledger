"use client";

import { useEffect, useRef } from "react";
import { blendPair, FRAME_COUNT, FRAME_H, FRAME_W, follow, frameAt, frameUrl, loadOrder, nearest, rateFor } from "@/lib/scene";

const CACHE = 20;
const AHEAD = 6;
const DECODES = 3;
const PARALLEL = 4;

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
    let target = 0, shown = 0, drawn = -1, drawnOver = -1, drawnKey = "", raf = 0, last = 0;

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
          if (k !== drawn && k !== drawnOver && d > dist) [far, dist] = [k, d];
        }
        if (far < 0) return;
        bitmaps.get(far)!.close();
        bitmaps.delete(far);
      }
    };
    const near = (i: number) => Math.abs(i - shown) <= CACHE / 2;
    const best = () => nearest(shown, FRAME_COUNT, (k) => blobs[k] !== undefined);
    const decode = (i: number, wanted = false) => {
      const blob = blobs[i];
      if (!blob || bitmaps.has(i) || decoding.has(i) || decoding.size >= DECODES || !(wanted || near(i))) return;
      decoding.add(i);
      createImageBitmap(blob).then(
        (bitmap) => {
          decoding.delete(i);
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
          blobs[i] = undefined;
          schedule();
        },
      );
    };

    function tick(now: number) {
      raf = 0;
      shown = follow(shown, target, rateFor(last ? now - last : 1000 / 60));
      const want = best();
      if (want >= 0) {
        decode(want, true);
        if (Math.ceil(shown) !== want) decode(Math.min(FRAME_COUNT - 1, Math.ceil(shown)));
        if (Math.floor(shown) !== want) decode(Math.floor(shown));
        const dir = target >= shown ? 1 : -1;
        for (let k = 1; k <= AHEAD; k++) {
          const i = want + dir * k;
          if (i >= 0 && i < FRAME_COUNT) decode(i);
        }
      }
      const pick = blendPair(shown, FRAME_COUNT, (i) => bitmaps.has(i));
      const key = pick.over < 0 ? `${pick.base}` : `${pick.base}:${pick.over}:${pick.alpha.toFixed(3)}`;
      if (pick.base >= 0 && key !== drawnKey) {
        ctx!.globalAlpha = 1;
        ctx!.drawImage(bitmaps.get(pick.base)!, 0, 0, FRAME_W, FRAME_H);
        if (pick.over >= 0) {
          ctx!.globalAlpha = pick.alpha;
          ctx!.drawImage(bitmaps.get(pick.over)!, 0, 0, FRAME_W, FRAME_H);
          ctx!.globalAlpha = 1;
        }
        [drawn, drawnOver, drawnKey] = [pick.base, pick.over, key];
        if (!ready) {
          ready = true;
          onReady();
        }
      }
      if (shown !== target) schedule();
      last = shown !== target ? now : 0;
    }

    measure();
    shown = target;

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
