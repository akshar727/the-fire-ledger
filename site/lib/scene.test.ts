// Tests for lib/scene.ts (FE-019): frame maths for the scroll scene, the rendered frames, and agreement with the
// Blender-side layout (scripts/landing_scene/layout.py).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { ANCHORS, follow, FRAME_COUNT, frameAt, frameUrl, loadOrder, nearest, SCENE_MEDIA } from "./scene.ts";
import { inBox, parsePoints, SCENE_BBOX, STORY_FIRE } from "./story.ts";

const here = (p: string) => new URL(p, import.meta.url);

test("frameAt holds the first and last frame outside the chapters and is linear between them", () => {
  const centres = [500, 1400, 2300, 3200, 4100, 5000];
  assert.equal(frameAt(centres, 0), 0);
  assert.equal(frameAt(centres, 500), 0);
  assert.equal(frameAt(centres, 950), 18);
  assert.equal(frameAt(centres, 1400), 36);
  assert.equal(frameAt(centres, 4100), 144);
  assert.equal(frameAt(centres, 4550), 161.5);
  assert.equal(frameAt(centres, 5000), 179);
  assert.equal(frameAt(centres, 9000), 179);
});

test("frameAt never runs backwards as the page scrolls down, and survives odd layouts", () => {
  const centres = [400, 1300, 1900, 3600, 4000, 5200];
  let last = -1;
  for (let y = 0; y <= 6000; y += 7) {
    const f = frameAt(centres, y);
    assert.ok(f >= last && f >= 0 && f <= FRAME_COUNT - 1, `y ${y}: ${f}`);
    last = f;
  }
  assert.equal(frameAt([], 100), 0);
  assert.equal(frameAt([300, 300, 900, 1200, 1500, 1800], 300), 0); // two chapters at one height: no division by zero
  assert.ok(Number.isFinite(frameAt([300, 300, 900, 1200, 1500, 1800], 301)));
  assert.equal(frameAt([100, 200], 150), 18); // fewer chapters than anchors: uses the ones there are
});

test("loadOrder fetches every frame once, the first one first, coarse before fine", () => {
  const order = loadOrder();
  assert.equal(order.length, FRAME_COUNT);
  assert.equal(new Set(order).size, FRAME_COUNT);
  assert.equal(order[0], 0);
  const early = order.slice(0, 14);
  assert.ok(early.includes(FRAME_COUNT - 1), "the last frame is among the first fetched");
  // after the coarse pass no position is more than 8 frames from a fetched one
  for (let i = 0; i < FRAME_COUNT; i++) assert.ok(early.some((k) => Math.abs(k - i) <= 8), `frame ${i}`);
  assert.deepEqual(loadOrder(3), [0, 2, 1]);
});

test("nearest picks the closest available frame, or -1 when there is none", () => {
  const have = new Set([0, 16, 32, 179]);
  const has = (i: number) => have.has(i);
  assert.equal(nearest(0, FRAME_COUNT, has), 0);
  assert.equal(nearest(7.6, FRAME_COUNT, has), 0);
  assert.equal(nearest(8.6, FRAME_COUNT, has), 16);
  assert.equal(nearest(24, FRAME_COUNT, has), 16); // a tie goes to the lower frame
  assert.equal(nearest(120, FRAME_COUNT, has), 179);
  assert.equal(nearest(500, FRAME_COUNT, has), 179);
  assert.equal(nearest(-3, FRAME_COUNT, has), 0);
  assert.equal(nearest(10, FRAME_COUNT, () => false), -1);
});

test("follow closes on the target and lands on it exactly", () => {
  let f = 0;
  for (let k = 0; k < 200 && f !== 90; k++) {
    const next = follow(f, 90);
    assert.ok(next > f && next <= 90);
    f = next;
  }
  assert.equal(f, 90);
  assert.equal(follow(40, 40), 40);
  assert.ok(follow(90, 0) < 90);
});

