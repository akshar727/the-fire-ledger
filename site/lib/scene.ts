// Scroll scene behind the landing story (FE-019): which pre-rendered frame goes with which scroll position, and the
// order the frames are fetched in. Pure functions with no imports, so `node --test` can run them; the canvas and the
// network live in components/story/StoryScene.tsx. The frames are rendered by scripts/landing_scene/scene.py, whose
// layout.py holds the same FRAMES and ANCHORS (lib/scene.test.ts checks they agree).

/** Frames f000.webp … f359.webp in public/scene/, 1600 x 900. */
export const FRAME_COUNT = 360;
export const FRAME_W = 1600;
export const FRAME_H = 900;

/** The frame on screen when chapter k+1 is in the middle of the window (same numbers as layout.py ANCHORS). */
export const ANCHORS = [0, 72, 144, 216, 288, 359] as const;

export const frameUrl = (i: number) => `/scene/f${String(i).padStart(3, "0")}.webp`;

/**
 * The scene needs room and motion: wide, landscape windows only (the frames are 16:9 and drawn to cover the window,
 * so a narrower shape would crop the ends of the timeline and calendar), and never under prefers-reduced-motion.
 * globals.css repeats this query, negated, for the caption (lib/scene.test.ts checks they agree).
 */
export const SCENE_MEDIA = "(min-width: 768px) and (min-aspect-ratio: 3/2) and (prefers-reduced-motion: no-preference)";

/**
 * The (fractional) frame for a scroll position. `centres` are the document-y middles of the chapters, top to bottom,
 * one per anchor; `middle` is the document-y of the middle of the window. Linear between neighbouring chapters, held
 * at the first frame above the first chapter and at the last frame below the last one.
 */
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

/**
 * Fetch order: the first frame, then every 32nd (and the last), 16th, 8th, 4th, 2nd, then the rest. A fast scroll
 * right after load still finds a frame near every position, and the gaps fill in behind it.
 */
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

/** The index closest to `want` for which `has(i)` is true (the lower one on a tie), or -1 when there is none. */
export function nearest(want: number, count: number, has: (i: number) => boolean): number {
  const w = Math.min(count - 1, Math.max(0, Math.round(want)));
  for (let d = 0; d < count; d++) {
    if (w - d >= 0 && has(w - d)) return w - d;
    if (w + d < count && has(w + d)) return w + d;
  }
  return -1;
}

/** One step of the eased follow: the shown frame moves a fraction of the way to the target, and snaps when close. */
export function follow(shown: number, target: number, rate = 0.22): number {
  const d = target - shown;
  return Math.abs(d) < 0.02 ? target : shown + d * rate;
}

/**
 * The follow rate for a step of `dt` ms, so the glide takes the same time at 60 Hz and 120 Hz: the gap to the
 * target shrinks by e every `tau` ms (about 0.17 per 60 Hz frame with the default). Clamped for long pauses.
 */
export function rateFor(dt: number, tau = 95): number {
  return 1 - Math.exp(-Math.min(Math.max(dt, 0), 100) / tau);
}

/**
 * What to draw for a fractional frame: the frame below it and, faded over it by the fraction, the frame above,
 * when both are decoded. `has` says which frames are ready. Falls back to the nearest ready frame alone.
 */
export function blendPair(shown: number, count: number, has: (i: number) => boolean): { base: number; over: number; alpha: number } {
  const lo = Math.min(count - 1, Math.max(0, Math.floor(shown)));
  const hi = Math.min(count - 1, lo + 1);
  const frac = Math.min(1, Math.max(0, shown - lo));
  if (has(lo) && has(hi) && hi !== lo && frac > 0.01 && frac < 0.99) return { base: lo, over: hi, alpha: frac };
  return { base: nearest(shown, count, has), over: -1, alpha: 0 };
}
