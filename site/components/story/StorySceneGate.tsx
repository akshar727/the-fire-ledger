"use client";

// Decides whether the scroll scene (FE-019) runs at all, and loads it late. It runs only on wide screens with motion
// allowed, without the browser's data-saver, and only once the page has loaded and gone idle, so the story's text and
// figures paint first and the frames never compete with them. Everywhere else (phones, reduced motion, no JavaScript)
// this renders nothing and the story stays the six static panels of FE-018.
//
// When the first frame is on the canvas the gate sets `data-scene` on the [data-story-shell] wrapper; the CSS in
// globals.css ("Scroll scene") shows the canvas and puts the story in its dark colours over it. Until then, and
// whenever the gate turns off again, the attribute is absent and nothing about the page changes.
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { SCENE_MEDIA } from "@/lib/scene";

const StoryScene = dynamic(() => import("./StoryScene"), { ssr: false });

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

export function StorySceneGate() {
  const [on, setOn] = useState(false);
  const holder = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const w = window as IdleWindow;
    const media = matchMedia(SCENE_MEDIA);
    const saver = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
    const decide = () => setOn(media.matches && !saver && "createImageBitmap" in window);
    let idle = 0, timer = 0;
    const start = () => {
      if (w.requestIdleCallback) idle = w.requestIdleCallback(decide, { timeout: 2000 });
      else timer = window.setTimeout(decide, 300);
    };
    if (document.readyState === "complete") start();
    else window.addEventListener("load", start, { once: true });
    media.addEventListener("change", decide);
    return () => {
      window.removeEventListener("load", start);
      media.removeEventListener("change", decide);
      if (idle) w.cancelIdleCallback?.(idle);
      clearTimeout(timer);
    };
  }, []);

  // the scene is gone (window narrowed, reduced motion switched on, page left): back to the static story
  useEffect(() => {
    if (!on) return;
    const shell = holder.current?.closest<HTMLElement>("[data-story-shell]");
    return () => shell?.removeAttribute("data-scene");
  }, [on]);

  const ready = useCallback(() => {
    holder.current?.closest<HTMLElement>("[data-story-shell]")?.setAttribute("data-scene", "");
  }, []);

  if (!on) return null;
  return (
    <div ref={holder} className="story-scene" aria-hidden>
      <StoryScene onReady={ready} />
      <div className="story-scrim" />
    </div>
  );
}