test("anchors are one per chapter, rising, from the first frame to the last", () => {
  assert.equal(ANCHORS.length, 6);
  assert.equal(ANCHORS[0], 0);
  assert.equal(ANCHORS.at(-1), FRAME_COUNT - 1);
  for (let k = 1; k < ANCHORS.length; k++) assert.ok(ANCHORS[k] > ANCHORS[k - 1]);
  assert.match(SCENE_MEDIA, /min-width: 768px/);
  assert.match(SCENE_MEDIA, /prefers-reduced-motion: no-preference/);
});

test("the stylesheet gates the scene caption with the same media query, and every scene rule needs [data-scene]", () => {
  const css = readFileSync(here("../app/globals.css"), "utf8");
  assert.ok(css.includes(`@media not (${SCENE_MEDIA})`), "globals.css negates SCENE_MEDIA for .story-scene-note");
  const scene = css.slice(css.indexOf("/* Scroll scene (FE-019)")).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(scene.length > 500);
  // outside [data-scene], the only things the scene's CSS may hide are its own canvas holder and its caption
  const hidden = [...scene.matchAll(/([^{}]+)\{[^{}]*(?:visibility:\s*hidden|display:\s*none|opacity:\s*0)[^{}]*\}/g)].map((m) => m[1].trim());
  for (const sel of hidden) assert.match(sel, /^\.story-scene( canvas)?$|^\.story-scene-note$/, sel);
  assert.match(scene, /\.story-shell\[data-scene\]\s*\{\s*overflow:\s*clip/, "the pinned scene is clipped to the story, so it cannot cover the footer");
});

test("the Blender layout uses the same frame count, anchors and box", () => {
  const layout = readFileSync(here("../../scripts/landing_scene/layout.py"), "utf8");
  const srtm = readFileSync(here("../../scripts/landing_scene/srtm.py"), "utf8");
  assert.match(layout, new RegExp(`^FRAMES = ${FRAME_COUNT}$`, "m"));
  assert.match(layout, new RegExp(`^ANCHORS = \\(${ANCHORS.join(", ")}\\)$`, "m"));
  assert.match(layout, new RegExp(`^YEAR = ${STORY_FIRE.date.slice(0, 4)}$`, "m"));
  assert.match(srtm, new RegExp(`^LAT0, LAT1 = ${SCENE_BBOX.s}, ${SCENE_BBOX.n}\\b`, "m"));
  assert.match(srtm, new RegExp(`^LON0, LON1 = ${SCENE_BBOX.w}, ${SCENE_BBOX.e}\\b`, "m"));
});

test("every frame is published as WebP and the set stays inside the 6-9 MB budget", () => {
  let total = 0;
  for (let i = 0; i < FRAME_COUNT; i++) {
    const file = here(`../public${frameUrl(i)}`);
    assert.ok(existsSync(file), `${frameUrl(i)} is missing: run scripts/landing_scene/scene.py -- --all`);
    const head = readFileSync(file).subarray(0, 12);
    assert.equal(head.toString("latin1", 0, 4) + head.toString("latin1", 8, 12), "RIFFWEBP", frameUrl(i));
    total += statSync(file).size;
  }
  assert.ok(!existsSync(here(`../public${frameUrl(FRAME_COUNT)}`)), "no frame past the last one");
  assert.ok(total < 9 * 1024 * 1024, `${(total / 1024 / 1024).toFixed(1)} MB of frames`);
});

test("the scene's detections are the published 2017 points inside the SRTM tiles", () => {
  const rows = parsePoints(readFileSync(here("../public/data/portugal/points/2017.csv"), "utf8"));
  const inside = rows.filter((d) => inBox(d, SCENE_BBOX));
  assert.equal(inside.length, 16906);
  assert.ok(inside.some((d) => d.date === STORY_FIRE.date));
  assert.ok(inBox({ lat: 40, lon: -8 }, SCENE_BBOX) && !inBox({ lat: 41.01, lon: -8 }, SCENE_BBOX));
});
