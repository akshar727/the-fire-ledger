export const FRAME_COUNT = 360;
export const FRAME_W = 1600;
export const FRAME_H = 900;

export const ANCHORS = [0, 72, 144, 216, 288, 359] as const;

export const frameUrl = (i: number) => `/scene/f${String(i).padStart(3, "0")}.webp`;

export const SCENE_MEDIA = "(min-width: 768px) and (min-aspect-ratio: 3/2) and (prefers-reduced-motion: no-preference)";

export function frameAt(centres: readonly number[], middle: number, anchors: readonly number[] = ANCHORS): number {
  const n = Math.min(centres.length, anchors.length);
  if (n === 0) return 0;
  if (middle <= centres[0]) return anchors[0];
  for (let k = 1; k < n; k++) {
    if (middle <= centres[k]) {
      const span = centres[k] - centres[k - 1];
      const u = span > 0 ? (middle - centres[k - 1]) / span : 1;
      return anchors[k - 1] + u * (anchors[k] - anchors[k - 1]);
    }
  }
  return anchors[n - 1];
}

export function loadOrder(count: number = FRAME_COUNT): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  const add = (i: number) => {
    if (i >= 0 && i < count && !seen.has(i)) {
      seen.add(i);
      out.push(i);
    }
  };
  add(0);
  for (let step = 32; step >= 1; step /= 2) {
    for (let i = 0; i < count; i += step) add(i);
    if (step === 32) add(count - 1);
  }
  return out;
}

export function nearest(want: number, count: number, has: (i: number) => boolean): number {
  const w = Math.min(count - 1, Math.max(0, Math.round(want)));
  for (let d = 0; d < count; d++) {
    if (w - d >= 0 && has(w - d)) return w - d;
    if (w + d < count && has(w + d)) return w + d;
  }
  return -1;
}

export function follow(shown: number, target: number, rate = 0.22): number {
  const d = target - shown;
  return Math.abs(d) < 0.02 ? target : shown + d * rate;
}

export function rateFor(dt: number, tau = 95): number {
  return 1 - Math.exp(-Math.min(Math.max(dt, 0), 100) / tau);
}

export function blendPair(shown: number, count: number, has: (i: number) => boolean): { base: number; over: number; alpha: number } {
  const lo = Math.min(count - 1, Math.max(0, Math.floor(shown)));
  const hi = Math.min(count - 1, lo + 1);
  const frac = Math.min(1, Math.max(0, shown - lo));
  if (has(lo) && has(hi) && hi !== lo && frac > 0.01 && frac < 0.99) return { base: lo, over: hi, alpha: frac };
  return { base: nearest(shown, count, has), over: -1, alpha: 0 };
}
